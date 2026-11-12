import { findClip, moveClip, withCrossfades } from "@/lib/audio-lanes/edits";
import { newId } from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

/**
 * Clip groups: clips (on one lane or several) that move, nudge, delete and select together. A
 * clip's `groupId` names its group; a group always has two clips or more. Unlike lane edit
 * groups (`AudioLane.group`), these tie single clips together.
 */

type Audio = AudioLanesSettings;

const allClips = (audio: Audio): AudioClip[] => audio.lanes.flatMap((l) => l.clips);

/** A copy of a clip with no group (the key is gone, so it is not saved). */
function ungrouped(clip: AudioClip): AudioClip {
  const copy = { ...clip };
  delete copy.groupId;
  return copy;
}

/** Sets the group of the clips `pick` returns a value for (undefined: no group). */
function regroup(audio: Audio, pick: (clip: AudioClip) => string | undefined | null): Audio {
  let changed = false;
  const lanes = audio.lanes.map((lane) => {
    let laneChanged = false;
    const clips = lane.clips.map((clip) => {
      const groupId = pick(clip);
      if (groupId === null || groupId === clip.groupId) return clip;
      laneChanged = true;
      return groupId === undefined ? ungrouped(clip) : { ...clip, groupId };
    });
    if (!laneChanged) return lane;
    changed = true;
    return { ...lane, clips };
  });
  return changed ? { ...audio, lanes } : audio;
}

/** The clips in the same group as `clipId`, itself included ([] for an unknown clip). */
export function groupMembers(audio: Audio, clipId: string): string[] {
  const found = findClip(audio, clipId);
  if (!found) return [];
  const { groupId } = found.clip;
  if (!groupId) return [clipId];
  return allClips(audio)
    .filter((c) => c.groupId === groupId)
    .map((c) => c.id);
}

/** `ids` with every clip of their groups added, each once, in order. */
export function withGroup(audio: Audio, ids: readonly string[]): string[] {
  const groups = new Set(
    ids.map((id) => findClip(audio, id)?.clip.groupId).filter((g): g is string => !!g),
  );
  if (groups.size === 0) return [...new Set(ids)];
  const members = allClips(audio)
    .filter((c) => c.groupId && groups.has(c.groupId))
    .map((c) => c.id);
  return [...new Set([...ids, ...members])];
}

/** One clip of each group in `ids` (and every ungrouped clip), for edits that move a group. */
export function groupLeaders(audio: Audio, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(ids)].filter((id) => {
    const groupId = findClip(audio, id)?.clip.groupId;
    if (!groupId) return true;
    if (seen.has(groupId)) return false;
    seen.add(groupId);
    return true;
  });
}

/** Removes the group of clips left alone in it (after a delete or a glue). */
export function pruneGroups(audio: Audio): Audio {
  const counts = new Map<string, number>();
  for (const c of allClips(audio))
    if (c.groupId) counts.set(c.groupId, (counts.get(c.groupId) ?? 0) + 1);
  if ([...counts.values()].every((n) => n > 1)) return audio;
  return regroup(audio, (c) => (c.groupId && counts.get(c.groupId) === 1 ? undefined : null));
}

/**
 * Puts clips in one new group. Needs two clips or more; a clip that was in another group leaves
 * it (a selection already holds whole groups, so only a clip picked alone does), and a group left
 * with one clip goes.
 */
export function groupClips(audio: Audio, ids: readonly string[], groupId: string = newId()): Audio {
  const known = [...new Set(ids)].filter((id) => findClip(audio, id));
  if (known.length < 2) return audio;
  const members = new Set(known);
  return pruneGroups(regroup(audio, (c) => (members.has(c.id) ? groupId : null)));
}

/** Breaks up the groups the clips are in (every member of them is ungrouped). */
export function ungroupClips(audio: Audio, ids: readonly string[]): Audio {
  const members = new Set(withGroup(audio, ids));
  return regroup(audio, (c) => (members.has(c.id) && c.groupId ? undefined : null));
}

/** Whether any of the clips is in a group. */
export const anyGrouped = (audio: Audio, ids: readonly string[]): boolean =>
  ids.some((id) => !!findClip(audio, id)?.clip.groupId);

/**
 * Moves a clip to `startMs` (on `laneId` when given), and every other clip of its group by the
 * same amount on its own lane. Nothing moves when a member is locked, and the group stops at the
 * start of the timeline. An ungrouped clip moves as `moveClip` moves it.
 */
export function moveClipGroup(
  audio: Audio,
  clipId: string,
  startMs: number,
  laneId?: string,
): Audio {
  const found = findClip(audio, clipId);
  if (!found?.clip.groupId) return moveClip(audio, clipId, startMs, laneId);
  const members = groupMembers(audio, clipId)
    .map((id) => findClip(audio, id)!.clip)
    .filter((c) => c.id !== clipId);
  if (found.clip.locked || members.some((c) => c.locked)) return audio;
  const earliest = Math.min(found.clip.startMs, ...members.map((c) => c.startMs));
  const delta = Math.max(startMs - found.clip.startMs, -earliest);
  if (delta === 0 && !laneId) return audio;
  const moved = moveClip(audio, clipId, found.clip.startMs + delta, laneId);
  // Set, not add: a lane edit group may have moved a member already.
  const targets = new Map(members.map((c) => [c.id, c.startMs + delta]));
  return {
    ...moved,
    lanes: moved.lanes.map((lane) =>
      lane.clips.some((c) => targets.has(c.id))
        ? withCrossfades({
            ...lane,
            clips: lane.clips
              .map((c) => (targets.has(c.id) ? { ...c, startMs: targets.get(c.id)! } : c))
              .sort((a, b) => a.startMs - b.startMs),
          })
        : lane,
    ),
  };
}

/** Clips with fresh group ids: copies are grouped with each other, not with the originals. */
export function freshGroups<T extends AudioClip>(clips: readonly T[]): T[] {
  const ids = new Map<string, string>();
  const fresh = (old: string) => ids.get(old) ?? ids.set(old, newId()).get(old)!;
  return clips.map((c) => (c.groupId ? { ...c, groupId: fresh(c.groupId) } : c));
}

/** After an edit that added copies (duplicate), gives the new clips fresh group ids. */
export function regroupCopies(before: Audio, after: Audio): Audio {
  if (after === before) return after;
  const old = new Set(allClips(before).map((c) => c.id));
  const copies = allClips(after).filter((c) => !old.has(c.id) && c.groupId);
  if (copies.length === 0) return after;
  const renamed = new Map(freshGroups(copies).map((c) => [c.id, c.groupId]));
  return regroup(after, (c) => (renamed.has(c.id) ? renamed.get(c.id) : null));
}

/** A hue (0 … 359) for a group, so its clips share a tint. */
export function groupHue(groupId: string): number {
  let hash = 0;
  for (const char of groupId) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}
