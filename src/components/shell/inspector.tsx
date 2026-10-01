import { useId, type ReactNode } from "react";
import { AudioLinesIcon, MicVocalIcon, Settings2Icon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EFFECT_LABELS, replaceEffect, type EffectSlot } from "@/lib/audio/effects";
import type { AudioEngineKind } from "@/lib/score/player";
import { describeInstrument } from "@/lib/score/instrument-view";
import { describePan, describeVolume } from "@/lib/score/mixer";
import { pitchName } from "@/lib/score/music";
import type { NotationView, TrackSummary, TrackView } from "@/lib/score/score";
import { isSoundFontId, SOUNDFONTS, type SoundFontId } from "@/lib/score/soundfonts";
import { MAX_SYNC_OFFSET_MS, MIN_SYNC_OFFSET_MS } from "@/lib/score/sync";
import { trackColor } from "@/lib/score/track-colors";
import type { TrackMix } from "@/lib/tauri";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 border-b px-3 py-3 last:border-b-0"
    >
      <h3 id={id} className="text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <label htmlFor={id}>{label}</label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** What the SONG tab lists. */
export interface SongInfo {
  title: string;
  artist: string;
  /** File name. */
  file: string;
  bars: number;
  /** Tempo at the shown bar (BPM). */
  tempo: number;
  /** Bars whose length does not match their time signature. */
  problems: number;
}

export interface InspectorActions {
  /** Opens the track's settings (name, sound, tuning, capo). */
  onTrackSettings: () => void;
  onLyrics: () => void;
  onTranspose: () => void;
  onFixBars: () => void;
  /** Opens the tempo dialog (song tempo, tempo changes, tempo for some bars). */
  onTempo: () => void;
  /** Opens the pedalboard of the shown track. */
  onEditEffects: () => void;
}

/** The track's effects as a compact list (GP8's mini effect chain). */
function MiniChain({
  chain,
  problems,
  onChange,
  onEdit,
}: {
  chain: EffectSlot[];
  problems: number;
  onChange: (chain: EffectSlot[]) => void;
  onEdit: () => void;
}) {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span id={headingId} className="text-sm">
          Effects
        </span>
        <Button variant="ghost" size="xs" onClick={onEdit}>
          <AudioLinesIcon data-icon="inline-start" />
          Pedalboard…
        </Button>
      </div>
      {chain.length === 0 ? (
        <p className="text-xs text-muted-foreground">No effects. Add some, or load a preset.</p>
      ) : (
        <ol aria-labelledby={headingId} className="flex flex-col gap-1" data-testid="mini-chain">
          {chain.map((slot, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded border bg-background/60 px-2 py-1 text-xs"
            >
              <span className="flex-1 truncate">
                {i + 1}. {EFFECT_LABELS[slot.type]}
              </span>
              <Switch
                checked={slot.enabled}
                onCheckedChange={(enabled) =>
                  onChange(replaceEffect(chain, i, { ...slot, enabled }))
                }
                aria-label={`${EFFECT_LABELS[slot.type]} ${i + 1} on`}
              />
            </li>
          ))}
        </ol>
      )}
      {problems > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {problems === 1 ? "One effect cannot play" : `${problems} effects cannot play`} (see the
          Pedalboard).
        </p>
      )}
    </div>
  );
}

/**
 * The panel on the right: SONG (what the file is) and TRACK (the shown track:
 * information, musical notation, sounds and interpretation). Changes that need
 * a form open the same dialogs as the Track menu, so they stay undoable.
 */
