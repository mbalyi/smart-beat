import { useId, useState, type KeyboardEvent } from "react";

import { formatTime } from "@/components/stems/stem-labels";
import { usePosition } from "@/components/stems/use-stem-player";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import type { StemPlayer } from "@/lib/stems/player";
import {
  addTap,
  clampBpm,
  describeSections,
  double,
  formatBpm,
  halve,
  LOW_CONFIDENCE,
  MAX_BPM,
  MIN_BPM,
  otherTempos,
  sectionAt,
  tapBpm,
  type EffectiveTempo,
} from "@/lib/stems/tempo";
import type { StemTempo } from "@/lib/tauri";

/** What the page knows about the tempo, and how the user changes it. */
export interface TempoModel {
  finding: boolean;
  detected: StemTempo | null;
  tempo: EffectiveTempo;
  /** The user changed something, so there is something to go back from. */
  changed: boolean;
  setBpm: (bpm: number) => void;
  setFirstBeat: (seconds: number) => void;
  setFollowSections: (follow: boolean) => void;
  reset: () => void;
}

const link =
  "rounded-sm font-medium text-foreground underline decoration-dotted underline-offset-4 outline-none hover:decoration-solid focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The tempo in the song's info line: "Finding the tempo…" while the detector works, then
 * "92 BPM" (or "Tempo not found") that opens the tempo menu, and "Tempo changes" when the
 * detector found large, stable changes. Renders inline, to sit in a line of text.
 */
export function TempoInfo({ model, player }: { model: TempoModel; player: StemPlayer | null }) {
  const { finding, tempo } = model;
  if (finding) {
    return (
      <span role="status" className="text-muted-foreground">
        Finding the tempo…
      </span>
    );
  }
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={link} title="Change the tempo" data-testid="stem-tempo">
            {tempo.bpm === null ? "Tempo not found" : `${formatBpm(tempo.bpm)} BPM`}
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="flex w-72 flex-col gap-3" aria-label="Tempo">
          <TempoMenu model={model} player={player} />
        </PopoverContent>
      </Popover>
      {tempo.sections.length > 1 && (
        <>
          {" · "}
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className={link} data-testid="stem-tempo-changes">
                Tempo changes
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="center"
              className="flex w-72 flex-col gap-3"
              aria-label="Tempo changes"
            >
              <TempoChanges model={model} player={player} />
            </PopoverContent>
          </Popover>
        </>
      )}
    </>
  );
}

/** The sentence and the list of tempo changes, the part the playhead is in, and the click's choice. */
function TempoChanges({ model, player }: { model: TempoModel; player: StemPlayer | null }) {
  const { tempo } = model;
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">Tempo changes</h2>
        <p className="text-sm" data-testid="stem-tempo-sentence">
          {describeSections(tempo.sections, formatTime)}
        </p>
      </div>
      <ul className="flex flex-col gap-0.5 text-sm tabular-nums">
        {tempo.sections.map((section) => (
          <li key={section.startSec} className="flex justify-between gap-3">
            <span className="text-muted-foreground">
              {formatTime(section.startSec)} to {formatTime(section.endSec)}
            </span>
            <span>{formatBpm(section.bpm)} BPM</span>
          </li>
        ))}
      </ul>
      {player && <WhereYouAre sections={tempo.sections} player={player} />}
      <Toggle
        variant="outline"
        size="sm"
        pressed={tempo.followSections}
        onPressedChange={model.setFollowSections}
        disabled={!tempo.detected}
        className="self-start"
      >
        Follow the tempo changes
      </Toggle>
      <p className="text-xs text-muted-foreground">
        {tempo.followSections
          ? "The metronome follows the changes. Setting a tempo yourself goes back to one tempo."
          : !tempo.detected
            ? "You set a tempo yourself, so the metronome uses it."
            : "The metronome clicks at one tempo, even where the song changes."}
      </p>
    </>
  );
}

