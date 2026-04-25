const fs = require('fs');
const path = require('path');
const { formatReminderEmails, parseReminderEmails } = require('./reminderEmails');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_REMINDER_DAYS = [3, 2, 1, 0];
const DEFAULT_REMINDER_EMAIL = process.env.DEFAULT_REMINDER_EMAIL || 'info@amitguptaadvocate.com';

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

  nextDb.snapshots = Array.isArray(nextDb.snapshots)
    ? nextDb.snapshots.map((snapshot) => normalizeSnapshot(snapshot))
    : [];
  nextDb.events = Array.isArray(nextDb.events) ? nextDb.events : [];
  nextDb.scrapeRuns = Array.isArray(nextDb.scrapeRuns) ? nextDb.scrapeRuns : [];
  nextDb.reminderDeliveries = Array.isArray(nextDb.reminderDeliveries) ? nextDb.reminderDeliveries : [];
  nextDb.users = Array.isArray(nextDb.users) ? nextDb.users : [];

  const latestSnapshotByCaseId = new Map();
  for (const snapshot of nextDb.snapshots) {
    const previous = latestSnapshotByCaseId.get(snapshot.trackedCaseId);
    if (!previous || String(snapshot.createdAt || '') > String(previous.createdAt || '')) {
      latestSnapshotByCaseId.set(snapshot.trackedCaseId, snapshot);
    }
  }

  nextDb.trackedCases = Array.isArray(nextDb.trackedCases)
    ? nextDb.trackedCases.map((trackedCase) => normalizeTrackedCase(trackedCase, latestSnapshotByCaseId.get(trackedCase.id)?.payload))
    : [];

  return nextDb;
}

function normalizeSnapshot(snapshot) {
  return {
    ...snapshot,
    payload: normalizeSnapshotPayload(snapshot?.payload || {})
  };
}

function normalizeTrackedCase(trackedCase, latestPayload) {
  const payload = normalizeSnapshotPayload(latestPayload || {});
  const storedReminderEmails = parseReminderEmails(trackedCase.reminderEmails || trackedCase.reminderEmail || '').emails;
  const reminderEmails = storedReminderEmails.length
    ? storedReminderEmails
    : parseReminderEmails(DEFAULT_REMINDER_EMAIL).emails;
  const latestCaseHistory = normalizeCaseHistory(trackedCase.latestCaseHistory || payload.caseHistory);
  const latestOrder = pickLatestOrder(latestCaseHistory.orders);
  const normalized = {
    reminderEmails: [],
    reminderEmail: '',
    reminderEnabled: false,
    reminderDaysBefore: DEFAULT_REMINDER_DAYS,
    reminderSkipDisposed: true,
    latestOrdersUrl: '',
    latestJudgmentsUrl: '',
    latestCaseHistoryUrl: '',
    latestFilingsUrl: '',
    latestListingsUrl: '',
    latestCaseHistory: emptyCaseHistory(),
    latestOrderUrl: '',
    latestOrderDate: '',
    latestNextHearingDateSource: '',
    latestStatusPageNextHearingDate: '',
    latestPossibleHearingDates: [],
    manualCaseTitle: '',
    latestCaseTitle: '',
    latestCourtName: '',
    latestCaseNumber: '',
    latestNextHearingDate: '',
    latestCourtNumber: '',
    latestStatus: '',
    officialSourceUrl: '',
    ...trackedCase,
    reminderEmails,
    reminderEnabled: storedReminderEmails.length
      ? trackedCase.reminderEnabled !== false && reminderEmails.length > 0
      : reminderEmails.length > 0,
    reminderDaysBefore: normalizeReminderDaysBefore(trackedCase.reminderDaysBefore),
    reminderSkipDisposed: trackedCase.reminderSkipDisposed !== false,
    latestCaseHistory,
    latestPossibleHearingDates: []
  };

  normalized.reminderEmail = reminderEmails[0] || '';
  normalized.reminderEmailsLabel = formatReminderEmails(reminderEmails);
  normalized.latestOrdersUrl = normalized.latestOrdersUrl || payload.ordersUrl || latestOrder.url || '';
  normalized.latestJudgmentsUrl = normalized.latestJudgmentsUrl || payload.judgmentsUrl || '';
  normalized.latestCaseHistoryUrl = normalized.latestCaseHistoryUrl || payload.caseHistoryUrl || '';
  normalized.latestFilingsUrl = normalized.latestFilingsUrl || payload.filingsUrl || normalized.latestCaseHistoryUrl || '';
  normalized.latestListingsUrl = normalized.latestListingsUrl || payload.listingsUrl || normalized.latestCaseHistoryUrl || '';
  normalized.latestOrderUrl = normalized.latestOrderUrl || payload.latestOrderUrl || latestOrder.url || '';
  normalized.latestOrderDate = normalized.latestOrderDate || payload.latestOrderDate || latestOrder.date || '';
  normalized.latestCaseTitle = normalized.latestCaseTitle || payload.caseTitle || '';
  normalized.latestCourtName = normalized.latestCourtName || payload.courtName || '';
  normalized.latestCaseNumber = normalized.latestCaseNumber || payload.caseNumber || deriveDistrictCaseNumber(normalized, latestCaseHistory) || '';
  normalized.latestNextHearingDate = normalized.latestNextHearingDate || payload.nextHearingDate || deriveNextHearingDate(payload, latestCaseHistory);
  normalized.latestStatusPageNextHearingDate = normalized.latestStatusPageNextHearingDate || payload.statusPageNextHearingDate || normalized.latestNextHearingDate;
  normalized.latestNextHearingDateSource = normalized.latestNextHearingDateSource || payload.nextHearingDateSource || inferDateSource(normalized.provider);
  normalized.latestCourtNumber = normalized.latestCourtNumber || payload.courtNumber || deriveDistrictCourtNumber(latestCaseHistory);
  normalized.latestStatus = normalized.latestStatus || payload.caseStatus || deriveDistrictStatus(latestCaseHistory);
  normalized.officialSourceUrl = normalized.officialSourceUrl || payload.officialSourceUrl || '';
  normalized.queryMeta = normalizeQueryMeta(normalized.provider, normalized.queryMeta || {});

  return normalized;
}

