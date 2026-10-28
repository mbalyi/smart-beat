import { CloudIcon, MicIcon, ShieldCheckIcon, type LucideIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import settingsTitle from "@/assets/settings/settings-title.webp";
import type { AppDialogProps } from "@/components/app-dialogs";
import { AsyncContent } from "@/components/async-content";
import { DIALOG_NEON, DialogArt, DialogLogo } from "@/components/ai/dialog-art";
import { CloudAccounts } from "@/components/cloud-accounts";
import { AudioInputSetting } from "@/components/audio-input-setting";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
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
      <p className="text-sm text-muted-foreground">
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

export type SettingsSection = "audio" | "cloud" | "privacy";

/** The frame of the dialog: the neon ring and a height that never jumps between sections. */
const SETTINGS_FRAME = `${DIALOG_NEON} h-[min(46rem,calc(100dvh-2rem))] sm:max-w-3xl`;

export function SettingsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  section = null,
}: AppDialogProps & {
  /** The section to scroll to and focus when the dialog opens (Help › Cloud Storage Settings…). */
  section?: SettingsSection | null;
}) {
  const sections = useRef<Partial<Record<SettingsSection, HTMLElement | null>>>({});
  const desktop = isTauri();
  const register = (id: SettingsSection, node: HTMLElement | null) => {
    sections.current[id] = node;
  };

  const focusSection = (event: Event) => {
    const target = section ? sections.current[section] : null;
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={focusSection}
        size="xl"
        className={SETTINGS_FRAME}
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col">
          <DialogArt name="settings" />
          <DialogHeader className="gap-3 px-6 pt-3 md:px-9">
            <DialogLogo src={settingsTitle} testId="settings-title-art" />
            <DialogTitle className="sr-only">Settings</DialogTitle>
            <DialogDescription className="text-base">
              Choose your audio input, connect your cloud storage and decide what you share.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="gap-3 px-6 pb-4 md:px-9">
            {open && (
              <>
                <SettingsCard
                  id="audio"
                  title="Audio input"
                  icon={MicIcon}
                  register={register}
                  testId="settings-audio"
                >
                  <AudioInputSetting />
                </SettingsCard>
                {desktop && (
                  <SettingsCard
                    id="cloud"
                    title="Cloud storage"
                    icon={CloudIcon}
                    register={register}
                    testId="settings-cloud"
                  >
                    <LoadedCloudFolder />
                    <div className="border-t pt-4">
                      <CloudAccounts />
                    </div>
                  </SettingsCard>
                )}
                <SettingsCard
                  id="privacy"
                  title="Privacy and usage statistics"
                  icon={ShieldCheckIcon}
                  register={register}
                  testId="settings-privacy"
                >
                  <LoadedSettings />
                </SettingsCard>
              </>
            )}
          </DialogBody>
          <DialogFooter className="mt-0 flex-row justify-end border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="lg" className="min-w-28 bg-card">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One group of settings as a card. The card can take focus so a menu item can point at it. */
function SettingsCard({
  id,
  title,
  icon: Icon,
  register,
  testId,
  children,
}: {
  id: SettingsSection;
  title: string;
  icon: LucideIcon;
  register: (id: SettingsSection, node: HTMLElement | null) => void;
  testId: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      ref={(node) => register(id, node)}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-testid={testId}
      className="flex shrink-0 flex-col gap-4 rounded-xl border bg-card/90 p-4 outline-none focus-visible:ring-2 focus-visible:ring-primary/70 dark:bg-card/85"
    >
      <h3 id={headingId} className="flex items-center gap-2 text-base font-semibold">
        <Icon aria-hidden="true" className="size-5 shrink-0 text-primary" />
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
