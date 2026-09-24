# Transfer Desk: build brief

Read this whole file before writing any code. It is the specification. When something here conflicts with your instinct, follow this file and flag the conflict.

## 1. What we are building

A small, beautiful, rigorous tool for clearing a **secondary transfer of an interest in an SPV**.

An operator enters a proposed transfer and the evidence they have. The tool checks four separate gates, each against the clause it comes from:

1. **Fund**: the SPV's limited partnership agreement.
2. **Side letter**: investor-specific terms that vary the fund rules.
3. **Company**: the underlying portfolio company's stockholders' agreement, including consent, competitors and a right of first refusal.
4. **Buyer and regulatory**: KYC/AML, sanctions, accredited status, tax form, adherence, and the beneficial-owner limit.

It returns one of three verdicts:

- **Blocked**: a known condition has failed. Where the failure can be cured, the tool says how.
- **Escalate**: evidence is missing, unknown or contradictory, or a legal judgement is required.
- **Checklist ready**: every condition is either satisfied or has a known, actionable next step. The tool generates the checklist, with owners and dates.

It **never** says "approved" or "cleared". A ready checklist is not an approval. The final step of every checklist is the General Partner recording the transfer in the Register (LPA 8.5), which is a human act.

Source documents are in `docs/source/`. They are synthetic. Every rule must trace to a section in one of them.

Each document exists in two forms with identical text: a formatted PDF (what a human would receive) and a Markdown file. **The Markdown is the canonical text for building `clauses.json`.** `docs/source/page-index.json` maps each section to its page in the PDF so the demo can deep-link to it.

## 2. Non-negotiable principles

1. **Fail safe.** Unknown never counts as satisfied. Silence never counts as consent unless a document expressly says so (only Harbour side letter para 2 does, and only for GP consent).
2. **Separate gates stay separate.** GP consent, company consent and the ROFR are independent. One can never satisfy another (SA 4.6).
3. **Provenance on everything.** Every rule result carries document, section and version. The UI shows the clause text on tap.
4. **Deterministic.** No LLM calls anywhere in the engine or the demo. Same input, same output.
5. **One engine.** The engine is written once as a pure JavaScript ES module. The demo page and the test runner import the same file.
6. **Zero dependencies.** Vanilla HTML, CSS and JavaScript. Node's built-in test runner. No framework, no build step, no npm packages.
7. **Overrides never change a verdict.** An operator override is recorded in the audit trail and rejected.

## 3. Repository layout

```
/
  index.html              demo page (GitHub Pages serves this)
  styles.css
  app.js                  UI only: rendering and interaction, no legal logic
  engine/
    engine.js             pure functions: evaluate(facts, rulebook, calendar) -> decision
    dates.js              business-day and notice-receipt helpers
  data/
    rulebook.json         rules with citations and plain-English descriptions
    clauses.json          clause id -> exact clause text and PDF page, for tap-to-expand
    calendar.json         business-day holiday list
    base-facts.json       the clean baseline transfer
    scenarios.json        known-answer cases, each an override of base-facts
    heldout.json          adversarial cases written by an external reviewer
  tests/
    engine.test.js        runs every scenario and held-out case
  docs/
    source/               the three synthetic documents
    NOTE.md               one-page note on approaching post-close
    REVIEW-LOG.md         findings from each review and what changed
  README.md
```

## 4. Date conventions

- **Business Day**: Monday to Friday, excluding the dates in `calendar.json`. This is a simplified, synthetic calendar and the README must say so.
- **Holidays**: 2026-01-01, 2026-01-19, 2026-02-16, 2026-05-25, 2026-06-19, 2026-09-07, 2026-10-12, 2026-11-11, 2026-11-26, 2026-12-25, 2027-01-01, 2027-01-18.
- **Receipt of a notice** (LPA 14.2, SA 9.1): received on the day sent if sent before 17:00 New York time on a Business Day, otherwise on the next Business Day. Treat timestamps as New York local time.
- **"N Business Days after X"**: count Business Days strictly after X. The Nth one is the result.
- **ROFR exercise period** (SA 4.2) ends at the end of the 20th Business Day after receipt of a complete Transfer Notice. It has expired if `as_of` is after that date.
- **Completion window** (SA 4.5): completion must be on or before the date 45 Business Days after the end of the exercise period, or after the waiver date if waived earlier.
- **Permitted-transfer notices use clear days** (LPA 8.2, SA 3.2): N full Business Days must fall between the day of receipt and the day the transfer takes effect, excluding both. So the earliest permitted completion is the (N+1)th Business Day after receipt: the 6th after GP receipt (LPA 8.2, five clear days) and the 11th after company receipt (SA 3.2, ten clear days).
- **Harbour deemed consent** (SL para 2): deemed given at the end of the 10th Business Day after GP receipt of a complete request, if no response. Satisfied only if `as_of` is after that date.
- Every evaluation uses `facts.as_of`, never the real clock.

