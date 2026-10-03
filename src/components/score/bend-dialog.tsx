import { useId, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
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
import {
  BEND_AMOUNTS,
  BEND_PRESETS,
  CURVE_LENGTH,
  describeCurve,
  MAX_BEND,
  MAX_WHAMMY,
  stepsText,
  WHAMMY_PRESETS,
  type CurvePoint,
} from "@/lib/score/effects";

export type CurveKind = "bend" | "whammy";

const WIDTH = 320;
const HEIGHT = 160;
const PAD = 16;
/** Positions snap to Guitar Pro's grid of 12 steps. */
const STEP = 5;

function pitchLabel(value: number, kind: CurveKind) {
  if (value === 0) return kind === "bend" ? "Not bent" : "As written";
  return `${value > 0 ? "+" : "−"}${stepsText(value)}`;
}

/** The curve drawn on a grid: click to add a point, drag to move one, double-click to remove. */
function CurveGraph({
  kind,
  points,
  onChange,
}: {
  kind: CurveKind;
  points: CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const min = kind === "bend" ? 0 : -MAX_WHAMMY;
  const max = kind === "bend" ? MAX_BEND : MAX_WHAMMY;
  const x = (offset: number) => PAD + (offset / CURVE_LENGTH) * (WIDTH - 2 * PAD);
  const y = (value: number) => PAD + (1 - (value - min) / (max - min)) * (HEIGHT - 2 * PAD);

  /** The grid position under the pointer, or null outside the graph. */
  const toPoint = (event: PointerEvent): CurvePoint | null => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM?.();
    if (!svg || !matrix) return null;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const offset = ((p.x - PAD) / (WIDTH - 2 * PAD)) * CURVE_LENGTH;
    const value = min + (1 - (p.y - PAD) / (HEIGHT - 2 * PAD)) * (max - min);
    return {
      offset: Math.min(CURVE_LENGTH, Math.max(0, Math.round(offset / STEP) * STEP)),
      value: Math.min(max, Math.max(min, Math.round(value))),
    };
  };
  const sorted = (list: CurvePoint[]) => [...list].sort((a, b) => a.offset - b.offset);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const target = (event.target as Element).closest("[data-point]");
    if (target) {
      setDragging(Number(target.getAttribute("data-point")));
      svgRef.current?.setPointerCapture?.(event.pointerId);
      return;
    }
    const point = toPoint(event);
    if (point && !points.some((p) => p.offset === point.offset)) {
      onChange(sorted([...points, point]));
    }
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (dragging === null) return;
    const point = toPoint(event);
    if (point) onChange(points.map((p, i) => (i === dragging ? point : p)));
  };
  const onPointerUp = () => {
    if (dragging === null) return;
    setDragging(null);
    onChange(sorted(points));
  };

  const gridX = Array.from({ length: CURVE_LENGTH / STEP + 1 }, (_, i) => i * STEP);
  const gridY = Array.from({ length: (max - min) / 2 + 1 }, (_, i) => min + i * 2);
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`Curve: ${describeCurve(points)}`}
      className="w-full touch-none rounded-md border bg-background select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {gridX.map((offset) => (
        <line
          key={`x${offset}`}
          x1={x(offset)}
          x2={x(offset)}
          y1={PAD}
          y2={HEIGHT - PAD}
          className="stroke-muted-foreground/20"
        />
      ))}
      {gridY.map((value) => (
        <line
          key={`y${value}`}
          x1={PAD}
          x2={WIDTH - PAD}
          y1={y(value)}
          y2={y(value)}
          className={value === 0 ? "stroke-muted-foreground/70" : "stroke-muted-foreground/20"}
        />
      ))}
      <polyline
        points={points.map((p) => `${x(p.offset)},${y(p.value)}`).join(" ")}
        className="fill-none stroke-sky-600 dark:stroke-sky-400"
        strokeWidth={2}
      />
      {points.map((p, i) => (
        <circle
          key={i}
          data-point={i}
          cx={x(p.offset)}
          cy={y(p.value)}
          r={6}
          className="cursor-grab fill-sky-600 stroke-background dark:fill-sky-400"
          strokeWidth={2}
          onDoubleClick={() => points.length > 2 && onChange(points.filter((_, j) => j !== i))}
        />
      ))}
    </svg>
  );
}

