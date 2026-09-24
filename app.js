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
  lastAnswerKey: null,
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

// --- Deal field definitions -------------------------------------------
//
// Each field writes straight into the facts object through applyOverride().
// Fields do not map one-to-one to engine rules: a single control (the buyer
// picker) can set several facts at once, and a field that does not apply to
// the current deal stays visible but disabled, with a one-line reason, per
// CLAUDE.md's "fail safe, never hide the question" spirit.

function applyOverride(overrideObj) {
  state.extraOverrides = Engine.deepMergeFacts(state.extraOverrides, overrideObj);
  render();
}

const BUYERS = [
  { name: 'Mira Chen', relationship: 'unrelated', competitor: 'no' },
  { name: 'Kestrel Automation Ltd', relationship: 'unrelated', competitor: 'yes', note: "on Helion's competitor list" },
  { name: 'Aldwych Angels II Ltd', relationship: 'affiliate', competitor: 'no', note: "the seller's affiliate" },
  { name: 'Harbour Growth Fund II LP', relationship: 'harbour_transferee', competitor: 'no', note: 'a Harbour-managed fund' },
];

const SELLERS = ['Aldwych Angels Ltd', 'Priya Nair', 'Harbour Family Office LLC'];

function isAffiliate(facts) {
  return facts.transfer.transferee_relationship === 'affiliate';
}

function isPledge(facts) {
  return facts.transfer.kind === 'pledge';
}

function buyerByName(name) {
  return BUYERS.find((b) => b.name === name);
}

// A generic select control over a dotted fact path, with plain-English
// option labels distinct from the engine's own values.
function selectControl(label, path, facts, choices, opts) {
  const current = getPath(facts, path);
  return {
    label,
    kind: 'select',
    choices,
    currentValue: current,
    disabledReason: opts && opts.disabledReason,
    buildOverride: (v) => nestOverride(path, v),
  };
}

function dateControl(label, path, facts, opts) {
  return {
    label,
    kind: 'date',
    currentValue: getPath(facts, path),
    disabledReason: opts && opts.disabledReason,
    buildOverride: (v) => nestOverride(path, v),
  };
}

function numberControl(label, path, facts, opts) {
  const val = getPath(facts, path);
  return {
    label,
    kind: 'number',
    currentValue: val === null || val === undefined ? '' : String(val),
    disabledReason: opts && opts.disabledReason,
    allowNull: opts && opts.allowNull,
    buildOverride: (v) => nestOverride(path, (opts && opts.allowNull && v === '') ? null : Number(v)),
  };
}

