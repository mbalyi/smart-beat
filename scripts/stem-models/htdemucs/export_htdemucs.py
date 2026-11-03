"""Export the HTDemucs (htdemucs, sig 955717e8) real-valued core to ONNX.

Run in a throwaway container (see setup_pylib.sh / run.sh):
  python export_htdemucs.py parity   # wrapper vs stock model, torch only
  python export_htdemucs.py export   # parity + ONNX export + onnxruntime vs torch

Core signature:  (mix [1,2,343980], z_cac [1,4,2048,336]) ->
                 (x_spec [1,4,4,2048,336], xt [1,4,2,343980])
  mix    : raw stereo waveform (the SAME 7.8 s segment fed to the STFT)
  z_cac  : STFT of mix, cropped, complex-as-channels: channel order
           (ch0.re, ch0.im, ch1.re, ch1.im)
  x_spec : spectrogram branch, ALREADY de-normalised (x*std+mean), CaC layout
           [B, source, (ch0.re,ch0.im,ch1.re,ch1.im), F, T]; apply iSTFT in Rust
  xt     : time branch, ALREADY de-normalised (xt*std_t+mean_t) [B, source, ch, L]
  final  = iSTFT(x_spec as complex) + xt
Normalisation (mean/std of z_cac over dims 1,2,3 and of mix over dims 1,2,
unbiased std, eps 1e-5) lives INSIDE the graph.
"""
import sys, os, math, time
sys.path.insert(0, os.environ.get('PYLIB', '/work/pylib'))
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from einops import rearrange

torch.set_num_threads(os.cpu_count() or 4)
WORK = os.environ.get('WORK', '/work')
WEIGHTS = os.path.join(WORK, '955717e8-8726e21a.th')
OUT = os.path.join(WORK, 'htdemucs_core.onnx')
L = 343980          # 7.8 s * 44100
FR, TT = 2048, 336  # freq bins (4096/2, last dropped), frames ceil(L/1024)


def snr_db(ref, est):
    ref = np.asarray(ref, dtype=np.float64); est = np.asarray(est, dtype=np.float64)
    return 10 * np.log10((ref ** 2).sum() / (((ref - est) ** 2).sum() + 1e-30))


def load_stock():
    pk = torch.load(WEIGHTS, map_location='cpu', weights_only=False)
    cls = pk['klass']
    model = cls(*pk['args'], **pk['kwargs'])
    model.load_state_dict(pk['state'])      # fp16 on disk -> fp32 params
    model.eval()
    return model, pk


# ---------------------------------------------------------------- attention
class ExplicitMHA(nn.Module):
    """nn.MultiheadAttention (batch_first) rewritten with Linear/MatMul/Softmax,
    same weights (in_proj split into q/k/v Linears, out_proj shared)."""
    def __init__(self, mha: nn.MultiheadAttention):
        super().__init__()
        assert mha.batch_first and mha._qkv_same_embed_dim
        E = mha.embed_dim
        self.h = mha.num_heads
        self.dh = E // self.h
        W, b = mha.in_proj_weight.data, mha.in_proj_bias.data
        self.q = nn.Linear(E, E); self.k = nn.Linear(E, E); self.v = nn.Linear(E, E)
        for i, lin in enumerate((self.q, self.k, self.v)):
            lin.weight.data = W[i * E:(i + 1) * E].clone()
            lin.bias.data = b[i * E:(i + 1) * E].clone()
        self.out_proj = mha.out_proj
        self.scale = 1.0 / math.sqrt(self.dh)

    def forward(self, query, key, value, **kw):
        B, Tq, E = query.shape
        Tk = key.shape[1]
        q = self.q(query).reshape(B, Tq, self.h, self.dh).permute(0, 2, 1, 3)
        k = self.k(key).reshape(B, Tk, self.h, self.dh).permute(0, 2, 3, 1)   # B,h,dh,Tk
        v = self.v(value).reshape(B, Tk, self.h, self.dh).permute(0, 2, 1, 3)
        att = torch.softmax(torch.matmul(q * self.scale, k), dim=-1)           # B,h,Tq,Tk
        y = torch.matmul(att, v).permute(0, 2, 1, 3).reshape(B, Tq, E)
        return self.out_proj(y), None


