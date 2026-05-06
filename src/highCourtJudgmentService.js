const { readDb, writeDb, id } = require('./db');
const delhiCauseListProvider = require('./providers/delhiCauseList');
const { sendCaseUpdateAlerts } = require('./caseUpdateAlertService');

const JUDGMENT_FEED_URL = 'https://www.delhihighcourt.nic.in/web/judgement/fetch-data';
const JUDGMENT_SCAN_INTERVAL_MS = Number(process.env.HIGH_COURT_JUDGMENT_MONITOR_INTERVAL_MS || 30 * 60 * 1000);

let lastScanAt = 0;

async function maybeRefreshHighCourtJudgmentMatches(options = {}) {
  const now = Date.now();
  if (!options.force && lastScanAt && (now - lastScanAt) < JUDGMENT_SCAN_INTERVAL_MS) {
    return { skipped: true, reason: 'Judgment monitor is not due yet.', events: [] };
  }

  lastScanAt = now;
  return refreshHighCourtJudgmentMatches();
}

async function refreshHighCourtJudgmentMatches() {
  const db = readDb();
  const trackedCases = db.trackedCases.filter((trackedCase) => trackedCase.provider === 'delhiManualCaptcha');
  if (!trackedCases.length) {
    return { skipped: false, events: [], matches: [] };
  }

  const entries = await fetchLatestJudgmentEntries();
  const scannedAt = new Date().toISOString();
  const events = [];

  for (const trackedCase of trackedCases) {
    const candidates = buildJudgmentCandidates(trackedCase);
    const previousMatches = Array.isArray(trackedCase.latestJudgmentMatches) ? trackedCase.latestJudgmentMatches : [];
    const previousUrls = new Set(previousMatches.map((entry) => entry.pdfUrl).filter(Boolean));
    const matches = entries.filter((entry) => matchesJudgmentEntry(entry, candidates));

    trackedCase.latestJudgmentMatches = matches;
    trackedCase.latestJudgmentMatchedOn = matches[0]?.judgmentDate || '';
    trackedCase.latestJudgmentLastCheckedAt = scannedAt;
    trackedCase.updatedAt = scannedAt;

    const baselineDate = normalizeDate(trackedCase.activityAlertBaselineDate || '');
    const newMatches = matches
      .filter((entry) => entry.pdfUrl && !previousUrls.has(entry.pdfUrl))
      .filter((entry) => !baselineDate || compareDates(entry.judgmentDate, baselineDate) > 0);
    if (!newMatches.length) continue;

    const event = {
      id: id('event'),
      trackedCaseId: trackedCase.id,
      type: 'judgment_published',
      message: `${newMatches.length} new judgment${newMatches.length === 1 ? '' : 's'} published on the Delhi High Court website`,
      details: {
        items: newMatches
      },
      createdAt: scannedAt
    };
    db.events.push(event);
    events.push(event);

    await sendCaseUpdateAlerts(db, trackedCase, [event], {
      nextHearingDate: trackedCase.latestNextHearingDate,
      rawMetadata: {}
    });
  }

  writeDb(db);
  return {
    skipped: false,
    events,
    matches: trackedCases.flatMap((trackedCase) => trackedCase.latestJudgmentMatches || [])
  };
}

async function fetchLatestJudgmentEntries() {
  const response = await fetch(JUDGMENT_FEED_URL, {
    headers: {
      'user-agent': 'CourtTrackPrototype/1.0 (+public judgment monitor)'
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Delhi High Court latest judgments: ${response.status}`);
  }

  const html = await response.text();
  const rows = [...html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*\d+\s*<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>[\s\S]*?<a[^>]*href="([^"]+)"/gis)];

  return rows.map((match) => ({
    caseNumber: normalizeCaseNumber(stripTags(match[1])),
    judgmentDate: normalizeDate(stripTags(match[2])),
    petitioner: stripTags(match[3]),
    respondent: stripTags(match[4]),
    pdfUrl: absolutizeUrl(match[5])
  })).filter((entry) => entry.caseNumber && entry.judgmentDate && entry.pdfUrl);
}

function buildJudgmentCandidates(trackedCase) {
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

  return Array.from(new Set(
    Array.from(inputs).flatMap((value) => delhiCauseListProvider.buildLookupCandidates(String(value || '').trim()))
  ));
}

function matchesJudgmentEntry(entry, candidates) {
  const entryNormalized = normalizeCaseNumber(entry.caseNumber);
  const compactEntry = compact(entryNormalized);
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeCaseNumber(candidate);
    return (
      entryNormalized === normalizedCandidate ||
      compactEntry === compact(normalizedCandidate) ||
      entryNormalized.includes(normalizedCandidate) ||
      normalizedCandidate.includes(entryNormalized)
    );
  });
}

function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value) {
  const input = String(value || '').trim();
  const direct = input.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (direct) {
    return `${pad(direct[1])}-${pad(direct[2])}-${direct[3]}`;
  }

  const named = input.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (named) {
    const month = monthNumber(named[2]);
    if (month) {
      return `${pad(named[1])}-${month}-${named[3]}`;
    }
  }

  return '';
}

function normalizeCaseNumber(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .trim()
    .toUpperCase();
}

function compact(value) {
  return normalizeCaseNumber(value).replace(/[^A-Z0-9]/g, '');
}

function monthNumber(name) {
  const map = {
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
  return map[String(name || '').trim().toLowerCase()] || '';
}

function pad(value) {
  return String(value || '').padStart(2, '0');
}

function compareDates(left, right) {
  return toSortableDate(left) - toSortableDate(right);
}

function toSortableDate(value) {
  const normalized = normalizeDate(value);
  if (!normalized) return 0;
  const [day, month, year] = normalized.split('-').map(Number);
  return new Date(year, month - 1, day).getTime();
}

function absolutizeUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `https://www.delhihighcourt.nic.in${url}`;
  return `https://www.delhihighcourt.nic.in/${url.replace(/^\.\//, '')}`;
}

module.exports = {
  maybeRefreshHighCourtJudgmentMatches,
  refreshHighCourtJudgmentMatches
};
