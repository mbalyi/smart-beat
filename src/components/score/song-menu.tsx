import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  FileDownIcon,
  GaugeIcon,
  PrinterIcon,
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
  onExportAudio,
  onPrint,
}: {
  onSave: () => void;
  onSaveAs: () => void;
  onExport: (format: ExportFormat) => void;
  /** Renders the mix to a WAV file. */
  onExportAudio: () => void;
  /** Opens the print dialog (which also saves a PDF). */
  onPrint: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" title="Save and export">
          <FileDownIcon data-icon="inline-start" />
          <span className="max-2xl:sr-only">File</span>
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
          <DropdownMenuItem onSelect={onExportAudio}>Audio (WAV)…</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onPrint}>
          <PrinterIcon />
          Print / PDF…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Editing helpers: transpose and fixing bar lengths. */
export function ToolsMenu({
  onTranspose,
  onFixBars,
  onTempo,
}: {
  onTranspose: () => void;
  onFixBars: () => void;
  onTempo: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" title="Editing tools">
          <WrenchIcon data-icon="inline-start" />
          <span className="max-2xl:sr-only">Tools</span>
          <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={onTranspose}>
          <ArrowUpDownIcon />
          Transpose…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onTempo}>
          <GaugeIcon />
          Tempo…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onFixBars}>
          <RulerIcon />
          Fix bar durations…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