function buildDealSections(facts) {
  const affiliate = isAffiliate(facts);
  const pledge = isPledge(facts);
  const harbourSeller = facts.transfer.transferor === 'Harbour Family Office LLC';
  const gpConsent = facts.fund.gp_consent || {};
  const companyConsent = facts.company.consent || {};
  const rofrNotice = facts.company.rofr_notice || {};
  const rofrResponse = facts.company.rofr_response || {};

  const affiliateReason = 'Not needed: the buyer is the seller&rsquo;s affiliate.';
  const harbourReason = 'Not needed: the buyer is a Harbour Transferee under the side letter.';
  const pledgeReason = "Not needed: pledges don't need this until the security is enforced.";

  const sections = [];

  // --- The sale ---
  sections.push({
    id: 'deal-sale',
    title: 'The sale',
    fields: [
      {
        label: 'Seller',
        kind: 'select',
        choices: SELLERS.map((n) => ({ value: n, label: n })),
        currentValue: facts.transfer.transferor,
        buildOverride: (v) => ({ transfer: { transferor: v } }),
      },
      {
        label: 'Buyer',
        kind: 'select',
        choices: BUYERS.map((b) => ({ value: b.name, label: b.note ? `${b.name} (${b.note})` : b.name })),
        currentValue: facts.transfer.transferee,
        buildOverride: (v) => {
          const b = buyerByName(v);
          return { transfer: { transferee: v, transferee_relationship: b.relationship, transferee_is_competitor: b.competitor } };
        },
      },
      {
        label: 'Type',
        kind: 'select',
        choices: [{ value: 'sale', label: 'Sale' }, { value: 'pledge', label: 'Pledge' }],
        currentValue: facts.transfer.kind,
        buildOverride: (v) => ({ transfer: { kind: v } }),
      },
      {
        label: 'How much of the stake',
        kind: 'select',
        choices: [{ value: 'whole', label: 'Whole stake' }, { value: 'part', label: 'Part of the stake' }],
        currentValue: facts.transfer.fraction >= 1 ? 'whole' : 'part',
        buildOverride: (v) => ({ transfer: { fraction: v === 'whole' ? 1 : (facts.transfer.fraction < 1 ? facts.transfer.fraction : 0.5) } }),
      },
      numberControl("Seller's Capital Contribution (US$)", 'transfer.transferor_capital_contribution', facts),
      ...(facts.transfer.fraction < 1
        ? [
            {
              label: 'Fraction transferred (%)',
              kind: 'number',
              currentValue: String(Math.round(facts.transfer.fraction * 100)),
              buildOverride: (v) => ({ transfer: { fraction: Number(v) / 100 } }),
            },
          ]
        : []),
      dateControl('Proposed completion', 'transfer.proposed_completion', facts),
    ],
  });

  // --- The fund ---
  const fundFields = [
    {
      label: "Has the fund manager (the GP) consented?",
      kind: 'select',
      choices: [
        { value: 'received', label: 'Yes, in writing' },
        { value: 'requested', label: 'Asked, no reply' },
        { value: 'refused', label: 'Refused' },
        { value: 'not_requested', label: 'Not asked' },
        { value: 'unknown', label: 'Unclear' },
      ],
      currentValue: gpConsent.status,
      disabledReason: affiliate ? affiliateReason : (facts.transfer.transferee_relationship === 'harbour_transferee' ? harbourReason : null),
      buildOverride: (v) => {
        const merged = { ...gpConsent, status: v };
        if (v === 'requested' && !merged.requested_at) merged.requested_at = `${facts.as_of}T10:00`;
        if (v === 'received' && !merged.received_at) merged.received_at = merged.requested_at || `${facts.as_of}T10:00`;
        return { fund: { gp_consent: merged } };
      },
    },
    numberControl('Beneficial owners before the sale', 'fund.beneficial_owners_current', facts, {
      allowNull: true,
      disabledReason: pledge ? pledgeReason : null,
    }),
  ];
  sections.push({ id: 'deal-fund', title: 'The fund', fields: fundFields });

  // --- Harbour side letter (only when seller is Harbour) ---
  if (harbourSeller) {
    sections.push({
      id: 'deal-harbour',
      title: 'Harbour side letter',
      fields: [
        {
          label: 'Did the GP receive a complete request?',
          kind: 'select',
          choices: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'unknown', label: 'Unclear' }],
          currentValue: gpConsent.complete === undefined ? 'yes' : gpConsent.complete,
          buildOverride: (v) => ({ fund: { gp_consent: { ...gpConsent, complete: v } } }),
        },
        {
          label: 'When was it received?',
          kind: 'datetime-local',
          currentValue: gpConsent.requested_at || '',
          buildOverride: (v) => ({ fund: { gp_consent: { ...gpConsent, requested_at: v } } }),
        },
      ],
    });
  }

  // --- Helion (the company) ---
  const companyFields = [];
  if (affiliate) {
    const gpNotice = facts.fund.gp_permitted_notice || {};
    const companyNotice = facts.company.permitted_notice || {};
    companyFields.push(
      {
        label: 'Date the GP received the permitted-transfer notice',
        kind: 'datetime-local',
        currentValue: gpNotice.sent_at || '',
        buildOverride: (v) => ({ fund: { gp_permitted_notice: { ...gpNotice, status: 'delivered', sent_at: v, complete: 'yes' } } }),
      },
      {
        label: 'Date Helion received the permitted-transfer notice',
        kind: 'datetime-local',
        currentValue: companyNotice.sent_at || '',
        buildOverride: (v) => ({ company: { permitted_notice: { ...companyNotice, status: 'delivered', sent_at: v, complete: 'yes' } } }),
      }
    );
  } else {
    companyFields.push(
      {
        label: 'Has Helion consented?',
        kind: 'select',
        choices: [
          { value: 'received', label: 'Yes, in writing' },
          { value: 'unknown', label: 'Only agreed on a call' },
          { value: 'refused', label: 'Refused' },
          { value: 'requested', label: 'Asked, no reply' },
          { value: 'not_requested', label: 'Not asked' },
          { value: 'contradictory', label: 'Conflicting evidence' },
        ],
        currentValue: companyConsent.status,
        buildOverride: (v) => {
          const merged = { ...companyConsent, status: v };
          if (v === 'requested' && !merged.requested_at) merged.requested_at = `${facts.as_of}T10:00`;
          if (v === 'received' && !merged.received_at) merged.received_at = merged.requested_at || `${facts.as_of}T10:00`;
          return { company: { consent: merged } };
        },
      },
      {
        label: "Transfer Notice for Helion's right of first refusal",
        note: "Helion's right to buy the stake first",
        kind: 'select',
        choices: [
          { value: 'not_sent', label: 'Not sent' },
          { value: 'sent_no_proof', label: 'Sent, no proof' },
          { value: 'delivered', label: 'Delivered' },
        ],
        currentValue: rofrNotice.status === 'not_applicable' ? 'not_sent' : rofrNotice.status,
        buildOverride: (v) => {
          const merged = { ...rofrNotice, status: v };
          if ((v === 'delivered' || v === 'sent_no_proof') && !merged.sent_at) merged.sent_at = `${facts.as_of}T10:00`;
          if (merged.complete === undefined) merged.complete = 'yes';
          if (v === 'delivered') merged.proof_of_delivery = 'yes';
          return { company: { rofr_notice: merged } };
        },
      }
    );
    if (rofrNotice.status === 'delivered') {
      const sentAt = rofrNotice.sent_at || `${facts.as_of}T10:00`;
      const [datePart] = sentAt.split('T');
      const time = sentAt.split('T')[1] || '10:00';
      const isAfterFive = time >= '17:00';
      companyFields.push(
        {
          label: 'Date the Transfer Notice was delivered',
          kind: 'date',
          currentValue: datePart,
          buildOverride: (v) => ({ company: { rofr_notice: { ...rofrNotice, sent_at: `${v}T${time}` } } }),
        },
        {
          label: 'Delivered before or after 5pm New York time?',
          kind: 'select',
          choices: [{ value: 'before', label: 'Before 5pm' }, { value: 'after', label: 'After 5pm' }],
          currentValue: isAfterFive ? 'after' : 'before',
          buildOverride: (v) => ({ company: { rofr_notice: { ...rofrNotice, sent_at: `${datePart}T${v === 'after' ? '18:00' : '16:00'}` } } }),
        },
        {
          label: "Helion's response",
          kind: 'select',
          choices: [
            { value: 'waived', label: 'Waived' },
            { value: 'none', label: 'No reply yet' },
            { value: 'exercised_whole', label: 'Bought the whole stake' },
            { value: 'exercised_partial', label: 'Tried to buy half' },
            { value: 'unknown', label: 'Unclear' },
          ],
          currentValue: rofrResponse.status,
          buildOverride: (v) => {
            const merged = { ...rofrResponse, status: v };
            if (v === 'waived' && !merged.at) merged.at = facts.as_of;
            return { company: { rofr_response: merged } };
          },
        }
      );
    }
  }
  sections.push({ id: 'deal-company', title: "Helion's agreement", fields: companyFields });

  // --- Buyer checks ---
  sections.push({
    id: 'deal-buyer',
    title: 'Buyer checks',
    fields: [
      {
        label: 'KYC / AML',
        kind: 'select',
        choices: [
          { value: 'cleared', label: 'Cleared' },
          { value: 'pending', label: 'Pending' },
          { value: 'not_started', label: 'Not started' },
          { value: 'unknown', label: 'Unclear' },
        ],
        currentValue: facts.buyer.kyc,
        buildOverride: (v) => ({ buyer: { kyc: v } }),
      },
      {
        label: 'Sanctions screening',
        kind: 'select',
        choices: [
          { value: 'clear', label: 'Clear' },
          { value: 'hit', label: 'Hit' },
          { value: 'pending', label: 'Pending' },
          { value: 'unknown', label: 'Unclear' },
        ],
        currentValue: facts.buyer.sanctions,
        buildOverride: (v) => ({ buyer: { sanctions: v } }),
      },
      {
        label: 'Accredited investor status',
        kind: 'select',
        choices: [
          { value: 'confirmed', label: 'Confirmed' },
          { value: 'not_accredited', label: 'Not accredited' },
          { value: 'unknown', label: 'Unclear' },
        ],
        currentValue: facts.buyer.accredited,
        disabledReason: pledge ? pledgeReason : null,
        buildOverride: (v) => ({ buyer: { accredited: v } }),
      },
      {
        label: 'Tax form',
        kind: 'select',
        choices: [{ value: 'received', label: 'Received' }, { value: 'outstanding', label: 'Outstanding' }],
        currentValue: facts.buyer.tax_form,
        disabledReason: pledge ? pledgeReason : null,
        buildOverride: (v) => ({ buyer: { tax_form: v } }),
      },
      {
        label: 'Signed adherence agreement',
        kind: 'select',
        choices: [{ value: 'signed', label: 'Signed' }, { value: 'outstanding', label: 'Outstanding' }],
        currentValue: facts.buyer.adherence,
        disabledReason: pledge ? pledgeReason : null,
        buildOverride: (v) => ({ buyer: { adherence: v } }),
      },
    ],
  });

  // --- Checked as of ---
  sections.push({
    id: 'deal-asof',
    title: 'Checked as of',
    fields: [dateControl('Checked as of', 'as_of', facts)],
  });

  return sections;
}

