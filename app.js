'use strict';

// UI only: rendering and interaction. All legal logic lives in engine/engine.js
// and engine/dates.js, loaded as <script> tags before this file and exposed on
// window.TransferDeskEngine / window.TransferDeskDates. Nothing here decides a
// rule state, a date or a verdict; it only reads what evaluate() returns and
// the data files fetched below.

const Engine = window.TransferDeskEngine;
const Dates = window.TransferDeskDates;

const DATA = {};

// Requests shown on the landing queue. Each is seeded from a scenario, with
// a reference, a received date and (for unrelated buyers and non-Harbour
// sellers only) a display-level party override, applied here rather than in
// scenarios.json so the scenario's own facts and expected verdict are
// untouched. Renaming has no legal effect: no rule in engine.js keys off a
// party's name except S-SCOPE's exact match on "Harbour Family Office LLC",
// which none of these overrides touch. Session edits made in the deal view
// are kept per request id in state.requestOverrides so the queue reflects
// them without touching this config or the scenario data itself.
const QUEUE_ROWS = [
  { id: 'T09', ref: 'TR-0139', received: '2026-09-14' },
  {
    id: 'T10',
    ref: 'TR-0142',
    received: '2026-09-21',
    displayOverrides: { transfer: { transferor: 'Oakfield Family Trust', transferee: 'Jonas Lindqvist' } },
  },
  { id: 'T22', ref: 'TR-0144', received: '2026-09-23', displayOverrides: { transfer: { transferee: 'Tomas Weber' } } },
  {
    id: 'T05',
    ref: 'TR-0136',
    received: '2026-09-08',
    displayOverrides: { transfer: { transferor: 'Clara Voss', transferee: 'Beacon Street Partners LP' } },
  },
  { id: 'T19', ref: 'TR-0147', received: '2026-09-26' },
  { id: 'T13', ref: 'TR-0131', received: '2026-08-25' },
  { id: 'T26', ref: 'TR-0150', received: '2026-09-29' },
  { id: 'T01', ref: 'TR-0128', received: '2026-08-20', displayOverrides: { transfer: { transferor: 'Daniel Okafor' } } },
];

const QUEUE_IDS = QUEUE_ROWS.map((r) => r.id);
const QUEUE_DISPLAY_OVERRIDES = Object.fromEntries(QUEUE_ROWS.filter((r) => r.displayOverrides).map((r) => [r.id, r.displayOverrides]));
const QUEUE_META = Object.fromEntries(QUEUE_ROWS.map((r) => [r.id, { ref: r.ref, received: r.received }]));

const state = {
  route: { view: 'queue' },
  requestOverrides: {},
  dealCollapsed: new Set(['deal-fund', 'deal-harbour', 'deal-company', 'deal-buyer', 'deal-asof']),
  lastAnswerKey: null,
  docViewer: { open: false, doc: null },
};

const DOC_LIST = [
  { key: 'LPA', label: 'LPA' },
  { key: 'SA', label: "Stockholders’ agreement" },
  { key: 'SL', label: 'Side letter' },
];

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

// --- Routing --------------------------------------------------------------