## 5. Data model

### Facts (input)

`base-facts.json` is the clean baseline. Each scenario deep-merges its overrides onto it.

```json
{
  "as_of": "2026-10-01",
  "documents_version_confirmed": "yes",
  "transfer": {
    "kind": "sale",
    "operator_classification": "transfer",
    "transferor": "Aldwych Angels Ltd",
    "transferor_capital_contribution": 50000,
    "fraction": 1.0,
    "transferee": "Mira Chen",
    "transferee_relationship": "unrelated",
    "transferee_existing_lp": false,
    "transferee_is_competitor": "no",
    "proposed_completion": "2026-10-05"
  },
  "fund": {
    "gp_consent": { "status": "received", "received_at": "2026-08-24T11:00" },
    "gp_permitted_notice": { "status": "not_applicable" },
    "beneficial_owners_current": 80,
    "claimed_side_letter": null
  },
  "company": {
    "consent": { "status": "received", "received_at": "2026-09-02T15:00" },
    "permitted_notice": { "status": "not_applicable" },
    "rofr_notice": { "status": "delivered", "sent_at": "2026-08-20T10:00", "complete": "yes", "proof_of_delivery": "yes" },
    "rofr_response": { "status": "waived", "at": "2026-08-27" }
  },
  "buyer": {
    "kyc": "cleared",
    "sanctions": "clear",
    "accredited": "confirmed",
    "tax_form": "received",
    "adherence": "signed"
  },
  "override": null
}
```

Allowed values:

- `transfer.kind`: `sale` | `pledge`
- `transfer.operator_classification`: `transfer` | `not_a_transfer`
- `transfer.transferee_relationship`: `unrelated` | `affiliate` | `family_trust` | `estate` | `harbour_transferee`
- `transfer.transferee_is_competitor`: `yes` | `no` | `unknown`
- consent `status`: `not_requested` | `requested` | `received` | `refused` | `unknown` | `contradictory`. `requested` carries `requested_at`, and for GP consent also `complete`: `yes` | `no` | `unknown` (whether the request contained everything SL para 2 requires). Default `yes`.
- notice `status`: `not_applicable` | `not_sent` | `delivered` | `sent_no_proof`
- `rofr_response.status`: `none` | `waived` | `exercised_whole` | `exercised_partial` | `unknown`
- `buyer.kyc`: `cleared` | `pending` | `not_started` | `unknown`
- `buyer.sanctions`: `clear` | `hit` | `pending` | `unknown`
- `buyer.accredited`: `confirmed` | `not_accredited` | `unknown`
- `buyer.tax_form`, `buyer.adherence`: `received`/`signed` | `outstanding`
- `beneficial_owners_current`: integer or `null` (unknown)
- `fund.claimed_side_letter`: `null` or `"harbour"` (the operator is relying on the Harbour side letter)
- `override`: `null` or `{ "by": string, "reason": string }`

### Rule result states

`SATISFIED` | `OUTSTANDING` | `FAILED` | `UNKNOWN` | `CONTRADICTORY` | `NOT_APPLICABLE`

- `OUTSTANDING`: known not yet done, and a clear action would resolve it. Produces a checklist action.
- `FAILED`: a known condition fails. May carry a `cure`.
- `UNKNOWN` and `CONTRADICTORY` always lead to Escalate.

### Verdict precedence

1. Any `FAILED` → **Blocked**.
2. Otherwise any `UNKNOWN` or `CONTRADICTORY` → **Escalate**.
3. Otherwise → **Checklist ready**.

### Decision (output)

