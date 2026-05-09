const { readDb, writeDb, id, normalizeSnapshotPayload, normalizeDateString } = require('./db');
const { detectEvents } = require('./changeDetection');
const { sendCaseUpdateAlerts } = require('./caseUpdateAlertService');
const { maybeRefreshHighCourtJudgmentMatches } = require('./highCourtJudgmentService');
const { formatReminderEmails, parseReminderEmailsFromInput } = require('./reminderEmails');
const mockHighCourtProvider = require('./providers/mockHighCourt');
const delhiCauseListProvider = require('./providers/delhiCauseList');
const delhiManualCaptchaProvider = require('./providers/delhiManualCaptcha');
const districtCourtCnrProvider = require('./providers/districtCourtCnr');

const providers = {
  mockHighCourt: mockHighCourtProvider,
  delhiCauseList: delhiCauseListProvider,
  delhiManualCaptcha: delhiManualCaptchaProvider,
  districtCourtCnr: districtCourtCnrProvider
};

const DEFAULT_REMINDER_EMAIL = process.env.DEFAULT_REMINDER_EMAIL || 'info@amitguptaadvocate.com';
const HIGH_COURT_ORDER_MONITOR_INTERVAL_MS = Number(process.env.HIGH_COURT_ORDER_MONITOR_INTERVAL_MS || 4 * 60 * 60 * 1000);

