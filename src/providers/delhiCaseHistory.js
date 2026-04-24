const SITE_ORIGIN = 'https://delhihighcourt.nic.in';
const CASE_HISTORY_URL = `${SITE_ORIGIN}/app/get-case-wise`;

async function fetchDelhiCaseHistory(input) {
  if (!input?.caseType || !input?.caseNumber || !input?.year) {
    return emptyHistory('Case history lookup requires case type, case number, and year.');
  }

  try {
    const caseHistoryUrl = await fetchCaseHistoryUrl(input);
    if (!caseHistoryUrl) {
      return emptyHistory('No case-history link was found for this case.');
    }

    const response = await fetch(caseHistoryUrl, {
      headers: { 'user-agent': 'CourtTrackPrototype/1.0 (+case history parser)' }
    });
    if (!response.ok) {
      return {
        ...emptyHistory(`Case-history page failed with HTTP ${response.status}.`),
        caseHistoryUrl,
        filingsUrl: caseHistoryUrl,
        listingsUrl: caseHistoryUrl
      };
    }

    const html = await response.text();
    const tables = extractTables(html);
    const filings = parseFilingsTable(tables[0] || '');
    const listings = parseListingsTable(tables[1] || '');

    return {
      parsed: true,
      reason: '',
      caseHistoryUrl,
      filingsUrl: caseHistoryUrl,
      listingsUrl: caseHistoryUrl,
      filings,
      listings,
      rawTextPreview: cleanHtmlText(html).slice(0, 1800)
    };
  } catch (error) {
    return emptyHistory(error.message);
  }
}

async function fetchCaseHistoryUrl(input) {
  const url = new URL(CASE_HISTORY_URL);
  url.searchParams.set('draw', '1');
  url.searchParams.set('start', '0');
  url.searchParams.set('length', '50');
  url.searchParams.set('case_type', input.caseType);
  url.searchParams.set('case_number', input.caseNumber);
  url.searchParams.set('case_year', input.year);

  const response = await fetch(url, {
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      'user-agent': 'CourtTrackPrototype/1.0 (+case history lookup)'
    }
  });
  if (!response.ok) {
    throw new Error(`Case-history search failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const expected = normalizeCaseKey(`${input.caseType}-${input.caseNumber}/${input.year}`);
  const matched = rows.find((row) => normalizeCaseKey(cleanHtmlText(row.ctype || '')).includes(expected)) || rows[0];
  return extractCaseHistoryLink(matched?.ctype || '');
}

function extractCaseHistoryLink(html) {
  const match = String(html || '').match(/href\s*=\s*['"]?([^'" >]+online-cause-history[^'" >]*)['"]?/i);
  return match ? absolutizeUrl(match[1].replace(/\\\//g, '/')) : '';
}

function parseFilingsTable(tableHtml) {
  return extractBodyRows(tableHtml).map((cells) => ({
    serialNumber: cells[0]?.text || '',
    date: normalizeDate(cells[1]?.text || ''),
    details: cells[2]?.text || '',
    diaryNumber: extractDiaryNumber(cells[2]?.text || ''),
    status: extractStatus(cells[2]?.text || '')
  })).filter((row) => row.date || row.details);
}

function parseListingsTable(tableHtml) {
  return extractBodyRows(tableHtml).map((cells) => ({
    serialNumber: cells[0]?.text || '',
    date: normalizeDate(cells[1]?.text || ''),
    details: cells[2]?.text || '',
    orderUrl: cells[1]?.links?.[0] || ''
  })).filter((row) => row.date || row.details || row.orderUrl);
}

function extractTables(html) {
  return [...String(html || '').matchAll(/<table[\s\S]*?<\/table>/gi)].map((match) => match[0]);
}

function extractBodyRows(tableHtml) {
  const tbody = String(tableHtml || '').match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || tableHtml;
  return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) => [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cellMatch) => parseCell(cellMatch[1])))
    .filter((cells) => cells.length);
}

function parseCell(html) {
  return {
    text: cleanHtmlText(html),
    links: extractLinks(html)
  };
}

function extractLinks(html) {
  return [...String(html || '').matchAll(/<a[^>]*href\s*=\s*['"]?([^'" >]+)['"]?[^>]*>/gi)]
    .map((match) => absolutizeUrl(match[1].replace(/\\\//g, '/')))
    .filter(Boolean);
}

function extractDiaryNumber(text) {
  return String(text || '').match(/diary\s+no\s*:\s*([0-9/ -]+)/i)?.[1]?.trim() || '';
}

function extractStatus(text) {
  return String(text || '').match(/\(status\s*:\s*([^)]+)\)/i)?.[1]?.trim() || '';
}

function normalizeDate(value) {
  const match = String(value || '').match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (!match) return cleanHtmlText(value);
  return [
    match[1].padStart(2, '0'),
    match[2].padStart(2, '0'),
    match[3]
  ].join('-');
}

function cleanHtmlText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCaseKey(value) {
  return cleanHtmlText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function absolutizeUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${SITE_ORIGIN}${url}`;
  return `${SITE_ORIGIN}/${url.replace(/^\.\//, '')}`;
}

function emptyHistory(reason) {
  return {
    parsed: false,
    reason,
    caseHistoryUrl: '',
    filingsUrl: '',
    listingsUrl: '',
    filings: [],
    listings: [],
    rawTextPreview: ''
  };
}

module.exports = {
  fetchDelhiCaseHistory
};
