import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import path from "node:path";
import { alphaTab } from "@coderline/alphatab-vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

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

/**
 * The crash-report DSN of the UI's Sentry project (docs/crash-reports.md), as
 * `import.meta.env.VITE_SENTRY_DSN_FRONTEND`. It is a build-time value, never stored in the
 * repository. Order: the real environment (the release pipeline sets
 * SMART_BEAT_SENTRY_DSN_FRONTEND from a repository secret), the git-ignored `.env` of this
 * checkout, and in a linked git worktree the `.env` of the main checkout (as src-tauri/build.rs
 * does for the Rust side). Without a value nothing is defined and the UI side is a no-op.
 */
function sentryDsnFrontend(): Record<string, string> {
  const root = import.meta.dirname;
  const dirs = [root];
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const main = path.dirname(common);
    if (main !== root) dirs.push(main);
  } catch {
    // Not a git checkout (a source archive): only this directory's .env counts.
  }
  const dsn =
    process.env.SMART_BEAT_SENTRY_DSN_FRONTEND ||
    process.env.VITE_SENTRY_DSN_FRONTEND ||
    dirs
      .map((dir) =>
        loadEnv(process.env.NODE_ENV ?? "development", dir, [
          "SMART_BEAT_SENTRY_DSN_",
          "VITE_SENTRY_DSN_",
        ]),
      )
      .map((env) => env.SMART_BEAT_SENTRY_DSN_FRONTEND || env.VITE_SENTRY_DSN_FRONTEND)
      .find(Boolean);
  return dsn ? { "import.meta.env.VITE_SENTRY_DSN_FRONTEND": JSON.stringify(dsn) } : {};
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
  // Unit tests must not see a developer's real DSN: they set the value themselves.
  define: process.env.VITEST ? {} : sentryDsnFrontend(),
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri uses WebView2 on Windows (Chromium) and WebKit on macOS/Linux.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