export function Inspector({
  tab,
  onTabChange,
  song,
  track,
  view,
  onViewChange,
  mix,
  soundFont,
  onSoundFontChange,
  soundsReady,
  syncOffset,
  onSyncOffsetChange,
  actions,
  audioEngine,
  onAudioEngineChange,
  effects,
  effectProblems,
  onEffectsChange,
}: {
  tab: "song" | "track";
  onTabChange: (tab: "song" | "track") => void;
  song: SongInfo;
  track: TrackSummary;
  view: TrackView;
  onViewChange: (view: TrackView) => void;
  mix: TrackMix | undefined;
  soundFont: SoundFontId;
  onSoundFontChange: (id: SoundFontId) => void;
  /** False while instrument sounds load: switching again is disabled. */
  soundsReady: boolean;
  /** Milliseconds the cursor is delayed on top of the measured output latency. */
  syncOffset: number;
  onSyncOffsetChange: (ms: number) => void;
  actions: InspectorActions;
  audioEngine: AudioEngineKind;
  /** Missing where only alphaTab's synthesizer can play (a browser). */
  onAudioEngineChange?: (kind: AudioEngineKind) => void;
  effects: EffectSlot[];
  /** How many of the track's effects cannot play (missing library items…). */
  effectProblems: number;
  onEffectsChange: (chain: EffectSlot[]) => void;
}) {
  const soundLabelId = useId();
  const syncId = useId();
  const showsTab = view.notation !== "score";
  const showsScore = view.notation !== "tab";

  /** Score and tab are the two notations: at least one stays on. */
  const setNotation = (score: boolean, tab: boolean) => {
    const notation: NotationView | null =
      score && tab ? "score-tab" : score ? "score" : tab ? "tab" : null;
    if (notation) onViewChange({ ...view, notation });
  };

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value === "song" ? "song" : "track")}
      className="h-full min-h-0"
    >
      <TabsList aria-label="Inspector">
        <TabsTrigger value="song">Song</TabsTrigger>
        <TabsTrigger value="track">Track</TabsTrigger>
      </TabsList>

      <TabsContent value="song">
        <Section title="Information">
          <Row label="Title">{song.title || song.file}</Row>
          <Row label="Artist">{song.artist || "—"}</Row>
          <Row label="File">{song.file}</Row>
          <Row label="Bars">{song.bars}</Row>
          <Row label="Tempo">
            ♩ = {song.tempo}
            <Button
              variant="ghost"
              size="xs"
              className="ml-1"
              onClick={actions.onTempo}
              aria-label="Change the tempo…"
            >
              Change…
            </Button>
          </Row>
        </Section>
        <Section title="Tools">
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={actions.onTranspose}>
              Transpose…
            </Button>
            <Button variant="outline" size="sm" onClick={actions.onFixBars}>
              Fix bar lengths
            </Button>
          </div>
          {song.problems > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {song.problems} {song.problems === 1 ? "bar has" : "bars have"} the wrong length in
              the shown track.
            </p>
          )}
        </Section>
      </TabsContent>

      <TabsContent value="track">
        <Section title="Information">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-5 shrink-0 rounded"
              style={{ backgroundColor: trackColor(track.index) }}
            />
            <p className="min-w-0 flex-1 truncate font-medium">{track.name}</p>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Track settings…"
              title="Track settings…"
              onClick={actions.onTrackSettings}
            >
              <Settings2Icon />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{describeInstrument(track)}</p>
        </Section>

        <Section title="Musical notation">
          <SwitchRow
            label="Standard notation"
            checked={showsScore}
            disabled={!track.canShowTab}
            onChange={(on) => setNotation(on, showsTab)}
          />
          <SwitchRow
            label="Tablature"
            checked={showsTab}
            disabled={!track.canShowTab}
            onChange={(on) => setNotation(showsScore, on)}
          />
          {track.kind === "drums" && (
            <p className="text-xs text-muted-foreground">
              The drum tab writes each hit as its drum number (35 kick, 38 snare, 42 closed
              hi-hat…), like Guitar Pro.
            </p>
          )}
          {track.kind === "stringed" && (
            <Row label="Tuning">
              <span className="font-mono tracking-widest">
                {[...track.tuning]
                  .reverse()
                  .map((p) => pitchName(p, { octave: false }))
                  .join(" ")}
              </span>
              {track.capo > 0 && (
                <span className="ml-2 text-muted-foreground">Capo {track.capo}</span>
              )}
            </Row>
          )}
        </Section>

        <Section title="Sounds">
          <div className="flex flex-col gap-1.5">
            <span id={soundLabelId} className="text-sm">
              Instrument sounds
            </span>
            <Select
              value={soundFont}
              disabled={!soundsReady}
              onValueChange={(value) => isSoundFontId(value) && onSoundFontChange(value)}
            >
              <SelectTrigger aria-labelledby={soundLabelId} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOUNDFONTS.map((font) => (
                  <SelectItem key={font.id} value={font.id}>
                    {font.label}
                    <span className="text-muted-foreground"> · {font.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm">
            <label htmlFor={syncId}>Sync offset (ms)</label>
            <Input
              id={syncId}
              type="number"
              inputMode="numeric"
              min={MIN_SYNC_OFFSET_MS}
              max={MAX_SYNC_OFFSET_MS}
              step={10}
              value={syncOffset}
              onChange={(event) => {
                if (event.target.value !== "") onSyncOffsetChange(event.target.valueAsNumber);
              }}
              aria-describedby={`${syncId}-help`}
              className="h-7 w-20 text-right tabular-nums"
            />
          </div>
          <p id={`${syncId}-help`} className="text-xs text-muted-foreground">
            Raise it if the cursor runs ahead of the sound (Bluetooth speakers), lower it if it
            lags.
          </p>
          {onAudioEngineChange && (
            <>
              <SwitchRow
                label="Native engine with effects"
                checked={audioEngine === "native"}
                onChange={(on) => onAudioEngineChange(on ? "native" : "alphatab")}
              />
              <p className="text-xs text-muted-foreground">
                Experimental: plays through effect chains and your sound library. No count-in yet.
              </p>
            </>
          )}
          <MiniChain
            chain={effects}
            problems={audioEngine === "native" ? effectProblems : 0}
            onChange={onEffectsChange}
            onEdit={actions.onEditEffects}
          />
        </Section>

        <Section title="Interpretation">
          {mix && (
            <>
              <Row label="Volume">{describeVolume(mix.volume)}</Row>
              <Row label="Pan">{describePan(mix.pan)}</Row>
            </>
          )}
          <Button variant="outline" size="sm" className="self-start" onClick={actions.onLyrics}>
            <MicVocalIcon data-icon="inline-start" />
            Lyrics…
          </Button>
        </Section>
      </TabsContent>
    </Tabs>
  );
}
