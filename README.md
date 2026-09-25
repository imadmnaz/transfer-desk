# Transfer Desk

Transfer Desk checks whether a secondary transfer of an interest in a venture SPV can go ahead. It reads the facts of a proposed sale against the SPV's limited partnership agreement, an investor side letter, the portfolio company's stockholders' agreement and the buyer conditions, and returns one of three answers: blocked, lawyer review, or the actions still outstanding before the general partner can record the transfer. Every conclusion cites the clause it relies on, the clause opens in place, and every computed date shows its working.

**Live demo:** https://imadmnaz.github.io/transfer-desk/

The documents, parties and dates are synthetic. This is not legal advice.

## Try it in a minute

The demo opens on a queue of eight transfer requests for one SPV, the way an operations team would see them: each with its status, the reason in one line and its completion date. Every request opens into the deal itself, where each fact can be changed and the answer updates instantly.

1. **Open the request to Kestrel Automation.** It is blocked. The SPV's own documents are satisfied, but Helion's stockholders' agreement bars competitors whatever the consents, and the clause is quoted with a link to its page in the PDF.
2. **Change the buyer.** The answer moves to "ready for the GP to record", and the request's row in the queue changes with it.
3. **Set Helion's consent to "Only agreed on a call".** The answer moves to lawyer review. The tool will not clear what it cannot evidence.
4. **Open the request completing on Mon 2 Nov**, where Helion's right of first refusal is still running. Move completion to before Mon 26 Oct and it blocks, with the date the right lapses and the working behind it.
5. **On any request with an action outstanding, log it.** The next action panel has a button for it: logging chases Helion's consent or the GP's, and the answer, the actions panel and the activity feed all update, with "Undo" on offer for a few seconds if you logged it by mistake.
6. **Where a letter is needed, open the draft.** The consent request and the Transfer Notice each have a "Draft" button next to them that writes the letter from the facts on screen, ready to copy, marked "Draft for review. Not legal advice."
7. **Back on the queue, run "Is it safe?"** It tries 486,000 combinations of facts in your browser and reports the number of unsafe clears: zero.

"New request" starts a blank deal, and all 31 test scenarios can be opened from the queue.

## Why I built this

I am a solicitor (England and Wales). I trained and practised in M&A at Skadden, where a large part of closing a deal is running a checklist: every condition, who owns it, what evidences it and the date it falls due. Clearing a transfer of an SPV interest is the same discipline applied to smaller deals at much higher volume, with less time and fewer lawyers per deal. The reasoning is careful reading, cross-referencing between documents and date arithmetic, and a single missed step can make the transfer void.

That makes it a good test of a question I care about in legal AI: which parts of a legal workflow should be automated, and how you prove the automation is safe. I wanted to build something a fund lawyer would trust, which meant it had to show its reasons, cite its sources, admit what it does not know and be tested as hard as I could test it.

The timing matters too. Some of the most sought-after private companies now say publicly that transfers of their shares into SPVs without their consent are void. OpenAI's published policy says its equity cannot be transferred directly or indirectly without its written consent, that any other transfer is void, and it names interests in SPVs among the offerings it does not recognise. In May 2026 Anthropic said that any transfer of its shares to an SPV is void under its transfer restrictions. A transfer can be clean under the SPV's own documents and still fail one level up, and that is the case this tool is built to catch.

## What it catches

A few of the 31 scenarios, all of which run in the demo:

| Scenario | Answer | Why |
|---|---|---|
| Competitor buyer (T09) | Blocked | The company's stockholders' agreement bars competitors "whether or not the Company has consented" (SA 3.3). Every other consent is in hand, and none of them helps. |
| Consent "agreed on a call" (T05) | Lawyer review | The company's consent must be written and Board approved (SA 3.1). An oral assurance is not evidence of either. |
| Company silent for months (T06) | Consent outstanding | Silence is not consent (SA 3.4), however long it lasts. |
| Borrowed Harbour consent (T20) | GP consent outstanding | Harbour's side letter gives it deemed consent, but the right is personal to Harbour (SL para 3). Another investor cannot rely on it. |
| Half-exercised right of first refusal (T13) | Lawyer review | The company may exercise in whole only (SA 4.3). The documents do not say what a partial exercise does, so a lawyer decides. |
| Notice sent after hours (T12) | Actions outstanding | A notice sent at 18:30 on a Friday is received on Monday, and every deadline that runs from it moves with it. |
| Completion inside the refusal period (T30) | Blocked | Completion is set before the company's right of first refusal lapses. The cure is to move completion past Mon 26 Oct 2026 or obtain a written waiver. |
| Pledge treated as "not a transfer" (T26) | Actions outstanding | Both agreements define a pledge as a Transfer. The engine rejects the label and applies the consent rules anyway. |
| Override attempted (T28) | Blocked | An operator tries to override a refusal. The override is logged in the audit record and changes nothing. |

