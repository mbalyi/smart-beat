import { listen } from "@tauri-apps/api/event";
import { CloudDownloadIcon, CloudIcon, CloudOffIcon, FileMusicIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { SectionKicker } from "@/components/section-kicker";
import { errorText } from "@/lib/errors";
import { listCloudAccounts } from "@/lib/cloud";
import {
  cloudErrorText,
  rememberCloudName,
  listCloudItems,
  providerLabel,
  type CloudItem,
  type CloudProvider,
} from "@/lib/cloud-items";
import {
  getCloudFolder,
  isCommandError,
  isTauri,
  listCloudScores,
  type CloudScore,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type State =
  | { status: "loading" }
  | { status: "unlinked" }
  | { status: "ready"; folder: string; scores: CloudScore[] }
  | { status: "error"; folder: string; message: string };

/** The tabs of one connected online drive, or why they can't be listed. */
type ProviderState = {
  provider: CloudProvider;
  items: CloudItem[];
  message?: string;
};

/** What to tell the user when the linked folder can't be read. */
function problemText(error: unknown): string {
  if (isCommandError(error) && error.kind === "not-found") {
    return "The cloud folder could not be found. Is the drive offline? Check your connection or the sync app, then reopen this screen.";
  }
  return errorText(error);
}

/**
 * The tabs in the linked cloud folder (#187), for the start screen. Hidden when no folder is
 * linked or outside the desktop app. A file that is only online shows "Waiting for download":
 * opening it asks the cloud app to fetch it first.
 */
export function CloudScores({ onOpen }: { onOpen: (path: string) => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  /** Files being fetched right now (the core tells us while it waits). */
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(new Set());

  const [providers, setProviders] = useState<ProviderState[]>([]);

  // The tabs of every connected online drive (#187, phase 2).
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    (async () => {
      try {
        const connected = (await listCloudAccounts()).filter((a) => a.account);
        const found = await Promise.all(
          connected.map(async ({ provider }): Promise<ProviderState> => {
            try {
              return { provider, items: await listCloudItems(provider) };
            } catch (error) {
              return {
                provider,
                items: [],
                message: cloudErrorText(error, provider) ?? errorText(error),
              };
            }
          }),
        );
        if (active) setProviders(found);
      } catch {
        // No accounts to show; the folder section still works.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    (async () => {
      let folder: string | null = null;
      try {
        folder = await getCloudFolder();
        if (!folder) {
          if (active) setState({ status: "unlinked" });
          return;
        }
        const scores = await listCloudScores();
        if (active) setState({ status: "ready", folder, scores });
      } catch (error) {
        if (active) {
          setState(
            folder
              ? { status: "error", folder, message: problemText(error) }
              : { status: "unlinked" },
          );
        }
      }
    })();
    const unlisten = listen<string>("cloud-download-waiting", (event) =>
      setDownloading((set) => new Set(set).add(event.payload)),
    );
    return () => {
      active = false;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const folderShown = state.status === "ready" || state.status === "error";
  if (!folderShown && providers.length === 0) return null;
  const remote = providers.flatMap(({ provider, items }) =>
    items.map((item) => ({ provider, item })),
  );
  const empty = state.status === "ready" && state.scores.length === 0 && remote.length === 0;
  const scores = state.status === "ready" ? state.scores : [];

  return (
    <section
      aria-labelledby="cloud-title"
      className="flex flex-col gap-3"
      data-testid="cloud-section"
    >
      <SectionKicker as="h2" id="cloud-title">
        Cloud
      </SectionKicker>
      {providers
        .filter((p) => p.message)
        .map((p) => (
          <p
            key={p.provider}
            role="alert"
            className="flex items-start gap-2 rounded-2xl border border-destructive/40 bg-card p-4 text-sm"
          >
            <CloudOffIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              {providerLabel(p.provider)}: {p.message}
            </span>
          </p>
        ))}
      {state.status === "error" ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-2xl border border-destructive/40 bg-card p-4 text-sm"
        >
          <CloudOffIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <span>{state.message}</span>
        </p>
      ) : empty ? (
        <p className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
          No tabs in your cloud folder yet. Save a song there and it shows up here on every device.
        </p>
      ) : scores.length + remote.length === 0 ? null : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {remote.map(({ provider, item }, index) => (
            <li key={item.id} className="min-w-0">
              <button
                type="button"
                className={cn(
                  "group flex min-h-[76px] w-full min-w-0 items-center gap-3.5 overflow-hidden rounded-2xl border bg-card px-4 py-3 text-left transition-[border-color,background-color,transform] duration-150 outline-none hover:-translate-y-0.5 hover:bg-muted focus-visible:-translate-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                  index % 2 === 0
                    ? "hover:border-brand-yellow/60 focus-visible:border-brand-yellow/60"
                    : "hover:border-brand/60 focus-visible:border-brand/60",
                )}
                onClick={() => {
                  rememberCloudName(item.id, item.name);
                  onOpen(item.id);
                }}
                title={`${item.name} (${providerLabel(provider)})`}
                data-testid="cloud-item"
              >
                <FileMusicIcon
                  className={cn(
                    "size-[22px] shrink-0",
                    index % 2 === 0 ? "text-brand-yellow" : "text-brand",
                  )}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[17px] font-bold">{item.name}</span>
                  <span className="flex items-center gap-1 truncate text-sm text-muted-foreground">
                    <CloudIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    {providerLabel(provider)}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {scores.map((score, index) => {
            const waiting = score.placeholder;
            const fetching = downloading.has(score.path);
            return (
              <li key={score.path} className="min-w-0">
                <button
                  type="button"
                  className={cn(
                    "group flex min-h-[76px] w-full min-w-0 items-center gap-3.5 overflow-hidden rounded-2xl border bg-card px-4 py-3 text-left transition-[border-color,background-color,transform] duration-150 outline-none hover:-translate-y-0.5 hover:bg-muted focus-visible:-translate-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                    index % 2 === 0
                      ? "hover:border-brand-yellow/60 focus-visible:border-brand-yellow/60"
                      : "hover:border-brand/60 focus-visible:border-brand/60",
                  )}
                  onClick={() => onOpen(score.path)}
                  title={score.path}
                  data-testid="cloud-score"
                  data-placeholder={waiting ? "true" : undefined}
                >
                  {waiting ? (
                    <CloudDownloadIcon
                      className="size-[22px] shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <FileMusicIcon
                      className={cn(
                        "size-[22px] shrink-0",
                        index % 2 === 0 ? "text-brand-yellow" : "text-brand",
                      )}
                      aria-hidden="true"
                    />
                  )}
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[17px] font-bold">{score.name}</span>
                    {waiting && (
                      <span className="flex items-center gap-1 truncate text-sm text-muted-foreground">
                        <CloudIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        {fetching ? "Downloading…" : "Waiting for download"}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
