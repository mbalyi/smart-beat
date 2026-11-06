#!/usr/bin/env python3
"""Export the ZFTurbo SCNet XL (v1.0.15) spectral core to a static-shape ONNX.

Graph contract: input  mix_spec   [1, 4, 2049, 476]   (L.re, L.im, R.re, R.im)
                output stems_spec [1, 16, 2049, 476]  (4 stems x [L.re, L.im, R.re, R.im],
                                                       stems = drums, bass, other, vocals)
STFT / iSTFT are NOT in the graph. There is no input mean/std normalisation either
(ZFTurbo's scnet.py has none; inference config says normalize: false).
In-graph torch.fft.rfft/irfft (FeatureConversion) are replaced by constant real DFT matmuls.

Run (inside a throwaway container with torch, onnx, onnxruntime, numpy):
  python export_scnet_xl.py --pkg /work/pkg --ckpt /work/scnet-xl/model_scnet_ep_36_sdr_10.0891.ckpt \
      --out /work/scnet-xl/scnet_xl_core.onnx
`--pkg` is a dir containing scnet/{__init__,scnet,separation}.py copied from ZFTurbo's models/scnet
(scnet.py and separation.py use relative imports). Use --skip-export to only re-verify an existing ONNX.
"""
import argparse, copy, math, sys
import numpy as np
import torch
from torch import nn

T_FRAMES, F_BINS = 476, 2049
XL = dict(dims=[4, 64, 128, 256], nfft=4096, hop_size=1024, win_size=4096, normalized=True,
          band_SR=[0.230, 0.370, 0.400], band_stride=[1, 4, 4], band_kernel=[3, 4, 4],
          conv_depths=[3, 3, 3], compress=4, conv_kernel=3, num_dplayer=8, expand=1)


class RealFeatureConversion(nn.Module):
    """rfft (inverse=False) or irfft (inverse=True) along the last dim, norm='ortho', as real matmuls."""
    def __init__(self, channels, n, inverse):
        super().__init__()
        self.channels, self.inverse = channels, inverse
        bins = n // 2 + 1
        k = np.arange(bins, dtype=np.int64)[:, None]
        t = np.arange(n, dtype=np.int64)[None, :]
        ang = 2.0 * np.pi * ((k * t) % n) / n                      # exact modular angle, float64
        cos, sin = np.cos(ang), np.sin(ang)
        if inverse:
            w = np.full((bins, 1), 2.0)
            w[0] = 1.0
            if n % 2 == 0:
                w[-1] = 1.0
            cm = cos * w / math.sqrt(n)
            sm = -sin * w / math.sqrt(n)
            sm[0] = 0.0                                             # irfft ignores imag of DC ...
            if n % 2 == 0:
                sm[-1] = 0.0                                        # ... and of Nyquist
            self.register_buffer("cm", torch.tensor(cm, dtype=torch.float32))   # [bins, n]
            self.register_buffer("sm", torch.tensor(sm, dtype=torch.float32))
        else:
            self.register_buffer("cm", torch.tensor(cos.T / math.sqrt(n), dtype=torch.float32))   # [n, bins]
            self.register_buffer("sm", torch.tensor(-sin.T / math.sqrt(n), dtype=torch.float32))

    def forward(self, x):
        if self.inverse:
            h = self.channels // 2
            return torch.matmul(x[:, :h], self.cm) + torch.matmul(x[:, h:], self.sm)
        return torch.cat([torch.matmul(x, self.cm), torch.matmul(x, self.sm)], dim=1)


class Core(nn.Module):
    """SCNet minus padding/STFT/iSTFT. Same code path as SCNet.forward between the two."""
    def __init__(self, model, replace_fft):
        super().__init__()
        self.encoder, self.decoder, self.sep = model.encoder, model.decoder, model.separation_net
        if replace_fft:
            for i, fc in enumerate(self.sep.feature_conversion):
                self.sep.feature_conversion[i] = RealFeatureConversion(fc.channels, T_FRAMES, bool(fc.inverse))

    def forward(self, x):
        skips, lens, olens = [], [], []
        for layer in self.encoder:
            x, s, l, o = layer(x)
            skips.append(s); lens.append(l); olens.append(o)
        x = self.sep(x)
        for fusion, up in self.decoder:
            x = fusion(x, skips.pop())
            x = up(x, lens.pop(), olens.pop())
        return x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pkg", required=True); ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--skip-export", action="store_true", help="only verify an existing --out")
    a = ap.parse_args()
    sys.path.insert(0, a.pkg)
    from scnet.scnet import SCNet
    torch.set_grad_enabled(False)
    model = SCNet(**XL).eval()
    sd = torch.load(a.ckpt, map_location="cpu", weights_only=True)   # plain state dict
    model.load_state_dict(sd)
    ref = Core(copy.deepcopy(model), replace_fft=False).eval()        # real torch.fft
    core = Core(model, replace_fft=True).eval()                        # DFT matmuls
    g = torch.Generator().manual_seed(a.seed)
    x = torch.randn(1, 4, F_BINS, T_FRAMES, generator=g)
    y_ref, y_mm = ref(x), core(x)
    print("torch fft vs matmul core: max abs", (y_ref - y_mm).abs().max().item(), "out", tuple(y_mm.shape), flush=True)
    if not a.skip_export:
        torch.onnx.export(core, (x,), a.out, input_names=["mix_spec"], output_names=["stems_spec"],
                          opset_version=17, dynamo=False, do_constant_folding=True)
    import onnx, onnxruntime as ort
    from collections import Counter
    onnx.checker.check_model(a.out)
    m = onnx.load(a.out, load_external_data=False)
    print("opset", [o.version for o in m.opset_import], "ops", dict(Counter(n.op_type for n in m.graph.node)))
    print("in", [(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim]) for i in m.graph.input],
          "out", [(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim]) for i in m.graph.output], flush=True)
    so = ort.SessionOptions(); so.intra_op_num_threads = 0
    sess = ort.InferenceSession(a.out, so, providers=["CPUExecutionProvider"])
    for name, xi in (("random N(0,1)", x), ("random 0.1*N(0,1) seed2", 0.1 * torch.randn(1, 4, F_BINS, T_FRAMES, generator=g))):
        yt = ref(xi).numpy()
        yo = sess.run(["stems_spec"], {"mix_spec": xi.numpy()})[0]
        err = np.abs(yt - yo).max()
        snr = 10 * np.log10((yt.astype(np.float64) ** 2).sum() / (((yt - yo).astype(np.float64)) ** 2).sum())
        print(f"[{name}] ORT vs torch(true fft): shape {yo.shape} max_abs_err {err:.3e}  SNR {snr:.2f} dB  ref_absmax {np.abs(yt).max():.3f}", flush=True)

if __name__ == "__main__":
    main()
