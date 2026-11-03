import { useEffect, useRef, useState } from "react";

import { NEURAL_ENGINES, type NeuralEngine } from "@/components/stems/stem-engines";
import { errorText } from "@/lib/errors";
import {
  acceptStemModelTerms,
  acceptUmxTerms,
  cancelStemModelDownload,
  cancelUmxDownload,
  downloadStemModel,
  downloadUmxModel,
  isTauri,
  removeStemModel,
  removeUmxModel,
  stemModelStatus,
  umxModelStatus,
  type StemEngine,
  type StemModelId,
} from "@/lib/tauri";

// --- One downloadable model, whichever commands it lives behind ------------------------------

/** What the dialog needs to know about a model on this computer. */
export interface ModelState {
  downloaded: boolean;
  termsAccepted: boolean;
  /** The size of the download, in bytes. */
  downloadBytes: number;
  /** The licence wording the user confirms. */
  licence: string;
  /** False while the file is not published yet. */
  available: boolean;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

interface Adapter {
  status: () => Promise<ModelState>;
  accept: () => Promise<unknown>;
  download: (onProgress: (progress: DownloadProgress) => void) => Promise<unknown>;
  cancel: () => Promise<unknown>;
  remove: () => Promise<unknown>;
}

const MODEL_OF: Record<Exclude<NeuralEngine, "neural">, StemModelId> = {
  scnet: "scnet",
  "scnet-xl": "scnet-xl",
  htdemucs: "htdemucs",
  "htdemucs-6s": "htdemucs-6s",
};

function adapterFor(engine: NeuralEngine): Adapter {
  if (engine === "neural") {
    // UMX-HQ keeps its own commands; it has no "not published" state.
    return {
      status: async () => ({ ...(await umxModelStatus()), available: true }),
      accept: acceptUmxTerms,
      download: downloadUmxModel,
      cancel: cancelUmxDownload,
      remove: removeUmxModel,
    };
  }
  const model = MODEL_OF[engine];
  return {
    status: () => stemModelStatus(model),
    accept: () => acceptStemModelTerms(model),
    download: (onProgress) => downloadStemModel(model, onProgress),
    cancel: cancelStemModelDownload,
    remove: () => removeStemModel(model),
  };
}

const STOPPED = "Download stopped.";

// --- The state of every model ----------------------------------------------------------------

type Stage = "terms" | "downloading";

/** The model whose terms or download the user is looking at. */
export interface Setup {
  engine: NeuralEngine;
  stage: Stage;
  download: DownloadProgress | null;
  error: string;
}

export interface EngineModels {
  states: Partial<Record<NeuralEngine, ModelState>>;
  /** Why a model's status could not be read. */
  unreadable: Partial<Record<NeuralEngine, string>>;
  setup: Setup | null;
  /** A download is running: the dialog must not be left or changed. */
  busy: boolean;
  /** Something went wrong outside a setup (removing a model). */
  error: string;
  /** On this computer, with the terms accepted. */
  isReady: (engine: StemEngine) => boolean;
  open: (engine: NeuralEngine) => void;
  close: () => void;
  accept: () => void;
  cancel: () => void;
  remove: (engine: NeuralEngine) => void;
}

/** Whether each model is on this computer, and the terms and download of the one being set up. */
export function useEngineModels(offered: boolean): EngineModels {
  const [states, setStates] = useState<EngineModels["states"]>({});
  const [unreadable, setUnreadable] = useState<EngineModels["unreadable"]>({});
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = async (engine: NeuralEngine) => {
    try {
      const next = await adapterFor(engine).status();
      if (!mounted.current) return;
      setStates((all) => ({ ...all, [engine]: next }));
      setUnreadable((all) => ({ ...all, [engine]: undefined }));
    } catch (cause) {
      if (mounted.current) setUnreadable((all) => ({ ...all, [engine]: errorText(cause) }));
    }
  };
  useEffect(() => {
    if (!offered || !isTauri()) return;
    for (const engine of NEURAL_ENGINES) void refresh(engine);
  }, [offered]);

  // Leaving while a download runs stops it.
  const running = useRef<NeuralEngine | null>(null);
  useEffect(() => {
    running.current = setup?.stage === "downloading" ? setup.engine : null;
  });
  useEffect(
    () => () => {
      if (running.current) void adapterFor(running.current).cancel();
    },
    [],
  );

  const accept = async () => {
    if (!setup) return;
    const { engine } = setup;
    const adapter = adapterFor(engine);
    setSetup({ engine, stage: "downloading", download: null, error: "" });
    try {
      await adapter.accept();
      await adapter.download((next) => {
        if (mounted.current) setSetup((now) => (now ? { ...now, download: next } : now));
      });
      await refresh(engine);
      if (mounted.current) setSetup(null);
    } catch (cause) {
      if (!mounted.current) return;
      const message = errorText(cause);
      setSetup({
        engine,
        stage: "terms",
        download: null,
        error: message === STOPPED ? "" : message,
      });
    }
  };

  return {
    states,
    unreadable,
    setup,
    busy: setup?.stage === "downloading",
    error,
    isReady: (engine) => {
      if (engine === "fast") return true;
      const state = states[engine];
      return Boolean(state?.downloaded && state.termsAccepted);
    },
    open: (engine) => {
      setError("");
      setSetup({ engine, stage: "terms", download: null, error: "" });
    },
    close: () => setSetup(null),
    accept: () => void accept(),
    cancel: () => {
      if (setup) void adapterFor(setup.engine).cancel();
    },
    remove: (engine) => {
      setError("");
      adapterFor(engine)
        .remove()
        .then(() => refresh(engine))
        .catch((cause) => mounted.current && setError(errorText(cause)));
    },
  };
}
