# ADR 0004: Smart Beat is for personal use, learning and research only

- **Status:** Accepted (lawyer review pending).
- **Date:** 2026-11-03
- **Supersedes in part:** [ADR 0002](0002-source-available-noncommercial-license.md), the parts that keep a paid commercial route open (decision points 2 and 5, and the commercial-licence row of the document table). Everything else in ADR 0002 stays.

## Context

ADR 0002 chose PolyForm Noncommercial 1.0.0 for the source and kept the door open for selling Smart Beat or licensing it commercially: commercial licences by email, an EULA that allowed professional use, and dependency rules (including "AI model weights must allow commercial use") written so a commercial release stayed possible.

The owner now says (2026-11-03): Smart Beat is for the owner's own use, research and learning; there is no plan to sell it or earn money with it, and commercial use is excluded. The owner wants to keep PolyForm.

## Decision

1. **The licence does not change.** The source stays under the unmodified PolyForm Noncommercial License 1.0.0 ([`LICENSE`](../../LICENSE)). It already excludes commercial use and allows personal use, study, hobby projects and research.
2. **Commercial use is not offered.** There is no commercial licence, price list or application form. [`NONCOMMERCIAL-USE.md`](../../NONCOMMERCIAL-USE.md) (the former `COMMERCIAL-LICENSE.md`) says what is allowed and what is not. The owner, as copyright holder, keeps the right to change this later; nothing promises it, and nobody is owed an answer.
3. **The EULA** ([`EULA.md`](../../EULA.md), version 1.1) now grants use for personal use, learning and research only, and excludes business use, paid services, use inside a company and earning money with the app. What users create with the app stays theirs, and the EULA does not restrict what they do with their own music. The separate MuScriptor "non-commercial only" exception became redundant and was folded into the general rule for AI models.
4. **Dependency rules.**
   - Rules for **code** stay: permissive licences and MPL-2.0 are allowed, LGPL only as a separate replaceable component, no GPL, AGPL or SSPL, and no code copied from GPL/LGPL projects. They cost nothing to keep and a strong-copyleft library would clash with PolyForm anyway. CI keeps enforcing them (`cargo deny`, `scripts/check-licenses.mjs`).
   - Rule for **AI model weights** is relaxed: weights must allow noncommercial use, must not be bundled into installers, and each model is accepted individually by the owner, with the risk recorded in [`docs/licensing.md`](../licensing.md). Weights that are limited to noncommercial or educational use (for example MuScriptor, models trained on MUSDB18-HQ) fit the project's purpose. The open question whether the project may **redistribute** weights with no stated licence is not changed by this decision.
5. **Contributions** keep the relicensing right in [`CONTRIBUTING.md`](../../CONTRIBUTING.md), for flexibility, but no document advertises commercial licensing any more.

## Consequences

- No document promises a paid tier, a commercial licence or a commercial EULA. The "paid tier" columns in [`docs/licensing.md`](../licensing.md) are marked not applicable while the project stays noncommercial and are kept in case that changes.
- Someone who asks for commercial use gets no standard answer; the owner decides, and may say no.
- A musician who uses Smart Beat only for personal practice, learning or research is covered; paid lessons, studio work or any business use that relies on the app is not.
- The legal review listed in [`docs/licensing.md`](../licensing.md#legal-review) is less urgent, because no paid offer is planned, but is still open.

_This is an engineering decision record, not legal advice._
