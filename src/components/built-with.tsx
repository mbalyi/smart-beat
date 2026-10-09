import alphaTabLogo from "@/assets/alphatab-logo-horizontal.svg";
import { ExternalLink } from "@/components/external-link";
import { ALPHATAB, OTHER_CREDITS } from "@/lib/credits";

const LINK = "font-medium underline underline-offset-4 hover:text-foreground";

/**
 * Thanks to the projects Smart Beat is built on, alphaTab first. The alphaTab logo is shown with
 * its maintainers' permission (docs/brand/README.md): visibly, never as if they endorsed the app.
 */
export function BuiltWith() {
  return (
    <section aria-labelledby="built-with-title" className="flex flex-col gap-4">
      <h2 id="built-with-title" className="font-heading text-xl font-semibold">
        Built with
      </h2>
      <div className="flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
        <ExternalLink
          href={ALPHATAB.url}
          aria-label="alphaTab"
          className="w-fit shrink-0 rounded-md bg-white p-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <img src={alphaTabLogo} alt="" aria-hidden="true" className="h-8 w-auto sm:h-10" />
        </ExternalLink>
        <p className="text-sm text-pretty text-muted-foreground">
          <ExternalLink href={ALPHATAB.url} className={LINK}>
            alphaTab
          </ExternalLink>{" "}
          reads the Guitar Pro files, draws the notation and the tablature, and powers the score and
          parts of playback. Smart Beat would not exist without it. Thank you to its maintainers and
          contributors: please{" "}
          <ExternalLink href={ALPHATAB.source} className={LINK}>
            star alphaTab on GitHub
          </ExternalLink>{" "}
          and try it in your own projects. Smart Beat is an independent project, not affiliated with
          or endorsed by alphaTab.
        </p>
      </div>
      <p className="text-sm text-pretty text-muted-foreground">
        Also built with{" "}
        {OTHER_CREDITS.map((credit, index) => (
          <span key={credit.name}>
            <ExternalLink href={credit.url} className={LINK}>
              {credit.name}
            </ExternalLink>{" "}
            ({credit.what}){index < OTHER_CREDITS.length - 1 ? ", " : "."}
          </span>
        ))}{" "}
        All notices are in Help › Open-Source Licenses.
      </p>
    </section>
  );
}
