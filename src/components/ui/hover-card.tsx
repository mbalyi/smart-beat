import * as React from "react";
import { cn } from "cn";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

/**
 * A card that opens on hover and on keyboard focus and, unlike a tooltip, stays open while the
 * pointer moves into it: it can hold a link. It closes a moment after the pointer left both the
 * trigger and the card.
 */
function HoverCard({
  openDelay = 80,
  closeDelay = 250,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={closeDelay} {...props} />;
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

function HoverCardContent({
  className,
  align = "start",
  sideOffset = 10,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border bg-popover p-4 text-popover-foreground shadow-[0_16px_40px_rgb(0_0_0/0.42)] outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
