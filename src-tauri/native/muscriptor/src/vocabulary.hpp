#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace msl
{

/** The event kinds the MT3 vocabulary encodes, in vocabulary order. */
enum class EventType : std::int8_t {
    Pad,
    Eos,
    Unk,
    Shift,
    Pitch,
    Velocity,
    Tie,
    Program,
    Drum,
};

/** One decoded token: what it is, and the number it carries. */
struct TokenEvent {
    EventType type = EventType::Pad;
    std::int32_t value = 0;

    bool operator==(const TokenEvent&) const = default;
};

/** A note's identity for as long as it is sounding. */
struct NoteKey {
    int program = 0;
    int pitch = 0;

    auto operator<=>(const NoteKey&) const = default;
    bool operator==(const NoteKey&) const = default;
};

/**
 * The MT3 token vocabulary: a fixed arithmetic index<->event mapping.
 *
 * Despite the name upstream gives it this is not a text tokenizer. There is no
 * BPE, no merges file and nothing to load -- the vocabulary is contiguous
 * ranges concatenated in a fixed order, so a token id is a position in that
 * concatenation and a handful of comparisons reproduce it exactly. Everything
 * here is spec'd in docs/TOKENIZER.md section 1.
 */
class Vocabulary
{
public:
    static constexpr std::int32_t MAX_SHIFT_STEPS = 1001;

    // The ranges, laid out the way build_event_vocab concatenates them. Written
    // as running offsets rather than as literals so the structure stays visible
    // and a single wrong bound cannot hide.
    static constexpr std::int32_t PAD_ID = 0;
    static constexpr std::int32_t EOS_ID = 1;
    static constexpr std::int32_t UNK_ID = 2;

    static constexpr std::int32_t SHIFT_FIRST = 3;
    static constexpr std::int32_t SHIFT_COUNT = MAX_SHIFT_STEPS;

    static constexpr std::int32_t PITCH_FIRST = SHIFT_FIRST + SHIFT_COUNT;
    static constexpr std::int32_t PITCH_COUNT = 128;

    static constexpr std::int32_t VELOCITY_FIRST = PITCH_FIRST + PITCH_COUNT;
    static constexpr std::int32_t VELOCITY_COUNT = 2;

    static constexpr std::int32_t TIE_FIRST = VELOCITY_FIRST + VELOCITY_COUNT;
    static constexpr std::int32_t TIE_COUNT = 1;

    static constexpr std::int32_t PROGRAM_FIRST = TIE_FIRST + TIE_COUNT;
    static constexpr std::int32_t PROGRAM_COUNT = 130;

    static constexpr std::int32_t DRUM_FIRST = PROGRAM_FIRST + PROGRAM_COUNT;
    static constexpr std::int32_t DRUM_COUNT = 128;

    static constexpr std::int32_t NUM_TOKENS = DRUM_FIRST + DRUM_COUNT;

    /** The model's 10 ms grid, in frames per second. */
    static constexpr int FRAME_RATE = 100;

    /**
     * @param inTokenId A token id.
     * @return What it decodes to. Ids outside the vocabulary answer
     *         `EventType::Unk`, which the decode state machine ignores --
     *         the same thing the reference does with a token it has no rule
     *         for.
     */
    static TokenEvent eventFor(std::int32_t inTokenId);

    /**
     * @param inType Event kind.
     * @param inValue Its value; must be inside that kind's range.
     * @return The token id, or -1 if `inValue` is out of range.
     */
    static std::int32_t tokenFor(EventType inType, std::int32_t inValue);

    /**
     * Encode a tie prologue declaring `inOpenKeys` as still sounding.
     *
     * `program p, pitch a, pitch b, program q, pitch c, ..., tie`, over the
     * keys sorted by (program, pitch), with each program token emitted once for
     * its run of pitches. An empty set still yields the bare `tie`.
     *
     * This is both what prelude forcing teacher-forces and what the training
     * encoder produces, which is why the two agree.
     *
     * @param inOpenKeys Keys to declare; need not be sorted.
     * @return The prologue's token ids.
     */
    static std::vector<std::int32_t> tieSectionTokenIds(std::span<const NoteKey> inOpenKeys);
};

} // namespace msl
