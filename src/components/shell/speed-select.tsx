import { useId } from "react";
import { GaugeIcon } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The practice speed menu ("Speed 80%") shared by the song's practice controls and the stem
 * page. Renders a fragment, so the caller's row lays it out.
 */
export function SpeedSelect({
  value,
  speeds,
  onChange,
  tour,
}: {
  /** Percent. */
  value: number;
  /** The percentages to offer, ascending; the current one is added when it is not among them. */
  speeds: readonly number[];
  onChange: (percent: number) => void;
  /** The guided tour's anchor. */
  tour?: string;
}) {
  const labelId = useId();
  const shown = [...new Set<number>([...speeds, value])].sort((a, b) => a - b);
  return (
    <>
      <GaugeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      <span id={labelId} className="text-sm max-xl:sr-only">
        Speed
      </span>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger
          size="sm"
          aria-labelledby={labelId}
          className="w-20 tabular-nums"
          data-tour={tour}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {shown.map((percent) => (
            <SelectItem key={percent} value={String(percent)}>
              {percent}%
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
