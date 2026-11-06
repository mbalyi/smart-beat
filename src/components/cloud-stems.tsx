import { CloudDownloadIcon, CloudIcon, LayersIcon } from "lucide-react";

import { SectionKicker } from "@/components/section-kicker";
import { formatBytes } from "@/components/stems/stem-labels";
import { useCloudStemList } from "@/components/stems/use-cloud-stem-list";
import { Badge } from "@/components/ui/badge";
import type { CloudStem } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** "Neon Nights" for `Neon Nights.sbstems`. */
const stemName = (file: string) => file.replace(/\.sbstems$/i, "");

/**
 * One saved stems file of the cloud folder as a card. A file that is only online shows
 * "Waiting for download": opening it asks the drive app to fetch it first.
 */
export function CloudStemCard({
  file,
  index,
  fetching,
  onOpen,
}: {
  file: CloudStem;
  /** Its place in the list: the icon colour alternates. */
  index: number;
  /** The core is waiting for the drive app to download it. */
  fetching: boolean;
  onOpen: (path: string) => void;
}) {
  const waiting = file.placeholder;
  return (
    <button
      type="button"
      className={cn(
        "group flex min-h-[76px] w-full min-w-0 items-center gap-3.5 overflow-hidden rounded-2xl border bg-card px-4 py-3 text-left transition-[border-color,background-color,transform] duration-150 outline-none hover:-translate-y-0.5 hover:bg-muted focus-visible:-translate-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        index % 2 === 0
          ? "hover:border-brand-yellow/60 focus-visible:border-brand-yellow/60"
          : "hover:border-brand/60 focus-visible:border-brand/60",
      )}
      onClick={() => onOpen(file.path)}
      title={file.path}
      data-testid="cloud-stem"
      data-placeholder={waiting ? "true" : undefined}
    >
      <LayersIcon
        aria-hidden="true"
        className={cn("size-[22px] shrink-0", index % 2 === 0 ? "text-brand-yellow" : "text-brand")}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[17px] font-bold">{stemName(file.name)}</span>
          <Badge variant="outline" className="shrink-0">
            Stems
          </Badge>
          <Badge variant="secondary" className="shrink-0">
            <CloudIcon aria-hidden="true" />
            Cloud
          </Badge>
        </span>
        <span className="flex items-center gap-1 truncate text-sm text-muted-foreground">
          {waiting ? (
            <>
              <CloudDownloadIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {fetching ? "Downloading…" : "Waiting for download"}
              {" · "}
            </>
          ) : null}
          {formatBytes(file.size)}
        </span>
      </span>
    </button>
  );
}

/**
 * The saved stems (`.sbstems`) in the linked cloud folder (#187, #186), for the start screen.
 * Hidden when no folder is linked, when the folder has none, when it can't be read (the Cloud
 * section above says why) and outside the desktop app. Smart Beat never uploads: the drive app
 * syncs the files saved there.
 */
export function CloudStems({ onOpen }: { onOpen: (path: string) => void }) {
  const { list, downloading } = useCloudStemList();
  const files = list.status === "ready" ? list.files : [];
  if (files.length === 0) return null;
  return (
    <section
      aria-labelledby="cloud-stems-title"
      className="flex flex-col gap-3"
      data-testid="cloud-stems-section"
    >
      <SectionKicker as="h2" id="cloud-stems-title">
        Stems in your cloud folder
      </SectionKicker>
      <ul className="grid gap-3 sm:grid-cols-2">
        {files.map((file, index) => (
          <li key={file.path} className="min-w-0">
            <CloudStemCard
              file={file}
              index={index}
              fetching={downloading.has(file.path)}
              onOpen={onOpen}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
