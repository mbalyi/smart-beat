#pragma once

#include "muscriptor/note.hpp"

#include "open_note_tracker.hpp"

#include <cstddef>
#include <span>
#include <vector>

namespace msl
{

/** A note plus the provenance the cleanup passes and the streaming slice need. */
struct TrackedNote {
    Note note;
    // Which chunk the note *closed* in, which is not necessarily where it began.
    int chunk_index = 0;
    NoteKey key;
    // From a drum token rather than a start and an end.
    bool drum_hit = false;
};

/**
 * Turns note actions into `Note`s, and runs the reference's cleanup passes.
 *
 * Notes are completed and appended when they *close*, so the append order is
 * close order. That order is load-bearing: `trimOverlappingNotes` sorts each
 * channel by onset with a stable sort, so ties inherit it.
 */
class NoteAssembler
{
public:
    /**
     * @param inActions Actions from one chunk, in order.
     * @param inChunkIndex Which chunk produced them. Recorded per note so the
     *        streaming caller can ask for a single chunk's worth.
     */
    void apply(std::span<const NoteAction> inActions, int inChunkIndex);

    /**
     * Notes that closed during `inChunkIndex`, cleaned.
     *
     * Cleaned over chunks `inChunkIndex` and `inChunkIndex + 1` together, then
     * filtered back: a note's offset can only be truncated by a note starting
     * strictly inside it, and on the model's 10 ms grid that neighbour is at
     * most one chunk away. So this is what the final `finalize()` would produce
     * for these notes, which is what makes the streaming callback append-only
     * rather than provisional.
     *
     * (The exception is a chunk whose shifts run backwards -- nothing at
     * inference forbids it, though the model does not do it -- where a much
     * later note could in principle truncate an earlier one. `finalize()` is
     * always authoritative.)
     */
    std::vector<Note> closedIn(int inChunkIndex) const;

    /** Every note, cleaned over the whole list and globally sorted. */
    std::vector<Note> finalize() const;

    /** Closed notes as `apply` recorded them, uncleaned, in close order. */
    const std::vector<TrackedNote>& closedNotes() const { return mClosed; }

    void reset();

private:
    // Append order is close order; see the class comment.
    std::vector<TrackedNote> mClosed;

    // Notes opened but not yet closed, in insertion order.
    std::vector<TrackedNote> mOpen;
};

/**
 * `validate_notes(fix=True)`.
 *
 * An if/else-if chain, not four independent rules -- that is how the reference
 * writes it, and the branches are not commutative:
 *
 *   onset missing                            -> drop
 *   else if offset missing                   -> onset + 10 ms
 *   else if onset > offset                   -> max(offset, onset + 10 ms)
 *   else if !is_drum and shorter than 10 ms  -> onset + 10 ms
 *
 * The first two cannot arise here (a Note always has both), so only the last
 * two do any work.
 */
void validateNotes(std::vector<Note>& ioNotes);

/**
 * `trim_overlapping_notes(sort=True)`.
 *
 * Per (program, pitch, is_drum) channel, truncate each note's offset to the
 * next onset in that channel, drop anything left empty, then sort the survivors
 * by (onset, is_drum, program, pitch, offset).
 *
 * @return The surviving notes, sorted.
 */
std::vector<Note> trimOverlappingNotes(std::span<const Note> inNotes);

/** `sort_notes`: (onset, is_drum, program, pitch, offset). */
void sortNotes(std::vector<Note>& ioNotes);

} // namespace msl
