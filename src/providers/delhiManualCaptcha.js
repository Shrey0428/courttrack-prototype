const { chromium } = require('playwright');
const BaseProvider = require('./base');
const {
  getCaseTypeDropdown,
  getCaseNumberInput,
  getYearDropdown,
  getCaptchaInput,
  getSubmitButton,
  getCaptchaImage,
  getResultsTable
} = require('./delhiCaseStatusSelectors');

const CASE_STATUS_URL = 'https://delhihighcourt.nic.in/app/get-case-type-status';
const CASE_HISTORY_SEARCH_URL = 'https://delhihighcourt.nic.in/app/get-case-wise';
const SITE_ORIGIN = 'https://delhihighcourt.nic.in';
const COURT_NAME = 'High Court of Delhi';

class DelhiManualCaptchaProvider extends BaseProvider {
  constructor() {
    super('delhiManualCaptcha');
  }

  get key() {
    return this.name;
  }

  get label() {
    return 'Delhi High Court (case status + manual CAPTCHA)';
  }

  requiresManualCaptcha() {
    return true;
  }

  async fetchCase() {
    throw new Error('Delhi case-status lookups require the manual CAPTCHA flow.');
  }

  async listLookupOptions() {
    const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== 'false' });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(CASE_STATUS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      const caseTypes = await readSelectOptions(await getCaseTypeDropdown(page));
      const years = await readSelectOptions(await getYearDropdown(page));

      return {
        sourceUrl: CASE_STATUS_URL,
        caseTypes,
        years
      };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  async startLookup({ caseType, caseNumber, year }) {
    if (!caseType || !caseNumber || !year) {
      throw new Error('Delhi case-status lookup requires case type, case number, and year.');
    }

    const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== 'false' });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(CASE_STATUS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    await selectDelhiOption(await getCaseTypeDropdown(page), caseType, 'case type');
    await (await getCaseNumberInput(page)).fill(String(caseNumber).trim());
    await selectDelhiOption(await getYearDropdown(page), String(year), 'year');

    const captchaLocator = await getCaptchaImage(page);
    await captchaLocator.waitFor({ state: 'visible', timeout: 15000 });
    const captchaPng = await captchaLocator.screenshot({ type: 'png' });

    return {
      browser,
      context,
      page,
      input: {
        caseType: String(caseType).trim(),
        caseNumber: String(caseNumber).trim(),
        year: String(year).trim()
      },
      preview: {
        captchaImageBase64: captchaPng.toString('base64'),
        instructions: 'Solve the CAPTCHA shown from the official Delhi High Court case-wise status page, then submit it here to finish the lookup.',
        sourceUrl: CASE_STATUS_URL
      }
    };
  }

  async completeLookup(session, captchaText) {
    if (!session?.page) {
      throw new Error('Lookup session is missing or expired.');
    }

    const cleanedCaptcha = String(captchaText || '').trim();
    if (!cleanedCaptcha) {
      throw new Error('CAPTCHA text is required.');
    }

    const { page, input } = session;
    const captchaValidationPromise = waitForCaptchaValidation(page);
    const resultsResponsePromise = waitForResultsResponse(page);

    await (await getCaptchaInput(page)).fill(cleanedCaptcha);
    await (await getSubmitButton(page)).click();

    const validationResponse = await captchaValidationPromise;
    const validationPayload = await readJsonResponse(validationResponse);

    if (!validationPayload?.success) {
      return {
        status: 'invalidCaptcha',
        debug: await buildDebugPayload(page, input, {
          invalidCaptchaDetected: true,
          message: 'Invalid CAPTCHA. Start a new lookup to load a fresh official CAPTCHA.'
        })
      };
    }

    const resultsResponse = await resultsResponsePromise;
    const resultsPayload = await readJsonResponse(resultsResponse);
    await page.waitForTimeout(800);

    return {
      status: 'success',
      caseData: await parseDelhiResult(page, input, resultsPayload, cleanedCaptcha)
    };
  }
}

