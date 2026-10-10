import { useId, useState } from "react";

import type { AppDialogProps } from "@/components/app-dialogs";
import { AsyncContent } from "@/components/async-content";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { usePromise } from "@/hooks/use-promise";
import { errorText } from "@/lib/errors";
import { getUsageSettings, setUsageSettings, type UsageSettings } from "@/lib/telemetry";

function UsageSetting({ initial }: { initial: UsageSettings | null }) {
  const switchId = useId();
  const descriptionId = useId();
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [error, setError] = useState<string | null>(null);

  if (!initial?.available) {
    return (
      <p className="text-muted-foreground">
        This version of Smart Beat does not collect any usage statistics.
      </p>
    );
  }

  const change = async (next: boolean) => {
    setEnabled(next);
    setError(null);
    try {
      await setUsageSettings({ enabled: next });
    } catch (e) {
      setEnabled(!next);
      setError(`The setting could not be saved. ${errorText(e)}`);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <label htmlFor={switchId} className="font-medium">
          Share anonymous usage counts
        </label>
        <Switch
          id={switchId}
          checked={enabled}
          onCheckedChange={(next) => void change(next)}
          aria-describedby={descriptionId}
        />
      </div>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        Smart Beat counts how often features such as Loop, Metronome, Count-in or Export are used,
        per day, with the app version, your operating system and the installer type. There is no
        identifier, so the counts cannot be tied to you or your computer. Songs, file names, sound
        names and anything you type are never sent. Switching this off also deletes counts that have
        not been sent yet.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange, onCloseAutoFocus }: AppDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Privacy and usage statistics.</DialogDescription>
        </DialogHeader>
        <DialogBody>{open && <LoadedSettings />}</DialogBody>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function LoadedSettings() {
  const state = usePromise(getUsageSettings);
  return (
    <AsyncContent
      state={state}
      loadingLabel="Loading settings…"
      errorMessage={(error) => `Settings are unavailable. ${errorText(error)}`}
    >
      {(settings) => <UsageSetting initial={settings} />}
    </AsyncContent>
  );
}
