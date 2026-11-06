import {
  ChevronsLeftIcon,
  ChevronsRightIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SquareIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

/** The words of the four jump buttons: a song jumps by bars, a set of stems by seconds. */
export type TransportLabels = {
  first: string;
  previous: string;
  next: string;
  last: string;
};

/**
 * The play control of the header, the same on an open song and on a set of stems: jump to the
 * start, step back, play or pause, stop, step forward, jump to the end. The outer jumps give
 * way in smaller windows.
 */
export function TransportButtons({
  ready,
  playing,
  labels,
  onFirst,
  onPrevious,
  onPlayPause,
  onStop,
  onNext,
  onLast,
  playTitle,
  locked = false,
}: {
  ready: boolean;
  /** Practice together: a guest follows the host, whose buttons these are. */
  locked?: boolean;
  playing: boolean;
  labels: TransportLabels;
  onFirst: () => void;
  onPrevious: () => void;
  onPlayPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onLast: () => void;
  /** The play button's tooltip when it differs from "Play" and "Pause" (a song shows its key). */
  playTitle?: { play: string; pause: string };
}) {
  const off = !ready || locked;
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onFirst}
        disabled={off}
        aria-label={labels.first}
        title={labels.first}
        className="max-2xl:hidden"
      >
        <SkipBackIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onPrevious}
        disabled={off}
        aria-label={labels.previous}
        title={labels.previous}
      >
        <ChevronsLeftIcon />
      </Button>
      <Button
        size="icon-sm"
        onClick={onPlayPause}
        disabled={off}
        aria-label={playing ? "Pause" : "Play"}
        data-tour="play"
        title={playing ? (playTitle?.pause ?? "Pause") : (playTitle?.play ?? "Play")}
        className="rounded-full"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={onStop}
        disabled={off}
        aria-label="Stop"
        title="Stop"
      >
        <SquareIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onNext}
        disabled={off}
        aria-label={labels.next}
        title={labels.next}
      >
        <ChevronsRightIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onLast}
        disabled={off}
        aria-label={labels.last}
        title={labels.last}
        className="max-2xl:hidden"
      >
        <SkipForwardIcon />
      </Button>
    </div>
  );
}
