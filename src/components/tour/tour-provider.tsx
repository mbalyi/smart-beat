import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Joyride, EVENTS, ACTIONS, type EventData, type Step } from "react-joyride";
import { toast } from "sonner";

import { CoachCard, CoachMark, type CoachData } from "@/components/tour/coach-mark";
import { CoachActionsContext, TourContext, type TourApi, type TourHost } from "@/hooks/use-tour";
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
import { TOUR_LIST, TOURS, type TourStep } from "@/lib/tour/tours";

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const targetSelector = (step: TourStep) => `[data-tour="${step.target}"]`;
/** A step can be shown when its control is on screen, or a dialog the step opens will have it. */
const isReachable = (step: TourStep) =>
  step.inDialog === true || document.querySelector(targetSelector(step)) !== null;

/** The other tours the last step of a tour offers to go on with. */
const otherTours = (current: string) =>
  TOUR_LIST.filter((tour) => tour.id !== current && tour.id !== "main").map((tour) => ({
    id: tour.id,
    title: tour.title,
    description: tour.description,
  }));

const coachData = (step: TourStep, tour: string, canGoBack: () => boolean): CoachData => ({
  canGoBack,
  choices: step.offerTours ? otherTours(tour) : undefined,
});

const toJoyrideStep = (step: TourStep, data: CoachData): Step => ({
  data,
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
  const prepare = useCallback((step: TourStep | undefined, previous?: TourStep) => {
    if (!step) return;
    if (step.needsSong && host.current && !host.current.hasSong()) host.current.openDemo();
    const request = { ...step.show };
    // Leaving a step that opened a dialog closes it, unless this step opens another one.
    const hadDialog = previous?.inDialog || (previous?.show?.dialog ?? "none") !== "none";
    if (request.dialog === undefined && hadDialog) request.dialog = "none";
    if (Object.keys(request).length > 0) requestTourPanels(request);
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
        prepare(def.steps[previous], def.steps[run.index]);
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
        prepare(def.steps[result.run.index], def.steps[run.index]);
        setRun(result.run);
      }
    },
    [run, prepare, finish],
  );

  const start = useCallback(
    (id: TourId, fromStep = 0) => {
      const def = TOURS[id];
      if (fromStep === 0 && def.startAt && document.querySelector(def.startAt.selector)) {
        const at = def.steps.findIndex((step) => step.id === def.startAt!.step);
        if (at > 0) fromStep = at;
      }
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

  /** The last step of a tour: finish it and go on with the one the user picked. */
  const choose = useCallback(
    (id: string) => {
      if (!run) return;
      const { tour, index } = run;
      setRun(null);
      finish(tour, "done", index);
      // Let the song put its panels back before the next tour records them again.
      window.setTimeout(() => start(id as TourId), 200);
    },
    [run, finish, start],
  );

  // A step inside a dialog is drawn at the bottom of that dialog (it is modal: nothing outside it
  // can be reached), so wait for the dialog's slot, and end the tour if the user closes the dialog.
  const currentStep = definition && run ? definition.steps[run.index] : undefined;
  const inline = currentStep?.inDialog === true;
  const [slot, setSlot] = useState<Element | null>(null);
  const slotEvent = useEffectEvent((event: TourEvent) => apply(event));
  useEffect(() => {
    if (!inline) return;
    const started = Date.now();
    let seen = false;
    const timer = window.setInterval(() => {
      const el = document.querySelector('[role="dialog"][data-state="open"] [data-tour-slot]');
      setSlot(el);
      if (el) seen = true;
      else if (seen) {
        window.clearInterval(timer);
        slotEvent("close");
      } else if (Date.now() - started > 6000) {
        window.clearInterval(timer);
        slotEvent("missing");
      }
    }, 150);
    return () => {
      window.clearInterval(timer);
      setSlot(null);
    };
  }, [inline, run?.index]);

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
        toJoyrideStep(
          step,
          coachData(step, definition.id, () => definition.steps.slice(0, i).some(isReachable)),
        ),
      ) ?? [],
    // The controls on screen change with the step, not with every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [definition, stepIndex],
  );

  return (
    <TourContext.Provider value={api}>
      {children}
      {run &&
        definition &&
        inline &&
        slot &&
        createPortal(
          <CoachCard
            inline
            index={run.index}
            size={definition.steps.length}
            title={currentStep!.title}
            body={currentStep!.body}
            isLast={run.index === definition.steps.length - 1}
            canGoBack={definition.steps.slice(0, run.index).some(isReachable)}
            choices={currentStep!.offerTours ? otherTours(definition.id) : undefined}
            onChoose={choose}
            onBack={() => apply("back")}
            onNext={() => apply("next")}
            onSkip={() => apply("skip")}
          />,
          slot,
        )}
      {run && definition && !inline && (
        <CoachActionsContext.Provider value={{ onChoose: choose }}>
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
            // The dimming never takes the mouse wheel or clicks: the page stays usable (WebKit would
            // otherwise not scroll the note palette under the overlay).
            styles={{ overlay: { pointerEvents: "none" }, spotlight: { pointerEvents: "none" } }}
            locale={{ back: "Back", close: "Close", last: "Done", next: "Next", skip: "Skip" }}
          />
        </CoachActionsContext.Provider>
      )}
    </TourContext.Provider>
  );
}
