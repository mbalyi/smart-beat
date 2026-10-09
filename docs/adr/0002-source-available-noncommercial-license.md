# ADR 0002: Smart Beat is source-available under PolyForm Noncommercial 1.0.0

- **Status:** Accepted (lawyer review pending)
- **Date:** 2026-10-08
- **Issue:** [#82](https://github.com/mbalyi/smart-beat/issues/82)
- **Supersedes:** [ADR 0001](0001-project-license.md) (proprietary freeware)

## Context

ADR 0001 kept the source closed. Issue #82 prepares a public repository and GitHub Releases as the one place to download the app. The owner's requirement:

- people may use the code for **personal use and research**;
- people who want to **sell it, use it inside a company, or wrap it in another product** must ask for permission or pay.

## Decision

1. The source code is licensed under the **[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)** ([`LICENSE`](../../LICENSE)). It permits personal, hobby, educational and research use, and use by charities, schools, public research bodies and government institutions. It does not permit use for commercial advantage, which covers selling, wrapping, paid services and a company using the software for its business.
2. Commercial use needs a separate agreement. [`COMMERCIAL-LICENSE.md`](../../COMMERCIAL-LICENSE.md) says what counts as commercial and how to ask.
3. The released installers stay free to download and are covered by the freeware [`EULA.md`](../../EULA.md) (still a draft). The EULA is a separate grant for the binary; it does not widen the source licence.
4. Pull requests, suggestions and ideas are welcome, on the terms in [`CONTRIBUTING.md`](../../CONTRIBUTING.md): contributing gives nobody a right to reuse the product or a stake in it, and the contributor grants the owner a perpetual, irrevocable right to use and relicense the contribution (including commercially). Those terms are a draft until a lawyer has reviewed them.
5. **The dependency rules from ADR 0001 stay in force**, because the owner may ship Smart Beat commercially under other terms:
   - permissive licenses (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode, CC0, OFL for fonts) and MPL-2.0 are allowed;
   - LGPL only as a separate, replaceable component, never statically linked or bundled into our JavaScript;
   - GPL, AGPL, SSPL and any other strong copyleft are not allowed;
   - AI model weights must allow commercial use;
   - we never copy or port code from GPL/LGPL projects (MuseScore, TuxGuitar, PyGuitarPro).
     CI keeps enforcing this (`cargo deny`, `scripts/check-licenses.mjs`).

## Consequences

- The repository can be made public without giving away commercial rights.
- PolyForm Noncommercial is **source-available, not open source** (the Open Source Definition forbids field-of-use limits). The README and website must not call Smart Beat "open source".
- The licence does not define "commercial" itself. [`COMMERCIAL-LICENSE.md`](../../COMMERCIAL-LICENSE.md) states the owner's reading; a lawyer should confirm it, especially for "internal use inside a company".
- Anyone may share modified copies for noncommercial purposes if they pass on the licence terms. If that is not wanted, PolyForm Strict 1.0.0 is the stricter alternative.
- The contributor terms in `CONTRIBUTING.md` are the inbound licensing mechanism for now. Before accepting substantial external code, have a lawyer review them or replace them with a proper CLA.

## Still open (not done by this change)

- Lawyer review of this licence setup, the EULA and the commercial licence wording, before paid commercial licences are offered.
- A secret scan of the repository **and its git history** before it becomes public.
- Re-running the third-party licence audit (`pnpm licenses:check`) right before the switch to public.

_This is an engineering decision record, not legal advice._
