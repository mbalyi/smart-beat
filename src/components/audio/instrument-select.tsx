import { ChevronDownIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { label, scoreInstrument } from "@/lib/audio-transcription/upstream/instruments";
import { cn } from "@/lib/utils";

/**
 * The expected instruments as a multi-select: chips in the field, a search box and a checkbox
 * list in the panel. Empty means automatic detection.
 */
export function InstrumentSelect({
  instruments,
  value,
  onChange,
  disabled,
  id,
  "aria-describedby": describedBy,
}: {
  instruments: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () =>
      instruments
        .map((name) => ({ name, score: scoreInstrument(name, query) }))
        .filter((v) => v.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
    [instruments, query],
  );
  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <div
        className={cn(
          "flex min-h-10 items-center gap-1.5 rounded-lg border bg-card/60 pr-1 pl-2",
          disabled && "opacity-50",
        )}
      >
        <ul aria-label="Chosen instruments" className="flex flex-wrap items-center gap-1.5 py-1">
          {value.map((name) => (
            <li key={name}>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${label(name)}`}
                onClick={() => onChange(value.filter((v) => v !== name))}
                className="flex items-center gap-1 rounded-md bg-primary/20 px-2 py-0.5 text-xs font-medium outline-none hover:bg-primary/30 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {label(name)}
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={id}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-describedby={describedBy}
            aria-expanded={open}
            className="flex min-h-8 flex-1 items-center justify-between gap-2 rounded-md px-1 text-left text-sm text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className={cn(value.length && "sr-only")}>
              {value.length ? "Add instruments" : "Automatic detection"}
            </span>
            <ChevronDownIcon aria-hidden="true" className="ml-auto size-4 shrink-0" />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        align="start"
        aria-label="Choose instruments"
        className="flex w-(--radix-popover-trigger-width) min-w-64 flex-col gap-2 p-2"
      >
        <Input
          aria-label="Search instruments"
          placeholder="Search instruments, families, or aliases…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul aria-label="Available instruments" className="max-h-64 overflow-y-auto">
          {matches.map(({ name }) => (
            <li key={name}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <Checkbox checked={value.includes(name)} onCheckedChange={() => toggle(name)} />
                {label(name)}
              </label>
            </li>
          ))}
          {!matches.length && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">No matching instruments.</li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
