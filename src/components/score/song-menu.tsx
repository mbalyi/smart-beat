import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  FileDownIcon,
  RulerIcon,
  SaveAllIcon,
  SaveIcon,
  WrenchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ExportFormat } from "@/lib/export";

const EXPORTS: { format: ExportFormat; label: string }[] = [
  { format: "musicxml", label: "MusicXML…" },
  { format: "midi", label: "MIDI…" },
  { format: "ascii-tab", label: "ASCII tab…" },
];

/** In-window mirror of the native File › Save, Save As and Export items. */
export function FileMenu({
  onSave,
  onSaveAs,
  onExport,
}: {
  onSave: () => void;
  onSaveAs: () => void;
  onExport: (format: ExportFormat) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" title="Save and export">
          <FileDownIcon data-icon="inline-start" />
          <span className="sr-only md:not-sr-only">File</span>
          <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={onSave}>
          <SaveIcon />
          Save
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSaveAs}>
          <SaveAllIcon />
          Save As…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Export</DropdownMenuLabel>
          {EXPORTS.map(({ format, label }) => (
            <DropdownMenuItem key={format} onSelect={() => onExport(format)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Editing helpers: transpose and fixing bar lengths. */
export function ToolsMenu({
  onTranspose,
  onFixBars,
}: {
  onTranspose: () => void;
  onFixBars: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" title="Editing tools">
          <WrenchIcon data-icon="inline-start" />
          <span className="sr-only md:not-sr-only">Tools</span>
          <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={onTranspose}>
          <ArrowUpDownIcon />
          Transpose…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onFixBars}>
          <RulerIcon />
          Fix bar durations…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
