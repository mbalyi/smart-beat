#pragma once

#include "muscriptor/device.hpp"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <vector>

namespace msl
{

class Stft;
class Trace;

/** Architecture and front-end constants, all read from the GGUF's metadata. */
struct Hparams {
    std::int32_t dim = 0;
    std::int32_t n_head = 0;
    std::int32_t head_dim = 0;
    std::int32_t n_layer = 0;
    std::int32_t ffn_dim = 0;
    std::int32_t vocab_size = 0; // `card`: the number of real logits
    std::int32_t initial_token_id = 0;
    // LMModel._compute_logits forces logits[:, 1393:] to -inf regardless of
    // vocab_size, so medium/large carry two ids that can never be produced.
    std::int32_t logit_mask_start = 0;
    float layer_norm_eps = 0.0f;
    float max_period = 0.0f;

    std::int32_t sample_rate = 0;
    std::int32_t n_fft = 0;
    std::int32_t hop_length = 0;
    std::int32_t frame_rate = 0;
    std::int32_t n_mels = 0;
    float log_eps = 0.0f;

    std::int32_t n_freq() const { return n_fft / 2 + 1; }
};

struct ModelOptions {
    // KV cache capacity in positions. Must cover the conditioning prefix plus
    // every generated token.
    int n_ctx = 2560;
    // 0 selects the performance-core count. Ignored on a GPU backend. Results
    // do not depend on it: ggml partitions matmuls by row.
    int n_threads = 0;
    // As `LoadOptions::device`, except that an explicit device that fails
    // throws `Error::DeviceUnavailable`.
    std::optional<std::size_t> device;
    // Load only. Polled after backend init, after each weight tensor and before
    // `load` returns; returning true makes `load` throw `Error::Cancelled`.
    std::function<bool()> should_cancel;
    // Load only. Fraction of the weight bytes uploaded, 0 to 1.
    std::function<void(float)> on_progress;
};

/**
 * The ggml port of MuScriptor: conditioning front-end, causal transformer
 * with a KV cache, and greedy decoding.
 *
 * Stateful like the reference: `reset` clears the cache and position counter,
 * `prefill` consumes the conditioning prefix plus prompt, and each `decode`
 * advances by one position.
 *
 * Not thread-safe, including the `const` members: every evaluation builds its
 * graph in one scratch buffer owned by the model. Use one `Model` per thread.
 */
class Model
{
public:
    using Options = ModelOptions;

    static Model load(const std::filesystem::path& inGgufPath, Options inOptions = {});

    ~Model();
    Model(Model&&) noexcept;
    Model& operator=(Model&&) noexcept;
    Model(const Model&) = delete;
    Model& operator=(const Model&) = delete;

    const Hparams& hparams() const;

    /** @return The device in use, as listed by `availableDevices()`. */
    const Device& device() const;

    /**
     * Node count of the most recent evaluation graph, and the capacity it was
     * built with. 0 until something has been evaluated. Exceeding the capacity
     * aborts inside ggml, so a test checks the margin.
     */
    int graphNodeCount() const;
    int graphNodeCapacity() const;

    /**
     * The STFT, configured from the GGUF: framing from the `audio.*` metadata,
     * window from the checkpoint's `cond.stft_window` buffer.
     */
    const Stft& stft() const;

    /**
     * STFT magnitudes for a chunk of 16 kHz mono audio, then the conditioning
     * front-end over them. Equivalent to
     *
     *     encodeConditioning(stft().magnitudes(samples),
     *                        stft().n_frames(samples.size()), samples.size())
     *
     * @param inSamples 16 kHz mono audio for one chunk.
     * @param inTrace Optional trace to capture intermediate tensors into.
     * @return The conditioning embedding as [n_frames][dim] row-major.
     */
    std::vector<float> encodeAudio(std::span<const float> inSamples, Trace* inTrace = nullptr) const;

    /**
     * Conditioning front-end.
     *
     * @param inSpectrum STFT magnitudes as [n_frames][n_freq] row-major.
     * @param inNFrames Number of frames in `inSpectrum`.
     * @param inNSamples Length of the audio the spectrum came from. The frame
     *        mask is derived from it, as in the reference, so the last frame is
     *        always masked.
     * @param inTrace Optional trace to capture intermediate tensors into.
     * @return The conditioning embedding as [n_frames][dim] row-major.
     */
    std::vector<float> encodeConditioning(std::span<const float> inSpectrum,
                                          int inNFrames,
                                          int inNSamples,
                                          Trace* inTrace = nullptr) const;

    /** Clear the KV cache and rewind to position 0. Call between chunks. */
    void reset();