function renderField(field) {
  const wrap = el('div', 'field' + (field.disabledReason ? ' field-disabled' : ''));
  const labelEl = el('label', 'field-label', field.label);
  wrap.appendChild(labelEl);
  if (field.note) wrap.appendChild(el('p', 'field-note', field.note));

  if (field.kind === 'select') {
    const group = el('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', field.label);
    for (const choice of field.choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = choice.label;
      btn.disabled = Boolean(field.disabledReason);
      const pressed = String(choice.value) === String(field.currentValue);
      btn.setAttribute('aria-pressed', String(pressed));
      btn.addEventListener('click', () => applyOverride(field.buildOverride(choice.value)));
      group.appendChild(btn);
    }
    wrap.appendChild(group);
  } else {
    const id = 'field-' + Math.random().toString(36).slice(2);
    labelEl.htmlFor = id;
    const input = document.createElement('input');
    input.type = field.kind;
    input.id = id;
    input.disabled = Boolean(field.disabledReason);
    if (field.kind === 'number') input.step = 'any';
    if (field.currentValue !== undefined && field.currentValue !== null) input.value = field.currentValue;
    input.addEventListener('change', () => applyOverride(field.buildOverride(input.value)));
    wrap.appendChild(input);
  }

  if (field.disabledReason) {
    wrap.appendChild(el('p', 'field-reason', field.disabledReason.replace('&rsquo;', '’')));
  }
  return wrap;
}

