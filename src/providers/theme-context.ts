import { createContext } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeContextValue {
  /** The user's choice. */
  theme: Theme;
  /** What is actually shown (`system` resolved against the OS setting). */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Switches between light and dark (used by View → Toggle Dark Mode). */
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);
