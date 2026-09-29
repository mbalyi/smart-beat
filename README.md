# Smart Beat

A modern, cross-platform tablature editor in the spirit of Guitar Pro 5, with optional **self-hosted AI** that turns a hummed melody into drums, bass, piano and guitar parts. Runs on macOS (Apple Silicon and Intel), Windows and Linux.

> **Status:** early preview. This repository currently contains the app shell (native window, menu bar and UI foundation), CI/CD and the licensing policy. The roadmap lives in the [project board](https://github.com/users/mbalyi/projects/3) and in [`high-level-plan.md`](high-level-plan.md).

## Tech stack

| Layer                     | Technology                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop shell ("backend") | [Tauri 2](https://v2.tauri.app) in Rust ([`src-tauri/`](src-tauri)): native window, menu bar, IPC commands                                        |
| UI                        | React 19 + TypeScript, [Vite](https://vite.dev), [Tailwind CSS 4](https://tailwindcss.com), [shadcn/ui](https://ui.shadcn.com) (Radix primitives) |
| Tests                     | Vitest + Testing Library + axe-core (UI), Playwright + axe (browser integration), `cargo test` with `tauri::test` (Rust)                          |
| Quality                   | ESLint (typescript-eslint, React Hooks, jsx-a11y), Prettier, rustfmt, clippy, cargo-deny                                                          |

## Prerequisites

Install these once per machine.

|                 | macOS                                                                                       | Windows                                                                                                                                                               | Linux (Debian/Ubuntu)                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24      | `nvm install` (uses [`.nvmrc`](.nvmrc))                                                     | [nodejs.org](https://nodejs.org) or `nvm-windows`                                                                                                                     | `nvm install`                                                                                                                           |
| pnpm            | `corepack enable`                                                                           | `corepack enable`                                                                                                                                                     | `corepack enable`                                                                                                                       |
| Rust (stable)   | [rustup](https://rustup.rs)                                                                 | [rustup](https://rustup.rs) (MSVC toolchain)                                                                                                                          | [rustup](https://rustup.rs)                                                                                                             |
| System          | Xcode or Xcode Command Line Tools (`xcode-select --install`)                                | [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) ("Desktop development with C++") and WebView2 (preinstalled on Windows 10/11) | `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` |
| License tooling | `cargo install cargo-about --locked --features cli` and `cargo install cargo-deny --locked` | same                                                                                                                                                                  | same                                                                                                                                    |

Optional: to build the universal (Apple Silicon + Intel) macOS app, run `rustup target add x86_64-apple-darwin aarch64-apple-darwin`.

Check your setup with `pnpm tauri info`.

## Getting started

```bash
corepack enable
pnpm install
pnpm tauri dev      # desktop app with hot reload
```

`pnpm dev` runs only the UI in a browser at http://localhost:1420. Native features (menu, About details) show a friendly "desktop app only" message there.

## Scripts

| Command                                                | What it does                                                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm tauri dev`                                       | Run the desktop app in development mode                                                                                                               |
| `pnpm tauri build`                                     | Build installers for the current OS (see [Packaging](#packaging))                                                                                     |
| `pnpm lint` / `pnpm format` / `pnpm format:check`      | ESLint / Prettier                                                                                                                                     |
| `pnpm typecheck`                                       | TypeScript project check                                                                                                                              |
| `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` | Vitest unit and integration tests (UI)                                                                                                                |
| `pnpm test:e2e`                                        | Playwright browser integration tests (Chromium and WebKit, a11y and responsive checks). Run `pnpm exec playwright install chromium webkit` once first |
| `pnpm rust:test` / `pnpm rust:lint` / `pnpm rust:fmt`  | Rust tests, clippy (`-D warnings`), rustfmt check                                                                                                     |
| `pnpm licenses:check`                                  | Enforce the license policy for npm packages and Rust crates                                                                                           |
| `pnpm licenses:generate`                               | Regenerate `public/third-party-licenses.txt` (runs automatically before `tauri build`)                                                                |
| `pnpm check`                                           | Everything CI runs, except Playwright and the license gate                                                                                            |

## Testing

| Layer               | Where                                                      | Tool                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI unit             | `src/**/*.test.ts(x)` next to the code                     | Vitest, Testing Library, axe-core                                                                                                                                                                                                 |
| UI integration      | [`src/App.test.tsx`](src/App.test.tsx)                     | Vitest with `@tauri-apps/api/mocks`: the whole UI plus a mocked Rust IPC (commands and menu events)                                                                                                                               |
| Browser integration | [`e2e/`](e2e)                                              | Playwright in Chromium (≈ WebView2 on Windows) and WebKit (≈ WKWebView on macOS, WebKitGTK on Linux): WCAG 2.2 AA scans in light and dark mode, keyboard navigation, focus management, reduced motion, layouts at 375/768/1280 px |
| Rust unit           | `#[cfg(test)]` modules in [`src-tauri/src`](src-tauri/src) | `cargo test`                                                                                                                                                                                                                      |
| Rust integration    | [`src-tauri/tests/ipc.rs`](src-tauri/tests/ipc.rs)         | `tauri::test` mock runtime: real command wiring over IPC and menu routing                                                                                                                                                         |

The frontend fixtures in [`src/test/tauri.ts`](src/test/tauri.ts) mirror the JSON returned by the Rust commands. The Rust integration tests assert the same shape.

## Packaging

```bash
pnpm tauri build                                   # installers for the current OS
pnpm tauri build --target universal-apple-darwin   # macOS: one app for Apple Silicon + Intel
```

Output lands in `src-tauri/target/<target>/release/bundle/`:

| OS      | Artifacts                                                     |
| ------- | ------------------------------------------------------------- |
| macOS   | `macos/Smart Beat.app`, `dmg/Smart Beat_<version>_<arch>.dmg` |
| Windows | `msi/*.msi`, `nsis/*-setup.exe`                               |
| Linux   | `appimage/*.AppImage`, `deb/*.deb`, `rpm/*.rpm`               |

Local macOS builds are ad-hoc signed. See [`docs/code-signing.md`](docs/code-signing.md) for signing and notarization.

## Project layout

```
src/                 React UI
  components/        App components (+ ui/ generated by shadcn)
  hooks/ providers/  Theme, menu-action and data-loading hooks
  lib/tauri.ts       Typed bridge to the Rust commands and events
  test/              Test setup, IPC mocks, axe helper
src-tauri/           Rust core
  src/menu.rs        Native menu bar and shortcut formatting
  src/commands.rs    IPC commands (app_info, menu_shortcuts)
  src/zoom.rs        View → Zoom levels
  tests/ipc.rs       Integration tests on the Tauri mock runtime
e2e/                 Playwright tests
scripts/             License check and notice generation
docs/                Licensing, code signing, ADRs
.github/workflows/   CI (every PR) and Release (installers)
```

### How the UI talks to Rust

- **Commands** (`invoke`): the UI calls `app_info` and `menu_shortcuts`, defined in `src-tauri/src/commands.rs` and wrapped with types in `src/lib/tauri.ts`.
- **Menu events:** clicking a native menu item goes to `menu::handle_event`. Window actions (zoom, full screen, close, quit) are handled in Rust. Everything else is emitted as a `menu-action` event, which the UI handles in `useMenuActions`.

## CI/CD

- **[CI](.github/workflows/ci.yml)** runs on every PR and every push to `main`:
  - lint, format, types, Vitest with coverage, and Playwright;
  - Rust fmt, clippy and tests, plus an app compile on **macOS, Windows and Linux**;
  - the license policy (npm and cargo-deny, including advisories).
- **[Release](.github/workflows/release.yml)** builds `.dmg` (universal), `.msi` and `.exe`, and `.AppImage`, `.deb` and `.rpm` installers. Push a tag matching `package.json` (e.g. `git tag v0.1.0 && git push origin v0.1.0`) to create a draft GitHub Release, or run it manually to get the installers as workflow artifacts.

## Licensing

Smart Beat is **proprietary freeware**: see [`LICENSE`](LICENSE) and the draft [`EULA.md`](EULA.md). We only use dependencies whose licenses allow closed-source distribution, and CI enforces this.

- [`docs/licensing.md`](docs/licensing.md): the component review, obligations, and the list of projects we must not copy code from.
- [ADR 0001](docs/adr/0001-project-license.md): why we chose this license.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).
