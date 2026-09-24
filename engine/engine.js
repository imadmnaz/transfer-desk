'use strict';

// Pure evaluation engine: facts + rulebook + calendar -> decision.
// No I/O, no Date.now(). The demo page and the test runner both import this
// file and call the same exported evaluate() function.

const crypto = require('crypto');
const dates = require('./dates.js');

const ENGINE_VERSION = '1.0.0';

const LPA_PERMITTED_RELATIONSHIPS = ['affiliate', 'family_trust', 'estate'];
const SA_PERMITTED_RELATIONSHIPS = ['affiliate', 'family_trust', 'estate'];

// --- Deep merge -------------------------------------------------------
//
// Every scenario deep-merges its overrides onto base-facts. Plain objects
// merge recursively, key by key, EXCEPT the six "status objects" below,
// which are always replaced wholesale by an override. Each of those
// objects has a different shape depending on its status field (e.g.
// "received" carries received_at, "requested" carries requested_at), so
// merging them key by key would leave stale fields from the base object
// behind (see tests/engine.test.js for a regression test of this).

const ATOMIC_PATHS = new Set([
  'fund.gp_consent',
  'fund.gp_permitted_notice',
  'company.consent',
  'company.permitted_notice',
  'company.rofr_notice',
  'company.rofr_response',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergeAt(base, overrides, path) {
  if (!isPlainObject(overrides)) return overrides;
  const result = { ...(isPlainObject(base) ? base : {}) };
  for (const key of Object.keys(overrides)) {
    const childPath = path ? `${path}.${key}` : key;
    const overrideVal = overrides[key];
    if (ATOMIC_PATHS.has(childPath) || !isPlainObject(overrideVal) || !isPlainObject(base[key])) {
      result[key] = overrideVal;
    } else {
      result[key] = mergeAt(base[key], overrideVal, childPath);
    }
  }
  return result;
}

function deepMergeFacts(baseFacts, overrides) {
  return mergeAt(baseFacts, overrides, '');
}

// --- Small helpers ------------------------------------------------------

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function usd(n) {
  return `US$${n.toLocaleString('en-US')}`;
}

function consentOutcome(status, partyLabel, silenceCitationText) {
  switch (status) {
    case 'received':
      return { state: 'SATISFIED', reason: `${partyLabel}'s written consent has been received.` };
    case 'refused':
      return { state: 'FAILED', reason: `${partyLabel} has refused consent.` };
    case 'not_requested':
      return {
        state: 'OUTSTANDING',
        reason: `${partyLabel}'s consent has not yet been requested.`,
        action: { owner: 'Ops', text: `Request ${partyLabel}'s written consent`, due: null },
      };
    case 'requested':
      return {
        state: 'OUTSTANDING',
        reason: `${partyLabel}'s written consent has been requested but not received. Silence is not consent (${silenceCitationText}).`,
        action: { owner: 'Ops', text: `Chase ${partyLabel} for written consent`, due: null },
      };
    case 'unknown':
      return { state: 'UNKNOWN', reason: `${partyLabel}'s consent status is unclear from the evidence provided.` };
    case 'contradictory':
      return { state: 'CONTRADICTORY', reason: `The evidence of ${partyLabel}'s consent is contradictory.` };
    default:
      throw new Error(`Unknown consent status: ${status}`);
  }
}

// --- The engine -----------------------------------------------------------

function evaluate(facts, rulebook, calendar) {
  const ruleMap = new Map(rulebook.rules.map((r) => [r.id, r]));
  const results = [];
  const notes = [];
  const t = facts.transfer;
  const isPledge = t.kind === 'pledge';
  const isSale = t.kind === 'sale';

  function mk(id, state, reason, extra = {}) {
    const rule = ruleMap.get(id);
    if (!rule) throw new Error(`Unknown rule id: ${id}`);
    const result = {
      rule_id: id,
      gate: rule.gate,
      state,
      reason,
      citations: rule.citations,
      action: extra.action || null,
      cure: extra.cure || null,
      notes: extra.notes || [],
      computed: extra.computed || null,
    };
    results.push(result);
    return result;
  }

  // --- Preliminary --------------------------------------------------------

  {
    let note = null;
    if (t.operator_classification === 'not_a_transfer') {
      note = `The operator's classification is rejected: a ${t.kind} of an Interest is a Transfer under LPA 1.1 and SA 1.1, and is evaluated as one.`;
      notes.push(note);
    }
    mk(
      'X-CLASSIFY',
      'SATISFIED',
      `This ${t.kind} is a Transfer under both the LPA and the Stockholders' Agreement.`,
      { notes: note ? [note] : [] }
    );
  }

  {
    if (facts.documents_version_confirmed === 'yes') {
      mk('X-VERSION', 'SATISFIED', 'The evidence was confirmed against the current version of the governing documents.');
    } else {
      mk('X-VERSION', 'UNKNOWN', 'The evidence may have been prepared against a superseded version of the governing documents.');
    }
  }

  // --- Side letter gate -----------------------------------------------------

  const sideLetterClaimed = facts.fund.claimed_side_letter === 'harbour';
  const sideLetterApplies = t.transferor === 'Harbour Family Office LLC';

  {
    if (sideLetterClaimed && !sideLetterApplies) {
      const note = 'The Harbour side letter rights are personal to Harbour and cannot be relied on by any other Limited Partner.';
      notes.push(note);
      mk('S-SCOPE', 'NOT_APPLICABLE', 'The transferor is not Harbour Family Office LLC, so the Harbour side letter does not apply.', {
        notes: [note],
      });
    } else if (sideLetterApplies) {
      mk('S-SCOPE', 'SATISFIED', 'The transferor is Harbour Family Office LLC, so the Harbour side letter applies.');
    } else {
      mk('S-SCOPE', 'NOT_APPLICABLE', 'The transferor is not Harbour Family Office LLC, so the Harbour side letter does not apply.');
    }
  }

  const isHarbourTransfereeRelationship = t.transferee_relationship === 'harbour_transferee' || t.transferee_relationship === 'affiliate';
  const harbourTransfereeGranted = sideLetterApplies && isHarbourTransfereeRelationship;

  {
    if (harbourTransfereeGranted) {
      mk('S-HARBOUR-TRANSFEREE', 'SATISFIED', 'The transferee is a Harbour Transferee, so General Partner consent is not required.');
    } else if (sideLetterApplies) {
      mk('S-HARBOUR-TRANSFEREE', 'NOT_APPLICABLE', 'The transferee is not a Harbour Transferee.');
    } else {
      mk('S-HARBOUR-TRANSFEREE', 'NOT_APPLICABLE', 'The Harbour side letter does not apply.');
    }
  }

  let deemedConsentOutcome = null;
  {
    const gpConsent = facts.fund.gp_consent;
    if (!sideLetterApplies) {
      mk('S-DEEMED-CONSENT', 'NOT_APPLICABLE', 'The Harbour side letter does not apply.');
    } else if (gpConsent.status !== 'requested') {
      mk(
        'S-DEEMED-CONSENT',
        'NOT_APPLICABLE',
        "The General Partner's consent has not been requested, so the deemed-consent clock has not started."
      );
    } else {
      const complete = gpConsent.complete === undefined ? 'yes' : gpConsent.complete;
      if (complete === 'no') {
        const action = { owner: 'Ops', text: 'Send a complete request for General Partner consent under SL para 2', due: null };
        const reason = 'The request for consent was not complete under SL para 2, so the deemed-consent clock has not started.';
        deemedConsentOutcome = { state: 'OUTSTANDING', reason, action };
        mk('S-DEEMED-CONSENT', 'OUTSTANDING', reason, { action });
      } else if (complete === 'unknown') {
        const reason =
          'It cannot be shown that the request for consent was complete under SL para 2, so the deemed-consent clock cannot be shown to have started.';
        deemedConsentOutcome = { state: 'UNKNOWN', reason };
        mk('S-DEEMED-CONSENT', 'UNKNOWN', reason);
      } else {
        const receipt = dates.receivedDate(gpConsent.requested_at, calendar);
        const deemed = dates.addBusinessDays(receipt.date, 10, calendar);
        const working = dates.businessDaysWorking(receipt.date, 10, deemed, 'from receipt');
        const computed = { deemed_at: { date: deemed.date, working } };
        if (facts.as_of > deemed.date) {
          const reason = `The General Partner did not respond within ten Business Days of receipt of a complete request, so its consent is deemed given as of the end of ${dates.formatReadable(deemed.date)}.`;
          deemedConsentOutcome = { state: 'SATISFIED', reason, computed };
          mk('S-DEEMED-CONSENT', 'SATISFIED', reason, { computed });
        } else {
          const action = {
            owner: 'Ops',
            text: 'Wait for the General Partner to respond, or for consent to be deemed given',
            due: deemed.date,
          };
          const reason = 'The ten Business Day period for deemed consent has not yet ended.';
          deemedConsentOutcome = { state: 'OUTSTANDING', reason, computed, action };
          mk('S-DEEMED-CONSENT', 'OUTSTANDING', reason, { computed, action });
        }
      }
    }
  }

  // --- Fund gate --------------------------------------------------------

  {
    const isLpaPermitted = LPA_PERMITTED_RELATIONSHIPS.includes(t.transferee_relationship);
    if (isLpaPermitted) {
      mk('F-CONSENT', 'NOT_APPLICABLE', 'The transferee is a Permitted Transferee under LPA 8.2, so General Partner consent is not required.');
    } else if (harbourTransfereeGranted) {
      mk('F-CONSENT', 'NOT_APPLICABLE', 'The transferee is a Harbour Transferee under the side letter, so General Partner consent is not required.');
    } else if (sideLetterApplies && deemedConsentOutcome) {
      mk('F-CONSENT', deemedConsentOutcome.state, deemedConsentOutcome.reason, {
        action: deemedConsentOutcome.action || null,
        computed: deemedConsentOutcome.computed || null,
      });
    } else {
      const outcome = consentOutcome(facts.fund.gp_consent.status, 'The General Partner', 'LPA 8.8');
      mk('F-CONSENT', outcome.state, outcome.reason, { action: outcome.action || null });
    }
  }

  function evaluatePermittedNotice(ruleId, notice, clearDays, partyLabel) {
    switch (notice.status) {
      case 'not_sent':
        mk(ruleId, 'OUTSTANDING', `Written notice of the Transfer has not yet been sent to ${partyLabel}.`, {
          action: {
            owner: 'Ops',
            text: `Send written notice of the Transfer to ${partyLabel} at least ${clearDays} clear Business Days before completion`,
            due: null,
          },
        });
        return;
      case 'sent_no_proof':
        mk(ruleId, 'UNKNOWN', `Notice was reportedly sent to ${partyLabel} but delivery cannot be evidenced.`);
        return;
      case 'delivered': {
        const receipt = dates.receivedDate(notice.sent_at, calendar);
        const earliest = dates.addBusinessDays(receipt.date, clearDays + 1, calendar);
        const working = dates.businessDaysWorking(receipt.date, clearDays + 1, earliest, 'after receipt');
        const computed = { earliest_completion: { date: earliest.date, working } };
        if (t.proposed_completion >= earliest.date) {
          mk(
            ruleId,
            'SATISFIED',
            `Notice was received on ${dates.formatReadable(receipt.date)}. Completion on ${dates.formatReadable(t.proposed_completion)} is on or after the earliest permitted date of ${dates.formatReadable(earliest.date)}.`,
            { computed }
          );
        } else {
          computed.cure_date = { date: earliest.date, working };
          mk(
            ruleId,
            'FAILED',
            `Notice was received on ${dates.formatReadable(receipt.date)}. Completion on ${dates.formatReadable(t.proposed_completion)} is before the earliest permitted date of ${dates.formatReadable(earliest.date)}.`,
            { cure: `Move completion to on or after ${earliest.date}`, computed }
          );
        }
        return;
      }
      default:
        throw new Error(`Unhandled notice status for ${ruleId}: ${notice.status}`);
    }
  }

  {
    const isLpaPermitted = LPA_PERMITTED_RELATIONSHIPS.includes(t.transferee_relationship);
    if (!isLpaPermitted) {
      mk('F-PERMITTED-NOTICE', 'NOT_APPLICABLE', 'The transferee is not a Permitted Transferee under LPA 1.1, so this notice requirement does not apply.');
    } else {
      evaluatePermittedNotice('F-PERMITTED-NOTICE', facts.fund.gp_permitted_notice, 5, 'the General Partner');
    }
  }

  {
    if (t.fraction >= 1) {
      mk('F-MIN-HOLDING', 'NOT_APPLICABLE', 'The transferor is Transferring its entire Interest, so the minimum holding requirement does not apply.');
    } else {
      const transferred = t.transferor_capital_contribution * t.fraction;
      const retained = t.transferor_capital_contribution - transferred;
      const min = 10000;
      if (transferred < min || retained < min) {
        mk(
          'F-MIN-HOLDING',
          'FAILED',
          `The Transfer would leave the transferee with ${usd(transferred)} and the transferor with ${usd(retained)}. Both must be at least ${usd(min)}.`,
          {
            cure: `Increase the fraction Transferred so that both the transferee's and the transferor's remaining Capital Contribution are at least ${usd(min)}, or transfer the entire Interest.`,
          }
        );
      } else {
        mk(
          'F-MIN-HOLDING',
          'SATISFIED',
          `The Transfer leaves the transferee with ${usd(transferred)} and the transferor with ${usd(retained)}, both at least ${usd(min)}.`
        );
      }
    }
  }

  {
    if (isPledge) {
      mk('F-BO-LIMIT', 'NOT_APPLICABLE', 'The Beneficial Owner Limit does not apply to a pledge.');
    } else {
      const current = facts.fund.beneficial_owners_current;
      if (current === null || current === undefined) {
        mk('F-BO-LIMIT', 'UNKNOWN', 'The current number of beneficial owners is not known.');
      } else {
        const transfereeIsNew = !t.transferee_existing_lp;
        const transferorExitsFully = t.fraction >= 1;
        const newCount = current + (transfereeIsNew ? 1 : 0) - (transferorExitsFully ? 1 : 0);
        const limit = 95;
        if (newCount > limit) {
          mk(
            'F-BO-LIMIT',
            'FAILED',
            `The Transfer would bring the Partnership to ${newCount} beneficial owners, above the Beneficial Owner Limit of ${limit}.`,
            { cure: 'Reduce the number of beneficial owners below the limit before completion, for example by transferring to an existing Limited Partner.' }
          );
        } else {
          mk(
            'F-BO-LIMIT',
            'SATISFIED',
            `The Transfer would bring the Partnership to ${newCount} beneficial owners, within the Beneficial Owner Limit of ${limit}.`
          );
        }
      }
    }
  }

  // --- Company gate -----------------------------------------------------

  {
    const comp = t.transferee_is_competitor;
    if (comp === 'yes') {
      mk('C-COMPETITOR', 'FAILED', `${t.transferee} is a Competitor listed in SA Schedule 2, or an Affiliate of one. No consent can cure this.`);
    } else if (comp === 'unknown') {
      mk('C-COMPETITOR', 'UNKNOWN', 'It is not known whether the transferee is a Competitor.');
    } else {
      mk('C-COMPETITOR', 'SATISFIED', `${t.transferee} is not a Competitor.`);
    }
  }

  const isSaPermitted = SA_PERMITTED_RELATIONSHIPS.includes(t.transferee_relationship);

  {
    if (isSaPermitted) {
      mk('C-CONSENT', 'NOT_APPLICABLE', 'The transferee is a Permitted Transferee under SA 1.1, so Company consent is not required.');
    } else {
      const outcome = consentOutcome(facts.company.consent.status, 'The Company', 'SA 3.4');
      mk('C-CONSENT', outcome.state, outcome.reason, { action: outcome.action || null });
    }
  }

  {
    if (!isSaPermitted) {
      mk('C-PERMITTED-NOTICE', 'NOT_APPLICABLE', 'The transferee is not a Permitted Transferee under SA 1.1, so this notice requirement does not apply.');
    } else {
      evaluatePermittedNotice('C-PERMITTED-NOTICE', facts.company.permitted_notice, 10, 'the Company');
    }
  }

  // The right of first refusal applies whenever the company gate applies: a
  // sale to anyone other than an SA Permitted Transferee. C-ROFR-RESPONSE and
  // C-ROFR-WINDOW are gated on this alone, not on whether the Transfer Notice
  // happens to be evidenced: a recorded exercise or waiver is real regardless
  // of whether the notice that preceded it can be proven (see REVIEW-LOG.md,
  // Round 3 - missing notice evidence must never hide a recorded exercise).
  const rofrApplies = !isPledge && !isSaPermitted;

  let rofrNoticeState = null;
  let rofrExpiry = null;
  let rofrExpiryWorking = null;

  {
    if (!rofrApplies) {
      mk(
        'C-ROFR-NOTICE',
        'NOT_APPLICABLE',
        isPledge
          ? 'The right of first refusal applies only to a sale; this is a pledge.'
          : 'The transferee is a Permitted Transferee under SA 1.1, so the right of first refusal does not apply.'
      );
      rofrNoticeState = 'NOT_APPLICABLE';
    } else {
      const notice = facts.company.rofr_notice;
      switch (notice.status) {
        case 'not_sent':
          mk('C-ROFR-NOTICE', 'OUTSTANDING', 'A Transfer Notice has not yet been served on the Company.', {
            action: { owner: 'Ops', text: 'Serve a complete Transfer Notice on the Company', due: null },
          });
          rofrNoticeState = 'OUTSTANDING';
          break;
        case 'sent_no_proof':
          mk(
            'C-ROFR-NOTICE',
            'UNKNOWN',
            'A Transfer Notice was reportedly sent, but delivery cannot be evidenced, so the exercise period cannot be shown to have started.'
          );
          rofrNoticeState = 'UNKNOWN';
          break;
        case 'delivered':
          if (notice.complete === 'no') {
            mk('C-ROFR-NOTICE', 'OUTSTANDING', 'The Transfer Notice served was not complete, so the exercise period has not started.', {
              action: { owner: 'Ops', text: 'Serve a complete Transfer Notice on the Company', due: null },
            });
            rofrNoticeState = 'OUTSTANDING';
          } else if (notice.complete === 'unknown') {
            mk(
              'C-ROFR-NOTICE',
              'UNKNOWN',
              'It cannot be shown that the Transfer Notice served was complete, so the exercise period cannot be shown to have started.'
            );
            rofrNoticeState = 'UNKNOWN';
          } else {
            const receipt = dates.receivedDate(notice.sent_at, calendar);
            const expiry = dates.addBusinessDays(receipt.date, 20, calendar);
            const working = dates.businessDaysWorking(receipt.date, 20, expiry, 'from receipt');
            rofrExpiry = expiry.date;
            rofrExpiryWorking = working;
            mk('C-ROFR-NOTICE', 'SATISFIED', `A complete Transfer Notice was received on ${dates.formatReadable(receipt.date)}.`, {
              computed: {
                receipt: { date: receipt.date, working: receipt.working },
                expiry: { date: expiry.date, working },
              },
            });
            rofrNoticeState = 'SATISFIED';
          }
          break;
        default:
          throw new Error(`Unhandled rofr_notice status: ${notice.status}`);
      }
    }
  }

  {
    if (!rofrApplies) {
      mk(
        'C-ROFR-RESPONSE',
        'NOT_APPLICABLE',
        isPledge
          ? 'The right of first refusal applies only to a sale; this is a pledge.'
          : 'The transferee is a Permitted Transferee under SA 1.1, so the right of first refusal does not apply.'
      );
    } else {
      const resp = facts.company.rofr_response;
      switch (resp.status) {
        case 'waived':
          mk('C-ROFR-RESPONSE', 'SATISFIED', 'The Company has waived its right of first refusal.');
          break;
        case 'exercised_whole':
          mk(
            'C-ROFR-RESPONSE',
            'FAILED',
            'The Company has exercised its right of first refusal in whole. The Company is buying the interest; the sale to this transferee cannot proceed.'
          );
          break;
        case 'exercised_partial':
          mk(
            'C-ROFR-RESPONSE',
            'UNKNOWN',
            'The Company has purported to exercise its right of first refusal in part. SA 4.3 permits exercise in whole only; a purported partial exercise needs legal review.'
          );
          break;
        case 'unknown':
          mk('C-ROFR-RESPONSE', 'UNKNOWN', 'It is not known whether the Company has responded to the Transfer Notice.');
          break;
        case 'none': {
          if (rofrNoticeState === 'SATISFIED') {
            const computed = { expiry: { date: rofrExpiry, working: rofrExpiryWorking } };
            if (facts.as_of > rofrExpiry) {
              mk(
                'C-ROFR-RESPONSE',
                'SATISFIED',
                `The Company did not exercise its right of first refusal within the exercise period, which ended ${dates.formatReadable(rofrExpiry)}.`,
                { computed }
              );
            } else if (t.proposed_completion <= rofrExpiry) {
              mk(
                'C-ROFR-RESPONSE',
                'FAILED',
                `Completion is scheduled for ${dates.formatReadable(t.proposed_completion)}, on or before the end of the exercise period on ${dates.formatReadable(rofrExpiry)}.`,
                { cure: `Move completion to after ${rofrExpiry} or obtain a written waiver`, computed }
              );
            } else {
              mk(
                'C-ROFR-RESPONSE',
                'OUTSTANDING',
                `The exercise period is still running. It ends ${dates.formatReadable(rofrExpiry)}.`,
                {
                  action: {
                    owner: 'Ops',
                    text: `Wait until ${rofrExpiry} or obtain a written waiver of the right of first refusal`,
                    due: rofrExpiry,
                  },
                  computed,
                }
              );
            }
          } else if (rofrNoticeState === 'OUTSTANDING') {
            mk('C-ROFR-RESPONSE', 'OUTSTANDING', 'The exercise period has not started: a complete Transfer Notice has not yet been served.');
          } else {
            // rofrNoticeState === 'UNKNOWN'
            mk(
              'C-ROFR-RESPONSE',
              'UNKNOWN',
              'It is not known whether the exercise period has started, because the Transfer Notice evidence is incomplete.'
            );
          }
          break;
        }
        default:
          throw new Error(`Unhandled rofr_response status: ${resp.status}`);
      }
    }
  }

  {
    const resp = facts.company.rofr_response;
    let applicable = false;
    let referenceDate = null;
    if (!rofrApplies) {
      applicable = false;
    } else if (resp.status === 'waived') {
      applicable = true;
      referenceDate = rofrExpiry !== null && rofrExpiry < resp.at ? rofrExpiry : resp.at;
    } else if (resp.status === 'none' && rofrNoticeState === 'SATISFIED' && facts.as_of > rofrExpiry) {
      applicable = true;
      referenceDate = rofrExpiry;
    }
    if (!applicable) {
      mk(
        'C-ROFR-WINDOW',
        'NOT_APPLICABLE',
        !rofrApplies
          ? 'The right of first refusal does not apply.'
          : 'The completion window is only evaluated once the right of first refusal has expired or been waived.'
      );
    } else {
      const windowEnd = dates.addBusinessDays(referenceDate, 45, calendar);
      const working = dates.businessDaysWorking(referenceDate, 45, windowEnd, 'from the end of the exercise period or waiver');
      const computed = { window_end: { date: windowEnd.date, working } };
      if (t.proposed_completion > windowEnd.date) {
        mk(
          'C-ROFR-WINDOW',
          'FAILED',
          `Completion on ${dates.formatReadable(t.proposed_completion)} is after the completion window, which ends ${dates.formatReadable(windowEnd.date)}.`,
          { cure: 'Serve a fresh Transfer Notice', computed }
        );
      } else {
        mk(
          'C-ROFR-WINDOW',
          'SATISFIED',
          `Completion on ${dates.formatReadable(t.proposed_completion)} is within the completion window, which ends ${dates.formatReadable(windowEnd.date)}.`,
          { computed }
        );
      }
    }
  }

  {
    if (isSale && !isSaPermitted) {
      notes.push(rulebook.cross_cutting_notes[0].text);
    }
  }

  // --- Buyer and regulatory gate --------------------------------------------

  {
    const map = {
      cleared: ['SATISFIED', 'KYC checks are complete.'],
      pending: ['OUTSTANDING', 'KYC checks are in progress.'],
      not_started: ['OUTSTANDING', 'KYC checks have not started.'],
      unknown: ['UNKNOWN', 'KYC status is not known.'],
    };
    const [state, reason] = map[facts.buyer.kyc];
    const extra = state === 'OUTSTANDING' ? { action: { owner: 'Ops', text: 'Complete KYC / AML checks for the transferee', due: null } } : {};
    mk('B-KYC', state, reason, extra);
  }

  {
    const map = {
      clear: ['SATISFIED', 'Sanctions screening is clear.'],
      hit: ['FAILED', 'Sanctions screening returned a hit.'],
      pending: ['OUTSTANDING', 'Sanctions screening is in progress.'],
      unknown: ['UNKNOWN', 'Sanctions screening status is not known.'],
    };
    const [state, reason] = map[facts.buyer.sanctions];
    const extra = state === 'OUTSTANDING' ? { action: { owner: 'Ops', text: 'Complete sanctions screening for the transferee', due: null } } : {};
    mk('B-SANCTIONS', state, reason, extra);
  }

  {
    if (isPledge) {
      mk('B-ACCREDITED', 'NOT_APPLICABLE', 'Accredited investor status is not required for a pledge unless and until the security is enforced.');
    } else {
      const map = {
        confirmed: ['SATISFIED', 'The transferee is confirmed as an accredited investor.'],
        not_accredited: ['FAILED', 'The transferee is not an accredited investor.'],
        unknown: ['UNKNOWN', 'Accredited investor status is not known.'],
      };
      const [state, reason] = map[facts.buyer.accredited];
      mk('B-ACCREDITED', state, reason);
    }
  }

  {
    if (isPledge) {
      mk('B-TAX-FORM', 'NOT_APPLICABLE', 'A tax form is not required for a pledge unless and until the security is enforced.');
    } else {
      const state = facts.buyer.tax_form === 'received' ? 'SATISFIED' : 'OUTSTANDING';
      const extra =
        state === 'OUTSTANDING' ? { action: { owner: 'Ops', text: 'Obtain a properly completed IRS Form W-9 or applicable Form W-8', due: null } } : {};
      mk('B-TAX-FORM', state, state === 'SATISFIED' ? 'A properly completed tax form has been received.' : 'The tax form is outstanding.', extra);
    }
  }

  {
    if (isPledge) {
      mk('B-ADHERENCE', 'NOT_APPLICABLE', 'A Transfer and Adherence Agreement is not required for a pledge unless and until the security is enforced.');
    } else {
      const state = facts.buyer.adherence === 'signed' ? 'SATISFIED' : 'OUTSTANDING';
      const extra =
        state === 'OUTSTANDING' ? { action: { owner: 'Ops', text: 'Obtain a signed Transfer and Adherence Agreement from the transferee', due: null } } : {};
      mk(
        'B-ADHERENCE',
        state,
        state === 'SATISFIED' ? 'A signed Transfer and Adherence Agreement has been received.' : 'The Transfer and Adherence Agreement is outstanding.',
        extra
      );
    }
  }

  // --- Override (audit-only; never affects state or verdict) ------------

  let overrideAudit = null;
  if (facts.override) {
    overrideAudit = { by: facts.override.by, reason: facts.override.reason, accepted: false };
    notes.push(
      `An operator override was recorded by ${facts.override.by} ("${facts.override.reason}") but is rejected. It does not change this decision.`
    );
  }

  // --- Verdict ------------------------------------------------------------

  const hasFailed = results.some((r) => r.state === 'FAILED');
  const hasUnknownOrContradictory = results.some((r) => r.state === 'UNKNOWN' || r.state === 'CONTRADICTORY');

  let verdict;
  if (hasFailed) verdict = 'BLOCKED';
  else if (hasUnknownOrContradictory) verdict = 'ESCALATE';
  else verdict = 'CHECKLIST_READY';

  let headline;
  if (verdict === 'BLOCKED') {
    const failedTitles = results.filter((r) => r.state === 'FAILED').map((r) => ruleMap.get(r.rule_id).title);
    headline = `Blocked: ${failedTitles.join('; ')}.`;
  } else if (verdict === 'ESCALATE') {
    const escalatedTitles = results
      .filter((r) => r.state === 'UNKNOWN' || r.state === 'CONTRADICTORY')
      .map((r) => ruleMap.get(r.rule_id).title);
    headline = `Needs legal judgement: ${escalatedTitles.join('; ')}.`;
  } else {
    const outstandingCount = results.filter((r) => r.state === 'OUTSTANDING').length;
    headline =
      outstandingCount > 0
        ? `${outstandingCount} action${outstandingCount === 1 ? '' : 's'} outstanding before the GP can record this transfer.`
        : 'Every condition is evidenced. Recording in the Register is a human decision.';
  }

  // --- Checklist ------------------------------------------------------------

  let checklist = [];
  if (verdict === 'BLOCKED') {
    checklist = results
      .filter((r) => r.state === 'FAILED')
      .map((r) => ({ owner: null, text: r.reason, cure: r.cure, due: null, source_rule: r.rule_id }));
  } else if (verdict === 'ESCALATE') {
    const escalated = results.filter((r) => r.state === 'UNKNOWN' || r.state === 'CONTRADICTORY');
    checklist.push({
      owner: 'Lawyer',
      text: `Lawyer review needed: ${escalated.map((r) => ruleMap.get(r.rule_id).title).join(', ')}`,
      due: null,
      source_rule: null,
    });
    results
      .filter((r) => r.state === 'OUTSTANDING' && r.action)
      .forEach((r) => checklist.push({ ...r.action, source_rule: r.rule_id }));
  } else {
    results
      .filter((r) => r.state === 'OUTSTANDING' && r.action)
      .forEach((r) => checklist.push({ ...r.action, source_rule: r.rule_id }));
    checklist.push({ owner: 'Transferor', text: 'Transferor pays transfer costs (LPA 8.7)', due: null, source_rule: null });
    checklist.push({
      owner: 'GP',
      text: 'GP records the transfer in the Register once every condition is evidenced (LPA 8.5)',
      due: null,
      source_rule: null,
    });
  }

  // --- Audit ------------------------------------------------------------

  const auditId = crypto
    .createHash('sha256')
    .update(`${stableStringify(facts)}|${rulebook.rulebook_version}`)
    .digest('hex')
    .slice(0, 16);

  return {
    verdict,
    headline,
    results,
    checklist,
    notes,
    audit: {
      id: auditId,
      as_of: facts.as_of,
      engine_version: ENGINE_VERSION,
      rulebook_version: rulebook.rulebook_version,
      facts,
      override: overrideAudit,
    },
  };
}

module.exports = { evaluate, deepMergeFacts, ENGINE_VERSION };
