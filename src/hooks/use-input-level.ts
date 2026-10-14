import { useEffect, useState } from "react";

import { audioInputErrorText, openAudioInput, type AudioInput } from "@/lib/audio/input";
import { meterLevel, peakOf, smoothLevel } from "@/lib/audio/level";

export type InputLevel =
  | { kind: "off" }
  | { kind: "asking" }
  /** `device`: the name of the input heard (it may be empty). */
  | { kind: "listening"; level: number; device: string }
  | { kind: "blocked"; message: string };

/**
 * Listens to the audio input (null: the system's default) while `on`, and reports its level
 * (0…1) for a meter. The input is asked for when listening starts and let go of when it stops.
 */
export function useInputLevel(on: boolean, input: AudioInput | null): InputLevel {
  const [state, setState] = useState<InputLevel>({ kind: "off" });

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      setState({ kind: "asking" });
      try {
        const opened = await openAudioInput(input);
        if (stopped) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
        const device = opened.getAudioTracks()[0]?.label ?? "";
        if (typeof AudioContext === "undefined") {
          setState({ kind: "listening", level: 0, device });
          return;
        }
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        let level = 0;
        setState({ kind: "listening", level, device });
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buffer);
          level = smoothLevel(level, meterLevel(peakOf(buffer)));
          setState({ kind: "listening", level, device });
        }, 60);
      } catch (error) {
        if (!stopped) setState({ kind: "blocked", message: audioInputErrorText(error) });
      }
    })();
    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
    };
  }, [on, input]);

  return on ? state : { kind: "off" };
}
