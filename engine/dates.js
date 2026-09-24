'use strict';

// Business-day and notice-receipt helpers. Pure functions only: no Date.now(),
// no host timezone dependency (all arithmetic is done in UTC against the
// calendar's own date strings, treating every timestamp as New York local time
// per CLAUDE.md section 4).

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDateParts(dateStr) {
  const datePart = dateStr.split('T')[0];
  const [y, m, d] = datePart.split('-').map(Number);
  return { y, m, d };
}

function toUTC(dateStr) {
  const { y, m, d } = parseDateParts(dateStr);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISO(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addCalendarDays(dateStr, n) {
  const dt = toUTC(dateStr);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toISO(dt);
}

function isWeekend(dateStr) {
  const day = toUTC(dateStr).getUTCDay();
  return day === 0 || day === 6;
}

function isHoliday(dateStr, calendar) {
  return calendar.holidays.includes(dateStr);
}

function isBusinessDay(dateStr, calendar) {
  return !isWeekend(dateStr) && !isHoliday(dateStr, calendar);
}

function formatReadable(dateStr) {
  const dt = toUTC(dateStr);
  const weekday = WEEKDAY_NAMES[dt.getUTCDay()];
  const day = dt.getUTCDate();
  const month = MONTH_NAMES[dt.getUTCMonth()];
  const year = dt.getUTCFullYear();
  return `${weekday} ${day} ${month} ${year}`;
}

function nextBusinessDay(dateStr, calendar) {
  let d = addCalendarDays(dateStr, 1);
  while (!isBusinessDay(d, calendar)) {
    d = addCalendarDays(d, 1);
  }
  return d;
}

// The date that is the nth Business Day strictly after dateStr (n >= 1),
// plus any holidays skipped along the way (for the working string).
function addBusinessDays(dateStr, n, calendar) {
  let d = dateStr;
  let count = 0;
  const skippedHolidays = [];
  while (count < n) {
    d = addCalendarDays(d, 1);
    if (isBusinessDay(d, calendar)) {
      count++;
    } else if (isHoliday(d, calendar)) {
      skippedHolidays.push(d);
    }
  }
  return { date: d, skippedHolidays };
}

// LPA 14.2 / SA 9.1 / SL para 2: received on the day sent if sent before
// 17:00 New York time on a Business Day, otherwise on the next Business Day.
function receivedDate(sentAtStr, calendar) {
  const [datePart, timePart] = sentAtStr.split('T');
  const [hh, mm] = (timePart || '00:00').split(':').map(Number);
  const isBefore5pm = hh < 17 || (hh === 17 && false);
  void mm;
  const sentOnBusinessDay = isBusinessDay(datePart, calendar);

  let date;
  let onTime;
  if (sentOnBusinessDay && isBefore5pm) {
    date = datePart;
    onTime = true;
  } else {
    date = nextBusinessDay(datePart, calendar);
    onTime = false;
  }

  let why;
  if (!sentOnBusinessDay) {
    why = `sent on ${formatReadable(datePart)}, not a Business Day`;
  } else if (!isBefore5pm) {
    why = `sent on ${formatReadable(datePart)} at or after 5:00 p.m. New York time`;
  } else {
    why = `sent on ${formatReadable(datePart)} before 5:00 p.m. New York time, a Business Day`;
  }
  const working = onTime
    ? `Received same day (${formatReadable(date)}): ${why}.`
    : `Received next Business Day (${formatReadable(date)}): ${why}.`;

  return { date, working, onTime };
}

// Fail-safe guards for facts the UI (or a scenario override) can leave
// missing or malformed: a status of "delivered" with no `sent_at`, a
// "waived" response with no `at`, etc. Every date parse in engine.js checks
// one of these first instead of handing a bad string to toUTC(), which
// would throw on split()/undefined rather than escalating like CLAUDE.md's
// fail-safe principle requires.
function isValidDateOnly(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidTimestamp(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);
}

function compareDates(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Builds a short plain-English working string for a Business-Day computation,
// e.g. "20 Business Days from receipt on Fri 25 Sep 2026; skips Mon 12 Oct 2026 holiday".
function businessDaysWorking(fromDate, n, result, label) {
  const skipped = result.skippedHolidays.length
    ? `; skips ${result.skippedHolidays.map((h) => formatReadable(h)).join(', ')} holiday${result.skippedHolidays.length > 1 ? 's' : ''}`
    : '';
  return `${n} Business Day${n === 1 ? '' : 's'} ${label} on ${formatReadable(fromDate)}${skipped}`;
}

const DatesModule = {
  isBusinessDay,
  isWeekend,
  isHoliday,
  addCalendarDays,
  nextBusinessDay,
  addBusinessDays,
  receivedDate,
  compareDates,
  formatReadable,
  businessDaysWorking,
  isValidDateOnly,
  isValidTimestamp,
};

// Browser wrapper: plumbing only, the functions above are untouched. Node
// (the test runner) gets module.exports as before; a plain <script> tag in
// the browser gets the same object on window, so app.js and engine.test.js
// call the exact same functions.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DatesModule;
}
if (typeof window !== 'undefined') {
  window.TransferDeskDates = DatesModule;
}