function CurveForm({
  kind,
  initial,
  onSubmit,
  onRemove,
  onCancel,
}: {
  kind: CurveKind;
  initial: CurvePoint[] | null;
  onSubmit: (points: CurvePoint[]) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const presets = kind === "bend" ? BEND_PRESETS : WHAMMY_PRESETS;
  const defaultAmount = kind === "bend" ? 4 : 8;
  const [amount, setAmount] = useState(defaultAmount);
  const [preset, setPreset] = useState<string>(initial ? "" : presets[0]!.id);
  const [points, setPoints] = useState<CurvePoint[]>(
    () => initial ?? presets[0]!.points(defaultAmount),
  );
  const amountId = useId();
  const tableId = useId();
  const noun = kind === "bend" ? "bend" : "whammy bar";
  const min = kind === "bend" ? 0 : -MAX_WHAMMY;
  const max = kind === "bend" ? MAX_BEND : MAX_WHAMMY;
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  const edit = (next: CurvePoint[]) => {
    setPreset("");
    setPoints(next);
  };
  const choose = (id: string, height = amount) => {
    const shape = presets.find((p) => p.id === id);
    if (!shape) return;
    setPreset(id);
    setPoints(shape.points(height));
  };
  const change = (index: number, patch: Partial<CurvePoint>) =>
    edit(points.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit([...points].sort((a, b) => a.offset - b.offset));
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>{kind === "bend" ? "Bend" : "Whammy bar"}</DialogTitle>
        <DialogDescription>
          Pick a shape, or edit the points: position runs from the start (0) to the end (
          {CURVE_LENGTH}) of the note.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Shape"
          value={preset}
          onValueChange={(id) => id && choose(id)}
          className="flex-wrap justify-start"
        >
          {presets.map((p) => (
            <ToggleGroupItem key={p.id} value={p.id}>
              {p.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="flex items-center gap-2">
          <label htmlFor={amountId} className="text-sm font-medium">
            {kind === "bend" ? "Bend by" : "Dive by"}
          </label>
          <Select
            value={String(amount)}
            onValueChange={(value) => {
              setAmount(Number(value));
              if (preset) choose(preset, Number(value));
            }}
          >
            <SelectTrigger id={amountId} size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BEND_AMOUNTS.map((a) => (
                <SelectItem key={a.value} value={String(a.value)}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <CurveGraph kind={kind} points={points} onChange={edit} />

        <div className="flex flex-col gap-2">
          <span id={tableId} className="text-sm font-medium">
            Points
          </span>
          <ol aria-labelledby={tableId} className="flex flex-col gap-1">
            {points.map((p, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-14 text-muted-foreground">Point {i + 1}</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={CURVE_LENGTH}
                  className="h-8 w-20"
                  aria-label={`Point ${i + 1} position`}
                  value={p.offset}
                  onChange={(e) =>
                    change(i, {
                      offset: Math.min(CURVE_LENGTH, Math.max(0, Number(e.target.value) || 0)),
                    })
                  }
                />
                <Select
                  value={String(p.value)}
                  onValueChange={(value) => change(i, { value: Number(value) })}
                >
                  <SelectTrigger size="sm" className="w-36" aria-label={`Point ${i + 1} pitch`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {values.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {pitchLabel(value, kind)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Remove point ${i + 1}`}
                  disabled={points.length <= 2}
                  onClick={() => edit(points.filter((_, j) => j !== i))}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              const last = points.at(-1)!;
              const offset = Math.min(CURVE_LENGTH, last.offset + STEP);
              edit([...points, { offset, value: last.value }]);
            }}
            disabled={points.at(-1)!.offset >= CURVE_LENGTH}
          >
            <PlusIcon data-icon="inline-start" />
            Add point
          </Button>
        </div>
      </DialogBody>

      <DialogFooter>
        {initial && (
          <Button type="button" variant="outline" className="sm:mr-auto" onClick={onRemove}>
            Remove {noun}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Apply</Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Edits the bend of the note at the edit cursor, or the whammy bar of its
 * beat: shapes, height and the curve's points (on the graph, or with the
 * keyboard in the list of points).
 */
export function BendDialog({
  open,
  onOpenChange,
  kind,
  initial,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: CurveKind;
  /** The current curve, or null for none. */
  initial: CurvePoint[] | null;
  /** The new curve, or null to remove it. */
  onSubmit: (points: CurvePoint[] | null) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const done = (points: CurvePoint[] | null) => {
    onSubmit(points);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" onCloseAutoFocus={onCloseAutoFocus}>
        <CurveForm
          kind={kind}
          initial={initial}
          onSubmit={done}
          onRemove={() => done(null)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
