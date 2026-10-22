#pragma once

#include "muscriptor/note.hpp"

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace msl
{

/**
 * The MT3_FULL_PLUS instrument grouping, and the two ways a caller's
 * instrument selection reaches the model.
 *
 * The table itself is generated (`instrument_groups.inc`) rather than written,
 * because upstream derives the singleton groups by iterating a Python set --
 * see the generated file's own header. Everything here is arithmetic on top of
 * that table.
 */
class InstrumentGroups
{
public:
    /** Every group, named or not. */
    static int numGroups();

    /** @return The only program the model emits for `inGroupId`, or -1. */
    static int representativeProgram(int inGroupId);

    /** @return The group `inProgram` represents, or nothing if it represents none. */
    static std::optional<int> groupIdForProgram(int inProgram);

    /** @return The group id behind `inGroup`. */
    static int groupIdFor(InstrumentGroup inGroup);

    /** @return The name for `inGroupId`, or empty if the group has none. */
    static std::string_view nameForGroupId(int inGroupId);

    /** @return The group with this exact name, or nothing. */
    static std::optional<InstrumentGroup> groupForName(std::string_view inName);

    /**
     * @return The instrument_group conditioner's embedding row for `inGroup`.
     *
     * `ClassConditioner::tokenize` adds one and `forward` adds one again, so a
     * group id lands on row `id + 2`. Spelled out because the double offset
     * reads like an off-by-one at a glance.
     */
    static std::int32_t conditioningRow(InstrumentGroup inGroup);

    /**
     * The row either class conditioner (dataset or instrument group) embeds when
     * given no class: `tokenize` maps it to 0 and `forward` adds one.
     */
    static constexpr std::int32_t NULL_CONDITIONING_ROW = 1;

    /**
     * Named groups, and so the most conditioning rows a selection can add.
     * Static-asserted against the generated table, which is where the real
     * count lives.
     */
    static constexpr int MAX_SELECTABLE = 35;

    /**
     * Token ids to force to -inf so nothing outside `inGroups` can be decoded:
     * every `program` token that is not an allowed group's representative, and
     * every `drum` token unless Drums is selected. Timing, pitch, velocity, tie
     * and the specials are never masked.
     *
     * @param inGroups The selection. **Must not be empty** -- the reference
     *        forbids every program and every drum for an empty selection, so a
     *        caller meaning "no filter" has to skip the mask entirely rather
     *        than pass nothing here. `Transcriber` does exactly that.
     * @return Sorted, unique token ids.
     */
    static std::vector<std::int32_t> forbiddenTokenIds(std::span<const InstrumentGroup> inGroups);

    /**
     * @param inGroups The selection; empty selects the unconditional path.
     * @return One conditioning row per selected group, in the caller's order,
     *         or the single null row when nothing is selected.
     */
    static std::vector<std::int32_t> conditioningRows(std::span<const InstrumentGroup> inGroups);
};

} // namespace msl