function getProvider(name) {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

function listProviders() {
  return Object.keys(providers);
}

function listCases() {
  return readDb().trackedCases;
}

function getCase(caseId) {
  const db = readDb();
  const trackedCase = db.trackedCases.find((candidate) => candidate.id === caseId);
  if (!trackedCase) return null;

  return {
    ...trackedCase,
    snapshots: db.snapshots.filter((snapshot) => snapshot.trackedCaseId === caseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    events: db.events.filter((event) => event.trackedCaseId === caseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    scrapeRuns: db.scrapeRuns.filter((run) => run.trackedCaseId === caseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    reminderDeliveries: db.reminderDeliveries
      .filter((delivery) => delivery.trackedCaseId === caseId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  };
}

function addCase(input) {
  const db = readDb();
  const duplicate = findDuplicateCase(db.trackedCases, input);
  if (duplicate) {
    throw new Error('This case is already being tracked.');
  }

  const parsedReminderEmails = parseReminderEmailsFromInput(applyDefaultReminderInput(input));
  if (parsedReminderEmails.invalid.length) {
    throw new Error(`Invalid reminder email(s): ${parsedReminderEmails.invalid.join(', ')}`);
  }

  const trackedCase = {
    id: id('case'),
    provider: input.provider || 'mockHighCourt',
    cnrNumber: input.cnrNumber || '',
    caseLookup: input.caseLookup || '',
    displayLabel: input.displayLabel || input.cnrNumber || input.caseLookup || '',
    queryMeta: input.queryMeta || {},
    latestCaseTitle: '',
    latestCourtName: '',
    latestCaseNumber: '',
    latestNextHearingDate: '',
    latestStatusPageNextHearingDate: '',
    latestNextHearingDateSource: '',
    latestCourtNumber: '',
    latestStatus: '',
    latestOrdersUrl: '',
    latestJudgmentsUrl: '',
    latestCaseHistoryUrl: '',
    latestFilingsUrl: '',
    latestListingsUrl: '',
    latestCaseHistory: { filings: [], listings: [], hearings: [], orders: [], rawTables: [] },
    latestOrderUrl: '',
    latestOrderDate: '',
    latestPossibleHearingDates: [],
    manualNextHearingDate: '',
    activityAlertBaselineDate: todayInIndia(),
    officialSourceUrl: '',
    manualCaseTitle: '',
    reminderEmails: parsedReminderEmails.emails,
    reminderEmail: parsedReminderEmails.emails[0] || '',
    reminderEmailsLabel: formatReminderEmails(parsedReminderEmails.emails),
    reminderEnabled: Boolean(parsedReminderEmails.emails.length),
    reminderDaysBefore: [3, 2, 1, 0],
    reminderSkipDisposed: true,
    lastCheckedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.trackedCases.push(trackedCase);
  writeDb(db);
  return trackedCase;
}

function deleteCase(caseId) {
  const db = readDb();
  db.trackedCases = db.trackedCases.filter((candidate) => candidate.id !== caseId);
  db.snapshots = db.snapshots.filter((snapshot) => snapshot.trackedCaseId !== caseId);
  db.events = db.events.filter((event) => event.trackedCaseId !== caseId);
  db.scrapeRuns = db.scrapeRuns.filter((run) => run.trackedCaseId !== caseId);
  db.reminderDeliveries = db.reminderDeliveries.filter((delivery) => delivery.trackedCaseId !== caseId);
  writeDb(db);
}

function updateCaseReminderSettings(caseId, input) {
  const db = readDb();
  const trackedCase = db.trackedCases.find((candidate) => candidate.id === caseId);
  if (!trackedCase) throw new Error('Tracked case not found');

  const parsedReminderEmails = parseReminderEmailsFromInput(input);
  if (parsedReminderEmails.invalid.length) {
    throw new Error(`Invalid reminder email(s): ${parsedReminderEmails.invalid.join(', ')}`);
  }

  trackedCase.reminderEmails = parsedReminderEmails.emails;
  trackedCase.reminderEmail = parsedReminderEmails.emails[0] || '';
  trackedCase.reminderEmailsLabel = formatReminderEmails(parsedReminderEmails.emails);
  trackedCase.reminderEnabled = Boolean(input.reminderEnabled && parsedReminderEmails.emails.length);
  trackedCase.reminderDaysBefore = normalizeReminderDays(input.reminderDaysBefore);
  trackedCase.reminderSkipDisposed = input.reminderSkipDisposed !== false;
  trackedCase.updatedAt = new Date().toISOString();

  writeDb(db);
  return trackedCase;
}

function updateCaseDetails(caseId, input) {
  const db = readDb();
  const trackedCase = db.trackedCases.find((candidate) => candidate.id === caseId);
  if (!trackedCase) throw new Error('Tracked case not found');

  if (Object.prototype.hasOwnProperty.call(input, 'manualCaseTitle')) {
    trackedCase.manualCaseTitle = String(input.manualCaseTitle || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(input, 'manualNextHearingDate')) {
    const rawValue = String(input.manualNextHearingDate || '').trim();
    const normalizedDate = normalizeDateString(rawValue);
    if (rawValue && !normalizedDate) {
      throw new Error('Manual next hearing date must be in DD-MM-YYYY format.');
    }
    trackedCase.manualNextHearingDate = normalizedDate || '';
    if (normalizedDate) {
      trackedCase.latestNextHearingDate = normalizedDate;
      trackedCase.latestNextHearingDateSource = 'manual_override';
      trackedCase.latestPossibleHearingDates = [normalizedDate];
    }
  }

  trackedCase.updatedAt = new Date().toISOString();
  writeDb(db);
  return trackedCase;
}

async function syncCase(caseId) {
  const db = readDb();
  const trackedCase = db.trackedCases.find((candidate) => candidate.id === caseId);
  if (!trackedCase) throw new Error('Tracked case not found');
  if (trackedCase.provider === 'districtCourtCnr') {
    throw new Error('This case must be refreshed from the browser UI so you can solve the official CAPTCHA.');
  }

  const provider = getProvider(trackedCase.provider);
  const run = createRun(db, caseId);

  try {
    const normalized = await provider.fetchCase({
      cnrNumber: trackedCase.cnrNumber,
      caseLookup: trackedCase.caseLookup,
      queryMeta: trackedCase.queryMeta,
      trackedCase
    });

    const result = applyNormalizedResult(db, trackedCase, normalized, run);
    await sendCaseUpdateAlerts(db, trackedCase, result.newEvents, normalized);
    writeDb(db);
    return result;
  } catch (error) {
    failRun(db, run, error.message);
    writeDb(db);
    throw error;
  }
}

async function syncCaseWithNormalizedResult(caseId, normalized) {
  const db = readDb();
  const trackedCase = db.trackedCases.find((candidate) => candidate.id === caseId);
  if (!trackedCase) throw new Error('Tracked case not found');

  const run = createRun(db, caseId);
  const result = applyNormalizedResult(db, trackedCase, normalized, run);
  await sendCaseUpdateAlerts(db, trackedCase, result.newEvents, normalized);
  writeDb(db);
  return result;
}

function createRun(db, caseId) {
  const run = {
    id: id('run'),
    trackedCaseId: caseId,
    status: 'started',
    message: 'Sync started',
    createdAt: new Date().toISOString()
  };
  db.scrapeRuns.push(run);
  writeDb(db);
  return run;
}

function failRun(db, run, message) {
  run.status = 'failed';
  run.message = message;
  run.finishedAt = new Date().toISOString();
}

function applyNormalizedResult(db, trackedCase, normalized, run) {
  const effectiveNormalized = normalizeSnapshotPayload(normalized);
  const latestSnapshot = db.snapshots
    .filter((snapshot) => snapshot.trackedCaseId === trackedCase.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const snapshot = {
    id: id('snapshot'),
    trackedCaseId: trackedCase.id,
    payload: effectiveNormalized,
    createdAt: new Date().toISOString()
  };
  db.snapshots.push(snapshot);

  const events = detectEvents(latestSnapshot?.payload, effectiveNormalized).map((event) => ({
    id: id('event'),
    trackedCaseId: trackedCase.id,
    ...event,
    createdAt: new Date().toISOString()
  }));
  db.events.push(...events);

  trackedCase.latestCaseTitle = effectiveNormalized.caseTitle || trackedCase.latestCaseTitle;
  trackedCase.latestCourtName = effectiveNormalized.courtName || trackedCase.latestCourtName;
  trackedCase.latestCaseNumber = effectiveNormalized.caseNumber || trackedCase.latestCaseNumber;
  trackedCase.latestNextHearingDate = effectiveNormalized.nextHearingDate || trackedCase.latestNextHearingDate;
  trackedCase.latestStatusPageNextHearingDate = effectiveNormalized.statusPageNextHearingDate || trackedCase.latestStatusPageNextHearingDate;
  trackedCase.latestNextHearingDateSource = effectiveNormalized.nextHearingDateSource || trackedCase.latestNextHearingDateSource;
  trackedCase.latestCourtNumber = effectiveNormalized.courtNumber || trackedCase.latestCourtNumber;
  trackedCase.latestStatus = effectiveNormalized.caseStatus || trackedCase.latestStatus;
  trackedCase.officialSourceUrl = effectiveNormalized.officialSourceUrl || trackedCase.officialSourceUrl;
  trackedCase.latestOrdersUrl = effectiveNormalized.ordersUrl || trackedCase.latestOrdersUrl;
  trackedCase.latestJudgmentsUrl = effectiveNormalized.judgmentsUrl || trackedCase.latestJudgmentsUrl;
  trackedCase.latestCaseHistoryUrl = effectiveNormalized.caseHistoryUrl || trackedCase.latestCaseHistoryUrl;
  trackedCase.latestFilingsUrl = effectiveNormalized.filingsUrl || trackedCase.latestFilingsUrl;
  trackedCase.latestListingsUrl = effectiveNormalized.listingsUrl || trackedCase.latestListingsUrl;
  trackedCase.latestCaseHistory = effectiveNormalized.caseHistory || trackedCase.latestCaseHistory;
  trackedCase.latestOrderUrl = effectiveNormalized.latestOrderUrl || trackedCase.latestOrderUrl;
  trackedCase.latestOrderDate = effectiveNormalized.latestOrderDate || trackedCase.latestOrderDate;
  trackedCase.latestPossibleHearingDates = Array.isArray(effectiveNormalized.possibleHearingDates)
    ? effectiveNormalized.possibleHearingDates
    : trackedCase.latestPossibleHearingDates;
  if (trackedCase.manualNextHearingDate && effectiveNormalized.nextHearingDate && effectiveNormalized.nextHearingDateSource !== 'manual_override') {
    trackedCase.manualNextHearingDate = '';
  }
  trackedCase.reminderEmail = trackedCase.reminderEmails[0] || '';
  trackedCase.reminderEmailsLabel = formatReminderEmails(trackedCase.reminderEmails);
  trackedCase.lastCheckedAt = new Date().toISOString();
  trackedCase.updatedAt = new Date().toISOString();

  run.status = 'success';
  run.message = events.length ? `Sync completed with ${events.length} new event(s)` : 'Sync completed with no changes';
  run.finishedAt = new Date().toISOString();

  return {
    trackedCase,
    latestSnapshot: snapshot,
    newEvents: events,
    scrapeRun: run
  };
}

async function syncAllCases(options = {}) {
  const cases = listCases();
  const results = [];
  const forceHighCourtMonitor = options.forceHighCourtMonitor === true;
  for (const trackedCase of cases) {
    if (trackedCase.provider === 'delhiManualCaptcha' && !forceHighCourtMonitor && !shouldRunHighCourtOrderMonitor(trackedCase)) {
      results.push({ caseId: trackedCase.id, ok: false, error: 'Skipped: High Court order monitor is not due yet' });
      continue;
    }
    if (trackedCase.provider === 'districtCourtCnr') {
      results.push({ caseId: trackedCase.id, ok: false, error: 'Skipped: manual CAPTCHA required' });
      continue;
    }
    try {
      const result = await syncCase(trackedCase.id);
      results.push({ caseId: trackedCase.id, ok: true, result });
    } catch (error) {
      results.push({ caseId: trackedCase.id, ok: false, error: error.message });
    }
  }

  try {
    const judgmentResult = await maybeRefreshHighCourtJudgmentMatches();
    if (!judgmentResult.skipped) {
      results.push({
        caseId: 'high_court_judgments',
        ok: true,
        result: {
          newEvents: judgmentResult.events
        }
      });
    }
  } catch (error) {
    results.push({ caseId: 'high_court_judgments', ok: false, error: error.message });
  }

  return results;
}

function shouldRunHighCourtOrderMonitor(trackedCase) {
  if (trackedCase.provider !== 'delhiManualCaptcha') return true;
  if (!trackedCase.latestCaseHistoryUrl) return false;

  const lastCheckedAt = trackedCase.lastCheckedAt ? new Date(trackedCase.lastCheckedAt).getTime() : 0;
  if (lastCheckedAt && (Date.now() - lastCheckedAt) < HIGH_COURT_ORDER_MONITOR_INTERVAL_MS) {
    return false;
  }

  return true;
}

function applyDefaultReminderInput(input) {
  const reminderEmail = typeof input?.reminderEmail === 'string' ? input.reminderEmail.trim() : '';
  const reminderEmails = Array.isArray(input?.reminderEmails)
    ? input.reminderEmails.filter((value) => String(value || '').trim())
    : (typeof input?.reminderEmails === 'string' ? input.reminderEmails.trim() : '');
  const hasReminderInput = Boolean(reminderEmail || (Array.isArray(reminderEmails) ? reminderEmails.length : reminderEmails));
  return hasReminderInput ? input : { ...input, reminderEmails: DEFAULT_REMINDER_EMAIL };
}

function todayInIndia() {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const parts = formatter.formatToParts(new Date());
  const day = parts.find((part) => part.type === 'day')?.value || '01';
  const month = parts.find((part) => part.type === 'month')?.value || '01';
  const year = parts.find((part) => part.type === 'year')?.value || '1970';
  return `${day}-${month}-${year}`;
}

function normalizeReminderDays(days) {
  const list = Array.isArray(days) ? days : [days];
  const normalized = list
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 30);
  return normalized.length ? [...new Set(normalized)].sort((a, b) => b - a) : [3, 2, 1, 0];
}

function findDuplicateCase(cases, input) {
  if (input.provider === 'districtCourtCnr') {
    return cases.find((candidate) =>
      candidate.provider === 'districtCourtCnr' &&
      districtCaseIdentity(candidate.queryMeta || {}) === districtCaseIdentity(input.queryMeta || {})
    ) || null;
  }

  return cases.find((candidate) =>
    candidate.provider === input.provider &&
    highCourtCaseIdentity(candidate, candidate.queryMeta || {}) === highCourtCaseIdentity(input, input.queryMeta || {})
  ) || null;
}

function districtCaseIdentity(queryMeta) {
  return [
    normalizeLookupToken(queryMeta?.districtSlug || ''),
    normalizeLookupToken(queryMeta?.searchMode || 'courtComplex'),
    normalizeLookupToken(queryMeta?.courtComplexValue || queryMeta?.courtComplex || ''),
    normalizeLookupToken(queryMeta?.courtEstablishmentValue || queryMeta?.courtEstablishment || ''),
    normalizeLookupToken(queryMeta?.caseType || ''),
    normalizeLookupToken(queryMeta?.caseNumber || ''),
    normalizeLookupToken(queryMeta?.year || '')
  ].join('|');
}

function highCourtCaseIdentity(source, queryMeta) {
  const queryKey = [
    normalizeLookupToken(queryMeta?.caseType || ''),
    normalizeLookupToken(queryMeta?.caseNumber || ''),
    normalizeLookupToken(queryMeta?.year || '')
  ].join('|');

  return [
    queryKey,
    normalizeLookupToken(source?.cnrNumber || ''),
    normalizeLookupToken(source?.caseLookup || ''),
    normalizeLookupToken(source?.displayLabel || ''),
    normalizeLookupToken(source?.latestCaseNumber || '')
  ].join('|');
}

function normalizeLookupToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/&AMP;/g, '&')
    .replace(/[^A-Z0-9]/g, '');
}

module.exports = {
  listProviders,
  getProvider,
  listCases,
  getCase,
  addCase,
  deleteCase,
  updateCaseReminderSettings,
  updateCaseDetails,
  syncCase,
  syncCaseWithNormalizedResult,
  syncAllCases
};
