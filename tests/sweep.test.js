'use strict';

// Property test: every combination of the facts below, evaluated against
// base-facts.json, must obey two invariants regardless of how the other
// facts land. This is not a substitute for the known-answer scenarios (it
// asserts coarse safety properties, not exact states); it exists to catch
// exactly the kind of gap Round 3 of the review log found: a state that
// should force BLOCKED or ESCALATE slipping through to CHECKLIST_READY in
// some combination nobody thought to write a scenario for.
//
// Run as part of `node --test` (see below for the time budget), or on its
// own with `node tests/sweep.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { evaluate, deepMergeFacts } = require('../engine/engine.js');

const dataDir = path.join(__dirname, '..', 'data');
const rulebook = JSON.parse(fs.readFileSync(path.join(dataDir, 'rulebook.json'), 'utf8'));
const calendar = JSON.parse(fs.readFileSync(path.join(dataDir, 'calendar.json'), 'utf8'));
const baseFacts = JSON.parse(fs.readFileSync(path.join(dataDir, 'base-facts.json'), 'utf8'));

// --- Axes -------------------------------------------------------------
//
// Each axis is a list of { key, overrides }. `overrides` is applied with
// the same deep-merge rules the engine itself uses (status objects replace
// wholesale), so combining axes is just repeated deepMergeFacts calls.

const RELATIONSHIP = [
  { key: 'unrelated', overrides: { transfer: { transferee_relationship: 'unrelated' } } },
  {
    key: 'affiliate',
    overrides: {
      transfer: { transferee_relationship: 'affiliate' },
      fund: { gp_permitted_notice: { status: 'delivered', sent_at: '2026-09-15T10:00' } },
      company: { permitted_notice: { status: 'delivered', sent_at: '2026-09-15T10:00' } },
    },
  },
  { key: 'harbour_transferee', overrides: { transfer: { transferee_relationship: 'harbour_transferee' } } },
];

const COMPETITOR = [
  { key: 'no', overrides: { transfer: { transferee_is_competitor: 'no' } } },
  { key: 'yes', overrides: { transfer: { transferee_is_competitor: 'yes' } } },
  { key: 'unknown', overrides: { transfer: { transferee_is_competitor: 'unknown' } } },
];

const GP_CONSENT = [
  { key: 'received', overrides: { fund: { gp_consent: { status: 'received', received_at: '2026-08-24T11:00' } } } },
  { key: 'refused', overrides: { fund: { gp_consent: { status: 'refused' } } } },
  { key: 'unknown', overrides: { fund: { gp_consent: { status: 'unknown' } } } },
  { key: 'contradictory', overrides: { fund: { gp_consent: { status: 'contradictory' } } } },
  { key: 'not_requested', overrides: { fund: { gp_consent: { status: 'not_requested' } } } },
  {
    key: 'requested_complete_unknown',
    overrides: { fund: { gp_consent: { status: 'requested', requested_at: '2026-09-10T10:00', complete: 'unknown' } } },
  },
];

const COMPANY_CONSENT = [
  { key: 'received', overrides: { company: { consent: { status: 'received', received_at: '2026-09-02T15:00' } } } },
  { key: 'refused', overrides: { company: { consent: { status: 'refused' } } } },
  { key: 'unknown', overrides: { company: { consent: { status: 'unknown' } } } },
  { key: 'contradictory', overrides: { company: { consent: { status: 'contradictory' } } } },
  { key: 'not_requested', overrides: { company: { consent: { status: 'not_requested' } } } },
];

const ROFR_NOTICE = [
  {
    key: 'delivered_complete_yes',
    overrides: { company: { rofr_notice: { status: 'delivered', sent_at: '2026-08-20T10:00', complete: 'yes', proof_of_delivery: 'yes' } } },
  },
  { key: 'not_sent', overrides: { company: { rofr_notice: { status: 'not_sent' } } } },
  {
    key: 'sent_no_proof',
    overrides: { company: { rofr_notice: { status: 'sent_no_proof', sent_at: '2026-08-20T10:00', complete: 'yes', proof_of_delivery: 'no' } } },
  },
  {
    key: 'delivered_complete_unknown',
    overrides: { company: { rofr_notice: { status: 'delivered', sent_at: '2026-08-20T10:00', complete: 'unknown', proof_of_delivery: 'yes' } } },
  },
  {
    key: 'delivered_complete_no',
    overrides: { company: { rofr_notice: { status: 'delivered', sent_at: '2026-08-20T10:00', complete: 'no', proof_of_delivery: 'yes' } } },
  },
];