```json
{
  "verdict": "BLOCKED | ESCALATE | CHECKLIST_READY",
  "headline": "one plain-English sentence",
  "results": [
    {
      "rule_id": "C-CONSENT",
      "gate": "company",
      "state": "OUTSTANDING",
      "reason": "Helion's written consent has been requested but not received. Silence is not consent.",
      "citations": [{ "doc": "SA", "section": "3.1", "version": "2025-11-20" }, { "doc": "SA", "section": "3.4", "version": "2025-11-20" }],
      "action": { "owner": "Ops", "text": "Chase Helion for written Board consent", "due": null },
      "cure": null,
      "notes": []
    }
  ],
  "checklist": [ { "owner": "...", "text": "...", "due": "YYYY-MM-DD or null", "source_rule": "..." } ],
  "notes": [ "cross-cutting notes, e.g. SA 4.6 independence" ],
  "audit": {
    "id": "deterministic hash of facts + rulebook version",
    "as_of": "...",
    "engine_version": "1.0.0",
    "rulebook_version": "LPA v1.1 | SA 2025-11-20 | Harbour SL 2025-03-05",
    "facts": { },
    "override": { "by": "...", "reason": "...", "accepted": false }
  }
}
```

Checklist rules: under Checklist ready, list every `OUTSTANDING` action, then "Transferor pays transfer costs (LPA 8.7)", then last "GP records the transfer in the Register once every condition is evidenced (LPA 8.5)". Under Escalate, the first item is "Lawyer review" naming the unknown or contradictory rules, followed by known actions. Under Blocked, show only the failures and their cures.

## 6. The rulebook

Every rule in `rulebook.json` has: `id`, `gate`, `title`, `description` (plain English), `citations`, and the logic below implemented in `engine.js`. Keep the legal content in the JSON and the mechanics in the engine.

**Classification**

- `X-CLASSIFY` (LPA 1.1 "Transfer"; SA 1.1 "Transfer"): a sale or a pledge is a Transfer under both documents. If `operator_classification` is `not_a_transfer`, add a note that the classification is rejected and evaluate as a Transfer. Never changes the verdict on its own.
- `X-VERSION`: `documents_version_confirmed` must be `yes`. `no` or `unknown` → `UNKNOWN` ("evidence may have been prepared against a superseded version").

**Side letter gate**

- `S-SCOPE` (SL para 3; LPA 12.4): the Harbour side letter applies only if `transferor` is "Harbour Family Office LLC". If `claimed_side_letter` is `"harbour"` and the transferor is not Harbour → note "side letter rights are personal to Harbour and cannot be relied on" and do not apply any side-letter effect. State `NOT_APPLICABLE` with that note.
- `S-HARBOUR-TRANSFEREE` (SL para 1): if the side letter applies and `transferee_relationship` is `harbour_transferee` or `affiliate`, GP consent is not required. It does **not** affect the company gate (SL para 4).
- `S-DEEMED-CONSENT` (SL para 2; LPA 8.8): if the side letter applies, GP consent is `requested`, and `as_of` is after 10 Business Days from receipt with no response → GP consent is deemed given (`SATISFIED`, note the deemed date). Otherwise not applicable. For any other transferor, silence is never consent (LPA 8.8). Deemed consent only runs from a **complete** request (SL para 2 defines complete). If `complete` is `no` → F-CONSENT OUTSTANDING with action "send a complete request under SL para 2". If `complete` is `unknown` → F-CONSENT UNKNOWN (the deemed-consent clock cannot be shown to have started).

**Fund gate**

- `F-CONSENT` (LPA 8.1, 8.8): required unless the transfer is to a Permitted Transferee under LPA 8.2 (`affiliate`, `family_trust`, `estate`) or a Harbour Transferee under the side letter. `received` → SATISFIED. `refused` → FAILED. `not_requested` or `requested` → OUTSTANDING (unless deemed under S-DEEMED-CONSENT). `unknown` → UNKNOWN. `contradictory` → CONTRADICTORY.
- `F-PERMITTED-NOTICE` (LPA 8.2): applies only to LPA Permitted Transferees. `delivered` and completion on or after the 6th Business Day after receipt (five clear days) → SATISFIED. `delivered` but completion too early → FAILED, cure "move completion to on or after {date}". `not_sent` → OUTSTANDING. `sent_no_proof` → UNKNOWN.
- `F-MIN-HOLDING` (LPA 8.3): if `fraction` < 1, the transferred Capital Contribution is `contribution × fraction` and the retained amount is the balance (LPA 8.3, second sentence). Both must be ≥ 10,000. Otherwise FAILED with cure.
- `F-BO-LIMIT` (LPA 8.4(d); LPA 1.1 "Beneficial Owner Limit", measured immediately after giving effect to the Transfer): new count = current + (transferee is new ? 1 : 0) − (transferor exits fully ? 1 : 0). Over 95 → FAILED with cure. `null` current → UNKNOWN. Not applicable to a pledge (LPA 8.4 last sentence).

