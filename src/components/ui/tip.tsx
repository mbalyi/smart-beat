import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A tooltip for a control: shows on hover and on keyboard focus, and Escape
 * dismisses it. Used instead of the native `title`, which keyboard users never see.
 */
export function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Whether `children` contain text (also visually hidden text), which gives a control its name. */
export function hasText(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child).trim() !== "";
    if (isValidElement<{ children?: ReactNode }>(child)) return hasText(child.props.children);
    return false;
  });
}

/**
 * The name an icon-only control gets from its tooltip text: only when it has
 * no `aria-label` and no text of its own (native `title` used to supply it).
 */
export function nameFromTip(
  title: string | undefined,
  ariaLabel: string | undefined,
  children: ReactNode,
): string | undefined {
  if (ariaLabel !== undefined) return ariaLabel;
  return title && !hasText(children) ? title : undefined;
}