function normalizeSnapshotPayload(payload) {
  const caseHistory = normalizeCaseHistory(payload.caseHistory);
  const latestOrder = pickLatestOrder(caseHistory.orders);
  const nextHearingDate = payload.nextHearingDate || deriveNextHearingDate(payload, caseHistory);
  const statusPageNextHearingDate = payload.statusPageNextHearingDate || nextHearingDate || '';

  return {
    provider: payload.provider || '',
    caseFound: payload.caseFound !== false,
    courtName: payload.courtName || '',
    caseNumber: payload.caseNumber || '',
    cnrNumber: payload.cnrNumber || '',
    caseTitle: payload.caseTitle || '',
    nextHearingDate,
    statusPageNextHearingDate,
    nextHearingDateSource: payload.nextHearingDateSource || inferDateSource(payload.provider),
    possibleHearingDates: [],
    courtNumber: payload.courtNumber || deriveDistrictCourtNumber(caseHistory),
    caseStatus: payload.caseStatus || deriveDistrictStatus(caseHistory),
    firstHearingDate: payload.firstHearingDate || deriveFirstHearingDate(caseHistory),
    lastOrderDate: payload.lastOrderDate || latestOrder.date || '',
    officialSourceUrl: payload.officialSourceUrl || payload.sourceUrl || '',
    sourceUrl: payload.sourceUrl || payload.officialSourceUrl || '',
    ordersUrl: payload.ordersUrl || latestOrder.url || '',
    judgmentsUrl: payload.judgmentsUrl || '',
    caseHistoryUrl: payload.caseHistoryUrl || '',
    filingsUrl: payload.filingsUrl || payload.caseHistoryUrl || '',
    listingsUrl: payload.listingsUrl || payload.caseHistoryUrl || '',
    caseHistory,
    latestOrderUrl: payload.latestOrderUrl || latestOrder.url || '',
    latestOrderDate: payload.latestOrderDate || latestOrder.date || '',
    pageTitle: payload.pageTitle || '',
    rawTextPreview: payload.rawTextPreview || '',
    invalidCaptchaDetected: payload.invalidCaptchaDetected === true,
    rawMetadata: payload.rawMetadata || {}
  };
}

function normalizeCaseHistory(input) {
  const caseHistory = {
    filings: Array.isArray(input?.filings) ? input.filings.map(normalizeFiling) : [],
    listings: Array.isArray(input?.listings) ? input.listings.map(normalizeListing) : [],
    hearings: Array.isArray(input?.hearings) ? input.hearings.map(normalizeHearing) : [],
    orders: Array.isArray(input?.orders) ? input.orders.map(normalizeOrder) : [],
    rawTables: Array.isArray(input?.rawTables) ? input.rawTables.map(normalizeRawTable) : []
  };

  if (!caseHistory.filings.length) {
    caseHistory.filings = deriveFilingsFromRawTables(caseHistory.rawTables);
  }
  if (!caseHistory.listings.length) {
    caseHistory.listings = deriveListingsFromRawTables(caseHistory.rawTables);
  }
  if (!caseHistory.hearings.length) {
    caseHistory.hearings = deriveHearingsFromRawTables(caseHistory.rawTables);
  }
  if (!caseHistory.orders.length) {
    caseHistory.orders = deriveOrdersFromRawTables(caseHistory.rawTables);
  }

  return caseHistory;
}

