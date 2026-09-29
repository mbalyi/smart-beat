import { useState } from "react";
import { toast } from "sonner";

import { AppDialogs, type AppDialog } from "@/components/app-dialogs";
import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";
import { SkipLink } from "@/components/skip-link";
import { Toaster } from "@/components/ui/sonner";
import { Welcome } from "@/components/welcome";
import { useMenuActions } from "@/hooks/use-menu-actions";
import { useTheme } from "@/hooks/use-theme";

export function App() {
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const { toggleTheme } = useTheme();

  const showDialog = (next: AppDialog, returnFocusTo: HTMLElement | null = null) => {
    setReturnFocusTo(returnFocusTo);
    setDialog(next);
  };

  const openFile = () => {
    toast.info("Opening files is coming soon", {
      description: "Guitar Pro (GP3–GP7) import is planned for an upcoming release.",
    });
  };

  useMenuActions((action) => {
    switch (action) {
      case "open":
        openFile();
        break;
      case "toggle-theme":
        toggleTheme();
        break;
      case "about":
      case "shortcuts":
      case "licenses":
        showDialog(action);
        break;
      default:
        // Window actions (zoom, full screen, quit) are handled natively.
        break;
    }
  });

  return (
    <>
      <SkipLink />
      <div className="flex min-h-svh flex-col">
        <AppHeader onShowDialog={showDialog} />
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          <Welcome onOpenFile={openFile} onShowShortcuts={() => showDialog("shortcuts")} />
        </main>
        <AppFooter />
      </div>
      <AppDialogs open={dialog} onOpenChange={setDialog} returnFocusTo={returnFocusTo} />
      <Toaster position="bottom-right" />
    </>
  );
}