function renderDealForm(facts) {
  const container = document.getElementById('deal-form');
  container.innerHTML = '';
  for (const section of buildDealSections(facts)) {
    const sectionEl = el('section', 'deal-section');
    sectionEl.id = section.id;
    sectionEl.appendChild(el('h2', 'deal-section-title', section.title));
    for (const field of section.fields) sectionEl.appendChild(renderField(field));
    container.appendChild(sectionEl);
  }
}

// --- Answer panel -------------------------------------------------------

const GATE_GROUPS = [
  { label: 'Fund agreement', gates: ['preliminary', 'fund'] },
  { label: 'Side letter', gates: ['side_letter'] },
  { label: "Helion's agreement", gates: ['company'] },
  { label: 'Buyer checks', gates: ['buyer'] },
];

function gateGroupStatus(decision, ruleMap, gateIds) {
  const results = decision.results.filter((r) => gateIds.includes(ruleMap.get(r.rule_id).gate));
  const applicable = results.filter((r) => r.state !== 'NOT_APPLICABLE');
  if (applicable.length === 0) return 'Not relevant';
  if (applicable.some((r) => r.state === 'FAILED')) return 'Fails';
  if (applicable.some((r) => r.state === 'UNKNOWN' || r.state === 'CONTRADICTORY')) return 'Needs a lawyer';
  if (applicable.some((r) => r.state === 'OUTSTANDING')) return 'Action needed';
  return 'Met';
}

