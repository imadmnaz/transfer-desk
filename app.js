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
  {
    id: 'T06',
    ref: 'TR-0120',
    received: '2026-08-03',
    displayOverrides: { transfer: { transferor: 'Rosalind Kerr', transferee: 'Wynwood Ventures LP' } },
  },
  {
    id: 'T20',
    ref: 'TR-0133',
    received: '2026-09-10',
    displayOverrides: { transfer: { transferor: 'Marguerite Shaw', transferee: 'Nikolai Petrov' } },
  },
  {
    id: 'T17',
    ref: 'TR-0141',
    received: '2026-09-18',
    displayOverrides: { transfer: { transferor: 'Felix Amara', transferee: 'Priyanka Rao' } },
  },
  {
    id: 'T31',
    ref: 'TR-0148',
    received: '2026-09-10',
    displayOverrides: { transfer: { transferee: 'Desmond Ola' } },
  },
];

const QUEUE_IDS = QUEUE_ROWS.map((r) => r.id);
const QUEUE_DISPLAY_OVERRIDES = Object.fromEntries(QUEUE_ROWS.filter((r) => r.displayOverrides).map((r) => [r.id, r.displayOverrides]));
const QUEUE_META = Object.fromEntries(QUEUE_ROWS.map((r) => [r.id, { ref: r.ref, received: r.received }]));

const state = {
  route: { view: 'queue' },
  requestOverrides: {},
  dealCollapsed: new Set(['deal-fund', 'deal-harbour', 'deal-company', 'deal-buyer', 'deal-asof']),
  lastAnswerKey: null,
  lastAnswerId: null,
  docViewer: { open: false, doc: null },
  queueTab: 'all',
  queueQuery: '',
  // Session activity per request id: each entry is one fact change the
  // operator made, with the answer before and after. UI memory only; the
  // engine never reads it.
  activity: {},
  undo: null,
  // The current "Try to break it" random case on the Assurance page, kept
  // so leaving and returning to the page does not lose it.
  assuranceBreak: null,
  lastPhoneUrl: null,
  // Chases logged against a request (waiting on the GP, Helion or the
  // buyer). Session memory only, exactly like state.activity: a chase does
  // not change any fact the engine reads, it only records that someone
  // asked again.
  chases: {},
  // Counsel decisions logged against a request. Where the decision maps to
  // a fact the engine already models, it is applied through applyOverride
  // like any other evidence; otherwise it is recorded here only, and never
  // changes the verdict.
  counselDecisions: {},
  // Register entries, keyed by request id, recorded only once a request
  // reaches "ready for the GP to record" and the operator actions it. Kept
  // for the session only, per the brief: this is not a new source of legal
  // truth, just a preview and export of what the GP would record.
  register: {},
  // Signatures logged per request and signatory. Session memory; where a
  // signatory's signing is also an engine fact (the buyer's Transfer and
  // Adherence Agreement), logging it "signed" here also applies that fact
  // through applyOverride, exactly like any other evidence.
  signatures: {},
};

// The three signatories on the Transfer and Adherence Agreement. Only the
// buyer's signature has a matching engine fact (buyer.adherence); the
// seller's and the GP's signing are tracked here for the workflow but do
// not feed any rule, since no rule in the rulebook keys off them.
const SIGNATORIES = [
  { key: 'seller', label: 'Seller' },
  { key: 'buyer', label: 'Buyer', factPath: 'buyer.adherence', factDoneValue: 'signed' },
  { key: 'gp', label: 'General Partner' },
];

// The four display statuses. They are read from the engine's verdict and
// outstanding count, never decided here. Red is reserved for Blocked; there
// is no green, because ready to record is not an approval.
const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'lawyer', label: 'Lawyer' },
  { key: 'actions', label: 'Action needed' },
  { key: 'ready', label: 'Ready' },
  { key: 'service', label: 'Past service level' },
];

// Recording in the Register (LPA 8.5) is session state that never feeds
// back into the engine, so the engine's own verdict for a recorded request
// stays CHECKLIST_READY forever, correctly: the tool never claims the act
// of recording as its own answer. What the operator sees, though, must
// still say Recorded once it happens, everywhere a status is shown (the
// banner, the queue row, the dashboard KPIs), which this optional id
// parameter makes possible without touching the engine's own output.
function statusOf(decision, id) {
  if (id && state.register[id]) {
    return { key: 'recorded', group: 4, short: 'Recorded', long: 'Recorded in the Register', badge: 'badge-ready' };
  }
  if (decision.verdict === 'BLOCKED') {
    return { key: 'blocked', group: 0, short: 'Blocked', long: 'Blocked', badge: 'badge-blocked' };
  }
  if (decision.verdict === 'ESCALATE') {
    return { key: 'lawyer', group: 1, short: 'Lawyer review', long: 'Lawyer review', badge: 'badge-lawyer' };
  }
  const n = decision.results.filter((r) => r.state === 'OUTSTANDING').length;
  if (n > 0) {
    return {
      key: 'actions',
      group: 2,
      short: `${n} action${n === 1 ? '' : 's'}`,
      long: `${n} action${n === 1 ? '' : 's'} outstanding`,
      badge: 'badge-action',
    };
  }
  return { key: 'ready', group: 3, short: 'Ready to record', long: 'Ready for the GP to record', badge: 'badge-ready' };
}

// --- Lifecycle stage ------------------------------------------------------
//
// A request's stage is derived, never stored: it reads the same decision
// the rest of the page reads, plus the signatures and register state logged
// in this session. There is no separate "stage" fact anywhere, so a stage
// can never drift from the answer that produced it.
const STAGE_CONSENT_NOTICE_RULES = ['F-CONSENT', 'S-DEEMED-CONSENT', 'C-CONSENT', 'F-PERMITTED-NOTICE', 'C-PERMITTED-NOTICE', 'C-ROFR-NOTICE', 'C-ROFR-RESPONSE'];
const STAGE_KYC_RULES = ['B-KYC', 'B-SANCTIONS', 'B-TAX-FORM', 'B-ADHERENCE'];

function signaturesFor(id, facts) {
  const logged = state.signatures[id] || {};
  return SIGNATORIES.map((s) => ({
    ...s,
    state: logged[s.key] || (s.factPath && getPath(facts, s.factPath) === s.factDoneValue ? 'signed' : 'not_sent'),
  }));
}

function stageFor(id, decision, facts) {
  if (state.register[id]) return { key: 'register', label: 'Register updated' };
  const status = statusOf(decision);
  if (status.key === 'blocked' || status.key === 'lawyer') return { key: 'compliance', label: 'Compliance review' };
  if (status.key === 'ready') {
    const sigs = signaturesFor(id, facts);
    if (sigs.every((s) => s.state === 'signed')) return { key: 'completion', label: 'Completion' };
    return { key: 'signatures', label: 'Signatures' };
  }
  const outstanding = decision.results.filter((r) => r.state === 'OUTSTANDING').map((r) => r.rule_id);
  if (outstanding.some((rid) => STAGE_CONSENT_NOTICE_RULES.includes(rid))) return { key: 'consents', label: 'Consents and notices' };
  if (outstanding.length && outstanding.every((rid) => STAGE_KYC_RULES.includes(rid))) return { key: 'kyc', label: 'KYC and documents' };
  return { key: 'intake', label: 'Intake' };
}

// Days the request has been open (received to as_of). Shown as the stage's
// age rather than a true per-stage clock, since the demo does not log stage
// transition timestamps; the queue and request page both say "open" for
// this reason, not "in this stage".
function daysOpen(receivedISO, asOfISO) {
  const from = Date.UTC(...receivedISO.split('-').map(Number));
  const to = Date.UTC(...asOfISO.split('-').map(Number));
  return Math.round((to - from) / 86400000);
}

// A request is past its service level once it has an overdue next action:
// the same dueDate the queue and Deadlines page already show, now flagged
// once as_of has passed it.
function pastServiceLevel(row, asOfISO) {
  return Boolean(row.dueDate && row.dueDate < asOfISO);
}

function badge(status, extraClass) {
  return el('span', `badge ${status.badge}${extraClass ? ` ${extraClass}` : ''}`, status.short);
}

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

const REQUEST_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'documents', label: 'Documents' },
  { key: 'signatures', label: 'Signatures' },
  { key: 'activity', label: 'Activity' },
];

function parseHash() {
  const m = location.hash.match(/^#\/request\/([^/]+)(?:\/([a-z]+))?$/);
  if (m) {
    const tab = REQUEST_TABS.some((t) => t.key === m[2]) ? m[2] : 'overview';
    return { view: 'request', id: decodeURIComponent(m[1]), tab };
  }
  if (location.hash === '#/new') return { view: 'new', id: 'NEW' };
  if (location.hash === '#/deadlines') return { view: 'deadlines' };
  if (location.hash === '#/assurance') return { view: 'assurance' };
  if (location.hash === '#/playbook') return { view: 'playbook' };
  if (location.hash === '#/chase') return { view: 'chase' };
  if (location.hash === '#/counsel') return { view: 'counsel' };
  return { view: 'queue' };
}

// Fresh intake defaults for the "New request" wizard: nothing has been
// evidenced yet, unlike the clean baseline used by the 31 scenarios. The
// parties and terms start at the baseline (Aldwych Angels Ltd -> Mira Chen)
// and step 1 of the wizard is where an operator changes them.
const NEW_INTAKE_OVERRIDES = {
  fund: { gp_consent: { status: 'not_requested' } },
  company: { consent: { status: 'not_requested' }, rofr_notice: { status: 'not_sent' } },
  buyer: { kyc: 'not_started', sanctions: 'pending', accredited: 'unknown', tax_form: 'outstanding', adherence: 'outstanding' },
};

function startNewRequestWizard() {
  state.wizard = { step: 1 };
  state.requestOverrides.NEW = JSON.parse(JSON.stringify(NEW_INTAKE_OVERRIDES));
  state.activity.NEW = [];
  navigate('#/new');
}

// The next reference in sequence, one past the highest TR-01xx already on
// the queue (including requests created earlier this session), so a new
// request reads like it was actually opened by the desk, not a demo id.
function nextQueueRef() {
  const max = QUEUE_ROWS.reduce((m, r) => Math.max(m, Number((r.ref || '').replace(/\D/g, '')) || 0), 0);
  return `TR-${max + 1}`;
}

// Turns the wizard's in-progress facts into a real queue row: a new id, a
// reference and a received date, appended to the same QUEUE_ROWS array
// every other view reads, so the dashboard, the stage tracker and the
// chase and counsel queues all see it immediately, exactly like any other
// request. Session only, like every other piece of state here.
function createRequestFromWizard() {
  const facts = factsForId('NEW');
  const id = `NEW-${QUEUE_ROWS.length + 1}`;
  const ref = nextQueueRef();
  QUEUE_ROWS.push({ id, ref, received: facts.as_of });
  QUEUE_IDS.push(id);
  QUEUE_META[id] = { ref, received: facts.as_of };
  state.requestOverrides[id] = state.requestOverrides.NEW;
  state.activity[id] = state.activity.NEW || [];
  delete state.requestOverrides.NEW;
  delete state.activity.NEW;
  state.wizard = null;
  return id;
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

function wireDisclosure(toggleId, bodyId) {
  const btn = document.getElementById(toggleId);
  const body = document.getElementById(bodyId);
  btn.addEventListener('click', () => {
    const willShow = body.hidden;
    body.hidden = !willShow;
    btn.setAttribute('aria-expanded', String(willShow));
  });
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

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// A short count-up from 0 to target, used only for the sweep's final
// numbers: it is a flourish on a number the operator already watched
// climb during the run, never a substitute for the real figure.
function animateCount(node, target, duration = 700) {
  if (prefersReducedMotion() || target === 0) {
    node.textContent = target.toLocaleString('en-US');
    return;
  }
  const start = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = Math.round(target * eased).toLocaleString('en-US');
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
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
  const status = statusOf(decision, id);

  const whatMatters = queueWording(firstSentence(humanize(decision.headline)));
  const dueDate = (nextActionOf(decision) || {}).due || null;
  const meta = QUEUE_META[id];
  const stage = stageFor(id, decision, facts);

  return {
    id,
    ref: meta.ref,
    received: meta.received,
    sellerBuyer: `${facts.transfer.transferor} → ${facts.transfer.transferee}${transferSuffix(facts)}`,
    status,
    group: status.group,
    dueDate,
    whatMatters,
    completion: facts.transfer.proposed_completion,
    completionAway: daysAwayText(facts.as_of, facts.transfer.proposed_completion),
    stage,
    daysOpen: daysOpen(meta.received, facts.as_of),
    pastServiceLevel: pastServiceLevel({ dueDate }, facts.as_of),
  };
}

function rowMatchesQuery(row, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${row.sellerBuyer} ${row.ref} ${row.whatMatters}`.toLowerCase().includes(q);
}

function renderQueueTabs(counts) {
  const container = document.getElementById('queue-tabs');
  container.innerHTML = '';
  for (const tab of STATUS_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.dataset.tab = tab.key;
    btn.setAttribute('role', 'tab');
    const selected = state.queueTab === tab.key;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
    btn.appendChild(el('span', null, tab.label));
    btn.appendChild(el('span', 'tab-count', String(counts[tab.key])));
    btn.addEventListener('click', () => {
      state.queueTab = tab.key;
      renderQueue();
      document.querySelector(`#queue-tabs [data-tab="${tab.key}"]`)?.focus();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = STATUS_TABS.findIndex((t) => t.key === state.queueTab);
      const next = STATUS_TABS[(i + (e.key === 'ArrowRight' ? 1 : STATUS_TABS.length - 1)) % STATUS_TABS.length];
      state.queueTab = next.key;
      renderQueue();
      document.querySelector(`#queue-tabs [data-tab="${next.key}"]`)?.focus();
    });
    container.appendChild(btn);
  }
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
  wrap.appendChild(el('div', null, shortReadable(row.completion)));
  wrap.appendChild(el('div', 'queue-meta', row.completionAway));
  if (row.dueDate) wrap.appendChild(el('div', 'queue-due-date', `Next due ${shortReadable(row.dueDate)}`));
  return wrap;
}

