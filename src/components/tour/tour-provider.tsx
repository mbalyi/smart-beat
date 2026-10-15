import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Joyride, EVENTS, ACTIONS, type EventData, type Step } from "react-joyride";
import { toast } from "sonner";

import { CoachMark } from "@/components/tour/coach-mark";
import { TourContext, type TourApi, type TourHost } from "@/hooks/use-tour";
import { APP_VERSION } from "@/lib/project-info";
import type { TourId } from "@/lib/tour/feature-registry";
import { requestTourPanels } from "@/lib/tour/tour-bus";
import {
  startRun,
  transition,
  type TourEnd,
  type TourEvent,
  type TourRun,
} from "@/lib/tour/tour-machine";
import {
  initTourState,
  writeTourState,
  type TourProgress,
  type TourState,
} from "@/lib/tour/tour-store";
import { TOURS, type TourStep } from "@/lib/tour/tours";

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const targetSelector = (step: TourStep) => `[data-tour="${step.target}"]`;
const isReachable = (step: TourStep) => document.querySelector(targetSelector(step)) !== null;

const toJoyrideStep = (step: TourStep, canGoBack: () => boolean): Step => ({
  data: { canGoBack },
  id: step.id,
  target: targetSelector(step),
  title: step.title,
  content: step.body,
  placement: step.placement ?? "bottom",
  skipBeacon: true,
  targetWaitTimeout: 4000,
});

const EVENT_FOR_ACTION: Partial<Record<string, TourEvent>> = {
  [ACTIONS.NEXT]: "next",
  [ACTIONS.PREV]: "back",
  [ACTIONS.CLOSE]: "close",
  [ACTIONS.SKIP]: "skip",
};

