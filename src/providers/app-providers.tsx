import type { ReactNode } from "react";

import { TourProvider } from "@/components/tour/tour-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/providers/theme-provider";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={400}>
        <TourProvider>{children}</TourProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