def patch_attention(model):
    n = 0
    for lst in (model.crosstransformer.layers, model.crosstransformer.layers_t):
        for layer in lst:
            if hasattr(layer, 'self_attn'):
                layer.self_attn = ExplicitMHA(layer.self_attn); n += 1
            else:
                layer.cross_attn = ExplicitMHA(layer.cross_attn); n += 1
    return n


# ---------------------------------------------------------------- core wrapper
class HTDemucsCore(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.m = model
        self.S = len(model.sources)
        ct = model.crosstransformer
        # precomputed positional embeddings (sizes fixed by the 7.8 s segment)
        from demucs.transformer import create_2d_sin_embedding, create_sin_embedding
        C = 512
        Fr_b, T1 = 8, TT
        T2 = 1344
        pe2 = create_2d_sin_embedding(C, Fr_b, T1, 'cpu', ct.max_period)        # 1,C,Fr,T1
        self.register_buffer('pos2d', rearrange(pe2, 'b c fr t1 -> b (t1 fr) c').contiguous())
        pe1 = create_sin_embedding(T2, C, shift=0, device='cpu', max_period=ct.max_period)  # T2,1,C
        self.register_buffer('pos1d', rearrange(pe1, 't2 b c -> b t2 c').contiguous())
        # frequency embedding (after first encoder layer): [1,C,Fr,1]
        frs = torch.arange(512)
        self.register_buffer('freq_emb', model.freq_emb(frs).t()[None, :, :, None].contiguous())

    def forward(self, mix, z):
        m = self.m
        B = 1
        x = z
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)

        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                x = x + m.freq_emb_scale * self.freq_emb      # broadcast over time
            saved.append(x)

        # bottleneck: 384 -> 512 -> cross transformer -> 384
        b, c, f, t = x.shape
        x = rearrange(x, "b c f t-> b c (f t)")
        x = m.channel_upsampler(x)
        xt = m.channel_upsampler_t(xt)
        ct = m.crosstransformer
        x = rearrange(x, "b c (f t) -> b (t f) c", f=f)
        x = ct.norm_in(x)
        x = x + ct.weight_pos_embed * self.pos2d
        xt = rearrange(xt, "b c t2 -> b t2 c")
        xt = ct.norm_in_t(xt)
        xt = xt + ct.weight_pos_embed * self.pos1d
        for idx in range(ct.num_layers):
            if idx % 2 == ct.classic_parity:
                x = ct.layers[idx](x)
                xt = ct.layers_t[idx](xt)
            else:
                old_x = x
                x = ct.layers[idx](x, xt)
                xt = ct.layers_t[idx](xt, old_x)
        x = rearrange(x, "b (t fr) c -> b c fr t", t=t)
        xt = rearrange(xt, "b t2 c -> b c t2")
        x = rearrange(x, "b c f t-> b c (f t)")
        x = m.channel_downsampler(x)
        x = rearrange(x, "b c (f t)-> b c f t", f=f)
        xt = m.channel_downsampler_t(xt)

        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)
        S = self.S
        x = x.view(B, S, -1, FR, TT)
        x = x * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, L)
        xt = xt * stdt[:, None] + meant[:, None]
        return x, xt


