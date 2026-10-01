import { FileMusicIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Visual feedback while files are dragged over the window. */
export function DropOverlay({ visible }: { visible: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-slot="drop-overlay"
      data-visible={visible}
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 opacity-0 transition-opacity",
        visible && "opacity-100",
      )}
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary px-10 py-8 text-center">
        <FileMusicIcon className="size-10 text-primary" />
        <p className="font-heading text-lg font-semibold">Drop a song to open it</p>
        <p className="text-sm text-muted-foreground">
          Guitar Pro (.gp3–.gp), MusicXML, MIDI, MuseScore (.mscx, .mscz), alphaTex (.atex), Capella
          (.capx) or text tab (.txt)
        </p>
      </div>
    </div>
  );
}
