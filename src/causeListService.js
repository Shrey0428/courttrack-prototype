const { readDb, writeDb, id } = require('./db');
const delhiCauseListProvider = require('./providers/delhiCauseList');

const INDIA_OFFSET_MINUTES = 330;
const CACHE_TTL_MS = Number(process.env.CAUSE_LIST_CACHE_TTL_MS || 30 * 60 * 1000);
const CAUSE_LIST_CACHE_VERSION = '3';

async function getTodayCauseListOverview(options = {}) {
  return getCauseListOverviewForDate(formatIndiaDate(new Date()), options);
}

async function refreshTodayCauseListOverview() {
  return refreshCauseListOverviewForDate(formatIndiaDate(new Date()));
}

async function getNextDayCauseListOverview(options = {}) {
  return getCauseListOverviewForDate(formatIndiaDate(addIndiaDays(new Date(), 1)), options);
}

async function refreshNextDayCauseListOverview() {
  return refreshCauseListOverviewForDate(formatIndiaDate(addIndiaDays(new Date(), 1)));
}

async function getActiveCauseListOverview(options = {}) {
  const target = getActiveCauseListTarget();
  const overview = await getCauseListOverviewForDate(target.date, options);
  return {
    ...overview,
    windowKind: target.kind,
    windowLabel: target.kind === 'next-day' ? 'Tomorrow' : 'Today'
  };
}

async function refreshActiveCauseListOverview() {
  const target = getActiveCauseListTarget();
  const overview = await refreshCauseListOverviewForDate(target.date);
  return {
    ...overview,
    windowKind: target.kind,
    windowLabel: target.kind === 'next-day' ? 'Tomorrow' : 'Today'
  };
}

async function getCauseListOverviewForDate(targetDate, options = {}) {
  const db = readDb();
  const normalizedDate = normalizeDateKey(targetDate);
  const cached = db.causeListByDate?.[normalizedDate] || {};
  const scannedAt = cached.scannedAt ? new Date(cached.scannedAt) : null;
  const isFresh = cached.date === normalizedDate &&
    cached.version === CAUSE_LIST_CACHE_VERSION &&
    scannedAt &&
    (Date.now() - scannedAt.getTime()) < CACHE_TTL_MS;

  if (!options.refresh && isFresh) {
    return buildOverview(cached, db);
  }

  return refreshCauseListOverviewForDate(normalizedDate);
}

