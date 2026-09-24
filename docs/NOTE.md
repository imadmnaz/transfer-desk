# A note on the legal design

The engine is only as good as the calls behind its rules. This note sets out the calls I made and why. Section references are to the three synthetic documents in `docs/source/`: the LPA, the Helion stockholders' agreement (SA) and the Harbour side letter (SL).

## Uncertainty goes to a lawyer

The engine has three outcomes, and the order between them is fixed. A known failure blocks. Anything unknown or contradictory escalates. Only when every fact is known and nothing fails does it produce a checklist.

The escalation rule does most of the protective work. Where the documents do not answer a question, the engine does not guess:

- **A partial exercise of the right of first refusal.** SA 4.3 allows exercise in whole only, but nothing says what a purported partial exercise does. It could be void, or it could be a valid exercise that the company must complete. That is for a lawyer (T13).
- **Contradictory consent evidence.** An approval followed by a refusal cannot be resolved mechanically, because the SA does not say whether a consent can be withdrawn (T17).
- **A notice with no proof of delivery**, or a request that may have been incomplete. Time does not run from a date that cannot be shown (T11, T31).
- **Unconfirmed document versions.** Evidence checked against a superseded agreement proves nothing about the current one (T27).

## Silence is not consent

The company's failure to respond is never consent (SA 3.4). The only deemed consent in the documents is Harbour's under SL para 2: the GP's consent is deemed given at the end of the tenth Business Day after receipt of a complete request. The engine applies that narrowly:

- The clock starts only once the request is complete. SL para 2 now defines a complete request, after the first review pointed out that it was undefined.
- The right is personal to Harbour (SL para 3), so another limited partner cannot rely on it (T20).
- On the tenth day itself, consent is not yet deemed. It arises at the end of that day (H05).

## Each level decides for itself

A consent at one level does nothing at another. GP consent does not satisfy the company, and Harbour's deemed consent does not touch Helion's consent (H10).

Within the company level, consent and the right of first refusal are separate requirements. SA 4.6 says so expressly, so a waiver of the right is not consent, and consent is not a waiver. The engine keeps them as separate rules and shows the SA 4.6 note whenever both apply.

The competitor bar is absolute. SA 3.3 prohibits a transfer to a Competitor "whether or not the Company has consented to it", and a Competitor includes an Affiliate of anyone listed in Schedule 2. No cure is offered (T09, H04).

## Dates

- **Receipt.** A notice sent before 17:00 New York time on a Business Day is received that day; otherwise it is received on the next Business Day. A notice sent at exactly 17:00 is received the next Business Day (H01), and so is a notice sent on a holiday (H02).
- **Clear days.** The first draft said notice must be given "at least five Business Days before" a permitted transfer. The blind review read that as clear days, and courts have read similar wording both ways, so I redrafted LPA 8.2 and SA 3.2 to say "clear Business Days" and spell out the exclusions. The earliest completion is the sixth Business Day after receipt for the GP and the eleventh for the company.
- **Right of first refusal.** The exercise period ends at the end of the twentieth Business Day after receipt of a complete Transfer Notice. Completion on or before that day fails, with a cure of moving the date or obtaining a written waiver (T30, H09).
- **Completion window.** Once the right lapses or is waived, completion must happen within 45 Business Days. After that a fresh Transfer Notice is needed (SA 4.5, T18, H08).

## Substance over labels

- **A pledge is a Transfer.** Both agreements define Transfer to include a pledge. If an operator classifies a pledge as "not a transfer", the engine rejects the classification and applies the consent rules anyway (T26).
- **Overrides are logged, never applied.** An operator can record an override with a name and a reason. It goes into the audit record and changes nothing (T28).
- **A recorded fact is never ignored.** If the company is recorded as having exercised its right of first refusal, the transfer is blocked even when the Transfer Notice itself is not evidenced. The first version of the engine missed this, and round 3 of the review log records the fix.

## Arithmetic

- **Minimum holding.** After a partial transfer, both the transferor and the transferee must hold at least US$10,000 of capital contribution (LPA 8.3). Exactly US$10,000 is enough (H03).
- **Beneficial Owner Limit.** The count is measured immediately after giving effect to the transfer. A buyer who is already a limited partner adds no one, and a seller who exits in full drops out of the count. Exactly 95 is within the limit (H03). If the count is unknown, the engine escalates (T24).

## What stays human

Recording a transfer in the register is the GP's decision (LPA 8.5). The best the engine can say is that every condition is evidenced and the GP may record it. That is why nothing on the page is ever green.
