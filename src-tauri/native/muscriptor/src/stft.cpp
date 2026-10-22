#include "muscriptor/stft.hpp"
#include "muscriptor/error.hpp"

#include "format.hpp"
#include "pffft.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <new>
#include <utility>

namespace msl
{

namespace
{

    /** pffft wants 16-byte-aligned buffers and has its own allocator for them. */
    class AlignedFloats
    {
    public:
        explicit AlignedFloats(int inCount)
            : mData(static_cast<float*>(pffft_aligned_malloc(static_cast<std::size_t>(inCount) * sizeof(float))))
        {
            if (mData == nullptr) {
                throw std::bad_alloc();
            }
        }
        ~AlignedFloats() { pffft_aligned_free(mData); }

        AlignedFloats(const AlignedFloats&) = delete;
        AlignedFloats& operator=(const AlignedFloats&) = delete;

        float* get() const { return mData; }

    private:
        float* mData;
    };

} // namespace

Stft::Stft(int inNFft, int inHopLength, std::span<const float> inWindow)
    : mNFft(inNFft)
    , mHopLength(inHopLength)
    , mWindow(inWindow.begin(), inWindow.end())
{
    if (inNFft <= 0 || inHopLength <= 0) {
        throw Exception(Error::Internal,
                        msl::format("stft needs positive n_fft and hop_length, got {} and {}", inNFft, inHopLength));
    }
    if (mWindow.size() != static_cast<std::size_t>(inNFft)) {
        throw Exception(Error::Internal,
                        msl::format("stft window has {} coefficients, expected n_fft = {}", mWindow.size(), inNFft));
    }

    // pffft returns null for a size it cannot factor, but checks the multiple of
    // 32 only with assert, which release builds compile out.
    if (inNFft % 32 == 0) {
        mSetup = pffft_new_setup(inNFft, PFFFT_REAL);
    }

    if (mSetup == nullptr) {
        throw Exception(Error::Internal,
                        msl::format("pffft cannot transform n_fft = {}; it needs 2^a*3^b*5^c with a >= 5", inNFft));
    }
}

Stft::~Stft()
{
    if (mSetup != nullptr) {
        pffft_destroy_setup(mSetup);
    }
}

Stft::Stft(Stft&& other) noexcept
    : mNFft(std::exchange(other.mNFft, 0))
    , mHopLength(std::exchange(other.mHopLength, 0))
    , mWindow(std::move(other.mWindow))
    , mSetup(std::exchange(other.mSetup, nullptr))
{
}

Stft& Stft::operator=(Stft&& other) noexcept
{
    if (this != &other) {
        if (mSetup != nullptr) {
            pffft_destroy_setup(mSetup);
        }

        mNFft = std::exchange(other.mNFft, 0);
        mHopLength = std::exchange(other.mHopLength, 0);
        mWindow = std::move(other.mWindow);
        mSetup = std::exchange(other.mSetup, nullptr);
    }

    return *this;
}

int Stft::nFrames(int inNSamples) const
{
    if (inNSamples < 0) {
        return 0;
    }

    // Centre padding adds n_fft/2 on each side, so the padded length is
    // n_samples + n_fft and the frame count collapses to this. PyTorch floors
    // the division, and so does this.
    return 1 + inNSamples / mHopLength;
}

std::vector<float> Stft::magnitudes(std::span<const float> inSamples) const
{
    const int pad = mNFft / 2;
    const int n_samples = static_cast<int>(inSamples.size());

    if (n_samples < pad + 1) {
        throw Exception(Error::Internal,
                        msl::format("stft needs at least {} samples to reflect-pad, got {}", pad + 1, n_samples));
    }

    // torch.stft(center=True, pad_mode="reflect") mirrors n_fft/2 samples onto
    // each end, and the reflection excludes the edge sample itself: the left
    // pad runs x[pad] .. x[1] and the right pad x[n-2] .. x[n-1-pad].
    std::vector<float> padded(static_cast<std::size_t>(n_samples) + 2 * static_cast<std::size_t>(pad));
    std::copy(inSamples.begin(), inSamples.end(), padded.begin() + pad);

    for (int i = 0; i < pad; ++i) {
        padded[static_cast<std::size_t>(i)] = inSamples[static_cast<std::size_t>(pad - i)];
        padded[static_cast<std::size_t>(pad + n_samples + i)] = inSamples[static_cast<std::size_t>(n_samples - 2 - i)];
    }

    const int n_frame = nFrames(n_samples);
    const int n_bin = nFreq();
    const int half = mNFft / 2;
    AlignedFloats windowed(mNFft);
    AlignedFloats spectrum(mNFft);
    AlignedFloats work(mNFft);

    std::vector<float> out(static_cast<std::size_t>(n_frame) * static_cast<std::size_t>(n_bin));

    for (int frame = 0; frame < n_frame; ++frame) {
        const float* src = padded.data() + static_cast<std::size_t>(frame) * mHopLength;

        for (int i = 0; i < mNFft; ++i) {
            windowed.get()[i] = src[i] * mWindow[static_cast<std::size_t>(i)];
        }

        pffft_transform_ordered(mSetup, windowed.get(), spectrum.get(), work.get(), PFFFT_FORWARD);

        const float* bins = spectrum.get();
        float* row = out.data() + static_cast<std::size_t>(frame) * n_bin;
        // pffft returns n_fft/2 complex slots for n_fft/2+1 bins: DC and
        // Nyquist are both purely real and share the first slot as
        // F(0) + i*F(N/2). Every other bin is a plain interleaved pair.
        row[0] = std::fabs(bins[0]);
        row[half] = std::fabs(bins[1]);

        for (int k = 1; k < half; ++k) {
            const float re = bins[2 * k];
            const float im = bins[2 * k + 1];
            // sqrt, not torch's std::hypot: several times faster, and the
            // difference is far below the STFT test tolerance.
            row[k] = std::sqrt(re * re + im * im);
        }
    }

    return out;
}

} // namespace msl
