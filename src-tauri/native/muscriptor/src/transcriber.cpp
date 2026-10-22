#include "muscriptor/transcriber.hpp"

#include "muscriptor/model.hpp"

#include "instrument_groups.hpp"
#include "note_assembler.hpp"
#include "open_note_tracker.hpp"
#include "resume_point.hpp"
#include "vocabulary.hpp"

#include <algorithm>
#include <iterator>
#include <new>
#include <optional>
#include <string>
#include <string_view>

namespace msl
{

namespace
{

    /**
     * KV positions to allocate.
     *
     * The prefix (mel frames, one dataset row, one row per selected instrument),
     * the initial token, and a chunk's worth of generation. Computed rather than
     * written down so it cannot go stale against the front-end constants.
     */
    constexpr int requiredContext(int inMelFrames)
    {
        return inMelFrames + 1 + InstrumentGroups::MAX_SELECTABLE + 1 + Transcriber::MAX_TOKENS_PER_CHUNK;
    }

    /** Mel frames one chunk produces: centre padding yields one more than it covers. */
    constexpr int melFramesPerChunk(int inHopLength)
    {
        return 1 + Transcriber::SEGMENT_SAMPLES / inHopLength;
    }

    /** The selection, with duplicates removed but the caller's order kept. */
    std::vector<InstrumentGroup> uniqueInstruments(std::span<const InstrumentGroup> inGroups)
    {
        std::vector<InstrumentGroup> unique;

        for (const InstrumentGroup group: inGroups) {
            if (std::find(unique.begin(), unique.end(), group) == unique.end()) {
                unique.push_back(group);
            }
        }

        return unique;
    }

    /** Installs a cancel predicate on a model for one call, and removes it on every exit. */
    class ScopedCancel
    {
    public:
        ScopedCancel(Model& ioModel, const CancelPredicate& inShouldCancel)
            : mModel(ioModel)
        {
            mModel.setShouldCancel(inShouldCancel);
        }

        ~ScopedCancel() { mModel.setShouldCancel({}); }

        ScopedCancel(const ScopedCancel&) = delete;
        ScopedCancel& operator=(const ScopedCancel&) = delete;

    private:
        Model& mModel;
    };

} // namespace

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

class Transcriber::Impl
{
public:
    explicit Impl(Model&& inModel)
        : mModel(std::move(inModel))
        , mMelFrames(melFramesPerChunk(mModel.hparams().hop_length))
    {
    }

    std::expected<std::vector<Note>, Error> transcribe(std::span<const float> inSamples,
                                                       const TranscribeOptions& inOptions,
                                                       const NoteCallback& inCallback);

    const Device& device() const { return mModel.device(); }

private:
    /**
     * Configure the model from `inOptions`. Returns false on a bad selection,
     * having touched nothing -- the model is left as the previous call
     * configured it, and the next call reconfigures it from scratch anyway.
     */
    bool _configure(const TranscribeOptions& inOptions);

    /** One chunk's samples, zero-padded to a full segment. */
    void _fillChunk(std::span<const float> inSamples, int inIndex);

    /**
     * Rebuild the decode state `inResumePoint` describes, after `_configure`.
     * @return The chunk to continue from, or nothing if the point does not fit
     *         this call.
     */
    std::optional<int> _restore(std::string_view inResumePoint,
                                std::size_t inNSamples,
                                const TranscribeOptions& inOptions,
                                int inNChunks);

    /** The resume point for right after chunk `inDecoded - 1`. */
    std::string _resumePoint(std::size_t inNSamples, const TranscribeOptions& inOptions, int inDecoded) const;

    Model mModel;
    int mMelFrames;