async function refreshCauseListOverviewForDate(targetDate) {
  const db = readDb();
  const normalizedDate = normalizeDateKey(targetDate);
  const todayDate = formatIndiaDate(new Date());
  const primaryEntries = await delhiCauseListProvider.listCauseListEntries({ listDate: normalizedDate, mode: 'main' });
  const fallbackEntries = await delhiCauseListProvider.listCauseListEntries({ listDate: normalizedDate, mode: 'fallback' });
  const entries = primaryEntries.length ? primaryEntries : fallbackEntries;
  const highCourtCases = db.trackedCases.filter((trackedCase) => trackedCase.provider !== 'districtCourtCnr');
  const caseMatchers = highCourtCases.map((trackedCase) => ({
    trackedCaseId: trackedCase.id,
    trackedCase,
    inputs: buildCauseListInputs(trackedCase)
  }));

  const matches = [];
  const primaryMatchesByCaseId = new Map();
  const fallbackMatchesByCaseId = new Map();

  for (const bucket of [primaryMatchesByCaseId, fallbackMatchesByCaseId]) {
    for (const candidate of caseMatchers) {
      bucket.set(candidate.trackedCaseId, []);
    }
  }

  for (const entry of primaryEntries) {
    let pdfText = '';
    try {
      pdfText = await delhiCauseListProvider.fetchCauseListPdfText(entry.pdfUrl);
    } catch (_error) {
      continue;
    }

    for (const candidate of caseMatchers) {
      const pageMatches = delhiCauseListProvider.parseCauseListMatches(pdfText, candidate.inputs);
      for (const match of pageMatches) {
        const row = buildCauseListMatchRow(candidate.trackedCase, candidate.trackedCaseId, entry, match);
        primaryMatchesByCaseId.get(candidate.trackedCaseId).push(row);
      }
    }
  }

  const unresolvedCaseIds = caseMatchers
    .filter((candidate) => !(primaryMatchesByCaseId.get(candidate.trackedCaseId) || []).length)
    .map((candidate) => candidate.trackedCaseId);

  for (const entry of fallbackEntries) {
    if (!unresolvedCaseIds.length) break;
    let pdfText = '';
    try {
      pdfText = await delhiCauseListProvider.fetchCauseListPdfText(entry.pdfUrl);
    } catch (_error) {
      continue;
    }

    for (const candidate of caseMatchers) {
      if (!unresolvedCaseIds.includes(candidate.trackedCaseId)) continue;
      const pageMatches = delhiCauseListProvider.parseCauseListMatches(pdfText, candidate.inputs);
      for (const match of pageMatches) {
        const row = buildCauseListMatchRow(candidate.trackedCase, candidate.trackedCaseId, entry, match);
        fallbackMatchesByCaseId.get(candidate.trackedCaseId).push(row);
      }
    }
  }

  const scannedAt = new Date().toISOString();
  for (const trackedCase of db.trackedCases) {
    const primaryMatches = dedupeMatches(primaryMatchesByCaseId.get(trackedCase.id) || []);
    const fallbackMatches = dedupeMatches(fallbackMatchesByCaseId.get(trackedCase.id) || []);
    const caseMatches = primaryMatches.length ? primaryMatches : fallbackMatches;
    matches.push(...caseMatches);
    const previousMatches = trackedCase.latestCauseListMatchesByDate?.[normalizedDate] || [];
    const previousKeys = new Set(previousMatches.map(matchIdentity));
    trackedCase.latestCauseListMatchesByDate = {
      ...(trackedCase.latestCauseListMatchesByDate || {}),
      [normalizedDate]: caseMatches
    };
    if (normalizedDate === todayDate) {
      trackedCase.latestCauseListMatches = caseMatches;
      trackedCase.latestCauseListMatchedOn = caseMatches.length ? normalizedDate : trackedCase.latestCauseListMatchedOn || '';
      trackedCase.latestCauseListLastCheckedAt = scannedAt;
    }
    trackedCase.updatedAt = new Date().toISOString();

    for (const match of caseMatches) {
      if (previousKeys.has(matchIdentity(match))) continue;
      db.events.push({
        id: id('event'),
        trackedCaseId: trackedCase.id,
        type: 'cause_list_match',
        message: `Case appears in Delhi High Court cause list for ${normalizedDate}: ${match.title}`,
        createdAt: scannedAt
      });
    }
  }

  const nextStore = {
    version: CAUSE_LIST_CACHE_VERSION,
    date: normalizedDate,
    scannedAt,
    entries,
    matches: dedupeMatches(matches)
  };

  db.causeListByDate = {
    ...(db.causeListByDate || {}),
    [normalizedDate]: nextStore
  };

  if (normalizedDate === todayDate) {
    db.causeListToday = nextStore;
  }

  writeDb(db);
  return buildOverview(nextStore, db);
}

function buildOverview(causeListForDate, db) {
  const casesById = new Map(db.trackedCases.map((trackedCase) => [trackedCase.id, trackedCase]));
  const matchedCases = (causeListForDate.matches || []).map((match) => {
    const trackedCase = casesById.get(match.trackedCaseId);
    return {
      ...match,
      displayTitle: trackedCase
        ? (trackedCase.manualCaseTitle || trackedCase.latestCaseTitle || trackedCase.displayLabel || trackedCase.latestCaseNumber)
        : match.caseTitle || match.caseNumber || 'Tracked case'
    };
  });

  return {
    date: causeListForDate.date || formatIndiaDate(new Date()),
    scannedAt: causeListForDate.scannedAt || '',
    entries: causeListForDate.entries || [],
    matches: matchedCases,
    matchedCaseIds: Array.from(new Set(matchedCases.map((match) => match.trackedCaseId).filter(Boolean)))
  };
}

