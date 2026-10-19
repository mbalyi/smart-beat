import { PoweredByMuscriptor } from "@/components/ai/powered-by-muscriptor";
import { ExternalLink } from "@/components/external-link";
import { SectionKicker } from "@/components/section-kicker";
import { MUSCRIPTOR } from "@/lib/credits";

/**
 * Optional add-ons the user downloads themselves (#150). A section of its own, apart from the
 * libraries Smart Beat is built on: the model is not part of the app. Text only, no logos.
 */
export function OptionalAddons() {
  return (
    <section aria-labelledby="addons-title" className="flex flex-col gap-4">
      <div className="flex max-w-3xl flex-col gap-3">
        <SectionKicker>Optional add-ons</SectionKicker>
        <h2
          id="addons-title"
          className="font-heading text-3xl leading-[1.08] font-bold tracking-tight text-balance sm:text-4xl"
        >
          Add-ons you download <span className="text-brand">yourself.</span>
        </h2>
        <p className="max-w-2xl text-base text-pretty text-muted-foreground">
          <ExternalLink
            href={MUSCRIPTOR.url}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {MUSCRIPTOR.name}
          </ExternalLink>{" "}
          by {MUSCRIPTOR.authors} ({MUSCRIPTOR.licence.name}) powers the AI mode of Record to tab
          and Import from Audio. It is not part of Smart Beat: you download it once, accept its
          terms, and it runs on your computer. Non-commercial use only.
        </p>
      </div>
      <div className="max-w-3xl">
        <PoweredByMuscriptor />
      </div>
    </section>
  );
}
