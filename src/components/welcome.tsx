import {
  AudioLinesIcon,
  FileMusicIcon,
  FilePlusIcon,
  FolderOpenIcon,
  KeyboardIcon,
} from "lucide-react";

import { BuiltWith } from "@/components/built-with";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FEATURES } from "@/components/welcome-features";
import { baseName } from "@/lib/score/format";
import { cn } from "@/lib/utils";

/** The folder a path is in ("Songs" for `/Users/me/Songs/riff.gp5`), to tell equal names apart. */
function folderOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2]! : "";
}

export function Welcome({
  onOpenFile,
  onNewSong,
  onShowShortcuts,
  recent = [],
  onOpenRecent,
  onShowLicenses,
}: {
  onOpenFile: () => void;
  onNewSong: () => void;
  onShowShortcuts: () => void;
  /** Recently opened songs (paths), most recent first. */
  recent?: string[];
  onOpenRecent?: (path: string) => void;
  /** "View open-source notices": opens Help › Open-Source Licenses. */
  onShowLicenses?: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-12 px-4 py-10 sm:px-6 sm:py-16 lg:px-8">
      <section aria-labelledby="welcome-title" className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Badge variant="secondary" className="w-fit">
            Early preview
          </Badge>
          <h1
            id="welcome-title"
            className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
          >
            Write, play and arrange guitar music
          </h1>
          <p className="max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">
            Smart Beat is a tablature editor for macOS, Windows and Linux, with optional self-hosted
            AI that turns a hummed melody into a full accompaniment.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button size="lg" onClick={onOpenFile}>
            <FolderOpenIcon data-icon="inline-start" />
            Open a file…
          </Button>
          <Button size="lg" variant="outline" onClick={onNewSong}>
            <FilePlusIcon data-icon="inline-start" />
            New song
          </Button>
          <Button size="lg" variant="outline" onClick={onShowShortcuts}>
            <KeyboardIcon data-icon="inline-start" />
            Keyboard shortcuts
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Opens Guitar Pro 3–8 files (.gp3, .gp4, .gp5, .gpx, .gp), MusicXML (.musicxml, .mxl),
          MIDI, MuseScore (.mscx, .mscz), alphaTex (.atex), Capella (.capx) and text tab (.txt)
          files. You can also drop a file anywhere in this window.
        </p>
      </section>

      {recent.length > 0 && onOpenRecent && (
        <section aria-labelledby="recent-title" className="flex flex-col gap-3">
          <h2 id="recent-title" className="font-heading text-xl font-semibold">
            Recent songs
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {recent.map((path, index) => (
              <li key={path} className="min-w-0">
                <button
                  type="button"
                  className={cn(
                    "group flex min-h-[76px] w-full min-w-0 items-center gap-3.5 overflow-hidden rounded-2xl border bg-card px-4 py-3 text-left transition-[border-color,background-color,transform] duration-150 outline-none hover:-translate-y-0.5 hover:bg-muted focus-visible:-translate-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                    index % 2 === 0
                      ? "hover:border-brand-yellow/60 focus-visible:border-brand-yellow/60"
                      : "hover:border-brand/60 focus-visible:border-brand/60",
                  )}
                  onClick={() => onOpenRecent(path)}
                  title={path}
                >
                  <FileMusicIcon
                    className={cn(
                      "size-[22px] shrink-0",
                      index % 2 === 0 ? "text-brand-yellow" : "text-brand",
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[17px] font-bold">{baseName(path)}</span>
                    <span className="truncate text-sm text-muted-foreground">{folderOf(path)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="roadmap-title" className="flex flex-col gap-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-bold tracking-[0.12em] text-muted-foreground uppercase">
              Made for the way you play
            </p>
            <h2
              id="roadmap-title"
              className="font-heading text-[clamp(26px,3vw,32px)] leading-tight font-bold tracking-tight"
            >
              Features
            </h2>
          </div>
          <span
            aria-hidden="true"
            className="grid size-[42px] shrink-0 place-items-center rounded-[13px] border text-brand"
          >
            <AudioLinesIcon className="size-[21px]" />
          </span>
        </div>
        <ul className="grid gap-[18px] md:grid-cols-2 lg:grid-cols-12">
          {FEATURES.map((feature, index) => (
            <li
              key={feature.title}
              // Four cards in the first row, three (wider) in the second.
              className={cn("min-w-0", index < 4 ? "lg:col-span-3" : "lg:col-span-4")}
            >
              <article className="flex h-full flex-col gap-4 rounded-[19px] border border-foreground/10 bg-card p-4">
                <h3 className="sr-only">{feature.title}</h3>
                <img
                  src={feature.image}
                  alt={feature.title}
                  loading="lazy"
                  draggable={false}
                  className="aspect-[558/447] w-full object-contain"
                />
                <Badge
                  variant="outline"
                  className={cn(
                    "w-fit rounded-full px-3 py-0.5",
                    feature.status === "available"
                      ? "border-green-600/60 bg-green-600/10 text-green-800 dark:border-green-500/60 dark:bg-green-500/10 dark:text-green-400"
                      : "border-brand/60 bg-brand/10 text-brand dark:text-[#e29bff]",
                  )}
                >
                  {feature.badge}
                </Badge>
                <div className="text-[15px] leading-relaxed text-muted-foreground">
                  <p>{feature.description}</p>
                  {feature.items && (
                    <ul className="mt-1 list-disc pl-5">
                      {feature.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            </li>
          ))}
        </ul>
      </section>

      <BuiltWith onShowLicenses={onShowLicenses} />
    </div>
  );
}
