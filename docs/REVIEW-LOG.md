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

## Round 2: blind scenario review

**Reviewer:** cross-model review. The reviewer decided all 31 scenarios from the revised documents alone, before seeing the expected answers.

**Result.** The reviewer's legal reasoning matched the expected analysis in all 31 cases: which provisions decide each one, which approvals are independent, where silence is not consent, and every deadline except the one below. Its verdict label differed in 9 cases, and every one of those differences traced to the same point of vocabulary rather than law.

| # | Finding | Decision | Change made |
|---|---|---|---|
| 1 | Verdict label differed in T02, T06, T15, T16, T19, T20, T26 and T29. In each, a step was known but not yet done (for example, consent not yet requested). The reviewer labelled these ESCALATE or BLOCKED; the expected answer is CHECKLIST_READY, because nothing is unknown or failed and the next step is clear. | Rejected on the verdict; accepted on the underlying point | The verdicts stand, because they follow the stated definitions and escalating known, actionable steps would bury genuine escalations. But the disagreement showed that the words "Checklist ready" read as "ready to close". The interface now never shows them: it shows "N actions outstanding" or, only when nothing is left, "Ready for the GP to record". |
| 2 | "At least five (or ten) Business Days before the Transfer takes effect" was read as clear days, excluding both the day of receipt and the effective day, giving an earliest completion one Business Day later than expected (T07, and T08's cure date of 14 October rather than 13 October). | Accepted | This is a genuine ambiguity in the drafting, and courts have read similar wording both ways. LPA 8.2 and SA 3.2 now say "clear Business Days" and spell out the exclusions. The engine uses the (N+1)th Business Day after receipt, and T08's expected cure date is now 14 October 2026. |
| 3 | T13: SA 4.3 prohibits a partial exercise of the right of first refusal but does not say what a purported partial exercise does. | Agreed | Already ESCALATE by design: the effect of an invalid partial exercise needs a lawyer. |
| 4 | T17: the documents do not say whether a consent can be withdrawn, so an approval followed by a refusal cannot be resolved mechanically. | Agreed | Already ESCALATE by design. |

## Round 3: engine review

**Reviewer:** my review of `engine/engine.js` against the unsafe-clears principle, after phase 2 (all 31 scenarios passing).
**Scope:** the C-ROFR-NOTICE, C-ROFR-RESPONSE and C-ROFR-WINDOW logic.

| # | Finding | Decision | Change made |
|---|---|---|---|
| 1 | Found in engine review: a recorded exercise of the right of first refusal was ignored when the Transfer Notice was not evidenced, producing an unsafe clear. Fixed, with four regression tests. | Accepted | C-ROFR-RESPONSE now evaluates `exercised_whole`, `exercised_partial`, `unknown` and `waived` on their own terms whenever the right of first refusal applies at all (not only once the Transfer Notice is SATISFIED); only `none` still depends on the notice. A `delivered` notice with `complete: "no"` is now C-ROFR-NOTICE OUTSTANDING, not UNKNOWN, since it is a known gap with a clear cure. C-ROFR-WINDOW now applies whenever there is a waiver, using the waiver date, or the earlier of the waiver and the expiry where the expiry is known, even without a satisfied notice. None of the 31 scenarios changed outcome. |

## Round 4: held-out cases

**Reviewer:** cross-model review. The cases were written blind, from the documents and conventions alone.
**Scope:** ten adversarial cases (`data/heldout.json`) probing 17:00 and holiday receipt boundaries, exact minimum-holding and beneficial-owner-limit arithmetic, an Affiliate of a listed Competitor, and exercise-period and completion-window edge days.

Held-out cases H01 to H10, written independently by a second model from the documents and conventions, without access to the engine. Results: 10/10 verdicts, 10/10 fully matched including dates.

A field-name alias table in `tests/engine.test.js` (`HELD_OUT_DATE_FIELD_ALIASES`) translates the held-out cases' date field names (for example `receipt_date`, `deemed_date`) to the engine's own (`receipt`, `deemed_at`) before comparison; no expected value in `data/heldout.json` was changed.
