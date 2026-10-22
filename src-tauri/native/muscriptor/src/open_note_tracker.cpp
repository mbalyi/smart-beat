#include "open_note_tracker.hpp"

#include "muscriptor/note.hpp"

#include <algorithm>
#include <cmath>
#include <iterator>

namespace msl
{

void OpenNoteTracker::reset()
{
    mOpen.clear();
    mSeekTime = 0.0;
    mNextSeekTime.reset();
    mStartTick = 0;
    mTickState = 0;
    mProgram.reset();
    mVelocity.reset();
    mInPrologue = true;
    mSkipRest = false;
    mChunkStarted = false;
    mTieSet.clear();
}

void OpenNoteTracker::restore(std::vector<OpenNote> inOpen, double inSeekTime, bool inInPrologue)
{
    reset();
    mOpen = std::move(inOpen);
    mSeekTime = inSeekTime;
    mInPrologue = inInPrologue;
    mChunkStarted = true;
}

std::vector<NoteAction> OpenNoteTracker::_endAll(double inTime)
{
    std::vector<NoteAction> actions;
    actions.reserve(mOpen.size());

    for (const OpenNote& note: mOpen) {
        actions.push_back({NoteActionKind::End, note.key.program, note.key.pitch, inTime});
    }

    mOpen.clear();
    return actions;
}

std::vector<NoteAction> OpenNoteTracker::feed(const ChunkBoundary& inBoundary)
{
    std::vector<NoteAction> actions;

    // A previous chunk that never closed its tie prologue is malformed: it
    // declared nothing, so everything still sounding ends at *its* boundary,
    // not at this one.
    if (mChunkStarted && mInPrologue) {
        actions = _endAll(mSeekTime);
    }

    mSeekTime = inBoundary.seek_time;
    mNextSeekTime = inBoundary.next_seek_time;
    mStartTick = static_cast<int>(std::llround(inBoundary.seek_time * Vocabulary::FRAME_RATE));
    mTickState = mStartTick;
    mProgram.reset();
    mVelocity.reset();
    mInPrologue = true;
    mSkipRest = false;
    mChunkStarted = true;
    mTieSet.clear();

    return actions;
}

std::vector<NoteAction> OpenNoteTracker::feed(std::int32_t inTokenId)
{
    if (mSkipRest) {
        return {};
    }

    const TokenEvent event = Vocabulary::eventFor(inTokenId);
    return mInPrologue ? _feedPrologue(event) : _feedBody(event);
}

std::vector<NoteAction> OpenNoteTracker::_feedPrologue(const TokenEvent& inEvent)
{
    switch (inEvent.type) {
        case EventType::Tie: {
            // End of the tie section. Everything not re-declared stops sounding
            // here -- this is the whole cross-chunk mechanism.
            mInPrologue = false;
            mVelocity.reset();

            std::vector<NoteAction> actions;
            std::vector<OpenNote> kept;
            kept.reserve(mOpen.size());

            for (const OpenNote& note: mOpen) {
                if (std::find(mTieSet.begin(), mTieSet.end(), note.key) != mTieSet.end()) {
                    kept.push_back(note);
                } else {
                    actions.push_back({NoteActionKind::End, note.key.program, note.key.pitch, mSeekTime});
                }
            }

            mOpen = std::move(kept);
            return actions;
        }

        case EventType::Shift: {
            // No tie token: the chunk is malformed. Close everything and throw
            // away the rest of it, including a tie that turns up later.
            mInPrologue = false;
            mSkipRest = true;
            return _endAll(mSeekTime);
        }

        case EventType::Program: {
            mProgram = inEvent.value;
            return {};
        }

        case EventType::Pitch: {
            if (mProgram.has_value()) {
                mTieSet.push_back({*mProgram, inEvent.value});
            }

            return {};
        }

        default:
            return {};
    }
}

std::vector<NoteAction> OpenNoteTracker::_feedBody(const TokenEvent& inEvent)
{
    switch (inEvent.type) {
        case EventType::Shift: {
            // Absolute within the chunk, and 0 is a no-op rather than a rewind.
            // Reading it as a delta produces plausible, progressively-wrong
            // timing that nothing else catches.
            if (inEvent.value > 0) {
                mTickState = mStartTick + inEvent.value;
            }

            return {};
        }

        case EventType::Program: {
            mProgram = inEvent.value;
            return {};
        }

        case EventType::Velocity: {
            mVelocity = inEvent.value;
            return {};
        }

        case EventType::Drum: {
            const double time = static_cast<double>(mTickState) / Vocabulary::FRAME_RATE;

            if (mNextSeekTime.has_value() && time >= *mNextSeekTime) {
                return {};
            }

            // Instantaneous, never enters the open set, and reads neither
            // register.
            return {{NoteActionKind::DrumHit, 0, inEvent.value, time}};
        }

        case EventType::Pitch: {
            if (!mProgram.has_value() || !mVelocity.has_value()) {
                return {};
            }

            const double time = static_cast<double>(mTickState) / Vocabulary::FRAME_RATE;

            // The model routinely emits events past the end of its own window;
            // they belong to the next chunk, which will decide for itself.
            if (mNextSeekTime.has_value() && time >= *mNextSeekTime) {
                return {};
            }

            const NoteKey key {*mProgram, inEvent.value};
            std::vector<NoteAction> actions;

            const auto it =
                std::find_if(mOpen.begin(), mOpen.end(), [&key](const OpenNote& n) { return n.key == key; });

            if (it != mOpen.end()) {
                mOpen.erase(it);
                actions.push_back({NoteActionKind::End, key.program, key.pitch, time});
            }

            // Velocity is an on/off flag, not dynamics. A pitch that is already
            // open and gets velocity 1 therefore retriggers: closed just above,
            // reopened here, at the same instant.
            if (*mVelocity > 0) {
                mOpen.push_back({key, time});
                actions.push_back({NoteActionKind::Start, key.program, key.pitch, time});
            }

            return actions;
        }

        default:
            return {};
    }
}

std::vector<NoteAction> OpenNoteTracker::finish()
{
    // A stream that ran out mid-prologue never declared anything, so its open
    // notes end at the boundary rather than getting the minimum duration.
    if (mChunkStarted && mInPrologue) {
        return _endAll(mSeekTime);
    }

    std::vector<NoteAction> actions;
    actions.reserve(mOpen.size());

    for (const OpenNote& note: mOpen) {
        actions.push_back(
            {NoteActionKind::End, note.key.program, note.key.pitch, note.onset + MINIMUM_NOTE_DURATION_SECONDS});
    }

    mOpen.clear();
    return actions;
}

std::vector<NoteKey> OpenNoteTracker::openKeys() const
{
    std::vector<NoteKey> keys;
    keys.reserve(mOpen.size());
    std::transform(mOpen.begin(), mOpen.end(), std::back_inserter(keys), [](const OpenNote& n) { return n.key; });

    std::sort(keys.begin(), keys.end());
    return keys;
}

} // namespace msl
