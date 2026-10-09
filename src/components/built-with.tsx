import alphaTabLogo from "@/assets/alphatab-logo-horizontal.svg";
import { ExternalLink } from "@/components/external-link";
import { Tip } from "@/components/ui/tip";
import { ALPHATAB, OTHER_CREDITS } from "@/lib/credits";

const TILE =
  "flex items-center justify-center rounded-lg border bg-card px-4 py-3 text-sm font-semibold text-card-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Thanks to the projects Smart Beat is built on, like the sponsors row of a project page: one tile
 * each, side by side, with what it does shown on hover and keyboard focus. alphaTab comes first with
 * its logo, used with its maintainers' permission (docs/brand/README.md): visibly, never as if they
 * endorsed the app. The other projects are shown by name until their owners allow their logos.
 */
export function BuiltWith() {
  return (
    <section aria-labelledby="built-with-title" className="flex flex-col gap-4">
      <h2 id="built-with-title" className="font-heading text-xl font-semibold text-balance">
        Many thanks to the open-source library maintainers, without whom this application could not
        have been born. It is built with:
      </h2>
      <div className="flex flex-wrap items-stretch gap-3">
        <Tip label={ALPHATAB.description}>
          <ExternalLink
            href={ALPHATAB.url}
            aria-label={ALPHATAB.name}
            className={`${TILE} bg-white hover:bg-white/90`}
          >
            <img src={alphaTabLogo} alt="" aria-hidden="true" className="h-8 w-auto sm:h-10" />
          </ExternalLink>
        </Tip>
        {OTHER_CREDITS.map((credit) => (
          <Tip key={credit.name} label={credit.description}>
            <ExternalLink href={credit.url} className={TILE}>
              {credit.name}
            </ExternalLink>
          </Tip>
        ))}
      </div>
      <p className="text-sm text-pretty text-muted-foreground">
        Special thanks to alphaTab, the heart of Smart Beat: it would not exist without it. Please{" "}
        <ExternalLink
          href={ALPHATAB.source}
          className="font-medium underline underline-offset-4 hover:text-foreground"
        >
          star alphaTab on GitHub
        </ExternalLink>{" "}
        and try it in your own projects. Smart Beat is an independent project, not affiliated with
        or endorsed by alphaTab or any of these projects. All notices are in Help › Open-Source
        Licenses.
      </p>
    </section>
  );
}
