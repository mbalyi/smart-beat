import type { TourId } from "@/lib/tour/feature-registry";
import type { TourDefinition } from "@/lib/tour/tour-types";
import { audioLanesTour } from "@/lib/tour/tours/audio-lanes";
import { editingTour } from "@/lib/tour/tours/editing";
import { effectsTour } from "@/lib/tour/tours/effects";
import { mainTour } from "@/lib/tour/tours/main";
import { midiTour } from "@/lib/tour/tours/midi";
import { recordToTabTour } from "@/lib/tour/tours/record-to-tab";
import { sampleBrowserTour } from "@/lib/tour/tours/sample-browser";
import { speedTrainerTour } from "@/lib/tour/tours/speed-trainer";

export type { TourDefinition, TourStep, TourTarget } from "@/lib/tour/tour-types";

export const TOURS: Record<TourId, TourDefinition> = {
  main: mainTour,
  editing: editingTour,
  "speed-trainer": speedTrainerTour,
  effects: effectsTour,
  "record-to-tab": recordToTabTour,
  "audio-lanes": audioLanesTour,
  "sample-browser": sampleBrowserTour,
  midi: midiTour,
};

export const TOUR_LIST: readonly TourDefinition[] = Object.values(TOURS);
