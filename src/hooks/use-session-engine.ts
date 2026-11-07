import { useEffect, useRef } from "react";
import { toast } from "sonner";

import type { AudioEngineKind } from "@/lib/score/player";

/**
 * Practice together plays with the SoundFonts (alphaTab's synthesizer): the native engine has its
 * own clock and buffers, which cannot be started at an agreed instant. While a session lasts the
 * engine is switched to the SoundFonts (without saving the choice), and it comes back after.
 */
export function useSessionEngine(
  sessionOn: boolean,
  engine: AudioEngineKind,
  setEngine: (kind: AudioEngineKind) => void,
) {
  const before = useRef<AudioEngineKind | null>(null);
  useEffect(() => {
    if (sessionOn && engine === "native") {
      before.current = "native";
      setEngine("alphatab");
      toast.info("Practice together plays with the SoundFonts", {
        description: "Your audio engine comes back when you leave the session.",
      });
    } else if (!sessionOn && before.current) {
      setEngine(before.current);
      before.current = null;
    }
  }, [sessionOn, engine, setEngine]);
}