**Company gate**

- `C-COMPETITOR` (SA 3.3, Schedule 2): `yes` → FAILED regardless of any consent. `unknown` → UNKNOWN.
- `C-CONSENT` (SA 3.1, 3.4): required unless the transferee is an SA Permitted Transferee (`affiliate`, `family_trust`, `estate`). Note that `harbour_transferee` is **not** an SA Permitted Transferee (SA 1.1 proviso). Same state mapping as F-CONSENT, except silence is never consent (SA 3.4) and there is no deemed-consent path.
- `C-PERMITTED-NOTICE` (SA 3.2): applies only to SA Permitted Transferees. Same mapping as F-PERMITTED-NOTICE with ten clear Business Days, so the earliest completion is the 11th Business Day after receipt.
- `C-ROFR-NOTICE` (SA 4.1, 4.2, 9.1): applies to a sale to anyone other than an SA Permitted Transferee. Not applicable to a pledge. `not_sent` → OUTSTANDING ("serve a complete Transfer Notice"). `sent_no_proof` → UNKNOWN ("the exercise period cannot be shown to have started"). `complete` = `no` or `unknown` → UNKNOWN. `delivered` → compute receipt and expiry.
- `C-ROFR-RESPONSE` (SA 4.2 to 4.4): only evaluated once the Transfer Notice is `delivered`; otherwise NOT_APPLICABLE (pending notice). `waived` → SATISFIED. `exercised_whole` → FAILED ("the Company is buying the interest; the sale to this transferee cannot proceed"). `exercised_partial` → UNKNOWN ("SA 4.3 permits exercise in whole only; a purported partial exercise needs legal review"). `none` with period running: if `proposed_completion` is on or before the expiry date → FAILED, cure "move completion to after {expiry} or obtain a written waiver"; otherwise OUTSTANDING, action "wait until {expiry} or obtain written waiver", due = expiry. `none` with period expired → SATISFIED. `unknown` → UNKNOWN.
- `C-ROFR-WINDOW` (SA 4.5): evaluated only once the period has ended or been waived; otherwise NOT_APPLICABLE. Completion must fall within 45 Business Days. Later → FAILED, cure "serve a fresh Transfer Notice".
- Always add the cross-cutting note from SA 4.6 when both C-CONSENT and the ROFR rules apply.

**Buyer and regulatory gate** (LPA 8.4)

- `B-KYC` (8.4(b)): `cleared` SATISFIED, `pending`/`not_started` OUTSTANDING, `unknown` UNKNOWN.
- `B-SANCTIONS` (8.4(b)): `clear` SATISFIED, `hit` FAILED (no cure), `pending` OUTSTANDING, `unknown` UNKNOWN.
- `B-ACCREDITED` (8.4(f)): `confirmed` SATISFIED, `not_accredited` FAILED, `unknown` UNKNOWN. Not applicable to a pledge.
- `B-TAX-FORM` (8.4(c)) and `B-ADHERENCE` (8.4(a)): done → SATISFIED, `outstanding` → OUTSTANDING. Not applicable to a pledge.

**Override**

- `X-OVERRIDE`: if `override` is present, record it in the audit trail with `accepted: false` and add a note. It never changes any rule state or the verdict.

## 7. Known-answer scenarios

Each scenario overrides `base-facts.json`. Tests assert the verdict, the listed rule states, and any listed dates. Dates below are pre-computed with the conventions in section 4. If your engine disagrees, the engine is wrong until proven otherwise.