# ---------------------------------------------------------------- helpers
def test_signal(seed=0):
    """Synthetic stereo 'music': harmonic notes + noise bursts + a panned part."""
    rng = np.random.default_rng(seed)
    t = np.arange(L) / 44100.0
    sig = np.zeros((2, L))
    for k, f0 in enumerate([110, 165, 220, 330, 440, 660]):
        env = (np.sin(2 * np.pi * (0.4 + 0.1 * k) * t) > 0).astype(float) * np.exp(-((t * 2 + k) % 1.0) * 3)
        for h in range(1, 6):
            sig[k % 2] += env * np.sin(2 * np.pi * f0 * h * t) / h * 0.15
    kicks = np.zeros(L)
    for s in range(0, L, 22050):
        n = min(8000, L - s)
        kicks[s:s + n] += np.sin(2 * np.pi * 60 * np.arange(n) / 44100) * np.exp(-np.arange(n) / 2000.0)
    sig += 0.5 * kicks
    sig += 0.02 * rng.standard_normal((2, L))
    return torch.tensor(sig[None], dtype=torch.float32)


def stft_cac(model, mix):
    """Python STFT used for parity: stock helper (torch.stft)."""
    z = model._spec(mix)                          # [1,2,2048,336] complex
    return torch.view_as_real(z).permute(0, 1, 4, 2, 3).reshape(1, 4, FR, TT).contiguous()


def istft_from_core(model, x_spec, xt):
    B, S = x_spec.shape[:2]
    out = x_spec.view(B, S, -1, 2, FR, TT).permute(0, 1, 2, 4, 5, 3).contiguous()
    zout = torch.view_as_complex(out)
    return model._ispec(zout, L) + xt


