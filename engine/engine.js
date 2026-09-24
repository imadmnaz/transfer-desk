'use strict';

// Pure evaluation engine: facts + rulebook + calendar -> decision.
// No I/O, no Date.now(). The demo page and the test runner both import this
// file and call the same exported evaluate() function.

// Browser wrapper: in Node (the test runner) this is a plain require. In the
// browser, dates.js has already run as a <script> tag and put its exports on
// window; there is no Node "crypto" module there, so sha256Hex() below falls
// back to a pure-JS implementation. None of the rule logic in this file
// changes between environments.
const isNode = typeof module !== 'undefined' && !!module.exports;
const crypto = isNode ? require('crypto') : null;
const dates = isNode ? require('./dates.js') : (typeof window !== 'undefined' ? window.TransferDeskDates : undefined);

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

// Pure, synchronous SHA-256 (FIPS 180-4), used only as the browser fallback
// for sha256Hex() below when Node's "crypto" module is unavailable. Browsers
// only expose an async digest (SubtleCrypto), which evaluate() cannot use
// and stay a synchronous pure function, so this produces the same standard
// SHA-256 digest by hand.
function sha256HexPure(message) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bytes = [];
  for (let i = 0; i < message.length; i++) {
    let c = message.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }

  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(Number((BigInt(bitLen) >> BigInt(i * 8)) & 0xffn));

  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let chunkStart = 0; chunkStart < bytes.length; chunkStart += 64) {
    const w = new Array(64).fill(0);
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((bytes[chunkStart + i * 4] << 24) |
          (bytes[chunkStart + i * 4 + 1] << 16) |
          (bytes[chunkStart + i * 4 + 2] << 8) |
          bytes[chunkStart + i * 4 + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
}

function sha256Hex(str) {
  if (crypto) return crypto.createHash('sha256').update(str).digest('hex');
  return sha256HexPure(str);
}

// --- Findings (headline text) ---------------------------------------------
//
// The headline (decision.headline) states the fact and its consequence in
// plain English, never a rule's technical "reason" or title. The wording for
// each rule/state lives in rulebook.json's rule.findings (legal content, per
// CLAUDE.md section 6), keyed by state name, or by an explicit finding_key
// on the result when one rule's FAILED or UNKNOWN covers more than one shape
// (see the findingKey uses above). A template of exactly "{action}" is
// replaced with that result's own action text, so it stays exactly right for
// the fact pattern that produced it instead of being re-described here.

function humanizeText(text) {
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => dates.formatReadable(m));
}

function ensureSentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function buildFinding(result, ruleMap) {
  const rule = ruleMap.get(result.rule_id);
  const findings = rule.findings || {};
  const template = findings[result.finding_key] || findings[result.state];
  if (!template) return null;
  if (template === '{action}') {
    return result.action ? ensureSentence(humanizeText(result.action.text)) : null;
  }
  return humanizeText(template);
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
      return { state: 'UNKNOWN', reason: `${partyLabel}'s consent status is not recognized.` };
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
      // Selects which entry of rulebook.json's rule.findings the headline
      // uses for this result, when a rule has more than one FAILED/UNKNOWN
      // shape (e.g. C-ROFR-RESPONSE: exercised outright vs. too-early
      // completion). Defaults to the state name in buildFinding() below.
      finding_key: extra.findingKey || null,
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
      } else if (!dates.isValidTimestamp(gpConsent.requested_at)) {
        const reason =
          'The date the General Partner received the request for consent is missing or invalid, so the deemed-consent clock cannot be shown to have started.';
        deemedConsentOutcome = { state: 'UNKNOWN', reason };
        mk('S-DEEMED-CONSENT', 'UNKNOWN', reason);
      } else {
        const receipt = dates.receivedDate(gpConsent.requested_at, calendar);
        const deemed = dates.addBusinessDays(receipt.date, 10, calendar);
        const working = dates.businessDaysWorking(receipt.date, 10, deemed, 'from receipt');
        const computed = {
          receipt: { date: receipt.date, working: receipt.working },
          deemed_at: { date: deemed.date, working },
        };
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
      // A Permitted Transferee whose notice fact is still "not_applicable"
      // (the default before this evidence has been gathered) has, as far as
      // the record shows, not yet been given notice: treat it the same as
      // "not_sent" rather than treating an unrecognised status as an error.
      case 'not_applicable':
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
        if (!dates.isValidTimestamp(notice.sent_at)) {
          mk(ruleId, 'UNKNOWN', `The date notice was delivered to ${partyLabel} is missing or invalid.`);
          return;
        }
        const receipt = dates.receivedDate(notice.sent_at, calendar);
        const earliest = dates.addBusinessDays(receipt.date, clearDays + 1, calendar);
        const working = dates.businessDaysWorking(receipt.date, clearDays + 1, earliest, 'after receipt');
        const computed = {
          receipt: { date: receipt.date, working: receipt.working },
          earliest_completion: { date: earliest.date, working },
        };
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
        mk(ruleId, 'UNKNOWN', `The notice status for ${partyLabel} is not recognized.`);
        return;
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
          } else if (!dates.isValidTimestamp(notice.sent_at)) {
            mk('C-ROFR-NOTICE', 'UNKNOWN', 'The date the Transfer Notice was delivered is missing or invalid.');
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
          mk('C-ROFR-NOTICE', 'UNKNOWN', 'The Transfer Notice status is not recognized.');
          rofrNoticeState = 'UNKNOWN';
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
            'The Company has exercised its right of first refusal in whole. The Company is buying the interest; the sale to this transferee cannot proceed.',
            { findingKey: 'FAILED_EXERCISED' }
          );
          break;
        case 'exercised_partial':
          mk(
            'C-ROFR-RESPONSE',
            'UNKNOWN',
            'The Company has purported to exercise its right of first refusal in part. SA 4.3 permits exercise in whole only; a purported partial exercise needs legal review.',
            { findingKey: 'UNKNOWN_PARTIAL' }
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
                { cure: `Move completion to after ${rofrExpiry} or obtain a written waiver`, computed, findingKey: 'FAILED_TOO_EARLY' }
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
          mk('C-ROFR-RESPONSE', 'UNKNOWN', 'The Company response to the Transfer Notice is not recognized.');
      }
    }
  }

  {
    const resp = facts.company.rofr_response;
    let applicable = false;
    let referenceDate = null;
    let dateMissing = false;
    if (!rofrApplies) {
      applicable = false;
    } else if (resp.status === 'waived') {
      if (!dates.isValidDateOnly(resp.at)) {
        dateMissing = true;
      } else {
        applicable = true;
        referenceDate = rofrExpiry !== null && rofrExpiry < resp.at ? rofrExpiry : resp.at;
      }
    } else if (resp.status === 'none' && rofrNoticeState === 'SATISFIED' && facts.as_of > rofrExpiry) {
      applicable = true;
      referenceDate = rofrExpiry;
    }
    if (dateMissing) {
      mk(
        'C-ROFR-WINDOW',
        'UNKNOWN',
        'The date the Company waived its right of first refusal is missing, so the completion window cannot be computed.'
      );
    } else if (!applicable) {
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
      const windowStartWorking =
        resp.status === 'waived'
          ? rofrExpiry !== null && rofrExpiry < resp.at
            ? `The exercise period ended ${dates.formatReadable(rofrExpiry)}, before the waiver on ${dates.formatReadable(resp.at)}, so the window runs from the earlier date.`
            : `The Company waived its right of first refusal on ${dates.formatReadable(resp.at)}.`
          : `The exercise period ended ${dates.formatReadable(rofrExpiry)} without exercise.`;
      const computed = {
        window_start: { date: referenceDate, working: windowStartWorking },
        window_end: { date: windowEnd.date, working },
      };
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
    const [state, reason] = map[facts.buyer.kyc] || ['UNKNOWN', 'KYC status is not recognized.'];
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
    const [state, reason] = map[facts.buyer.sanctions] || ['UNKNOWN', 'Sanctions screening status is not recognized.'];
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
      const [state, reason] = map[facts.buyer.accredited] || ['UNKNOWN', 'Accredited investor status is not recognized.'];
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

  function withOtherIssues(finding, extraCount) {
    if (extraCount <= 0) return finding;
    const trimmed = finding.replace(/[.!?]$/, '');
    return `${trimmed} and ${extraCount} other issue${extraCount === 1 ? '' : 's'} below.`;
  }

  let headline;
  if (verdict === 'BLOCKED') {
    const failed = results.filter((r) => r.state === 'FAILED');
    const finding = buildFinding(failed[0], ruleMap) || `Blocked: ${ruleMap.get(failed[0].rule_id).title}.`;
    headline = withOtherIssues(finding, failed.length - 1);
  } else if (verdict === 'ESCALATE') {
    const escalated = results.filter((r) => r.state === 'UNKNOWN' || r.state === 'CONTRADICTORY');
    const finding = buildFinding(escalated[0], ruleMap) || `Needs legal judgement: ${ruleMap.get(escalated[0].rule_id).title}.`;
    headline = withOtherIssues(finding, escalated.length - 1);
  } else {
    const outstanding = results.filter((r) => r.state === 'OUTSTANDING');
    if (outstanding.length > 0) {
      headline =
        buildFinding(outstanding[0], ruleMap) ||
        `${outstanding.length} action${outstanding.length === 1 ? '' : 's'} outstanding before the GP can record this transfer.`;
    } else {
      headline = 'Every condition is evidenced. Recording in the Register is a human decision.';
    }
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

  const auditId = sha256Hex(`${stableStringify(facts)}|${rulebook.rulebook_version}`).slice(0, 16);

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

const EngineModule = { evaluate, deepMergeFacts, ENGINE_VERSION };

if (isNode) {
  module.exports = EngineModule;
}
if (typeof window !== 'undefined') {
  window.TransferDeskEngine = EngineModule;
}
