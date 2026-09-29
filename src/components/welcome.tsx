import { FolderOpenIcon, KeyboardIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FEATURES } from "@/components/welcome-features";

export function Welcome({
  onOpenFile,
  onShowShortcuts,
}: {
  onOpenFile: () => void;
  onShowShortcuts: () => void;
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
          <Button size="lg" variant="outline" onClick={onShowShortcuts}>
            <KeyboardIcon data-icon="inline-start" />
            Keyboard shortcuts
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Opens Guitar Pro 3–8 files (.gp3, .gp4, .gp5, .gpx, .gp). You can also drop a file
          anywhere in this window.
        </p>
      </section>

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
