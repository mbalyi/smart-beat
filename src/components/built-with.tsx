import { ArrowUpRightIcon } from "lucide-react";

import alphaTabLogo from "@/assets/alphatab-logo-horizontal.svg";
import rustAudioLogo from "@/assets/rustaudio-logo.png";
import { ExternalLink } from "@/components/external-link";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ALPHATAB, OTHER_CREDITS, type Credit } from "@/lib/credits";
import { cn } from "@/lib/utils";

const TILE =
  "flex min-h-[84px] w-full items-center justify-center gap-2.5 rounded-2xl border bg-card px-[18px] py-3.5 text-card-foreground outline-none transition-[border-color,background-color,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/60 hover:bg-muted focus-visible:-translate-y-0.5 focus-visible:border-brand/60 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none motion-reduce:hover:translate-y-0";

/** The logos that stand next to a name: alphaTab's own, and RustAudio's next to "cpal by RustAudio". */
const LOGOS: Record<string, string> = { RustAudio: rustAudioLogo };

/**
 * One project. The tile opens its page; hovering or focusing it also opens a card that says what
 * it does for Smart Beat, with a link. The card stays open while the pointer moves into it.
 */
function CreditCard({
  credit,
  className,
  children,
}: {
  credit: Credit;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <ExternalLink href={credit.url} className={cn(TILE, className)}>
          {children}
        </ExternalLink>
      </HoverCardTrigger>
      <HoverCardContent>
        <strong className="mb-1.5 block text-[15px]">{credit.name}</strong>
        <p className="mb-3 text-[13px] leading-normal text-muted-foreground">
          {credit.description}
        </p>
        <ExternalLink
          href={credit.url}
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-yellow underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          Explore project
          <ArrowUpRightIcon className="size-[15px]" aria-hidden="true" />
        </ExternalLink>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Thanks to the projects Smart Beat is built on. alphaTab comes first with its logo, used with its
 * maintainers' permission, and the RustAudio logo stands next to "cpal by RustAudio", as cpal's
 * maintainers said it may (docs/brand/README.md): visibly, never as if they endorsed the app.
 */
export function BuiltWith({ onShowLicenses }: { onShowLicenses?: () => void }) {
  return (
    <section aria-labelledby="built-with-title" className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-[0.12em] text-muted-foreground uppercase">
          <span aria-hidden="true" className="h-0.5 w-5 bg-brand-yellow" />
          Built together
        </p>
        <h2
          id="built-with-title"
          className="font-heading text-4xl leading-[1.08] font-bold tracking-tight text-balance sm:text-5xl"
        >
          Made possible by <span className="text-brand">open source.</span>
        </h2>
        <p className="max-w-2xl text-base text-pretty text-muted-foreground">
          A heartfelt thank you to the maintainers whose work makes Smart Beat possible. Meet a few
          of the projects behind the music.
        </p>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="sm:col-span-2 lg:col-span-2">
          <CreditCard
            credit={ALPHATAB}
            className="justify-start border-transparent bg-white px-5 hover:border-brand-yellow hover:bg-white focus-visible:bg-white"
          >
            <span className="sr-only">alphaTab</span>
            <img src={alphaTabLogo} alt="" aria-hidden="true" className="h-9 w-auto" />
          </CreditCard>
        </div>
        {OTHER_CREDITS.map((credit) => (
          <div key={credit.name} className="min-w-0">
            <CreditCard credit={credit}>
              {credit.by && (
                <img
                  src={LOGOS[credit.by]}
                  alt=""
                  aria-hidden="true"
                  className="size-8 shrink-0 rounded-full bg-white p-0.5"
                />
              )}
              <span className="flex flex-col items-center">
                <span className="text-center text-lg font-bold tracking-tight">{credit.name}</span>{" "}
                {credit.by && (
                  <span className="text-xs font-medium text-muted-foreground">by {credit.by}</span>
                )}
              </span>
            </CreditCard>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 text-muted-foreground sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <p className="max-w-4xl text-sm leading-relaxed text-pretty">
          Special thanks to <strong className="text-foreground">alphaTab</strong>, the heart of
          Smart Beat: this project would not exist without it. Please{" "}
          <ExternalLink
            href={ALPHATAB.source}
            className="font-medium text-foreground underline underline-offset-4"
          >
            star alphaTab on GitHub
          </ExternalLink>{" "}
          and try it in your own projects. Smart Beat is independent and is not affiliated with or
          endorsed by alphaTab or any of these projects.
        </p>
        {onShowLicenses && (
          <button
            type="button"
            onClick={onShowLicenses}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md text-[13px] font-semibold text-foreground outline-none hover:text-brand-yellow focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            View open-source notices
            <ArrowUpRightIcon className="size-[15px]" aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}