const ROFR_RESPONSE = [
  { key: 'waived', overrides: { company: { rofr_response: { status: 'waived', at: '2026-08-27' } } } },
  { key: 'none', overrides: { company: { rofr_response: { status: 'none' } } } },
  { key: 'exercised_whole', overrides: { company: { rofr_response: { status: 'exercised_whole' } } } },
  { key: 'exercised_partial', overrides: { company: { rofr_response: { status: 'exercised_partial' } } } },
  { key: 'unknown', overrides: { company: { rofr_response: { status: 'unknown' } } } },
];

const SANCTIONS = [
  { key: 'clear', overrides: { buyer: { sanctions: 'clear' } } },
  { key: 'hit', overrides: { buyer: { sanctions: 'hit' } } },
  { key: 'unknown', overrides: { buyer: { sanctions: 'unknown' } } },
  { key: 'pending', overrides: { buyer: { sanctions: 'pending' } } },
];

const KYC = [
  { key: 'cleared', overrides: { buyer: { kyc: 'cleared' } } },
  { key: 'unknown', overrides: { buyer: { kyc: 'unknown' } } },
  { key: 'pending', overrides: { buyer: { kyc: 'pending' } } },
];

const BO_LIMIT = [
  { key: '80', overrides: { fund: { beneficial_owners_current: 80 } } },
  { key: '95', overrides: { fund: { beneficial_owners_current: 95 } } },
  { key: 'null', overrides: { fund: { beneficial_owners_current: null } } },
];

const VERSION = [
  { key: 'yes', overrides: { documents_version_confirmed: 'yes' } },
  { key: 'no', overrides: { documents_version_confirmed: 'no' } },
];

const AXES = [RELATIONSHIP, COMPETITOR, GP_CONSENT, COMPANY_CONSENT, ROFR_NOTICE, ROFR_RESPONSE, SANCTIONS, KYC, BO_LIMIT, VERSION];
const expectedTotal = AXES.reduce((acc, axis) => acc * axis.length, 1);

