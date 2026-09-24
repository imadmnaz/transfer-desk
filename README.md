# Transfer Desk

Transfer Desk checks whether a secondary transfer of an interest in a venture SPV can go ahead. It reads the facts of a proposed sale against the SPV's limited partnership agreement, an investor side letter, the portfolio company's stockholders' agreement and the buyer conditions, and returns one of three answers: blocked, lawyer review, or the list of actions still outstanding before the general partner can record the transfer. Every conclusion cites the clause it relies on, and the clause opens in place.

**Live demo:** https://imadmnaz.github.io/transfer-desk/

The documents, parties and dates are synthetic. This is not legal advice.

## Why this problem

A transfer of an SPV interest has to clear two sets of documents. The SPV's own agreement governs who may become a limited partner. The portfolio company's stockholders' agreement governs indirect transfers of its shares, and it usually has its own consent requirement, a right of first refusal and a list of competitors who may never hold an interest.

The company level now matters more than it did. OpenAI's published policy says its equity cannot be transferred directly or indirectly without its written consent, that any transfer made without it is void, and it names interests in SPVs among the offerings it does not recognise. In May 2026 Anthropic said that any transfer of its shares to an SPV is void under its transfer restrictions and will not be recognised on its books. A transfer can be clean under the SPV's documents and still be void one level up.

The work of clearing these transfers is mostly careful reading and date arithmetic, done under time pressure, and a missed step is expensive. That is the kind of work a rules engine does well, provided it knows when to stop and ask a lawyer.

## Design decisions

- **Fail safe.** Anything unknown, contradictory or ambiguous goes to a lawyer. The engine never treats silence as consent unless a document says so, and it never clears a transfer on evidence it cannot see.
- **Separate gates.** The fund, the side letter, the company and the buyer are checked separately, because a consent at one level does nothing at another. Company consent and a waiver of the right of first refusal are also kept apart, because the stockholders' agreement says each is independent of the other (SA 4.6).
- **Provenance.** Every result carries its citations, the clause text is stored verbatim with its PDF page, and every computed date shows its working, for example "20 Business Days from receipt on Fri 25 Sep 2026; skips Mon 12 Oct 2026 holiday".
- **Deterministic.** The engine is plain JavaScript with no dependencies and no model in the loop. The same facts always give the same answer, and the audit record carries a hash of the facts and the rulebook version.
- **One engine.** The demo page and the test suite call the same `evaluate()` function, so what the page shows is what the tests prove.
- **No green.** A transfer with nothing outstanding is "ready for the GP to record", which is a different thing from approved. Recording it in the register stays a human decision (LPA 8.5).

## How it works

```
facts ──▶ preliminary checks ──▶ fund ──▶ side letter ──▶ company ──▶ buyer
                                   │
                                   ▼
          verdict: BLOCKED  |  LAWYER REVIEW  |  N actions outstanding
                                   │
                                   ▼
                  finding, cures or checklist, audit record
```

The verdict follows a fixed order. Any failed rule blocks the transfer. Otherwise any unknown or contradictory fact sends it to a lawyer. Otherwise the answer is a checklist of outstanding actions, ending with the GP recording the transfer.

| Path | What it holds |
|---|---|
| `engine/engine.js` | The 21 rules and the verdict |
| `engine/dates.js` | Business Days, the 17:00 New York receipt rule, clear days and the working strings |
| `data/rulebook.json` | Each rule's gate, citations, thresholds and plain-English findings |
| `data/clauses.json` | Verbatim clause text keyed by document and section, with PDF page numbers |
| `data/scenarios.json` | 31 known-answer scenarios |
| `data/heldout.json` | 10 held-out cases, kept exactly as written |
| `docs/source/` | The three synthetic documents, as PDF and Markdown |
| `index.html`, `app.js`, `styles.css` | The demo page |

## Results

| Check | Result |
|---|---|
| Known-answer scenarios | 31 of 31 |
| Held-out cases, written blind without access to the engine | 10 of 10, including every date |
| Exhaustive sweep of fact combinations | 486,000 combinations, 0 unsafe clears |
| Test suite | 59 of 59 |

An unsafe clear is any case where the engine returns a checklist when it should have blocked the transfer or sent it to a lawyer. The sweep enumerates every combination of the facts most likely to cause one and checks two things on each: anything that must block does block, and nothing uncertain is ever cleared.

The "Run all tests" button at the bottom of the demo runs the scenarios, the held-out cases and the sweep in your browser.

To run the tests locally (Node 18 or later, no install step):

```
node --test
```

To serve the demo locally:

```
python3 -m http.server
```

## How I built this

I wrote the specification in `CLAUDE.md`, drafted the three documents, set the date conventions and made every legal call in the rulebook. Claude Code wrote most of the code against that specification, one phase at a time, and I reviewed each phase before it was committed.

To test my own judgement, I used cross-model review: a model from a different vendor, working adversarially and without access to the build. It marked up the drafting, decided all 31 scenarios blind before seeing my expected answers, and wrote the ten held-out cases. Its findings were inputs. I decided each one, and `docs/REVIEW-LOG.md` records what it found, what I decided and what changed. The engine review in round 3 found an unsafe clear the scenarios had missed; the fix and its regression tests are logged there.

`docs/NOTE.md` explains the legal judgement calls behind the rules.

## Known limitations

- The documents and the holiday calendar are synthetic and simplified.
- The model covers one SPV holding one portfolio company.
- The rulebook is written by hand. A new set of documents needs a new rulebook.
- Both agreements define a change of control as a Transfer, but change-of-control events are not modelled as an event type.
- The beneficial-owner count is taken from the GP as an input.
- The company has no deadline to answer a consent request, and the GP has no deadline to record a transfer once every condition is met, so the tool tracks both steps without being able to force them.

## What I would build next

Model-assisted drafting of the rulebook from a new agreement, measured against this hand-built rulebook and its tests before any of it is trusted.

## Sources

- OpenAI, [Unauthorized OpenAI equity transactions](https://openai.com/policies/unauthorized-openai-equity-transactions/)
- Anthropic, [Unauthorized Anthropic stock sales and investment scams](https://support.claude.com/en/articles/13704655-unauthorized-anthropic-stock-sales-and-investment-scams)
- TechCrunch, [Anthropic warns investors against secondary platforms offering access to its shares](https://techcrunch.com/2026/05/12/anthropic-warns-investors-against-secondary-platforms-offering-access-to-its-shares/), 12 May 2026
