import { LayersIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatBytes, formatTime } from "@/components/stems/stem-labels";
import { SectionKicker } from "@/components/section-kicker";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { deleteStemSong, listStemSongs, type StemSong } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * "Your separated songs" on the start screen: the songs already separated on this computer,
 * which open on the page at once. Nothing is shown in a browser or while there are none.
 */
export function StemSongs({ onOpen }: { onOpen: (song: StemSong) => void }) {
  const [songs, setSongs] = useState<StemSong[]>([]);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    listStemSongs().then(
      (list) => alive && setSongs(list),
      // A browser has no library: the section just stays out.
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const remove = async (song: StemSong) => {
    setError("");
    try {
      await deleteStemSong(song.id);
      setSongs((list) => list.filter((item) => item.id !== song.id));
    } catch (cause) {
      setError(errorText(cause));
    }
    setAsking(null);
  };

  if (songs.length === 0) return null;
  return (
    <section aria-labelledby="stem-songs-title" className="flex flex-col gap-3">
      <SectionKicker as="h2" id="stem-songs-title">
        Your separated songs
      </SectionKicker>
      <ul className="grid gap-3 sm:grid-cols-2">
        {songs.map((song, index) => (
          <li
            key={song.id}
            className={cn(
              "flex min-h-[76px] min-w-0 items-center gap-2 overflow-hidden rounded-2xl border bg-card pr-2 transition-[border-color] duration-150 motion-reduce:transition-none",
              index % 2 === 0 ? "hover:border-brand-yellow/60" : "hover:border-brand/60",
            )}
          >
            <button
              type="button"
              onClick={() => onOpen(song)}
              className="flex min-w-0 flex-1 items-center gap-3.5 py-3 pl-4 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <LayersIcon
                aria-hidden="true"
                className={cn(
                  "size-[22px] shrink-0",
                  index % 2 === 0 ? "text-brand-yellow" : "text-brand",
                )}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[17px] font-bold">{song.name}</span>
                <span className="truncate text-sm text-muted-foreground">
                  {formatTime(song.durationSeconds)} · {song.stems.length} parts ·{" "}
                  {song.engine === "neural" ? "Neural" : "Fast"} · {formatBytes(song.bytes)}
                </span>
              </span>
            </button>
            {asking === song.id ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="destructive"
                  size="sm"
                  aria-label={`Delete the stems of ${song.name}`}
                  onClick={() => void remove(song)}
                >
                  Delete
                </Button>
                <Button variant="outline" size="sm" onClick={() => setAsking(null)}>
                  Keep
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label={`Delete ${song.name}`}
                onClick={() => setAsking(song.id)}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