function parseHash() {
  const m = location.hash.match(/^#\/request\/(.+)$/);
  if (m) return { view: 'request', id: decodeURIComponent(m[1]) };
  return { view: 'queue' };
}

function navigate(hash) {
  location.hash = hash;
}

// --- Facts for a given request id -----------------------------------------

function factsForId(id) {
  let base;
  if (id === 'NEW') {
    base = DATA.baseFacts;
  } else {
    const scenario = DATA.scenarios.find((s) => s.id === id);
    base = scenario ? Engine.deepMergeFacts(DATA.baseFacts, scenario.overrides) : DATA.baseFacts;
  }
  if (QUEUE_DISPLAY_OVERRIDES[id]) base = Engine.deepMergeFacts(base, QUEUE_DISPLAY_OVERRIDES[id]);
  return Engine.deepMergeFacts(base, state.requestOverrides[id] || {});
}

function decisionForId(id) {
  const facts = factsForId(id);
  return { facts, decision: Engine.evaluate(facts, DATA.rulebook, DATA.calendar) };
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

function nextActionOf(decision) {
  return decision.checklist.find((item) => item.source_rule) || null;
}

// --- Queue ------------------------------------------------------------

function transferSuffix(facts) {
  if (facts.transfer.kind === 'pledge') return ' (pledge)';
  if (facts.transfer.fraction < 1) return ' (part of stake)';
  return '';
}

// Queue text drops the year (dates are all within one quarter) and never
// says "The Company" / "The General Partner": those are the generic party
// labels the engine's consent findings are built from (see
// engine.js's consentOutcome), and the queue always calls them by name.
function shortReadable(dateStr) {
  return Dates.formatReadable(dateStr).replace(/ \d{4}$/, '');
}

function queueWording(text) {
  if (!text) return text;
  return text.replace(/\bThe Company\b/g, 'Helion').replace(/\bThe General Partner\b/g, 'the GP').replace(/\bGeneral Partner\b/g, 'GP');
}

function firstSentence(text) {
  const m = text.match(/^[^.!?]*[.!?]/);
  return m ? m[0] : text;
}

function daysAwayText(fromISO, toISO) {
  const from = Date.UTC(...fromISO.split('-').map(Number));
  const to = Date.UTC(...toISO.split('-').map(Number));
  const diff = Math.round((to - from) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'in 1 day';
  if (diff > 1) return `in ${diff} days`;
  if (diff === -1) return '1 day ago';
  return `${-diff} days ago`;
}

function queueRowFor(id) {
  const { facts, decision } = decisionForId(id);

  let statusWord;
  let statusClass = '';
  let group;

  if (decision.verdict === 'BLOCKED') {
    statusWord = 'BLOCKED';
    statusClass = 'blocked';
    group = 0;
  } else if (decision.verdict === 'ESCALATE') {
    statusWord = 'LAWYER';
    statusClass = 'escalate';
    group = 1;
  } else {
    const outstandingCount = decision.results.filter((r) => r.state === 'OUTSTANDING').length;
    if (outstandingCount > 0) {
      statusWord = `${outstandingCount} action${outstandingCount === 1 ? '' : 's'}`;
      group = 2;
    } else {
      statusWord = 'READY';
      group = 3;
    }
  }

  const whatMatters = queueWording(firstSentence(humanize(decision.headline)));
  const dueDate = (nextActionOf(decision) || {}).due || null;
  const meta = QUEUE_META[id];

  return {
    id,
    ref: meta.ref,
    received: meta.received,
    sellerBuyer: `${facts.transfer.transferor} → ${facts.transfer.transferee}${transferSuffix(facts)}`,
    statusWord,
    statusClass,
    group,
    dueDate,
    whatMatters,
    completion: facts.transfer.proposed_completion,
    completionAway: daysAwayText(facts.as_of, facts.transfer.proposed_completion),
  };
}

function compareRows(a, b) {
  if (a.group !== b.group) return a.group - b.group;
  if (a.group === 2) {
    if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
  }
  return 0;
}

function renderCompletionCell(row) {
  const wrap = el('div');
  wrap.appendChild(el('div', null, `${shortReadable(row.completion)} · ${row.completionAway}`));
  if (row.dueDate) wrap.appendChild(el('div', 'queue-due-date', `Due ${shortReadable(row.dueDate)}`));
  return wrap;
}

function renderQueue() {
  const rows = QUEUE_ROWS.map((r) => r.id).map(queueRowFor).sort(compareRows);

  const counts = { blocked: 0, lawyer: 0, actions: 0, ready: 0 };
  for (const r of rows) {
    if (r.group === 0) counts.blocked++;
    else if (r.group === 1) counts.lawyer++;
    else if (r.group === 2) counts.actions++;
    else counts.ready++;
  }

  document.getElementById('queue-summary').textContent =
    `${rows.length} requests: ${counts.blocked} blocked · ${counts.lawyer} need a lawyer · ${counts.actions} actions outstanding · ${counts.ready} ready to record`;

  const tbody = document.getElementById('queue-table-body');
  tbody.innerHTML = '';
  const mobileList = document.getElementById('queue-list-mobile');
  mobileList.innerHTML = '';

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.className = 'queue-row';

    const requestCell = el('td');
    requestCell.appendChild(el('div', null, row.sellerBuyer));
    requestCell.appendChild(el('div', 'queue-meta', `${row.ref} · received ${shortReadable(row.received)}`));
    tr.appendChild(requestCell);

    tr.appendChild(el('td', 'queue-status' + (row.statusClass ? ` ${row.statusClass}` : ''), row.statusWord));
    tr.appendChild(el('td', 'queue-matters', row.whatMatters));
    const completionCell = document.createElement('td');
    completionCell.className = 'queue-completion';
    completionCell.appendChild(renderCompletionCell(row));
    tr.appendChild(completionCell);

    const open = () => navigate(`#/request/${row.id}`);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    tbody.appendChild(tr);

    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'queue-row-mobile';
    btn.appendChild(el('span', 'queue-row-mobile-top', row.sellerBuyer));
    btn.appendChild(el('span', 'queue-row-mobile-meta', `${row.ref} · received ${shortReadable(row.received)}`));
    const statusLine = el('span', 'queue-row-mobile-status' + (row.statusClass ? ` ${row.statusClass}` : ''), row.statusWord);
    btn.appendChild(statusLine);
    btn.appendChild(el('span', 'queue-row-mobile-matters', row.whatMatters));
    btn.appendChild(el('span', 'queue-row-mobile-due', `${shortReadable(row.completion)} · ${row.completionAway}`));
    if (row.dueDate) btn.appendChild(el('span', 'queue-row-mobile-due', `Due ${shortReadable(row.dueDate)}`));
    btn.addEventListener('click', open);
    li.appendChild(btn);
    mobileList.appendChild(li);
  }
}

// --- Deal field definitions -------------------------------------------
//
// Each field writes straight into the facts object through applyOverride().
// Fields do not map one-to-one to engine rules: a single control (the buyer
// picker) can set several facts at once, and a field that does not apply to
// the current deal stays visible but disabled, with a one-line reason, per
// CLAUDE.md's "fail safe, never hide the question" spirit.

function applyOverride(overrideObj) {
  const id = state.route.id;
  state.requestOverrides[id] = Engine.deepMergeFacts(state.requestOverrides[id] || {}, overrideObj);
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

function dateControl(label, path, facts, opts) {
  return {
    label,
    kind: 'date',
    currentValue: getPath(facts, path),
    disabledReason: opts && opts.disabledReason,
    buildOverride: (v) => nestOverride(path, v),
  };
}

const CONSENT_LABELS = {
  received: 'Given in writing',
  requested: 'Asked, no reply',
  refused: 'Refused',
  not_requested: 'Not asked',
  unknown: 'Unclear',
  contradictory: 'Conflicting evidence',
};

const ROFR_NOTICE_LABELS = {
  not_sent: 'notice not sent',
  sent_no_proof: 'notice sent, no proof',
  delivered: 'notice delivered',
  not_applicable: 'not relevant',
};

function saleSummary(facts) {
  const kind = facts.transfer.kind === 'pledge' ? 'Pledge' : 'Sale';
  const stake = facts.transfer.fraction >= 1 ? 'whole stake' : `${Math.round(facts.transfer.fraction * 100)}% of the stake`;
  return `${facts.transfer.transferor} → ${facts.transfer.transferee} · ${kind} · ${stake}`;
}

function fundSummary(facts) {
  if (isAffiliate(facts) || facts.transfer.transferee_relationship === 'harbour_transferee') return 'GP consent not needed for this buyer.';
  const status = CONSENT_LABELS[(facts.fund.gp_consent || {}).status] || 'Not set';
  const owners = facts.fund.beneficial_owners_current;
  return `GP consent: ${status}${owners == null ? '' : ` · ${owners} beneficial owners`}`;
}

function harbourSummary(facts) {
  const complete = (facts.fund.gp_consent || {}).complete;
  return complete === 'yes' ? 'Request marked complete.' : complete === 'no' ? 'Request marked incomplete.' : 'Completeness unclear.';
}

function companySummary(facts) {
  if (isAffiliate(facts)) return 'Permitted-transfer notice to Helion, not a consent request.';
  const consent = CONSENT_LABELS[(facts.company.consent || {}).status] || 'Not set';
  const rofr = ROFR_NOTICE_LABELS[(facts.company.rofr_notice || {}).status] || 'not sent';
  return `Consent: ${consent} · ROFR ${rofr}`;
}

function buyerChecksSummary(facts) {
  const pledge = isPledge(facts);
  const checks = [facts.buyer.kyc === 'cleared', facts.buyer.sanctions === 'clear'];
  if (!pledge) checks.push(facts.buyer.accredited === 'confirmed', facts.buyer.tax_form === 'received', facts.buyer.adherence === 'signed');
  const outstanding = checks.filter((ok) => !ok).length;
  return outstanding === 0 ? 'All buyer checks complete.' : `${outstanding} check${outstanding === 1 ? '' : 's'} outstanding or unclear.`;
}

function asOfSummary(facts) {
  return `Checked as of ${Dates.formatReadable(facts.as_of)}.`;
}

function buildDealSections(facts) {
  const affiliate = isAffiliate(facts);
  const pledge = isPledge(facts);
  const harbourSeller = facts.transfer.transferor === 'Harbour Family Office LLC';
  const gpConsent = facts.fund.gp_consent || {};
  const companyConsent = facts.company.consent || {};
  const rofrNotice = facts.company.rofr_notice || {};
  const rofrResponse = facts.company.rofr_response || {};

  const affiliateReason = 'Not needed: the buyer is the seller’s affiliate.';
  const harbourReason = 'Not needed: the buyer is a Harbour Transferee under the side letter.';
  const pledgeReason = "Not needed: pledges don't need this until the security is enforced.";

  const sections = [];

  // --- The sale ---
  sections.push({
    id: 'deal-sale',
    title: 'The sale',
    summary: saleSummary(facts),
    fields: [
      {
        label: 'Seller',
        kind: 'party-select',
        choices: SELLERS.map((n) => ({ value: n, label: n })),
        currentValue: facts.transfer.transferor,
        buildOverride: (v) => ({ transfer: { transferor: v } }),
      },
      {
        label: 'Buyer',
        kind: 'party-select',
        choices: BUYERS.map((b) => ({ value: b.name, label: b.note ? `${b.name} (${b.note})` : b.name })),
        currentValue: facts.transfer.transferee,
        buildOverride: (v) => {
          const b = buyerByName(v);
          const override = { transfer: { transferee: v, transferee_relationship: b.relationship, transferee_is_competitor: b.competitor } };
          // A Permitted Transferee under LPA 8.2 / SA 3.2 needs its own
          // notice evidence, not the "not_applicable" default left over from
          // an unrelated buyer: start both notices at "not sent" so the
          // engine reports them as an outstanding action rather than a fact
          // it cannot make sense of.
          if (b.relationship === 'affiliate') {
            const gpNotice = facts.fund.gp_permitted_notice || {};
            const companyNotice = facts.company.permitted_notice || {};
            override.fund = { gp_permitted_notice: { ...gpNotice, status: 'not_sent' } };
            override.company = { permitted_notice: { ...companyNotice, status: 'not_sent' } };
          }
          return override;
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
      label: 'Has the fund manager (the GP) consented?',
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
  sections.push({ id: 'deal-fund', title: 'The fund', summary: fundSummary(facts), fields: fundFields });

  // --- Harbour side letter (only when seller is Harbour) ---
  if (harbourSeller) {
    sections.push({
      id: 'deal-harbour',
      title: 'Harbour side letter',
      summary: harbourSummary(facts),
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
  sections.push({ id: 'deal-company', title: "Helion's agreement", summary: companySummary(facts), fields: companyFields });

  // --- Buyer checks ---
  sections.push({
    id: 'deal-buyer',
    title: 'Buyer checks',
    summary: buyerChecksSummary(facts),
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
    summary: asOfSummary(facts),
    fields: [dateControl('Checked as of', 'as_of', facts)],
  });

  return sections;
}

function dateHint(kind, value) {
  if (!value) return null;
  if (kind === 'date') return Dates.formatReadable(value);
  if (kind === 'datetime-local') {
    const [datePart, timePart] = value.split('T');
    if (!datePart) return null;
    return timePart ? `${Dates.formatReadable(datePart)} · ${timePart}` : Dates.formatReadable(datePart);
  }
  return null;
}

function renderField(field) {
  const wrap = el('div', 'field' + (field.disabledReason ? ' field-disabled' : ''));
  const labelEl = el('label', 'field-label', field.label);
  wrap.appendChild(labelEl);
  if (field.note) wrap.appendChild(el('p', 'field-note', field.note));

  if (field.kind === 'party-select' || (field.kind === 'select' && field.choices.length > 5)) {
    // A select styled to match .segmented (same height, border and type):
    // used for Seller/Buyer, and for any single-choice field with more than
    // five options, where segmented buttons would wrap awkwardly.
    const select = document.createElement('select');
    select.className = 'choice-select';
    select.disabled = Boolean(field.disabledReason);
    select.setAttribute('aria-label', field.label);
    for (const choice of field.choices) {
      const opt = document.createElement('option');
      opt.value = choice.value;
      opt.textContent = choice.label;
      opt.selected = String(choice.value) === String(field.currentValue);
      select.appendChild(opt);
    }
    select.addEventListener('change', () => applyOverride(field.buildOverride(select.value)));
    wrap.appendChild(select);
  } else if (field.kind === 'select') {
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
    const row = el('div', 'field-input-row');
    const input = document.createElement('input');
    input.type = field.kind;
    input.id = id;
    input.disabled = Boolean(field.disabledReason);
    if (field.kind === 'number') input.step = 'any';
    if (field.currentValue !== undefined && field.currentValue !== null) input.value = field.currentValue;
    input.addEventListener('change', () => applyOverride(field.buildOverride(input.value)));
    row.appendChild(input);
    const hint = dateHint(field.kind, field.currentValue);
    if (hint) row.appendChild(el('span', 'field-date-hint', hint));
    wrap.appendChild(row);
  }

  if (field.disabledReason) {
    wrap.appendChild(el('p', 'field-reason', field.disabledReason));
  }
  return wrap;
}

// Which deal-form section holds the fact that is actually deciding the
// verdict, so that section can open on its own and carry a "Deciding" label
// (see decidingSectionId below). preliminary has no editable section of its
// own (X-CLASSIFY/X-VERSION are not user-editable facts), so it falls back
// to the sale section, where the transfer's classification lives.
const GATE_SECTION = {
  preliminary: 'deal-sale',
  side_letter: 'deal-harbour',
  fund: 'deal-fund',
  company: 'deal-company',
  buyer: 'deal-buyer',
};

function decidingSectionId(decidingId, ruleMap, sections) {
  if (!decidingId) return null;
  const rule = ruleMap.get(decidingId);
  const candidate = rule && GATE_SECTION[rule.gate];
  return candidate && sections.some((s) => s.id === candidate) ? candidate : null;
}

function renderDealForm(facts, decidingId, ruleMap) {
  const container = document.getElementById('deal-form');
  container.innerHTML = '';
  const sections = buildDealSections(facts);
  const decidingSecId = decidingSectionId(decidingId, ruleMap, sections);
  if (decidingSecId) state.dealCollapsed.delete(decidingSecId);

  for (const section of sections) {
    const sectionEl = el('section', 'deal-section');
    sectionEl.id = section.id;
    const isDeciding = section.id === decidingSecId;

    const collapsed = state.dealCollapsed.has(section.id);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'deal-section-toggle';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.appendChild(el('span', 'deal-section-title-text', section.title));
    if (isDeciding) toggle.appendChild(el('span', 'deal-section-deciding', 'Deciding'));
    if (collapsed && section.summary) toggle.appendChild(el('span', 'deal-section-summary', section.summary));
    toggle.addEventListener('click', () => {
      if (state.dealCollapsed.has(section.id)) state.dealCollapsed.delete(section.id);
      else state.dealCollapsed.add(section.id);
      render();
    });
    sectionEl.appendChild(toggle);
    if (!collapsed) for (const field of section.fields) sectionEl.appendChild(renderField(field));
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

  const key = `${decision.verdict}|${decision.headline}`;
  if (state.lastAnswerKey !== null && state.lastAnswerKey !== key) {
    for (const target of [panel, document.getElementById('mobile-answer-bar')]) {
      target.classList.remove('answer-flash');
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
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'open-doc';
      link.textContent = `Open the full document at p. ${clause.page}`;
      link.addEventListener('click', () => openDocViewer(top.doc, top.section));
      source.appendChild(link);
      container.appendChild(source);
    }
    if (rule.citations.length > 1) {
      const others = el('div', 'cites');
      for (const c of rule.citations.slice(1)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cite';
        btn.textContent = formatCitation(c);
        btn.addEventListener('click', () => openDocViewer(c.doc, c.section));
        others.appendChild(btn);
      }
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

// --- Scenario picker (search across all 31 test scenarios) --------------

let pickerTrigger = null;

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
      closePicker();
      navigate(`#/request/${s.id}`);
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function getFocusable(container) {
  return Array.from(container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
}

function openPicker(triggerEl) {
  pickerTrigger = triggerEl || document.activeElement;
  document.getElementById('scenario-picker').hidden = false;
  document.getElementById('scenario-search').value = '';
  renderScenarioList('');
  document.getElementById('scenario-search').focus();
}

function closePicker() {
  document.getElementById('scenario-picker').hidden = true;
  if (pickerTrigger) pickerTrigger.focus();
  pickerTrigger = null;
}

function handlePickerKeydown(e) {
  if (e.key === 'Escape') {
    closePicker();
    return;
  }
  if (e.key !== 'Tab') return;
  const dialog = document.getElementById('scenario-picker');
  const focusable = getFocusable(dialog);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// --- Nav drawer (mobile menu, mirrors the sidebar) -----------------------

let drawerTrigger = null;

function openDrawer(triggerEl) {
  drawerTrigger = triggerEl || document.activeElement;
  document.getElementById('nav-drawer').hidden = false;
  document.getElementById('nav-menu-btn').setAttribute('aria-expanded', 'true');
  getFocusable(document.getElementById('nav-drawer'))[0]?.focus();
}

function closeDrawer() {
  document.getElementById('nav-drawer').hidden = true;
  document.getElementById('nav-menu-btn').setAttribute('aria-expanded', 'false');
  if (drawerTrigger) drawerTrigger.focus();
  drawerTrigger = null;
}

function handleDrawerKeydown(e) {
  if (e.key === 'Escape') {
    closeDrawer();
    return;
  }
  if (e.key !== 'Tab') return;
  const dialog = document.getElementById('nav-drawer');
  const focusable = getFocusable(dialog);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function runNavAction(action, triggerEl) {
  if (action === 'requests') navigate('#/');
  else if (action === 'new') navigate('#/request/NEW');
  else if (action === 'scenarios') openPicker(triggerEl);
  else if (action === 'documents') openDocViewer('LPA', null);
  else if (action === 'safe') {
    navigate('#/');
    setTimeout(() => document.getElementById('safe-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }
}

// --- Document viewer (reads docs/source Markdown, tab per document) ------

function mdInline(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function mdToFragment(md) {
  const frag = document.createDocumentFragment();
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const text = para.join(' ').trim();
    para = [];
    if (!text) return;
    const p = document.createElement('p');
    const m = text.match(/^\*\*(\d+(?:\.\d+)?)\s+[^*]*\*\*/);
    if (m) {
      p.id = `clause-${m[1]}`;
      p.dataset.section = m[1];
    }
    p.innerHTML = mdInline(text);
    frag.appendChild(p);
  };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
    } else if (line === '---') {
      flush();
      frag.appendChild(document.createElement('hr'));
    } else if (/^#{1,3}\s/.test(line)) {
      flush();
      const level = line.match(/^#+/)[0].length;
      const h = document.createElement(level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4');
      h.innerHTML = mdInline(line.replace(/^#+\s*/, ''));
      frag.appendChild(h);
    } else if (line.startsWith('>')) {
      flush();
      const bq = el('blockquote', 'doc-notice');
      bq.innerHTML = mdInline(line.replace(/^>\s*/, ''));
      frag.appendChild(bq);
    } else {
      para.push(line);
    }
  }
  flush();
  return frag;
}

function sectionAnchorId(section) {
  const m = String(section).match(/^\d+(?:\.\d+)?/);
  return m ? `clause-${m[0]}` : null;
}

async function loadDocSource(key) {
  if (!DATA.docSource) DATA.docSource = {};
  if (DATA.docSource[key]) return DATA.docSource[key];
  const file = DATA.clauses[key].file.replace(/\.pdf$/, '.md');
  const text = await fetch(`docs/source/${file}`).then((r) => r.text());
  DATA.docSource[key] = text;
  return text;
}

function renderDocTabs() {
  const container = document.getElementById('doc-tabs');
  container.innerHTML = '';
  for (const doc of DOC_LIST) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'doc-tab';
    btn.setAttribute('role', 'tab');
    btn.textContent = doc.label;
    btn.addEventListener('click', () => openDocViewer(doc.key, null));
    container.appendChild(btn);
  }
}

function updateDocTabsSelection(key) {
  const tabs = document.querySelectorAll('#doc-tabs .doc-tab');
  DOC_LIST.forEach((doc, i) => tabs[i].setAttribute('aria-selected', String(doc.key === key)));
}

let docViewerTrigger = null;

async function openDocViewer(key, section) {
  docViewerTrigger = document.activeElement;
  const panel = document.getElementById('doc-viewer');
  const backdrop = document.getElementById('doc-viewer-backdrop');
  panel.hidden = false;
  backdrop.hidden = false;
  state.docViewer = { open: true, doc: key };
  updateDocTabsSelection(key);

  const clauseDoc = DATA.clauses[key];
  const meta = document.getElementById('doc-viewer-meta');
  meta.innerHTML = '';
  meta.appendChild(el('span', null, clauseDoc.title.split(' - ')[0]));
  const pdfLink = el('a', null, 'Download PDF');
  pdfLink.href = `docs/source/${clauseDoc.file}`;
  pdfLink.target = '_blank';
  pdfLink.rel = 'noopener';
  meta.appendChild(pdfLink);

  const body = document.getElementById('doc-viewer-body');
  body.innerHTML = 'Loading…';
  const text = await loadDocSource(key);
  if (state.docViewer.doc !== key) return; // a later tab click won.
  body.innerHTML = '';
  body.appendChild(mdToFragment(text));

  body.querySelectorAll('.clause-highlight').forEach((n) => n.classList.remove('clause-highlight', 'clause-flash'));
  const anchorId = section ? sectionAnchorId(section) : null;
  const target = anchorId && document.getElementById(anchorId);
  if (target) {
    target.classList.add('clause-highlight', 'clause-flash');
    target.scrollIntoView({ block: 'center' });
  } else {
    body.scrollTop = 0;
  }
  body.focus();
}

function closeDocViewer() {
  document.getElementById('doc-viewer').hidden = true;
  document.getElementById('doc-viewer-backdrop').hidden = true;
  state.docViewer = { open: false, doc: null };
  if (docViewerTrigger) docViewerTrigger.focus();
  docViewerTrigger = null;
}

function handleDocViewerKeydown(e) {
  if (e.key === 'Escape') {
    closeDocViewer();
    return;
  }
  if (e.key !== 'Tab') return;
  const dialog = document.getElementById('doc-viewer');
  const focusable = getFocusable(dialog);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// --- Rendering root -------------------------------------------------------

function requestLabel(id, facts) {
  const meta = QUEUE_META[id];
  const parties = `${facts.transfer.transferor} → ${facts.transfer.transferee}`;
  return meta ? `${meta.ref} ${parties}` : `New request · ${parties}`;
}

function renderBreadcrumb(id, facts) {
  const el2 = document.getElementById('breadcrumb');
  el2.innerHTML = '';
  const link = el('a', null, 'Requests');
  link.href = '#/';
  el2.appendChild(link);
  el2.appendChild(el('span', 'sep', '/'));
  el2.appendChild(el('span', 'current', requestLabel(id, facts)));
}

function renderTopbarContext() {
  const el2 = document.getElementById('topbar-context');
  if (el2 && DATA.baseFacts) el2.textContent = `Northgate Helion SPV · Checked as of ${Dates.formatReadable(DATA.baseFacts.as_of)}`;
}

function renderSidebarCounts() {
  const count = String(QUEUE_ROWS.length);
  const sidebarCount = document.getElementById('sidebar-count');
  const drawerCount = document.getElementById('drawer-count');
  if (sidebarCount) sidebarCount.textContent = count;
  if (drawerCount) drawerCount.textContent = count;
}

function renderRequestView() {
  const id = state.route.id;
  let facts;
  let decision;
  try {
    facts = factsForId(id);
    decision = Engine.evaluate(facts, DATA.rulebook, DATA.calendar);
  } catch {
    return;
  }
  const ruleMap = new Map(DATA.rulebook.rules.map((r) => [r.id, r]));
  const decidingId = decidingRuleId(decision);

  renderBreadcrumb(id, facts);
  renderDealForm(facts, decidingId, ruleMap);
  renderAnswer(decision, ruleMap);
  renderWhy(decision, decidingId, ruleMap);
  renderNext(decision, ruleMap);
  renderAllRules(decision, ruleMap);
  renderAudit(decision);
}

function render() {
  state.route = parseHash();
  const isRequest = state.route.view === 'request';

  document.getElementById('view-queue').hidden = isRequest;
  document.getElementById('view-request').hidden = !isRequest;
  document.getElementById('mobile-answer-bar').hidden = !isRequest;
  document.body.classList.toggle('view-request', isRequest);

  renderTopbarContext();
  renderSidebarCounts();

  if (isRequest) {
    renderRequestView();
  } else {
    renderQueue();
  }
}

// --- Theme --------------------------------------------------------------

function prefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function isDarkNow() {
  const current = document.documentElement.getAttribute('data-theme');
  return current ? current === 'dark' : prefersDark();
}

function updateThemeButtons() {
  const label = isDarkNow() ? 'Light' : 'Dark';
  document.getElementById('theme-toggle').textContent = label;
  document.getElementById('theme-toggle-drawer').textContent = label;
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch (e) {
    /* private mode / blocked storage: fall back to prefers-color-scheme */
  }
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  updateThemeButtons();
}

function toggleTheme() {
  const next = isDarkNow() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('theme', next);
  } catch (e) {
    /* ignore */
  }
  updateThemeButtons();
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
  document.getElementById('theme-toggle-drawer').addEventListener('click', toggleTheme);

  for (const btn of document.querySelectorAll('[data-nav]')) {
    btn.addEventListener('click', () => {
      const wasInDrawer = !document.getElementById('nav-drawer').hidden;
      if (wasInDrawer) closeDrawer();
      runNavAction(btn.dataset.nav, wasInDrawer ? document.getElementById('nav-menu-btn') : btn);
    });
  }
  document.getElementById('nav-menu-btn').addEventListener('click', (e) => openDrawer(e.currentTarget));
  document.getElementById('nav-drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('nav-drawer').addEventListener('keydown', handleDrawerKeydown);

  renderDocTabs();
  document.getElementById('doc-viewer-close').addEventListener('click', closeDocViewer);
  document.getElementById('doc-viewer-backdrop').addEventListener('click', closeDocViewer);
  document.getElementById('doc-viewer').addEventListener('keydown', handleDocViewerKeydown);

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

  document.getElementById('new-request-btn').addEventListener('click', () => {
    navigate('#/request/NEW');
  });
  document.getElementById('open-scenarios-btn').addEventListener('click', (e) => openPicker(e.currentTarget));
  document.getElementById('picker-close').addEventListener('click', closePicker);
  document.getElementById('scenario-search').addEventListener('input', (e) => renderScenarioList(e.target.value));
  document.getElementById('scenario-picker').addEventListener('keydown', handlePickerKeydown);

  window.addEventListener('hashchange', render);
}

async function init() {
  initTheme();
  wireEvents();
  await loadData();
  render();
}

init();
