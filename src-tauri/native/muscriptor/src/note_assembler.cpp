#include "note_assembler.hpp"

#include "format.hpp"
#include "muscriptor/error.hpp"

#include <algorithm>
#include <iterator>
#include <numeric>
#include <optional>
#include <tuple>

namespace msl
{

namespace
{

    /** The reference's `sort_notes` key. */
    bool notesLess(const Note& inLeft, const Note& inRight)
    {
        return std::tie(inLeft.onset, inLeft.is_drum, inLeft.program, inLeft.pitch, inLeft.offset)
               < std::tie(inRight.onset, inRight.is_drum, inRight.program, inRight.pitch, inRight.offset);
    }

    void validateTracked(std::vector<TrackedNote>& ioNotes)
    {
        for (TrackedNote& tracked: ioNotes) {
            Note& note = tracked.note;

            // The last two branches of the reference's chain (note_assembler.hpp).
            if (note.onset > note.offset) {
                note.offset = std::max(note.offset, note.onset + MINIMUM_NOTE_DURATION_SECONDS);
            } else if (!note.is_drum && note.offset - note.onset < MINIMUM_NOTE_DURATION_SECONDS) {
                note.offset = note.onset + MINIMUM_NOTE_DURATION_SECONDS;
            }
        }
    }

    std::vector<TrackedNote> trimTracked(std::span<const TrackedNote> inNotes)
    {
        if (inNotes.size() <= 1) {
            return {inNotes.begin(), inNotes.end()};
        }

        // Channel identity for trimming. Drums share the (program, pitch) space
        // with melodic notes -- both can be program 128 -- so is_drum is part of
        // the key rather than implied by it.
        const auto channel = [](const TrackedNote& n) {
            return std::tuple(n.note.program, n.note.pitch, n.note.is_drum);
        };

        std::vector<std::size_t> order(inNotes.size());
        std::iota(order.begin(), order.end(), 0);

        // Group by channel while preserving the master (close) order inside
        // each group: the reference filters the master list per channel and
        // then does a *stable* sort on onset alone, so equal onsets keep close
        // order. Sorting by the full five-key comparator here instead would
        // change which of two coincident notes gets truncated.
        std::stable_sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) {
            return channel(inNotes[a]) < channel(inNotes[b]);
        });

        std::vector<TrackedNote> trimmed;
        trimmed.reserve(inNotes.size());

        std::size_t start = 0;
        while (start < order.size()) {
            std::size_t end = start + 1;
            while (end < order.size() && channel(inNotes[order[end]]) == channel(inNotes[order[start]])) {
                ++end;
            }

            std::vector<TrackedNote> group;
            group.reserve(end - start);
            std::transform(order.begin() + static_cast<std::ptrdiff_t>(start),
                           order.begin() + static_cast<std::ptrdiff_t>(end),
                           std::back_inserter(group),
                           [&](std::size_t index) { return inNotes[index]; });

            std::stable_sort(group.begin(), group.end(), [](const TrackedNote& a, const TrackedNote& b) {
                return a.note.onset < b.note.onset;
            });

            for (std::size_t i = 1; i < group.size(); ++i) {
                if (group[i - 1].note.offset > group[i].note.onset) {
                    group[i - 1].note.offset = group[i].note.onset;
                }
            }

            std::copy_if(group.begin(), group.end(), std::back_inserter(trimmed), [](const TrackedNote& n) {
                return n.note.onset < n.note.offset;
            });

            start = end;
        }

        std::sort(trimmed.begin(), trimmed.end(), [](const TrackedNote& a, const TrackedNote& b) {
            return notesLess(a.note, b.note);
        });

