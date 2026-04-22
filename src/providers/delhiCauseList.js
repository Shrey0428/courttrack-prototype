const BaseProvider = require('./base');
const { pdfBufferToText } = require('../utils/pdfText');

const CAUSE_LIST_PAGE = 'https://delhihighcourt.nic.in/web/cause-lists/cause-list';
const SITE_ORIGIN = 'https://delhihighcourt.nic.in';

class DelhiCauseListProvider extends BaseProvider {
  constructor() {
    super('delhiCauseList');
  }

  async fetchCase({ cnrNumber, caseLookup }) {
    const target = (caseLookup || cnrNumber || '').trim();
    if (!target) throw new Error('Delhi provider requires a caseLookup or CNR value');

    const query = normalizeCaseKey(target);
    const candidates = buildLookupCandidates(target);
    const causeLists = await fetchCauseListEntries();
    const checked = [];

    for (const entry of causeLists) {
      try {
        const pdfText = await fetchPdfText(entry.pdfUrl);
        const match = findCaseInCauseList(pdfText, candidates);
        checked.push({ title: entry.title, listDate: entry.listDate, pdfUrl: entry.pdfUrl, matched: !!match });
        if (!match) continue;

        return {
          source: this.name,
          courtName: 'High Court of Delhi',
          caseNumber: match.matchedCaseNumber || target,
          cnrNumber: '',
          caseTitle: match.caseTitle || '',
          nextHearingDate: entry.listDate,
          courtNumber: match.courtNumber || '',
          caseStatus: 'Listed in official Delhi High Court cause list',
          lastOrderDate: '',
          officialSourceUrl: entry.pdfUrl,
          rawMetadata: {
            causeListTitle: entry.title,
            causeListDate: entry.listDate,
            searchedQuery: query,
            candidates,
            matchedLine: match.matchedLine,
            providerPage: CAUSE_LIST_PAGE,
            checkedCount: checked.length
          }
        };
      } catch (error) {
        checked.push({ title: entry.title, listDate: entry.listDate, pdfUrl: entry.pdfUrl, error: error.message });
        continue;
      }
    }

    return {
      source: this.name,
      courtName: 'High Court of Delhi',
      caseNumber: target,
      cnrNumber: '',
      caseTitle: '',
      nextHearingDate: '',
      courtNumber: '',
      caseStatus: 'Not found in latest official Delhi High Court cause lists',
      lastOrderDate: '',
      officialSourceUrl: CAUSE_LIST_PAGE,
      rawMetadata: {
        searchedQuery: query,
        candidates,
        causeListsChecked: checked
      }
    };
  }
}

async function fetchCauseListEntries() {
  const response = await fetch(CAUSE_LIST_PAGE, {
    headers: {
      'user-agent': 'CourtTrackPrototype/1.0 (+public cause list monitor)'
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch Delhi cause list page: ${response.status}`);

  const html = await response.text();
  const rows = [...html.matchAll(/<tr[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<\/tr>/gis)];
  const entries = [];

  for (const row of rows) {
    const title = stripTags(row[2]).replace(/\s+/g, ' ').trim();
    const listDate = normalizeDate(stripTags(row[3]).trim());
    const hrefMatch = row[0].match(/href="([^"]+\.pdf)"/i);
    const pdfUrl = hrefMatch ? absolutizeUrl(hrefMatch[1]) : '';
    if (!title || !listDate || !pdfUrl) continue;
    entries.push({ title, listDate, pdfUrl });
  }

  const seen = new Set();
  const deduped = entries.filter((e) => {
    const key = `${e.title}|${e.listDate}|${e.pdfUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => sortableDate(b.listDate) - sortableDate(a.listDate));
  return deduped.slice(0, 30);
}

async function fetchPdfText(pdfUrl) {
  const response = await fetch(pdfUrl, {
    headers: {
      'user-agent': 'CourtTrackPrototype/1.0 (+public cause list monitor)'
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return pdfBufferToText(Buffer.from(arrayBuffer));
}

function buildLookupCandidates(input) {
  const raw = input.trim();
  const normalized = normalizeCaseKey(raw);
  const compact = compactCaseKey(raw);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const candidates = new Set([
    raw.toUpperCase(),
    normalized,
    normalized.replace(/\s+/g, ''),
    normalized.replace(/\s*\/\s*/g, '/'),
    compact,
    tokens.join(' '),
    tokens.join('')
  ].filter(Boolean));
  return Array.from(candidates);
}

function findCaseInCauseList(text, candidates) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, '').trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const current = normalizeCaseKey(rawLine);
    const currentCompact = compactCaseKey(rawLine);
    const matched = candidates.find((candidate) => {
      const candidateCompact = compactCaseKey(candidate);
      return current.includes(candidate) || current.replace(/\s+/g, '').includes(candidate.replace(/\s+/g, '')) || (candidateCompact && currentCompact.includes(candidateCompact));
    });

    if (!matched) continue;

    const contextStart = Math.max(0, i - 30);
    const contextEnd = Math.min(lines.length, i + 8);
    const contextLines = lines.slice(contextStart, contextEnd);
    const courtNumber = extractCourtNumber(contextLines);
    const caseTitle = extractCaseTitle(lines, i);
    const matchedCaseNumber = extractCaseNumber(rawLine) || extractCaseNumber(current) || matched;

    return {
      matchedLine: rawLine,
      matchedCaseNumber,
      caseTitle,
      courtNumber
    };
  }

  return null;
}

function extractCourtNumber(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/COURT\s*NO\.?\s*[:\-]?\s*([A-Z0-9-]+)/i);
    if (match) return match[1];
  }
  return '';
}

function extractCaseTitle(lines, index) {
  for (let offset = 1; offset <= 3; offset += 1) {
    const line = lines[index + offset];
    if (!line) continue;
    if (/\bversus\b|\bvs\.?\b/i.test(line) || /\bpetitioner\b|\brespondent\b/i.test(line)) {
      return line.replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function extractCaseNumber(line) {
  const match = line.match(/[A-Z.()\-\s]+\d+[A-Z.()\-\s/]*\/\d{4}/i);
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}

function normalizeCaseKey(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/&AMP;/g, '&')
    .replace(/\u00A0/g, ' ')
    .replace(/[^A-Z0-9()/.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactCaseKey(value) {
  return normalizeCaseKey(value).replace(/[^A-Z0-9]/g, '');
}

function normalizeDate(value) {
  const m = String(value).match(/(\d{2})[-/.](\d{2})[-/.](\d{4})/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function sortableDate(value) {
  const [dd, mm, yyyy] = String(value).split('-').map(Number);
  if (!dd || !mm || !yyyy) return 0;
  return new Date(yyyy, mm - 1, dd).getTime();
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

function absolutizeUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${SITE_ORIGIN}${url}`;
  return `${SITE_ORIGIN}/${url.replace(/^\.\//, '')}`;
}

module.exports = new DelhiCauseListProvider();
