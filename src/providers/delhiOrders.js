const { pdfBufferToText } = require('../utils/pdfText');

const SITE_ORIGIN = 'https://delhihighcourt.nic.in';

async function extractLatestOrderHearingDates(ordersUrl) {
  if (!ordersUrl) {
    return emptyResult('No orders URL was available.');
  }

  try {
    const orders = await fetchOrderRows(ordersUrl);
    const latestOrder = pickLatestOrder(orders);
    if (!latestOrder?.pdfUrl) {
      return {
        ...emptyResult('No downloadable latest order PDF was found.'),
        ordersCount: orders.length
      };
    }

    const response = await fetch(latestOrder.pdfUrl);
    if (!response.ok) {
      return {
        ...emptyResult(`Latest order PDF download failed with HTTP ${response.status}.`),
        latestOrder,
        ordersCount: orders.length
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const text = await pdfBufferToText(buffer);
    const candidates = extractHearingDateCandidates(text);
    const preferred = pickPreferredCandidate(candidates);

    return {
      parsed: Boolean(preferred),
      confidence: preferred?.confidence || 'none',
      nextHearingDate: preferred?.date || '',
      candidates,
      latestOrder: {
        ...latestOrder,
        textPreview: sanitizeText(text).slice(0, 1800)
      },
      ordersCount: orders.length,
      reason: preferred ? '' : 'Latest order text did not contain a confident court hearing date.'
    };
  } catch (error) {
    return emptyResult(error.message);
  }
}

async function fetchOrderRows(ordersUrl) {
  const url = new URL(ordersUrl);
  url.searchParams.set('draw', '1');
  url.searchParams.set('start', '0');
  url.searchParams.set('length', '25');

  const response = await fetch(url, {
    headers: { 'x-requested-with': 'XMLHttpRequest' }
  });
  if (!response.ok) {
    throw new Error(`Order list request failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalizeOrderRow).filter((row) => row.pdfUrl || row.orderDate);
}

function normalizeOrderRow(row) {
  const pdfUrl = extractPdfUrl(row.case_no_order_link) || buildShowLogoUrl(row);
  const orderDate = normalizeDate(row.orddate || row.order_date?.display || '');
  const orderTimestamp = Number(row.order_date?.timestamp || 0) ? Number(row.order_date.timestamp) * 1000 : dateSortValue(orderDate);

  return {
    caseNumber: cleanHtmlText(row.caseno || row.case_no_order_link || ''),
    orderDate,
    orderTimestamp,
    pdfUrl,
    raw: {
      pdffilename: row.pdffilename || '',
      orderdate: row.orderdate || ''
    }
  };
}

function pickLatestOrder(orders) {
  return [...orders].sort((a, b) => {
    if (b.orderTimestamp !== a.orderTimestamp) return b.orderTimestamp - a.orderTimestamp;
    return String(b.orderDate).localeCompare(String(a.orderDate));
  })[0] || null;
}

function extractHearingDateCandidates(text) {
  const candidates = [];
  const seen = new Set();
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => sanitizeText(line))
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const lineContext = lines[index];
    const expandedContext = sanitizeText([lines[index], lines[index + 1]].filter(Boolean).join(' '));
    const context = findDates(lineContext).length ? lineContext : expandedContext;
    if (!isPossibleListingContext(context) || isExcludedContext(context)) continue;

    for (const match of findDates(context)) {
      const key = `${match.date}|${context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        date: match.date,
        confidence: scoreDateContext(context),
        context: trimContext(context),
        source: classifyDateContext(context)
      });
    }
  }

  return dedupeCandidates(candidates);
}

function pickPreferredCandidate(candidates) {
  const scored = [...candidates]
    .map((candidate, index) => ({ ...candidate, index, score: confidenceScore(candidate.confidence) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0];
  return best && best.score >= confidenceScore('high') ? best : null;
}

function findDates(text) {
  const matches = [];
  const numericDate = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g;
  const monthDate = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})\b/gi;

  for (const match of text.matchAll(numericDate)) {
    const date = formatDateParts(match[1], match[2], match[3]);
    if (date) matches.push({ raw: match[0], date });
  }

  for (const match of text.matchAll(monthDate)) {
    const date = formatDateParts(match[1], monthNumber(match[2]), match[3]);
    if (date) matches.push({ raw: match[0], date });
  }

  return matches;
}

function isPossibleListingContext(context) {
  return /(list|listed|listing|renotify|re-notify|post|posted|put up|next date|returnable|before the court|before court|before the learned|mediator|mediation|hearing)/i.test(context);
}

function isExcludedContext(context) {
  return /(downloaded from|authenticity|digitally signed|page \d+ of \d+|order is downloaded|date of order)/i.test(context) ||
    (/^\W*order\W/i.test(context) && !/(list|listed|next date|before|renotify|post|hearing)/i.test(context));
}

function scoreDateContext(context) {
  if (/\b(next date|next hearing date|returnable date)\b/i.test(context)) return 'high';
  if (/(list|listed|renotify|re-notify|post|posted|put up)( the matter)?.{0,60}before (the )?court\b/i.test(context)) return 'high';
  if (/\blist before (the )?court on\b/i.test(context)) return 'high';
  if (/(list|listed).{0,80}(mediator|mediation|registrar|joint registrar)/i.test(context)) return 'medium';
  if (/(mediator|mediation|registrar|joint registrar).{0,80}\bon\b/i.test(context)) return 'medium';
  return 'low';
}

function classifyDateContext(context) {
  if (/(mediator|mediation)/i.test(context)) return 'Mediation';
  if (/(registrar|joint registrar)/i.test(context)) return 'Registry';
  if (/(court)/i.test(context)) return 'Court';
  return 'Order text';
}

function dedupeCandidates(candidates) {
  const byDateAndSource = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.date}|${candidate.source}`;
    const existing = byDateAndSource.get(key);
    if (!existing || confidenceScore(candidate.confidence) > confidenceScore(existing.confidence)) {
      byDateAndSource.set(key, candidate);
    }
  }
  return Array.from(byDateAndSource.values()).sort((a, b) => {
    const scoreDiff = confidenceScore(b.confidence) - confidenceScore(a.confidence);
    if (scoreDiff) return scoreDiff;
    return dateSortValue(a.date) - dateSortValue(b.date);
  });
}

function confidenceScore(confidence) {
  return { high: 3, medium: 2, low: 1, none: 0 }[confidence] || 0;
}

function extractPdfUrl(html) {
  const match = String(html || '').match(/href\s*=\s*['"]?([^'" >]+\.pdf\/\d{4})['"]?/i);
  return match ? absolutizeUrl(match[1].replace(/\\\//g, '/')) : '';
}

function buildShowLogoUrl(row) {
  if (!row?.pdffilename) return '';
  const year = String(row.orderdate || row.orddate || '').match(/\b(20\d{2}|19\d{2})\b/)?.[1] || '';
  return year ? `${SITE_ORIGIN}/app/showlogo/${row.pdffilename}/${year}` : '';
}

function cleanHtmlText(value) {
  return sanitizeText(String(value || '').replace(/<[^>]+>/g, ' '));
}

function trimContext(context) {
  const text = sanitizeText(context);
  return text.length > 260 ? `${text.slice(0, 257)}...` : text;
}

function normalizeDate(value) {
  const [match] = findDates(String(value || ''));
  return match?.date || '';
}

function formatDateParts(day, month, year) {
  const dd = Number(day);
  const mm = Number(month);
  const yyyy = Number(year);
  if (!dd || !mm || !yyyy || mm > 12 || dd > 31) return '';

  const date = new Date(yyyy, mm - 1, dd);
  if (date.getFullYear() !== yyyy || date.getMonth() !== mm - 1 || date.getDate() !== dd) return '';

  return [
    String(dd).padStart(2, '0'),
    String(mm).padStart(2, '0'),
    String(yyyy)
  ].join('-');
}

function monthNumber(monthName) {
  return String(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(String(monthName).toLowerCase()) + 1);
}

function dateSortValue(value) {
  const match = String(value || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return 0;
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime();
}

function absolutizeUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${SITE_ORIGIN}${url}`;
  return `${SITE_ORIGIN}/${url.replace(/^\.\//, '')}`;
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyResult(reason) {
  return {
    parsed: false,
    confidence: 'none',
    nextHearingDate: '',
    candidates: [],
    latestOrder: null,
    ordersCount: 0,
    reason
  };
}

module.exports = {
  extractHearingDateCandidates,
  extractLatestOrderHearingDates,
  pickPreferredCandidate
};
