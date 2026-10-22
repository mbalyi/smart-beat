#pragma once

#include "muscriptor/note.hpp"

#include "note_assembler.hpp"
#include "open_note_tracker.hpp"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace msl
{

/**
 * Everything `transcribe` carries from one chunk to the next, plus what the
 * resumed call has to match.
 *
 * Serialised as whitespace-separated text, times in whole 10 ms frames:
 *
 *     muscriptor-resume 1
 *     samples 240000          signal length
 *     prelude 1               prelude_forcing
 *     instruments 2 33 35     count, then the selection
 *     decoded 2               chunks done
 *     prologue 0              1 if the last chunk never reached its tie token
 *     open 2                  count, then: program pitch onset
 *     29 48 992
 *     33 38 992
 *     withheld 2              count, then: n program pitch onset offset
 *     n 29 46 491 515                           or d pitch onset (drum hit)
 *     d 38 515
 *
 * (The right-hand annotations are not part of it.)
 */
struct ResumeState {
    std::size_t n_samples = 0;
    bool prelude_forcing = true;
    std::vector<InstrumentGroup> instruments;

    // Chunks decoded; a resumed call starts at this chunk.
    int decoded = 0;

    // The last decoded chunk never reached its `tie` token.
    bool in_prologue = false;

    // In the order they opened.
    std::vector<OpenNoteTracker::OpenNote> open;

    // Closed during the last decoded chunk and not reported yet, in close order.
    std::vector<TrackedNote> withheld;
};

/**
 * @return The resume point string. Throws `Error::Internal` if a time is not
 *         on the model's frame grid, which decoding never produces.
 */
std::string serializeResumeState(const ResumeState& inState);

/**
 * @return The state, or nothing if `inText` is not a well-formed resume point
 *         of this format version. Checks the format only, not that it fits a
 *         given signal or options.
 */
std::optional<ResumeState> parseResumeState(std::string_view inText);

} // namespace msl
