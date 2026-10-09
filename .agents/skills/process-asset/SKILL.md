---
name: process-asset
description: Prepare a logo/wordmark/animation for Smart Beat (transparent background, alpha check) and wire it into the header and startup splash.
---

Reply in English.

1. Inspect the asset (`file`, `ffprobe` for video, view images). Images may arrive inline only; search Downloads for a file copy.
2. If the image should be transparent and is not, remove the background, then verify by measuring alpha directly and by compositing on a solid colour and viewing it. Dark outlines are not checker leftovers; do not erase them.
3. Put optimised copies under `public/` or `src/assets` (keep sizes small; prefer webm/mp4 or a short gif for animation).
4. Wire in: replace the text title in the header with the wordmark (keep an accessible name via `alt`/`aria-label`); show the animation as a startup splash matching its background colour, held for one full loop, marked `inert`, and respecting `prefers-reduced-motion`.
5. Update tests that asserted the old title text, then run `ui-visual-check`.
