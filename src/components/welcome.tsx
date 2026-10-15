import {
  AudioLinesIcon,
  FileMusicIcon,
  FilePlusIcon,
  FolderOpenIcon,
  InfoIcon,
  KeyboardIcon,
  CompassIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { BuiltWith } from "@/components/built-with";
import { SectionKicker } from "@/components/section-kicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { FEATURES, type Feature } from "@/components/welcome-features";
import { baseName } from "@/lib/score/format";
import { cn } from "@/lib/utils";

/** The folder a path is in ("Songs" for `/Users/me/Songs/riff.gp5`), to tell equal names apart. */
function folderOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2]! : "";
}

/** The hero buttons: taller, rounder, and a little lift on hover. */
const HERO_BUTTON =
  "h-12 rounded-[15px] px-[15px] text-base font-semibold transition-[background-color,border-color,transform] duration-150 hover:-translate-y-px motion-reduce:hover:translate-y-0 max-sm:h-[46px] max-sm:px-3 max-sm:text-sm";

export function Welcome({
  onOpenFile,
  onImportAudio,
  onNewSong,
  onShowShortcuts,
  recent = [],
  onOpenRecent,
  onShowLicenses,
  onTakeTour,
  tour,
}: {
  onOpenFile: () => void;
  /** Import from Audio; left out while the `audio-2-tab` feature is off. */
  onImportAudio?: () => void;
  onNewSong: () => void;
  onShowShortcuts: () => void;
  /** Recently opened songs (paths), most recent first. */
  recent?: string[];
  onOpenRecent?: (path: string) => void;
  /** "View open-source notices": opens Help › Open-Source Licenses. */
  onShowLicenses?: () => void;
  /** Starts the guided tour (also Help › Take the Tour). */
  onTakeTour?: () => void;
  /** A first launch: offered the guided tour, once (#84). */
  tour?: { onStart: () => void; onSkip: () => void };
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1536px] flex-col gap-14 px-4 pt-4 pb-10 sm:px-6 sm:pt-6 sm:pb-14 lg:px-8 lg:pt-8">
      {/* The space above the title equals the page's side padding (the container's padding). */}
      <section aria-labelledby="welcome-title" className="flex flex-col">
        <h1
          id="welcome-title"
          className="mb-4 max-w-[1120px] font-heading text-[clamp(40px,6vw,68px)] leading-[1.04] font-bold tracking-[-0.06em] text-balance max-sm:text-[clamp(40px,10vw,58px)]"
        >
          Write, play and arrange guitar music
        </h1>
        <p className="max-w-[900px] text-[18px] leading-[1.55] text-pretty text-muted-foreground sm:text-[clamp(18px,2.1vw,27px)]">
          Smart Beat is a tablature editor for macOS, Windows and Linux, with optional self-hosted
          AI that turns a hummed melody into a full accompaniment.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2.5 sm:mt-8 sm:gap-3">
          <Button size="lg" className={HERO_BUTTON} onClick={onOpenFile} data-tour="open-file">
            <FolderOpenIcon data-icon="inline-start" />
            Open a file…
          </Button>
          {onImportAudio && (
            <Button size="lg" variant="outline" className={HERO_BUTTON} onClick={onImportAudio}>
              <AudioLinesIcon data-icon="inline-start" />
              Import from Audio…
            </Button>
          )}
          <Button size="lg" variant="outline" className={HERO_BUTTON} onClick={onNewSong}>
            <FilePlusIcon data-icon="inline-start" />
            New song
          </Button>
          <Button size="lg" variant="outline" className={HERO_BUTTON} onClick={onShowShortcuts}>
            <KeyboardIcon data-icon="inline-start" />
            Keyboard shortcuts
          </Button>
          {onTakeTour && (
            <Button size="lg" variant="outline" className={HERO_BUTTON} onClick={onTakeTour}>
              <CompassIcon data-icon="inline-start" />
              Take a tour
            </Button>
          )}
        </div>
        {tour && (
          <section
            aria-labelledby="tour-offer-title"
            className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-card p-4 sm:mt-8"
          >
            <div className="min-w-0">
              <h2 id="tour-offer-title" className="text-lg font-bold">
                New here? Take a quick tour
              </h2>
              <p className="text-sm text-muted-foreground">
                Two minutes with a demo song: play it, slow it down, loop a part. You can replay it
                from Help › Take the Tour.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={tour.onSkip}>
                Skip for now
              </Button>
              <Button onClick={tour.onStart}>Take a quick tour</Button>
            </div>
          </section>
        )}
        <p className="mt-5 max-w-[1260px] text-[13px] leading-relaxed text-muted-foreground sm:mt-6 sm:text-sm">
          Opens Guitar Pro 3–8 files (.gp3, .gp4, .gp5, .gpx, .gp), MusicXML (.musicxml, .mxl),
          MIDI, MuseScore (.mscx, .mscz), alphaTex (.atex), Capella (.capx) and text tab (.txt)
          files. You can also drop a file anywhere in this window.
        </p>
      </section>

      {recent.length > 0 && onOpenRecent && (
        <section aria-labelledby="recent-title" className="flex flex-col gap-3">
          <SectionKicker as="h2" id="recent-title">
            Recent songs
          </SectionKicker>
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
            <div className="mb-2">
              <SectionKicker>Made for the way you play</SectionKicker>
            </div>
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
              <FeatureCard feature={feature} />
            </li>
          ))}
        </ul>
      </section>

      <BuiltWith onShowLicenses={onShowLicenses} />
    </div>
  );
}

