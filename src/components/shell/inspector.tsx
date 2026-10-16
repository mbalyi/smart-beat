import { useId, type ReactNode } from "react";
import {
  AudioLinesIcon,
  MicVocalIcon,
  Settings2Icon,
  TriangleAlertIcon,
  ListOrderedIcon,
  CopyPlusIcon,
  SlidersVerticalIcon,
} from "lucide-react";

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
import { LabeledSlider } from "@/components/labeled-slider";
import { describeInstrument } from "@/lib/score/instrument-view";
import { PLAYING_STYLES, type Interpretation, type PlayingStyle } from "@/lib/score/interpretation";
import { describePan, describeVolume } from "@/lib/score/mixer";
import { tuningLabel, tuningNotes } from "@/lib/score/music";
import type { NotationView, TrackSummary, TrackView } from "@/lib/score/score";
import {
  allSoundFonts,
  isSoundFontId,
  type SoundFont,
  type SoundFontId,
} from "@/lib/score/soundfonts";
import { MAX_SYNC_OFFSET_MS, MIN_SYNC_OFFSET_MS } from "@/lib/score/sync";
import { trackColor } from "@/lib/score/track-colors";
import type { DrumKit, TrackMix } from "@/lib/tauri";

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

function Row({
  label,
  children,
  wrap = false,
}: {
  label: string;
  children: ReactNode;
  /** Let a long value wrap instead of being cut off with an ellipsis. */
  wrap?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={wrap ? "min-w-0 text-right" : "min-w-0 truncate text-right"}>
        {children}
      </span>
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

/** GP8's Interpretation: playing style, palm mute and accent strength, let ring, brush. */
function InterpretationControls({
  value,
  onChange,
}: {
  value: Interpretation;
  onChange: (value: Interpretation) => void;
}) {
  const styleId = useId();
  const set = (change: Partial<Interpretation>) => onChange({ ...value, ...change });
  const percent = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span id={styleId}>Playing style</span>
        <Select
          value={value.style}
          onValueChange={(style) => set({ style: style as PlayingStyle })}
        >
          <SelectTrigger aria-labelledby={styleId} size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLAYING_STYLES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-2 text-sm">
        <span>Palm mute</span>
        <LabeledSlider
          label="Palm mute strength"
          valueText={percent(value.palmMute)}
          value={value.palmMute}
          step={0.05}
          onValueChange={(palmMute) => set({ palmMute })}
        />
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {percent(value.palmMute)}
        </span>
        <span>Accentuation</span>
        <LabeledSlider
          label="Accentuation strength"
          valueText={percent(value.accent)}
          value={value.accent}
          step={0.05}
          onValueChange={(accent) => set({ accent })}
        />
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {percent(value.accent)}
        </span>
      </div>
      <SwitchRow
        label="Auto let ring"
        checked={value.letRing}
        onChange={(letRing) => set({ letRing })}
      />
      <SwitchRow
        label="Auto brush (strum chords)"
        checked={value.brush}
        onChange={(brush) => set({ brush })}
      />
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
  /** Opens the drum mixer of the shown (drum) track, as Guitar Pro does from its sound row. */
  onDrumMixer?: () => void;
  /** Re-maps the shown drum track's notes onto the standard lanes of the drum tab. */
  onNormalizeDrums?: () => void;
  /** Opens the dialog that copies the shown (non-drum) track to another instrument. */
  onCopyToInstrument?: () => void;
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
/** The drum kit picker of a drum track (#40). */
export interface DrumKitChoice {
  kits: DrumKit[];
  /** The kit the track plays (null: the SoundFont's own kit). */
  current: string | null;
  onChange: (kit: string | null) => void;
  /** Opens the drum kit library (import, remove). */
  onManage: () => void;
  /** False in a browser: imported kits need the desktop app. */
  available: boolean;
}

const BUNDLED_KIT = "bundled";

function DrumKitPicker({ kits, current, onChange, onManage, available }: DrumKitChoice) {
  const id = useId();
  const value = current && kits.some((k) => k.id === current) ? current : BUNDLED_KIT;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm">
        Drum kit
      </label>
      <div className="flex gap-1">
        <Select value={value} onValueChange={(v) => onChange(v === BUNDLED_KIT ? null : v)}>
          <SelectTrigger id={id} size="sm" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BUNDLED_KIT}>Instrument sounds (built in)</SelectItem>
            {kits.map((kit) => (
              <SelectItem key={kit.id} value={kit.id}>
                {kit.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={onManage}>
          Kits…
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {available
          ? "Imported kits play with the native engine; a large kit takes a moment to load the first time."
          : "Imported drum kits are available in the Smart Beat desktop app."}
      </p>
    </div>
  );
}

export function Inspector({
  tab,
  onTabChange,
  song,
  track,
  view,
  onViewChange,
  mix,
  color,
  soundFont,
  onSoundFontChange,
  soundFonts,
  onManageSoundFonts,
  soundsReady,
  syncOffset,
  onSyncOffsetChange,
  actions,
  audioEngine,
  onAudioEngineChange,
  effects,
  effectProblems,
  onEffectsChange,
  interpretation,
  onInterpretationChange,
  drumKit,
}: {
  /** Drum tracks: which imported kit plays (#40). */
  drumKit?: DrumKitChoice;
  tab: "song" | "track";
  onTabChange: (tab: "song" | "track") => void;
  song: SongInfo;
  track: TrackSummary;
  view: TrackView;
  onViewChange: (view: TrackView) => void;
  mix: TrackMix | undefined;
  /** The colour the user chose for the track, `#rrggbb`. */
  color?: string | null;
  soundFont: SoundFontId;
  onSoundFontChange: (id: SoundFontId) => void;
  /** The SoundFonts the user added (#81), listed after the built-in ones. */
  soundFonts?: readonly SoundFont[];
  /** Opens the dialog where SoundFonts are imported, downloaded and removed. */
  onManageSoundFonts?: () => void;
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
  interpretation: Interpretation;
  onInterpretationChange: (value: Interpretation) => void;
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
              style={{ backgroundColor: trackColor(track.index, color) }}
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
            <Row label="Tuning" wrap>
              <span className="mr-2 font-medium" data-testid="tuning-name">
                {tuningLabel(track.tuning)}
              </span>
              <span className="font-mono tracking-widest">{tuningNotes(track.tuning)}</span>
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
                {allSoundFonts(soundFonts).map((font) => (
                  <SelectItem key={font.id} value={font.id}>
                    {font.label}
                    <span className="text-muted-foreground"> · {font.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {onManageSoundFonts && (
              <Button
                variant="outline"
                size="sm"
                data-tour="soundfonts"
                onClick={onManageSoundFonts}
              >
                SoundFonts…
              </Button>
            )}
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
                Experimental: plays through effect chains and your sound library.
              </p>
            </>
          )}
          {track.kind === "drums" && drumKit && <DrumKitPicker {...drumKit} />}
          {track.kind === "drums" && actions.onNormalizeDrums && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={actions.onNormalizeDrums}
              data-tour="normalize-drums"
            >
              <ListOrderedIcon data-icon="inline-start" />
              Normalize drum notation
            </Button>
          )}
          {track.kind !== "drums" && actions.onCopyToInstrument && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={actions.onCopyToInstrument}
              data-tour="copy-instrument"
            >
              <CopyPlusIcon data-icon="inline-start" />
              Copy to instrument…
            </Button>
          )}
          {track.kind === "drums" && actions.onDrumMixer && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={actions.onDrumMixer}
            >
              <SlidersVerticalIcon data-icon="inline-start" />
              Drum mixer…
            </Button>
          )}
          <MiniChain
            chain={effects}
            problems={audioEngine === "native" ? effectProblems : 0}
            onChange={onEffectsChange}
            onEdit={actions.onEditEffects}
          />
        </Section>

        <Section title="Interpretation">
          {track.kind === "drums" ? (
            <p className="text-xs text-muted-foreground">
              Drums play as written. Mix the kit pieces in the drum mixer.
            </p>
          ) : (
            <InterpretationControls value={interpretation} onChange={onInterpretationChange} />
          )}
          {mix && (
            <p className="text-xs text-muted-foreground">
              Volume {describeVolume(mix.volume)} · Pan {describePan(mix.pan)}
            </p>
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
