const { readDb, writeDb, id } = require('./db');
const delhiCauseListProvider = require('./providers/delhiCauseList');

const INDIA_OFFSET_MINUTES = 330;
const CACHE_TTL_MS = Number(process.env.CAUSE_LIST_CACHE_TTL_MS || 30 * 60 * 1000);

async function getTodayCauseListOverview(options = {}) {
  const db = readDb();
  const today = formatIndiaDate(new Date());
  const cached = db.causeListToday || {};
  const scannedAt = cached.scannedAt ? new Date(cached.scannedAt) : null;
  const isFresh = cached.date === today && scannedAt && (Date.now() - scannedAt.getTime()) < CACHE_TTL_MS;

  if (!options.refresh && isFresh) {
    return buildOverview(cached, db);
  }

  return refreshTodayCauseListOverview();
}

async function refreshTodayCauseListOverview() {
  const db = readDb();
  const today = formatIndiaDate(new Date());
  const entries = await delhiCauseListProvider.listCauseListEntries({ listDate: today });
  const highCourtCases = db.trackedCases.filter((trackedCase) => trackedCase.provider !== 'districtCourtCnr');
  const caseMatchers = highCourtCases.map((trackedCase) => ({
    trackedCaseId: trackedCase.id,
    trackedCase,
    inputs: buildCauseListInputs(trackedCase)
  }));

  const matches = [];
  const matchesByCaseId = new Map();

  for (const entry of entries) {
    let pdfText = '';
    try {
      pdfText = await delhiCauseListProvider.fetchCauseListPdfText(entry.pdfUrl);
    } catch (error) {
      continue;
    }

    for (const candidate of caseMatchers) {
      const match = delhiCauseListProvider.findCaseInText(pdfText, candidate.inputs);
      if (!match) continue;

      const row = {
        trackedCaseId: candidate.trackedCaseId,
        caseNumber: match.matchedCaseNumber || candidate.trackedCase.latestCaseNumber || candidate.trackedCase.displayLabel,
        caseTitle: match.caseTitle || candidate.trackedCase.latestCaseTitle || candidate.trackedCase.manualCaseTitle || '',
        courtNumber: match.courtNumber || '',
        matchedLine: match.matchedLine || '',
        title: entry.title,
        listDate: entry.listDate,
        pdfUrl: entry.pdfUrl
      };

      matches.push(row);
      if (!matchesByCaseId.has(candidate.trackedCaseId)) {
        matchesByCaseId.set(candidate.trackedCaseId, []);
      }
      matchesByCaseId.get(candidate.trackedCaseId).push(row);
    }
  }

  const scannedAt = new Date().toISOString();
  for (const trackedCase of db.trackedCases) {
    const caseMatches = matchesByCaseId.get(trackedCase.id) || [];
    const previousUrls = new Set((trackedCase.latestCauseListMatches || []).map((item) => item.pdfUrl));
    trackedCase.latestCauseListMatches = caseMatches;
    trackedCase.latestCauseListMatchedOn = caseMatches.length ? today : '';
    trackedCase.latestCauseListLastCheckedAt = scannedAt;
    trackedCase.updatedAt = new Date().toISOString();

    for (const match of caseMatches) {
      if (previousUrls.has(match.pdfUrl)) continue;
      db.events.push({
        id: id('event'),
        trackedCaseId: trackedCase.id,
        type: 'cause_list_match',
        message: `Case appears in today's Delhi High Court cause list: ${match.title}`,
        createdAt: scannedAt
      });
    }
  }

  db.causeListToday = {
    date: today,
    scannedAt,
    entries,
    matches
  };
  writeDb(db);

  return buildOverview(db.causeListToday, db);
}

function buildOverview(causeListToday, db) {
  const casesById = new Map(db.trackedCases.map((trackedCase) => [trackedCase.id, trackedCase]));
  const matchedCases = (causeListToday.matches || []).map((match) => {
    const trackedCase = casesById.get(match.trackedCaseId);
    return {
      ...match,
      displayTitle: trackedCase
        ? (trackedCase.manualCaseTitle || trackedCase.latestCaseTitle || trackedCase.displayLabel || trackedCase.latestCaseNumber)
        : match.caseTitle || match.caseNumber || 'Tracked case'
    };
  });

  return {
    date: causeListToday.date || formatIndiaDate(new Date()),
    scannedAt: causeListToday.scannedAt || '',
    entries: causeListToday.entries || [],
    matches: matchedCases,
    matchedCaseIds: Array.from(new Set(matchedCases.map((match) => match.trackedCaseId).filter(Boolean)))
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

module.exports = {
  getTodayCauseListOverview,
  refreshTodayCauseListOverview
};
