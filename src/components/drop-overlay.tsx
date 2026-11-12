import { FileMusicIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * What the dragged files are, as far as the window knows: `song` (scores, or nothing known and no
 * song open), `audio` (only audio files, over an open song: they go on lanes) or `files` (the
 * kinds are not known yet).
 */
export type DropKind = "song" | "audio" | "files";

/** Visual feedback while files are dragged over the window. */
export function DropOverlay({ visible, kind = "song" }: { visible: boolean; kind?: DropKind }) {
  // Audio goes on the lane under the pointer: the lanes stay in view behind a small banner.
  if (kind === "audio") {
    return (
      <div
        aria-hidden="true"
        data-slot="drop-overlay"
        data-kind={kind}
        data-visible={visible}
        className={cn(
          "pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-6 opacity-0 transition-opacity",
          visible && "opacity-100",
        )}
      >
        <p className="rounded-full border-2 border-primary bg-background px-4 py-1.5 text-sm font-medium shadow-lg">
          Drop on a lane to add it there, or anywhere else for a new lane
        </p>
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      data-slot="drop-overlay"
      data-kind={kind}
      data-visible={visible}
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 opacity-0 transition-opacity",
        visible && "opacity-100",
      )}
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary px-10 py-8 text-center">
        <FileMusicIcon className="size-10 text-primary" />
        {kind === "files" ? (
          <p className="font-heading text-lg font-semibold">Drop files</p>
        ) : (
          <>
            <p className="font-heading text-lg font-semibold">Drop a song to open it</p>
            <p className="text-sm text-muted-foreground">
              Guitar Pro (.gp3–.gp), MusicXML (.musicxml, .mxl), MIDI, MuseScore (.mscx, .mscz),
              alphaTex (.atex), Capella (.capx) or text tab (.txt)
            </p>
          </>
        )}
      </div>
    </div>
  );
}