    OpenNoteTracker mTracker;
    NoteAssembler mAssembler;
    std::vector<float> mChunk;
    std::vector<InstrumentGroup> mInstruments;
};

bool Transcriber::Impl::_configure(const TranscribeOptions& inOptions)
{
    mInstruments = uniqueInstruments(inOptions.instruments);

    for (const InstrumentGroup group: mInstruments) {
        if (instrumentName(group).empty()) {
            return false;
        }
    }

    mModel.setNumThreads(inOptions.n_threads);
    mModel.setInstrumentRows(InstrumentGroups::conditioningRows(mInstruments));

    // Guarded rather than called unconditionally: the reference forbids every
    // program and every drum for an empty selection, so passing one straight
    // through would turn "no filter" into "no instruments".
    if (mInstruments.empty()) {
        mModel.setForbiddenTokens({});
    } else {
        mModel.setForbiddenTokens(InstrumentGroups::forbiddenTokenIds(mInstruments));
    }

    return true;
}

std::optional<int> Transcriber::Impl::_restore(std::string_view inResumePoint,
                                               std::size_t inNSamples,
                                               const TranscribeOptions& inOptions,
                                               int inNChunks)
{
    std::optional<ResumeState> state = parseResumeState(inResumePoint);

    if (!state || state->n_samples != inNSamples || state->prelude_forcing != inOptions.prelude_forcing
        || state->instruments != mInstruments || state->decoded > inNChunks) {
        return std::nullopt;
    }

    const int last = state->decoded - 1;

    // Replayed through the same actions decoding produced, so the assembler
    // ends up holding exactly what it held then.
    for (const TrackedNote& tracked: state->withheld) {
        const NoteKey& key = tracked.key;

        if (tracked.drum_hit) {
            mAssembler.apply(std::vector {NoteAction {NoteActionKind::DrumHit, 0, key.pitch, tracked.note.onset}},
                             last);
        } else {
            mAssembler.apply(
                std::vector {NoteAction {NoteActionKind::Start, key.program, key.pitch, tracked.note.onset},
                             NoteAction {NoteActionKind::End, key.program, key.pitch, tracked.note.offset}},
                last);
        }
    }

    for (const OpenNoteTracker::OpenNote& note: state->open) {
        mAssembler.apply(std::vector {NoteAction {NoteActionKind::Start, note.key.program, note.key.pitch, note.onset}},
                         last);
    }

    mTracker.restore(std::move(state->open), last * SEGMENT_DURATION, state->in_prologue);

    return state->decoded;
}

std::string
    Transcriber::Impl::_resumePoint(std::size_t inNSamples, const TranscribeOptions& inOptions, int inDecoded) const
{
    ResumeState state;
    state.n_samples = inNSamples;
    state.prelude_forcing = inOptions.prelude_forcing;
    state.instruments = mInstruments;
    state.decoded = inDecoded;
    state.in_prologue = mTracker.inPrologue();
    state.open = mTracker.openNotes();

    // Earlier chunks' notes have all been reported, and nothing later depends on them.
    std::copy_if(mAssembler.closedNotes().begin(),
                 mAssembler.closedNotes().end(),
                 std::back_inserter(state.withheld),
                 [inDecoded](const TrackedNote& n) { return n.chunk_index == inDecoded - 1; });

    return serializeResumeState(state);
}

void Transcriber::Impl::_fillChunk(std::span<const float> inSamples, int inIndex)
{
    mChunk.assign(static_cast<std::size_t>(SEGMENT_SAMPLES), 0.0f);

    const std::size_t start = static_cast<std::size_t>(inIndex) * SEGMENT_SAMPLES;
    const std::size_t available = std::min<std::size_t>(SEGMENT_SAMPLES, inSamples.size() - start);
    std::copy_n(inSamples.begin() + static_cast<std::ptrdiff_t>(start), available, mChunk.begin());
}

std::expected<std::vector<Note>, Error> Transcriber::Impl::transcribe(std::span<const float> inSamples,
                                                                      const TranscribeOptions& inOptions,
                                                                      const NoteCallback& inCallback)
{
    // At the top, not the bottom: a previous call that was cancelled or threw
    // must not leave open notes for this one to inherit.
    mTracker.reset();
    mAssembler.reset();

    if (!_configure(inOptions)) {
        return std::unexpected(Error::InvalidArgument);
    }

    const int n_chunks = Transcriber::chunkCount(inSamples.size());
    int first_chunk = 0;

    if (!inOptions.resume_from.empty()) {
        const std::optional<int> resumed = _restore(inOptions.resume_from, inSamples.size(), inOptions, n_chunks);

        if (!resumed) {
            return std::unexpected(Error::InvalidResumePoint);
        }

        first_chunk = *resumed;
    }

    const ScopedCancel scoped_cancel(mModel, inOptions.should_cancel);

    for (int chunk = first_chunk; chunk < n_chunks; ++chunk) {
        if (inOptions.should_cancel && inOptions.should_cancel()) {
            return std::unexpected(Error::Cancelled);
        }

        _fillChunk(inSamples, chunk);

        // The tail is zero-padded and the padding is *not* masked away: the
        // conditioner is handed a full segment, so the model sees the trailing
        // silence as audio. That is what the reference does, and "improving" it
        // would change every note near the end of a signal.
        const std::vector<float> conditioning = mModel.encodeAudio(mChunk);

        ChunkBoundary boundary;
        boundary.seek_time = chunk * SEGMENT_DURATION;

        if (chunk + 1 < n_chunks) {
            boundary.next_seek_time = (chunk + 1) * SEGMENT_DURATION;
        }

        // Feed the boundary before reading open keys: it settles a previous
        // chunk that ended mid-prologue, and only then is openKeys() the
        // decoder's own view.
        mAssembler.apply(mTracker.feed(boundary), chunk);

        std::vector<std::int32_t> prompt;

        if (chunk > 0 && inOptions.prelude_forcing) {
            prompt = Vocabulary::tieSectionTokenIds(mTracker.openKeys());
        }

        // Clamped rather than allowed to overflow. A pathological prologue eats
        // into the generation budget, which is the right trade: the reference
        // treats running out without an EOS as a warning, not a failure.
        const int prefix = mMelFrames + 1 + static_cast<int>(mModel.instrumentRows().size());
        const int budget = mModel.contextSize() - prefix - 1;

        if (budget <= static_cast<int>(prompt.size())) {
            return std::unexpected(Error::ContextOverflow);
        }

        const int max_tokens = std::min(Transcriber::MAX_TOKENS_PER_CHUNK, budget);

        const std::vector<std::int32_t> tokens =
            mModel.generate(conditioning, mMelFrames, max_tokens, Vocabulary::EOS_ID, prompt);

        for (const std::int32_t token: tokens) {
            if (token == Vocabulary::EOS_ID) {
                break;
            }

            mAssembler.apply(mTracker.feed(token), chunk);
        }

        if (inCallback) {
            // One chunk late: a note is only final once the following chunk has
            // decoded, so releasing it now would mean correcting it later.
            const std::vector<Note> ready = chunk > 0 ? mAssembler.closedIn(chunk - 1) : std::vector<Note> {};

            TranscriptionUpdate update;
            update.new_notes = ready;
            // Chunks 0 through chunk-1 have been released, and each of them
            // closed only notes ending inside its own window.
            update.finalized_through = chunk * SEGMENT_DURATION;
            update.progress = static_cast<float>(chunk + 1) / static_cast<float>(n_chunks);
            update.resume_point = _resumePoint(inSamples.size(), inOptions, chunk + 1);

            if (!inCallback(update)) {
                return std::unexpected(Error::Cancelled);
            }
        }
    }

    if (n_chunks > 0) {
        mAssembler.apply(mTracker.finish(), n_chunks - 1);

        if (inCallback) {
            // The withheld tail. Notes finish() closes were open throughout, so
            // nothing can have opened on their channel to trim an earlier chunk's --
            // this call cannot invalidate anything already reported.
            const std::vector<Note> tail = mAssembler.closedIn(n_chunks - 1);

            TranscriptionUpdate update;
            update.new_notes = tail;
            // An under-claim: the last chunk has no window past it, so a note
            // there may end fractionally later. Claiming less than is known
            // costs a host nothing; claiming more would cost it a note.
            update.finalized_through = n_chunks * SEGMENT_DURATION;
            update.progress = 1.0f;

            if (!inCallback(update)) {
                return std::unexpected(Error::Cancelled);
            }
        }
    }

    return mAssembler.finalize();
}

// ---------------------------------------------------------------------------
// Transcriber
// ---------------------------------------------------------------------------

Transcriber::Transcriber() = default;
Transcriber::~Transcriber() = default;
Transcriber::Transcriber(Transcriber&&) noexcept = default;
Transcriber& Transcriber::operator=(Transcriber&&) noexcept = default;

int Transcriber::chunkCount(std::size_t inNSamples)
{
    return static_cast<int>((inNSamples + SEGMENT_SAMPLES - 1) / SEGMENT_SAMPLES);
}

std::expected<Transcriber, Error> Transcriber::load(const std::filesystem::path& inGgufPath, LoadOptions inOptions)
{
    try {
        ModelOptions options;
        options.device = inOptions.device;
        options.should_cancel = std::move(inOptions.should_cancel);
        options.on_progress = std::move(inOptions.on_progress);
        // The hparams are checked against these constants below.
        options.n_ctx = requiredContext(melFramesPerChunk(SAMPLE_RATE / Vocabulary::FRAME_RATE));

        Model model = Model::load(inGgufPath, options);
        const Hparams& hp = model.hparams();

        // This library is 16 kHz and 10 ms only: both are baked into the
        // segment length and into the decode state machine's tick arithmetic.
        if (hp.sample_rate != SAMPLE_RATE || hp.frame_rate != Vocabulary::FRAME_RATE
            || hp.hop_length != SAMPLE_RATE / Vocabulary::FRAME_RATE) {
            return std::unexpected(Error::UnsupportedArch);
        }

        Transcriber transcriber;
        transcriber.mImpl = std::make_unique<Impl>(std::move(model));
        return transcriber;
    } catch (const Exception& e) {
        return std::unexpected(e.error());
    } catch (const std::bad_alloc&) {
        return std::unexpected(Error::OutOfMemory);
    } catch (const std::exception&) {
        return std::unexpected(Error::Internal);
    }
}

const Device& Transcriber::device() const
{
    return mImpl->device();
}

std::expected<std::vector<Note>, Error> Transcriber::transcribe(std::span<const float> inSamples,
                                                                const TranscribeOptions& inOptions,
                                                                const NoteCallback& inCallback)
{
    try {
        return mImpl->transcribe(inSamples, inOptions, inCallback);
    } catch (const Exception& e) {
        return std::unexpected(e.error());
    } catch (const std::bad_alloc&) {
        return std::unexpected(Error::OutOfMemory);
    } catch (const std::exception&) {
        return std::unexpected(Error::Internal);
    }
}

} // namespace msl
