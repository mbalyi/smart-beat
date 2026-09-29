import { AppLogo } from "@/components/app-logo";
import type { AppDialogProps } from "@/components/app-dialogs";
import { AsyncContent } from "@/components/async-content";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePromise } from "@/hooks/use-promise";
import { errorText } from "@/lib/errors";
import { describePlatform, getAppInfo } from "@/lib/tauri";

function AppDetails() {
  const state = usePromise(getAppInfo);

  return (
    <AsyncContent
      state={state}
      loadingLabel="Loading version details…"
      errorMessage={(error) => `Version details are unavailable. ${errorText(error)}`}
    >
      {(info) => (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-medium tabular-nums">{info.version}</dd>
          <dt className="text-muted-foreground">Platform</dt>
          <dd className="font-medium">{describePlatform(info)}</dd>
          <dt className="text-muted-foreground">Tauri</dt>
          <dd className="font-medium tabular-nums">{info.tauriVersion}</dd>
        </dl>
      )}
    </AsyncContent>
  );
}

export function AboutDialog({ open, onOpenChange, onCloseAutoFocus }: AppDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader className="items-center text-center">
          <AppLogo className="size-16" />
          <DialogTitle className="text-lg">Smart Beat</DialogTitle>
          <DialogDescription>Tablature editor with self-hosted AI accompaniment.</DialogDescription>
        </DialogHeader>
        <AppDetails />
        <DialogFooter showCloseButton>
          <p className="mr-auto self-center text-xs text-muted-foreground">
            © {new Date().getFullYear()} Smart Beat. All rights reserved.
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