# --- independent re-implementation of the conventions (what Rust must do)
def manual_stft(x):                       # x [..., L] -> complex [..., 2048, 336]
    n, hop = 4096, 1024
    pad = hop // 2 * 3                    # 1536
    le = math.ceil(x.shape[-1] / hop)
    x = F.pad(x, (pad, pad + le * hop - x.shape[-1]), mode='reflect')   # reflect pad
    x = F.pad(x, (n // 2, n // 2), mode='reflect')                      # center=True reflect pad
    win = torch.hann_window(n)                                          # periodic
    fr = x.unfold(-1, n, hop) * win                                     # [..., frames, n]
    spec = torch.fft.rfft(fr, dim=-1) / math.sqrt(n)                    # normalized
    spec = spec.transpose(-1, -2)[..., :-1, :]                          # drop last bin
    return spec[..., 2:2 + le]                                          # crop 2 frames each side


def manual_istft(z, length):              # z complex [..., 2048, 336]
    n, hop = 4096, 1024
    z = F.pad(z, (0, 0, 0, 1))            # restore Nyquist bin as zero
    z = F.pad(z, (2, 2))                  # 2 zero frames each side
    frames = torch.fft.irfft(z.transpose(-1, -2) * math.sqrt(n), n=n, dim=-1)   # [..., T, n]
    win = torch.hann_window(n)
    frames = frames * win
    T = frames.shape[-2]
    total = n + hop * (T - 1)
    y = torch.zeros(*frames.shape[:-2], total)
    wsum = torch.zeros(total)
    for i in range(T):
        y[..., i * hop:i * hop + n] += frames[..., i, :]
        wsum[i * hop:i * hop + n] += win ** 2
    y = y / wsum.clamp_min(1e-11)
    y = y[..., n // 2: total - n // 2]    # remove center padding
    pad = hop // 2 * 3
    le = hop * math.ceil(length / hop) + 2 * pad
    return y[..., :le][..., pad:pad + length]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'export'
    model, pk = load_stock()
    kw = pk['kwargs']
    print('kwargs bottom_channels', kw['bottom_channels'], 'dconv_mode', kw['dconv_mode'],
          'params', sum(p.numel() for p in model.parameters()))
    mix = test_signal()
    with torch.no_grad():
        t0 = time.time(); ref = model(mix); print('stock forward %.1fs' % (time.time() - t0), tuple(ref.shape))
        z = stft_cac(model, mix)
        # manual STFT/iSTFT conventions check
        zm = manual_stft(mix)
        zc = torch.view_as_complex(z.view(1, 2, 2, FR, TT).permute(0, 1, 3, 4, 2).contiguous())
        print('manual STFT vs torch.stft: max abs %.3e, SNR %.1f dB' % ((zm - zc).abs().max(), snr_db(torch.view_as_real(zc), torch.view_as_real(zm))))
        zr = manual_istft(zc, L)
        print('manual iSTFT(STFT(x)) vs x (roundtrip): SNR %.1f dB' % snr_db(mix, zr))
        print('manual iSTFT vs torch istft: SNR %.1f dB' % snr_db(model._ispec(zc, L), zr))
        # wrapper (attention patched)
        n = patch_attention(model); print('patched attention modules:', n)
        core = HTDemucsCore(model).eval()
        t0 = time.time(); xs, xt = core(mix, z); print('core forward %.1fs' % (time.time() - t0), tuple(xs.shape), tuple(xt.shape))
        out = istft_from_core(model, xs, xt)
        print('PARITY core+python STFT/iSTFT vs stock: max abs %.3e, SNR %.1f dB' % ((out - ref).abs().max(), snr_db(ref, out)))
        # manual iSTFT path too
        B, S = xs.shape[:2]
        zout = torch.view_as_complex(xs.view(B, S, -1, 2, FR, TT).permute(0, 1, 2, 4, 5, 3).contiguous())
        out2 = manual_istft(zout, L) + xt
        print('PARITY core+manual STFT/iSTFT (Rust conventions) vs stock: SNR %.1f dB' % snr_db(ref, out2))
    if mode == 'parity':
        return
    # ------------------------------------------------------------ export
    torch.onnx.export(core, (mix, z), OUT, opset_version=17, dynamo=False, do_constant_folding=True,
                      input_names=['mix', 'z_cac'], output_names=['x_spec', 'xt'])
    print('exported', OUT, os.path.getsize(OUT), 'bytes')
    import onnx, onnxruntime as ort
    mdl = onnx.load(OUT)
    onnx.checker.check_model(OUT)
    ops = {}
    for nd in mdl.graph.node:
        ops[nd.op_type] = ops.get(nd.op_type, 0) + 1
    print('opset', [(o.domain, o.version) for o in mdl.opset_import], 'nodes', len(mdl.graph.node))
    print('ops', dict(sorted(ops.items(), key=lambda kv: -kv[1])))
    print('inputs', [(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim]) for i in mdl.graph.input if i.name in ('mix', 'z_cac')])
    print('outputs', [(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim]) for i in mdl.graph.output])
    so = ort.SessionOptions(); so.intra_op_num_threads = os.cpu_count() or 4
    sess = ort.InferenceSession(OUT, so, providers=['CPUExecutionProvider'])
    t0 = time.time()
    oxs, oxt = sess.run(None, {'mix': mix.numpy(), 'z_cac': z.numpy()})
    print('ort run %.1fs' % (time.time() - t0))
    for name, a, b in (('x_spec', xs.numpy(), oxs), ('xt', xt.numpy(), oxt)):
        print('ORT vs torch %s: max abs %.3e, SNR %.1f dB, ref absmax %.3f' % (name, np.abs(a - b).max(), snr_db(a, b), np.abs(a).max()))
    out_ort = istft_from_core(model, torch.from_numpy(oxs), torch.from_numpy(oxt))
    print('ORT full pipeline vs stock: SNR %.1f dB' % snr_db(ref, out_ort))
    # second, different signal for robustness
    mix2 = test_signal(1) * 0.3 + 0.1 * torch.randn(1, 2, L)
    with torch.no_grad():
        z2 = stft_cac(model, mix2); r2 = core(mix2, z2)
    o2 = sess.run(None, {'mix': mix2.numpy(), 'z_cac': z2.numpy()})
    print('signal2 ORT vs torch: x_spec SNR %.1f dB, xt SNR %.1f dB' % (snr_db(r2[0].numpy(), o2[0]), snr_db(r2[1].numpy(), o2[1])))


if __name__ == '__main__':
    main()