function runSweep() {
  let checked = 0;
  const mustBlockFailures = [];
  const uncertainClearFailures = [];

  for (const relationship of RELATIONSHIP) {
    for (const competitor of COMPETITOR) {
      for (const gpConsent of GP_CONSENT) {
        for (const companyConsent of COMPANY_CONSENT) {
          for (const rofrNotice of ROFR_NOTICE) {
            for (const rofrResponse of ROFR_RESPONSE) {
              for (const sanctions of SANCTIONS) {
                for (const kyc of KYC) {
                  for (const boLimit of BO_LIMIT) {
                    for (const version of VERSION) {
                      let facts = baseFacts;
                      facts = deepMergeFacts(facts, relationship.overrides);
                      facts = deepMergeFacts(facts, competitor.overrides);
                      facts = deepMergeFacts(facts, gpConsent.overrides);
                      facts = deepMergeFacts(facts, companyConsent.overrides);
                      facts = deepMergeFacts(facts, rofrNotice.overrides);
                      facts = deepMergeFacts(facts, rofrResponse.overrides);
                      facts = deepMergeFacts(facts, sanctions.overrides);
                      facts = deepMergeFacts(facts, kyc.overrides);
                      facts = deepMergeFacts(facts, boLimit.overrides);
                      facts = deepMergeFacts(facts, version.overrides);

                      const decision = evaluate(facts, rulebook, calendar);
                      checked++;

                      const relIsAffiliate = relationship.key === 'affiliate';
                      // A permitted transferee's consent/notice/ROFR gates are all
                      // NOT_APPLICABLE, so an "unknown" or "refused" value on one of
                      // those facts is inert for that combination: it never reaches
                      // a rule that reads it. Only "applicable" facts can force the
                      // invariants below.

                      // --- Invariant 1: must block ---------------------------------
                      const mustBlock =
                        competitor.key === 'yes' ||
                        sanctions.key === 'hit' ||
                        (!relIsAffiliate && companyConsent.key === 'refused') ||
                        (!relIsAffiliate && rofrResponse.key === 'exercised_whole') ||
                        (relationship.key === 'unrelated' && gpConsent.key === 'refused');

                      if (mustBlock && decision.verdict !== 'BLOCKED') {
                        mustBlockFailures.push({
                          relationship: relationship.key,
                          competitor: competitor.key,
                          gpConsent: gpConsent.key,
                          companyConsent: companyConsent.key,
                          rofrNotice: rofrNotice.key,
                          rofrResponse: rofrResponse.key,
                          sanctions: sanctions.key,
                          kyc: kyc.key,
                          boLimit: boLimit.key,
                          version: version.key,
                          verdict: decision.verdict,
                        });
                      }

                      // --- Invariant 2: never clear the uncertain ------------------
                      // gpConsent "requested_complete_unknown" is deliberately not
                      // treated as uncertain here: outside the Harbour side letter
                      // (which never applies in this sweep, since the transferor
                      // stays "Aldwych Angels Ltd" throughout), F-CONSENT's ordinary
                      // path reads only the consent status, not the completeness
                      // flag, so a "requested" status is OUTSTANDING either way.
                      const uncertain =
                        competitor.key === 'unknown' ||
                        (!relIsAffiliate && ['unknown', 'contradictory'].includes(gpConsent.key)) ||
                        (!relIsAffiliate && ['unknown', 'contradictory'].includes(companyConsent.key)) ||
                        (!relIsAffiliate && ['sent_no_proof', 'delivered_complete_unknown'].includes(rofrNotice.key)) ||
                        (!relIsAffiliate && ['unknown', 'exercised_partial'].includes(rofrResponse.key)) ||
                        sanctions.key === 'unknown' ||
                        kyc.key === 'unknown' ||
                        boLimit.key === 'null' ||
                        version.key === 'no';

                      if (uncertain && decision.verdict === 'CHECKLIST_READY') {
                        uncertainClearFailures.push({
                          relationship: relationship.key,
                          competitor: competitor.key,
                          gpConsent: gpConsent.key,
                          companyConsent: companyConsent.key,
                          rofrNotice: rofrNotice.key,
                          rofrResponse: rofrResponse.key,
                          sanctions: sanctions.key,
                          kyc: kyc.key,
                          boLimit: boLimit.key,
                          version: version.key,
                          verdict: decision.verdict,
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { checked, mustBlockFailures, uncertainClearFailures };
}

test('sweep: full cartesian product of the listed facts', () => {
  assert.strictEqual(expectedTotal, 486000, `axis sizes changed: expected 486,000 combinations, axes multiply to ${expectedTotal}`);

  const start = Date.now();
  const { checked, mustBlockFailures, uncertainClearFailures } = runSweep();
  const elapsedMs = Date.now() - start;

  console.log(`Sweep: ${checked} combinations checked in ${elapsedMs}ms`);

  if (mustBlockFailures.length) {
    console.log('Must-block failures (first 5):', mustBlockFailures.slice(0, 5));
  }
  if (uncertainClearFailures.length) {
    console.log('Uncertain-clear failures (first 5):', uncertainClearFailures.slice(0, 5));
  }

  assert.strictEqual(checked, expectedTotal);
  assert.strictEqual(mustBlockFailures.length, 0, `${mustBlockFailures.length} combinations should have been BLOCKED but were not`);
  assert.strictEqual(
    uncertainClearFailures.length,
    0,
    `${uncertainClearFailures.length} combinations cleared to CHECKLIST_READY despite an applicable unknown fact`
  );
});

// This single test takes about 10 seconds, under the 15-second budget for
// the default suite, so it runs as part of `node --test` like every other
// test file. It can also be run on its own, exactly the same way, with
// `node --test tests/sweep.test.js`.
