# SCNet XL (ZFTurbo v1.0.15, model_type scnet) - conventions around the ONNX core

ONNX: scnet_xl_core.onnx, opset 17, static shapes. Input `mix_spec` [1,4,2049,476] f32, output `stems_spec` [1,16,2049,476] f32.
Channel order in: [L.re, L.im, R.re, R.im]. Out: 4 stems x those 4 channels, stem order drums, bass, other, vocals
(out channel = stem*4 + {0:L.re,1:L.im,2:R.re,3:R.im}); this is `x.view(B, 4, -1, Fr, T)` of the 16 channels, then `reshape(-1, 2, Fr, T)` pairs (re, im).

Front end (done by torch.stft in SCNet.forward; must be reproduced in Rust):

- chunk 485100 samples/channel (11 s @ 44.1 kHz), stereo. Pad at the END with zeros: padding = hop - len % hop = 1024 - 485100 % 1024 = 1300;
  if (len+padding)/hop is even, padding += hop. Here (485100+1300)/1024 = 475 (odd) -> no extra. Padded length 486400.
- torch.stft(n_fft=4096, hop_length=1024, win_length=4096, window=None -> RECTANGULAR (all ones), center=True,
  pad_mode default 'reflect' (2048 samples each side, mirror without repeating the edge sample), normalized=True (multiply by 1/sqrt(4096)=1/64),
  onesided=True, return_complex=True). Frames = 486400/1024 + 1 = 476, bins = 2049.
- layout: per channel (L, R) spectrum [2049,476] complex -> view_as_real [2049,476,2] -> channels [L.re, L.im, R.re, R.im] -> [1,4,2049,476].
- Mean/std input normalisation is NOT in the graph and NOT applied: ZFTurbo's scnet.py has none, config says `normalize: false`
  (starrytong's original scnet does (x-mean)/(1e-5+std) and un-normalises at the end; not for the XL checkpoint).
- Graph content: encoder (3 SD blocks), 8 dual-path layers (the rfft/irfft along T in FeatureConversion are constant ortho-scaled real DFT matmuls), decoder.

Back end (torch.istft in SCNet.forward):

- stems [16,2049,476] -> per stem/channel complex pairs -> torch.istft(n_fft=4096, hop=1024, win_length=4096, window=None (rectangular), center=True, normalized=True)
  = inverse rFFT * 64 (undo 1/sqrt(N)), overlap-add with rectangular window, divide by the window-square overlap envelope (4 in the interior; 1..4 at the edges),
  trim 2048 from the start (center) and the end -> 486400 samples; then drop the last `padding` (1300) samples -> 485100.
- Inference (ZFTurbo): num_overlap 4, batch 4, chunks of 485100 with step chunk/4 and windowed overlap-add (done outside the model).