// Rows due within the next 7 days (including overdue-today), soonest
// first: the same due dates the queue's "Next due" column and the
// Deadlines view already read, just surfaced above the table so the
// most time-sensitive requests never wait for a filter or a scroll.
function renderDueWeekStrip(allRows) {
  const strip = document.getElementById('due-week-strip');
  const list = document.getElementById('due-week-list');
  const asOf = DATA.baseFacts.as_of;
  const dueSoon = allRows
    .filter((r) => r.dueDate && r.dueDate >= asOf)
    .filter((r) => {
      const from = Date.UTC(...asOf.split('-').map(Number));
      const to = Date.UTC(...r.dueDate.split('-').map(Number));
      return Math.round((to - from) / 86400000) <= 7;
    })
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  strip.hidden = dueSoon.length === 0;
  list.innerHTML = '';
  for (const row of dueSoon) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'due-week-item';
    btn.appendChild(el('span', 'due-week-item-date', `${shortReadable(row.dueDate)} · ${daysAwayText(asOf, row.dueDate)}`));
    btn.appendChild(el('span', 'due-week-item-name', row.sellerBuyer));
    btn.addEventListener('click', () => navigate(`#/request/${row.id}`));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

// Six headline figures for the desk, the same shape a fund operations lead
// would expect at the top of a transfer queue. Every number is derived from
// the same rows and due dates the table below reads; nothing here is a new
// fact or a separate source of truth.
function renderKpiRow(allRows) {
  const asOf = DATA.baseFacts.as_of;
  const toDays = (fromISO, toISO) => Math.round((Date.UTC(...toISO.split('-').map(Number)) - Date.UTC(...fromISO.split('-').map(Number))) / 86400000);

  // A recorded request (LPA 8.5) is finished: it stays visible in the queue
  // for the record, but it is no longer open work, so it drops out of every
  // one of these figures the way a closed matter would drop out of a live
  // caseload count.
  const openRows = allRows.filter((r) => r.status.key !== 'recorded');
  const open = openRows.length;
  const blocked = openRows.filter((r) => r.status.key === 'blocked').length;
  const withCounsel = openRows.filter((r) => r.status.key === 'lawyer').length;
  const completingThisWeek = openRows.filter((r) => toDays(asOf, r.completion) >= 0 && toDays(asOf, r.completion) <= 7).length;
  const avgDaysOpen = open ? Math.round(openRows.reduce((sum, r) => sum + toDays(r.received, asOf), 0) / open) : 0;
  const pastServiceLevel = openRows.filter((r) => r.dueDate && toDays(r.dueDate, asOf) > 0).length;

  const kpis = [
    { label: 'Open transfers', value: String(open) },
    { label: 'Blocked', value: String(blocked) },
    { label: 'With counsel', value: String(withCounsel) },
    { label: 'Completing in 7 days', value: String(completingThisWeek) },
    { label: 'Average days open', value: String(avgDaysOpen) },
    { label: 'Past service level', value: String(pastServiceLevel) },
  ];

  const KPI_QUEUE_TAB = { Blocked: 'blocked', 'With counsel': 'lawyer', 'Past service level': 'service' };
  const KPI_CAPTION = {};

  const row = document.getElementById('kpi-row');
  row.innerHTML = '';
  for (const kpi of kpis) {
    const item = el('div', 'kpi-item');
    item.appendChild(el('dt', 'kpi-label', kpi.label));
    const valueClass = `kpi-value${kpi.label === 'Blocked' && blocked > 0 ? ' kpi-value-blocked' : ''}${kpi.label === 'Past service level' && pastServiceLevel > 0 ? ' kpi-value-flag' : ''}`;
    const targetTab = KPI_QUEUE_TAB[kpi.label];
    const dd = el('dd', valueClass);
    if (targetTab && Number(kpi.value) > 0) {
      const btn = el('button', 'kpi-value-link', kpi.value);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        state.queueTab = targetTab;
        renderQueue();
        document.querySelector(`#queue-tabs [data-tab="${targetTab}"]`)?.focus();
      });
      dd.appendChild(btn);
    } else {
      dd.textContent = kpi.value;
    }
    item.appendChild(dd);
    if (KPI_CAPTION[kpi.label]) item.appendChild(el('p', 'kpi-caption', KPI_CAPTION[kpi.label]));
    row.appendChild(item);
  }
}

function renderQueue() {
  const allRows = QUEUE_ROWS.map((r) => r.id).map(queueRowFor).sort(compareRows);
  renderKpiRow(allRows);
  renderDueWeekStrip(allRows);
  const searched = allRows.filter((r) => rowMatchesQuery(r, state.queueQuery));

  const counts = { all: searched.length, blocked: 0, lawyer: 0, actions: 0, ready: 0, service: 0 };
  for (const r of searched) {
    counts[r.status.key]++;
    if (r.pastServiceLevel) counts.service++;
  }
  const totals = { blocked: 0, lawyer: 0, actions: 0, ready: 0, recorded: 0 };
  for (const r of allRows) totals[r.status.key]++;
  const openCount = allRows.length - totals.recorded;

  document.getElementById('queue-summary').textContent =
    `${openCount} open requests · ${totals.blocked} blocked · ${totals.lawyer} with a lawyer · ${totals.actions} with actions outstanding · ${totals.ready} ready to record${totals.recorded ? ` · ${totals.recorded} recorded` : ''}`;

  renderQueueTabs(counts);

  const rows =
    state.queueTab === 'all'
      ? searched
      : state.queueTab === 'service'
        ? searched.filter((r) => r.pastServiceLevel)
        : searched.filter((r) => r.status.key === state.queueTab);
  document.getElementById('queue-empty').hidden = rows.length > 0;
  document.getElementById('queue-table').hidden = rows.length === 0;

  const tbody = document.getElementById('queue-table-body');
  tbody.innerHTML = '';
  const mobileList = document.getElementById('queue-list-mobile');
  mobileList.innerHTML = '';

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.className = 'queue-row';
    tr.dataset.id = row.id;

    const requestCell = el('td');
    requestCell.appendChild(el('div', 'queue-parties', row.sellerBuyer));
    const metaLine = el('div', 'queue-meta');
    metaLine.appendChild(el('span', 'queue-ref', row.ref));
    metaLine.appendChild(document.createTextNode(` · received ${shortReadable(row.received)}`));
    requestCell.appendChild(metaLine);
    const stageLine = el('div', 'queue-stage');
    stageLine.appendChild(el('span', null, row.stage.label));
    stageLine.appendChild(document.createTextNode(` · ${row.daysOpen} day${row.daysOpen === 1 ? '' : 's'} open`));
    if (row.pastServiceLevel) stageLine.appendChild(el('span', 'queue-stage-flag', 'Past service level'));
    requestCell.appendChild(stageLine);
    tr.appendChild(requestCell);

    const statusCell = el('td', 'queue-status');
    statusCell.appendChild(badge(row.status));
    tr.appendChild(statusCell);
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
    btn.dataset.id = row.id;
    btn.appendChild(el('span', 'queue-row-mobile-top', row.sellerBuyer));
    btn.appendChild(badge(row.status, 'queue-row-mobile-status'));
    btn.appendChild(el('span', 'queue-row-mobile-matters', row.whatMatters));
    const meta = el('span', 'queue-row-mobile-meta');
    meta.appendChild(el('span', 'queue-ref', row.ref));
    meta.appendChild(el('span', null, `${row.stage.label} · ${row.daysOpen}d open`));
    meta.appendChild(el('span', null, `Completes ${shortReadable(row.completion)}, ${row.completionAway}`));
    if (row.dueDate) meta.appendChild(el('span', 'due', `Next due ${shortReadable(row.dueDate)}`));
    btn.appendChild(meta);
    btn.addEventListener('click', open);
    li.appendChild(btn);
    mobileList.appendChild(li);
  }
}

// --- Deadlines ----------------------------------------------------------
//
// The same rows as the queue, filtered to the ones with a next due date and
// sorted soonest first. Nothing here is a new fact or a new rule: due dates
// come straight from each request's checklist, exactly as the queue reads
// them for its "Next due" column.

function renderDeadlines() {
  const rows = QUEUE_ROWS.map((r) => r.id)
    .map(queueRowFor)
    .filter((r) => r.dueDate)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  document.getElementById('deadlines-summary').textContent =
    rows.length === 0 ? 'No request has a step waiting on a date right now.' : `${rows.length} request${rows.length === 1 ? '' : 's'} with a next due date, soonest first.`;

  document.getElementById('deadlines-table').hidden = rows.length === 0;
  document.getElementById('deadlines-empty').hidden = rows.length > 0;

  const tbody = document.getElementById('deadlines-table-body');
  tbody.innerHTML = '';
  const mobileList = document.getElementById('deadlines-list-mobile');
  mobileList.innerHTML = '';

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.className = 'queue-row';
    tr.dataset.id = row.id;

    const requestCell = el('td');
    requestCell.appendChild(el('div', 'queue-parties', row.sellerBuyer));
    const metaLine = el('div', 'queue-meta');
    metaLine.appendChild(el('span', 'queue-ref', row.ref));
    requestCell.appendChild(metaLine);
    tr.appendChild(requestCell);

    const statusCell = el('td', 'queue-status');
    statusCell.appendChild(badge(row.status));
    tr.appendChild(statusCell);

    const dueCell = el('td', 'queue-completion');
    dueCell.appendChild(el('div', null, shortReadable(row.dueDate)));
    dueCell.appendChild(el('div', 'queue-meta', daysAwayText(DATA.baseFacts.as_of, row.dueDate)));
    tr.appendChild(dueCell);

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
    btn.dataset.id = row.id;
    btn.appendChild(el('span', 'queue-row-mobile-top', row.sellerBuyer));
    btn.appendChild(badge(row.status, 'queue-row-mobile-status'));
    const meta = el('span', 'queue-row-mobile-meta');
    meta.appendChild(el('span', 'due', `Due ${shortReadable(row.dueDate)}`));
    btn.appendChild(meta);
    btn.addEventListener('click', open);
    li.appendChild(btn);
    mobileList.appendChild(li);
  }
}

// --- Chase list -----------------------------------------------------------

function renderChaseView() {
  const items = computeChaseItems();
  document.getElementById('chase-summary').textContent =
    items.length === 0 ? 'Nothing is waiting on the GP, Helion or the buyer right now.' : `${items.length} item${items.length === 1 ? '' : 's'} waiting on someone else, longest first.`;
  document.getElementById('chase-table').hidden = items.length === 0;
  document.getElementById('chase-empty').hidden = items.length > 0;

  // Context for why the list is short: most of the queue has not asked
  // yet, so there is nothing to chase there, only a next action of Ops's
  // own (shown on the request itself and the queue, not here).
  const ownAction = computeOwnActionRequests();
  const note = document.getElementById('chase-not-asked');
  if (ownAction.length === 0) {
    note.hidden = true;
  } else {
    note.hidden = false;
    note.innerHTML = '';
    note.appendChild(document.createTextNode(
      `${ownAction.length} other request${ownAction.length === 1 ? '' : 's'} in the queue ${ownAction.length === 1 ? 'has' : 'have'} an outstanding step that Ops has not asked for yet, so there is nothing to chase there until it does: `,
    ));
    ownAction.forEach((r, i) => {
      const link = document.createElement('a');
      link.href = `#/request/${r.id}`;
      link.textContent = r.ref;
      note.appendChild(link);
      if (i < ownAction.length - 1) note.appendChild(document.createTextNode(', '));
    });
    note.appendChild(document.createTextNode('.'));
  }

  const tbody = document.getElementById('chase-table-body');
  tbody.innerHTML = '';
  const mobileList = document.getElementById('chase-list-mobile');
  mobileList.innerHTML = '';

  for (const item of items) {
    const tr = document.createElement('tr');
    tr.className = 'queue-row';

    const requestCell = el('td');
    requestCell.appendChild(el('div', 'queue-parties', item.sellerBuyer));
    const metaLine = el('div', 'queue-meta');
    metaLine.appendChild(el('span', 'queue-ref', item.ref));
    requestCell.appendChild(metaLine);
    tr.appendChild(requestCell);

    tr.appendChild(el('td', null, `Waiting on ${item.party} for ${item.thing}`));
    tr.appendChild(el('td', null, `${item.days} day${item.days === 1 ? '' : 's'}${item.chasedCount ? ` · chased ${item.chasedCount}×` : ''}`));

    const actionCell = document.createElement('td');
    const openBtn = el('button', 'btn btn-ghost btn-sm', 'Open');
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => navigate(`#/request/${item.id}`));
    const chaseBtn = el('button', 'btn btn-secondary btn-sm', 'Log chase');
    chaseBtn.type = 'button';
    chaseBtn.addEventListener('click', () => {
      logChase(item.id, item.ruleId, item.party, item.thing);
      renderChaseView();
    });
    actionCell.appendChild(openBtn);
    actionCell.appendChild(chaseBtn);
    tr.appendChild(actionCell);
    tbody.appendChild(tr);

    const li = document.createElement('li');
    const wrap = el('div', 'queue-row-mobile');
    wrap.appendChild(el('span', 'queue-row-mobile-top', item.sellerBuyer));
    wrap.appendChild(el('span', 'queue-row-mobile-matters', `Waiting on ${item.party} for ${item.thing} · ${item.days}d`));
    const mobileActions = el('span', 'signature-actions');
    const mOpen = el('button', 'btn btn-ghost btn-sm', 'Open');
    mOpen.type = 'button';
    mOpen.addEventListener('click', () => navigate(`#/request/${item.id}`));
    const mChase = el('button', 'btn btn-secondary btn-sm', 'Log chase');
    mChase.type = 'button';
    mChase.addEventListener('click', () => {
      logChase(item.id, item.ruleId, item.party, item.thing);
      renderChaseView();
    });
    mobileActions.appendChild(mOpen);
    mobileActions.appendChild(mChase);
    wrap.appendChild(mobileActions);
    li.appendChild(wrap);
    mobileList.appendChild(li);
  }
}

// --- Counsel review ---------------------------------------------------