| ID | Scenario | Overrides from base | Expected verdict | Must assert |
|---|---|---|---|---|
| T01 | Clean full transfer | none | CHECKLIST_READY | no OUTSTANDING rules; last checklist item is GP registration (LPA 8.5) |
| T02 | Company consent not yet requested | company.consent = not_requested | CHECKLIST_READY | C-CONSENT OUTSTANDING |
| T03 | Company consent refused | company.consent = refused | BLOCKED | C-CONSENT FAILED |
| T04 | GP consent refused | fund.gp_consent = refused | BLOCKED | F-CONSENT FAILED |
| T05 | Company consent only "agreed on a call" | company.consent = unknown | ESCALATE | C-CONSENT UNKNOWN |
| T06 | Company silent for two months | company.consent = requested, requested_at 2026-08-03T10:00 | CHECKLIST_READY | C-CONSENT OUTSTANDING (never SATISFIED); reason cites SA 3.4 |
| T07 | Permitted transfer to transferor's affiliate | transferee "Aldwych Angels II Ltd", relationship affiliate; gp_permitted_notice and company.permitted_notice delivered 2026-09-15T10:00; rofr_notice not_sent; rofr_response none; gp_consent not_requested; company.consent not_requested | CHECKLIST_READY | F-CONSENT, C-CONSENT, C-ROFR-NOTICE all NOT_APPLICABLE; both notices SATISFIED (earliest completion 2026-09-23 for the GP notice and 2026-09-30 for the company notice) |
| T08 | Permitted transfer, company notice too late | as T07 but company.permitted_notice delivered 2026-09-28T11:00, completion 2026-10-02 | BLOCKED | C-PERMITTED-NOTICE FAILED; cure date 2026-10-14 (ten clear Business Days, skipping the 12 Oct holiday) |
| T09 | Sale to a Competitor with every consent in hand | transferee "Kestrel Automation Ltd", is_competitor yes | BLOCKED | C-COMPETITOR FAILED despite C-CONSENT SATISFIED |
| T10 | ROFR period still running | rofr_notice delivered 2026-09-25T10:00; rofr_response none; completion 2026-11-02 | CHECKLIST_READY | C-ROFR-RESPONSE OUTSTANDING; expiry 2026-10-26 |
| T11 | ROFR notice sent, no proof of delivery | rofr_notice sent_no_proof; rofr_response none | ESCALATE | C-ROFR-NOTICE UNKNOWN |
| T12 | ROFR notice sent after 5pm on a Friday | rofr_notice delivered 2026-09-25T18:30; rofr_response none; completion 2026-11-02 | CHECKLIST_READY | receipt 2026-09-28; expiry 2026-10-27 |
| T13 | Company purports to exercise ROFR over half | rofr_response exercised_partial | ESCALATE | C-ROFR-RESPONSE UNKNOWN, reason cites SA 4.3 |
| T14 | Company exercises ROFR in whole | rofr_response exercised_whole | BLOCKED | C-ROFR-RESPONSE FAILED |
| T15 | ROFR waived, consent not sought | company.consent not_requested | CHECKLIST_READY | C-CONSENT OUTSTANDING; SA 4.6 note present |
| T16 | Consent received, no Transfer Notice | rofr_notice not_sent; rofr_response none | CHECKLIST_READY | C-ROFR-NOTICE OUTSTANDING; SA 4.6 note present |
| T17 | Contradictory consent evidence (approval 20 Sep, refusal 22 Sep) | company.consent contradictory | ESCALATE | C-CONSENT CONTRADICTORY |
| T18 | Completion outside the post-ROFR window | rofr_notice delivered 2026-06-01T10:00; rofr_response none | BLOCKED | expiry 2026-06-30; window end 2026-09-01; C-ROFR-WINDOW FAILED, cure fresh notice |
| T19 | Harbour to a fund managed by its adviser | transferor "Harbour Family Office LLC"; transferee "Harbour Growth Fund II LP", relationship harbour_transferee; gp_consent not_requested; company.consent not_requested; rofr_notice not_sent; rofr_response none | CHECKLIST_READY | F-CONSENT NOT_APPLICABLE via SL para 1; C-CONSENT OUTSTANDING (not an SA Permitted Transferee); C-ROFR-NOTICE OUTSTANDING |
| T20 | Non-Harbour LP relying on Harbour's deemed consent | transferor "Priya Nair"; claimed_side_letter harbour; gp_consent requested, requested_at 2026-09-10T10:00 | CHECKLIST_READY | S-SCOPE note present; F-CONSENT OUTSTANDING (not deemed) |
| T21 | Harbour, GP silent past 10 Business Days | transferor "Harbour Family Office LLC"; gp_consent requested, requested_at 2026-09-10T10:00, complete yes | CHECKLIST_READY | F-CONSENT SATISFIED via S-DEEMED-CONSENT; deemed at end of 2026-09-24 |
| T22 | Partial transfer below minimum holding | transferor "Priya Nair", contribution 15000, fraction 0.6 | BLOCKED | F-MIN-HOLDING FAILED (transfers 9,000 and retains 6,000, both below 10,000) |
| T23 | Partial transfer breaches beneficial-owner limit | transferor "Priya Nair", contribution 50000, fraction 0.5; beneficial_owners_current 95 | BLOCKED | F-BO-LIMIT FAILED (96 > 95) |
| T24 | Beneficial-owner count unknown | beneficial_owners_current null | ESCALATE | F-BO-LIMIT UNKNOWN |
| T25 | Sanctions screening hit | buyer.sanctions hit | BLOCKED | B-SANCTIONS FAILED, no cure |
| T26 | Pledge treated as "not a transfer" | kind pledge; operator_classification not_a_transfer; transferee "Cobalt Lending Ltd"; gp_consent not_requested; company.consent not_requested; rofr_notice not_sent; rofr_response none | CHECKLIST_READY | X-CLASSIFY note; F-CONSENT and C-CONSENT OUTSTANDING; C-ROFR-NOTICE, B-ADHERENCE, B-TAX-FORM, B-ACCREDITED, F-BO-LIMIT NOT_APPLICABLE |
| T27 | Evidence prepared against a superseded LPA | documents_version_confirmed no | ESCALATE | X-VERSION UNKNOWN |
| T28 | Operator overrides a refusal | as T03, plus override { by "ops.user2", reason "urgent close" } | BLOCKED | audit.override.accepted false; verdict unchanged |
| T29 | KYC still pending | buyer.kyc pending | CHECKLIST_READY | B-KYC OUTSTANDING |
| T30 | Completion scheduled inside a running ROFR period | rofr_notice delivered 2026-09-25T10:00; rofr_response none; completion 2026-10-05 | BLOCKED | C-ROFR-RESPONSE FAILED; cure: move completion after 2026-10-26 or obtain a written waiver |
| T31 | Harbour, GP silent, but the request may have been incomplete | as T21 but gp_consent complete unknown | ESCALATE | F-CONSENT UNKNOWN; no deemed consent |