/** "You are in the 140 BPM part", following the playhead (only mounted while a menu is open). */
function WhereYouAre({
  sections,
  player,
}: {
  sections: EffectiveTempo["sections"];
  player: StemPlayer;
}) {
  const at = sectionAt(sections, usePosition(player));
  if (!at) return null;
  return (
    <p className="text-sm" role="status">
      The playhead is in the {formatBpm(at.bpm)} BPM part.
    </p>
  );
}

function TempoMenu({ model, player }: { model: TempoModel; player: StemPlayer | null }) {
  const { tempo, detected } = model;
  const bpmId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [taps, setTaps] = useState<number[]>([]);

  const halved = tempo.bpm === null ? null : halve(tempo.bpm);
  const doubled = tempo.bpm === null ? null : double(tempo.bpm);
  const others = otherTempos(detected?.alternatives ?? [], tempo.bpm);
  const tapped = tapBpm(taps);

  const commit = () => {
    if (draft === null) return;
    const value = Number.parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(value) && value > 0) model.setBpm(clampBpm(value));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setDraft(null);
  };
  const tap = () => {
    const now = Date.now();
    const next = addTap(taps, now);
    setTaps(next);
    const bpm = tapBpm(next);
    if (bpm !== null) model.setBpm(bpm);
  };

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">Tempo</h2>
        <p className="text-sm text-muted-foreground" data-testid="stem-tempo-source">
          {tempo.bpm === null
            ? "Not found. Tap along with the song, or type a tempo."
            : tempo.detected
              ? "Found by listening. Change it if it is off."
              : "Set by you."}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={halved === null}
          onClick={() => halved !== null && model.setBpm(halved)}
        >
          Halve
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={doubled === null}
          onClick={() => doubled !== null && model.setBpm(doubled)}
        >
          Double
        </Button>
      </div>

      {others.length > 0 && (
        <div role="group" aria-label="Other likely tempos" className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Other likely tempos</span>
          <div className="flex flex-wrap gap-2">
            {others.map((bpm) => (
              <Button key={bpm} variant="outline" size="sm" onClick={() => model.setBpm(bpm)}>
                {formatBpm(bpm)} BPM
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label htmlFor={bpmId} className="text-sm font-medium">
          Type a tempo
        </label>
        <Input
          id={bpmId}
          type="number"
          inputMode="decimal"
          min={MIN_BPM}
          max={MAX_BPM}
          step={0.1}
          value={draft ?? (tempo.bpm === null ? "" : formatBpm(tempo.bpm))}
          placeholder="BPM"
          onFocus={(event) => {
            setDraft(tempo.bpm === null ? "" : formatBpm(tempo.bpm));
            event.currentTarget.select();
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          className="h-8 w-20 tabular-nums"
        />
        <span className="text-sm text-muted-foreground">BPM</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Button variant="outline" size="sm" onClick={tap} className="self-start">
          Tap tempo
        </Button>
        <p className="text-xs text-muted-foreground" role="status">
          {taps.length === 0
            ? "Tap along with the beat, four times or more."
            : tapped === null
              ? "Keep tapping."
              : `${formatBpm(tapped)} BPM from ${taps.length} taps. A pause starts again.`}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={!player}
          onClick={() => player && model.setFirstBeat(player.position())}
          className="self-start"
        >
          First beat is at the playhead
        </Button>
        <p className="text-xs text-muted-foreground">
          The first beat is at {formatTime(tempo.firstBeatSec)}. Move the playhead onto a beat of
          the song, then press this to line the clicks up with it.
        </p>
      </div>

      {tempo.sections.length > 1 && !tempo.followSections && (
        <p className="text-xs text-muted-foreground">
          This song changes tempo. The metronome uses one tempo; see Tempo changes in the song's
          details to follow the changes.
        </p>
      )}

      {model.changed && (
        <Button variant="ghost" size="sm" onClick={model.reset} className="self-start">
          {detected && detected.confidence >= LOW_CONFIDENCE && detected.bpm > 0
            ? "Use what was detected"
            : "Forget my changes"}
        </Button>
      )}
    </>
  );
}
