'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { evaluate, deepMergeFacts } = require('../engine/engine.js');
const dates = require('../engine/dates.js');

const dataDir = path.join(__dirname, '..', 'data');
const rulebook = JSON.parse(fs.readFileSync(path.join(dataDir, 'rulebook.json'), 'utf8'));
const calendar = JSON.parse(fs.readFileSync(path.join(dataDir, 'calendar.json'), 'utf8'));
const baseFacts = JSON.parse(fs.readFileSync(path.join(dataDir, 'base-facts.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(path.join(dataDir, 'scenarios.json'), 'utf8'));

const heldoutPath = path.join(dataDir, 'heldout.json');
const heldout = fs.existsSync(heldoutPath) ? JSON.parse(fs.readFileSync(heldoutPath, 'utf8')) : [];

function decisionFor(scenario) {
  const facts = deepMergeFacts(baseFacts, scenario.overrides);
  return { facts, decision: evaluate(facts, rulebook, calendar) };
}

function findResult(decision, ruleId) {
  return decision.results.find((r) => r.rule_id === ruleId);
}

// Shared assertion logic for both the 31 scenarios and the held-out cases.
// `translateDateField` lets a caller remap a date key's field name before
// looking it up on the result's `computed` object (see the alias table
// below, used only by the held-out cases).
function runExpectations(decision, expect, label, translateDateField = (field) => field) {
  assert.strictEqual(decision.verdict, expect.verdict, `${label} verdict`);

  for (const [ruleId, state] of Object.entries(expect.rule_states || {})) {
    const r = findResult(decision, ruleId);
    assert.ok(r, `${label}: missing rule result for ${ruleId}`);
    assert.strictEqual(r.state, state, `${label}: ${ruleId} state`);
  }

  for (const [key, expectedDate] of Object.entries(expect.dates || {})) {
    const [ruleId, rawField] = key.split('.');
    const field = translateDateField(rawField);
    const r = findResult(decision, ruleId);
    assert.ok(r, `${label}: missing rule result for ${ruleId} (date key ${key})`);
    assert.ok(r.computed && r.computed[field], `${label}: missing computed.${field} on ${ruleId} (from key ${key})`);
    assert.strictEqual(r.computed[field].date, expectedDate, `${label}: ${key}`);
    assert.ok(
      typeof r.computed[field].working === 'string' && r.computed[field].working.length > 0,
      `${label}: ${key} should carry a plain-English working string`
    );
  }

  for (const [ruleId, substr] of Object.entries(expect.reason_includes || {})) {
    const r = findResult(decision, ruleId);
    assert.ok(r, `${label}: missing rule result for ${ruleId}`);
    assert.ok(r.reason.includes(substr), `${label}: ${ruleId} reason "${r.reason}" should include "${substr}"`);
  }

  for (const [ruleId, substr] of Object.entries(expect.cure_includes || {})) {
    const r = findResult(decision, ruleId);
    assert.ok(r && r.cure, `${label}: missing cure for ${ruleId}`);
    assert.ok(r.cure.includes(substr), `${label}: ${ruleId} cure "${r.cure}" should include "${substr}"`);
  }

  for (const substr of expect.notes_include || []) {
    assert.ok(
      decision.notes.some((n) => n.includes(substr)),
      `${label}: notes ${JSON.stringify(decision.notes)} should include "${substr}"`
    );
  }

  if (expect.no_outstanding) {
    assert.ok(!decision.results.some((r) => r.state === 'OUTSTANDING'), `${label}: expected no OUTSTANDING rules`);
  }

  if (expect.checklist_last_contains) {
    const last = decision.checklist[decision.checklist.length - 1];
    assert.ok(last, `${label}: checklist is empty`);
    assert.ok(
      last.text.includes(expect.checklist_last_contains),
      `${label}: checklist last item "${last.text}" should include "${expect.checklist_last_contains}"`
    );
  }

  if (expect.audit) {
    for (const [p, expected] of Object.entries(expect.audit)) {
      const val = p.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), decision.audit);
      assert.strictEqual(val, expected, `${label}: audit.${p}`);
    }
  }
}

// --- Scenario suite: every known-answer case from CLAUDE.md section 7 -----

describe('scenarios (CLAUDE.md section 7)', () => {
  for (const scenario of scenarios) {
    test(`${scenario.id}: ${scenario.title}`, () => {
      const { decision } = decisionFor(scenario);
      runExpectations(decision, scenario.expect, scenario.id);
    });
  }
});

// --- Requirement 1: the merge rule -----------------------------------------

test('deep merge replaces status objects wholesale, not key by key (T02)', () => {
  const scenario = scenarios.find((s) => s.id === 'T02');
  const { facts } = decisionFor(scenario);
  assert.strictEqual(facts.company.consent.status, 'not_requested');
  assert.strictEqual('received_at' in facts.company.consent, false, 'stale received_at from base-facts must not survive the override');
  assert.strictEqual('requested_at' in facts.company.consent, false);
});

test('deep merge still merges non-atomic objects recursively', () => {
  const facts = deepMergeFacts(baseFacts, { transfer: { transferee: 'Someone Else' } });
  assert.strictEqual(facts.transfer.transferee, 'Someone Else');
  // Untouched sibling fields on the recursively-merged "transfer" object survive.
  assert.strictEqual(facts.transfer.transferor, baseFacts.transfer.transferor);
  assert.strictEqual(facts.transfer.kind, baseFacts.transfer.kind);
});

// --- Requirement 2: unsafe clears -----------------------------------------

test('unsafe clears: 0 (no FAILED, UNKNOWN or CONTRADICTORY rule ever yields CHECKLIST_READY)', () => {
  const allCases = [...scenarios, ...heldout];
  let unsafeClears = 0;
  const offenders = [];
  for (const c of allCases) {
    const { decision } = decisionFor(c);
    const hasUnsafeState = decision.results.some((r) => ['FAILED', 'UNKNOWN', 'CONTRADICTORY'].includes(r.state));
    if (hasUnsafeState && decision.verdict === 'CHECKLIST_READY') {
      unsafeClears++;
      offenders.push(c.id);
    }
  }
  assert.strictEqual(unsafeClears, 0, `Unsafe clears: ${unsafeClears} (${offenders.join(', ')})`);
});

test('every scenario whose expected verdict is BLOCKED or ESCALATE never comes back CHECKLIST_READY', () => {
  for (const scenario of scenarios) {
    if (scenario.expect.verdict === 'BLOCKED' || scenario.expect.verdict === 'ESCALATE') {
      const { decision } = decisionFor(scenario);
      assert.notStrictEqual(decision.verdict, 'CHECKLIST_READY', `${scenario.id} must not clear`);
    }
  }
});

// --- Requirement 3: dates.js unit tests ------------------------------------

test('dates: a notice sent after 17:00 on a Friday is received the next Business Day', () => {
  const result = dates.receivedDate('2026-09-25T18:30', calendar);
  assert.strictEqual(result.date, '2026-09-28');
});

test('dates: a notice sent on a holiday is received the next Business Day', () => {
  // 2026-10-12 is Columbus Day, a Monday.
  const result = dates.receivedDate('2026-10-12T09:00', calendar);
  assert.strictEqual(dates.isHoliday('2026-10-12', calendar), true);
  assert.strictEqual(result.date, '2026-10-13');
});

test('dates: clear days spanning the 12 Oct holiday skip it in the count', () => {
  // Ten clear Business Days after receipt on 2026-09-28 means the 11th
  // Business Day after receipt; the 12 Oct holiday must not count.
  const result = dates.addBusinessDays('2026-09-28', 11, calendar);
  assert.strictEqual(result.date, '2026-10-14');
  assert.ok(result.skippedHolidays.includes('2026-10-12'));
});

test('dates: a Business Day count ending across a weekend skips both weekend days', () => {
  // 2026-09-24 is a Thursday. 3 Business Days after: Fri 25, (skip Sat 26 / Sun 27), Mon 28.
  const result = dates.addBusinessDays('2026-09-24', 3, calendar);
  assert.strictEqual(result.date, '2026-09-29');
});

test('dates: isBusinessDay is false for weekends and holidays, true otherwise', () => {
  assert.strictEqual(dates.isBusinessDay('2026-09-26', calendar), false); // Saturday
  assert.strictEqual(dates.isBusinessDay('2026-09-27', calendar), false); // Sunday
  assert.strictEqual(dates.isBusinessDay('2026-01-01', calendar), false); // holiday
  assert.strictEqual(dates.isBusinessDay('2026-09-25', calendar), true); // Friday, no holiday
});

// --- Requirement 4: every computed date carries a working string ----------

test('every computed date on every scenario result carries a plain-English working string', () => {
  for (const scenario of scenarios) {
    const { decision } = decisionFor(scenario);
    for (const r of decision.results) {
      if (!r.computed) continue;
      for (const [field, value] of Object.entries(r.computed)) {
        assert.ok(typeof value.date === 'string', `${scenario.id}: ${r.rule_id}.computed.${field}.date should be a string`);
        assert.ok(
          typeof value.working === 'string' && value.working.length > 0,
          `${scenario.id}: ${r.rule_id}.computed.${field}.working should be a non-empty string`
        );
      }
    }
  }
});

// --- Requirement 5: purity --------------------------------------------------

test('evaluate() is pure: same facts in, byte-identical decision out', () => {
  const scenario = scenarios.find((s) => s.id === 'T10');
  const { facts } = decisionFor(scenario);
  const d1 = evaluate(facts, rulebook, calendar);
  const d2 = evaluate(facts, rulebook, calendar);
  assert.deepStrictEqual(d1, d2);
  assert.strictEqual(d1.audit.id, d2.audit.id);
});

test('evaluate() never reads the real clock: as_of alone drives every date decision', () => {
  const scenario = scenarios.find((s) => s.id === 'T21');
  const { facts } = decisionFor(scenario);
  const before = evaluate({ ...facts, as_of: '2026-09-23' }, rulebook, calendar);
  const after = evaluate({ ...facts, as_of: '2026-09-25' }, rulebook, calendar);
  assert.strictEqual(findResult(before, 'F-CONSENT').state, 'OUTSTANDING');
  assert.strictEqual(findResult(after, 'F-CONSENT').state, 'SATISFIED');
});

// --- Regression: a recorded ROFR exercise must never be hidden by missing --
// --- Transfer Notice evidence (Round 3, see docs/REVIEW-LOG.md) -----------

function decisionForOverrides(overrides) {
  const facts = deepMergeFacts(baseFacts, overrides);
  return { facts, decision: evaluate(facts, rulebook, calendar) };
}

test('regression (a): notice not_sent, response exercised_whole: BLOCKED', () => {
  const { decision } = decisionForOverrides({
    company: { rofr_notice: { status: 'not_sent' }, rofr_response: { status: 'exercised_whole' } },
  });
  assert.strictEqual(decision.verdict, 'BLOCKED');
  assert.strictEqual(findResult(decision, 'C-ROFR-RESPONSE').state, 'FAILED');
});

test('regression (b): notice sent_no_proof, response exercised_whole: BLOCKED', () => {
  const { decision } = decisionForOverrides({
    company: {
      rofr_notice: { status: 'sent_no_proof', sent_at: '2026-08-20T10:00', complete: 'yes', proof_of_delivery: 'no' },
      rofr_response: { status: 'exercised_whole' },
    },
  });
  assert.strictEqual(decision.verdict, 'BLOCKED');
  assert.strictEqual(findResult(decision, 'C-ROFR-RESPONSE').state, 'FAILED');
});

test('regression (c): notice delivered with complete unknown, response none: ESCALATE, C-ROFR-RESPONSE UNKNOWN', () => {
  const { decision } = decisionForOverrides({
    company: {
      rofr_notice: { status: 'delivered', sent_at: '2026-08-20T10:00', complete: 'unknown', proof_of_delivery: 'yes' },
      rofr_response: { status: 'none' },
    },
  });
  assert.strictEqual(decision.verdict, 'ESCALATE');
  assert.strictEqual(findResult(decision, 'C-ROFR-RESPONSE').state, 'UNKNOWN');
});

test('regression (d): notice not_sent, response waived at 2026-06-01, completion 2026-10-05: BLOCKED on C-ROFR-WINDOW', () => {
  const { decision } = decisionForOverrides({
    company: {
      rofr_notice: { status: 'not_sent' },
      rofr_response: { status: 'waived', at: '2026-06-01' },
    },
    transfer: { proposed_completion: '2026-10-05' },
  });
  assert.strictEqual(decision.verdict, 'BLOCKED');
  assert.strictEqual(findResult(decision, 'C-ROFR-WINDOW').state, 'FAILED');
});

// --- Held-out cases (external reviewer, phase 3) ---------------------------
//
// The held-out cases were written independently against the documents and
// CLAUDE.md's date conventions, without access to this engine, so they use
// slightly different names for the same computed dates (e.g. "receipt_date"
// where the engine's own field is "receipt"). This table translates NAMES
// ONLY: it never touches an expected value. CLAUDE.md section 7 says held-out
// cases must never be edited, including their expected answers, so the
// engine's output is translated to match the case's vocabulary rather than
// the other way around.
const HELD_OUT_DATE_FIELD_ALIASES = {
  receipt_date: 'receipt',
  earliest_permitted_completion: 'earliest_completion',
  expiry_date: 'expiry',
  deemed_date: 'deemed_at',
  start_date: 'window_start',
  end_date: 'window_end',
};

function translateHeldOutDateField(field) {
  return HELD_OUT_DATE_FIELD_ALIASES[field] || field;
}

// Runs the same checks as runExpectations() but swallows assertion failures
// into a list instead of throwing, so the summary test below can report a
// full "n/10" tally in one place, in addition to the per-case pass/fail
// tests just above it.
function checkHeldOutCase(c) {
  const { decision } = decisionFor(c);
  const failures = [];
  try {
    runExpectations(decision, c.expect, c.id, translateHeldOutDateField);
  } catch (err) {
    failures.push(err.message);
  }
  return { decision, failures };
}

describe('held-out cases (external reviewer, see docs/REVIEW-LOG.md Round 4)', () => {
  if (heldout.length === 0) {
    test('heldout.json is not present yet', () => {});
  }

  for (const c of heldout) {
    test(`${c.id} (held-out): ${c.title}`, () => {
      const { decision } = decisionFor(c);
      runExpectations(decision, c.expect, c.id, translateHeldOutDateField);
    });
  }

  test('held-out summary: verdicts and full matches, case by case', () => {
    if (heldout.length === 0) return;
    let verdictsMatched = 0;
    let fullyMatched = 0;
    const lines = [];
    for (const c of heldout) {
      const { decision, failures } = checkHeldOutCase(c);
      const verdictOk = decision.verdict === c.expect.verdict;
      if (verdictOk) verdictsMatched++;
      if (failures.length === 0) fullyMatched++;
      lines.push(
        `  ${c.id}: verdict ${decision.verdict} (expected ${c.expect.verdict})${
          failures.length ? ' — ' + failures.join(' | ') : ' — OK, including all dates'
        }`
      );
    }
    console.log(`Held-out: ${verdictsMatched}/${heldout.length} verdicts matched`);
    console.log(`Held-out: ${fullyMatched}/${heldout.length} fully matched (verdict + rule states + dates)`);
    lines.forEach((line) => console.log(line));
  });
});
