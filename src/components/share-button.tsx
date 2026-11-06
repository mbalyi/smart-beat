import { Share2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ShareTarget } from "@/lib/cloud-share";
import { cn } from "@/lib/utils";
import { useShare } from "@/providers/share-context";

/**
 * The share icon of a file row (#201): copies a link to the file, after asking which storage a
 * file on this computer goes to. A sibling of the row's own button, never inside it (a button
 * can't hold a button). Renders nothing where sharing is not available.
 */
export function ShareButton({ target, className }: { target: ShareTarget; className?: string }) {
  const share = useShare();
  if (!share) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      className={cn("shrink-0 rounded-full", className)}
      aria-label={`Share a link to ${target.name}`}
      title="Share a link"
      onClick={() => share(target)}
      data-testid="share-button"
    >
      <Share2Icon aria-hidden="true" />
    </Button>
  );
}
