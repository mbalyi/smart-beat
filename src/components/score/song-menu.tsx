import {
  ArrowUpDownIcon,
  AudioLinesIcon,
  ChevronDownIcon,
  FileDownIcon,
  GaugeIcon,
  LanguagesIcon,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ExportFormat } from "@/lib/export";
import { ENCODING_LABELS, type EncodingChoice, type TextEncodingId } from "@/lib/score/encoding";

/** Guitar Pro 3–5 songs: read the text again with another encoding (#53). */
export interface EncodingMenu {
  /** The encoding the text was read with. */
  current: TextEncodingId;
  choice: EncodingChoice;
  /** The song has unsaved changes (reading it again would lose them). */
  edited: boolean;
  onChange: (choice: EncodingChoice) => void;
}

const EXPORTS: { format: ExportFormat; label: string }[] = [
  { format: "gp", label: "Guitar Pro…" },
  { format: "gp5", label: "Guitar Pro 5…" },
  { format: "gp4", label: "Guitar Pro 4…" },
  { format: "gp3", label: "Guitar Pro 3…" },
  { format: "musicxml", label: "MusicXML…" },
  { format: "midi", label: "MIDI…" },
  { format: "atex", label: "alphaTex…" },
  { format: "ascii-tab", label: "ASCII tab…" },
];

/** In-window mirror of the native File › Save, Save As and Export items. */
export function FileMenu({
  onImportAudio,
  onSave,
  onSaveAs,
  onExport,
  onExportAudio,
  onExportM4a,
  onExportAll,
  onPrint,
  encoding,
}: {
  encoding?: EncodingMenu;
  /** Import from Audio (#88). In this menu, beside Open: the header has no room for another button. */
  onImportAudio?: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: (format: ExportFormat) => void;
  /** Renders the mix to a WAV file. */
  onExportAudio: () => void;
  /** Renders the mix to an M4A file (only where the desktop app can: macOS). */
  onExportM4a?: () => void;
  /** Opens the Export dialog, which lists every format (#90). */
  onExportAll: () => void;
  /** Opens the print dialog (which also saves a PDF). */
  onPrint: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" title="Import, save and export">
          <FileDownIcon data-icon="inline-start" />
          <span className="max-2xl:sr-only">File</span>
          <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {onImportAudio && (
          <>
            <DropdownMenuItem onSelect={onImportAudio}>
              <AudioLinesIcon />
              Import from Audio…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
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
          <DropdownMenuItem onSelect={onExportAll}>All formats…</DropdownMenuItem>
          {EXPORTS.map(({ format, label }) => (
            <DropdownMenuItem key={format} onSelect={() => onExport(format)}>
              {label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={onExportAudio}>Audio (WAV)…</DropdownMenuItem>
          {onExportM4a && <DropdownMenuItem onSelect={onExportM4a}>Audio (M4A)…</DropdownMenuItem>}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onPrint}>
          <PrinterIcon />
          Print / PDF…
        </DropdownMenuItem>
        {encoding && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={encoding.edited}>
                <LanguagesIcon />
                Reopen with encoding
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Read as {ENCODING_LABELS[encoding.current]}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={encoding.choice}
                  onValueChange={(value) => encoding.onChange(value as EncodingChoice)}
                >
                  {(Object.keys(ENCODING_LABELS) as EncodingChoice[]).map((choice) => (
                    <DropdownMenuRadioItem key={choice} value={choice}>
                      {ENCODING_LABELS[choice]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
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