/** The badge colours of each status. */
const STATUS_BADGE: Record<Feature["status"], string> = {
  available:
    "border-green-600/60 bg-green-600/10 text-green-800 dark:border-green-500/60 dark:bg-green-500/10 dark:text-green-400",
  beta: "border-brand/60 bg-brand/10 text-brand dark:text-[#e29bff]",
  soon: "border-brand/60 bg-brand/10 text-brand dark:text-[#e29bff]",
};

/**
 * One feature on the welcome screen. A feature with limits shows them in a popup when the card
 * is hovered or its "Limits" button has focus; screen readers get the same list from the button.
 */
function FeatureCard({ feature }: { feature: Feature }) {
  const limitsId = useId();
  // The popup opens from the "Limits" button (hover or focus), and also while the card is hovered.
  const [open, setOpen] = useState(false);
  const [cardHovered, setCardHovered] = useState(false);
  const limits = feature.limits;
  const limitsButton = limits && (
    <button
      type="button"
      aria-describedby={limitsId}
      className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <InfoIcon className="size-4" aria-hidden="true" />
      Limits
    </button>
  );
  const card = (
    <article
      onPointerEnter={limits ? () => setCardHovered(true) : undefined}
      onPointerLeave={limits ? () => setCardHovered(false) : undefined}
      className="flex h-full flex-col gap-4 rounded-[19px] border border-foreground/10 bg-card p-4"
    >
      <h3 className="sr-only">{feature.title}</h3>
      <img
        src={feature.image}
        alt={feature.title}
        loading="lazy"
        draggable={false}
        className="aspect-[558/447] w-full object-contain"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn("w-fit rounded-full px-3 py-0.5", STATUS_BADGE[feature.status])}
        >
          {feature.badge}
        </Badge>
        {limitsButton && <HoverCardTrigger asChild>{limitsButton}</HoverCardTrigger>}
      </div>
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
      {limits && (
        <ul id={limitsId} className="sr-only">
          {limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      )}
    </article>
  );
  if (!limits) return card;
  return (
    <HoverCard open={open || cardHovered} onOpenChange={setOpen}>
      {card}
      {/* The button describes itself with the same list: the popup is for the eyes only. */}
      <HoverCardContent
        aria-hidden="true"
        side="bottom"
        align="start"
        collisionPadding={16}
        className="w-[min(34rem,calc(100vw-2rem))]"
      >
        <strong className="mb-1.5 block text-[15px]">{feature.title}: what to expect</strong>
        <ul className="list-disc pl-5 text-[13px] leading-normal text-muted-foreground">
          {limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}
