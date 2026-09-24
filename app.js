'use strict';

// UI only: rendering and interaction. All legal logic lives in engine/engine.js
// and engine/dates.js, loaded as <script> tags before this file and exposed on
// window.TransferDeskEngine / window.TransferDeskDates. Nothing here decides a
// rule state, a date or a verdict; it only reads what evaluate() returns and
// the data files fetched below.

const Engine = window.TransferDeskEngine;
const Dates = window.TransferDeskDates;

const DATA = {};
const state = {
  scenarioId: 'T09',
  extraOverrides: {},
  expandedRuleIds: new Set(),
  expandedNAGates: new Set(),
};

const STATE_LABELS = {
  SATISFIED: 'Met',
  OUTSTANDING: 'Outstanding',
  FAILED: 'Fails',
  UNKNOWN: 'Unknown',
  CONTRADICTORY: 'Conflicting',
  NOT_APPLICABLE: 'Not applicable',
};

// --- Data loading -----------------------------------------------------

async function loadData() {
  const [rulebook, clauses, calendar, baseFacts, scenarios, heldout] = await Promise.all([
    fetch('data/rulebook.json').then((r) => r.json()),
    fetch('data/clauses.json').then((r) => r.json()),
    fetch('data/calendar.json').then((r) => r.json()),
    fetch('data/base-facts.json').then((r) => r.json()),
    fetch('data/scenarios.json').then((r) => r.json()),
    fetch('data/heldout.json').then((r) => r.json()),
  ]);
  Object.assign(DATA, { rulebook, clauses, calendar, baseFacts, scenarios, heldout });
}

function currentScenario() {
  return DATA.scenarios.find((s) => s.id === state.scenarioId) || DATA.scenarios[0];
}

function currentFacts() {
  let facts = Engine.deepMergeFacts(DATA.baseFacts, currentScenario().overrides);
  facts = Engine.deepMergeFacts(facts, state.extraOverrides);
  return facts;
}

// --- Small helpers ------------------------------------------------------

