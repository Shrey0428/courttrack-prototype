const fs = require('fs');
const path = require('path');
const { formatReminderEmails, parseReminderEmails } = require('./reminderEmails');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'db.json');

const initialDb = {
  trackedCases: [],
  snapshots: [],
  events: [],
  scrapeRuns: [],
  reminderDeliveries: [],
  users: []
};

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDb, null, 2));
  }
}

function readDb() {
  ensureDb();
  return normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function id(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDb(db) {
  const nextDb = {
    ...initialDb,
    ...db
  };

  nextDb.trackedCases = Array.isArray(nextDb.trackedCases)
    ? nextDb.trackedCases.map((trackedCase) => ({
        reminderEmails: [],
        reminderEmail: '',
        reminderEnabled: false,
        reminderDaysBefore: [3, 2, 1, 0],
        reminderSkipDisposed: true,
        latestOrdersUrl: '',
        latestJudgmentsUrl: '',
        latestCaseHistoryUrl: '',
        latestFilingsUrl: '',
        latestListingsUrl: '',
        latestCaseHistory: { filings: [], listings: [], hearings: [], orders: [], rawTables: [] },
        latestOrderUrl: '',
        latestOrderDate: '',
        latestNextHearingDateSource: '',
        latestStatusPageNextHearingDate: '',
        manualCaseTitle: '',
        ...trackedCase,
        reminderEmails: (() => {
          const parsed = parseReminderEmails(trackedCase.reminderEmails || trackedCase.reminderEmail || '');
          return parsed.emails;
        })(),
        reminderDaysBefore: normalizeReminderDaysBefore(trackedCase.reminderDaysBefore),
        reminderSkipDisposed: trackedCase.reminderSkipDisposed !== false,
        latestCaseHistory: normalizeCaseHistory(trackedCase.latestCaseHistory)
      }))
    : [];

  nextDb.snapshots = Array.isArray(nextDb.snapshots)
    ? nextDb.snapshots.map((snapshot) => ({
        ...snapshot,
        payload: normalizeSnapshotPayload(snapshot.payload)
      }))
    : [];
  nextDb.events = Array.isArray(nextDb.events) ? nextDb.events : [];
  nextDb.scrapeRuns = Array.isArray(nextDb.scrapeRuns) ? nextDb.scrapeRuns : [];
  nextDb.reminderDeliveries = Array.isArray(nextDb.reminderDeliveries) ? nextDb.reminderDeliveries : [];
  nextDb.users = Array.isArray(nextDb.users) ? nextDb.users : [];

  for (const trackedCase of nextDb.trackedCases) {
    trackedCase.reminderEmail = trackedCase.reminderEmails[0] || '';
    trackedCase.reminderEmailsLabel = formatReminderEmails(trackedCase.reminderEmails);

    const latestSnapshot = nextDb.snapshots
      .filter((snapshot) => snapshot.trackedCaseId === trackedCase.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (!latestSnapshot?.payload) continue;

    trackedCase.latestOrdersUrl = trackedCase.latestOrdersUrl || latestSnapshot.payload.ordersUrl || '';
    trackedCase.latestJudgmentsUrl = trackedCase.latestJudgmentsUrl || latestSnapshot.payload.judgmentsUrl || '';
    trackedCase.latestCaseHistoryUrl = trackedCase.latestCaseHistoryUrl || latestSnapshot.payload.caseHistoryUrl || '';
    trackedCase.latestFilingsUrl = trackedCase.latestFilingsUrl || latestSnapshot.payload.filingsUrl || '';
    trackedCase.latestListingsUrl = trackedCase.latestListingsUrl || latestSnapshot.payload.listingsUrl || '';
    trackedCase.latestCaseHistory = hasCaseHistory(trackedCase.latestCaseHistory) ? trackedCase.latestCaseHistory : normalizeCaseHistory(latestSnapshot.payload.caseHistory);
    trackedCase.latestOrderUrl = trackedCase.latestOrderUrl || latestSnapshot.payload.latestOrderUrl || '';
    trackedCase.latestOrderDate = trackedCase.latestOrderDate || latestSnapshot.payload.latestOrderDate || '';
    const historySummary = deriveHistorySummary(latestSnapshot.payload.caseHistory);
    trackedCase.latestCaseNumber = historySummary.caseNumber || trackedCase.latestCaseNumber || latestSnapshot.payload.caseNumber || '';
    trackedCase.latestCourtNumber = historySummary.courtNumber || trackedCase.latestCourtNumber || latestSnapshot.payload.courtNumber || '';
    trackedCase.latestStatus = historySummary.caseStatus || trackedCase.latestStatus || latestSnapshot.payload.caseStatus || '';
    trackedCase.latestNextHearingDate = historySummary.nextHearingDate || trackedCase.latestNextHearingDate || latestSnapshot.payload.nextHearingDate || '';
    trackedCase.latestNextHearingDateSource = historySummary.nextHearingDate
      ? (latestSnapshot.payload.nextHearingDateSource || 'district_case_number')
      : (trackedCase.latestNextHearingDateSource || latestSnapshot.payload.nextHearingDateSource || '');
    trackedCase.latestStatusPageNextHearingDate = trackedCase.latestStatusPageNextHearingDate || latestSnapshot.payload.statusPageNextHearingDate || '';
  }

  return nextDb;
}

function normalizeReminderDaysBefore(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? '3,2,1,0').split(/[\s,;]+/g);
  const unique = [];
  const seen = new Set();
  for (const raw of values) {
    const day = Number(raw);
    if (!Number.isInteger(day) || day < 0 || day > 30 || seen.has(day)) continue;
    seen.add(day);
    unique.push(day);
  }
  return unique.length ? unique.sort((a, b) => b - a) : [3, 2, 1, 0];
}

function normalizeCaseHistory(value) {
  return {
    filings: Array.isArray(value?.filings) ? value.filings : [],
    listings: Array.isArray(value?.listings) ? value.listings : [],
    hearings: Array.isArray(value?.hearings) ? value.hearings : [],
    orders: Array.isArray(value?.orders) ? value.orders : [],
    rawTables: Array.isArray(value?.rawTables) ? value.rawTables : []
  };
}

function hasCaseHistory(value) {
  return Boolean(value && (value.filings?.length || value.listings?.length || value.hearings?.length || value.orders?.length || value.rawTables?.length));
}

function deriveHistorySummary(caseHistory) {
  return {
    nextHearingDate: normalizeDate(pickHistoryField(caseHistory, ['Next Hearing Date', 'Next Date', 'Next Listing Date'])),
    caseStatus: pickHistoryField(caseHistory, ['Case Status', 'Status', 'Stage of Case', 'Case Stage']),
    caseNumber: pickHistoryField(caseHistory, ['Registration Number', 'Case Number']),
    courtNumber: pickHistoryField(caseHistory, ['Court Number and Judge', 'Court Number', 'Judge'])
  };
}

function pickHistoryField(caseHistory, names) {
  const wanted = names.map((name) => normalizeLabel(name).toLowerCase());
  for (const table of Array.isArray(caseHistory?.rawTables) ? caseHistory.rawTables : []) {
    for (const row of Array.isArray(table.rows) ? table.rows : []) {
      for (const cell of Array.isArray(row.cells) ? row.cells : []) {
        const label = normalizeLabel(cell.label).toLowerCase();
        const text = String(cell.text || '').trim();
        if (!label || !text) continue;
        if (wanted.includes(label)) return text;
      }
    }
  }
  return '';
}

function normalizeLabel(value) {
  return String(value || '').replace(/[:：]+$/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  const numericMatch = String(value || '').match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (numericMatch) {
    return [numericMatch[1].padStart(2, '0'), numericMatch[2].padStart(2, '0'), numericMatch[3]].join('-');
  }

  const cleaned = String(value || '')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .replace(/,/g, ' ');
  const namedMatch = cleaned.match(/\b(\d{1,2})[-/.\s]+([A-Za-z]{3,9})[-/.\s]+(\d{4})\b/);
  if (!namedMatch) return '';

  const months = {
    jan: '01',
    january: '01',
    feb: '02',
    february: '02',
    mar: '03',
    march: '03',
    apr: '04',
    april: '04',
    may: '05',
    jun: '06',
    june: '06',
    jul: '07',
    july: '07',
    aug: '08',
    august: '08',
    sep: '09',
    sept: '09',
    september: '09',
    oct: '10',
    october: '10',
    nov: '11',
    november: '11',
    dec: '12',
    december: '12'
  };
  const month = months[String(namedMatch[2] || '').trim().toLowerCase()];
  if (!month) return '';
  return [namedMatch[1].padStart(2, '0'), month, namedMatch[3]].join('-');
}

module.exports = { readDb, writeDb, id, DB_PATH };

function normalizeSnapshotPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const nextPayload = {
    ...payload,
    caseHistory: normalizeCaseHistory(payload.caseHistory)
  };
  const historySummary = deriveHistorySummary(nextPayload.caseHistory);

  if (!historySummary.nextHearingDate && !historySummary.caseStatus && !historySummary.caseNumber && !historySummary.courtNumber) {
    return nextPayload;
  }

  nextPayload.caseNumber = historySummary.caseNumber || nextPayload.caseNumber || '';
  nextPayload.nextHearingDate = historySummary.nextHearingDate || nextPayload.nextHearingDate || '';
  nextPayload.caseStatus = historySummary.caseStatus || nextPayload.caseStatus || '';
  nextPayload.courtNumber = historySummary.courtNumber || nextPayload.courtNumber || '';
  nextPayload.nextHearingDateSource = historySummary.nextHearingDate
    ? (nextPayload.nextHearingDateSource || 'district_case_number')
    : (nextPayload.nextHearingDateSource || '');
  nextPayload.statusPageNextHearingDate = nextPayload.statusPageNextHearingDate || nextPayload.nextHearingDate || '';

  return nextPayload;
}