function verdictLabelFor(decision) {
  if (decision.verdict === 'BLOCKED') return { text: 'BLOCKED', cls: 'blocked' };
  if (decision.verdict === 'ESCALATE') return { text: 'LAWYER REVIEW', cls: 'escalate' };
  const outstandingCount = decision.results.filter((r) => r.state === 'OUTSTANDING').length;
  if (outstandingCount > 0) return { text: `${outstandingCount} ACTION${outstandingCount === 1 ? '' : 'S'} OUTSTANDING`, cls: '' };
  return { text: 'READY FOR THE GP TO RECORD', cls: '' };
}

function renderAnswer(decision, ruleMap) {
  const verdict = verdictLabelFor(decision);
  const headline = ensureSentence(humanize(decision.headline));

  const mobileVerdict = document.getElementById('mobile-verdict');
  mobileVerdict.textContent = verdict.text;
  mobileVerdict.className = 'mobile-verdict' + (verdict.cls ? ` ${verdict.cls}` : '');
  document.getElementById('mobile-headline').textContent = headline;

  const panel = document.getElementById('answer-panel');
  panel.innerHTML = '';
  panel.appendChild(el('p', 'verdict-label' + (verdict.cls ? ` ${verdict.cls}` : ''), verdict.text));
  panel.appendChild(el('h1', 'answer-headline', headline));

  const docList = el('dl', 'doc-status-list');
  for (const group of GATE_GROUPS) {
    const status = gateGroupStatus(decision, ruleMap, group.gates);
    docList.appendChild(el('dt', null, group.label));
    const statusClass = status === 'Fails' ? 'fails' : status === 'Needs a lawyer' ? 'needs-lawyer' : status === 'Action needed' ? 'action-needed' : '';
    docList.appendChild(el('dd', statusClass, status));
  }
  panel.appendChild(docList);

  panel.appendChild(el('p', 'answer-hint', "Try picking a different buyer, or change Helion's consent to “Only agreed on a call”."));

  const key = `${decision.verdict}|${decision.headline}`;
  if (state.lastAnswerKey !== null && state.lastAnswerKey !== key) {
    for (const target of [panel, document.getElementById('mobile-answer-bar')]) {
      target.classList.remove('answer-flash');
      // Force reflow so the animation restarts even if the class never left.
      void target.offsetWidth;
      target.classList.add('answer-flash');
    }
  }
  state.lastAnswerKey = key;
}

// --- Why section ----------------------------------------------------------

function renderWhy(decision, decidingId, ruleMap) {
  const container = document.getElementById('why-body');
  container.innerHTML = '';
  if (!decidingId) {
    container.appendChild(el('p', null, 'Every condition is evidenced. There is nothing left to decide.'));
    return;
  }
  const rule = ruleMap.get(decidingId);
  const result = decision.results.find((r) => r.rule_id === decidingId);

  container.appendChild(el('p', 'why-reason', result.reason));

  if (result.computed) {
    const working = Object.values(result.computed).map((v) => v.working).filter(Boolean).join(' · ');
    if (working) container.appendChild(el('div', 'working', working));
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
      container.appendChild(source);
    }
    if (rule.citations.length > 1) {
      const others = el('div', 'cites');
      for (const c of rule.citations.slice(1)) others.appendChild(el('span', 'cite', formatCitation(c)));
      container.appendChild(others);
    }
  }

  if (decision.notes.length) {
    const notes = el('ul', 'notes');
    for (const n of decision.notes) notes.appendChild(el('li', null, n));
    container.appendChild(notes);
  }
}

// --- What happens next ------------------------------------------------

function renderNext(decision, ruleMap) {
  const heading = document.getElementById('next-heading');
  const list = document.getElementById('next-list');
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

  heading.textContent = 'What happens next';
  for (const item of decision.checklist) {
    const li = document.createElement('li');
    if (item.owner) li.appendChild(el('div', 'owner', item.owner));
    li.appendChild(el('div', null, ensureSentence(humanize(item.text))));
    if (item.due) li.appendChild(el('div', 'due', 'Due ' + Dates.formatReadable(item.due)));
    list.appendChild(li);
  }
}

// --- Every rule we checked ---------------------------------------------

