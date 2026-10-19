// GENERATED FILE -- do not edit. Regenerate with `uv run msl-tables --emit-cpp`.
//
// The MT3_FULL_PLUS instrument groups, read off the reference tokenizer rather
// than reimplemented. Upstream assigns the singleton groups (36 and up) by
// iterating a Python set of unassigned programs, so their group-id to program
// mapping is an artifact of CPython's set ordering and not of anything written
// down. test_instrument_groups.cpp asserts this table against
// testdata/vectors/tables.json, which is what keeps the two from drifting.


constexpr int NUM_GROUPS = 66;

// Cross-checks the value the public header hard-codes.
constexpr int REFERENCE_DRUM_PROGRAM = 128;

// Group id -> the group's first program, which is the only one the model
// ever emits for that group.
constexpr std::array<std::int16_t, NUM_GROUPS> GROUP_REPRESENTATIVE {{
      0,   2,   8,  16,  24,  26,  29,  32,  33,  40,  41,  42,
     43,  46,  47,  48,  50,  52,  55,  56,  57,  58,  60,  61,
     64,  66,  67,  68,  69,  70,  71,  72,  80,  88, 100, 101,
     96,  97,  98,  99, 102, 103, 104, 105, 106, 107, 108, 109,
    110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121,
    122, 123, 124, 125, 126, 127,
}};

// The user-facing names. Group ids without one surface as their
// program number instead, matching the reference's program_<n>.
constexpr std::array<NamedGroup, 35> NAMED_GROUPS {{
    {"acoustic_piano", 0},
    {"electric_piano", 1},
    {"chromatic_percussion", 2},
    {"organ", 3},
    {"acoustic_guitar", 4},
    {"clean_electric_guitar", 5},
    {"distorted_electric_guitar", 6},
    {"acoustic_bass", 7},
    {"electric_bass", 8},
    {"violin", 9},
    {"viola", 10},
    {"cello", 11},
    {"contrabass", 12},
    {"orchestral_harp", 13},
    {"timpani", 14},
    {"string_ensemble", 15},
    {"synth_strings", 16},
    {"voice", 17},
    {"orchestra_hit", 18},
    {"trumpet", 19},
    {"trombone", 20},
    {"tuba", 21},
    {"french_horn", 22},
    {"brass_section", 23},
    {"soprano_and_alto_sax", 24},
    {"tenor_sax", 25},
    {"baritone_sax", 26},
    {"oboe", 27},
    {"english_horn", 28},
    {"bassoon", 29},
    {"clarinet", 30},
    {"flutes", 31},
    {"synth_lead", 32},
    {"synth_pad", 33},
    {"drums", 36},
}};
