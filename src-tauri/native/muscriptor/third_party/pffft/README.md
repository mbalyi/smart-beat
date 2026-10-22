# pffft

Vendored verbatim from <https://bitbucket.org/jpommier/pffft>, `master`.

| File | SHA-256 |
|---|---|
| `pffft.c` | `930b664934a11bd11126ce1f6cdb9c1f55a573267fc2b9c5fed5884c6b1d07ac` |
| `pffft.h` | `f07a580d03403ead8c4fbd10eb56ce1125b2a4bbd5a5eb628a58290f2f4881df` |

Two files, no build system, BSD-style FFTPACK licence (see the header comment in
`pffft.c`).

Used by `msl::Stft` for the STFT's real-to-complex transform.

## What the port relies on

- **Single precision only.** pffft has no double path; the whole front-end is
  fp32, which is also what the reference computes in.
- **`N = 2^a·3^b·5^c` with `a ≥ 5`.** `n_fft = 2048 = 2^11` qualifies.
  `Stft`'s constructor rejects anything `pffft_new_setup` refuses.
- **`pffft_transform_ordered` output layout**, verified against
  `numpy.fft.rfft`: `out[0]` is `Re F(0)`, `out[1]` is `Re F(N/2)`, and
  `out[2k], out[2k+1]` are `Re F(k), Im F(k)` for `k = 1 … N/2-1`. That is
  `N/2` complex slots for `N/2+1` bins, so DC and Nyquist share the first one
  and have to be unpacked by hand.
- **Unscaled forward transform**, matching `torch.stft(normalized=False)`.
- **Same sign convention as numpy/torch** (`e^{-2πikn/N}`). Irrelevant to
  magnitudes, but it means the bins can be compared directly if a complex
  spectrum is ever needed.
- **16-byte-aligned buffers**, hence `pffft_aligned_malloc` in `stft.cpp`.
- **`PFFFT_Setup` is read-only and shareable across threads**, so one `Stft`
  can serve concurrent `magnitudes` calls.