        return trimmed;
    }

    std::vector<Note> unwrap(std::span<const TrackedNote> inNotes)
    {
        std::vector<Note> notes;
        notes.reserve(inNotes.size());
        std::transform(
            inNotes.begin(), inNotes.end(), std::back_inserter(notes), [](const TrackedNote& n) { return n.note; });

        return notes;
    }

    std::vector<TrackedNote> wrap(std::span<const Note> inNotes)
    {
        std::vector<TrackedNote> tracked;
        tracked.reserve(inNotes.size());
        std::transform(inNotes.begin(), inNotes.end(), std::back_inserter(tracked), [](const Note& n) {
            return TrackedNote {n, 0, {n.program, n.pitch}};
        });

        return tracked;
    }

} // namespace

void NoteAssembler::reset()
{
    mClosed.clear();
    mOpen.clear();
}

void NoteAssembler::apply(std::span<const NoteAction> inActions, int inChunkIndex)
{
    for (const NoteAction& action: inActions) {
        switch (action.kind) {
            case NoteActionKind::Start: {
                const std::optional<InstrumentGroup> group = instrumentGroupFor(action.program);
                const bool is_drum = group == InstrumentGroup::Drums;

                Note note;
                note.onset = action.time;
                note.offset = action.time;
                note.pitch = action.pitch;
                // Resolved through the group name, not copied from the token:
                // a decoded program 96 names itself "drums" upstream and is
                // routed as one, and this is where that has to happen -- it
                // changes the trimming channel, so doing it at label time
                // instead would produce a different note list.
                note.program = is_drum ? DRUM_PROGRAM : action.program;
                note.is_drum = is_drum;

                mOpen.push_back({note, inChunkIndex, {action.program, action.pitch}});
                break;
            }

            case NoteActionKind::End: {
                const NoteKey key {action.program, action.pitch};
                const auto it =
                    std::find_if(mOpen.begin(), mOpen.end(), [&key](const TrackedNote& n) { return n.key == key; });

                if (it == mOpen.end()) {
                    throw Exception(Error::Internal,
                                    msl::format("note end for (program {}, pitch {}) with nothing open",
                                                action.program,
                                                action.pitch));
                }

                TrackedNote closed = *it;
                mOpen.erase(it);
                closed.note.offset = action.time;
                closed.chunk_index = inChunkIndex;
                mClosed.push_back(closed);
                break;
            }

            case NoteActionKind::DrumHit: {
                Note note;
                note.onset = action.time;
                note.offset = action.time + MINIMUM_NOTE_DURATION_SECONDS;
                note.pitch = action.pitch;
                note.program = DRUM_PROGRAM;
                note.is_drum = true;

                mClosed.push_back({note, inChunkIndex, {DRUM_PROGRAM, action.pitch}, true});
                break;
            }
        }
    }
}

std::vector<Note> NoteAssembler::finalize() const
{
    std::vector<TrackedNote> notes = mClosed;
    validateTracked(notes);
    return unwrap(trimTracked(notes));
}

std::vector<Note> NoteAssembler::closedIn(int inChunkIndex) const
{
    std::vector<TrackedNote> window;
    std::copy_if(mClosed.begin(), mClosed.end(), std::back_inserter(window), [inChunkIndex](const TrackedNote& n) {
        return n.chunk_index == inChunkIndex || n.chunk_index == inChunkIndex + 1;
    });

    validateTracked(window);
    const std::vector<TrackedNote> trimmed = trimTracked(window);

    std::vector<TrackedNote> mine;
    std::copy_if(trimmed.begin(), trimmed.end(), std::back_inserter(mine), [inChunkIndex](const TrackedNote& n) {
        return n.chunk_index == inChunkIndex;
    });

    return unwrap(mine);
}

void validateNotes(std::vector<Note>& ioNotes)
{
    std::vector<TrackedNote> tracked = wrap(ioNotes);
    validateTracked(tracked);
    ioNotes = unwrap(tracked);
}

std::vector<Note> trimOverlappingNotes(std::span<const Note> inNotes)
{
    return unwrap(trimTracked(wrap(inNotes)));
}

void sortNotes(std::vector<Note>& ioNotes)
{
    std::sort(ioNotes.begin(), ioNotes.end(), notesLess);
}

} // namespace msl
