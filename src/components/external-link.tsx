import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentProps } from "react";
import { toast } from "sonner";

import { errorText } from "@/lib/errors";
import { isTauri } from "@/lib/tauri";

/**
 * A link to a web page. In the desktop app the page opens in the system browser (a plain link
 * would replace the app's own window), and only the addresses allowed in the app's capability
 * open. In a browser it is an ordinary link in a new tab.
 */
export function ExternalLink({
  href,
  onClick,
  children,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !isTauri()) return;
        event.preventDefault();
        openUrl(href).catch((error: unknown) => {
          toast.error("Couldn't open the link", { description: errorText(error) });
        });
      }}
      {...props}
    >
      {children}
    </a>
  );
}