function renderRuleRow(rule, result) {
  const wrap = el('div', 'rule-row');
  const nonMet = result.state === 'FAILED' || result.state === 'UNKNOWN' || result.state === 'CONTRADICTORY' || result.state === 'OUTSTANDING';
  const row = el('div', 'rule-row-line');
  const nameWrap = el('span');
  nameWrap.appendChild(el('span', 'name', rule.title));
  nameWrap.appendChild(el('span', 'detail', result.reason));
  row.appendChild(nameWrap);
  row.appendChild(el('span', 'state' + (nonMet ? ' nonmet' : ''), STATE_LABELS[result.state] || result.state));
  wrap.appendChild(row);
  return wrap;
}

function renderAllRules(decision, ruleMap) {
  const container = document.getElementById('all-rules-body');
  container.innerHTML = '';
  const gateLabel = Object.fromEntries(DATA.rulebook.gates.map((g) => [g.id, g.label]));
  for (const gate of DATA.rulebook.gates) {
    const rulesInGate = decision.results.filter((r) => ruleMap.get(r.rule_id).gate === gate.id);
    if (rulesInGate.length === 0) continue;
    const group = el('div', 'gate-group');
    group.appendChild(el('div', 'gate-label', gateLabel[gate.id] || gate.id));
    for (const result of rulesInGate) group.appendChild(renderRuleRow(ruleMap.get(result.rule_id), result));
    container.appendChild(group);
  }
}

// --- Audit ---------------------------------------------------------------

function renderAudit(decision) {
  document.getElementById('audit-json').textContent = JSON.stringify(decision.audit, null, 2);
}

// --- Examples -----------------------------------------------------------

