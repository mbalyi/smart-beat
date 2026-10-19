#include "instrument_groups.hpp"

#include "format.hpp"
#include "muscriptor/error.hpp"

#include "vocabulary.hpp"

#include <algorithm>
#include <array>
#include <iterator>
#include <string_view>

namespace msl
{

namespace
{

    struct NamedGroup {
        std::string_view name;
        std::int32_t group_id;
    };

#include "instrument_groups.inc"

    static_assert(REFERENCE_DRUM_PROGRAM == DRUM_PROGRAM, "note.hpp's DRUM_PROGRAM disagrees with the reference");

    static_assert(NAMED_GROUPS.size() == InstrumentGroups::MAX_SELECTABLE,
                  "MAX_SELECTABLE disagrees with the generated table; the KV context size depends on it");

    bool isValidGroupId(int inGroupId)
    {
        return inGroupId >= 0 && inGroupId < NUM_GROUPS;
    }

} // namespace

int InstrumentGroups::numGroups()
{
    return NUM_GROUPS;
}

int InstrumentGroups::representativeProgram(int inGroupId)
{
    if (!isValidGroupId(inGroupId)) {
        return -1;
    }

    return GROUP_REPRESENTATIVE[static_cast<std::size_t>(inGroupId)];
}

std::optional<int> InstrumentGroups::groupIdForProgram(int inProgram)
{
    const auto it = std::find(GROUP_REPRESENTATIVE.begin(), GROUP_REPRESENTATIVE.end(), inProgram);

    if (it == GROUP_REPRESENTATIVE.end()) {
        return std::nullopt;
    }

    return static_cast<int>(std::distance(GROUP_REPRESENTATIVE.begin(), it));
}

int InstrumentGroups::groupIdFor(InstrumentGroup inGroup)
{
    return static_cast<int>(inGroup);
}

std::string_view InstrumentGroups::nameForGroupId(int inGroupId)
{
    const auto it = std::find_if(
        NAMED_GROUPS.begin(), NAMED_GROUPS.end(), [inGroupId](const NamedGroup& g) { return g.group_id == inGroupId; });

    return it == NAMED_GROUPS.end() ? std::string_view {} : it->name;
}

std::optional<InstrumentGroup> InstrumentGroups::groupForName(std::string_view inName)
{
    const auto it = std::find_if(
        NAMED_GROUPS.begin(), NAMED_GROUPS.end(), [inName](const NamedGroup& g) { return g.name == inName; });

    if (it == NAMED_GROUPS.end()) {
        return std::nullopt;
    }

    return static_cast<InstrumentGroup>(it->group_id);
}

std::int32_t InstrumentGroups::conditioningRow(InstrumentGroup inGroup)
{
    return groupIdFor(inGroup) + 2;
}

std::vector<std::int32_t> InstrumentGroups::forbiddenTokenIds(std::span<const InstrumentGroup> inGroups)
{
    if (inGroups.empty()) {
        throw Exception(Error::Internal,
                        "forbiddenTokenIds needs a non-empty selection: the reference forbids "
                        "every program and every drum for an empty one");
    }

    const bool allow_drums = std::find(inGroups.begin(), inGroups.end(), InstrumentGroup::Drums) != inGroups.end();

    // Drums contributes no allowed program: it is not a program group, and the
    // reference skips it here rather than allowing its representative (96).
    std::vector<int> allowed_programs;
    for (const InstrumentGroup group: inGroups) {
        if (group == InstrumentGroup::Drums) {
            continue;
        }

        const int program = representativeProgram(groupIdFor(group));

        if (program >= 0) {
            allowed_programs.push_back(program);
        }
    }

    std::vector<std::int32_t> forbidden;
    forbidden.reserve(static_cast<std::size_t>(Vocabulary::PROGRAM_COUNT + Vocabulary::DRUM_COUNT));

    for (std::int32_t value = 0; value < Vocabulary::PROGRAM_COUNT; ++value) {
        if (std::find(allowed_programs.begin(), allowed_programs.end(), value) == allowed_programs.end()) {
            forbidden.push_back(Vocabulary::tokenFor(EventType::Program, value));
        }
    }

    if (!allow_drums) {
        for (std::int32_t value = 0; value < Vocabulary::DRUM_COUNT; ++value) {
            forbidden.push_back(Vocabulary::tokenFor(EventType::Drum, value));
        }
    }

    return forbidden;
}

std::vector<std::int32_t> InstrumentGroups::conditioningRows(std::span<const InstrumentGroup> inGroups)
{
    if (inGroups.empty()) {
        return {NULL_CONDITIONING_ROW};
    }

    std::vector<std::int32_t> rows;
    rows.reserve(inGroups.size());
    std::transform(inGroups.begin(), inGroups.end(), std::back_inserter(rows), conditioningRow);
    return rows;
}

// ---------------------------------------------------------------------------
// The public lookups, which are thin wrappers over the table
// ---------------------------------------------------------------------------

std::span<const InstrumentGroup> allInstrumentGroups()
{
    static const std::vector<InstrumentGroup> groups = [] {
        std::vector<InstrumentGroup> out;
        out.reserve(NAMED_GROUPS.size());
        std::transform(NAMED_GROUPS.begin(), NAMED_GROUPS.end(), std::back_inserter(out), [](const NamedGroup& g) {
            return static_cast<InstrumentGroup>(g.group_id);
        });

        return out;
    }();

    return groups;
}

std::optional<InstrumentGroup> instrumentGroupFor(int inProgram)
{
    if (inProgram == DRUM_PROGRAM) {
        return InstrumentGroup::Drums;
    }

    const std::optional<int> group_id = InstrumentGroups::groupIdForProgram(inProgram);

    if (!group_id.has_value() || InstrumentGroups::nameForGroupId(*group_id).empty()) {
        return std::nullopt;
    }

    return static_cast<InstrumentGroup>(*group_id);
}

std::string_view instrumentName(InstrumentGroup inGroup)
{
    return InstrumentGroups::nameForGroupId(InstrumentGroups::groupIdFor(inGroup));
}

int programFor(InstrumentGroup inGroup)
{
    if (inGroup == InstrumentGroup::Drums) {
        return DRUM_PROGRAM;
    }

    return InstrumentGroups::representativeProgram(InstrumentGroups::groupIdFor(inGroup));
}

std::string instrumentLabel(int inProgram)
{
    const std::optional<InstrumentGroup> group = instrumentGroupFor(inProgram);

    if (group.has_value()) {
        return std::string(instrumentName(*group));
    }

    return msl::format("program_{}", inProgram);
}

} // namespace msl
