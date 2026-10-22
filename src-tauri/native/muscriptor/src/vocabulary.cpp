#include "vocabulary.hpp"

#include <algorithm>
#include <array>

namespace msl
{

namespace
{

    /** Range descriptor, so eventFor and tokenFor cannot disagree. */
    struct Range {
        EventType type;
        std::int32_t first;
        std::int32_t count;
    };

    constexpr std::array<Range, 9> RANGES {{
        {EventType::Pad, Vocabulary::PAD_ID, 1},
        {EventType::Eos, Vocabulary::EOS_ID, 1},
        {EventType::Unk, Vocabulary::UNK_ID, 1},
        {EventType::Shift, Vocabulary::SHIFT_FIRST, Vocabulary::SHIFT_COUNT},
        {EventType::Pitch, Vocabulary::PITCH_FIRST, Vocabulary::PITCH_COUNT},
        {EventType::Velocity, Vocabulary::VELOCITY_FIRST, Vocabulary::VELOCITY_COUNT},
        {EventType::Tie, Vocabulary::TIE_FIRST, Vocabulary::TIE_COUNT},
        {EventType::Program, Vocabulary::PROGRAM_FIRST, Vocabulary::PROGRAM_COUNT},
        {EventType::Drum, Vocabulary::DRUM_FIRST, Vocabulary::DRUM_COUNT},
    }};

} // namespace

TokenEvent Vocabulary::eventFor(std::int32_t inTokenId)
{
    for (const Range& range: RANGES) {
        if (inTokenId >= range.first && inTokenId < range.first + range.count) {
            return {range.type, inTokenId - range.first};
        }
    }

    return {EventType::Unk, 0};
}

std::int32_t Vocabulary::tokenFor(EventType inType, std::int32_t inValue)
{
    for (const Range& range: RANGES) {
        if (range.type == inType) {
            return inValue >= 0 && inValue < range.count ? range.first + inValue : -1;
        }
    }

    return -1;
}

std::vector<std::int32_t> Vocabulary::tieSectionTokenIds(std::span<const NoteKey> inOpenKeys)
{
    std::vector<NoteKey> sorted(inOpenKeys.begin(), inOpenKeys.end());
    std::sort(sorted.begin(), sorted.end());

    std::vector<std::int32_t> tokens;
    tokens.reserve(sorted.size() * 2 + 1);

    // Tracks the sticky program register the decoder will be in, so a program
    // token is emitted once per run rather than once per pitch. Seeded with a
    // value no program can take, so the first key always emits one.
    int program_state = -1;

    for (const NoteKey& key: sorted) {
        if (key.program != program_state) {
            tokens.push_back(tokenFor(EventType::Program, key.program));
            program_state = key.program;
        }

        tokens.push_back(tokenFor(EventType::Pitch, key.pitch));
    }

    tokens.push_back(tokenFor(EventType::Tie, 0));
    return tokens;
}

} // namespace msl
