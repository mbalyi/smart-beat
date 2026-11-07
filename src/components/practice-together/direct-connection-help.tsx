import { type DesktopOs, detectDesktopOs } from "@/lib/practice-together/desktop-os";
import {
  DIRECT_CONNECTION_CHECK,
  DIRECT_CONNECTION_EXPECT,
  directConnectionGuide,
} from "@/lib/practice-together/direct-connection";
import { CARD } from "@/components/practice-together/together-frame";
import { cn } from "@/lib/utils";

/**
 * Steps for getting two computers onto one network without a router. It shows the steps of
 * the system the app runs on and no other system's (`os` is for tests).
 */
export function DirectConnectionHelp({ os = detectDesktopOs() }: { os?: DesktopOs }) {
  const guide = directConnectionGuide(os);
  return (
    <div
      role="region"
      aria-labelledby="direct-connection-title"
      data-testid="direct-connection-help"
      data-os={guide.os}
      // The dialog body scrolls on a small screen; this lets the keyboard scroll it.
      tabIndex={0}
      className="flex flex-col gap-4 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="flex flex-col gap-1">
        <h3 id="direct-connection-title" className="text-lg font-semibold">
          A direct connection on {guide.system}
        </h3>
        <p className="text-sm text-muted-foreground">{guide.intro}</p>
      </div>
      {guide.options.map((option) => (
        <div key={option.id} className={cn(CARD, "flex flex-col gap-2")}>
          <h4 className="text-sm font-semibold">{option.title}</h4>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
            {option.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {option.other && (
            <>
              <p className="text-sm font-semibold">The other player</p>
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
                {option.other.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      ))}
      <div className={cn(CARD, "flex flex-col gap-2")}>
        <h4 className="text-sm font-semibold">What to expect</h4>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          {DIRECT_CONNECTION_EXPECT.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-sm">{DIRECT_CONNECTION_CHECK}</p>
      </div>
    </div>
  );
}
