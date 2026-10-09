# ADR 0001: Smart Beat is proprietary freeware

- **Status:** Superseded by [ADR 0002](0002-source-available-noncommercial-license.md) (2026-10-08). The dependency rules in section 2 and 3 of the decision still apply.
- **Date:** 2026-09-29
- **Issue:** [#3](https://github.com/mbalyi/smart-beat/issues/3)

## Context

Smart Beat will be:

- **closed source**: the source code is not shared;
- **free to download** as a desktop app, without AI features;
- possibly **paid** for an AI tier: self-hosted accompaniment generation and chat assistant.

We still want to reuse as much open-source software as possible, especially the projects named in `high-level-plan.md`: alphaTab, PyGuitarPro, TuxGuitar, MuseScore and a range of AI models. Their licenses decide what we can use and how. The full component review is in [`docs/licensing.md`](../licensing.md).

## Decision

1. Smart Beat's own code is **proprietary, all rights reserved**. The details are in [`LICENSE`](../../LICENSE). End users get the free app under a freeware EULA ([`EULA.md`](../../EULA.md), draft pending legal review).
2. **We only depend on software whose license allows closed-source, commercial distribution:**
   - **Permissive licenses** (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode, CC0, OFL for fonts) are allowed.
   - **MPL-2.0** (for example alphaTab) is allowed. MPL copyleft applies per file, so we can link it into proprietary code. If we modify an MPL file, we must publish that file's source.
   - **LGPL** is allowed only as a separate, replaceable component: an unmodified library in the Python AI service (for example PyGuitarPro), or a dynamically linked system library. It is never statically linked into the Rust binary and never bundled into our JavaScript.
   - **GPL, AGPL, SSPL** and any other strong copyleft license are **not allowed**.
   - **AI model weights** must allow commercial use for the paid tier. Non-commercial or research-only weights (for example MusicGen, CC-BY-NC) are not allowed.
3. **We never copy or port source code** from GPL/LGPL projects (MuseScore, TuxGuitar, PyGuitarPro). Where we need their functionality, such as writing GP5 files, we implement it clean-room from public format documentation.
4. **We ship license notices** for everything we bundle. The build generates `public/third-party-licenses.txt`, and the app shows it under Help → Open-Source Licenses.
5. **CI enforces the policy:**
   - `cargo deny check licenses` for Rust crates;
   - `scripts/check-licenses.mjs` for npm packages.

## Consequences

- We can build on alphaTab (the planned rendering and playback engine) without opening our code.
- GP5 writing costs more because we can't port TuxGuitar or PyGuitarPro. PyGuitarPro can still be used unmodified in the Python AI service to read and write files on the server side.
- MuseScore can serve only as a behavioral reference (UX, engraving ideas). No code or assets may come from it.
- Every new dependency must pass the license gate. Adding an exception needs a review in `docs/licensing.md`.
- If the AI service is later offered as a hosted SaaS, GPL obligations still don't apply, but AGPL obligations would. That is why AGPL stays forbidden.

## Alternatives considered

| Option                       | Why not                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPL-2.0 open source          | Doesn't fit the decision not to share the source code.                                                                                            |
| Apache-2.0 / MIT open source | Same. It would also let competitors reuse the code freely.                                                                                        |
| GPL-3.0                      | Would allow porting MuseScore, TuxGuitar and PyGuitarPro code, but forces every distributed version, including a paid AI tier, to be open source. |

_This is an engineering decision record, not legal advice. Have a lawyer review the EULA and the obligations checklist before the first public release._
