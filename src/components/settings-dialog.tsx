import { useId, useState, type ReactNode } from "react";

import type { AppDialogProps } from "@/components/app-dialogs";
import { AsyncContent } from "@/components/async-content";
import { CloudAccounts } from "@/components/cloud-accounts";
import { AudioInputSetting } from "@/components/audio-input-setting";
import { Button } from "@/components/ui/button";
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
import {
  detectCloudFolders,
  getCloudFolder,
  isTauri,
  pickCloudFolder,
  setCloudFolder,
  type CloudFolderCandidate,
} from "@/lib/tauri";
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
          <DialogDescription>Audio input, privacy and usage statistics.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {open && (
            <div className="flex flex-col gap-6">
              <SettingsSection title="Audio">
                <AudioInputSetting />
              </SettingsSection>
              {isTauri() && (
                <SettingsSection title="Cloud folder">
                  <LoadedCloudFolder />
                  <div className="mt-4">
                    <CloudAccounts />
                  </div>
                </SettingsSection>
              )}
              <SettingsSection title="Privacy">
                <LoadedSettings />
              </SettingsSection>
            </div>
          )}
        </DialogBody>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3
        id={id}
        className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </h3>
      {children}
    </section>
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

async function loadCloudFolder() {
  const [folder, candidates] = await Promise.all([getCloudFolder(), detectCloudFolders()]);
  return { folder, candidates };
}

function LoadedCloudFolder() {
  const state = usePromise(loadCloudFolder);
  return (
    <AsyncContent
      state={state}
      loadingLabel="Loading cloud folder…"
      errorMessage={(error) => `The cloud folder is unavailable. ${errorText(error)}`}
    >
      {({ folder, candidates }) => <CloudFolderSetting initial={folder} candidates={candidates} />}
    </AsyncContent>
  );
}

function CloudFolderSetting({
  initial,
  candidates,
}: {
  initial: string | null;
  candidates: CloudFolderCandidate[];
}) {
  const [folder, setFolder] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  // Folder paths stay on this computer: nothing here is reported to usage statistics.
  const link = async (next: string | null) => {
    setError(null);
    try {
      setFolder(await setCloudFolder(next));
    } catch (e) {
      setError(`The cloud folder could not be saved. ${errorText(e)}`);
    }
  };

  const choose = async () => {
    setError(null);
    try {
      const picked = await pickCloudFolder();
      if (picked) await link(picked);
    } catch (e) {
      setError(`The folder could not be chosen. ${errorText(e)}`);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Link a folder that your cloud service already syncs (iCloud Drive, Dropbox, OneDrive, Google
        Drive) to keep your songs on all your computers.
      </p>
      <p className="text-sm" data-testid="cloud-folder-current">
        {folder ? (
          <>
            <span className="font-medium">Linked folder: </span>
            <span className="break-all">{folder}</span>
          </>
        ) : (
          "No folder linked."
        )}
      </p>
      {candidates.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {candidates.map((candidate) => (
            <Button
              key={candidate.path}
              type="button"
              variant="outline"
              size="sm"
              title={candidate.path}
              onClick={() => void link(candidate.path)}
            >
              Use {candidate.provider}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void choose()}>
          Choose folder…
        </Button>
        {folder && (
          <Button type="button" variant="outline" size="sm" onClick={() => void link(null)}>
            Unlink
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