function buildCauseListMatchRow(trackedCase, trackedCaseId, entry, match) {
  return {
    trackedCaseId,
    caseNumber: match.matchedCaseNumber || trackedCase.latestCaseNumber || trackedCase.displayLabel,
    caseTitle: match.caseTitle || trackedCase.latestCaseTitle || trackedCase.manualCaseTitle || '',
    partyNames: match.partyNames || '',
    advocateNames: match.advocateNames || '',
    courtNumber: match.courtNumber || '',
    matchedLine: match.matchedLine || '',
    itemNumber: match.itemNumber || '',
    listType: match.listType || 'main',
    benchType: match.benchType || '',
    judgeNames: match.judgeNames || '',
    judgeLabel: match.judgeLabel || '',
    meetingLink: match.meetingLink || '',
    pageNumber: match.pageNumber || 0,
    title: entry.title,
    listDate: entry.listDate,
    pdfUrl: entry.pdfUrl,
    sourceKind: /Cause List of Sitting of Benches/i.test(entry.title) ? 'sitting_benches' : 'other'
  };
}

function buildCauseListInputs(trackedCase) {
  const inputs = new Set();
  const caseType = String(trackedCase.queryMeta?.caseType || '').trim();
  const caseNumber = String(trackedCase.queryMeta?.caseNumber || '').trim();
  const year = String(trackedCase.queryMeta?.year || '').trim();

  if (caseType && caseNumber && year) {
    inputs.add(`${caseType} ${caseNumber}/${year}`);
  }

  [
    trackedCase.latestCaseNumber,
    trackedCase.displayLabel,
    trackedCase.caseLookup
  ].forEach((value) => {
    const text = String(value || '').trim();
    if (text) inputs.add(text);
  });

  return Array.from(inputs);
}

function matchIdentity(match) {
  return [
    match.trackedCaseId || '',
    match.pdfUrl || '',
    match.pageNumber || '',
    match.itemNumber || '',
    match.caseNumber || ''
  ].join('|');
}

function dedupeMatches(matches) {
  const seen = new Set();
  return (matches || []).filter((match) => {
    const key = matchIdentity(match);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getIndiaParts(date) {
  const shifted = new Date(date.getTime() + INDIA_OFFSET_MINUTES * 60 * 1000);
  return {
    day: String(shifted.getUTCDate()).padStart(2, '0'),
    month: String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    year: String(shifted.getUTCFullYear())
  };
}

function formatIndiaDate(date) {
  const parts = getIndiaParts(date);
  return `${parts.day}-${parts.month}-${parts.year}`;
}

function addIndiaDays(date, count) {
  const shifted = new Date(date.getTime() + INDIA_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() + count);
  return new Date(shifted.getTime() - INDIA_OFFSET_MINUTES * 60 * 1000);
}

function getIndiaTimeParts(date) {
  const shifted = new Date(date.getTime() + INDIA_OFFSET_MINUTES * 60 * 1000);
  return {
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes()
  };
}

function getActiveCauseListTarget(now = new Date()) {
  const { hours, minutes } = getIndiaTimeParts(now);
  const afterCutoff = hours > 19 || (hours === 19 && minutes >= 0);
  return {
    kind: afterCutoff ? 'next-day' : 'today',
    date: afterCutoff ? formatIndiaDate(addIndiaDays(now, 1)) : formatIndiaDate(now)
  };
}

function normalizeDateKey(value) {
  const m = String(value || '').match(/(\d{2})[-/.](\d{2})[-/.](\d{4})/);
  if (!m) return formatIndiaDate(new Date());
  return `${m[1]}-${m[2]}-${m[3]}`;
}

module.exports = {
  getActiveCauseListOverview,
  getTodayCauseListOverview,
  refreshTodayCauseListOverview,
  refreshActiveCauseListOverview,
  getNextDayCauseListOverview,
  refreshNextDayCauseListOverview,
  getCauseListOverviewForDate,
  refreshCauseListOverviewForDate
};
