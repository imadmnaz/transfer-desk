# Review log

Every review of this project is recorded here: what was found, what I decided, and what changed.

**Method.** I drafted the documents and the rules and made every legal call. To catch my own blind spots, I used cross-model review: a separate model, from a different vendor to the one that wrote the code, reviewing adversarially with no access to the build. It reviewed the drafting, decided every scenario blind before seeing the expected answers, and wrote held-out test cases. Its findings are inputs, not decisions. Each one is triaged below as Accepted (right and material, so something changed), Rejected (wrong, or the behaviour is deliberate, with the test that proves it) or Deferred (right, but out of scope for this version).

## Round 1: drafting review

**Reviewer:** cross-model review, briefed to mark up the drafts as a senior associate at a US fund formation firm would mark up a junior's.
**Scope:** the three synthetic source documents, before any code was written.

| # | Finding | Decision | Change made |
|---|---|---|---|
| 1 | Harbour's side-letter permission does not clear the portfolio company's consent and first refusal requirements, and could mislead a reviewer. | Rejected as a defect | Deliberate. This mismatch between the fund-level and company-level definitions of permitted transferee is the central edge case the tool exists to catch. Tested by T19. |
| 2 | "Transfer" in the LPA includes a change of Control of a Limited Partner; the stockholders' agreement did not expressly cover a change of control. | Accepted | SA 1.1 "Indirect Transfer" now includes a change of control of a person whose principal asset is an interest in an Investment Vehicle. Change-of-control events are listed as a known limitation of the engine. |
| 3 | The stockholders' agreement's enforcement mechanism for indirect transfers was unclear, because LP interests are recorded in the Partnership's Register, not the Company's books. | Accepted | SA 6.1 now also requires each Investment Vehicle to refuse to register or give effect to a non-compliant Indirect Transfer. Together with LPA 8.4(e) and 8.5, the GP cannot record it. |
| 4 | The US$10,000 minimum holding could not be calculated after a partial transfer, because the LPA did not allocate Capital Contribution between the transferred and retained parts. | Accepted | LPA 8.3 now allocates Capital Contribution pro rata to the proportion transferred. The engine's calculation now cites that sentence. |
| 5 | Pledge treatment in the two documents does not line up cleanly. | Rejected as a defect | The documents are consistent: at grant of a pledge, GP consent, Company consent, the competitor bar and KYC and sanctions apply; adherence, tax form, owner count and accredited status wait for enforcement; first refusal applies to sales only. Tested by T26. |
| 6 | Company consent has no response deadline, unlike the first refusal. | Rejected as a defect; noted | Realistic, and deliberate. Silence is never consent (SA 3.4), tested by T06. Raised in the README's known limitations and in the operating note as a real operational pain point. |
| 7 | The side letter's deemed-consent clock ran from a "complete request", which was undefined. | Accepted | SL para 2 now defines a complete request. The engine only runs deemed consent from a complete request, and escalates if completeness is unknown. New scenario T31. |
| 8 | The beneficial-owner test had no stated timing or method. | Partly accepted | LPA 1.1 now measures the limit immediately after giving effect to the proposed Transfer. The counting method remains a GP determination, and the engine takes the count as an input; listed as a known limitation. |
| 9 | Deemed GP consent under the side letter cannot satisfy the Company's consent. | Rejected as a defect | Agrees with the design. Tested by T20 and T21. |
| 10 | The LPA's execution wording ("as of the date first written above") did not reconcile with Amendment No. 1. | Accepted | Signature page now executes as of March 3, 2025, with a note that the Amendment No. 1 signature page is omitted from the extract. |
| 11 | No deadline for the GP to record a transfer once conditions are met. | Deferred | Realistic. Listed as a known limitation; the tool can track this step but not force it. |
| 12 | Some operative terms are open-ended ("principal asset", "beneficial owners", "complete request"). | Partly accepted | "Complete request" is now defined (see 7) and the owner-count timing is set (see 8). "Principal asset" is left as ordinary drafting. |
| 13 | The signature wording about powers of attorney looked imprecise. | Accepted | Reworded to execution "for itself and as attorney-in-fact for each Limited Partner pursuant to the power of attorney granted under this Agreement". |
