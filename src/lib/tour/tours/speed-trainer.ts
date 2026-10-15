import type { TourDefinition } from "@/lib/tour/tour-types";

export const speedTrainerTour: TourDefinition = {
  id: "speed-trainer",
  title: "Speed Trainer tour",
  description: "Loop a passage and speed it up a little each time round.",
  steps: [
    {
      id: "loop",
      target: "loop",
      title: "Choose a passage",
      body: "Turn Loop on and drag across the bars to repeat, or pick a named section.",
      needsSong: true,
      placement: "bottom",
    },
    {
      id: "trainer",
      target: "speed-trainer",
      title: "Speed Trainer",
      body: "Start slowly and let each round of the loop go a little faster, up to your target. Stopping it puts the speed back to 100%.",
      needsSong: true,
      placement: "bottom",
    },
  ],
};
