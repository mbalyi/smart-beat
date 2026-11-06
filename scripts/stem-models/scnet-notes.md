# SCNet Small and XL: what the host has to do around the graph (issue 186 spike)

- SCNet Small ONNX (`scnet_cpu.onnx`, upstream, 52,271,228 bytes): input `[1,4,2049,338]`, output `[1,4,4,2049,338]`.
- XL ONNX (our export): input `[1,4,2049,476]`, output `[1,16,2049,476]`. See `STFT_CONVENTIONS.md`.
- Both use a rectangular-window STFT (the app's shared `Stft` is Hann, so SCNet has its own transform): `n_fft` 4096, hop 1024, reflect pad 2048, end zero pad to an odd number of hops, `normalized=True` (1/64), all 2049 bins kept.
- Small: 343,980 samples padded to 345,088 (338 frames). It also normalises the whole spectrogram by one scalar mean and standard deviation, `(x - m) / (1e-5 + std)`, and undoes it on every output channel.
- XL: 485,100 samples padded to 486,400 (476 frames). No spectrogram normalisation.
- Stem order on the stem axis: drums, bass, other, vocals.
