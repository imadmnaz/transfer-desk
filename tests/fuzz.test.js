'use strict';

// Interface fuzz test (see docs/REVIEW-LOG.md Round 5): the engine must
// never throw on facts the UI can produce, including a fact left mid-edit
// (a notice marked "delivered" before its date has been filled in, a
// Permitted Transferee whose notice is still at its "not_applicable"
// default) or a date field that ends up missing or malformed. Per CLAUDE.md's
// fail-safe principle, a missing or unusable fact must become UNKNOWN with a
// reason naming what's missing, never a thrown error and never a state that
// lets CHECKLIST_READY slip through.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { evaluate, deepMergeFacts } = require('../engine/engine.js');

const dataDir = path.join(__dirname, '..', 'data');
const rulebook = JSON.parse(fs.readFileSync(path.join(dataDir, 'rulebook.json'), 'utf8'));
const calendar = JSON.parse(fs.readFileSync(path.join(dataDir, 'calendar.json'), 'utf8'));
const baseFacts = JSON.parse(fs.readFileSync(path.join(dataDir, 'base-facts.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(path.join(dataDir, 'scenarios.json'), 'utf8'));

function evalWith(scenarioOverrides, controlOverrides) {
  const facts = deepMergeFacts(deepMergeFacts(baseFacts, scenarioOverrides), controlOverrides);
  return { facts, decision: evaluate(facts, rulebook, calendar) };
}

// --- Regression cases from the interface bug report -----------------------

test('regression: affiliate buyer with F-PERMITTED-NOTICE still at "not_applicable" does not throw', () => {
  const { decision } = evalWith(
    {},
    { transfer: { transferee_relationship: 'affiliate' } } // notices left at base-facts' "not_applicable"
  );
  assert.strictEqual(decision.results.find((r) => r.rule_id === 'F-PERMITTED-NOTICE').state, 'OUTSTANDING');
  assert.strictEqual(decision.results.find((r) => r.rule_id === 'C-PERMITTED-NOTICE').state, 'OUTSTANDING');
  // OUTSTANDING (notice not yet given) is a safe, actionable state: it is
  // allowed to still resolve to CHECKLIST_READY, with the notice as one of
  // the outstanding actions, unlike the UNKNOWN/FAILED cases below.
  assert.strictEqual(decision.verdict, 'CHECKLIST_READY');
  assert.ok(decision.checklist.some((item) => item.source_rule === 'F-PERMITTED-NOTICE'));
  assert.ok(decision.checklist.some((item) => item.source_rule === 'C-PERMITTED-NOTICE'));
});

test('regression: rofr_notice delivered with no sent_at does not throw, resolves UNKNOWN', () => {
  const { decision } = evalWith({}, { company: { rofr_notice: { status: 'delivered', complete: 'yes', proof_of_delivery: 'yes' } } });
  const r = decision.results.find((r) => r.rule_id === 'C-ROFR-NOTICE');
  assert.strictEqual(r.state, 'UNKNOWN');
  assert.match(r.reason, /missing|invalid/);
  assert.notStrictEqual(decision.verdict, 'CHECKLIST_READY');
});

test('regression: rofr_response waived with no at date does not throw, C-ROFR-WINDOW resolves UNKNOWN', () => {
  // Force straight into the "period has ended" shape so C-ROFR-WINDOW is
  // reached at all, then drop the waiver date.
  const { decision } = evalWith({}, { company: { rofr_response: { status: 'waived' } } });
  const r = decision.results.find((r) => r.rule_id === 'C-ROFR-WINDOW');
  assert.strictEqual(r.state, 'UNKNOWN');
  assert.match(r.reason, /missing/);
  assert.notStrictEqual(decision.verdict, 'CHECKLIST_READY');
});

test('regression: gp_consent requested with no requested_at (Harbour deemed-consent path) does not throw', () => {
  const { decision } = evalWith(
    { transfer: { transferor: 'Harbour Family Office LLC' } },
    { fund: { gp_consent: { status: 'requested', complete: 'yes' } } }
  );
  const r = decision.results.find((r) => r.rule_id === 'S-DEEMED-CONSENT');
  assert.strictEqual(r.state, 'UNKNOWN');
  assert.match(r.reason, /missing|invalid/);
  assert.notStrictEqual(decision.verdict, 'CHECKLIST_READY');
});

// --- Broad fuzz: every value of every deal-form control, on every scenario -

const AS_OF = baseFacts.as_of;

// Mirrors the shapes app.js's deal-form controls write into facts (see
// buildDealSections in app.js), plus the same control values with a required
// date left out, since a control that today always prefills a date is
// exactly one refactor away from not doing so, and the engine is the
// backstop either way.
const CONTROL_VALUES = [
  { transfer: { transferee: 'Mira Chen', transferee_relationship: 'unrelated', transferee_is_competitor: 'no' } },
  { transfer: { transferee: 'Kestrel Automation Ltd', transferee_relationship: 'unrelated', transferee_is_competitor: 'yes' } },
  {
    transfer: { transferee: 'Aldwych Angels II Ltd', transferee_relationship: 'affiliate', transferee_is_competitor: 'no' },
    fund: { gp_permitted_notice: { status: 'not_sent' } },
    company: { permitted_notice: { status: 'not_sent' } },
  },
  // affiliate buyer BEFORE app.js's own prefill runs
  { transfer: { transferee: 'Aldwych Angels II Ltd', transferee_relationship: 'affiliate', transferee_is_competitor: 'no' } },
  { transfer: { transferee: 'Harbour Growth Fund II LP', transferee_relationship: 'harbour_transferee', transferee_is_competitor: 'no' } },

  { transfer: { transferor: 'Aldwych Angels Ltd' } },
  { transfer: { transferor: 'Priya Nair' } },
  { transfer: { transferor: 'Harbour Family Office LLC' } },

  { transfer: { kind: 'sale' } },
  { transfer: { kind: 'pledge' } },

  { fund: { gp_consent: { status: 'received', received_at: `${AS_OF}T10:00` } } },
  { fund: { gp_consent: { status: 'requested', requested_at: `${AS_OF}T10:00` } } },
  { fund: { gp_consent: { status: 'requested' } } },
  { fund: { gp_consent: { status: 'refused' } } },
  { fund: { gp_consent: { status: 'not_requested' } } },
  { fund: { gp_consent: { status: 'unknown' } } },

  { company: { consent: { status: 'received', received_at: `${AS_OF}T10:00` } } },
  { company: { consent: { status: 'unknown' } } },
  { company: { consent: { status: 'refused' } } },
  { company: { consent: { status: 'requested', requested_at: `${AS_OF}T10:00` } } },
  { company: { consent: { status: 'requested' } } },
  { company: { consent: { status: 'not_requested' } } },
  { company: { consent: { status: 'contradictory' } } },

  { company: { rofr_notice: { status: 'not_sent' } } },
  { company: { rofr_notice: { status: 'sent_no_proof', sent_at: `${AS_OF}T10:00` } } },
  { company: { rofr_notice: { status: 'sent_no_proof' } } },
  { company: { rofr_notice: { status: 'delivered', sent_at: `${AS_OF}T10:00`, complete: 'yes', proof_of_delivery: 'yes' } } },
  { company: { rofr_notice: { status: 'delivered', complete: 'yes', proof_of_delivery: 'yes' } } },

  { company: { rofr_response: { status: 'waived', at: AS_OF } } },
  { company: { rofr_response: { status: 'waived' } } },
  { company: { rofr_response: { status: 'none' } } },
  { company: { rofr_response: { status: 'exercised_whole' } } },
  { company: { rofr_response: { status: 'exercised_partial' } } },
  { company: { rofr_response: { status: 'unknown' } } },

  { buyer: { kyc: 'cleared' } },
  { buyer: { kyc: 'pending' } },
  { buyer: { kyc: 'not_started' } },
  { buyer: { kyc: 'unknown' } },
  { buyer: { sanctions: 'clear' } },
  { buyer: { sanctions: 'hit' } },
  { buyer: { sanctions: 'pending' } },
  { buyer: { sanctions: 'unknown' } },
  { buyer: { accredited: 'confirmed' } },
  { buyer: { accredited: 'not_accredited' } },
  { buyer: { accredited: 'unknown' } },
  { buyer: { tax_form: 'received' } },
  { buyer: { tax_form: 'outstanding' } },
  { buyer: { adherence: 'signed' } },
  { buyer: { adherence: 'outstanding' } },

  { as_of: AS_OF },
];

test('fuzz: every scenario x every deal-form control value never throws, never clears an unsafe result', () => {
  let checked = 0;
  const unsafeClears = [];

  for (const scenario of scenarios) {
    for (const controlOverrides of CONTROL_VALUES) {
      checked++;
      let decision;
      assert.doesNotThrow(() => {
        ({ decision } = evalWith(scenario.overrides, controlOverrides));
      }, `${scenario.id} + ${JSON.stringify(controlOverrides)} should not throw`);

      const hasUnsafeState = decision.results.some(
        (r) => r.state === 'FAILED' || r.state === 'UNKNOWN' || r.state === 'CONTRADICTORY'
      );
      if (hasUnsafeState && decision.verdict === 'CHECKLIST_READY') {
        unsafeClears.push({ scenario: scenario.id, controlOverrides });
      }
    }
  }

  console.log(`Fuzz: ${checked} (scenario, control value) combinations checked`);
  assert.strictEqual(
    unsafeClears.length,
    0,
    `Unsafe clears: ${unsafeClears.length} (${JSON.stringify(unsafeClears.slice(0, 3))})`
  );
});
