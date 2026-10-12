# ADR 0002: Smart Beat is source-available under PolyForm Noncommercial 1.0.0

- **Status:** Accepted (lawyer review pending). Confirmed for the public release on 2026-10-12 (#97).
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
3. The released installers stay free to download and are covered by the freeware [`EULA.md`](../../EULA.md). The EULA is a separate grant for the binary; it does not widen the source licence.
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

## Alternatives considered

Reviewed again for the public release ([#97](https://github.com/mbalyi/smart-beat/issues/97)).

- **MIT, Apache-2.0 or BSD.** Rejected: anyone could sell Smart Beat, wrap it, or use it inside a company without asking, which is exactly what the owner wants to keep under a paid licence.
- **GPL-3.0 or AGPL-3.0.** Rejected. Copyleft forces modified versions to stay open, but it still allows selling and commercial use, so it does not protect commercial rights. It would also make the commercial dual licence harder, because every outside contribution would arrive under the GPL.
- **Business Source License (BSL).** Rejected for now. It turns into an open-source licence after a set date, and its "additional use grant" would need custom wording.
- **PolyForm Strict 1.0.0, or a custom "no modification" licence.** Considered because the owner's first wording was "any modification or reuse needs permission". Rejected on 2026-10-12 in favour of the noncommercial model: people may study, change and share Smart Beat for noncommercial purposes, and only commercial use needs a paid licence. A custom licence would also be harder to read and to enforce than a standard, published one.
- **PolyForm Noncommercial 1.0.0.** Chosen. It is a published, lawyer-written licence, used unmodified, so readers can rely on its standard meaning.

## How the documents fit together

| Layer                        | Document                                                                                         | Who it binds                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Source code                  | [`LICENSE`](../../LICENSE) (PolyForm Noncommercial 1.0.0, unmodified official text)              | Anyone who uses the code                           |
| Commercial use               | [`COMMERCIAL-LICENSE.md`](../../COMMERCIAL-LICENSE.md): what counts as commercial and how to ask | Companies and anyone earning money with Smart Beat |
| The released app             | [`EULA.md`](../../EULA.md)                                                                       | Anyone who installs an official installer          |
| Third-party code and content | Help › Open-Source Licenses, [`docs/licensing.md`](../licensing.md)                              | Each component under its own licence               |
| AI models                    | Each model's licence, shown before download                                                      | Model users                                        |
| Contributions                | [`CONTRIBUTING.md`](../../CONTRIBUTING.md)                                                       | Contributors                                       |

If two of these ever disagree, `LICENSE` wins for the source code, the EULA wins for the official app, and a third-party licence wins for its own component.

**Commercial licences** are agreed one by one by email (smart-beat@outlook.com). The owner can grant them because the owner holds the copyright in Smart Beat's own code, and contributors give the owner the right to relicense their contributions (point 4 above). Third-party components keep their own licences in a commercial licence too.

## Still open (not done by this change)

- Lawyer review of this licence setup, the EULA and the commercial licence wording, before paid commercial licences are offered ([`docs/licensing.md`](../licensing.md#legal-review)).
- Done for #97: the secret scan of the repository and its full git history (2026-10-12, gitleaks, no secrets found; CI now repeats it on every PR).
- Re-running the third-party licence audit (`pnpm licenses:check`) right before the switch to public.

_This is an engineering decision record, not legal advice._