Held-out cases in `heldout.json` come from an external reviewer. Report them separately and never edit them to make them pass. If one fails, either fix the engine or record the disagreement in `REVIEW-LOG.md`.

The single most important assertion across the whole suite: **no case with any UNKNOWN, CONTRADICTORY or FAILED rule may ever return CHECKLIST_READY.** Write that as its own test, run over every scenario and held-out case, and report it as "Unsafe clears: 0".

## 8. The demo page

### Feel

Calm, exact and quiet, like Stripe's documentation or Linear. Typography and whitespace do the work. No gradients, no illustrations, no emoji, no drop shadows beyond a hairline.

**The visual target is `design-ref/reference.html`** (with screenshots beside it), a static render of T09 called "the transfer register". Match its fonts, colours, type sizes, spacing and rules closely. Where it differs from anything below in this section (tokens, fonts, verdict banner, scenario chips, gate stepper, stepper cards), the reference wins. The verdict wording rules in item 4 still apply, adapted to its format. Its content is illustrative only: all real text, dates, counts and scores come from the engine and the data files. `design-ref/` is gitignored and never deployed.

Design rules that go with the reference:
- IBM Plex Sans for everything, including the wordmark (16px semibold) and the finding (22/28 semibold). Body 16/24. Section labels 13/18 medium. IBM Plex Mono 12px for citations only. No serif anywhere.
- Each theme has one canvas, one text colour, one rule colour and one link colour; muted text is the text colour mixed toward the canvas. Red is reserved for the word BLOCKED. Escalate uses the text colour with the label LAWYER REVIEW. No green, no tinted panels, no cards, no boxes, no rounded corners, no highlighting.
- Order: header (wordmark; scenario as "T09 · Competitor buyer" with a "Change" link that opens a full-screen searchable scenario list), a four-row register (Seller, Buyer, Interest, Completion), the finding, then the document review.
- The finding: a 12px status label (BLOCKED, LAWYER REVIEW, or N ACTIONS OUTSTANDING / READY FOR THE GP TO RECORD), one sentence at 22/28, one short explanation, and the citations it relies on. Blocked leads with what failed. Lawyer review says what is uncertain and what the lawyer must decide. Actions outstanding leads with the next action, its owner and due date.
- The document review follows the decision: the deciding rule first and expanded, with its clause as source text (a source line such as "Company stockholders' agreement · §3.3 · p. 3", a single top rule, the verbatim extract, and a link to open the PDF at that page), then the fact toggle that would change it. Other rules follow as plain rows with a one-line detail and a state word, grouped by document, the deciding document first.
- Desktop stays one reading column, max 680px. The full document opens only on request.
- The test scorecard, audit id and theme toggle sit in a quiet record and footer at the very end.

