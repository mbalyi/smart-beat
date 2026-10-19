#pragma once

#include "vocabulary.hpp"

#include <cstdint>
#include <optional>
#include <vector>

namespace msl
{

/** Marks the start of a chunk in the token stream. */
struct ChunkBoundary {
    // Where this chunk starts in the signal, in seconds.
    double seek_time = 0.0;
    // Where the next one starts; empty on the last chunk, which is what turns
    // the window-drop rule off there.
    std::optional<double> next_seek_time;
};

enum class NoteActionKind : std::int8_t { Start, End, DrumHit };

/** What the state machine decides a token means. */
struct NoteAction {
    NoteActionKind kind = NoteActionKind::Start;
    int program = 0;
    int pitch = 0;
    double time = 0.0;

    bool operator==(const NoteAction&) const = default;
};

/**
 * The decode state machine for the model's token stream.
 *
 * Consumes chunk boundaries and token ids in the order the model produces them
 * and answers with note actions. Every cross-chunk rule lives here: the tie
 * prologue (notes not re-declared close at the boundary), malformed chunks (a
 * shift before the `tie` token closes everything and drops the rest), the
 * `next_seek_time` window, and retriggers. Spec'd in docs/TOKENIZER.md
 * section 3.
 *
 * Two callers share it, exactly as upstream: note assembly consumes the
 * actions, and prelude forcing reads `openKeys()` at each boundary to build the
 * next chunk's forced prologue. One state machine serving both is what keeps
 * decoding and forcing consistent by construction.
 */
class OpenNoteTracker
{
public:
    /** An open note, and when it started. */
    struct OpenNote {
        NoteKey key;
        double onset = 0.0;
    };

    /**
     * Start a new chunk.
     *
     * Must be called before reading `openKeys()` for that boundary: a previous
     * chunk that ended mid-prologue drops all its open notes here, and only
     * afterwards is `openKeys()` the decoder's own view.
     */
    std::vector<NoteAction> feed(const ChunkBoundary& inBoundary);

    /** Consume one model token. */
    std::vector<NoteAction> feed(std::int32_t inTokenId);

    /** End of stream: close whatever is still sounding. */
    std::vector<NoteAction> finish();

    /** Still-sounding notes, sorted by (program, pitch). */
    std::vector<NoteKey> openKeys() const;

    /** Still-sounding notes, in the order they opened. */
    const std::vector<OpenNote>& openNotes() const { return mOpen; }

    /** Whether the current chunk has not reached its `tie` token yet. */
    bool inPrologue() const { return mInPrologue; }

    /**
     * Put the tracker where it was right after decoding the chunk starting at
     * `inSeekTime`: `inOpen` sounding, and that chunk still in its prologue if
     * `inInPrologue`. The next call must be `feed(ChunkBoundary)` or `finish()`.
     */
    void restore(std::vector<OpenNote> inOpen, double inSeekTime, bool inInPrologue);

    void reset();

private:
    std::vector<NoteAction> _endAll(double inTime);
    std::vector<NoteAction> _feedPrologue(const TokenEvent& inEvent);
    std::vector<NoteAction> _feedBody(const TokenEvent& inEvent);

    /**
     * Insertion-ordered on purpose, not a map.
     *
     * `finish()` replays its closes in insertion order, and that order reaches
     * the caller. A std::map would quietly reorder them by (program, pitch) and
     * nothing else in the pipeline would notice. There are a few dozen entries
     * at most, so linear lookup costs nothing.
     */
    std::vector<OpenNote> mOpen;

    // Per-chunk state. All of it resets at a boundary; mOpen does not.
    double mSeekTime = 0.0;
    std::optional<double> mNextSeekTime;
    int mStartTick = 0;
    int mTickState = 0;
    std::optional<int> mProgram;
    std::optional<int> mVelocity;
    bool mInPrologue = true;
    bool mSkipRest = false;
    bool mChunkStarted = false;
    std::vector<NoteKey> mTieSet;
};

} // namespace msl