function renderCounselView() {
  const items = computeCounselItems();
  document.getElementById('counsel-summary').textContent =
    items.length === 0 ? 'Nothing is waiting on a lawyer right now.' : `${items.length} request${items.length === 1 ? '' : 's'} at lawyer review.`;

  const body = document.getElementById('counsel-body');
  body.innerHTML = '';
  document.getElementById('counsel-empty').hidden = items.length > 0;

  for (const item of items) {
    const card = el('div', 'card card-pad counsel-item');
    const head = el('div', 'counsel-item-head');
    head.appendChild(el('h3', 'counsel-item-title', item.sellerBuyer));
    const openLink = el('a', 'footer-link', 'Open request');
    openLink.href = `#/request/${item.id}`;
    head.appendChild(openLink);
    card.appendChild(head);
    card.appendChild(el('p', 'queue-meta', item.ref));

    card.appendChild(el('p', null, ensureSentence(queueWording(humanize(item.result.reason)))));

    if (item.result.citations && item.result.citations.length) {
      const cites = el('div', 'playbook-citations');
      for (const c of item.result.citations) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'playbook-citation';
        btn.textContent = formatCitation(c);
        btn.addEventListener('click', () => openDocViewer(c.doc, c.section));
        cites.appendChild(btn);
      }
      card.appendChild(cites);
    }

    const decisionsRow = el('div', 'counsel-decisions');
    if (item.options.length) {
      for (const option of item.options) {
        const btn = el('button', 'btn btn-secondary btn-sm', option.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          recordCounselDecision(item.id, item.rule.id, option);
          renderCounselView();
        });
        decisionsRow.appendChild(btn);
      }
    } else {
      const btn = el('button', 'btn btn-ghost btn-sm', 'Log counsel note');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        logOnly(item.id, `Counsel review logged for ${item.rule.title}`, 'Logged only. This point needs a legal judgement the desk cannot resolve from a fact.');
        renderCounselView();
      });
      decisionsRow.appendChild(btn);
      decisionsRow.appendChild(el('span', 'item-hint', 'No fact in the schema resolves this alone; recorded as a note only.'));
    }
    card.appendChild(decisionsRow);

    const decided = state.counselDecisions[item.id] || [];
    if (decided.length) {
      const log = el('ul', 'counsel-log');
      for (const d of decided) log.appendChild(el('li', null, `${d.label} · ${Dates.formatReadable(d.at)}`));
      card.appendChild(log);
    }

    body.appendChild(card);
  }
}

// --- New request wizard ---------------------------------------------------
//
// Three steps, ending on the request page for id "NEW": parties and terms,
// then the evidence gathered so far, then a review. Every field is the same
// field object the deal form uses (see buildDealSections/renderField), so a
// change here goes through the same applyOverride() path as editing an
// existing request. Nothing legal is decided in this file; the engine reads
// whatever facts the wizard has built once it lands on the request page.

const WIZARD_STEPS = ['Parties and interest', 'Evidence received so far', 'Review'];

function renderWizardSteps() {
  const wrap = document.getElementById('wizard-steps');
  wrap.innerHTML = '';
  const step = state.wizard.step;
  WIZARD_STEPS.forEach((label, i) => {
    const n = i + 1;
    const item = el('div', `wizard-step${n === step ? ' is-current' : n < step ? ' is-done' : ''}`);
    item.appendChild(el('span', 'wizard-step-dot', String(n)));
    item.appendChild(el('span', 'wizard-step-label', label));
    wrap.appendChild(item);
  });
  document.getElementById('wizard-step-label').textContent = `Step ${step} of ${WIZARD_STEPS.length} · ${WIZARD_STEPS[step - 1]}`;
}

function renderWizardActions(facts) {
  const wrap = document.getElementById('wizard-actions');
  wrap.innerHTML = '';
  const step = state.wizard.step;
  if (step > 1) {
    const back = el('button', 'btn btn-secondary', 'Back');
    back.type = 'button';
    back.addEventListener('click', () => {
      state.wizard.step -= 1;
      renderWizard();
    });
    wrap.appendChild(back);
  }
  if (step < WIZARD_STEPS.length) {
    const next = el('button', 'btn btn-primary', 'Continue');
    next.type = 'button';
    next.addEventListener('click', () => {
      state.wizard.step += 1;
      renderWizard();
    });
    wrap.appendChild(next);
  } else {
    const create = el('button', 'btn btn-primary', 'Create request');
    create.type = 'button';
    create.addEventListener('click', () => {
      const id = createRequestFromWizard();
      showToast(`Request created: ${facts.transfer.transferor} → ${facts.transfer.transferee}`, false);
      navigate(`#/request/${id}`);
    });
    wrap.appendChild(create);
  }
}

function renderWizard() {
  if (!state.wizard) {
    // A direct link or a page reload lands here without going through the
    // "New request" nav click, which normally seeds the intake defaults
    // before navigating. Seed them here too, so this view is never the
    // clean baseline: a new request starts with nothing evidenced.
    state.wizard = { step: 1 };
    if (!state.requestOverrides.NEW) state.requestOverrides.NEW = JSON.parse(JSON.stringify(NEW_INTAKE_OVERRIDES));
  }
  const facts = factsForId('NEW');
  const sections = buildDealSections(facts);
  const byId = new Map(sections.map((s) => [s.id, s]));

  renderWizardSteps();

  const body = document.getElementById('wizard-body');
  body.innerHTML = '';

  if (state.wizard.step === 1) {
    const sale = byId.get('deal-sale');
    for (const field of sale.fields) body.appendChild(renderField(field));
  } else if (state.wizard.step === 2) {
    const groups = ['deal-fund', 'deal-harbour', 'deal-company', 'deal-buyer'].map((id) => byId.get(id)).filter(Boolean);
    for (const group of groups) {
      if (!group.fields.length) continue;
      body.appendChild(el('h3', 'wizard-group-title', group.title));
      for (const field of group.fields) body.appendChild(renderField(field));
    }
  } else {
    body.appendChild(el('h3', 'wizard-group-title', 'The sale'));
    body.appendChild(el('p', 'wizard-review-line', saleSummary(facts)));
    body.appendChild(el('h3', 'wizard-group-title', 'The fund'));
    body.appendChild(el('p', 'wizard-review-line', fundSummary(facts)));
    if (facts.transfer.transferor === 'Harbour Family Office LLC') {
      body.appendChild(el('h3', 'wizard-group-title', 'Harbour side letter'));
      body.appendChild(el('p', 'wizard-review-line', harbourSummary(facts)));
    }
    body.appendChild(el('h3', 'wizard-group-title', "Helion's agreement"));
    body.appendChild(el('p', 'wizard-review-line', companySummary(facts)));
    body.appendChild(el('h3', 'wizard-group-title', 'Buyer checks'));
    body.appendChild(el('p', 'wizard-review-line', buyerChecksSummary(facts)));
    body.appendChild(el('p', 'wizard-review-note', 'This opens the request page, where the answer, the clause behind it and every next action are shown, and any of this can still be changed.'));
  }

  renderWizardActions(facts);
}

// --- Deal field definitions -------------------------------------------
//
// Each field writes straight into the facts object through applyOverride().
// Fields do not map one-to-one to engine rules: a single control (the buyer
// picker) can set several facts at once, and a field that does not apply to
// the current deal stays visible but disabled, with a one-line reason, per
// CLAUDE.md's "fail safe, never hide the question" spirit.

// Every fact change, whether from the deal form or a "Log" button on a next
// action, goes through here: merge the change into this request's session
// overrides, then re-render, which re-runs Engine.evaluate(). The activity
// entry records the answer before and after, both read from the engine.
// explicitId lets a caller outside a request page (the Counsel review queue
// lists items from several requests at once, none of which is "the current
// request") say exactly which request the change applies to; every other
// caller runs from inside a request page, where state.route.id already
// names it correctly.
function applyOverride(overrideObj, logText, explicitId) {
  const id = explicitId || state.route.id;
  const before = statusOf(decisionForId(id).decision);
  const previous = state.requestOverrides[id];
  state.requestOverrides[id] = Engine.deepMergeFacts(previous || {}, overrideObj);
  const after = statusOf(decisionForId(id).decision);
  if (logText) {
    const entry = {
      text: logText,
      meta: before.long === after.long ? `Answer unchanged: ${lowerFirst(after.long)}` : `Answer moved from ${lowerFirst(before.long)} to ${lowerFirst(after.long)}`,
    };
    (state.activity[id] = state.activity[id] || []).unshift(entry);
    state.undo = { id, previous, entry };
  }
  render();
  return { before, after };
}

function undoLast() {
  const u = state.undo;
  if (!u) return;
  state.undo = null;
  if (u.previous) state.requestOverrides[u.id] = u.previous;
  else delete state.requestOverrides[u.id];
  const list = state.activity[u.id] || [];
  const i = list.indexOf(u.entry);
  if (i >= 0) list.splice(i, 1);
  hideToast();
  render();
}

// --- Toast --------------------------------------------------------------

let toastTimer = null;

function showToast(text, withUndo) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-text').textContent = text;
  document.getElementById('toast-undo').hidden = !withUndo;
  toast.hidden = false;
  toast.classList.add('is-entering');
  requestAnimationFrame(() => toast.classList.remove('is-entering'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}

function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast').hidden = true;
}

// --- Next actions that can be logged in one tap --------------------------
//
// Maps an outstanding checklist item to the fact change that evidences it,
// dated to the request's as_of (never the real clock). This is exactly the
// change the deal form would make for the same fact; the engine then decides
// what it means, which can include a new failure (for example, a notice
// logged today may leave too few clear days before completion).

function loggableAction(ruleId, facts) {
  const at = `${facts.as_of}T10:00`;
  const day = Dates.formatReadable(facts.as_of);
  const gp = facts.fund.gp_consent || {};
  const co = facts.company.consent || {};
  switch (ruleId) {
    case 'F-CONSENT':
    case 'S-DEEMED-CONSENT':
      if (gp.status === 'not_requested') {
        return { label: 'Log request sent', override: { fund: { gp_consent: { ...gp, status: 'requested', requested_at: at, complete: 'yes' } } }, log: `Request for the GP's consent logged as sent on ${day}` };
      }
      if (gp.status === 'requested' && gp.complete === 'no') {
        return { label: 'Log complete request sent', override: { fund: { gp_consent: { ...gp, complete: 'yes', requested_at: at } } }, log: `Complete request for the GP's consent logged as sent on ${day}` };
      }
      if (gp.status === 'requested') {
        return { label: 'Log written consent', override: { fund: { gp_consent: { ...gp, status: 'received', received_at: at } } }, log: `The GP's written consent logged as received on ${day}` };
      }
      return null;
    case 'C-CONSENT':
      if (co.status === 'not_requested') {
        return { label: 'Log request sent', override: { company: { consent: { ...co, status: 'requested', requested_at: at } } }, log: `Request for Helion's consent logged as sent on ${day}` };
      }
      if (co.status === 'requested') {
        return { label: 'Log written consent', override: { company: { consent: { ...co, status: 'received', received_at: at } } }, log: `Helion's written consent logged as received on ${day}` };
      }
      return null;
    case 'F-PERMITTED-NOTICE':
      return { label: 'Log notice delivered', override: { fund: { gp_permitted_notice: { status: 'delivered', sent_at: at, complete: 'yes' } } }, log: `Notice of the transfer to the GP logged as delivered on ${day}` };
    case 'C-PERMITTED-NOTICE':
      return { label: 'Log notice delivered', override: { company: { permitted_notice: { status: 'delivered', sent_at: at, complete: 'yes' } } }, log: `Notice of the transfer to Helion logged as delivered on ${day}` };
    case 'C-ROFR-NOTICE':
      return {
        label: 'Log Transfer Notice delivered',
        override: { company: { rofr_notice: { status: 'delivered', sent_at: at, complete: 'yes', proof_of_delivery: 'yes' } } },
        log: `Complete Transfer Notice logged as delivered to Helion on ${day}`,
      };
    case 'C-ROFR-RESPONSE':
      if ((facts.company.rofr_response || {}).status !== 'none') return null;
      return { label: 'Log written waiver', override: { company: { rofr_response: { status: 'waived', at: facts.as_of } } }, log: `Helion's written waiver of its right of first refusal logged on ${day}` };
    case 'B-KYC':
      return { label: 'Log KYC cleared', override: { buyer: { kyc: 'cleared' } }, log: 'KYC and AML checks logged as cleared' };
    case 'B-SANCTIONS':
      return { label: 'Log screening clear', override: { buyer: { sanctions: 'clear' } }, log: 'Sanctions screening logged as clear' };
    case 'B-TAX-FORM':
      return { label: 'Log tax form received', override: { buyer: { tax_form: 'received' } }, log: 'Tax form logged as received' };
    case 'B-ADHERENCE':
      return { label: 'Log signed agreement', override: { buyer: { adherence: 'signed' } }, log: 'Signed Transfer and Adherence Agreement logged as received' };
    default:
      return null;
  }
}

function runLoggedAction(action) {
  const { after } = applyOverride(action.override, action.log);
  showToast(`${action.log}. Now: ${lowerFirst(after.long)}.`, true);
}

// A log-only entry: records something happened (a chase, a counsel note)
// without touching any fact the engine reads. Used whenever there is no
// fact in the schema that the event maps to, so the verdict cannot move.
function logOnly(id, text, meta) {
  (state.activity[id] = state.activity[id] || []).unshift({ text, meta: meta || 'Logged only. Does not change the answer.' });
  render();
}

// --- Signatures -------------------------------------------------------
//
// Blocked transfers never reach signature. The wizard and the request page
// only offer these actions once the answer is not BLOCKED, matching the
// operator's real workflow: nobody signs on a transfer that cannot proceed.

function setSignatureState(id, key, newState, facts) {
  const signatory = SIGNATORIES.find((s) => s.key === key);
  const day = Dates.formatReadable(facts.as_of);
  const verb = newState === 'sent' ? 'sent for signature' : 'signed';
  if (signatory.factPath && newState === 'signed') {
    const label = `${signatory.label}'s signature on the Transfer and Adherence Agreement logged as received on ${day}`;
    applyOverride(nestOverride(signatory.factPath, signatory.factDoneValue), label);
    const rec = (state.signatures[id] = state.signatures[id] || {});
    rec[key] = newState;
    return;
  }
  const rec = (state.signatures[id] = state.signatures[id] || {});
  rec[key] = newState;
  logOnly(id, `${signatory.label}'s copy of the Transfer and Adherence Agreement logged as ${verb} on ${day}`, 'Tracked for the signing workflow; no rule reads a seller or GP signature.');
}

