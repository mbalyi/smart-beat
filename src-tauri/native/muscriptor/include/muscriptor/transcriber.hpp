#pragma once

#include "muscriptor/device.hpp"
#include "muscriptor/error.hpp"
#include "muscriptor/note.hpp"

#include <cstddef>
#include <expected>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace msl
{

/**
 * Polled while `load` or `transcribe` runs, always on the thread that called
 * it; return true to stop, and the call returns `Error::Cancelled`. It is
 * called often, so keep it to something like an atomic load.
 */
using CancelPredicate = std::function<bool()>;

struct TranscribeOptions {
    /**
     * Instruments to transcribe. Empty selects the unconditional path.
     *
     * A non-empty selection adds the `instrument_group` conditioning prefix and
     * masks every other instrument's tokens, so no other instrument can appear.
     * It changes decoding, so it cannot be applied to a finished result.
     */
    std::vector<InstrumentGroup> instruments;

    /**
     * Teacher-force still-sounding notes across chunk boundaries, as the
     * reference does by default. Chunks are decoded strictly in order.
     */
    bool prelude_forcing = true;

    /**
     * CPU threads; 0 selects the performance-core count. Ignored on a GPU
     * backend. Inside a DAW, cap it to leave cores for the host's audio threads.
     */
    int n_threads = 0;

    /**
     * Polled before each chunk, before each decode step, and on the CPU backend
     * at every node of a graph. Empty: never cancelled. See docs/API.md for the
     * longest stretch between two polls on each backend.
     */
    CancelPredicate should_cancel;

    /**
     * A `TranscriptionUpdate::resume_point` from an earlier call on the same
     * signal with the same options. Empty: start from the beginning. Otherwise
     * decoding continues after that update, and only the notes it had not
     * reported yet are returned. See docs/API.md, "Resuming".
     */
    std::string resume_from;
};

/** Options fixed at load: they decide where the weights and KV cache live. */
struct LoadOptions {
    /**
     * Index into `availableDevices()`, or empty for Auto: `autoDevice`'s pick,
     * falling back to the CPU. An explicit device that fails makes `load`
     * return `Error::DeviceUnavailable`. `Transcriber::device` reports where
     * the model runs. CPU and GPU results are not bit-identical.
     */
    std::optional<std::size_t> device;

    /**
     * Polled after backend initialisation, after each weight tensor, and once
     * more before `load` returns. Empty: never cancelled. Backend
     * initialisation itself cannot be interrupted; see docs/API.md.
     */
    CancelPredicate should_cancel;

    /**
     * Fraction of the weight bytes uploaded, 0 to 1, non-decreasing, on the
     * loading thread. The first call, with 0, comes after backend
     * initialisation; the last, with 1, is followed by a short setup before
     * `load` returns.
     */
    std::function<void(float inProgress)> on_progress;
};

/**
 * What one chunk's completion adds to the transcription.
 *
 * Reported once per chunk and once more at the end, synchronously on the thread
 * that called `transcribe`. Nothing here outlives the call.
 */
struct TranscriptionUpdate {
    /**
     * Notes finalised by this update; may be empty.
     *
     * Released one chunk late -- the call after chunk *k* carries what closed
     * during chunk *k-1* -- since overlap trimming can still shorten a note
     * against one starting in the next chunk. Each note is reported once and
     * never changes; concatenating every call reproduces `transcribe`'s result.
     */
    std::span<const Note> new_notes;

    /**
     * Seconds. Every note whose offset is below this has been reported; nothing
     * is known about the signal beyond it. After chunk *k* this is
     * `k * SEGMENT_DURATION`.
     *
     * Exception: a note the model never closes is closed at `onset + 10 ms`
     * when the signal ends, possibly far behind this line, and arrives in the
     * final call.
     */
    double finalized_through = 0.0;

    /**
     * Fraction of the signal consumed, 0 to 1, non-decreasing. The last two
     * calls both report 1; `transcribe` returning is the end signal.
     */
    float progress = 0.0f;

    /**
     * Pass as `TranscribeOptions::resume_from` to continue right after this
     * update, in this process or a later one. Empty in the final call.
     */
    std::string resume_point;
};

/**
 * @param inUpdate What this chunk added; valid only for the duration of the call.
 * @return false to cancel; `transcribe` then returns `Error::Cancelled`. Only
 *         checked once per chunk: `TranscribeOptions::should_cancel` is the
 *         prompt way.
 */
using NoteCallback = std::function<bool(const TranscriptionUpdate& inUpdate)>;

/**
 * The `muscriptor.format_version` this build loads; any other value fails with
 * `Error::UnsupportedCheckpointVersion`. See docs/API.md.
 */
inline constexpr int CHECKPOINT_FORMAT_VERSION = 1;

/**
 * Audio in, notes out: chunking, the mel front-end, the transformer, greedy
 * decoding, the MT3 decode state machine, prelude forcing and note assembly.
 */
class Transcriber
{
public:
    /** The only sample rate this model accepts. */
    static constexpr int SAMPLE_RATE = 16000;

    /** Audio window the model consumes at a time, in samples and in seconds. */
    static constexpr int SEGMENT_SAMPLES = 80000;
    static constexpr double SEGMENT_DURATION = 5.0;

    /** Upper bound on tokens per chunk, matching the reference's max_gen_len. */
    static constexpr int MAX_TOKENS_PER_CHUNK = 2000;

    static std::expected<Transcriber, Error> load(const std::filesystem::path& inGgufPath, LoadOptions inOptions = {});

    /** @return The device the model runs on, as listed by `availableDevices()`. */
    const Device& device() const;

    ~Transcriber();
    Transcriber(Transcriber&&) noexcept;
    Transcriber& operator=(Transcriber&&) noexcept;
    Transcriber(const Transcriber&) = delete;
    Transcriber& operator=(const Transcriber&) = delete;

    /**
     * Transcribe a whole signal. Blocking, seconds to minutes; never call it
     * from an audio thread.
     *
     * One call at a time per instance: it mutates the KV cache and is not
     * synchronised.
     *
     * @param inSamples 16 kHz mono float32, the entire signal. Split into 5 s
     *        chunks; a short tail is zero-padded. An empty signal yields no notes.
     * @param inOptions Decode-time configuration.
     * @param inCallback Optional per-chunk progress and cancellation.
     * @return Every note, sorted by (onset, is_drum, program, pitch, offset).
     */
    std::expected<std::vector<Note>, Error> transcribe(std::span<const float> inSamples,
                                                       const TranscribeOptions& inOptions = {},
                                                       const NoteCallback& inCallback = {});

    /** @return Number of 5 s chunks `inNSamples` will be split into. */
    static int chunkCount(std::size_t inNSamples);

private:
    Transcriber();

    class Impl;
    std::unique_ptr<Impl> mImpl;
};

} // namespace msl