function renderExamples() {
  const list = document.getElementById('example-list');
  list.innerHTML = '';
  for (const s of DATA.scenarios) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.appendChild(el('span', 'id', s.id));
    btn.appendChild(el('span', null, s.display_name));
    btn.addEventListener('click', () => {
      state.scenarioId = s.id;
      state.extraOverrides = {};
      render();
      document.getElementById('deal-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

// --- Rendering root -------------------------------------------------------

function renderError() {
  document.getElementById('mobile-verdict').textContent = 'CANNOT EVALUATE';
  document.getElementById('mobile-headline').textContent = 'Reload the page to try again.';
  const panel = document.getElementById('answer-panel');
  panel.innerHTML = '';
  panel.appendChild(el('p', 'verdict-label escalate', 'CANNOT EVALUATE'));
  panel.appendChild(el('h1', 'answer-headline', 'Something went wrong loading this scenario.'));
}

function render() {
  let facts;
  let decision;
  try {
    facts = currentFacts();
    decision = Engine.evaluate(facts, DATA.rulebook, DATA.calendar);
  } catch {
    renderError();
    return;
  }
  const ruleMap = new Map(DATA.rulebook.rules.map((r) => [r.id, r]));
  const decidingId = decidingRuleId(decision);

  renderDealForm(facts);
  renderAnswer(decision, ruleMap);
  renderWhy(decision, decidingId, ruleMap);
  renderNext(decision, ruleMap);
  renderAllRules(decision, ruleMap);
  renderAudit(decision);
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

// --- Test runner / sweep (mirrors tests/engine.test.js and tests/sweep.test.js) ---
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

function* generateSweepCases() {
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
                      yield { relationship, competitor, gpConsent, companyConsent, rofrNotice, rofrResponse, sanctions, kyc, boLimit, version };
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

function evaluateSweepCase(c) {
  let facts = DATA.baseFacts;
  facts = Engine.deepMergeFacts(facts, c.relationship.overrides);
  facts = Engine.deepMergeFacts(facts, c.competitor.overrides);
  facts = Engine.deepMergeFacts(facts, c.gpConsent.overrides);
  facts = Engine.deepMergeFacts(facts, c.companyConsent.overrides);
  facts = Engine.deepMergeFacts(facts, c.rofrNotice.overrides);
  facts = Engine.deepMergeFacts(facts, c.rofrResponse.overrides);
  facts = Engine.deepMergeFacts(facts, c.sanctions.overrides);
  facts = Engine.deepMergeFacts(facts, c.kyc.overrides);
  facts = Engine.deepMergeFacts(facts, c.boLimit.overrides);
  facts = Engine.deepMergeFacts(facts, c.version.overrides);

  const decision = Engine.evaluate(facts, DATA.rulebook, DATA.calendar);
  const relIsAffiliate = c.relationship.key === 'affiliate';

  const mustBlock =
    c.competitor.key === 'yes' ||
    c.sanctions.key === 'hit' ||
    (!relIsAffiliate && c.companyConsent.key === 'refused') ||
    (!relIsAffiliate && c.rofrResponse.key === 'exercised_whole') ||
    (c.relationship.key === 'unrelated' && c.gpConsent.key === 'refused');

  const uncertain =
    c.competitor.key === 'unknown' ||
    (!relIsAffiliate && ['unknown', 'contradictory'].includes(c.gpConsent.key)) ||
    (!relIsAffiliate && ['unknown', 'contradictory'].includes(c.companyConsent.key)) ||
    (!relIsAffiliate && ['sent_no_proof', 'delivered_complete_unknown'].includes(c.rofrNotice.key)) ||
    (!relIsAffiliate && ['unknown', 'exercised_partial'].includes(c.rofrResponse.key)) ||
    c.sanctions.key === 'unknown' ||
    c.kyc.key === 'unknown' ||
    c.boLimit.key === 'null' ||
    c.version.key === 'no';

  return { decision, mustBlock, uncertain };
}

async function runSweepWithProgress(onProgress) {
  const CHUNK = 4000;
  let checked = 0;
  let mustBlockFailures = 0;
  let uncertainClearFailures = 0;
  let sinceYield = 0;

  for (const c of generateSweepCases()) {
    const { decision, mustBlock, uncertain } = evaluateSweepCase(c);
    checked++;
    if (mustBlock && decision.verdict !== 'BLOCKED') mustBlockFailures++;
    if (uncertain && decision.verdict === 'CHECKLIST_READY') uncertainClearFailures++;
    sinceYield++;
    if (sinceYield >= CHUNK) {
      sinceYield = 0;
      onProgress(checked);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress(checked);
  return { checked, mustBlockFailures, uncertainClearFailures };
}

const HELD_OUT_DATE_FIELD_ALIASES = {
  receipt_date: 'receipt',
  earliest_permitted_completion: 'earliest_completion',
  expiry_date: 'expiry',
  deemed_date: 'deemed_at',
  start_date: 'window_start',
  end_date: 'window_end',
};

function findResult(decision, ruleId) {
  return decision.results.find((r) => r.rule_id === ruleId);
}

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

async function runSweepAndReport() {
  const btn = document.getElementById('run-sweep');
  const result = document.getElementById('sweep-result');
  btn.disabled = true;
  const original = btn.textContent;

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

  const sweep = await runSweepWithProgress((checked) => {
    btn.textContent = `Checking… ${checked.toLocaleString('en-US')} of 486,000`;
  });

  const unsafe = sweep.mustBlockFailures + sweep.uncertainClearFailures;
  result.innerHTML = '';
  result.appendChild(el('p', 'sweep-unsafe' + (unsafe > 0 ? ' unsafe-nonzero' : ''), `${unsafe} unsafe clears`));
  result.appendChild(
    el(
      'p',
      'subline',
      `${sweep.checked.toLocaleString('en-US')} combinations checked. Scenarios: ${scenariosPassed}/${DATA.scenarios.length}. Held-out: ${heldoutPassed}/${DATA.heldout.length}.`
    )
  );

  btn.disabled = false;
  btn.textContent = original;
}

// --- Wiring ---------------------------------------------------------------

function wireEvents() {
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  document.getElementById('audit-toggle').addEventListener('click', () => {
    const pre = document.getElementById('audit-json');
    const btn = document.getElementById('audit-toggle');
    const willShow = pre.hidden;
    pre.hidden = !willShow;
    btn.setAttribute('aria-expanded', String(willShow));
  });

  document.getElementById('all-rules-toggle').addEventListener('click', () => {
    const body = document.getElementById('all-rules-body');
    const btn = document.getElementById('all-rules-toggle');
    const willShow = body.hidden;
    body.hidden = !willShow;
    btn.setAttribute('aria-expanded', String(willShow));
  });

  document.getElementById('run-sweep').addEventListener('click', runSweepAndReport);
}

async function init() {
  initTheme();
  wireEvents();
  await loadData();
  renderExamples();
  render();
}

init();
