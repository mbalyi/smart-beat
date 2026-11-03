# Stem model export tooling (issue 186)

How the ONNX files behind the optional SCNet and HTDemucs engines were made, so anyone can redo
them. Nothing here runs in the app or in CI, and nothing here is needed to build Smart Beat. The
files are for the one-off conversion of PyTorch checkpoints that upstream only publishes as
`.ckpt` or `.th`.

## What was produced

| File                                                          | Source                                                                                         | Size (bytes)     | SHA-256                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `scnet_cpu.onnx` (SCNet Small)                                | not ours: `https://github.com/demixr/scnet-executorch/releases/download/v0.1.2/scnet_cpu.onnx` | 52,271,228       | `f2c050b7264d2b2401497beb712c26a50e6162dfb951041060f23f84929d600e` |
| `scnet_xl_core.onnx` (SCNet XL)                               | `export_scnet_xl.py`                                                                           | 216,163,649      | `4ee5107c1978fd68cc666aa35898c9e866fa7c7d47278086a75bf4448807f0ee` |
| `htdemucs_core.onnx` (HTDemucs)                               | `htdemucs/export_htdemucs.py`                                                                  | 176,589,623      | `105da2c479af1f11e2f2057a9d5435f97b27b9f9d1d7c728390bf0a8ab5107ee` |
| `htdemucs_6s_core.onnx` (HTDemucs 6-source, guitar and piano) | `htdemucs/export_htdemucs.py ... htdemucs_6s`                                                  | **not made yet** | **not made yet**                                                   |

The two exported files above are hosted as assets of the pre-release
[`stem-models-v1`](https://github.com/mbalyi/smart-beat/releases/tag/stem-models-v1) (owner's
decision, 2026-11-03). If an obligation arises they are removed immediately (see
`docs/licensing.md`).

## Input checkpoints

| Model                                                         | File                                                                                                 | Size (bytes)                                                         | Hash                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| SCNet XL IHF (MUSDB18-HQ only, 10.09 dB average SDR on MUSDB) | `model_scnet_ep_36_sdr_10.0891.ckpt` from ZFTurbo/Music-Source-Separation-Training release `v1.0.15` | 214,063,778                                                          | SHA-256 `ac25975f0f5704f3d1a3c3c251505b7a0f417a22eafe82773440ee4f7e14b74f` |
| SCNet XL config                                               | `config_musdb18_scnet_xl_more_wide_v5.yaml` (same release)                                           | not recorded                                                         | SHA-256 `54ddcb8aeeae85c8d0e148741e7d87b0fbd38bd21cffa5d59ba124fe1e672f40` |
| HTDemucs 6-source (`htdemucs_6s`, signature 5c90dfd2)         | `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th`                      | 54,996,327 (download size read from the server, file not downloaded) | not recorded                                                               |
| HTDemucs (`htdemucs`, signature 955717e8)                     | `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th`                      | 84,141,911                                                           | MD5 `b57e3704651588e6702539cd7e8f87f6` (SHA-256 not recorded)              |

## How to redo it

Use a throwaway container so nothing is installed on the host. Any image with Python 3.12, `torch`
(2.x), `einops` and `numpy` works; the spike used a local image that already had torch.

SCNet XL:

```sh
# WORK holds pkg/ (a copy of scnet-xl-pkg/scnet under pkg/scnet) and scnet-xl/ with the .ckpt
docker run --rm -v "$WORK":/work -v "$PWD":/src:ro "$IMAGE" sh -c \
  'pip install -q onnx onnxruntime && python -I /src/export_scnet_xl.py --pkg /work/pkg \
   --ckpt /work/scnet-xl/model_scnet_ep_36_sdr_10.0891.ckpt --out /work/scnet-xl/scnet_xl_core.onnx'
```

HTDemucs: put the `.th` file in `$WORK`, run `htdemucs/setup_pylib.sh` once in the container (it
installs `onnx`, `onnxruntime`, `julius`, `demucs` and `openunmix` into `$WORK/pylib`), then
`WORK=... IMAGE=... htdemucs/run.sh parity` and `... run.sh export`. For the 6-source model (`5c90dfd2-34c22ccb.th` in `$WORK`) add its name: `... run.sh parity htdemucs_6s`, `... run.sh export htdemucs_6s`; the script stops if the checkpoint's sources, segment or transformer width differ from the 4-source model's.

## What the graphs contain and what the host does

Both exports are the real-valued core only, opset 17, static shapes. The complex STFT and iSTFT
stay outside the graph (ONNX cannot export `torch.stft`); the app does them in Rust.

- SCNet: `STFT_CONVENTIONS.md` (XL) and `scnet-notes.md` (Small and XL). In the XL export the
  `rfft`/`irfft` along time inside the dual-path layers are replaced by constant real DFT matrix
  multiplications.
- HTDemucs: inputs `mix [1,2,343980]` and `z_cac [1,4,2048,336]`, outputs `x_spec [1,4,4,2048,336]`
  and `xt [1,4,2,343980]`; the final stem is `iSTFT(x_spec) + xt`. Mean/std normalisation is inside
  the graph. The attention modules were rewritten as Linear/MatMul/Softmax so tract can run them.

## Parity checks (what was measured)

- HTDemucs: the wrapped core with Python STFT/iSTFT against the stock model: max abs error
  5.07e-07, **SNR 129.0 dB**. The same with our manual STFT/iSTFT (the conventions the Rust code
  uses): SNR 129.0 dB. The manual STFT against `torch.stft`: SNR 338 dB. (Log:
  `htdemucs/parity1.log` in the spike notes, not copied here.) The exported ONNX was also checked
  against torch with onnxruntime; that result was not recorded.
- SCNet XL: ONNX run in onnxruntime against torch with the real FFT, random N(0,1) input: max abs
  error 9.55e-02 on a reference peak of 8.25, **SNR 52.1 dB**. The process was then killed (out of
  memory) before any further check, so no second input was verified. The real-audio results in
  `docs/stem-separation-spike.md` (stems sum back to the mix, SDR against exact truth) are the
  stronger evidence.
- SCNet Small is upstream's own export and was only run, not compared against torch.

## Licences of the copied code

`scnet-xl-pkg/scnet/` is code from ZFTurbo/Music-Source-Separation-Training (`models/scnet`), which
is itself based on starrytong/SCNet. Both repositories are under the MIT licence; the files carry
no header of their own, so the licence texts are kept next to them:
`scnet-xl-pkg/LICENSE-ZFTurbo-MIT.txt` and `scnet-xl-pkg/LICENSE-SCNet-starrytong-MIT.txt` (checked
on GitHub, 2026-11-03). `htdemucs/export_htdemucs.py` imports the Demucs package (MIT) at run time
and does not copy it. The **weights** have their own question, tracked in `docs/licensing.md`.