function emptyCaseHistory() {
  return { filings: [], listings: [], hearings: [], orders: [], rawTables: [] };
}

function normalizeQueryMeta(provider, queryMeta) {
  const next = { ...queryMeta };
  if (provider === 'districtCourtCnr') {
    if (!next.lookupMode) next.lookupMode = 'district_case_number';
    if (!next.courtComplex && next.courtEstablishment) {
      next.courtComplex = next.courtEstablishment;
    }
  }
  return next;
}

function normalizeFiling(filing) {
  return {
    serialNumber: text(filing?.serialNumber),
    date: normalizeDateString(filing?.date),
    details: text(filing?.details),
    diaryNumber: text(filing?.diaryNumber),
    status: text(filing?.status)
  };
}

function normalizeListing(listing) {
  return {
    serialNumber: text(listing?.serialNumber),
    date: normalizeDateString(listing?.date),
    details: text(listing?.details),
    orderUrl: text(listing?.orderUrl)
  };
}

function normalizeHearing(hearing) {
  return {
    serialNumber: text(hearing?.serialNumber),
    judge: text(hearing?.judge),
    businessDate: normalizeDateString(hearing?.businessDate),
    nextDate: normalizeDateString(hearing?.nextDate),
    purpose: text(hearing?.purpose),
    business: text(hearing?.business)
  };
}

function normalizeOrder(order) {
  return {
    serialNumber: text(order?.serialNumber),
    date: normalizeDateString(order?.date),
    details: text(order?.details),
    url: decodeEntities(text(order?.url)),
    action: order?.action || null,
    sourceUrl: decodeEntities(text(order?.sourceUrl || order?.url))
  };
}

function normalizeRawTable(table) {
  return {
    title: text(table?.title),
    columns: Array.isArray(table?.columns) ? table.columns.map(text) : [],
    rows: Array.isArray(table?.rows) ? table.rows.map(normalizeRawRow) : []
  };
}

function normalizeRawRow(row) {
  return {
    cells: Array.isArray(row?.cells) ? row.cells.map(normalizeRawCell) : [],
    text: text(row?.text),
    links: Array.isArray(row?.links) ? row.links.map((link) => decodeEntities(text(link))).filter(Boolean) : [],
    actions: Array.isArray(row?.actions) ? row.actions : []
  };
}

function normalizeRawCell(cell) {
  return {
    label: text(cell?.label),
    text: text(cell?.text),
    links: Array.isArray(cell?.links) ? cell.links.map((link) => decodeEntities(text(link))).filter(Boolean) : [],
    actions: Array.isArray(cell?.actions) ? cell.actions : []
  };
}

function deriveFilingsFromRawTables(rawTables) {
  const table = rawTables.find((entry) => /filing details/i.test(entry.title));
  if (!table) return [];
  return table.rows.map((row, index) => {
    const values = row.cells.map((cell) => cell.text);
    return normalizeFiling({
      serialNumber: String(index + 1),
      date: values[2] || '',
      details: values.filter(Boolean).join(' | '),
      diaryNumber: '',
      status: ''
    });
  });
}

function deriveListingsFromRawTables(rawTables) {
  const table = rawTables.find((entry) => entry.columns.includes('Business On Date') && entry.columns.includes('Hearing Date'));
  if (!table) return [];
  return table.rows.map((row) => {
    const lookup = rawCellLookup(row);
    return normalizeListing({
      serialNumber: lookup['Registration Number'] || lookup['Serial Number'] || '',
      date: lookup['Hearing Date'] || '',
      details: [lookup['Purpose of hearing'], lookup['Hearing Date']].filter(Boolean).join(' | '),
      orderUrl: firstLink(row)
    });
  });
}

function deriveHearingsFromRawTables(rawTables) {
  const table = rawTables.find((entry) => entry.columns.includes('Business On Date') && entry.columns.includes('Hearing Date'));
  if (!table) return [];
  return table.rows.map((row) => {
    const lookup = rawCellLookup(row);
    return normalizeHearing({
      serialNumber: lookup['Registration Number'] || '',
      judge: lookup.Judge || '',
      businessDate: lookup['Business On Date'] || '',
      nextDate: lookup['Hearing Date'] || '',
      purpose: lookup['Purpose of hearing'] || '',
      business: lookup['Business On Date'] || ''
    });
  });
}

function deriveOrdersFromRawTables(rawTables) {
  const table = rawTables.find((entry) => /orders/i.test(entry.title));
  if (!table) return [];
  return table.rows.map((row) => {
    const lookup = rawCellLookup(row);
    const url = firstLink(row);
    return normalizeOrder({
      serialNumber: lookup['Order Number'] || lookup['Serial Number'] || '',
      date: lookup['Order Date'] || '',
      details: lookup['Order Details'] || row.text,
      url,
      sourceUrl: url
    });
  });
}

