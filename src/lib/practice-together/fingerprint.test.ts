import { describe, expect, it } from "vitest";

import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import { texScore } from "@/test/playback";

const TAB = String.raw`
\title "T"
\tempo 120
\track "Guitar"
  \staff {score tabs}
  \instrument 25
  :4 3.6 5.5 7.4 r |
`;

describe("scoreFingerprint", () => {
  it("does not change with what a player sets for themselves (the bug that blocked every start)", async () => {
    const score = texScore(TAB);
    const base = (await scoreFingerprint(score)).key;
    const track = score.tracks[0]!;
    const staff = track.staves[0]!;
    track.playbackInfo.isMute = true;
    track.playbackInfo.isSolo = true;
    track.playbackInfo.volume = 3;
    track.playbackInfo.balance = 2;
    staff.showTablature = false;
    staff.showStandardNotation = false;
    expect((await scoreFingerprint(score)).key).toBe(base);
    // ...and nothing was left changed by the check.
    expect(track.playbackInfo.isMute).toBe(true);
    expect(track.playbackInfo.volume).toBe(3);
    expect(staff.showTablature).toBe(false);
  });

  it("changes with the music", async () => {
    const a = await scoreFingerprint(texScore(TAB));
    const b = await scoreFingerprint(texScore(TAB.replace("7.4", "7.3")));
    expect(a.key).not.toBe(b.key);
  });
});
