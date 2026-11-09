import { useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tip } from "@/components/ui/tip";
import { DENOMINATORS, MAX_NUMERATOR, type TimeSignature } from "@/lib/score/structure";

/**
 * The time signature of the bar at the cursor: beats per bar and the note value of a beat. Any
 * signature works (7/8, 5/4, 6/8...). It lasts until the next bar that changes it.
 */
export function TimeSignatureControl({
  time,
  onChange,
}: {
  time: TimeSignature;
  onChange: (time: TimeSignature) => void;
}) {
  const [text, setText] = useState(String(time.numerator));
  const commit = () => {
    const value = Math.round(Number(text));
    const numerator = Number.isFinite(value)
      ? Math.min(MAX_NUMERATOR, Math.max(1, value))
      : time.numerator;
    setText(String(numerator));
    if (numerator !== time.numerator) onChange({ ...time, numerator });
  };
  return (
    <div className="flex items-center gap-1.5">
      <Tip label="Beats per bar">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_NUMERATOR}
          size={3}
          aria-label="Beats per bar"
          className="h-8 w-14 px-2"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      </Tip>
      <span aria-hidden="true" className="text-sm text-muted-foreground">
        /
      </span>
      <Tip label="Beat unit: the note value of one beat">
        <span className="inline-flex">
          <Select
            value={String(time.denominator)}
            onValueChange={(value) => onChange({ ...time, denominator: Number(value) })}
          >
            <SelectTrigger size="sm" aria-label="Beat unit" className="h-8 w-[4.5rem] px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DENOMINATORS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
      </Tip>
    </div>
  );
}