### Tokens

- Fonts (Google Fonts): IBM Plex Sans and IBM Plex Mono only, as set out above. Tabular figures for all numbers.
- Light: background `#FAFAF7`, surface `#FFFFFF`, ink `#1A1A1A`, muted `#6B6B66`, hairline `#E7E5DF`, accent navy `#14284B`.
- Dark: background `#0F1115`, surface `#171A20`, ink `#ECECEC`, muted `#9A9A95`, hairline `#2A2E36`, accent `#8FA8D6`. Follow `prefers-color-scheme` and provide a manual toggle.
- Verdicts: Blocked muted red `#9B2C2C` on `#F7ECEA`; Escalate amber `#8A5A00` on `#FBF3E2`; Checklist ready is ink on surface with a navy left rule.
- **There is no green anywhere.** This is deliberate: a ready checklist is not an approval. The README explains it.
- 8px spacing grid. Radius 10px on cards. Hairline borders.

### Layout, mobile first (single column, max width 720px on desktop)

1. **Header**: "Transfer Desk" and a one-line subtitle: "Clears SPV secondary transfers against every document that governs them." Small "Synthetic documents · not legal advice" tag.
2. **Scenario picker**: chips show a short plain-English name, never a bare ID (the ID sits beside it in small mono). Six featured chips: Clean transfer (T01), Competitor buyer (T09), ROFR still running (T10), Half-exercised ROFR (T13), Harbour deemed consent (T21), Override attempted (T28). Then an "All 31" chip that opens a searchable list (bottom sheet on mobile, popover on desktop), and "Custom" last. The page opens on T09, because it makes the core point in one screen: the fund gate is clean and the company gate blocks.
3. **Request card**: seller → buyer, interest, proposed completion date, as-of date. Below 600px it collapses to one line (seller → buyer · amount · completion date) and expands on tap.
4. **Verdict banner**: the verdict in large type and the one-sentence headline. Never show the bare words "Checklist ready", because a reader takes them to mean ready to close. When the verdict is CHECKLIST_READY with outstanding actions, the banner reads **"N actions outstanding"** with the subline "Nothing blocks this transfer, but these steps must be completed before the GP can record it." When there are none, it reads **"Ready for the GP to record"** with the subline "Every condition is evidenced. Recording in the Register (LPA 8.5) is a human decision."
5. **Four gates as a vertical stepper**: Fund, Side letter, Company, Buyer and regulatory. Each rule row shows a state pill, the plain-English reason and a citation in mono. Tapping the citation expands the exact clause text from `clauses.json` inline, with a quiet "View in document, p. N" link that opens the PDF at that page (`docs/source/<file>.pdf#page=N`) in a new tab.
6. **Evidence toggles**: under each gate, the relevant facts as segmented controls. Changing one re-runs the engine instantly and animates only the verdict change (150ms fade).
7. **Checklist**: a compact timeline with owner, action and date.
8. **Audit record**: collapsed; expands to show the JSON with a copy button.
9. **Footer**: "Run all tests" button that runs every scenario and held-out case in the browser and shows a scorecard: scenarios passed, held-out passed, and **Unsafe clears: 0** in the largest type.

### Quality bar

- Works at 375px wide with no horizontal scroll. Tap targets at least 44px.
- Keyboard accessible, visible focus rings, correct contrast in both themes.
- No layout shift when the verdict changes.
- Loads from GitHub Pages with no console errors.

### Typography and hierarchy

- Type scale uses only 12, 14, 16, 20, 28 and 40px. Body text is 16px, including form controls, so iOS never zooms. Line height 1.5 for body, 1.15 for headlines.
- Three weights only: 400, 500, 600. The verdict headline is 28px on mobile and 40px on desktop, weight 600, letter spacing -0.02em.
- One accent colour. State pills are a small coloured dot plus text, not saturated filled blocks.
- Pill labels are plain English: Met, Outstanding, Fails, Unknown, Conflicting, Not applicable. Engine state names appear only in the audit JSON.
- Within each gate, NOT_APPLICABLE rules collapse into one muted line ("2 rules not applicable") that expands on tap.
- Dates in the UI read "Mon 26 Oct 2026" in tabular figures; ISO dates appear only in the audit JSON. Where the engine computes a date, show the working in small muted text beneath it (for example "20 Business Days from receipt on Fri 25 Sep; skips Mon 12 Oct holiday").