// --- Chase list -------------------------------------------------------
//
// Every outstanding item across every request that is waiting on someone
// else to respond, not on Ops to act. Read straight off the same decisions
// and due dates the queue and Deadlines page use; a chase never changes a
// fact, it only records that Ops asked again.
const CHASE_RULES = {
  'F-CONSENT': { party: 'the GP', thing: "the GP's consent", timestampPath: 'fund.gp_consent.requested_at' },
  'S-DEEMED-CONSENT': { party: 'the GP', thing: "the GP's consent", timestampPath: 'fund.gp_consent.requested_at' },
  'C-CONSENT': { party: 'Helion', thing: "Helion's consent", timestampPath: 'company.consent.requested_at' },
  'C-ROFR-RESPONSE': { party: 'Helion', thing: 'a response to the Transfer Notice', timestampPath: 'company.rofr_notice.sent_at' },
  'B-KYC': { party: 'the buyer', thing: 'KYC and AML checks', timestampPath: null },
  'B-SANCTIONS': { party: 'the buyer', thing: 'sanctions screening', timestampPath: null },
  'B-TAX-FORM': { party: 'the buyer', thing: 'the tax form', timestampPath: null },
  'B-ADHERENCE': { party: 'the buyer', thing: 'the signed Transfer and Adherence Agreement', timestampPath: null },
};

function chaseAgeDays(row, meta, asOfISO) {
  const from = meta.timestampPath ? getPath(row.facts, meta.timestampPath) : null;
  const fromDate = from ? from.slice(0, 10) : row.received;
  return daysOpen(fromDate, asOfISO);
}

function computeChaseItems() {
  const asOf = DATA.baseFacts.as_of;
  const items = [];
  for (const meta of QUEUE_ROWS) {
    const { facts, decision } = decisionForId(meta.id);
    // Only rules that have already been requested/sent count as "waiting on
    // someone else"; a rule that is OUTSTANDING because Ops has not yet
    // acted (for example not_requested) is Ops's own next action, not a
    // chase.
    for (const r of decision.results) {
      if (r.state !== 'OUTSTANDING') continue;
      const ruleMeta = CHASE_RULES[r.rule_id];
      if (!ruleMeta) continue;
      const waiting =
        r.rule_id === 'F-CONSENT' || r.rule_id === 'S-DEEMED-CONSENT'
          ? facts.fund.gp_consent.status === 'requested'
          : r.rule_id === 'C-CONSENT'
            ? facts.company.consent.status === 'requested'
            : r.rule_id === 'C-ROFR-RESPONSE'
              ? facts.company.rofr_notice.status === 'delivered' && facts.company.rofr_response.status === 'none'
              : true;
      if (!waiting) continue;
      items.push({
        id: meta.id,
        ref: meta.ref,
        sellerBuyer: `${facts.transfer.transferor} → ${facts.transfer.transferee}`,
        ruleId: r.rule_id,
        party: ruleMeta.party,
        thing: ruleMeta.thing,
        days: chaseAgeDays({ facts, received: meta.received }, ruleMeta, asOf),
        chasedCount: ((state.chases[meta.id] || {})[r.rule_id] || []).length,
      });
    }
  }
  return items.sort((a, b) => b.days - a.days);
}

// Requests that have an OUTSTANDING rule waiting on a third party, but
// where the request itself has not yet gone out (for example
// not_requested or not_sent). These are Ops's own next action, not a
// chase, so they never appear as chase rows; this is read alongside the
// chase table so a short list never reads as broken or empty when most of
// the queue simply has not reached "asked and waiting" yet.
function computeOwnActionRequests() {
  const seen = new Map();
  for (const meta of QUEUE_ROWS) {
    const { facts, decision } = decisionForId(meta.id);
    for (const r of decision.results) {
      if (r.state !== 'OUTSTANDING') continue;
      if (!CHASE_RULES[r.rule_id]) continue;
      const waiting =
        r.rule_id === 'F-CONSENT' || r.rule_id === 'S-DEEMED-CONSENT'
          ? facts.fund.gp_consent.status === 'requested'
          : r.rule_id === 'C-CONSENT'
            ? facts.company.consent.status === 'requested'
            : r.rule_id === 'C-ROFR-RESPONSE'
              ? facts.company.rofr_notice.status === 'delivered' && facts.company.rofr_response.status === 'none'
              : true;
      if (waiting) continue;
      if (!seen.has(meta.id)) seen.set(meta.id, { id: meta.id, ref: meta.ref, sellerBuyer: `${facts.transfer.transferor} → ${facts.transfer.transferee}` });
    }
  }
  return Array.from(seen.values());
}

function logChase(id, ruleId, party, thing) {
  const facts = factsForId(id);
  const day = Dates.formatReadable(facts.as_of);
  const rec = (state.chases[id] = state.chases[id] || {});
  (rec[ruleId] = rec[ruleId] || []).push(facts.as_of);
  logOnly(id, `Chased ${party} for ${thing} on ${day}`, 'Logged only. Does not change the answer.');
  showToast(`Chase logged for ${party}.`, false);
}

// --- Counsel review -----------------------------------------------------
//
// Every request currently at "lawyer review", with the uncertain rule that
// put it there and, where the rulebook models a real answer to that
// uncertainty as a fact, the fact changes counsel can confirm. Anything
// else is recorded as a note only: the brief for this desk is explicit
// that an operator's or a lawyer's say-so never overrides the verdict, only
// evidence the engine already understands does.
function counselOptionsFor(ruleId, facts) {
  const at = `${facts.as_of}T10:00`;
  switch (ruleId) {
    case 'C-CONSENT':
      return [
        { label: 'Confirm written consent was received', override: { company: { consent: { status: 'received', received_at: at } } } },
        { label: 'Confirm consent was refused', override: { company: { consent: { status: 'refused' } } } },
      ];
    case 'F-CONSENT':
      return [
        { label: "Confirm the GP's written consent was received", override: { fund: { gp_consent: { ...facts.fund.gp_consent, status: 'received', received_at: at } } } },
        { label: 'Confirm the GP refused consent', override: { fund: { gp_consent: { ...facts.fund.gp_consent, status: 'refused' } } } },
      ];
    case 'S-DEEMED-CONSENT':
      return [
        { label: 'Confirm the request to the GP was complete', override: { fund: { gp_consent: { ...facts.fund.gp_consent, complete: 'yes' } } } },
        { label: 'Confirm the request to the GP was incomplete', override: { fund: { gp_consent: { ...facts.fund.gp_consent, complete: 'no' } } } },
      ];
    case 'X-VERSION':
      return [{ label: 'Confirm the evidence matches the current document version', override: { documents_version_confirmed: 'yes' } }];
    case 'F-BO-LIMIT':
      return [{ label: 'Confirm the current beneficial owner count with the GP', override: null, note: 'Needs a number from the GP; not a yes or no counsel can confirm alone.' }];
    default:
      return [];
  }
}

function computeCounselItems() {
  const ruleMap = new Map(DATA.rulebook.rules.map((r) => [r.id, r]));
  const items = [];
  for (const meta of QUEUE_ROWS) {
    const { facts, decision } = decisionForId(meta.id);
    if (decision.verdict !== 'ESCALATE') continue;
    const r = decision.results.find((r) => r.state === 'UNKNOWN' || r.state === 'CONTRADICTORY');
    if (!r) continue;
    items.push({
      id: meta.id,
      ref: meta.ref,
      sellerBuyer: `${facts.transfer.transferor} → ${facts.transfer.transferee}`,
      rule: ruleMap.get(r.rule_id),
      result: r,
      options: counselOptionsFor(r.rule_id, facts).filter((o) => o.override),
    });
  }
  return items;
}

function recordCounselDecision(id, ruleId, option) {
  const facts = factsForId(id);
  const day = Dates.formatReadable(facts.as_of);
  applyOverride(option.override, `Counsel decision logged: ${lowerFirst(option.label)} (${day})`, id);
  (state.counselDecisions[id] = state.counselDecisions[id] || []).push({ ruleId, label: option.label, at: facts.as_of });
}

// --- Register update ---------------------------------------------------
//
// Available only once a request is ready for the GP to record, i.e. verdict
// CHECKLIST_READY with nothing outstanding: the same state the queue and
// request page already show as "Ready to record". Recording here does not
// feed back into the engine; LPA 8.5 makes this a human act, not a rule.
function registerPreview(facts) {
  const t = facts.transfer;
  const total = t.transferor_capital_contribution;
  const moved = Math.round(total * Math.min(t.fraction, 1));
  const retained = Math.round(total - moved);
  return {
    effectiveDate: facts.as_of,
    rows: [
      { party: t.transferor, role: 'Transferor', before: total, after: t.fraction >= 1 ? 0 : retained },
      { party: t.transferee, role: 'Transferee', before: 0, after: moved },
    ],
    amountMoved: moved,
  };
}

function recordInRegister(id) {
  const facts = factsForId(id);
  const preview = registerPreview(facts);
  state.register[id] = { at: facts.as_of, preview };
  const day = Dates.formatReadable(facts.as_of);
  (state.activity[id] = state.activity[id] || []).unshift({
    text: `Recorded in the Register on ${day} (LPA 8.5)`,
    meta: `US$${preview.amountMoved.toLocaleString('en-US')} of Capital Contribution moved from ${facts.transfer.transferor} to ${facts.transfer.transferee}`,
  });
  showToast('Recorded in the Register.', false);
  render();
}

function registerRecordAsJson(id, facts, preview) {
  const meta = QUEUE_META[id] || {};
  return JSON.stringify(
    {
      reference: meta.ref || id,
      transferor: facts.transfer.transferor,
      transferee: facts.transfer.transferee,
      effective_date: preview.effectiveDate,
      capital_contribution_moved: preview.amountMoved,
      holdings: preview.rows,
      recorded_under: 'LPA 8.5',
    },
    null,
    2,
  );
}

function registerRecordAsCsv(id, facts, preview) {
  const meta = QUEUE_META[id] || {};
  const header = 'reference,party,role,before,after,effective_date';
  const lines = preview.rows.map((r) => `${meta.ref || id},${r.party},${r.role},${r.before},${r.after},${preview.effectiveDate}`);
  return [header, ...lines].join('\n');
}

function downloadFile(filename, contents, mime) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Deterministic drafts -------------------------------------------------
//
// Plain text built from the same facts the engine reads, with no model in
// the loop. Offered only next to the two checklist items they answer, and
// only while that step is still outstanding.

function draftFor(ruleId, facts) {
  const seller = facts.transfer.transferor;
  const buyer = facts.transfer.transferee;
  const contribution = `US$${facts.transfer.transferor_capital_contribution.toLocaleString('en-US')}`;
  const fraction = facts.transfer.fraction < 1 ? `${Math.round(facts.transfer.fraction * 100)}% of` : 'the whole of';
  const completion = Dates.formatReadable(facts.transfer.proposed_completion);
  const today = Dates.formatReadable(facts.as_of);
  if (ruleId === 'C-CONSENT' && facts.company.consent.status !== 'received') {
    return {
      title: 'Draft consent request to Helion',
      citation: 'SA 3.1',
      body: `To the Board of Directors of Helion Robotics, Inc.\n\nRe: Request for written consent to a Transfer under section 3.1 of the Stockholders' Agreement\n\n${seller} proposes to Transfer ${fraction} its interest (Capital Contribution ${contribution}) in Northgate Helion SPV LP to ${buyer}, with completion proposed for ${completion}.\n\nUnder section 3.1 of the Stockholders' Agreement, this Transfer requires the Company's prior written consent, approved by the Board. We ask the Board to consider this request and confirm its consent in writing. Please note that, under section 3.4, silence is not consent.\n\nDated ${today}.`,
    };
  }
  if (ruleId === 'C-ROFR-NOTICE' && facts.company.rofr_notice.status !== 'delivered') {
    return {
      title: 'Draft Transfer Notice',
      citation: 'SA 4.1',
      body: `To the Board of Directors of Helion Robotics, Inc.\n\nRe: Transfer Notice under section 4.1 of the Stockholders' Agreement\n\n${seller} gives notice of a proposed Transfer of ${fraction} its interest (Capital Contribution ${contribution}) in Northgate Helion SPV LP to ${buyer}, with completion proposed for ${completion}.\n\nThis notice is given under section 4.1 of the Stockholders' Agreement and offers the Company the right of first refusal described in section 4.2. The exercise period runs from the Company's receipt of this notice. Please acknowledge receipt.\n\nDated ${today}.`,
    };
  }
  if (ruleId === 'B-KYC' && facts.buyer.kyc !== 'cleared') {
    return {
      title: 'Draft AML/KYC comfort letter request',
      citation: 'LPA 8.4(b)',
      body: `To the compliance contact for ${buyer}\n\nRe: Know-your-customer confirmation for a proposed Transfer of an interest in Northgate Helion SPV LP\n\n${buyer} is the proposed transferee of ${fraction} the interest held by ${seller} (Capital Contribution ${contribution}), with completion proposed for ${completion}.\n\nUnder section 8.4(b) of the Limited Partnership Agreement, the General Partner's consent is conditioned on completion of know-your-customer and anti-money-laundering checks and clearance of sanctions screening on the transferee. We ask that ${buyer} provide a comfort letter, or supporting documentation, confirming its KYC/AML status, or complete the outstanding checks directly with the fund administrator.\n\nDated ${today}.`,
    };
  }
  if (ruleId === 'B-TAX-FORM' && facts.buyer.tax_form === 'outstanding') {
    return {
      title: 'Draft tax form checklist',
      citation: 'LPA 8.4(c)',
      body: `To ${buyer}\n\nRe: Tax documentation required before completion of a proposed Transfer\n\nBefore the General Partner can give effect to the proposed Transfer of ${fraction} the interest held by ${seller} in Northgate Helion SPV LP (completion proposed for ${completion}), the transferee must provide a properly completed US tax form appropriate to its status, under section 8.4(c) of the Limited Partnership Agreement.\n\nChecklist:\n - Confirm whether the transferee is a US person or a non-US person for US tax purposes\n - If a US person, complete and sign Form W-9\n - If a non-US person, complete and sign the applicable Form W-8 (W-8BEN for an individual, W-8BEN-E or W-8IMY for an entity)\n - Return the signed form to the fund administrator before completion\n\nDated ${today}.`,
    };
  }
  return null;
}