function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function nestOverride(path, value) {
  const segs = path.split('.');
  let out = value;
  for (let i = segs.length - 1; i >= 0; i--) out = { [segs[i]]: out };
  return out;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function truncate(str, n) {
  if (!str || str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + '…';
}

// Display-only date/text formatting. The engine's own reason strings are
// already formatted with Dates.formatReadable; only a handful of cure and
// action strings still carry a raw ISO date internally (kept that way
// because a couple of scenario/held-out assertions match against the exact
// ISO substring), so this catches those before anything reaches the page.
function humanize(text) {
  if (!text) return text;
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => Dates.formatReadable(m));
}

function ensureSentence(text) {
  if (!text) return text;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function lookupClause(citation) {
  const doc = DATA.clauses[citation.doc];
  if (!doc) return null;
  const section = doc.sections[citation.section];
  if (!section) return null;
  return { docTitle: doc.title, file: doc.file, page: section.page, text: section.text, heading: section.heading };
}

// "SA 3.3", "SA Sch. 2", "SA 1.1 Competitor", "LPA 8.4(d)", "SL para 2":
// never a bare section number and never a "§".
function citationSectionLabel(doc, section) {
  if (doc === 'SL') return `para ${section}`;
  if (section.startsWith('Schedule ')) return `Sch. ${section.slice('Schedule '.length)}`;
  if (section.includes(':')) {
    const [num, term] = section.split(':');
    return `${num} ${term}`;
  }
  return section;
}

function formatCitation(c) {
  return `${c.doc} ${citationSectionLabel(c.doc, c.section)}`;
}

function decidingRuleId(decision) {
  if (decision.verdict === 'BLOCKED') {
    const r = decision.results.find((r) => r.state === 'FAILED');
    return r ? r.rule_id : null;
  }
  if (decision.verdict === 'ESCALATE') {
    const r = decision.results.find((r) => r.state === 'UNKNOWN' || r.state === 'CONTRADICTORY');
    return r ? r.rule_id : null;
  }
  const r = decision.results.find((r) => r.state === 'OUTSTANDING' && r.action);
  return r ? r.rule_id : null;
}

// --- Fact controls --------------------------------------------------------
//
// One control descriptor per editable fact: { label, kind, currentValue,
// options?, buildOverride(rawValue) }. buildOverride() returns a partial
// facts object that gets deep-merged on top of the scenario's own facts
// (see applyOverride()). For the six "atomic" status objects (consent and
// notice objects), the whole object is rebuilt with the changed field so
// sibling fields the engine needs (e.g. requested_at) are never dropped.

function applyOverride(overrideObj) {
  state.extraOverrides = Engine.deepMergeFacts(state.extraOverrides, overrideObj);
  render();
}

function selectFieldControl(label, path, facts, options) {
  return {
    label,
    kind: 'select',
    currentValue: String(getPath(facts, path)),
    options,
    buildOverride: (v) => nestOverride(path, v),
  };
}

function booleanFieldControl(label, path, facts) {
  const val = getPath(facts, path);
  return {
    label,
    kind: 'select',
    currentValue: val ? 'true' : 'false',
    options: ['true', 'false'],
    buildOverride: (v) => nestOverride(path, v === 'true'),
  };
}

function dateFieldControl(label, path, facts) {
  return {
    label,
    kind: 'date',
    currentValue: getPath(facts, path),
    buildOverride: (v) => nestOverride(path, v),
  };
}

function numberFieldControl(label, path, facts, allowNull) {
  const val = getPath(facts, path);
  return {
    label,
    kind: 'number',
    currentValue: val === null || val === undefined ? '' : String(val),
    buildOverride: (v) => nestOverride(path, allowNull && v === '' ? null : Number(v)),
  };
}

function consentStatusControl(label, objPath, facts) {
  const current = getPath(facts, objPath) || {};
  return {
    label,
    kind: 'select',
    currentValue: current.status,
    options: ['not_requested', 'requested', 'received', 'refused', 'unknown', 'contradictory'],
    buildOverride: (newStatus) => {
      const merged = { ...current, status: newStatus };
      if (newStatus === 'requested' && !merged.requested_at) merged.requested_at = `${facts.as_of}T10:00`;
      if (newStatus === 'received' && !merged.received_at) merged.received_at = merged.requested_at || `${facts.as_of}T10:00`;
      return nestOverride(objPath, merged);
    },
  };
}

function consentCompleteControl(label, objPath, facts) {
  const current = getPath(facts, objPath) || {};
  return {
    label,
    kind: 'select',
    currentValue: current.complete === undefined ? 'yes' : current.complete,
    options: ['yes', 'no', 'unknown'],
    buildOverride: (v) => nestOverride(objPath, { ...current, complete: v }),
  };
}

// Options exclude "not_applicable": that value is only ever a placeholder
// used when the notice rule itself is NOT_APPLICABLE, and is never a valid
// input once the rule is live (see evaluatePermittedNotice in engine.js).
function noticeStatusControl(label, objPath, facts) {
  const current = getPath(facts, objPath) || {};
  return {
    label,
    kind: 'select',
    currentValue: current.status === 'not_applicable' ? 'not_sent' : current.status,
    options: ['not_sent', 'delivered', 'sent_no_proof'],
    buildOverride: (v) => {
      const merged = { ...current, status: v };
      if ((v === 'delivered' || v === 'sent_no_proof') && !merged.sent_at) merged.sent_at = `${facts.as_of}T10:00`;
      if (merged.complete === undefined) merged.complete = 'yes';
      return nestOverride(objPath, merged);
    },
  };
}

function noticeSentAtControl(label, objPath, facts) {
  const current = getPath(facts, objPath) || {};
  return {
    label,
    kind: 'datetime-local',
    currentValue: current.sent_at || '',
    buildOverride: (v) => nestOverride(objPath, { ...current, sent_at: v }),
  };
}

function noticeCompleteControl(label, objPath, facts) {
  const current = getPath(facts, objPath) || {};
  return {
    label,
    kind: 'select',
    currentValue: current.complete === undefined ? 'yes' : current.complete,
    options: ['yes', 'no', 'unknown'],
    buildOverride: (v) => nestOverride(objPath, { ...current, complete: v }),
  };
}

function rofrResponseControl(facts) {
  const objPath = 'company.rofr_response';
  const current = getPath(facts, objPath) || {};
  return {
    label: "Company's response to the Transfer Notice",
    kind: 'select',
    currentValue: current.status,
    options: ['none', 'waived', 'exercised_whole', 'exercised_partial', 'unknown'],
    buildOverride: (v) => {
      const merged = { ...current, status: v };
      if (v === 'waived' && !merged.at) merged.at = facts.as_of;
      return nestOverride(objPath, merged);
    },
  };
}

const RELATIONSHIP_OPTIONS = ['unrelated', 'affiliate', 'family_trust', 'estate', 'harbour_transferee'];

const CONTROL_BUILDERS = {
  'X-CLASSIFY': (f) => [selectFieldControl('Operator classification', 'transfer.operator_classification', f, ['transfer', 'not_a_transfer'])],
  'X-VERSION': (f) => [selectFieldControl('Documents version confirmed', 'documents_version_confirmed', f, ['yes', 'no', 'unknown'])],
  'S-SCOPE': (f) => [
    {
      label: 'Claimed side letter',
      kind: 'select',
      currentValue: f.fund.claimed_side_letter || 'none',
      options: ['none', 'harbour'],
      buildOverride: (v) => nestOverride('fund.claimed_side_letter', v === 'none' ? null : v),
    },
  ],
  'S-HARBOUR-TRANSFEREE': (f) => [selectFieldControl("Buyer's relationship to the seller", 'transfer.transferee_relationship', f, RELATIONSHIP_OPTIONS)],
  'S-DEEMED-CONSENT': (f) => [
    consentStatusControl('General Partner consent', 'fund.gp_consent', f),
    consentCompleteControl('GP consent request complete', 'fund.gp_consent', f),
  ],
  'F-CONSENT': (f) => [
    consentStatusControl('General Partner consent', 'fund.gp_consent', f),
    selectFieldControl("Buyer's relationship to the seller", 'transfer.transferee_relationship', f, RELATIONSHIP_OPTIONS),
  ],
  'F-PERMITTED-NOTICE': (f) => [
    noticeStatusControl('Notice to the General Partner', 'fund.gp_permitted_notice', f),
    noticeSentAtControl('Notice sent at', 'fund.gp_permitted_notice', f),
    dateFieldControl('Proposed completion', 'transfer.proposed_completion', f),
  ],
  'F-MIN-HOLDING': (f) => [
    numberFieldControl('Fraction transferred', 'transfer.fraction', f),
    numberFieldControl("Seller's Capital Contribution", 'transfer.transferor_capital_contribution', f),
  ],
  'F-BO-LIMIT': (f) => [
    numberFieldControl('Current beneficial owners', 'fund.beneficial_owners_current', f, true),
    booleanFieldControl('Buyer already a Limited Partner', 'transfer.transferee_existing_lp', f),
    numberFieldControl('Fraction transferred', 'transfer.fraction', f),
  ],
  'C-COMPETITOR': (f) => [selectFieldControl('Buyer is a Competitor', 'transfer.transferee_is_competitor', f, ['no', 'yes', 'unknown'])],
  'C-CONSENT': (f) => [consentStatusControl('Company consent', 'company.consent', f)],
  'C-PERMITTED-NOTICE': (f) => [
    noticeStatusControl('Notice to the Company', 'company.permitted_notice', f),
    noticeSentAtControl('Notice sent at', 'company.permitted_notice', f),
    dateFieldControl('Proposed completion', 'transfer.proposed_completion', f),
  ],
  'C-ROFR-NOTICE': (f) => [
    noticeStatusControl('Transfer Notice', 'company.rofr_notice', f),
    noticeSentAtControl('Notice sent at', 'company.rofr_notice', f),
    noticeCompleteControl('Notice complete', 'company.rofr_notice', f),
  ],
  'C-ROFR-RESPONSE': (f) => [rofrResponseControl(f)],
  'C-ROFR-WINDOW': (f) => [dateFieldControl('Proposed completion', 'transfer.proposed_completion', f)],
  'B-KYC': (f) => [selectFieldControl('KYC / AML checks', 'buyer.kyc', f, ['cleared', 'pending', 'not_started', 'unknown'])],
  'B-SANCTIONS': (f) => [selectFieldControl('Sanctions screening', 'buyer.sanctions', f, ['clear', 'hit', 'pending', 'unknown'])],
  'B-ACCREDITED': (f) => [selectFieldControl('Accredited investor status', 'buyer.accredited', f, ['confirmed', 'not_accredited', 'unknown'])],
  'B-TAX-FORM': (f) => [selectFieldControl('Tax form', 'buyer.tax_form', f, ['received', 'outstanding'])],
  'B-ADHERENCE': (f) => [selectFieldControl('Transfer and Adherence Agreement', 'buyer.adherence', f, ['signed', 'outstanding'])],
};

// Human, capitalised labels for raw fact values, used on the segmented
// toggle buttons. Falls back to sentence case ("not_requested" -> "Not
// requested") for anything not listed here.
const OPTION_LABELS = {
  true: 'Yes',
  false: 'No',
  none: 'None',
  transfer: 'Transfer',
  not_a_transfer: 'Not a transfer',
  harbour: 'Harbour',
  harbour_transferee: 'Harbour Transferee',
  family_trust: 'Family trust',
  sent_no_proof: 'Sent, no proof',
  exercised_whole: 'Exercised in whole',
  exercised_partial: 'Exercised in part',
  not_accredited: 'Not accredited',
  not_started: 'Not started',
};

function optionLabel(raw) {
  if (Object.prototype.hasOwnProperty.call(OPTION_LABELS, raw)) return OPTION_LABELS[raw];
  const spaced = String(raw).replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function renderControl(ctrl) {
  const wrap = el('div', 'fact-control');
  const labelEl = el('label', 'fact-control-label', ctrl.label);
  wrap.appendChild(labelEl);

  if (ctrl.kind === 'select') {
    const group = el('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', ctrl.label);
    for (const opt of ctrl.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = optionLabel(opt);
      const pressed = String(opt) === String(ctrl.currentValue);
      btn.setAttribute('aria-pressed', String(pressed));
      btn.addEventListener('click', () => applyOverride(ctrl.buildOverride(opt)));
      group.appendChild(btn);
    }
    wrap.appendChild(group);
  } else {
    const id = 'ctrl-' + Math.random().toString(36).slice(2);
    labelEl.htmlFor = id;
    const input = document.createElement('input');
    input.type = ctrl.kind;
    input.id = id;
    if (ctrl.kind === 'number') input.step = 'any';
    if (ctrl.currentValue !== undefined && ctrl.currentValue !== null) input.value = ctrl.currentValue;
    input.addEventListener('change', () => applyOverride(ctrl.buildOverride(input.value)));
    wrap.appendChild(input);
  }
  return wrap;
}

// --- Rendering ------------------------------------------------------------

function renderHeader() {
  const scenario = currentScenario();
  document.getElementById('scenario-id').textContent = scenario.id;
  document.getElementById('scenario-title-text').textContent = scenario.display_name;
}

function renderRegister(facts) {
  const t = facts.transfer;
  const list = document.getElementById('register');
  list.innerHTML = '';

  function row(label, valueEl) {
    list.appendChild(el('dt', null, label));
    const dd = el('dd');
    dd.appendChild(valueEl);
    list.appendChild(dd);
  }

  row('Seller', document.createTextNode(t.transferor));
  row('Buyer', document.createTextNode(t.transferee));

  const usd = (n) => `US$${n.toLocaleString('en-US')}`;
  const interestText =
    t.fraction >= 1
      ? `Whole, ${usd(t.transferor_capital_contribution)} contribution`
      : `${Math.round(t.fraction * 100)}%, ${usd(t.transferor_capital_contribution * t.fraction)} of ${usd(t.transferor_capital_contribution)} contribution`;
  row('Interest', document.createTextNode(interestText));

  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode(Dates.formatReadable(t.proposed_completion)));
  const asOf = el('span', 'as-of', ` · as of ${Dates.formatReadable(facts.as_of)}`);
  frag.appendChild(asOf);
  row('Completion', frag);
}

// The finding block says each thing once: decision.headline is the plain-
// English fact-and-consequence sentence (built in engine.js from
// rulebook.json's rule.findings), the explanation is the deciding rule's own
// reason (a different, more technical sentence), and citations follow. The
// expanded deciding rule below shows the clause and fact toggles, not a
// second copy of the explanation.
function renderFinding(decision, decidingId) {
  const container = document.getElementById('finding');
  container.innerHTML = '';
  const decidingResult = decidingId ? decision.results.find((r) => r.rule_id === decidingId) : null;

  let labelText;
  let labelClass = 'verdict-label';
  let subline = null;
  let dueText = null;
  let citations = decidingResult ? decidingResult.citations : [];

  if (decision.verdict === 'BLOCKED') {
    labelText = 'BLOCKED';
    labelClass += ' blocked';
  } else if (decision.verdict === 'ESCALATE') {
    labelText = 'LAWYER REVIEW';
    labelClass += ' escalate';
  } else {
    const outstandingCount = decision.results.filter((r) => r.state === 'OUTSTANDING').length;
    if (outstandingCount > 0) {
      labelText = `${outstandingCount} ACTION${outstandingCount === 1 ? '' : 'S'} OUTSTANDING`;
      subline = 'Nothing blocks this transfer, but these steps must be completed before the GP can record it.';
      const nextAction = decision.checklist.find((item) => item.source_rule);
      if (nextAction) dueText = `${nextAction.owner || 'Ops'}${nextAction.due ? ' · due ' + Dates.formatReadable(nextAction.due) : ''}`;
    } else {
      labelText = 'READY FOR THE GP TO RECORD';
      citations = [{ doc: 'LPA', section: '8.5' }];
    }
  }

  container.appendChild(el('p', labelClass, labelText));
  container.appendChild(el('h1', null, ensureSentence(humanize(decision.headline))));
  if (decidingResult && decision.verdict !== 'CHECKLIST_READY') {
    container.appendChild(el('p', 'explanation', decidingResult.reason));
  } else if (subline) {
    container.appendChild(el('p', 'subline', subline));
  }
  if (dueText) container.appendChild(el('p', 'due', dueText));

  if (citations.length) {
    const citesWrap = el('div', 'cites');
    for (const c of citations) citesWrap.appendChild(el('span', 'cite', formatCitation(c)));
    container.appendChild(citesWrap);
  }
}

// isDeciding: the finding block above already showed this rule's reason as
// the explanation, so the expanded detail does not repeat it (CLAUDE.md
// pass B item 3, "say each thing once"). A FAILED rule's cure is likewise
// not repeated here: under BLOCKED it lives once, in "What would change the
// answer" below the review.
function renderRuleDetail(rule, result, facts, isDeciding) {
  const detail = el('div', 'rule-detail');
  if (!isDeciding) {
    detail.appendChild(el('p', null, result.reason));
  }

  if (result.computed) {
    const working = Object.values(result.computed)
      .map((v) => v.working)
      .filter(Boolean)
      .join(' · ');
    if (working) detail.appendChild(el('div', 'working', working));
  }

  if (rule.citations && rule.citations.length) {
    const top = rule.citations[0];
    const clause = lookupClause(top);
    if (clause) {
      const source = el('div', 'source');
      source.appendChild(el('div', 'source-line', `${clause.docTitle.split(' - ')[0]} · ${formatCitation(top)} · p. ${clause.page}`));
      source.appendChild(el('blockquote', null, clause.text));
      const link = el('a', 'open-doc', `Open the full document at p. ${clause.page}`);
      link.href = `docs/source/${clause.file}#page=${clause.page}`;
      link.target = '_blank';
      link.rel = 'noopener';
      source.appendChild(link);
      detail.appendChild(source);
    }
    if (rule.citations.length > 1) {
      const others = el('div', 'cites');
      for (const c of rule.citations.slice(1)) others.appendChild(el('span', 'cite', formatCitation(c)));
      detail.appendChild(others);
    }
  }

  const builder = CONTROL_BUILDERS[rule.id];
  const controls = builder ? builder(facts) : [];
  if (controls.length) {
    const wrap = el('div', 'fact-controls');
    for (const ctrl of controls) wrap.appendChild(renderControl(ctrl));
    detail.appendChild(wrap);
  }

  return detail;
}

function renderRuleRow(rule, result, isDeciding, facts) {
  const wrap = el('div', 'rule-row' + (isDeciding ? ' deciding' : ''));
  const expanded = state.expandedRuleIds.has(result.rule_id);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'row-toggle';
  toggle.setAttribute('aria-expanded', String(expanded));

  const nameWrap = el('span');
  nameWrap.appendChild(el('span', 'name', rule.title));
  nameWrap.appendChild(el('span', 'detail', truncate(result.reason, 130)));

  const stateClass =
    result.state === 'FAILED' ? ' blocked' : result.state === 'UNKNOWN' || result.state === 'CONTRADICTORY' ? ' escalate' : '';
  const stateSpan = el('span', 'state' + stateClass, STATE_LABELS[result.state] || result.state);

  toggle.appendChild(nameWrap);
  toggle.appendChild(stateSpan);
  toggle.addEventListener('click', () => {
    if (state.expandedRuleIds.has(result.rule_id)) state.expandedRuleIds.delete(result.rule_id);
    else state.expandedRuleIds.add(result.rule_id);
    render();
  });
  wrap.appendChild(toggle);

  if (expanded) {
    wrap.appendChild(renderRuleDetail(rule, result, facts, isDeciding));
  }
  return wrap;
}

// Not-applicable rules collapse into one row per gate group ("3 not
// applicable"), which expands on tap to show them individually.
function renderNotApplicableRow(gateId, results, ruleMap, facts) {
  const wrap = el('div', 'rule-row na-summary');
  const expanded = state.expandedNAGates.has(gateId);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'row-toggle';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.appendChild(el('span', 'name', `${results.length} not applicable`));
  toggle.addEventListener('click', () => {
    if (state.expandedNAGates.has(gateId)) state.expandedNAGates.delete(gateId);
    else state.expandedNAGates.add(gateId);
    render();
  });
  wrap.appendChild(toggle);

  if (expanded) {
    const list = el('div', 'na-list');
    for (const result of results) {
      list.appendChild(renderRuleRow(ruleMap.get(result.rule_id), result, false, facts));
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function renderReview(decision, facts, decidingId) {
  const container = document.getElementById('review');
  container.innerHTML = '';
  const ruleMap = new Map(DATA.rulebook.rules.map((r) => [r.id, r]));
  const gateLabel = Object.fromEntries(DATA.rulebook.gates.map((g) => [g.id, g.label]));
  const gateOrder = DATA.rulebook.gates.map((g) => g.id);
  const decidingGate = decidingId ? ruleMap.get(decidingId).gate : null;
  const orderedGates = decidingGate ? [decidingGate, ...gateOrder.filter((g) => g !== decidingGate)] : gateOrder;

  for (const gateId of orderedGates) {
    const rulesInGate = decision.results.filter((r) => ruleMap.get(r.rule_id).gate === gateId);
    if (rulesInGate.length === 0) continue;
    const applicable = rulesInGate.filter((r) => r.state !== 'NOT_APPLICABLE');
    const notApplicable = rulesInGate.filter((r) => r.state === 'NOT_APPLICABLE');
    const group = el('div', 'gate-group');
    group.appendChild(el('div', 'gate-label', gateLabel[gateId] || gateId));
    for (const result of applicable) {
      group.appendChild(renderRuleRow(ruleMap.get(result.rule_id), result, result.rule_id === decidingId, facts));
    }
    if (notApplicable.length) {
      group.appendChild(renderNotApplicableRow(gateId, notApplicable, ruleMap, facts));
    }
    container.appendChild(group);
  }
}

function renderNotes(decision) {
  const container = document.getElementById('notes-section');
  container.innerHTML = '';
  if (!decision.notes.length) return;
  const wrap = el('div', 'gate-group');
  wrap.appendChild(el('div', 'gate-label', 'Notes'));
  const ul = el('ul', 'notes');
  for (const n of decision.notes) ul.appendChild(el('li', null, n));
  wrap.appendChild(ul);
  container.appendChild(wrap);
}

// Under BLOCKED, the checklist section becomes "What would change the
// answer": one line per failure's cure, in the rulebook's own words, or a
// plain "nothing on these facts" line for a failure that has none (e.g. a
// Competitor sale, a sanctions hit). Every other verdict keeps the ordinary
// checklist.
function renderChecklist(decision, ruleMap) {
  const heading = document.getElementById('checklist-heading');
  const list = document.getElementById('checklist');
  list.innerHTML = '';

  if (decision.verdict === 'BLOCKED') {
    heading.textContent = 'What would change the answer';
    for (const item of decision.checklist) {
      const li = document.createElement('li');
      const rule = ruleMap.get(item.source_rule);
      const text = item.cure ? ensureSentence(humanize(item.cure)) : (rule && rule.no_cure) || 'Nothing on these facts.';
      li.appendChild(el('div', null, text));
      list.appendChild(li);
    }
    return;
  }

  heading.textContent = 'Checklist';
  for (const item of decision.checklist) {
    const li = document.createElement('li');
    if (item.owner) li.appendChild(el('div', 'owner', item.owner));
    li.appendChild(el('div', null, ensureSentence(humanize(item.text))));
    if (item.due) li.appendChild(el('div', 'due', 'Due ' + Dates.formatReadable(item.due)));
    list.appendChild(li);
  }
}

function renderAudit(decision) {
  document.getElementById('audit-json').textContent = JSON.stringify(decision.audit, null, 2);
}

function renderError(err) {
  const container = document.getElementById('finding');
  container.innerHTML = '';
  container.appendChild(el('p', 'verdict-label escalate', 'CANNOT EVALUATE'));
  container.appendChild(
    el('h1', null, 'This combination of facts cannot be evaluated.')
  );
  container.appendChild(el('p', 'explanation', err.message));
  document.getElementById('review').innerHTML = '';
  document.getElementById('notes-section').innerHTML = '';
  document.getElementById('checklist').innerHTML = '';
}

function render() {
  renderHeader();
  let facts;
  let decision;
  try {
    facts = currentFacts();
    decision = Engine.evaluate(facts, DATA.rulebook, DATA.calendar);
  } catch (err) {
    renderError(err);
    return;
  }
  const decidingId = decidingRuleId(decision);
  if (decidingId) state.expandedRuleIds.add(decidingId);
  const ruleMap = new Map(DATA.rulebook.rules.map((r) => [r.id, r]));

  renderRegister(facts);
  renderFinding(decision, decidingId);
  renderReview(decision, facts, decidingId);
  renderNotes(decision);
  renderChecklist(decision, ruleMap);
  renderAudit(decision);
}

// --- Scenario picker --------------------------------------------------

function renderScenarioList(filter) {
  const ul = document.getElementById('scenario-list');
  ul.innerHTML = '';
  const q = (filter || '').toLowerCase().trim();
  for (const s of DATA.scenarios) {
    if (q && !(s.id.toLowerCase().includes(q) || s.display_name.toLowerCase().includes(q) || s.title.toLowerCase().includes(q))) continue;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.appendChild(el('span', 'id', s.id));
    btn.appendChild(el('span', null, s.display_name));
    btn.addEventListener('click', () => {
      state.scenarioId = s.id;
      state.extraOverrides = {};
      state.expandedRuleIds = new Set();
      state.expandedNAGates = new Set();
      closePicker();
      render();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function openPicker() {
  document.getElementById('scenario-picker').hidden = false;
  document.getElementById('scenario-chip').setAttribute('aria-expanded', 'true');
  document.getElementById('scenario-search').value = '';
  renderScenarioList('');
  document.getElementById('scenario-search').focus();
}

function closePicker() {
  document.getElementById('scenario-picker').hidden = true;
  document.getElementById('scenario-chip').setAttribute('aria-expanded', 'false');
}

// --- Theme --------------------------------------------------------------

function prefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function isDarkNow() {
  const current = document.documentElement.getAttribute('data-theme');
  return current ? current === 'dark' : prefersDark();
}

function updateThemeButton() {
  document.getElementById('theme-toggle').textContent = isDarkNow() ? 'Light' : 'Dark';
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch (e) {
    /* private mode / blocked storage: fall back to prefers-color-scheme */
  }
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  updateThemeButton();
}

function toggleTheme() {
  const next = isDarkNow() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('theme', next);
  } catch (e) {
    /* ignore */
  }
  updateThemeButton();
}

// --- Test runner (mirrors tests/engine.test.js and tests/sweep.test.js) ---
//
// This duplicates the axes and invariants from tests/sweep.test.js rather
// than importing it, because that file is a Node test module (it requires
// node:test). The scenarios, held-out cases and engine it exercises are the
// same ones fetched above, so a pass here means the same thing it means in
// `node --test`.

function decisionForCase(caseObj) {
  const facts = Engine.deepMergeFacts(DATA.baseFacts, caseObj.overrides);
  return { facts, decision: Engine.evaluate(facts, DATA.rulebook, DATA.calendar) };
}

function findResult(decision, ruleId) {
  return decision.results.find((r) => r.rule_id === ruleId);
}

const HELD_OUT_DATE_FIELD_ALIASES = {
  receipt_date: 'receipt',
  earliest_permitted_completion: 'earliest_completion',
  expiry_date: 'expiry',
  deemed_date: 'deemed_at',
  start_date: 'window_start',
  end_date: 'window_end',
};

function caseFailures(decision, expect, translateDateField) {
  const translate = translateDateField || ((f) => f);
  const failures = [];

  if (decision.verdict !== expect.verdict) failures.push('verdict');

  for (const [ruleId, s] of Object.entries(expect.rule_states || {})) {
    const r = findResult(decision, ruleId);
    if (!r || r.state !== s) failures.push(`${ruleId} state`);
  }

  for (const [key, expectedDate] of Object.entries(expect.dates || {})) {
    const [ruleId, rawField] = key.split('.');
    const field = translate(rawField);
    const r = findResult(decision, ruleId);
    if (!r || !r.computed || !r.computed[field] || r.computed[field].date !== expectedDate) failures.push(key);
  }

  for (const [ruleId, substr] of Object.entries(expect.reason_includes || {})) {
    const r = findResult(decision, ruleId);
    if (!r || !r.reason.includes(substr)) failures.push(`${ruleId} reason`);
  }

  for (const [ruleId, substr] of Object.entries(expect.cure_includes || {})) {
    const r = findResult(decision, ruleId);
    if (!r || !r.cure || !r.cure.includes(substr)) failures.push(`${ruleId} cure`);
  }

  for (const substr of expect.notes_include || []) {
    if (!decision.notes.some((n) => n.includes(substr))) failures.push('notes');
  }

  if (expect.no_outstanding && decision.results.some((r) => r.state === 'OUTSTANDING')) failures.push('no_outstanding');

  if (expect.checklist_last_contains) {
    const last = decision.checklist[decision.checklist.length - 1];
    if (!last || !last.text.includes(expect.checklist_last_contains)) failures.push('checklist_last');
  }

  if (expect.audit) {
    for (const [p, expected] of Object.entries(expect.audit)) {
      const val = p.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), decision.audit);
      if (val !== expected) failures.push(`audit.${p}`);
    }
  }

  return failures;
}

// --- Sweep (mirrors tests/sweep.test.js's axes and invariants) ------------

const SWEEP_RELATIONSHIP = [
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

const SWEEP_COMPETITOR = [
  { key: 'no', overrides: { transfer: { transferee_is_competitor: 'no' } } },
  { key: 'yes', overrides: { transfer: { transferee_is_competitor: 'yes' } } },
  { key: 'unknown', overrides: { transfer: { transferee_is_competitor: 'unknown' } } },
];

const SWEEP_GP_CONSENT = [
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

const SWEEP_COMPANY_CONSENT = [
  { key: 'received', overrides: { company: { consent: { status: 'received', received_at: '2026-09-02T15:00' } } } },
  { key: 'refused', overrides: { company: { consent: { status: 'refused' } } } },
  { key: 'unknown', overrides: { company: { consent: { status: 'unknown' } } } },
  { key: 'contradictory', overrides: { company: { consent: { status: 'contradictory' } } } },
  { key: 'not_requested', overrides: { company: { consent: { status: 'not_requested' } } } },
];

const SWEEP_ROFR_NOTICE = [
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

const SWEEP_ROFR_RESPONSE = [
  { key: 'waived', overrides: { company: { rofr_response: { status: 'waived', at: '2026-08-27' } } } },
  { key: 'none', overrides: { company: { rofr_response: { status: 'none' } } } },
  { key: 'exercised_whole', overrides: { company: { rofr_response: { status: 'exercised_whole' } } } },
  { key: 'exercised_partial', overrides: { company: { rofr_response: { status: 'exercised_partial' } } } },
  { key: 'unknown', overrides: { company: { rofr_response: { status: 'unknown' } } } },
];

const SWEEP_SANCTIONS = [
  { key: 'clear', overrides: { buyer: { sanctions: 'clear' } } },
  { key: 'hit', overrides: { buyer: { sanctions: 'hit' } } },
  { key: 'unknown', overrides: { buyer: { sanctions: 'unknown' } } },
  { key: 'pending', overrides: { buyer: { sanctions: 'pending' } } },
];

const SWEEP_KYC = [
  { key: 'cleared', overrides: { buyer: { kyc: 'cleared' } } },
  { key: 'unknown', overrides: { buyer: { kyc: 'unknown' } } },
  { key: 'pending', overrides: { buyer: { kyc: 'pending' } } },
];

const SWEEP_BO_LIMIT = [
  { key: '80', overrides: { fund: { beneficial_owners_current: 80 } } },
  { key: '95', overrides: { fund: { beneficial_owners_current: 95 } } },
  { key: 'null', overrides: { fund: { beneficial_owners_current: null } } },
];

const SWEEP_VERSION = [
  { key: 'yes', overrides: { documents_version_confirmed: 'yes' } },
  { key: 'no', overrides: { documents_version_confirmed: 'no' } },
];

function runSweep() {
  let checked = 0;
  let mustBlockFailures = 0;
  let uncertainClearFailures = 0;

  for (const relationship of SWEEP_RELATIONSHIP) {
    for (const competitor of SWEEP_COMPETITOR) {
      for (const gpConsent of SWEEP_GP_CONSENT) {
        for (const companyConsent of SWEEP_COMPANY_CONSENT) {
          for (const rofrNotice of SWEEP_ROFR_NOTICE) {
            for (const rofrResponse of SWEEP_ROFR_RESPONSE) {
              for (const sanctions of SWEEP_SANCTIONS) {
                for (const kyc of SWEEP_KYC) {
                  for (const boLimit of SWEEP_BO_LIMIT) {
                    for (const version of SWEEP_VERSION) {
                      let facts = DATA.baseFacts;
                      facts = Engine.deepMergeFacts(facts, relationship.overrides);
                      facts = Engine.deepMergeFacts(facts, competitor.overrides);
                      facts = Engine.deepMergeFacts(facts, gpConsent.overrides);
                      facts = Engine.deepMergeFacts(facts, companyConsent.overrides);
                      facts = Engine.deepMergeFacts(facts, rofrNotice.overrides);
                      facts = Engine.deepMergeFacts(facts, rofrResponse.overrides);
                      facts = Engine.deepMergeFacts(facts, sanctions.overrides);
                      facts = Engine.deepMergeFacts(facts, kyc.overrides);
                      facts = Engine.deepMergeFacts(facts, boLimit.overrides);
                      facts = Engine.deepMergeFacts(facts, version.overrides);

                      const decision = Engine.evaluate(facts, DATA.rulebook, DATA.calendar);
                      checked++;

                      const relIsAffiliate = relationship.key === 'affiliate';

                      const mustBlock =
                        competitor.key === 'yes' ||
                        sanctions.key === 'hit' ||
                        (!relIsAffiliate && companyConsent.key === 'refused') ||
                        (!relIsAffiliate && rofrResponse.key === 'exercised_whole') ||
                        (relationship.key === 'unrelated' && gpConsent.key === 'refused');
                      if (mustBlock && decision.verdict !== 'BLOCKED') mustBlockFailures++;

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
                      if (uncertain && decision.verdict === 'CHECKLIST_READY') uncertainClearFailures++;
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

function runAllTests() {
  let scenariosPassed = 0;
  for (const scenario of DATA.scenarios) {
    const { decision } = decisionForCase(scenario);
    if (caseFailures(decision, scenario.expect).length === 0) scenariosPassed++;
  }

  let heldoutPassed = 0;
  for (const c of DATA.heldout) {
    const { decision } = decisionForCase(c);
    if (caseFailures(decision, c.expect, (f) => HELD_OUT_DATE_FIELD_ALIASES[f] || f).length === 0) heldoutPassed++;
  }

  let unsafeClears = 0;
  for (const c of [...DATA.scenarios, ...DATA.heldout]) {
    const { decision } = decisionForCase(c);
    const hasUnsafeState = decision.results.some((r) => ['FAILED', 'UNKNOWN', 'CONTRADICTORY'].includes(r.state));
    if (hasUnsafeState && decision.verdict === 'CHECKLIST_READY') unsafeClears++;
  }

  const sweep = runSweep();

  return {
    scenariosPassed,
    scenariosTotal: DATA.scenarios.length,
    heldoutPassed,
    heldoutTotal: DATA.heldout.length,
    unsafeClears,
    sweep,
  };
}

function renderScorecard(results) {
  const container = document.getElementById('scorecard');
  container.hidden = false;
  container.innerHTML = '';

  function cell(label, value, unsafe) {
    const div = el('div', unsafe ? 'unsafe-nonzero' : null);
    div.appendChild(el('span', null, label));
    div.appendChild(el('b', null, value));
    container.appendChild(div);
  }

  cell('Unsafe clears', String(results.unsafeClears), results.unsafeClears > 0);
  cell('Scenarios', `${results.scenariosPassed}/${results.scenariosTotal}`);
  cell('Held-out', `${results.heldoutPassed}/${results.heldoutTotal}`);

  const sweepOk = results.sweep.mustBlockFailures === 0 && results.sweep.uncertainClearFailures === 0;
  const sweepLine = el(
    'p',
    'subline',
    `Sweep: ${results.sweep.checked.toLocaleString('en-US')} combinations checked, ${sweepOk ? 'all safe' : `${results.sweep.mustBlockFailures + results.sweep.uncertainClearFailures} failed`}.`
  );
  container.appendChild(sweepLine);
}

// --- Wiring ---------------------------------------------------------------

function wireEvents() {
  document.getElementById('scenario-chip').addEventListener('click', openPicker);
  document.getElementById('change-link').addEventListener('click', openPicker);
  document.getElementById('picker-close').addEventListener('click', closePicker);
  document.getElementById('scenario-search').addEventListener('input', (e) => renderScenarioList(e.target.value));
  document.getElementById('scenario-picker').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePicker();
  });

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  document.getElementById('audit-toggle').addEventListener('click', () => {
    const pre = document.getElementById('audit-json');
    const btn = document.getElementById('audit-toggle');
    const willShow = pre.hidden;
    pre.hidden = !willShow;
    btn.setAttribute('aria-expanded', String(willShow));
  });

  document.getElementById('run-tests').addEventListener('click', async () => {
    const btn = document.getElementById('run-tests');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Running…';
    await new Promise((resolve) => setTimeout(resolve, 20));
    const results = runAllTests();
    renderScorecard(results);
    btn.disabled = false;
    btn.textContent = original;
  });
}

async function init() {
  initTheme();
  wireEvents();
  await loadData();
  render();
}

init();
