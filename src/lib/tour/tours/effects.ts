import type { TourDefinition } from "@/lib/tour/tour-types";

export const effectsTour: TourDefinition = {
  id: "effects",
  title: "Effects tour",
  description: "Guitar effects, the pedalboard and the mastering strip.",
  steps: [
    {
      id: "tracks",
      target: "tracks",
      title: "Effects per track",
      body: "Each track has volume, pan, EQ and effects. Open a track's menu to edit its effects in the pedalboard, where you drag them into order.",
      needsSong: true,
      show: { mixer: true },
      placement: "top",
    },
    {
      id: "mastering",
      target: "mastering",
      title: "Mastering",
      body: "The master strip sets the whole mix; its pedalboard button adds effects to everything.",
      needsSong: true,
      show: { mixer: true },
      placement: "top",
    },
  ],
};