// Every draft type the Documents tab knows how to build, in the order they
// are offered. Each entry names the rule it answers so the panel can show
// why a draft is or is not currently needed, using the same draftFor logic
// the Next actions checklist already relies on, so there is only one place
// that generates draft text.
const DOCUMENT_DRAFT_RULES = [
  { ruleId: 'C-CONSENT', neededLabel: "Helion's written consent has not been requested or received yet." },
  { ruleId: 'C-ROFR-NOTICE', neededLabel: 'The Transfer Notice has not been served yet.' },
  { ruleId: 'B-KYC', neededLabel: "The buyer's KYC/AML clearance is not confirmed yet." },
  { ruleId: 'B-TAX-FORM', neededLabel: "The buyer's tax form is outstanding." },
];

// The Transfer and Adherence Agreement itself: the document the Signatures
// tab tracks signing of, but which the Documents tab never actually showed
// before this round. Built from the same facts as every other draft, with
// each signature block carrying whatever this session has logged on the
// Signatures tab, so the two tabs describe one document, not two. Not
// offered on a blocked transfer, matching when Signatures itself opens.
function agreementDraftFor(id, facts) {
  const seller = facts.transfer.transferor;
  const buyer = facts.transfer.transferee;
  const contribution = `US$${facts.transfer.transferor_capital_contribution.toLocaleString('en-US')}`;
  const fraction = facts.transfer.fraction < 1 ? `${Math.round(facts.transfer.fraction * 100)}% of` : 'the whole of';
  const completion = Dates.formatReadable(facts.transfer.proposed_completion);
  const today = Dates.formatReadable(facts.as_of);
  const sigLine = (sig) => {
    if (sig.state === 'signed') return `Signed (logged ${today})`;
    if (sig.state === 'sent') return 'Sent for signature, not yet signed';
    return 'Not yet sent';
  };
  const sigs = signaturesFor(id, facts);
  const blocks = sigs
    .map((sig) => {
      const party = sig.key === 'seller' ? `TRANSFEROR\n${seller}` : sig.key === 'buyer' ? `TRANSFEREE\n${buyer}` : 'GENERAL PARTNER\nActing for Northgate Helion SPV LP';
      return `${party}\nSignature: ________________________  Date: ________________\nStatus: ${sigLine(sig)}`;
    })
    .join('\n\n');
  return {
    title: 'Draft Transfer and Adherence Agreement',
    citation: 'LPA 8.1, 8.4(a); SA 3.1',
    body: `TRANSFER AND ADHERENCE AGREEMENT\n\nDated ${today}\n\nBetween the Transferor, the Transferee and the General Partner of Northgate Helion SPV LP.\n\n1. Transfer. The Transferor agrees to transfer to the Transferee ${fraction} its interest in the Partnership (Capital Contribution ${contribution}), with completion proposed for ${completion}, under section 8.1 of the Limited Partnership Agreement.\n\n2. Adherence. The Transferee agrees to adhere to and be bound by the Limited Partnership Agreement as if an original party, under section 8.4(a).\n\n3. Conditions. This Transfer remains subject to the General Partner's consent, the Company's consent and right of first refusal, and the other conditions on the compliance checklist for this request. Signing this agreement does not itself satisfy any of them.\n\n${blocks}`,
  };
}

function documentDraftFilename(title) {
  return `${title.toLowerCase().replace(/^draft\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}.txt`;
}

// Renders the Documents tab: one card per deterministic draft the facts on
// this request currently call for. A draft only appears while the step it
// answers is still outstanding, matching the Next actions checklist exactly
// (both read draftFor), so the tab can never show a stale draft for a step
// that is already done. When nothing is currently needed, a single quiet
// line explains that, rather than leaving the tab looking broken or empty.
function renderDocumentsPanel(id, decision, facts) {
  const body = document.getElementById('documents-body');
  if (!body) return;
  body.innerHTML = '';

  const cards = [];
  if (decision.verdict !== 'BLOCKED') {
    cards.push({ ruleId: 'AGREEMENT', draft: agreementDraftFor(id, facts) });
  }
  for (const { ruleId } of DOCUMENT_DRAFT_RULES) {
    const draft = draftFor(ruleId, facts);
    if (draft) cards.push({ ruleId, draft });
  }

  if (cards.length === 0) {
    body.appendChild(el('p', 'queue-empty', 'No drafts are available. This transfer is blocked, so there is nothing to sign or send.'));
    return;
  }

  for (const { draft } of cards) {
    const card = el('div', 'card card-pad document-draft-card');
    const head = el('div', 'draft-pane-head');
    head.appendChild(el('h3', 'section-title section-title-bare', draft.title));
    const actions = el('div', 'document-draft-actions');
    const copyBtn = el('button', 'btn btn-ghost btn-sm', 'Copy');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(draft.body);
        showToast('Draft copied to clipboard', false);
      } catch (e) {
        showToast('Could not copy. Select the text and copy it manually.', false);
      }
    });
    const downloadBtn = el('button', 'btn btn-secondary btn-sm', 'Download .txt');
    downloadBtn.type = 'button';
    downloadBtn.addEventListener('click', () => downloadFile(documentDraftFilename(draft.title), draft.body, 'text/plain'));
    actions.appendChild(copyBtn);
    actions.appendChild(downloadBtn);
    head.appendChild(actions);
    card.appendChild(head);
    card.appendChild(el('span', 'draft-pane-label', `Draft for review. Not legal advice. Cites ${draft.citation}.`));
    card.appendChild(el('pre', 'draft-pane-body', draft.body));
    body.appendChild(card);
  }
}

function toggleDraftPane(container, draft) {
  const existing = container.querySelector('.draft-pane');
  if (existing) {
    existing.remove();
    return;
  }
  const pane = el('div', 'draft-pane');
  const head = el('div', 'draft-pane-head');
  head.appendChild(el('span', 'draft-pane-label', 'Draft for review. Not legal advice.'));
  const copyBtn = el('button', 'btn btn-ghost btn-sm', 'Copy');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(draft.body);
      showToast('Draft copied to clipboard', false);
    } catch (e) {
      showToast('Could not copy. Select the text and copy it manually.', false);
    }
  });
  head.appendChild(copyBtn);
  pane.appendChild(head);
  pane.appendChild(el('pre', 'draft-pane-body', draft.body));
  container.appendChild(pane);
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const BUYERS = [
  { name: 'Mira Chen', relationship: 'unrelated', competitor: 'no' },
  { name: 'Kestrel Automation Ltd', relationship: 'unrelated', competitor: 'yes', note: 'Helion competitor' },
  { name: 'Aldwych Angels II Ltd', relationship: 'affiliate', competitor: 'no', note: "seller's affiliate" },
  { name: 'Harbour Growth Fund II LP', relationship: 'harbour_transferee', competitor: 'no', note: 'Harbour-managed fund' },
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
          // The request's own buyer, re-selected: keep its recorded facts.
          if (!b) return { transfer: { transferee: v } };
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
    // A request's own party (for example a queue row's seller) may not be
    // one of the preset choices; list it first so the control shows the
    // party the request is actually about rather than the first preset.
    const choices = field.choices.some((c) => String(c.value) === String(field.currentValue)) || field.currentValue == null
      ? field.choices
      : [{ value: field.currentValue, label: String(field.currentValue) }, ...field.choices];
    for (const choice of choices) {
      const opt = document.createElement('option');
      opt.value = choice.value;
      opt.textContent = choice.label;
      opt.selected = String(choice.value) === String(field.currentValue);
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const picked = choices.find((c) => String(c.value) === select.value);
      applyOverride(field.buildOverride(select.value), `${field.label} set to ${picked ? picked.label : select.value}`);
    });
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
      btn.addEventListener('click', () => {
        if (pressed) return;
        applyOverride(field.buildOverride(choice.value), `${field.label} set to ${choice.label}`);
      });
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
    input.addEventListener('change', () => {
      const shown = dateHint(field.kind, input.value) || (input.value === '' ? 'blank' : input.value);
      applyOverride(field.buildOverride(input.value), `${field.label} set to ${shown}`);
    });
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
    const isDeciding = section.id === decidingSecId;
    const sectionEl = el('section', 'deal-section' + (isDeciding ? ' is-deciding' : ''));
    sectionEl.id = section.id;

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
    if (!collapsed) {
      const fields = el('div', 'deal-fields');
      for (const field of section.fields) fields.appendChild(renderField(field));
      sectionEl.appendChild(fields);
    }
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

const ANSWER_SUBLINES = {
  blocked: 'A known condition has failed. Nothing moves until it is cured.',
  lawyer: 'Evidence is missing, unclear or conflicting. A lawyer decides before anything moves.',
  actions: 'Nothing blocks this transfer, but these steps must be completed before the GP can record it.',
  ready: 'Every condition is evidenced. Recording in the Register (LPA 8.5) is a human decision.',
  recorded: 'The General Partner has recorded this transfer in the Register (LPA 8.5). Nothing further is outstanding.',
};

const GATE_STATUS_BADGE = {
  Fails: 'badge-blocked',
  'Needs a lawyer': 'badge-lawyer',
  'Action needed': 'badge-action',
  Met: 'badge-ready',
  'Not relevant': 'badge-quiet',
};

// Short labels for "what's wrong" badges: what failed, not the rule's
// title (a rule title reads as the satisfied condition, e.g. "Transferee
// is not a Competitor", which is confusing next to a failure). Most rules
// have one failure mode, but C-ROFR-RESPONSE has two, told apart by its
// reason text below.
const WHATS_WRONG_LABELS = {
  'F-CONSENT': 'GP consent was refused',
  'C-CONSENT': "Helion's consent was refused",
  'F-PERMITTED-NOTICE': 'GP notice arrived too late',
  'C-PERMITTED-NOTICE': "Helion's notice arrived too late",
  'F-MIN-HOLDING': 'Holding falls below the minimum',
  'F-BO-LIMIT': 'Transfer breaches the beneficial owner limit',
  'C-COMPETITOR': 'Buyer is a Competitor',
  'C-ROFR-WINDOW': 'Completion is outside the ROFR window',
  'B-SANCTIONS': 'Buyer failed sanctions screening',
  'B-ACCREDITED': 'Buyer is not accredited',
};

function whatsWrongLabel(rule, result) {
  if (rule && rule.id === 'C-ROFR-RESPONSE') {
    return result && /exercised its right of first refusal in whole/.test(result.reason)
      ? 'Helion is buying the interest'
      : 'Completion falls inside the ROFR period';
  }
  if (rule && WHATS_WRONG_LABELS[rule.id]) return WHATS_WRONG_LABELS[rule.id];
  return (rule && rule.title) || 'Fails';
}

function renderAnswer(decision, ruleMap, id) {
  const status = statusOf(decision, id);
  const headline = ensureSentence(queueWording(humanize(decision.headline)));

  const mobileVerdict = document.getElementById('mobile-verdict');
  mobileVerdict.textContent = status.short;
  mobileVerdict.className = `mobile-verdict badge ${status.badge}`;
  document.getElementById('mobile-headline').textContent = headline;

  const panel = document.getElementById('answer-panel');
  panel.innerHTML = '';
  panel.className = `answer-panel card is-${status.key === 'actions' ? 'action' : status.key}`;
  panel.appendChild(el('p', 'answer-eyebrow', 'The answer today'));
  panel.appendChild(el('span', `badge badge-lg ${status.badge}`, status.long));
  panel.appendChild(el('h2', 'answer-headline', headline));
  panel.appendChild(el('p', 'answer-sub', ANSWER_SUBLINES[status.key]));

  const docList = el('ul', 'doc-status-list');
  docList.setAttribute('aria-label', 'Each document');
  for (const group of GATE_GROUPS) {
    const gateStatus = gateGroupStatus(decision, ruleMap, group.gates);
    const li = el('li');
    li.appendChild(el('span', null, group.label));
    li.appendChild(el('span', `badge ${GATE_STATUS_BADGE[gateStatus] || 'badge-quiet'}`, gateStatus));
    docList.appendChild(li);
  }
  panel.appendChild(docList);

  const next = status.key === 'actions' ? nextActionOf(decision) : null;
  if (next) {
    const box = el('div', 'answer-next');
    box.appendChild(el('strong', null, next.due ? `Next · ${next.owner} · due ${Dates.formatReadable(next.due)}` : `Next · ${next.owner}`));
    box.appendChild(document.createTextNode(ensureSentence(queueWording(humanize(next.text)))));
    panel.appendChild(box);
  }

  const key = `${decision.verdict}|${decision.headline}`;
  if (state.lastAnswerId !== state.route.id) state.lastAnswerKey = null;
  state.lastAnswerId = state.route.id;
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

  container.appendChild(el('p', 'why-reason', queueWording(result.reason)));

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
      link.className = 'open-doc btn btn-ghost btn-sm';
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

  // The SA 4.6 cross-cutting note ("consent and the right of first refusal
  // are independent gates") is correctly generated by the engine whenever a
  // sale reaches both rule families (CLAUDE.md section 6), even when neither
  // is the rule that actually decided the answer, for example a Competitor
  // block. It belongs in the full compliance list, but repeating it here
  // under a rule it has nothing to do with reads as noise, so this card
  // only shows it when the deciding rule is a consent or ROFR rule.
  const RELEVANT_TO_4_6 = ['C-CONSENT', 'C-ROFR-NOTICE', 'C-ROFR-RESPONSE', 'C-ROFR-WINDOW', 'C-PERMITTED-NOTICE'];
  const shownNotes = decision.notes.filter((n) => !n.includes('4.6') || RELEVANT_TO_4_6.includes(decidingId));

  if (shownNotes.length) {
    const notes = el('ul', 'notes');
    for (const n of shownNotes) notes.appendChild(el('li', null, n));
    container.appendChild(notes);
  }
}

