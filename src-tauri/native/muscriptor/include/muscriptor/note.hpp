#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace msl
{

/**
 * The MT3_FULL_PLUS instrument groups that have a name: 34 groups plus Drums.
 *
 * Enumerators are the reference's group ids, so they are not contiguous. The
 * other 31 of the 66 groups are unnamed; `Note::program` identifies those.
 */
enum class InstrumentGroup : std::int32_t {
    AcousticPiano = 0,
    ElectricPiano = 1,
    ChromaticPercussion = 2,
    Organ = 3,
    AcousticGuitar = 4,
    CleanElectricGuitar = 5,
    DistortedElectricGuitar = 6,
    AcousticBass = 7,
    ElectricBass = 8,
    Violin = 9,
    Viola = 10,
    Cello = 11,
    Contrabass = 12,
    OrchestralHarp = 13,
    Timpani = 14,
    StringEnsemble = 15,
    SynthStrings = 16,
    Voice = 17,
    OrchestraHit = 18,
    Trumpet = 19,
    Trombone = 20,
    Tuba = 21,
    FrenchHorn = 22,
    BrassSection = 23,
    SopranoAndAltoSax = 24,
    TenorSax = 25,
    BaritoneSax = 26,
    Oboe = 27,
    EnglishHorn = 28,
    Bassoon = 29,
    Clarinet = 30,
    Flutes = 31,
    SynthLead = 32,
    SynthPad = 33,
    Drums = 36,
};

/** The program number the reference assigns to drum hits. */
inline constexpr int DRUM_PROGRAM = 128;

/** Shortest note the reference will emit, and its fallback duration. */
inline constexpr double MINIMUM_NOTE_DURATION_SECONDS = 0.01;

/** One transcribed note. The model predicts no velocity. */
struct Note {
    // Seconds, absolute in the input signal. Onsets land on the model's 10 ms
    // grid; offsets may not, after overlap trimming.
    double onset = 0.0;
    double offset = 0.0;

    // MIDI note number, 0-127. For a drum hit this is the GM percussion note.
    int pitch = 0;

    // The MIDI program the model decoded, or DRUM_PROGRAM for a drum hit.
    int program = 0;

    // Drum-token hits last the 10 ms minimum. A decoded program 96 is routed to
    // drums and keeps its decoded offset.
    bool is_drum = false;
};

/** @return Every named group, in enumerator order. */
std::span<const InstrumentGroup> allInstrumentGroups();

/**
 * @param inProgram A decoded program number, or DRUM_PROGRAM.
 * @return The named group it belongs to, or nothing for an unnamed group.
 *         Program 96 answers `Drums`, as in the reference (docs/TOKENIZER.md
 *         section 5).
 */
std::optional<InstrumentGroup> instrumentGroupFor(int inProgram);

/** @return The group's name, e.g. "electric_bass". */
std::string_view instrumentName(InstrumentGroup inGroup);

/** @return The program the model emits for `inGroup`; DRUM_PROGRAM for Drums. */
int programFor(InstrumentGroup inGroup);

/** @return The group name where there is one, otherwise "program_<n>". */
std::string instrumentLabel(int inProgram);

} // namespace msl