async function selectDelhiOption(selectLocator, value, fieldName) {
  const exactValue = String(value).trim();
  const exactSelected = await selectLocator.selectOption({ value: exactValue }).catch(() => []);
  if (exactSelected.length) return;

  const options = await selectLocator.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: node.getAttribute('value') || '',
      text: node.textContent || ''
    }))
  );

  const target = normalizeOption(exactValue);
  const flexibleTarget = normalizeFlexibleOption(exactValue);
  const match = options.find((option) => normalizeOption(option.value) === target || normalizeOption(option.text) === target) ||
    options.find((option) => normalizeFlexibleOption(option.value) === flexibleTarget || normalizeFlexibleOption(option.text) === flexibleTarget) ||
    options.find((option) => normalizeFlexibleOption(option.value).includes(flexibleTarget) || normalizeFlexibleOption(option.text).includes(flexibleTarget)) ||
    options.find((option) => flexibleTarget.includes(normalizeFlexibleOption(option.value)) || flexibleTarget.includes(normalizeFlexibleOption(option.text)));

  if (!match) {
    throw new Error(`Could not find Delhi ${fieldName} "${value}" in the official dropdown.`);
  }

  await selectLocator.selectOption(match.value || { label: match.text });
}

async function readSelectOptions(selectLocator) {
  return selectLocator.locator('option').evaluateAll((nodes) =>
    nodes
      .map((node) => ({
        value: node.getAttribute('value') || '',
        label: (node.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter((option) => option.value && option.label)
  );
}

function waitForCaptchaValidation(page) {
  return page.waitForResponse((response) => {
    return response.url().includes('/validateCaptcha') && response.request().method() === 'POST';
  }, { timeout: 20000 });
}

function waitForResultsResponse(page) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return response.url().startsWith(CASE_STATUS_URL) &&
      request.method() === 'GET' &&
      request.resourceType() === 'xhr' &&
      response.url().includes('draw=');
  }, { timeout: 20000 });
}

async function parseDelhiResult(page, input, resultsPayload, captchaText) {
  await getResultsTable(page);

  const pageTitle = await page.title().catch(() => '');
  const sourceUrl = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const rawTextPreview = sanitizeText(bodyText).slice(0, 3000);
  const rows = extractResultRows(resultsPayload);
  const bestRow = pickBestRow(rows, input);

  if (!bestRow) {
    return {
      provider: 'delhiManualCaptcha',
      caseFound: false,
      courtName: COURT_NAME,
      caseNumber: formatCaseNumber(input),
      cnrNumber: '',
      caseTitle: '',
      nextHearingDate: '',
      statusPageNextHearingDate: '',
      nextHearingDateSource: 'case_status_page',
      courtNumber: '',
      caseStatus: 'No matching case found in the official Delhi case-status search results',
      lastOrderDate: '',
      officialSourceUrl: sourceUrl,
      sourceUrl,
      ordersUrl: '',
      judgmentsUrl: '',
      caseHistoryUrl: '',
      filingsUrl: '',
      listingsUrl: '',
      caseHistory: { filings: [], listings: [], hearings: [], orders: [], rawTables: [] },
      latestOrderUrl: '',
      latestOrderDate: '',
      pageTitle,
      rawTextPreview,
      invalidCaptchaDetected: false,
      rawMetadata: {
        resultsCount: rows.length,
        results: rows
      }
    };
  }

  const { listingDate, courtNumber } = parseListingCell(bestRow.listingDateAndCourtNo);
  const latestOrderDate = extractLastOrderDate(bestRow.listingDateAndCourtNo);
  const caseNumber = bestRow.caseNumber || formatCaseNumber(input);
  const historyLookup = await fetchDelhiCaseHistory(page, input, captchaText).catch((error) => ({
    caseHistoryUrl: '',
    filingsUrl: '',
    listingsUrl: '',
    caseHistory: emptyCaseHistory(),
    summary: {},
    rawMetadata: {
      error: error.message || String(error)
    }
  }));
  const summary = historyLookup.summary || {};

  return {
    provider: 'delhiManualCaptcha',
    caseFound: true,
    courtName: COURT_NAME,
    caseNumber: summary.caseNumber || caseNumber,
    cnrNumber: summary.cnrNumber || '',
    caseTitle: summary.caseTitle || bestRow.parties || '',
    nextHearingDate: listingDate,
    statusPageNextHearingDate: listingDate,
    nextHearingDateSource: 'case_status_page',
    courtNumber: summary.courtNumber || courtNumber,
    caseStatus: summary.caseStatus || bestRow.caseStatus || 'Found in official Delhi case-status results',
    firstHearingDate: summary.firstHearingDate || '',
    lastOrderDate: summary.lastOrderDate || latestOrderDate,
    officialSourceUrl: sourceUrl,
    sourceUrl,
    ordersUrl: bestRow.links.ordersUrl,
    judgmentsUrl: bestRow.links.judgmentsUrl,
    caseHistoryUrl: historyLookup.caseHistoryUrl || '',
    filingsUrl: historyLookup.filingsUrl || '',
    listingsUrl: historyLookup.listingsUrl || '',
    caseHistory: historyLookup.caseHistory || emptyCaseHistory(),
    latestOrderUrl: '',
    latestOrderDate: summary.lastOrderDate || latestOrderDate,
    pageTitle,
    rawTextPreview,
    invalidCaptchaDetected: false,
    rawMetadata: {
      resultsCount: rows.length,
      results: rows,
      historyLookup: historyLookup.rawMetadata || {}
    }
  };
}

function extractResultRows(resultsPayload) {
  const rows = Array.isArray(resultsPayload?.data) ? resultsPayload.data : [];
  return rows
    .map((row) => ({
      serialNumber: cleanHtmlText(row.DT_RowIndex || row[0] || ''),
      caseNumberHtml: String(row.ctype || row[1] || ''),
      caseNumberAndStatus: cleanHtmlText(row.ctype || row[1] || ''),
      parties: cleanHtmlText(row.pet || row[2] || ''),
      listingDateAndCourtNo: cleanHtmlText(row.orderdate || row[3] || '')
    }))
    .map((row) => ({
      ...row,
      caseNumber: extractCaseNumber(row.caseNumberAndStatus),
      caseStatus: extractStatus(row.caseNumberAndStatus),
      links: extractLinksFromHtml(row.caseNumberHtml)
    }))
    .filter((row) => row.caseNumberAndStatus || row.parties || row.listingDateAndCourtNo);
}

function extractHistorySearchRows(resultsPayload) {
  const rows = Array.isArray(resultsPayload?.data) ? resultsPayload.data : [];
  return rows
    .map((row) => ({
      serialNumber: cleanHtmlText(row.DT_RowIndex || row[0] || ''),
      caseNumberHtml: String(row.ctype || row[1] || ''),
      caseNumberAndStatus: cleanHtmlText(row.ctype || row[1] || ''),
      parties: cleanHtmlText(row.pet_name || row.pet || row[2] || '')
    }))
    .map((row) => ({
      ...row,
      caseNumber: extractCaseNumber(row.caseNumberAndStatus),
      caseStatus: extractStatus(row.caseNumberAndStatus),
      links: extractLinksFromHtml(row.caseNumberHtml)
    }))
    .filter((row) => row.caseNumberAndStatus || row.parties);
}

function pickBestRow(rows, input) {
  if (!rows.length) return null;

  const expectedCaseNumber = normalizeSearchText(formatCaseNumber(input));
  const matched = rows.find((row) => normalizeSearchText(row.caseNumber || row.caseNumberAndStatus).includes(expectedCaseNumber));
  return matched || rows[0];
}

function parseListingCell(value) {
  const text = sanitizeText(value);
  const nextDateMatch = text.match(/next\s*date\s*:\s*(\d{1,2}[-/]\d{1,2}[-/]\d{4}|na)/i);
  const courtMatch = text.match(/court\s*no\.?\s*[:\-]?\s*([a-z0-9-]+)/i);
  const fallbackDateMatch = text.match(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/);
  const nextDate = nextDateMatch ? nextDateMatch[1] : '';
  const normalizedNextDate = nextDate && !/^na$/i.test(nextDate)
    ? nextDate.replace(/\//g, '-').replace(/\b(\d{1})([-/])/g, '0$1$2').replace(/-(\d)(-)/g, '-0$1$2')
    : '';

  return {
    listingDate: normalizedNextDate || (fallbackDateMatch ? fallbackDateMatch[0].replace(/\//g, '-') : ''),
    courtNumber: courtMatch ? courtMatch[1].trim().toUpperCase() : ''
  };
}

function extractCaseNumber(value) {
  const text = sanitizeText(value);
  const match = text.match(/[A-Z.() -]+[- ]\s*\d+\s*\/\s*\d{4}/i);
  if (!match) return '';
  return sanitizeText(match[0]).replace(/\s*-\s*/, ' ').replace(/\s*\/\s*/, '/');
}

function extractLastOrderDate(value) {
  const text = sanitizeText(value);
  const match = text.match(/last\s*date\s*:\s*(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i);
  return match ? match[1].replace(/\//g, '-') : '';
}

function extractStatus(value) {
  const text = sanitizeText(value);
  const bracketMatch = text.match(/\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1].trim();

  const tailMatch = text.match(/status\s*[:\-]?\s*([a-z0-9 ,./()-]+)/i);
  return tailMatch ? sanitizeText(tailMatch[1]) : '';
}

function cleanHtmlText(value) {
  return sanitizeText(
    String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
  );
}

function extractLinksFromHtml(html) {
  const links = {
    ordersUrl: '',
    judgmentsUrl: '',
    caseHistoryUrl: ''
  };

  for (const match of String(html || '').matchAll(/<a[^>]*href\s*=\s*['"]?([^'" >]+)['"]?[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolutizeUrl(match[1]);
    const text = sanitizeText(match[2]).toLowerCase();

    if (url.includes('/online-cause-history/')) {
      links.caseHistoryUrl = url;
    } else if (text.includes('order')) {
      links.ordersUrl = url;
    } else if (text.includes('judgment')) {
      links.judgmentsUrl = url;
    }
  }

  return links;
}

function absolutizeUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${SITE_ORIGIN}${url}`;
  return `${SITE_ORIGIN}/${url.replace(/^\.\//, '')}`;
}

async function readJsonResponse(response) {
  if (!response) return null;
  return response.json().catch(() => null);
}

async function buildDebugPayload(page, input, extras = {}) {
  const pageTitle = await page.title().catch(() => '');
  const sourceUrl = page.url();
  const rawTextPreview = sanitizeText(await page.locator('body').innerText().catch(() => '')).slice(0, 3000);

  return {
    provider: 'delhiManualCaptcha',
    caseFound: false,
    courtName: COURT_NAME,
    caseNumber: formatCaseNumber(input),
    cnrNumber: '',
    caseTitle: '',
    nextHearingDate: '',
    courtNumber: '',
    caseStatus: extras.message || 'Lookup failed',
    lastOrderDate: '',
    officialSourceUrl: sourceUrl,
    sourceUrl,
    pageTitle,
    rawTextPreview,
    invalidCaptchaDetected: !!extras.invalidCaptchaDetected,
    rawMetadata: {
      input
    }
  };
}

async function fetchDelhiCaseHistory(page, input, captchaText) {
  const result = {
    caseHistoryUrl: '',
    filingsUrl: '',
    listingsUrl: '',
    caseHistory: emptyCaseHistory(),
    summary: {},
    rawMetadata: {}
  };

  await page.goto(CASE_HISTORY_SEARCH_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  await selectDelhiOption(page.locator('#case_type'), input.caseType, 'case type');
  await page.locator('#case_number').fill(String(input.caseNumber).trim());
  await selectDelhiOption(page.locator('#year'), String(input.year), 'year');

  let historyResultsPayload = await requestCaseHistoryResults(page, input);
  if (!Array.isArray(historyResultsPayload?.data) || !historyResultsPayload.data.length) {
    historyResultsPayload = await tryDrawCaseHistoryTable(page);
  }
  if (!Array.isArray(historyResultsPayload?.data) || !historyResultsPayload.data.length) {
    historyResultsPayload = await submitCaseHistorySearch(page, captchaText);
  }

  const rows = extractHistorySearchRows(historyResultsPayload);
  let bestRow = pickBestRow(rows, input);

  if (!bestRow?.links?.caseHistoryUrl) {
    const href = await page
      .locator('#caseTable tbody tr td:nth-child(2) a[href*="/online-cause-history/"]')
      .first()
      .getAttribute('href')
      .catch(() => '');
    if (href) {
      bestRow = {
        ...(bestRow || {}),
        links: {
          ...(bestRow?.links || {}),
          caseHistoryUrl: absolutizeUrl(href)
        }
      };
    }
  }

  const caseHistoryUrl = bestRow?.links?.caseHistoryUrl || '';
  if (!caseHistoryUrl) {
    return {
      ...result,
      rawMetadata: {
        resultsCount: rows.length,
        results: rows,
        caseHistoryFound: false
      }
    };
  }

  await page.goto(caseHistoryUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.locator('#printable-area').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  const parsed = await parseDelhiCaseHistoryPage(page);
  return {
    caseHistoryUrl,
    filingsUrl: caseHistoryUrl,
    listingsUrl: caseHistoryUrl,
    caseHistory: parsed.caseHistory,
    summary: parsed.summary,
    rawMetadata: {
      resultsCount: rows.length,
      results: rows,
      caseHistoryFound: true
    }
  };
}

async function tryDrawCaseHistoryTable(page) {
  const resultsPromise = waitForHistoryResultsResponse(page).catch(() => null);
  await page.evaluate(() => {
    const table = window.jQuery && window.jQuery('#caseTable').DataTable ? window.jQuery('#caseTable').DataTable() : null;
    if (table) table.draw();
  }).catch(() => {});
  const response = await resultsPromise;
  return readJsonResponse(response);
}

async function requestCaseHistoryResults(page, input) {
  const response = await page.context().request.get(CASE_HISTORY_SEARCH_URL, {
    params: {
      draw: '1',
      start: '0',
      length: '10',
      case_type: String(input.caseType).trim(),
      case_number: String(input.caseNumber).trim(),
      case_year: String(input.year).trim()
    },
    headers: {
      'X-Requested-With': 'XMLHttpRequest'
    },
    timeout: 20000
  }).catch(() => null);

  if (!response || !response.ok()) {
    return null;
  }

  return response.json().catch(() => null);
}

async function submitCaseHistorySearch(page, captchaText) {
  const captchaInput = String(captchaText || '').trim();
  if (!captchaInput) {
    return null;
  }

  await page.locator('#captchaInput').fill(captchaInput);

  const validationPromise = waitForCaptchaValidation(page).catch(() => null);
  const resultsPromise = waitForHistoryResultsResponse(page).catch(() => null);
  await page.locator('#search').click();

  const validationResponse = await validationPromise;
  const validationPayload = await readJsonResponse(validationResponse);
  if (validationPayload && !validationPayload.success) {
    return null;
  }

  const resultsResponse = await resultsPromise;
  return readJsonResponse(resultsResponse);
}

function waitForHistoryResultsResponse(page) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return response.url().startsWith(CASE_HISTORY_SEARCH_URL) &&
      request.method() === 'GET' &&
      request.resourceType() === 'xhr' &&
      response.url().includes('draw=');
  }, { timeout: 20000 });
}

async function parseDelhiCaseHistoryPage(page) {
  return page.evaluate(() => {
    const normalizeText = (value) => String(value || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    const normalizeCaseNumber = (value) => normalizeText(value).replace(/\s*-\s*/, ' ').replace(/\s*\/\s*/g, '/');
    const emptyCaseHistory = () => ({ filings: [], listings: [], hearings: [], orders: [], rawTables: [] });
    const container = document.querySelector('#printable-area');
    if (!container) {
      return { summary: {}, caseHistory: emptyCaseHistory() };
    }

    const summary = {};
    for (const label of Array.from(container.querySelectorAll('.form-group.group.row label'))) {
      const bold = label.querySelector('b');
      if (!bold) continue;
      const key = normalizeText(bold.textContent).replace(/\s*:\s*$/, '');
      if (!key) continue;
      const fullText = normalizeText(label.textContent);
      const value = normalizeText(fullText.replace(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*`), ''));
      if (value) summary[key] = value;
    }

    const partyNode = Array.from(container.querySelectorAll('.row.justify-content-center.mb-4 label'))
      .find((label) => /vs\./i.test(label.textContent || ''));
    const caseTitle = partyNode ? normalizeText(partyNode.textContent).replace(/\s*Vs\.\s*/i, ' VS. ') : '';

    const sectionTitles = Array.from(container.querySelectorAll('.listing-3d-box h5')).map((node) => normalizeText(node.textContent));
    const tables = Array.from(container.querySelectorAll('table.table.table-bordered'));
    const rawTables = tables.map((table, index) => {
      const columns = Array.from(table.querySelectorAll('thead th')).map((cell) => normalizeText(cell.textContent));
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((row) => {
        const cells = Array.from(row.querySelectorAll('td')).map((cell, cellIndex) => ({
          label: columns[cellIndex] || '',
          text: normalizeText(cell.textContent),
          links: Array.from(cell.querySelectorAll('a[href]')).map((link) => link.href).filter(Boolean),
          actions: []
        }));
        return {
          cells,
          text: normalizeText(row.textContent),
          links: cells.flatMap((cell) => cell.links),
          actions: []
        };
      });
      return {
        title: sectionTitles[index] || `Table ${index + 1}`,
        columns,
        rows
      };
    });

    const filingTable = rawTables.find((table) => /filing details/i.test(table.title)) || rawTables[0] || null;
    const listingTable = rawTables.find((table) => /listing details/i.test(table.title)) || rawTables[1] || null;

    const filings = filingTable
      ? filingTable.rows.map((row) => {
          const serialNumber = row.cells[0]?.text || '';
          const date = row.cells[1]?.text || '';
          const details = row.cells[2]?.text || '';
          const diaryMatch = details.match(/Diary No:\s*([A-Z0-9/.-]+)/i);
          const statusMatch = details.match(/\(Status:\s*([A-Z])\s*\)/i);
          return {
            serialNumber,
            date,
            details,
            diaryNumber: diaryMatch ? diaryMatch[1] : '',
            status: statusMatch ? statusMatch[1] : ''
          };
        }).filter((entry) => entry.serialNumber || entry.date || entry.details)
      : [];

    const listings = listingTable
      ? listingTable.rows.map((row) => ({
          serialNumber: row.cells[0]?.text || '',
          date: row.cells[1]?.text || '',
          details: row.cells[2]?.text || '',
          orderUrl: row.cells[1]?.links?.[0] || ''
        })).filter((entry) => entry.serialNumber || entry.date || entry.details)
      : [];

    const orders = listings
      .filter((entry) => entry.orderUrl)
      .map((entry) => ({
        serialNumber: entry.serialNumber,
        date: entry.date,
        details: entry.details,
        url: entry.orderUrl,
        sourceUrl: entry.orderUrl,
        action: null
      }));

    return {
      summary: {
        caseNumber: normalizeCaseNumber(summary['Case No'] || ''),
        cnrNumber: summary['CNR No.'] || '',
        caseTitle,
        caseStatus: summary.Status || '',
        firstHearingDate: summary['Date of First Filing'] || '',
        lastOrderDate: listings[1]?.date || listings[0]?.date || '',
        courtNumber: ''
      },
      caseHistory: {
        filings,
        listings,
        hearings: [],
        orders,
        rawTables
      }
    };
  });
}

function formatCaseNumber(input) {
  return `${input.caseType} ${input.caseNumber}/${input.year}`;
}

function emptyCaseHistory() {
  return { filings: [], listings: [], hearings: [], orders: [], rawTables: [] };
}

function normalizeOption(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFlexibleOption(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeSearchText(value) {
  return sanitizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = new DelhiManualCaptchaProvider();