### Mobile specifics

- On a 375px screen the first viewport shows the header, the picker and the verdict banner without scrolling.
- Once the verdict banner scrolls out of view, a compact sticky bar (44px, verdict word and action count) appears at the top, so the reader never loses the answer while reading the gates. Use IntersectionObserver.
- The chip row uses scroll snap and a fade on the right edge so it is obvious that it scrolls.
- Use `100dvh`, respect safe-area insets, and give nothing a hover-only affordance.
- The audit JSON block may scroll inside itself; the page never scrolls horizontally.

### Details that signal care

- `prefers-reduced-motion` turns off the fade.
- Favicon: a simple navy monogram SVG. A proper `<title>`, meta description and Open Graph tags with a 1200×630 preview image made from a real screenshot, so the link looks finished when pasted into an email or LinkedIn.
- The theme toggle remembers the choice in localStorage, wrapped in try/catch.
- No lorem, TODO or placeholder text anywhere.

### Avoid (these read as a template)

Cards inside cards. More than one border style. Icons beside every heading. Emoji. Gradients. Glass effects. Coloured section backgrounds. All-caps labels. Centred body text. Default blue links. Badges on everything. Marketing copy.

### Design process for phase 4

1. Build a static version first from the computed T09 decision, before any interactivity, matching `design-ref/reference.html`. Stop and show screenshots side by side with the reference ones.
2. Take screenshots with Playwright run through npx, without adding it to the repo (the repo stays dependency free). Capture 375×812 and 1280×800, light and dark, for T09, T10, T13 and T01, plus one with a clause expanded and one with the scorecard open. Save them to `screens/` (gitignored) with names like `t09-375-light.png`.
3. Before showing me anything, review your own screenshots against this section and fix what you find. At least two rounds.
4. Confirm no horizontal scroll at 320, 375 and 390px, and check every text and background pair against WCAG AA in both themes. Report the results.

## 9. Build phases

Commit at the end of each phase with a clear message. Run `node --test` before every commit.

1. **Data.** `clauses.json` from the Markdown source documents (exact text, keyed by doc and section, with the PDF page from `page-index.json`), `rulebook.json`, `calendar.json`, `base-facts.json`, `scenarios.json`. Stop and let me review before phase 2.
2. **Engine and tests.** `dates.js`, `engine.js`, `engine.test.js` including the unsafe-clears test. All 31 scenarios passing. Stop for review.
3. **Held-out.** I will paste external adversarial cases into `heldout.json`. Run them, report results, do not edit them.
4. **Demo page.** Build to section 8, following its design process. Stop for review after the static version, and again once it is interactive.
5. **README, NOTE.md and REVIEW-LOG.md.** Then enable GitHub Pages.

## 10. README outline

1. One-paragraph summary and a link to the live demo.
2. **Why this problem**: secondary transfers in SPVs depend on documents at two levels. Some late-stage companies now state publicly that indirect transfers through SPVs without their consent are void (OpenAI and Anthropic, May 2026). A transfer can be clean under the SPV's own documents and still be void at the company level.
3. **Design decisions**: fail safe; separate gates; provenance; deterministic engine; one engine for demo and tests; no green.
4. **How it works**: a small diagram of facts → four gates → verdict → checklist and audit.
5. **Results**: scenario score, held-out score, unsafe clears.
6. **Known limitations**: synthetic documents and calendar; single SPV and single portfolio company; hand-authored rulebook; change-of-control events are defined as Transfers in both documents but not modelled as an event type; the beneficial-owner count is taken from the GP as an input; the Company's consent has no response deadline, and the GP has no deadline to record a transfer once conditions are met, so the tool can only track these, not force them.
7. **What I would build next**: model-assisted drafting of the rulebook from a new agreement, measured against this hand-built rulebook before being trusted.
8. Link to `docs/NOTE.md` and `docs/REVIEW-LOG.md`.

## 11. Style

- Plain English in all user-facing text. No legal jargon without a reason.
- No em dashes anywhere in the UI, README or notes.
- Small pure functions. No clever abstractions. Comments explain why, not what.
