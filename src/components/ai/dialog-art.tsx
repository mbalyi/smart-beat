import splashLeft from "@/assets/record-to-tab/splash-bottom-left.webp";
import splashRight from "@/assets/record-to-tab/splash-bottom-right.webp";
import { Stepper } from "@/components/ui/stepper";
import { cn } from "@/lib/utils";

/** The neon glow and ring of the AI dialogs. Add the frame's size classes beside it. */
export const DIALOG_NEON =
  "shadow-[0_0_24px_color-mix(in_oklab,var(--primary)_55%,transparent)] ring-2 ring-primary/90";

/** The steps of every AI dialog: one component, in our colours, centred across the dialog. */
export function DialogStepper({
  labels,
  current,
  start = 1,
}: {
  labels: readonly string[];
  current: number;
  /** The number on the first step; 0 for a step before the first. */
  start?: number;
}) {
  return <Stepper steps={labels} current={current} start={start} className="-mt-[12px] pb-1" />;
}

/** The graffiti behind the dialog: splashes along the bottom and the picture of the step. */
export function DialogArt({
  hero,
  name,
}: {
  hero?: { src: string; place: string } | null;
  name: string;
}) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <img
        src={splashLeft}
        alt=""
        className="absolute bottom-0 left-0 w-[40%] opacity-50 dark:opacity-90"
      />
      <img
        src={splashRight}
        alt=""
        className="absolute right-0 bottom-0 w-[20%] opacity-50 dark:opacity-90"
      />
      {hero && (
        <img
          src={hero.src}
          alt=""
          data-hero={name}
          className={cn("absolute hidden md:block", hero.place)}
        />
      )}
    </div>
  );
}

/** The logo in the dialog header, decorative for screen readers. */
export function DialogLogo({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("-mt-[14px] -ml-[28px] h-[94px] w-auto self-start object-contain", className)}
    />
  );
}
