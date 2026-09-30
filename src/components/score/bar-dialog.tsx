import { useId, useState, type FormEvent, type ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { describeAccidentals, KEY_SIGNATURES } from "@/lib/score/keys";
import {
  DENOMINATORS,
  DIRECTIONS,
  MAX_ENDINGS,
  MAX_NUMERATOR,
  MAX_REPEAT_COUNT,
  MAX_TEMPO,
  MIN_TEMPO,
  TRIPLET_FEELS,
  type BarSettings,
  type DirectionType,
} from "@/lib/score/structure";

const MAJOR = 0;
const MINOR = 1;

const clamp = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      {children}
    </fieldset>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}

function BarForm({
  barNumber,
  initial,
  currentTempo,
  warningsFor,
  onSubmit,
  onCancel,
}: {
  barNumber: number;
  initial: BarSettings;
  currentTempo: number;
  warningsFor: (draft: BarSettings) => string[];
  onSubmit: (settings: BarSettings) => void;
  onCancel: () => void;
}) {
  const ids = {
    numerator: useId(),
    denominator: useId(),
    key: useId(),
    tripletFeel: useId(),
    bpm: useId(),
    tempoLabel: useId(),
    section: useId(),
    repeatCount: useId(),
    endings: useId(),
  };
  const [draft, setDraft] = useState<BarSettings>(initial);
  const set = (change: Partial<BarSettings>) => setDraft((d) => ({ ...d, ...change }));
  const firstBar = barNumber === 1;
  const [tempoText, setTempoText] = useState(String(initial.tempo?.bpm ?? currentTempo));
  const [numeratorText, setNumeratorText] = useState(String(initial.timeSignature.numerator));
  const [repeatText, setRepeatText] = useState(String(initial.repeatEnd || 2));
  const warnings = warningsFor(draft);

  const toggleDirection = (value: DirectionType, on: boolean) =>
    set({
      directions: on
        ? [...draft.directions, value].sort((a, b) => a - b)
        : draft.directions.filter((d) => d !== value),
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const numerator = clamp(
      Number(numeratorText),
      1,
      MAX_NUMERATOR,
      initial.timeSignature.numerator,
    );
    const bpm = clamp(Number(tempoText), MIN_TEMPO, MAX_TEMPO, currentTempo);
    onSubmit({
      ...draft,
      timeSignature: { ...draft.timeSignature, numerator },
      tempo: draft.tempo || firstBar ? { bpm, label: draft.tempo?.label ?? "" } : null,
      repeatEnd: draft.repeatEnd ? clamp(Number(repeatText), 2, MAX_REPEAT_COUNT, 2) : 0,
      section: draft.section.trim(),
    });
  };

  const directionBoxes = (kind: "target" | "jump") => (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {DIRECTIONS.filter((d) => d.kind === kind).map((d) => (
        <CheckboxField
          key={d.value}
          label={d.label}
          checked={draft.directions.includes(d.value)}
          onChange={(on) => toggleDirection(d.value, on)}
        />
      ))}
    </div>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Bar {barNumber}</DialogTitle>
        <DialogDescription>
          Time and key signatures and the triplet feel last until the next bar that changes them.
        </DialogDescription>
      </DialogHeader>

      <Fieldset legend="Time and key">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Beats per bar" id={ids.numerator}>
            <Input
              id={ids.numerator}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_NUMERATOR}
              value={numeratorText}
              onChange={(e) => setNumeratorText(e.target.value)}
            />
          </Field>
          <Field label="Beat unit" id={ids.denominator}>
            <Select
              value={String(draft.timeSignature.denominator)}
              onValueChange={(value) =>
                set({ timeSignature: { ...draft.timeSignature, denominator: Number(value) } })
              }
            >
              <SelectTrigger id={ids.denominator} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DENOMINATORS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d === 1 ? "Whole notes (1)" : `1/${d} notes`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Key signature" id={ids.key}>
          <Select
            value={String(draft.keySignature)}
            onValueChange={(value) => set({ keySignature: Number(value) })}
          >
            <SelectTrigger id={ids.key} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KEY_SIGNATURES.map((k) => (
                <SelectItem key={k.signature} value={String(k.signature)}>
                  {`${k.major} major / ${k.minor} minor · ${describeAccidentals(k.signature)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Mode"
          value={String(draft.keyType)}
          onValueChange={(value) => value && set({ keyType: Number(value) })}
          className="self-start"
        >
          <ToggleGroupItem value={String(MAJOR)}>Major</ToggleGroupItem>
          <ToggleGroupItem value={String(MINOR)}>Minor</ToggleGroupItem>
        </ToggleGroup>
        <Field label="Triplet feel" id={ids.tripletFeel}>
          <Select
            value={String(draft.tripletFeel)}
            onValueChange={(value) => set({ tripletFeel: Number(value) })}
          >
            <SelectTrigger id={ids.tripletFeel} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRIPLET_FEELS.map((t) => (
                <SelectItem key={t.value} value={String(t.value)}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </Fieldset>

      <Fieldset legend="Tempo and section">
        <CheckboxField
          label={firstBar ? "Song tempo (bar 1)" : "Tempo change at this bar"}
          checked={firstBar || draft.tempo !== null}
          disabled={firstBar}
          onChange={(on) =>
            set({ tempo: on ? { bpm: Number(tempoText) || currentTempo, label: "" } : null })
          }
        />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Beats per minute" id={ids.bpm}>
            <Input
              id={ids.bpm}
              type="number"
              inputMode="numeric"
              min={MIN_TEMPO}
              max={MAX_TEMPO}
              disabled={!firstBar && draft.tempo === null}
              value={tempoText}
              onChange={(e) => setTempoText(e.target.value)}
            />
          </Field>
          <Field label="Tempo text (optional)" id={ids.tempoLabel}>
            <Input
              id={ids.tempoLabel}
              placeholder="e.g. Allegro"
              maxLength={40}
              disabled={!firstBar && draft.tempo === null}
              value={draft.tempo?.label ?? ""}
              onChange={(e) =>
                set({
                  tempo: {
                    bpm: draft.tempo?.bpm ?? currentTempo,
                    label: e.target.value,
                  },
                })
              }
            />
          </Field>
        </div>
        <Field label="Section name" id={ids.section}>
          <Input
            id={ids.section}
            placeholder="e.g. Chorus"
            maxLength={60}
            value={draft.section}
            onChange={(e) => set({ section: e.target.value })}
          />
        </Field>
      </Fieldset>

      <Fieldset legend="Repeats and endings">
        <CheckboxField
          label="Repeat starts here"
          checked={draft.repeatStart}
          onChange={(on) => set({ repeatStart: on })}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CheckboxField
            label="Repeat ends here"
            checked={draft.repeatEnd > 0}
            onChange={(on) => set({ repeatEnd: on ? Number(repeatText) || 2 : 0 })}
          />
          <div className="flex items-center gap-2">
            <label htmlFor={ids.repeatCount} className="text-sm">
              Play
            </label>
            <Input
              id={ids.repeatCount}
              type="number"
              inputMode="numeric"
              min={2}
              max={MAX_REPEAT_COUNT}
              className="w-20"
              disabled={draft.repeatEnd === 0}
              value={repeatText}
              onChange={(e) => setRepeatText(e.target.value)}
              aria-describedby={`${ids.repeatCount}-unit`}
            />
            <span id={`${ids.repeatCount}-unit`} className="text-sm">
              times
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" id={ids.endings}>
            Alternate ending: played on pass
          </span>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            spacing={0}
            aria-labelledby={ids.endings}
            value={Array.from({ length: MAX_ENDINGS }, (_, i) => i)
              .filter((i) => (draft.endings & (1 << i)) !== 0)
              .map(String)}
            onValueChange={(values) =>
              set({ endings: values.reduce((mask, v) => mask | (1 << Number(v)), 0) })
            }
            className="self-start"
          >
            {Array.from({ length: MAX_ENDINGS }, (_, i) => (
              <ToggleGroupItem
                key={i}
                value={String(i)}
                aria-label={`Pass ${i + 1}`}
                className="min-w-8 tabular-nums"
              >
                {i + 1}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </Fieldset>

      <Fieldset legend="Signs (where jumps go)">{directionBoxes("target")}</Fieldset>
      <Fieldset legend="Jumps">{directionBoxes("jump")}</Fieldset>

      <div role="status" aria-live="polite">
        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
            {warnings.map((warning) => (
              <li key={warning} className="flex gap-2">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {warning}
              </li>
            ))}
          </ul>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Apply</Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The structure of the bar at the edit cursor: time and key signatures,
 * triplet feel, tempo, section, repeats, alternate endings and jumps (Segno,
 * Coda, D.C., D.S. ...), with warnings about jumps that can't work.
 */
export function BarDialog({
  open,
  onOpenChange,
  barNumber,
  initial,
  currentTempo,
  warningsFor,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 1-based. */
  barNumber: number;
  initial: BarSettings | null;
  /** The tempo at the bar, for a new tempo change. */
  currentTempo: number;
  warningsFor: (draft: BarSettings) => string[];
  onSubmit: (settings: BarSettings) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {initial && (
          <BarForm
            barNumber={barNumber}
            initial={initial}
            currentTempo={currentTempo}
            warningsFor={warningsFor}
            onSubmit={(settings) => {
              onSubmit(settings);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
