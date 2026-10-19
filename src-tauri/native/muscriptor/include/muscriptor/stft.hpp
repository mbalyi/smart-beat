#pragma once

#include <span>
#include <vector>

struct PFFFT_Setup;

namespace msl
{

/**
 * Short-time Fourier transform magnitudes.
 *
 * Reproduces exactly what MuScriptor's mel front-end computes before the
 * filterbank:
 *
 *     torch.stft(x, n_fft, hop_length, win_length=n_fft, window=window,
 *                center=True, pad_mode="reflect", normalized=False,
 *                onesided=True, return_complex=True).abs() ** 1.0
 *
 * `power` is 1.0 in the checkpoint, so these are magnitudes and not powers --
 * squaring them is a silent, plausible-looking error that survives every
 * shape check.
 *
 * ggml has no FFT op, so this runs on the host outside the compute graph. The
 * transform itself is pffft; the framing, padding and windowing around it are
 * the parts that have to match PyTorch, and they are what `test_stft.cpp` pins
 * down.
 *
 * Everything is fp32. The reference keeps the whole conditioning path in
 * fp32 even when the transformer runs in fp16 (`load_model` calls
 * `condition_provider.float()`), and pffft has no double precision anyway.
 */
class Stft
{
public:
    /**
     * @param inNFft FFT size.
     * @param inHopLength Hop length in samples.
     * @param inWindow Window coefficients; must hold exactly `inNFft` of them.
     *        Pass the checkpoint's own `cond.stft_window` rather than
     *        regenerating a Hann window -- `Model::stft()` does. The
     *        reference's window is *periodic* (`torch.hann_window` defaults
     *        to `periodic=True`, so the denominator is `n_fft`, not
     *        `n_fft - 1`).
     *
     * Throws if `inWindow` is the wrong length, if `inHopLength` is not
     * positive, or if pffft cannot transform `inNFft` (it needs 2^a*3^b*5^c
     * with a >= 5, at most 2^26).
     */
    Stft(int inNFft, int inHopLength, std::span<const float> inWindow);

    ~Stft();
    Stft(Stft&&) noexcept;
    Stft& operator=(Stft&&) noexcept;
    Stft(const Stft&) = delete;
    Stft& operator=(const Stft&) = delete;

    int nFft() const { return mNFft; }
    int hopLength() const { return mHopLength; }
    int nFreq() const { return mNFft / 2 + 1; }

    /**
     * The window in use, so a test can assert on the coefficients the
     * transform actually applies rather than on a copy from the GGUF.
     */
    std::span<const float> window() const { return mWindow; }

    /**
     * @param inNSamples Length of the input audio, in samples.
     * @return Frames emitted for `inNSamples` of input: centre padding makes
     *         this `1 + n_samples / hop_length`, which is one more than the
     *         number of frames the audio actually covers -- the reason
     *         `encodeConditioning` masks the last one away.
     */
    int nFrames(int inNSamples) const;

    /**
     * @param inSamples Input audio.
     * @return Magnitudes as [nFrames(inNSamples)][nFreq()] row-major: the
     *         layout `Model::encodeConditioning` takes and the one
     *         `in.spectrum` is dumped in.
     *
     * Throws if the input is shorter than `n_fft / 2 + 1` samples, which is
     * the point below which reflect padding has nothing left to reflect. In
     * the pipeline this cannot happen: chunks are zero-padded to a fixed 5 s.
     *
     * Safe to call concurrently on one Stft.
     */
    std::vector<float> magnitudes(std::span<const float> inSamples) const;

private:
    int mNFft = 0;
    int mHopLength = 0;
    std::vector<float> mWindow;
    PFFFT_Setup* mSetup = nullptr;
};

} // namespace msl