// --- What happens next ------------------------------------------------

function renderNext(decision, ruleMap, id) {
  const heading = document.getElementById('next-heading');
  const list = document.getElementById('next-list');
  list.innerHTML = '';

  // Once recorded, the checklist this list was built from is finished: the
  // engine's own last checklist item ("GP records the transfer...") is
  // permanent, fixed legal-content wording (CLAUDE.md section 5) that
  // always appears under a CHECKLIST_READY verdict whether or not anyone
  // has actually recorded it yet, since the engine has no concept of
  // "recorded". This UI-only branch is what tells the two states apart.
  const recorded = id && state.register[id];
  if (recorded) {
    heading.textContent = 'Recorded';
    const li = el('li', 'item-final');
    li.appendChild(el('div', 'item-text', `Recorded in the Register on ${Dates.formatReadable(recorded.at)} (LPA 8.5). See the register update below.`));
    list.appendChild(li);
    return;
  }

  if (decision.verdict === 'BLOCKED') {
    heading.textContent = 'What would change the answer';
    for (const item of decision.checklist) {
      const li = el('li', 'is-cure');
      const rule = ruleMap.get(item.source_rule);
      const result = decision.results.find((r) => r.rule_id === item.source_rule);
      const text = item.cure ? ensureSentence(humanize(item.cure)) : (rule && rule.no_cure) || 'Nothing on these facts.';
      const top = el('div', 'item-top');
      top.appendChild(el('span', 'badge badge-blocked', whatsWrongLabel(rule, result)));
      li.appendChild(top);
      li.appendChild(el('div', 'item-text', text));
      list.appendChild(li);
    }
    return;
  }

  heading.textContent = 'Next actions';
  const facts = decision.audit.facts;
  const shown = new Set();
  for (const item of decision.checklist) {
    const li = el('li', item.source_rule ? '' : 'item-final');
    const top = el('div', 'item-top');
    if (item.owner) top.appendChild(el('span', 'owner', item.owner));
    if (item.due) top.appendChild(el('span', 'due', 'Due ' + Dates.formatReadable(item.due)));
    if (top.childNodes.length) li.appendChild(top);
    li.appendChild(el('div', 'item-text', ensureSentence(queueWording(humanize(item.text)))));

    // One tap to log the evidence for this step. The same fact change can
    // answer two checklist items (Harbour's deemed consent and GP consent),
    // so each distinct change gets one button.
    const action = item.source_rule ? loggableAction(item.source_rule, facts) : null;
    const signature = action && JSON.stringify(action.override);
    const draft = item.source_rule ? draftFor(item.source_rule, facts) : null;
    if ((action && !shown.has(signature)) || draft) {
      const showAction = action && !shown.has(signature);
      if (showAction) shown.add(signature);
      const row = el('div', 'item-actions');
      if (showAction) {
        const btn = el('button', 'btn btn-secondary btn-sm', action.label);
        btn.type = 'button';
        btn.dataset.rule = item.source_rule;
        btn.addEventListener('click', () => runLoggedAction(action));
        row.appendChild(btn);
      }
      if (draft) {
        const draftBtn = el('button', 'btn btn-ghost btn-sm', draft.title);
        draftBtn.type = 'button';
        draftBtn.setAttribute('aria-expanded', 'false');
        draftBtn.addEventListener('click', () => {
          const expanded = draftBtn.getAttribute('aria-expanded') === 'true';
          draftBtn.setAttribute('aria-expanded', String(!expanded));
          toggleDraftPane(li, draft);
        });
        row.appendChild(draftBtn);
      }
      if (action) row.appendChild(el('span', 'item-hint', `Dated ${Dates.formatReadable(facts.as_of)}`));
      li.appendChild(row);
    }
    list.appendChild(li);
  }
}

// Signatures never appear for a blocked transfer: there is nothing to sign
// on a transfer that cannot proceed. They appear once the answer is at
// least "actions outstanding" (so evidence can be gathered in parallel with
// signing) and stay visible once ready to record.
function renderSignatures(id, decision, facts) {
  const section = document.getElementById('signatures-section');
  const empty = document.getElementById('signatures-empty');
  if (decision.verdict === 'BLOCKED') {
    section.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  section.hidden = false;
  if (empty) empty.hidden = true;
  const viewLink = document.getElementById('signatures-view-agreement');
  if (viewLink) viewLink.onclick = (e) => {
    e.preventDefault();
    navigate(`#/request/${id}/documents`);
  };
  const list = document.getElementById('signatures-list');
  list.innerHTML = '';
  for (const sig of signaturesFor(id, facts)) {
    const li = el('li', 'signature-row');
    li.appendChild(el('span', 'signature-name', sig.label));
    const stateLabel = sig.state === 'signed' ? 'Signed' : sig.state === 'sent' ? 'Sent' : 'Not sent';
    li.appendChild(el('span', `badge ${sig.state === 'signed' ? 'badge-ready' : sig.state === 'sent' ? 'badge-action' : 'badge-quiet'}`, stateLabel));
    const actions = el('span', 'signature-actions');
    if (sig.state === 'not_sent') {
      const btn = el('button', 'btn btn-ghost btn-sm', 'Log sent');
      btn.type = 'button';
      btn.addEventListener('click', () => setSignatureState(id, sig.key, 'sent', facts));
      actions.appendChild(btn);
    }
    if (sig.state !== 'signed') {
      const btn = el('button', 'btn btn-ghost btn-sm', 'Log signed');
      btn.type = 'button';
      btn.addEventListener('click', () => setSignatureState(id, sig.key, 'signed', facts));
      actions.appendChild(btn);
    }
    li.appendChild(actions);
    list.appendChild(li);
  }
}

// The register card only ever shows one action at a time: record, or the
// preview and export of what was just recorded. "Record in register" only
// ever appears once the answer is ready for the GP to record, per LPA 8.5.
function renderRegisterSection(id, decision, facts) {
  const section = document.getElementById('register-section');
  const status = statusOf(decision);
  const already = state.register[id];
  if (status.key !== 'ready' && !already) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const body = document.getElementById('register-body');
  body.innerHTML = '';

  if (!already) {
    body.appendChild(el('p', 'explainer', 'Every condition is evidenced. Recording in the Register is the General Partner’s act, not the tool’s: this button only logs it, once someone has decided to.'));
    const btn = el('button', 'btn btn-primary', 'Record in register');
    btn.type = 'button';
    btn.addEventListener('click', () => recordInRegister(id));
    body.appendChild(btn);
    return;
  }

  const preview = already.preview;
  body.appendChild(el('p', 'explainer', `Recorded ${Dates.formatReadable(already.at)}, effective ${Dates.formatReadable(preview.effectiveDate)} (LPA 8.5).`));
  const table = document.createElement('table');
  table.className = 'queue-table register-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th scope="col">Party</th><th scope="col">Role</th><th scope="col">Before</th><th scope="col">After</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of preview.rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', null, row.party));
    tr.appendChild(el('td', null, row.role));
    tr.appendChild(el('td', null, `US$${row.before.toLocaleString('en-US')}`));
    tr.appendChild(el('td', null, `US$${row.after.toLocaleString('en-US')}`));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);

  const exportRow = el('div', 'register-export');
  const jsonBtn = el('button', 'btn btn-secondary btn-sm', 'Export JSON');
  jsonBtn.type = 'button';
  jsonBtn.addEventListener('click', () => downloadFile(`${(QUEUE_META[id] || {}).ref || id}-transfer-record.json`, registerRecordAsJson(id, facts, preview), 'application/json'));
  const csvBtn = el('button', 'btn btn-secondary btn-sm', 'Export CSV');
  csvBtn.type = 'button';
  csvBtn.addEventListener('click', () => downloadFile(`${(QUEUE_META[id] || {}).ref || id}-transfer-record.csv`, registerRecordAsCsv(id, facts, preview), 'text/csv'));
  exportRow.appendChild(jsonBtn);
  exportRow.appendChild(csvBtn);
  body.appendChild(exportRow);
}

