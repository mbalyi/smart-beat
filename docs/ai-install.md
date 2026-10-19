# The AI installer (MuScriptor)

Record to tab (AI tab) and Import from Audio use the same optional model, MuScriptor
([`audio-to-midi.md`](audio-to-midi.md)). Neither dialog downloads anything itself. When the
model is missing they show a **Download MuScriptor** button that hands over to one installer:

1. The asking dialog closes and the installer opens (`openInstaller("record" | "audio")` in
   `src/lib/ai/ai-store.ts`). It remembers who asked.
2. Five steps in a frame of fixed size, with the close button and the footer buttons (Back,
   the primary action, Close) always in the same place: **Powered by MuScriptor**, **Models and
   performance** (the size picker), **Register and accept the terms** (a link to the official
   model card, then two checkboxes: the weight terms accepted, and "I only use music I have the
   rights to"), **Downloading**, and **Everything is set up**.
3. Rust records the acceptance (`terms.json` in the model folder, with the terms version) only
   when the rights box was ticked. Download and transcription both refuse to run without it, so
   the dialogs are not the only gate.
4. When the installer closes (also when it is cancelled), the asking dialog reopens: the
   workspace that is on screen for Record to tab, the app for Import from Audio.

Analytics (counters only, [analytics.md](analytics.md)): `ai_install` (the size), `ai_rights_confirmed`,
and `ai_transcribe_start` / `ai_transcribe_file` at every AI start with `rights_confirmed` or
`rights_unconfirmed`.

Feature flags (`src/lib/features.json`): `audio-2-tab` for Import from Audio and
`muscriptor-record` for the AI tab of Record to tab.

## Building the engine

`src-tauri/build.rs` builds `src-tauri/native` (the vendored muscriptor.cpp, MIT, plus a small C
wrapper) with CMake 3.24 or newer and a C++23 compiler. ggml is fetched by CMake at the commit
pinned in `native/muscriptor/CMakeLists.txt`, so the first build needs git and network access.
Metal shaders (macOS) are compiled at run time, so no extra file ships. The installer for each
platform must be built on that platform. Windows builds use CPU, and Vulkan only when the SDK is
found at build time; they are untested so far.
