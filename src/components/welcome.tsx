import { FileMusicIcon, FilePlusIcon, FolderOpenIcon, KeyboardIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FEATURES } from "@/components/welcome-features";
import { baseName } from "@/lib/score/format";

/** The folder a path is in ("Songs" for `/Users/me/Songs/riff.gp5`), to tell equal names apart. */
function folderOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2]! : "";
}

export function Welcome({
  onOpenFile,
  onNewSong,
  onShowShortcuts,
  recent = [],
  onOpenRecent,
}: {
  onOpenFile: () => void;
  onNewSong: () => void;
  onShowShortcuts: () => void;
  /** Recently opened songs (paths), most recent first. */
  recent?: string[];
  onOpenRecent?: (path: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-12 px-4 py-10 sm:px-6 sm:py-16 lg:px-8">
      <section aria-labelledby="welcome-title" className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Badge variant="secondary" className="w-fit">
            Early preview
          </Badge>
          <h1
            id="welcome-title"
            className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
          >
            Write, play and arrange guitar music
          </h1>
          <p className="max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">
            Smart Beat is a tablature editor for macOS, Windows and Linux, with optional self-hosted
            AI that turns a hummed melody into a full accompaniment.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button size="lg" onClick={onOpenFile}>
            <FolderOpenIcon data-icon="inline-start" />
            Open a file…
          </Button>
          <Button size="lg" variant="outline" onClick={onNewSong}>
            <FilePlusIcon data-icon="inline-start" />
            New song
          </Button>
          <Button size="lg" variant="outline" onClick={onShowShortcuts}>
            <KeyboardIcon data-icon="inline-start" />
            Keyboard shortcuts
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Opens Guitar Pro 3–8 files (.gp3, .gp4, .gp5, .gpx, .gp), MusicXML and MIDI files. You can
          also drop a file anywhere in this window.
        </p>
      </section>

      {recent.length > 0 && onOpenRecent && (
        <section aria-labelledby="recent-title" className="flex flex-col gap-3">
          <h2 id="recent-title" className="font-heading text-xl font-semibold">
            Recent songs
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {recent.map((path) => (
              <li key={path} className="min-w-0">
                <Button
                  variant="outline"
                  className="h-auto w-full min-w-0 justify-start gap-3 overflow-hidden px-3 py-2 text-left"
                  onClick={() => onOpenRecent(path)}
                  title={path}
                >
                  <FileMusicIcon data-icon="inline-start" aria-hidden="true" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{baseName(path)}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {folderOf(path)}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="roadmap-title" className="flex flex-col gap-4">
        <h2 id="roadmap-title" className="font-heading text-xl font-semibold">
          Features
        </h2>
        <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ title, description, Icon, badge }) => (
            <li key={title}>
              <Card className="h-full">
                <CardHeader className="gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden="true" />
                    </span>
                    <Badge variant="outline">{badge}</Badge>
                  </div>
                  <CardTitle>
                    <h3>{title}</h3>
                  </CardTitle>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
