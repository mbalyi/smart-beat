import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { GaugeIcon, Repeat2Icon, SquareIcon, TimerIcon, TimerResetIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { Toggle } from "@/components/ui/toggle";
import {
  DEFAULT_TRAINER,
  MAX_SPEED,
  MIN_SPEED,
  normalizeRange,
  SPEED_PRESETS,
  type LoopRange,
  type PracticeState,
  type SpeedTrainer,
} from "@/lib/score/practice";

/** A bar number field that commits on Enter or when it loses focus. */
function BarNumber({
  label,
  value,
  barCount,
  onCommit,
}: {
  label: string;
  /** 0-based. */
  value: number;
  barCount: number;
  onCommit: (bar: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const number = Number.parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(number)) onCommit(Math.min(barCount, Math.max(1, number)) - 1);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setDraft(null);
  };
  return (
    <Input
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={1}
      max={barCount}
      value={draft ?? String(value + 1)}
      onFocus={(event) => {
        setDraft(String(value + 1));
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
      className="h-8 w-14 tabular-nums"
    />
  );
}

export function PracticeControls({
  practice,
  barCount,
  onLoopChange,
  onRangeChange,
  onSpeedChange,
  onMetronomeChange,
  onCountInChange,
  onOpenTrainer,
  onStopTrainer,
}: {
  practice: PracticeState;
  barCount: number;
  onLoopChange: (loop: boolean) => void;
  onRangeChange: (range: LoopRange) => void;
  onSpeedChange: (percent: number) => void;
  onMetronomeChange: (on: boolean) => void;
  onCountInChange: (on: boolean) => void;
  onOpenTrainer: () => void;
  onStopTrainer: () => void;
}) {
  const speedLabelId = useId();
  const { loop, range, speed, trainer } = practice;
  const speeds = [...new Set<number>([...SPEED_PRESETS, speed])].sort((a, b) => a - b);
  const setRange = (next: LoopRange) => onRangeChange(normalizeRange(next, barCount));

  return (
    <div
      role="group"
      aria-label="Practice"
      className="flex items-center gap-x-3 gap-y-2 *:shrink-0 sm:flex-wrap"
    >
      <div className="flex items-center gap-1.5">
        <Toggle
          variant="outline"
          size="sm"
          pressed={loop}
          onPressedChange={onLoopChange}
          title="Loop the selected bars (drag across bars in the score to choose them)"
        >
          <Repeat2Icon data-icon="inline-start" />
          Loop
        </Toggle>
        {loop && (
          <div className="flex items-center gap-1 text-sm">
            <span className="text-muted-foreground">Bars</span>
            <BarNumber
              label="Loop from bar"
              value={range.start}
              barCount={barCount}
              onCommit={(start) => setRange({ start, end: Math.max(start, range.end) })}
            />
            <span aria-hidden="true">–</span>
            <BarNumber
              label="Loop to bar"
              value={range.end}
              barCount={barCount}
              onCommit={(end) => setRange({ start: Math.min(range.start, end), end })}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <GaugeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <span id={speedLabelId} className="text-sm">
          Speed
        </span>
        <Select value={String(speed)} onValueChange={(value) => onSpeedChange(Number(value))}>
          <SelectTrigger size="sm" aria-labelledby={speedLabelId} className="w-20 tabular-nums">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {speeds.map((percent) => (
              <SelectItem key={percent} value={String(percent)}>
                {percent}%
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {trainer ? (
          <span className="flex items-center gap-1 text-sm">
            <span role="status" className="text-muted-foreground tabular-nums">
              Trainer {speed}% → {trainer.to}%
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={onStopTrainer}
              aria-label="Stop the Speed Trainer"
              title="Stop the Speed Trainer"
            >
              <SquareIcon />
            </Button>
          </span>
        ) : (
          <Button variant="outline" size="sm" onClick={onOpenTrainer}>
            <TimerResetIcon data-icon="inline-start" />
            Speed Trainer…
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Toggle
          variant="outline"
          size="sm"
          pressed={practice.metronome}
          onPressedChange={onMetronomeChange}
        >
          <TimerIcon data-icon="inline-start" />
          Metronome
        </Toggle>
        <Toggle
          variant="outline"
          size="sm"
          pressed={practice.countIn}
          onPressedChange={onCountInChange}
          title="Count one bar in before playing"
        >
          Count-in
        </Toggle>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={Number.isFinite(value) ? value : ""}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          className="w-24 tabular-nums"
        />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

function SpeedTrainerForm({
  barCount,
  initialRange,
  onStart,
  onCancel,
}: {
  barCount: number;
  initialRange: LoopRange;
  onStart: (trainer: SpeedTrainer, range: LoopRange) => void;
  onCancel: () => void;
}) {
  const [trainer, setTrainer] = useState<SpeedTrainer>(DEFAULT_TRAINER);
  const [range, setRange] = useState(initialRange);
  const set = (change: Partial<SpeedTrainer>) => setTrainer((t) => ({ ...t, ...change }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onStart(trainer, normalizeRange(range, barCount));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Speed Trainer</DialogTitle>
        <DialogDescription>
          Loops the bars, starting slowly and speeding up after each loop until the target speed.
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-4">
        <NumberField
          label="From bar"
          value={range.start + 1}
          min={1}
          max={barCount}
          onChange={(bar) => setRange((r) => ({ ...r, start: bar - 1 }))}
        />
        <NumberField
          label="To bar"
          value={range.end + 1}
          min={1}
          max={barCount}
          onChange={(bar) => setRange((r) => ({ ...r, end: bar - 1 }))}
        />
        <NumberField
          label="Start speed"
          value={trainer.from}
          min={MIN_SPEED}
          max={MAX_SPEED}
          suffix="%"
          onChange={(from) => set({ from })}
        />
        <NumberField
          label="Target speed"
          value={trainer.to}
          min={MIN_SPEED}
          max={MAX_SPEED}
          suffix="%"
          onChange={(to) => set({ to })}
        />
        <NumberField
          label="Increase by"
          value={trainer.step}
          min={1}
          max={MAX_SPEED}
          suffix="%"
          onChange={(step) => set({ step })}
        />
        <NumberField
          label="Loops at each speed"
          value={trainer.loopsPerStep}
          min={1}
          max={20}
          onChange={(loopsPerStep) => set({ loopsPerStep })}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Start</Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The Speed Trainer: loops some bars, starting slow and getting faster after
 * each loop (or every few loops) until the target speed.
 */
export function SpeedTrainerDialog({
  open,
  onOpenChange,
  barCount,
  initialRange,
  onStart,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  barCount: number;
  /** The bars to suggest (the loop, the selection or the current bar). */
  initialRange: LoopRange;
  onStart: (trainer: SpeedTrainer, range: LoopRange) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <SpeedTrainerForm
          barCount={barCount}
          initialRange={initialRange}
          onStart={(trainer, range) => {
            onStart(trainer, range);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