    /**
     * Embedding rows for the instrument_group conditioner, one prefix position
     * each. Empty restores the unconditional path: a single null-class row.
     * Changes the prefix length. `reset()` does not clear it.
     *
     * @param inRows Rows to read, from `InstrumentGroups::conditioningRows`.
     */
    void setInstrumentRows(std::span<const std::int32_t> inRows);

    /** @return The rows in use; a single null-class row when unconditional. */
    std::span<const std::int32_t> instrumentRows() const;

    /**
     * Token ids forced to -inf on top of the reserved-id mask, matching
     * `_compute_logits`. Applied by `prefill`, `decode` and `generate`. Empty by
     * default. `reset()` does not clear it.
     *
     * @param inTokenIds Ids to mask; out-of-range ids are ignored.
     */
    void setForbiddenTokens(std::span<const std::int32_t> inTokenIds);

    /** @return Whether any forbidden mask is currently installed. */
    bool hasForbiddenTokens() const;

    /**
     * Threads for subsequent evaluations; 0 selects the performance-core count.
     * Ignored on a GPU backend. Results do not depend on it.
     */
    void setNumThreads(int inNThreads);

    /** @return Threads currently configured, with 0 resolved. Never 0. */
    int numThreads() const;

    /**
     * Cancellation for subsequent evaluations: polled before each decode step
     * of `generate`, and on the CPU backend at every graph node. Returning true
     * makes the evaluation throw `Error::Cancelled`, leaving the KV cache
     * partly written; `generate` resets it. Empty to clear.
     */
    void setShouldCancel(std::function<bool()> inShouldCancel);

    /**
     * First forward pass of a chunk: prepends the conditioning embedding and
     * the class embeddings to `inTokens`.
     *
     * @param inConditioning Conditioning embedding, [n_frames][dim] row-major.
     * @param inNFrames Number of frames in `inConditioning`.
     * @param inTokens Prompt tokens to prepend after the conditioning.
     * @param inTrace Optional trace to capture intermediate tensors into.
     * @return The masked logits at the last position, [vocab_size].
     */
    std::vector<float> prefill(std::span<const float> inConditioning,
                               int inNFrames,
                               std::span<const std::int32_t> inTokens,
                               Trace* inTrace = nullptr);

    /**
     * One autoregressive step.
     *
     * @param inToken Token to feed at this step.
     * @param inTrace Optional trace to capture intermediate tensors into.
     * @return The masked logits, [vocab_size].
     */
    std::vector<float> decode(std::int32_t inToken, Trace* inTrace = nullptr);

    /**
     * Greedy-decode a whole chunk. Calls `reset`.
     *
     * @param inConditioning Conditioning embedding, [n_frames][dim] row-major.
     * @param inNFrames Number of frames in `inConditioning`.
     * @param inMaxTokens Upper bound on emitted tokens if EOS never arrives.
     * @param inEosId Token id that ends generation.
     * @return The tokens up to and including `inEosId` (or `inMaxTokens`
     *         tokens if EOS never arrives).
     */
    std::vector<std::int32_t>
        generate(std::span<const float> inConditioning, int inNFrames, int inMaxTokens, std::int32_t inEosId);

    /**
     * Greedy-decode a whole chunk from a teacher-forced prompt. Calls `reset`.
     *
     * @param inConditioning Conditioning embedding, [n_frames][dim] row-major.
     * @param inNFrames Number of frames in `inConditioning`.
     * @param inMaxTokens Upper bound on `inPrompt` plus generated tokens
     *        together, as `max_gen_len` bounds upstream.
     * @param inEosId Token id that ends generation.
     * @param inPrompt Tokens forced immediately after the initial token,
     *        consumed by the prefill pass.
     * @return `inPrompt` followed by the generated tokens, up to and including
     *         `inEosId`. The decode state machine needs the prompt too.
     */
    std::vector<std::int32_t> generate(std::span<const float> inConditioning,
                                       int inNFrames,
                                       int inMaxTokens,
                                       std::int32_t inEosId,
                                       std::span<const std::int32_t> inPrompt);

    /** Sinusoidal position table, [n_ctx][dim] row-major. */
    std::span<const float> positionEmbeddings() const;

    /** @return Number of KV entries currently cached (the reference's `offset`). */
    int nPast() const;

    /** @return KV cache capacity in positions, as configured at load. */
    int contextSize() const;

    /** Internal state; declared here only so model.cpp's graph builder can name it. */
    struct Impl;

private:
    Model();
    std::unique_ptr<Impl> mImpl;
};

} // namespace msl