/**
 * Runs the guided tours (#84) on top of react-joyride in controlled mode: the state machine in
 * `tour-machine.ts` owns the step, joyride only draws the spotlight and positions the coach mark.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TourState | null>(null);
  const [run, setRun] = useState<TourRun | null>(null);
  const host = useRef<TourHost | null>(null);
  const bindHost = useCallback((next: TourHost) => {
    host.current = next;
  }, []);

  const update = useCallback((change: (s: TourState) => TourState) => {
    setState((current) => {
      if (!current) return current;
      const next = change(current);
      writeTourState(next);
      return next;
    });
  }, []);

  // `initTourState` returns what is saved, so calling this twice (Strict Mode) changes nothing.
  const init = useCallback((existingUser: boolean) => {
    const next = initTourState(existingUser, APP_VERSION);
    setState(next);
    return next;
  }, []);

  const definition = run ? TOURS[run.tour as TourId] : null;

  /** Gets the song and panels ready for the step about to show. */
  const prepare = useCallback((step: TourStep | undefined) => {
    if (!step) return;
    if (step.needsSong && host.current && !host.current.hasSong()) host.current.openDemo();
    if (step.show) requestTourPanels(step.show);
  }, []);

  const finish = useCallback(
    (tour: string, ended: TourEnd, step: number) => {
      requestTourPanels("restore");
      const progress: TourProgress =
        ended === "interrupted" && step > 0
          ? { step }
          : ended === "interrupted"
            ? "skipped"
            : ended;
      update((s) => ({ ...s, tours: { ...s.tours, [tour]: progress } }));
    },
    [update],
  );

  const apply = useCallback(
    (event: TourEvent) => {
      if (!run) return;
      const def = TOURS[run.tour as TourId];
      if (event === "back") {
        let previous = run.index - 1;
        while (previous >= 0 && !isReachable(def.steps[previous]!)) previous--;
        if (previous < 0) return;
        prepare(def.steps[previous]);
        setRun({ ...run, index: previous, direction: -1 });
        return;
      }
      const result = transition(run, event, def.steps.length);
      if (result.ended) {
        setRun(null);
        finish(run.tour, result.ended, run.index);
        return;
      }
      if (result.run) {
        prepare(def.steps[result.run.index]);
        setRun(result.run);
      }
    },
    [run, prepare, finish],
  );

  const start = useCallback(
    (id: TourId, fromStep = 0) => {
      const def = TOURS[id];
      // A replay with a song open does not wait for a control that only the start page has.
      const index = def.steps.findIndex(
        (step, i) =>
          i >= fromStep &&
          (document.querySelector(`[data-tour="${step.target}"]`) !== null ||
            (step.needsSong === true && host.current?.hasSong() === false)),
      );
      if (index < 0) return;
      prepare(def.steps[index]);
      setRun(startRun(id, index));
    },
    [prepare],
  );

  const onEvent = (data: EventData) => {
    if (data.type === EVENTS.TARGET_NOT_FOUND) {
      apply("missing");
      return;
    }
    // Skip ends the tour with its own event rather than a finished step.
    if (data.action === ACTIONS.SKIP && data.type !== EVENTS.STEP_AFTER_HOOK) {
      apply("skip");
      return;
    }
    if (data.type === EVENTS.STEP_AFTER) {
      const event = EVENT_FOR_ACTION[data.action];
      if (event) apply(event);
    }
  };

  // The control the step points at gets an outline, so the target does not rely on colour or the
  // dimming. The control may appear after the step starts (the demo song is still opening).
  const targetName = definition && run ? definition.steps[run.index]?.target : undefined;
  useEffect(() => {
    if (!targetName) return;
    let marked: Element | null = null;
    const mark = () => {
      const el = document.querySelector(`[data-tour="${targetName}"]`);
      if (el && el !== marked) {
        marked?.removeAttribute("data-tour-active");
        el.setAttribute("data-tour-active", "");
        marked = el;
      }
    };
    mark();
    const timer = window.setInterval(mark, 250);
    return () => {
      window.clearInterval(timer);
      marked?.removeAttribute("data-tour-active");
    };
  }, [targetName, run?.index]);

  const api = useMemo<TourApi>(
    () => ({
      state,
      active: run ? (run.tour as TourId) : null,
      offerMainTour: state !== null && state.tours.main === undefined,
      init,
      bindHost,
      start,
      dismissMainTour: () => update((s) => ({ ...s, tours: { ...s.tours, main: "skipped" } })),
      resumeStep: (id) => {
        const progress = state?.tours[id];
        return typeof progress === "object" ? progress.step : null;
      },
      markVersionSeen: () => update((s) => ({ ...s, lastSeenVersion: APP_VERSION })),
      hint: (id, tour, message) => {
        if (!state || state.hints[id] || run) return;
        update((s) => ({ ...s, hints: { ...s.hints, [id]: true } }));
        toast(message, {
          action: { label: "Show me", onClick: () => start(tour) },
          duration: 10000,
        });
      },
      resetHints: () => update((s) => ({ ...s, hints: {} })),
    }),
    [state, run, init, bindHost, start, update],
  );

  // Back is offered only when an earlier step has its control on screen (the start page's Open
  // button is gone once a song is open); the coach mark asks when it draws.
  const stepIndex = run?.index;
  const steps = useMemo(
    () =>
      definition?.steps.map((step, i) =>
        toJoyrideStep(step, () => definition.steps.slice(0, i).some(isReachable)),
      ) ?? [],
    // The controls on screen change with the step, not with every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [definition, stepIndex],
  );

  return (
    <TourContext.Provider value={api}>
      {children}
      {run && definition && (
        <Joyride
          steps={steps}
          run
          continuous
          stepIndex={run.index}
          onEvent={onEvent}
          tooltipComponent={CoachMark}
          options={{
            skipBeacon: true,
            disableFocusTrap: true,
            overlayClickAction: false,
            dismissKeyAction: "close",
            overlayColor: "rgba(0, 0, 0, 0.45)",
            zIndex: 60,
            spotlightRadius: 10,
            spotlightPadding: 6,
            // The workspace never scrolls the page; scrolling to a control would slide it under the header.
            skipScroll: true,
            scrollDuration: prefersReducedMotion() ? 0 : 300,
            showProgress: true,
          }}
          locale={{ back: "Back", close: "Close", last: "Done", next: "Next", skip: "Skip" }}
        />
      )}
    </TourContext.Provider>
  );
}