function renderActivity(id) {
  const list = document.getElementById('activity-list');
  list.innerHTML = '';
  const entries = state.activity[id] || [];
  if (!entries.length) {
    list.appendChild(el('li', 'activity-empty', 'Nothing logged in this session yet. Log a next action or change a fact and it appears here, with the answer before and after.'));
    return;
  }
  for (const entry of entries) {
    const li = el('li', null, ensureSentence(entry.text));
    li.appendChild(el('span', 'activity-meta', ensureSentence(entry.meta)));
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
  const stateBadge =
    result.state === 'FAILED' ? 'badge-blocked'
      : result.state === 'UNKNOWN' || result.state === 'CONTRADICTORY' ? 'badge-lawyer'
        : result.state === 'OUTSTANDING' ? 'badge-action'
          : result.state === 'SATISFIED' ? 'badge-ready' : 'badge-quiet';
  row.appendChild(el('span', `badge ${stateBadge}` + (nonMet ? ' nonmet' : ''), STATE_LABELS[result.state] || result.state));
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

// --- Keyboard shortcuts overlay -------------------------------------------

let shortcutsTrigger = null;

function openShortcuts(triggerEl) {
  shortcutsTrigger = triggerEl || document.activeElement;
  document.getElementById('shortcuts-overlay').hidden = false;
  document.getElementById('shortcuts-close').focus();
}

function closeShortcuts() {
  document.getElementById('shortcuts-overlay').hidden = true;
  if (shortcutsTrigger) shortcutsTrigger.focus();
  shortcutsTrigger = null;
}

function handleShortcutsKeydown(e) {
  if (e.key === 'Escape') {
    closeShortcuts();
    return;
  }
  if (e.key !== 'Tab') return;
  const dialog = document.getElementById('shortcuts-overlay');
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

// The queue's own j/k/Enter/,/Esc/? shortcuts. Only active on the queue
// view, and only when no overlay is open and the user isn't typing
// somewhere else, so a keystroke never fights with a form field.
function isTypingTarget(target) {
  return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

function anyOverlayOpen() {
  return !document.getElementById('shortcuts-overlay').hidden ||
    !document.getElementById('scenario-picker').hidden ||
    !document.getElementById('doc-viewer').hidden ||
    !document.getElementById('nav-drawer').hidden;
}

function handleQueueShortcuts(e) {
  if (state.route.view !== 'queue') return;
  if (anyOverlayOpen()) return;

  const typing = isTypingTarget(document.activeElement);
  const search = document.getElementById('queue-search');

  if (e.key === '/' && !typing) {
    e.preventDefault();
    search.focus();
    return;
  }
  if (e.key === 'Escape' && document.activeElement === search) {
    search.blur();
    return;
  }
  if (e.key === '?' && !typing) {
    e.preventDefault();
    openShortcuts();
    return;
  }
  if (typing || e.key !== 'j' && e.key !== 'k') return;

  const rows = Array.from(document.querySelectorAll('#queue-table-body tr.queue-row'));
  if (!rows.length) return;
  e.preventDefault();
  const idx = rows.indexOf(document.activeElement);
  if (e.key === 'j') rows[idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)].focus();
  else rows[idx < 0 ? 0 : Math.max(0, idx - 1)].focus();
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
  else if (action === 'new') startNewRequestWizard();
  else if (action === 'deadlines') navigate('#/deadlines');
  else if (action === 'scenarios') openPicker(triggerEl);
  else if (action === 'documents') openDocViewer('LPA', null);
  else if (action === 'assurance') navigate('#/assurance');
  else if (action === 'playbook') navigate('#/playbook');
  else if (action === 'chase') navigate('#/chase');
  else if (action === 'counsel') navigate('#/counsel');
}

// --- Document viewer (reads docs/source Markdown, tab per document) ------

function mdInline(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>');
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

function renderBreadcrumb(id) {
  const el2 = document.getElementById('breadcrumb');
  el2.innerHTML = '';
  const link = el('a', null, 'Requests');
  link.href = '#/';
  el2.appendChild(link);
  el2.appendChild(el('span', 'sep', '/'));
  const meta = QUEUE_META[id];
  el2.appendChild(el('span', 'current', meta ? meta.ref : id === 'NEW' ? 'New request' : id === 'TRY' ? 'Try to break it' : `Scenario ${id}`));
}

const STAGE_ORDER = ['intake', 'compliance', 'consents', 'kyc', 'signatures', 'completion', 'register'];
const STAGE_LABELS = {
  intake: 'Intake',
  compliance: 'Compliance review',
  consents: 'Consents and notices',
  kyc: 'KYC and documents',
  signatures: 'Signatures',
  completion: 'Completion',
  register: 'Register updated',
};

function renderRequestHead(facts) {
  const t = facts.transfer;
  document.getElementById('request-title').textContent = `${t.transferor} → ${t.transferee}`;
  const kind = t.kind === 'pledge' ? 'Pledge' : 'Sale';
  const stake = t.fraction >= 1 ? 'whole stake' : `${Math.round(t.fraction * 100)}% of the stake`;
  const amount = Math.round(t.transferor_capital_contribution * Math.min(t.fraction, 1)).toLocaleString('en-US');
  document.getElementById('request-meta').textContent =
    `${kind} of ${stake}, US$${amount} of Capital Contribution · completion ${Dates.formatReadable(t.proposed_completion)} · checked as of ${Dates.formatReadable(facts.as_of)}`;
}

// A compact horizontal tracker over the seven lifecycle stages. The current
// stage (and, for a blocked or lawyer-review request, the compliance review
// stage it is stuck at) is the only one marked; nothing here implies a
// stage was ever "completed" with its own timestamp, since the demo does
// not log stage transitions, only the facts and actions that a stage
// tracker reads.
// Deliberately does not repeat every stage's full name next to the request
// tabs below (Overview / Compliance / Documents / Signatures / Activity):
// two of the seven stage names read almost identically to two tab names
// ("Compliance review" vs "Compliance", "Signatures" vs "Signatures"), and
// showing both a lifecycle stage list and a tab bar spelling out the same
// words reads as two navigations for one idea. The tracker instead shows
// only the current stage's name as text ("Stage 3 of 7 · Consents and
// notices"); the other six segments stay unlabelled progress ticks, with
// each stage's full name kept as a title tooltip and in an aria-label for
// screen readers, so the sequence is still discoverable, just not spelled
// out in full next to a tab row that already uses adjacent words.
function renderStageTracker(id, decision, facts) {
  const container = document.getElementById('stage-tracker');
  if (!container) return;
  const meta = QUEUE_META[id];
  const stage = stageFor(id, decision, facts);
  const currentIndex = STAGE_ORDER.indexOf(stage.key);
  container.innerHTML = '';
  container.setAttribute('aria-label', `Lifecycle stage ${currentIndex + 1} of ${STAGE_ORDER.length}: ${stage.label}`);
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const key = STAGE_ORDER[i];
    const item = el('li', 'stage-step');
    item.title = STAGE_LABELS[key];
    if (i < currentIndex) item.classList.add('is-done');
    if (i === currentIndex) item.classList.add('is-current');
    item.appendChild(el('span', 'visually-hidden', STAGE_LABELS[key]));
    container.appendChild(item);
  }
  const days = meta ? daysOpen(meta.received, facts.as_of) : 0;
  document.getElementById('stage-tracker-meta').textContent = meta
    ? `Stage ${currentIndex + 1} of ${STAGE_ORDER.length} · ${stage.label} · ${days} day${days === 1 ? '' : 's'} since this request was received${pastServiceLevel({ dueDate: (nextActionOf(decision) || {}).due }, facts.as_of) ? ' · past service level' : ''}`
    : '';
}

function renderTopbarContext() {
  const el2 = document.getElementById('topbar-context');
  if (el2 && DATA.baseFacts) el2.textContent = `Northgate Helion SPV LP · as of ${Dates.formatReadable(DATA.baseFacts.as_of)}`;
}

function renderNavCurrent() {
  const route = state.route;
  const current =
    route.view === 'new'
      ? 'new'
      : route.view === 'deadlines'
        ? 'deadlines'
        : route.view === 'assurance'
          ? 'assurance'
          : route.view === 'playbook'
            ? 'playbook'
            : route.view === 'chase'
              ? 'chase'
              : route.view === 'counsel'
                ? 'counsel'
                : 'requests';
  for (const btn of document.querySelectorAll('[data-nav]')) {
    if (btn.dataset.nav === current) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
}

// The compact answer bar is pinned at the top of the request page below
// 900px, so the verdict is never off screen. Tapping it jumps to the full
// decision card.
let answerBarWired = false;

function wireAnswerBar() {
  if (answerBarWired) return;
  answerBarWired = true;
  document.getElementById('mobile-answer-bar').addEventListener('click', () => {
    document.getElementById('answer-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderSidebarCounts() {
  const count = String(QUEUE_ROWS.length);
  const sidebarCount = document.getElementById('sidebar-count');
  const drawerCount = document.getElementById('drawer-count');
  if (sidebarCount) sidebarCount.textContent = count;
  if (drawerCount) drawerCount.textContent = count;
}

// Links to this exact page, including the current route, so scanning the
// phone card from a request page opens that same request on the phone.
function phoneUrl() {
  return `https://imadmnaz.github.io/transfer-desk/${location.hash || ''}`;
}

function renderPhoneCard() {
  const container = document.getElementById('phone-qr');
  if (!container || typeof qrcode !== 'function') return;
  const url = phoneUrl();
  if (state.lastPhoneUrl === url) return;
  state.lastPhoneUrl = url;
  container.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
  } catch (e) {
    container.innerHTML = '';
  }
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

  renderBreadcrumb(id);
  renderRequestHead(facts);
  renderStageTracker(id, decision, facts);
  renderRequestTabs(id);
  renderDealForm(facts, decidingId, ruleMap);
  renderAnswer(decision, ruleMap, id);
  renderWhy(decision, decidingId, ruleMap);
  renderNext(decision, ruleMap, id);
  renderDocumentsPanel(id, decision, facts);
  renderSignatures(id, decision, facts);
  renderRegisterSection(id, decision, facts);
  renderActivity(id);
  renderAllRules(decision, ruleMap);
  renderAudit(decision);
}

// Real routable tabs: each has its own hash (#/request/id/tab) and its own
// panel. Only the active panel is visible; switching tabs never re-fetches
// or re-evaluates anything, it only changes which panel is shown and the
// URL, so the browser back button and a shared link both land on the same
// tab a reader was looking at.
function renderRequestTabs(id) {
  const nav = document.getElementById('request-tabs');
  nav.innerHTML = '';
  for (const tab of REQUEST_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `tab-btn-${tab.key}`;
    btn.className = 'request-tab';
    btn.setAttribute('role', 'tab');
    const selected = state.route.tab === tab.key;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
    btn.textContent = tab.label;
    btn.addEventListener('click', () => navigate(`#/request/${id}/${tab.key}`));
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = REQUEST_TABS.findIndex((t) => t.key === tab.key);
      const next = REQUEST_TABS[(i + (e.key === 'ArrowRight' ? 1 : REQUEST_TABS.length - 1)) % REQUEST_TABS.length];
      navigate(`#/request/${id}/${next.key}`);
      document.getElementById(`tab-btn-${next.key}`)?.focus();
    });
    nav.appendChild(btn);
  }
  for (const tab of REQUEST_TABS) {
    const panel = document.getElementById(`panel-${tab.key}`);
    if (panel) panel.hidden = state.route.tab !== tab.key;
  }
  const current = document.getElementById(`tab-btn-${state.route.tab}`);
  if (current && nav.scrollWidth > nav.clientWidth) {
    nav.scrollLeft = Math.max(0, current.offsetLeft - nav.offsetLeft - 16);
  }
}

function render() {
  state.route = parseHash();
  const view = state.route.view;
  const isRequest = view === 'request';
  const isNew = view === 'new';
  const isDeadlines = view === 'deadlines';
  const isAssurance = view === 'assurance';
  const isPlaybook = view === 'playbook';
  const isChase = view === 'chase';
  const isCounsel = view === 'counsel';
  const isQueue = view === 'queue';

  document.getElementById('view-queue').hidden = !isQueue;
  document.getElementById('view-new').hidden = !isNew;
  document.getElementById('view-deadlines').hidden = !isDeadlines;
  document.getElementById('view-assurance').hidden = !isAssurance;
  document.getElementById('view-playbook').hidden = !isPlaybook;
  document.getElementById('view-chase').hidden = !isChase;
  document.getElementById('view-counsel').hidden = !isCounsel;
  document.getElementById('view-request').hidden = !isRequest;
  document.getElementById('mobile-answer-bar').hidden = !isRequest;
  document.body.classList.toggle('view-request', isRequest);

  renderTopbarContext();
  renderSidebarCounts();
  renderNavCurrent();
  wireAnswerBar();
  renderPhoneCard();

  if (isRequest) renderRequestView();
  else if (isNew) renderWizard();
  else if (isDeadlines) renderDeadlines();
  else if (isAssurance) renderAssuranceView();
  else if (isPlaybook) renderPlaybookView();
  else if (isChase) renderChaseView();
  else if (isCounsel) renderCounselView();
  else renderQueue();
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
  const counts = { blocked: 0, lawyer: 0, actions: 0, ready: 0 };

  for (const c of generateSweepCases()) {
    const { decision, mustBlock, uncertain } = evaluateSweepCase(c);
    checked++;
    if (mustBlock && decision.verdict !== 'BLOCKED') mustBlockFailures++;
    if (uncertain && decision.verdict === 'CHECKLIST_READY') uncertainClearFailures++;
    counts[statusOf(decision).key]++;
    sinceYield++;
    if (sinceYield >= CHUNK) {
      sinceYield = 0;
      onProgress(checked);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress(checked);
  return { checked, mustBlockFailures, uncertainClearFailures, counts };
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
  const unsafeP = el('p', 'sweep-unsafe' + (unsafe > 0 ? ' unsafe-nonzero' : ''));
  const unsafeNum = el('span', null, '0');
  unsafeP.appendChild(unsafeNum);
  unsafeP.appendChild(document.createTextNode(' unsafe clears'));
  result.appendChild(unsafeP);
  animateCount(unsafeNum, unsafe);

  const checkedNum = el('span', null, '0');
  const subline = el('p', 'subline');
  subline.appendChild(checkedNum);
  subline.appendChild(
    document.createTextNode(` combinations checked. Scenarios: ${scenariosPassed}/${DATA.scenarios.length}. Held-out: ${heldoutPassed}/${DATA.heldout.length}.`)
  );
  result.appendChild(subline);
  animateCount(checkedNum, sweep.checked);

  const segments = [
    { key: 'blocked', label: 'Blocked', cls: 'sweep-seg-blocked' },
    { key: 'lawyer', label: 'Lawyer review', cls: 'sweep-seg-lawyer' },
    { key: 'actions', label: 'Actions outstanding', cls: 'sweep-seg-actions' },
    { key: 'ready', label: 'Ready to record', cls: 'sweep-seg-ready' },
  ];
  const bar = el('div', 'sweep-bar');
  for (const seg of segments) {
    const span = el('div', `sweep-seg ${seg.cls}`);
    span.style.width = `${(sweep.counts[seg.key] / sweep.checked) * 100}%`;
    bar.appendChild(span);
  }
  result.appendChild(bar);

  const legend = el('ul', 'sweep-legend');
  for (const seg of segments) {
    const li = el('li');
    li.appendChild(el('span', `sweep-legend-dot ${seg.cls}`));
    li.appendChild(document.createTextNode(`${seg.label}: ${sweep.counts[seg.key].toLocaleString('en-US')}`));
    legend.appendChild(li);
  }
  result.appendChild(legend);

  btn.disabled = false;
  btn.textContent = original;
}

// --- Assurance page ---------------------------------------------------

const VERDICT_LABEL = {
  BLOCKED: 'Blocked',
  ESCALATE: 'Lawyer review',
  CHECKLIST_READY: 'Checklist ready',
};

// One plain line per held-out case, drawn from its title and its working
// in heldout.json: what makes that case a trap rather than a routine one.
const HELD_OUT_TRAPS = {
  H01: 'Both notices were sent at exactly 17:00, the boundary instant for same day receipt.',
  H02: 'Sent on a day that is a listed holiday, so receipt must roll to the next Business Day.',
  H03: 'The beneficial owner count and both resulting holdings land exactly on their limits.',
  H04: "An Affiliate buyer is also an Affiliate of a listed Competitor, which no permitted transfer notice can cure.",
  H05: 'Deemed consent would arise on the same day as_of falls, testing the "after that date" boundary.',
  H06: "Completion falls one Business Day short of the Company's ten clear day minimum.",
  H07: "The right of first refusal's exercise period ends on as_of itself, testing whether it has actually expired.",
  H08: 'Completion lands on the very last Business Day the 45 day completion window allows.',
  H09: "Completion is proposed for the exercise period's own final day, before it has expired.",
  H10: "The GP's deemed consent under the side letter is tested against the Company's own, separate consent.",
};

function datesMatch(decision, expect, translateDateField) {
  const translate = translateDateField || ((f) => f);
  for (const [key, expectedDate] of Object.entries(expect.dates || {})) {
    const [ruleId, rawField] = key.split('.');
    const field = translate(rawField);
    const r = findResult(decision, ruleId);
    if (!r || !r.computed || !r.computed[field] || r.computed[field].date !== expectedDate) return false;
  }
  return true;
}

function renderAssuranceKnownAnswers() {
  const list = document.getElementById('assurance-known-list');
  list.innerHTML = '';
  let passed = 0;
  for (const s of DATA.scenarios) {
    const { decision } = decisionForCase(s);
    const pass = caseFailures(decision, s.expect).length === 0;
    if (pass) passed++;

    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'assurance-row';
    row.addEventListener('click', () => navigate(`#/request/${s.id}`));
    const top = el('div', 'assurance-row-top');
    top.appendChild(el('span', 'assurance-row-id', s.id));
    top.appendChild(el('span', 'assurance-row-name', s.display_name));
    top.appendChild(el('span', `badge ${pass ? 'badge-ready' : 'badge-blocked'}`, pass ? 'Pass' : 'Fail'));
    row.appendChild(top);
    row.appendChild(el('div', 'assurance-row-sub', `Expected ${VERDICT_LABEL[s.expect.verdict]} · result ${VERDICT_LABEL[decision.verdict]}`));
    li.appendChild(row);
    list.appendChild(li);
  }
  document.getElementById('assurance-known-result').textContent = `${passed}/${DATA.scenarios.length} known answer cases pass`;
}

function renderAssuranceHeldOut() {
  const list = document.getElementById('assurance-heldout-list');
  list.innerHTML = '';
  let passed = 0;
  const translate = (f) => HELD_OUT_DATE_FIELD_ALIASES[f] || f;
  for (const c of DATA.heldout) {
    const { decision } = decisionForCase(c);
    const pass = caseFailures(decision, c.expect, translate).length === 0;
    if (pass) passed++;
    const okDates = datesMatch(decision, c.expect, translate);

    const li = document.createElement('li');
    li.className = 'assurance-row';
    const top = el('div', 'assurance-row-top');
    top.appendChild(el('span', 'assurance-row-id', c.id));
    top.appendChild(el('span', 'assurance-row-name', c.title));
    top.appendChild(el('span', `badge ${pass ? 'badge-ready' : 'badge-blocked'}`, pass ? 'Pass' : 'Fail'));
    li.appendChild(top);
    li.appendChild(el('div', 'assurance-row-sub', HELD_OUT_TRAPS[c.id] || ''));
    li.appendChild(
      el(
        'div',
        'assurance-row-sub',
        `Expected ${VERDICT_LABEL[c.expect.verdict]} · actual ${VERDICT_LABEL[decision.verdict]} · dates ${okDates ? 'all matched' : 'did not all match'}`
      )
    );
    list.appendChild(li);
  }
  document.getElementById('assurance-heldout-result').textContent = `${passed}/${DATA.heldout.length} blind cases pass`;
}

// --- Try to break it -------------------------------------------------

// Reuses the sweep's own axes so the random deal is always built from the
// same facts the 486,000 combination stress test varies.
const BREAK_WEIGHTS = {
  relationship: {},
  competitor: { yes: 4, unknown: 4 },
  gpConsent: { refused: 3, unknown: 3, contradictory: 3, requested_complete_unknown: 3 },
  companyConsent: { refused: 3, unknown: 3, contradictory: 3 },
  rofrNotice: { sent_no_proof: 3, delivered_complete_unknown: 3, delivered_complete_no: 3 },
  rofrResponse: { exercised_whole: 3, exercised_partial: 3, unknown: 3 },
  sanctions: { hit: 3, unknown: 3 },
  kyc: { unknown: 3 },
  boLimit: { null: 2 },
  version: { no: 3 },
};

const RELATIONSHIP_TEXT = {
  unrelated: 'Buyer is unrelated to the seller',
  affiliate: "Buyer is the seller's affiliate",
  harbour_transferee: 'Buyer is a fund managed by Harbour, under the side letter',
};
const COMPETITOR_TEXT = {
  no: 'Buyer is not a Competitor',
  yes: 'Buyer is a Competitor',
  unknown: 'Whether the buyer is a Competitor is not known',
};
const GP_CONSENT_TEXT = {
  received: 'GP consent given in writing',
  refused: 'GP consent refused',
  unknown: 'GP consent status unclear',
  contradictory: 'GP consent evidence conflicts',
  not_requested: 'GP consent not yet requested',
  requested_complete_unknown: 'GP consent requested, but completeness of the request is not known',
};
const COMPANY_CONSENT_TEXT = {
  received: "Helion's consent given in writing",
  refused: "Helion's consent refused",
  unknown: "Helion's consent status unclear",
  contradictory: "Helion's consent evidence conflicts",
  not_requested: "Helion's consent not yet requested",
};
const ROFR_NOTICE_TEXT = {
  delivered_complete_yes: 'Transfer Notice delivered, with proof',
  not_sent: 'Transfer Notice not sent',
  sent_no_proof: 'Transfer Notice sent, no proof of delivery',
  delivered_complete_unknown: 'Transfer Notice delivered, but its completeness is not known',
  delivered_complete_no: 'Transfer Notice delivered, but it was incomplete',
};
const ROFR_RESPONSE_TEXT = {
  waived: 'Helion has waived its right of first refusal',
  none: 'Helion has not responded to the right of first refusal',
  exercised_whole: 'Helion has exercised its right of first refusal in whole',
  exercised_partial: 'Helion has purported to exercise its right of first refusal in part',
  unknown: "Helion's response to the right of first refusal is not known",
};
const SANCTIONS_TEXT = {
  clear: 'Sanctions screening clear',
  hit: 'Sanctions screening returned a hit',
  unknown: 'Sanctions screening status not known',
  pending: 'Sanctions screening still pending',
};
const KYC_TEXT = {
  cleared: 'KYC and AML checks cleared',
  unknown: 'KYC status not known',
  pending: 'KYC still pending',
};
const BO_TEXT = {
  80: '80 beneficial owners before the sale',
  95: '95 beneficial owners before the sale',
  null: 'Beneficial owner count not known',
};
const VERSION_TEXT = {
  yes: 'Documents version confirmed',
  no: 'Documents version not confirmed',
};

function pickWeighted(list, weights) {
  const w = list.map((item) => (weights && weights[item.key] != null ? weights[item.key] : 1));
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    if (r < w[i]) return list[i];
    r -= w[i];
  }
  return list[list.length - 1];
}

function generateBreakCase() {
  const picks = {
    relationship: pickWeighted(SWEEP_RELATIONSHIP, BREAK_WEIGHTS.relationship),
    competitor: pickWeighted(SWEEP_COMPETITOR, BREAK_WEIGHTS.competitor),
    gpConsent: pickWeighted(SWEEP_GP_CONSENT, BREAK_WEIGHTS.gpConsent),
    companyConsent: pickWeighted(SWEEP_COMPANY_CONSENT, BREAK_WEIGHTS.companyConsent),
    rofrNotice: pickWeighted(SWEEP_ROFR_NOTICE, BREAK_WEIGHTS.rofrNotice),
    rofrResponse: pickWeighted(SWEEP_ROFR_RESPONSE, BREAK_WEIGHTS.rofrResponse),
    sanctions: pickWeighted(SWEEP_SANCTIONS, BREAK_WEIGHTS.sanctions),
    kyc: pickWeighted(SWEEP_KYC, BREAK_WEIGHTS.kyc),
    boLimit: pickWeighted(SWEEP_BO_LIMIT, BREAK_WEIGHTS.boLimit),
    version: pickWeighted(SWEEP_VERSION, BREAK_WEIGHTS.version),
  };
  let overrides = {};
  for (const pick of Object.values(picks)) overrides = Engine.deepMergeFacts(overrides, pick.overrides);
  const facts = Engine.deepMergeFacts(DATA.baseFacts, overrides);
  const decision = Engine.evaluate(facts, DATA.rulebook, DATA.calendar);
  return { picks, overrides, facts, decision };
}

function breakFactLines(picks) {
  return [
    RELATIONSHIP_TEXT[picks.relationship.key],
    COMPETITOR_TEXT[picks.competitor.key],
    GP_CONSENT_TEXT[picks.gpConsent.key],
    COMPANY_CONSENT_TEXT[picks.companyConsent.key],
    ROFR_NOTICE_TEXT[picks.rofrNotice.key],
    ROFR_RESPONSE_TEXT[picks.rofrResponse.key],
    SANCTIONS_TEXT[picks.sanctions.key],
    KYC_TEXT[picks.kyc.key],
    BO_TEXT[picks.boLimit.key],
    VERSION_TEXT[picks.version.key],
  ];
}

// Why the answer is safe even though the deal is deliberately awkward: a
// short line naming the one fact a lawyer, or a cure, must resolve.
function safetyExplanation(decision, ruleMap) {
  if (decision.verdict === 'BLOCKED') {
    const r = decision.results.find((x) => x.state === 'FAILED');
    const rule = r ? ruleMap.get(r.rule_id) : null;
    return `${ensureSentence(whatsWrongLabel(rule, r))} A blocked transfer is never recorded.`;
  }
  if (decision.verdict === 'ESCALATE') {
    const r = decision.results.find((x) => x.state === 'UNKNOWN' || x.state === 'CONTRADICTORY');
    const line = r ? firstSentence(queueWording(r.reason)) : 'Evidence is missing, unclear or conflicting.';
    return `${ensureSentence(line)} A lawyer must decide before anything moves.`;
  }
  return 'Every known condition is satisfied or has a clear next step. A ready checklist is not an approval; recording stays a human act.';
}

function renderBreakResult(breakCase) {
  const container = document.getElementById('break-result');
  container.innerHTML = '';
  if (!breakCase) return;
  const { picks, decision } = breakCase;
  const status = statusOf(decision);
  const ruleMap = new Map(DATA.rulebook.rules.map((r) => [r.id, r]));

  const factsList = el('ul', 'break-facts');
  for (const line of breakFactLines(picks)) factsList.appendChild(el('li', null, line));
  container.appendChild(factsList);

  container.appendChild(el('span', `badge badge-lg ${status.badge}`, status.long));
  container.appendChild(el('p', 'break-headline', ensureSentence(queueWording(humanize(decision.headline)))));
  container.appendChild(el('p', 'break-safety', safetyExplanation(decision, ruleMap)));

  const actions = el('div', 'break-actions');
  const openBtn = el('button', 'btn btn-secondary btn-sm', 'Open this as a request');
  openBtn.type = 'button';
  openBtn.addEventListener('click', () => {
    state.requestOverrides.TRY = breakCase.overrides;
    navigate('#/request/TRY');
  });
  const againBtn = el('button', 'btn btn-ghost btn-sm', 'Try another');
  againBtn.type = 'button';
  againBtn.addEventListener('click', () => {
    state.assuranceBreak = generateBreakCase();
    renderBreakResult(state.assuranceBreak);
  });
  actions.appendChild(openBtn);
  actions.appendChild(againBtn);
  container.appendChild(actions);
}

// --- Playbook -------------------------------------------------------------
//
// Renders the rulebook itself as a set of readable positions, grouped by
// document, the way a law firm's own transfer playbook reads: the
// provision, the clause it comes from, what the tool checks, what it does
// with each outcome, and the scenarios that prove it. All text comes from
// rulebook.json and clauses.json; nothing here is invented copy.

// Returns '' when the rule's own description already states its effect on
// the verdict (or lack of one), so the outcome line is never a near-repeat
// of the sentence just read above it.
function playbookOutcomeText(rule) {
  const keys = Object.keys(rule.findings || {});
  const blocks = keys.some((k) => k.startsWith('FAILED'));
  const escalates = keys.some((k) => k.startsWith('UNKNOWN') || k.startsWith('CONTRADICTORY')) || rule.id === 'X-VERSION';
  const acts = keys.some((k) => k.startsWith('OUTSTANDING'));
  const parts = [];
  if (blocks) parts.push('blocks the transfer');
  if (escalates) parts.push('sends it to a lawyer');
  if (acts) parts.push('creates a checklist action');
  if (parts.length === 0) return /verdict/i.test(rule.description) ? '' : 'Never changes the verdict on its own.';
  const last = parts.pop();
  return `When this condition is not met, it ${parts.length ? parts.join(', ') + ' or ' : ''}${last}, depending on the evidence.`;
}

function scenariosTestingRule(ruleId) {
  return DATA.scenarios.filter((s) => s.expect && s.expect.rule_states && Object.prototype.hasOwnProperty.call(s.expect.rule_states, ruleId));
}

function renderPlaybookView() {
  const gateLabel = Object.fromEntries(DATA.rulebook.gates.map((g) => [g.id, g.label]));
  document.getElementById('playbook-summary').textContent =
    `${DATA.rulebook.rules.length} rules across ${DATA.rulebook.gates.length} gates · ${DATA.rulebook.rulebook_version}`;

  const body = document.getElementById('playbook-body');
  body.innerHTML = '';

  for (const gate of DATA.rulebook.gates) {
    const rules = DATA.rulebook.rules.filter((r) => r.gate === gate.id);
    if (rules.length === 0) continue;

    const section = el('section', 'playbook-gate');
    section.appendChild(el('h2', 'section-title playbook-gate-title', gateLabel[gate.id] || gate.id));

    for (const rule of rules) {
      const card = el('div', 'playbook-rule');
      const main = el('div', 'playbook-rule-main');
      const head = el('div', 'playbook-rule-head');
      head.appendChild(el('h3', 'playbook-rule-title', rule.title));
      head.appendChild(el('span', 'playbook-rule-id', rule.id));
      main.appendChild(head);

      if (rule.citations && rule.citations.length) {
        const cites = el('div', 'playbook-citations');
        for (const c of rule.citations) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'playbook-citation';
          btn.textContent = formatCitation(c);
          btn.addEventListener('click', () => openDocViewer(c.doc, c.section));
          cites.appendChild(btn);
        }
        main.appendChild(cites);
      }

      main.appendChild(el('p', 'playbook-rule-description', rule.description));
      const outcomeText = playbookOutcomeText(rule);
      if (outcomeText) main.appendChild(el('p', 'playbook-rule-outcome', outcomeText));
      card.appendChild(main);

      // The right column: the clause text itself, so the position and its
      // source sit side by side, and the scenarios that prove it, so the
      // page uses the width a 1120px container gives it rather than
      // leaving it empty next to a 640px column of prose.
      const side = el('div', 'playbook-rule-side');
      const topCitation = rule.citations && rule.citations[0];
      const clause = topCitation && lookupClause(topCitation);
      if (clause) {
        const clauseBox = el('div', 'playbook-clause');
        clauseBox.appendChild(el('div', 'playbook-clause-source', `${clause.docTitle.split(' - ')[0]} · ${formatCitation(topCitation)} · p. ${clause.page}`));
        clauseBox.appendChild(el('blockquote', null, clause.text));
        side.appendChild(clauseBox);
      }
      const tested = scenariosTestingRule(rule.id);
      const testedLine = el('p', 'playbook-rule-scenarios');
      if (tested.length) {
        testedLine.textContent = `Tested by: ${tested.map((s) => `${s.id} (${s.display_name || s.title})`).join(', ')}`;
      } else {
        testedLine.textContent = 'Covered indirectly by the known answer suite.';
      }
      side.appendChild(testedLine);
      card.appendChild(side);

      section.appendChild(card);
    }
    body.appendChild(section);
  }
}

function renderAssuranceView() {
  renderAssuranceKnownAnswers();
  renderAssuranceHeldOut();
  renderBreakResult(state.assuranceBreak);
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

  wireDisclosure('audit-toggle', 'audit-json');
  wireDisclosure('all-rules-toggle', 'all-rules-body');
  wireDisclosure('assurance-known-toggle', 'assurance-known-body');
  wireDisclosure('assurance-heldout-toggle', 'assurance-heldout-body');

  document.getElementById('run-sweep').addEventListener('click', runSweepAndReport);
  document.getElementById('try-break-btn').addEventListener('click', () => {
    state.assuranceBreak = generateBreakCase();
    renderBreakResult(state.assuranceBreak);
  });

  document.getElementById('new-request-btn').addEventListener('click', startNewRequestWizard);
  document.getElementById('open-scenarios-btn').addEventListener('click', (e) => openPicker(e.currentTarget));
  document.getElementById('picker-close').addEventListener('click', closePicker);
  document.getElementById('scenario-search').addEventListener('input', (e) => renderScenarioList(e.target.value));
  document.getElementById('scenario-picker').addEventListener('keydown', handlePickerKeydown);

  document.getElementById('shortcuts-btn').addEventListener('click', (e) => openShortcuts(e.currentTarget));
  document.getElementById('shortcuts-close').addEventListener('click', closeShortcuts);
  document.getElementById('shortcuts-overlay').addEventListener('keydown', handleShortcutsKeydown);
  document.addEventListener('keydown', handleQueueShortcuts);

  document.getElementById('queue-search').addEventListener('input', (e) => {
    state.queueQuery = e.target.value;
    renderQueue();
  });
  document.getElementById('toast-undo').addEventListener('click', undoLast);

  window.addEventListener('hashchange', () => {
    hideToast();
    state.undo = null;
    render();
    window.scrollTo(0, 0);
  });
}

async function init() {
  initTheme();
  wireEvents();
  await loadData();
  render();
}

init();
