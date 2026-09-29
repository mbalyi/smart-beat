import { cpSync } from "node:fs";
import path from "node:path";
import { alphaTab } from "@coderline/alphatab-vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Set by `tauri dev` when targeting a physical device on the local network.
const host = process.env.TAURI_DEV_HOST;

const ALPHATAB_DIST = path.resolve(import.meta.dirname, "node_modules/@coderline/alphatab/dist");

/**
 * Copies alphaTab's music font and Sonivox SoundFont to public/ (served at
 * /font/ and /soundfont/, gitignored). alphaTab's own plugin copies them at
 * `buildStart`, after the dev server has indexed public/, so on a fresh
 * checkout (CI) the dev server answered those URLs with index.html. The
 * `config` hook runs before that.
 */
function alphaTabAssets(): Plugin {
  return {
    name: "smart-beat:alphatab-assets",
    config() {
      for (const dir of ["font", "soundfont"]) {
        cpSync(path.join(ALPHATAB_DIST, dir), path.resolve(import.meta.dirname, "public", dir), {
          recursive: true,
        });
      }
    },
  };
}

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Unit tests mock alphaTab, so Vitest skips these.
    !process.env.VITEST && alphaTabAssets(),
    // Bundles alphaTab's worker and audio worklet (assets: see above).
    !process.env.VITEST && alphaTab({ assetOutputDir: false }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // Keep Rust errors visible in the terminal.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // The Rust side is rebuilt by the Tauri CLI, not Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri uses WebView2 on Windows (Chromium) and WebKit on macOS/Linux.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
