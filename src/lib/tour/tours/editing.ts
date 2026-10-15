import type { TourDefinition } from "@/lib/tour/tour-types";

export const editingTour: TourDefinition = {
  id: "editing",
  title: "Editing tour",
  description: "Write notes and drums, undo and redo, and work with tracks.",
  steps: [
    {
      id: "edit",
      target: "edit",
      title: "Edit mode",
      body: "Turn Edit mode on to write notes with the keyboard and mouse.",
      needsSong: true,
      placement: "bottom",
    },
    {
      id: "palette",
      target: "note-palette",
      title: "Note palette",
      body: "Pick a duration and a technique. On a drum track, the drum picker names each element, and Normalize drum notation tidies the staff.",
      needsSong: true,
      show: { editing: true },
      placement: "bottom",
    },
    {
      id: "history",
      target: "history",
      title: "Undo and redo",
      body: "Every edit can be undone, and redone.",
      needsSong: true,
      placement: "bottom",
    },
    {
      id: "tracks",
      target: "tracks",
      title: "Tracks",
      body: "Add a track, or open a track's menu to copy it to another instrument or normalize a drum track.",
      needsSong: true,
      show: { mixer: true },
      placement: "top",
    },
  ],
};
