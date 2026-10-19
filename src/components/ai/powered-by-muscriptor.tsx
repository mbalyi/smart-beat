import { ExternalLink } from "@/components/external-link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { MUSCRIPTOR, MUSCRIPTOR_AUTHORS } from "@/lib/credits";
import { SIZES } from "@/lib/ai/muscriptor-sizes";

/** The text that explains what MuScriptor is: where it comes from, its licence and the links. */
export function MuscriptorFacts({ withSpeeds = false }: { withSpeeds?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <p>{MUSCRIPTOR.about}</p>
      <p>
        Made by{" "}
        <ExternalLink className="underline" href={MUSCRIPTOR_AUTHORS[0]!.url}>
          {MUSCRIPTOR_AUTHORS[0]!.name}
        </ExternalLink>{" "}
        and{" "}
        <ExternalLink className="underline" href={MUSCRIPTOR_AUTHORS[1]!.url}>
          {MUSCRIPTOR_AUTHORS[1]!.name}
        </ExternalLink>
        . The weights are licensed{" "}
        <ExternalLink className="underline" href={MUSCRIPTOR.licence.url}>
          {MUSCRIPTOR.licence.name}
        </ExternalLink>
        : <strong>non-commercial use only</strong>, and only on music you have the rights to.{" "}
        {MUSCRIPTOR.conversion}
      </p>
      {withSpeeds && (
        <p className="text-muted-foreground">
          The authors measured {SIZES.map((s) => `${s.label} ${s.gpuSeconds} s`).join(", ")} per
          minute of audio on an Apple M1 Pro GPU, on one machine only.
        </p>
      )}
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {MUSCRIPTOR.links.map((link) => (
          <li key={link.url}>
            <ExternalLink className="underline" href={link.url}>
              {link.label}
            </ExternalLink>
            {link.note ? <span className="text-muted-foreground"> ({link.note})</span> : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Smart Beat is independent and not affiliated with or endorsed by Kyutai or Mirelo.
      </p>
    </div>
  );
}

/** "Powered by MuScriptor", a collapsed accordion with the facts inside. */
export function PoweredByMuscriptor({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={defaultOpen ? "powered-by" : undefined}
      data-testid="powered-by-muscriptor"
    >
      <AccordionItem value="powered-by">
        <AccordionTrigger>Powered by MuScriptor</AccordionTrigger>
        <AccordionContent>
          <MuscriptorFacts />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