## Design decisions

- **Fail safe.** Anything unknown, contradictory or ambiguous goes to a lawyer. The engine never treats silence as consent unless a document says so, and it never clears a transfer on evidence it cannot see.
- **Separate gates.** The fund, the side letter, the company and the buyer are checked separately, because a consent at one level does nothing at another. Company consent and a waiver of the right of first refusal are also kept apart, because the stockholders' agreement makes each independent of the other (SA 4.6).
- **Provenance.** Every result carries its citations, the clause text is stored verbatim with its PDF page, and every computed date shows its working, for example "20 Business Days from receipt on Fri 25 Sep 2026; skips Mon 12 Oct 2026 holiday".
- **Deterministic.** The engine is plain JavaScript with no dependencies and no model in the decision path. The same facts always give the same answer, and the audit record carries a hash of the facts and the rulebook version.
- **One engine.** The demo page and the test suite call the same `evaluate()` function, so what the page shows is what the tests prove.
- **No green.** A transfer with nothing outstanding is "ready for the GP to record", which is a different thing from approved. Recording it in the register stays a human decision (LPA 8.5).

The legal judgement calls behind the rules, such as how clear days are counted and why a partial exercise goes to a lawyer, are explained in [`docs/NOTE.md`](docs/NOTE.md).

## How it works

```
facts ──▶ preliminary checks ──▶ fund ──▶ side letter ──▶ company ──▶ buyer
                                   │
                                   ▼
          verdict: BLOCKED  |  LAWYER REVIEW  |  N actions outstanding
                                   │
                                   ▼
             finding, cures or checklist, clause extracts, audit record
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

To run the tests locally (Node 18 or later, no install step):

```
node --test
```

To serve the demo locally:

```
python3 -m http.server
```

## How I built this

I wrote the specification in [`CLAUDE.md`](CLAUDE.md), drafted the three documents, set the date conventions and made every legal call in the rulebook. Claude Code wrote most of the code against that specification, one phase at a time, and I reviewed each phase before it was committed. The commit history follows those phases.

To test my own judgement, I used cross-model review: a model from a different vendor, working adversarially and without access to the build. It marked up the drafting, decided all 31 scenarios blind before seeing my expected answers, and wrote the ten held-out cases. Its findings were inputs. I decided each one, and [`docs/REVIEW-LOG.md`](docs/REVIEW-LOG.md) records what it found, what I decided and what changed. Two examples: the blind review showed that "at least five Business Days before" could be read two ways, so I redrafted the clauses to say clear days; and my own review of the engine found an unsafe clear that all 31 scenarios had missed, which is now fixed and covered by regression tests.

## Known limitations

- The documents and the holiday calendar are synthetic and simplified.
- The model covers one SPV holding one portfolio company.
- The rulebook is written by hand. A new set of documents needs a new rulebook.
- Both agreements define a change of control as a Transfer, but change-of-control events are not modelled as an event type.
- The beneficial-owner count is taken from the GP as an input.
- The company has no deadline to answer a consent request, and the GP has no deadline to record a transfer once every condition is met, so the tool tracks both steps without being able to force them.

## What I would build next

1. **An intake layer: the model reads, the rules decide.** In practice the facts arrive as an email thread, a signed consent letter and a notice with a courier receipt, not as toggles. A model would read those sources and extract each fact together with the quote it relied on. Any fact it cannot ground in a quote would be recorded as unknown, so the intake could only ever make the engine more cautious. I would measure it by writing messy source material for each of the 31 scenarios and checking that the extracted facts reproduce the expected answers.
2. **Rulebook drafting from a new agreement.** A model proposes the rules and citations for an unfamiliar stockholders' agreement, and a lawyer reviews them. Nothing would be trusted until it reproduces the answers of this hand-built rulebook on the same scenarios.
3. **Deadline tracking.** The engine already computes when a refusal period lapses, when deemed consent arises and when the completion window closes. Those dates, with their working, would feed a calendar and reminders for each live transfer.
4. **Portfolio scale.** Many SPVs across many portfolio companies, with each company's transfer policy (including public positions like OpenAI's and Anthropic's) held as its own rule pack, and change-of-control events modelled alongside sales and pledges.

## Sources

- OpenAI, [Unauthorized OpenAI equity transactions](https://openai.com/policies/unauthorized-openai-equity-transactions/)
- Anthropic, [Unauthorized Anthropic stock sales and investment scams](https://support.claude.com/en/articles/13704655-unauthorized-anthropic-stock-sales-and-investment-scams)
- TechCrunch, [Anthropic warns investors against secondary platforms offering access to its shares](https://techcrunch.com/2026/05/12/anthropic-warns-investors-against-secondary-platforms-offering-access-to-its-shares/), 12 May 2026