function deriveNextHearingDate(payload, caseHistory) {
  const direct = normalizeDateString(payload?.nextHearingDate || payload?.statusPageNextHearingDate);
  if (direct) return direct;

  for (const row of findSummaryRows(caseHistory.rawTables)) {
    const nextDate = normalizeDateString(row['Next Hearing Date'] || row['Hearing Date']);
    if (nextDate) return nextDate;
  }

  const hearingDates = caseHistory.hearings
    .map((entry) => normalizeDateString(entry.nextDate || entry.businessDate))
    .filter(Boolean);
  return hearingDates[hearingDates.length - 1] || '';
}

function deriveFirstHearingDate(caseHistory) {
  for (const row of findSummaryRows(caseHistory.rawTables)) {
    const value = normalizeDateString(row['First Hearing Date']);
    if (value) return value;
  }
  const dates = caseHistory.hearings
    .map((entry) => normalizeDateString(entry.businessDate))
    .filter(Boolean);
  return dates[0] || '';
}

function deriveDistrictStatus(caseHistory) {
  for (const row of findSummaryRows(caseHistory.rawTables)) {
    const value = text(row['Case Status']);
    if (value) return value;
  }
  return '';
}

function deriveDistrictCourtNumber(caseHistory) {
  for (const row of findSummaryRows(caseHistory.rawTables)) {
    const value = text(row['Court Number and Judge']);
    if (value) return value;
  }
  return caseHistory.hearings.find((entry) => entry.judge)?.judge || '';
}

function deriveDistrictCaseNumber(trackedCase, caseHistory) {
  const filing = caseHistory.filings[0];
  if (filing?.details) {
    const match = filing.details.match(/\b\d+\/\d{4}\b/);
    if (match) return match[0];
  }
  if (trackedCase.queryMeta?.caseNumber && trackedCase.queryMeta?.year) {
    return `${trackedCase.queryMeta.caseNumber}/${trackedCase.queryMeta.year}`;
  }
  return '';
}

function findSummaryRows(rawTables) {
  return rawTables
    .filter((table) => table.columns.includes('Next Hearing Date') || table.columns.includes('Case Status'))
    .flatMap((table) => table.rows.map(rawCellLookup));
}

function rawCellLookup(row) {
  const lookup = {};
  for (const cell of row.cells || []) {
    lookup[cell.label] = cell.text;
  }
  return lookup;
}

function firstLink(row) {
  if (Array.isArray(row.links) && row.links.length) return decodeEntities(row.links[0]);
  for (const cell of row.cells || []) {
    if (Array.isArray(cell.links) && cell.links.length) return decodeEntities(cell.links[0]);
  }
  return '';
}

function pickLatestOrder(orders) {
  const normalizedOrders = Array.isArray(orders) ? orders.map(normalizeOrder) : [];
  return normalizedOrders
    .slice()
    .sort((left, right) => compareDateStrings(left.date, right.date))
    .slice(-1)[0] || { date: '', url: '' };
}

function normalizeReminderDaysBefore(days) {
  const list = Array.isArray(days) ? days : [days];
  const normalized = list
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 30);
  return normalized.length ? [...new Set(normalized)].sort((a, b) => b - a) : [...DEFAULT_REMINDER_DAYS];
}

function normalizeDateString(value) {
  const input = text(value);
  if (!input) return '';
  const direct = input.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (direct) {
    return `${pad(direct[1])}-${pad(direct[2])}-${direct[3]}`;
  }

  const monthName = input.match(/\b(\d{1,2})[- ]([A-Za-z]+)[- ,](\d{4})\b/);
  if (monthName) {
    const month = monthNumber(monthName[2]);
    if (month) return `${pad(monthName[1])}-${month}-${monthName[3]}`;
  }

  const iso = input.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return `${iso[3]}-${iso[2]}-${iso[1]}`;
  }

  return '';
}

function compareDateStrings(left, right) {
  return toSortableDate(left) - toSortableDate(right);
}

function toSortableDate(value) {
  const normalized = normalizeDateString(value);
  if (!normalized) return 0;
  const [day, month, year] = normalized.split('-').map(Number);
  return new Date(year, month - 1, day).getTime();
}

function inferDateSource(provider) {
  if (provider === 'districtCourtCnr') return 'district_case_number';
  if (provider === 'delhiManualCaptcha') return 'case_status_page';
  return '';
}

function monthNumber(name) {
  const months = {
    january: '01',
    february: '02',
    march: '03',
    april: '04',
    may: '05',
    june: '06',
    july: '07',
    august: '08',
    september: '09',
    october: '10',
    november: '11',
    december: '12'
  };
  return months[String(name || '').trim().toLowerCase()] || '';
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function decodeEntities(value) {
  return text(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function text(value) {
  return String(value || '').trim();
}

module.exports = {
  readDb,
  writeDb,
  id,
  DB_PATH
};
