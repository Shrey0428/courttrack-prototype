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
const { fetchDelhiCaseHistory } = require('./delhiCaseHistory');
const { extractLatestOrderHearingDates } = require('./delhiOrders');
const { getPlaywrightLaunchOptions, getPlaywrightContextOptions, prepareLookupPage } = require('../playwrightProfile');

const CASE_STATUS_URL = 'https://delhihighcourt.nic.in/app/get-case-type-status';
const SITE_ORIGIN = 'https://delhihighcourt.nic.in';
const COURT_NAME = 'High Court of Delhi';
const DELHI_CASE_TYPES_TTL_MS = 12 * 60 * 60 * 1000;
let delhiCaseTypesCache = { items: null, expiresAt: 0 };

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

  async listCaseTypes() {
    const now = Date.now();
    if (delhiCaseTypesCache.items && delhiCaseTypesCache.expiresAt > now) {
      return delhiCaseTypesCache.items;
    }

    const response = await fetch(CASE_STATUS_URL, {
      headers: {
        'user-agent': 'CourtTrackPrototype/1.0 (+delhi case type options)'
      }
    });
    if (!response.ok) {
      throw new Error(`Delhi case types request returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const items = extractDelhiCaseTypesFromHtml(html);
    delhiCaseTypesCache = {
      items,
      expiresAt: now + DELHI_CASE_TYPES_TTL_MS
    };
    return items;
  }

  async startLookup({ caseType, caseNumber, year }) {
    if (!caseType || !caseNumber || !year) {
      throw new Error('Delhi case-status lookup requires case type, case number, and year.');
    }

    const browser = await chromium.launch(getPlaywrightLaunchOptions());
    const context = await browser.newContext(getPlaywrightContextOptions());
    const page = await context.newPage();
    await prepareLookupPage(page);

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

    const validationResponse = await captchaValidationPromise.catch((error) => {
      throw new Error(formatOfficialTimeout(error, 'Delhi CAPTCHA validation did not finish in time. Load a fresh CAPTCHA and try again.'));
    });
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

    const resultsResponse = await resultsResponsePromise.catch((error) => {
      throw new Error(formatOfficialTimeout(error, 'Delhi case-status results did not return in time. Load a fresh CAPTCHA and try again.'));
    });
    const resultsPayload = await readJsonResponse(resultsResponse);
    await page.waitForTimeout(800);

    return {
      status: 'success',
      caseData: await parseDelhiResult(page, input, resultsPayload)
    };
  }
}

function extractDelhiCaseTypesFromHtml(html) {
  const selectMatch = String(html || '').match(/<select[^>]*id="case_type"[\s\S]*?<\/select>/i);
  if (!selectMatch) {
    throw new Error('Could not find Delhi case-type dropdown on the official page.');
  }

  return [...selectMatch[0].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
    .map(([, value, label]) => ({
      value: String(value || '').trim(),
      label: String(label || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    }))
    .filter((option) => option.value);
}

function formatOfficialTimeout(error, fallbackMessage) {
  const message = String(error?.message || error || '');
  if (/Timeout|waitForResponse|waiting for event "response"/i.test(message)) {
    return fallbackMessage;
  }
  return message || fallbackMessage;
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
  const match = options.find((option) => normalizeOption(option.value) === target || normalizeOption(option.text) === target);

  if (!match) {
    throw new Error(`Could not find Delhi ${fieldName} "${value}" in the official dropdown.`);
  }

  await selectLocator.selectOption(match.value || { label: match.text });
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

async function parseDelhiResult(page, input, resultsPayload) {
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
      courtNumber: '',
      caseStatus: 'No matching case found in the official Delhi case-status search results',
      lastOrderDate: '',
      officialSourceUrl: sourceUrl,
      sourceUrl,
      pageTitle,
      rawTextPreview,
      invalidCaptchaDetected: false,
      rawMetadata: {
        resultsCount: rows.length,
        results: rows
      }
    };
  }

  const { listingDate, lastDate, courtNumber } = parseListingCell(bestRow.listingDateAndCourtNo);
  const orderHearing = await extractLatestOrderHearingDates(bestRow.links.ordersUrl);
  const orderDerivedDate = orderHearing.parsed ? orderHearing.nextHearingDate : '';
  const nextHearingDate = orderDerivedDate || listingDate;
  const nextHearingDateSource = orderDerivedDate ? 'latest_order' : (listingDate ? 'case_status_page' : '');
  const caseHistory = await fetchDelhiCaseHistory(input);

  return {
    provider: 'delhiManualCaptcha',
    caseFound: true,
    courtName: COURT_NAME,
    caseNumber: bestRow.caseNumber || formatCaseNumber(input),
    cnrNumber: '',
    caseTitle: bestRow.parties || '',
    nextHearingDate,
    statusPageNextHearingDate: listingDate,
    nextHearingDateSource,
    courtNumber,
    caseStatus: bestRow.caseStatus || 'Found in official Delhi case-status results',
    lastOrderDate: orderHearing.latestOrder?.orderDate || lastDate,
    officialSourceUrl: sourceUrl,
    sourceUrl,
    ordersUrl: bestRow.links.ordersUrl,
    judgmentsUrl: bestRow.links.judgmentsUrl,
    caseHistoryUrl: caseHistory.caseHistoryUrl,
    filingsUrl: caseHistory.filingsUrl,
    listingsUrl: caseHistory.listingsUrl,
    caseHistory: {
      filings: caseHistory.filings,
      listings: caseHistory.listings
    },
    latestOrderUrl: orderHearing.latestOrder?.pdfUrl || '',
    latestOrderDate: orderHearing.latestOrder?.orderDate || '',
    pageTitle,
    rawTextPreview,
    invalidCaptchaDetected: false,
    rawMetadata: {
      resultsCount: rows.length,
      results: rows,
      statusPageListingDate: listingDate,
      statusPageLastDate: lastDate,
      latestOrderHearingExtraction: orderHearing,
      caseHistoryExtraction: caseHistory
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

function pickBestRow(rows, input) {
  if (!rows.length) return null;

  const expectedCaseNumber = normalizeSearchText(formatCaseNumber(input));
  const matched = rows.find((row) => normalizeSearchText(row.caseNumber || row.caseNumberAndStatus).includes(expectedCaseNumber));
  return matched || rows[0];
}

function parseListingCell(value) {
  const text = sanitizeText(value);
  const nextDateMatch = text.match(/next\s+date\s*:\s*(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i);
  const lastDateMatch = text.match(/last\s+date\s*:\s*(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i);
  const fallbackDateMatch = text.match(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/);
  const courtMatch = text.match(/court\s*no\.?\s*[:\-]?\s*([a-z0-9-]+)/i);

  return {
    listingDate: nextDateMatch ? normalizeListingDate(nextDateMatch[1]) : '',
    lastDate: lastDateMatch ? normalizeListingDate(lastDateMatch[1]) : (fallbackDateMatch ? normalizeListingDate(fallbackDateMatch[0]) : ''),
    courtNumber: courtMatch ? courtMatch[1].trim().toUpperCase() : ''
  };
}

function normalizeListingDate(value) {
  const match = String(value || '').match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (!match) return '';
  return [
    match[1].padStart(2, '0'),
    match[2].padStart(2, '0'),
    match[3]
  ].join('-');
}

function extractCaseNumber(value) {
  const text = sanitizeText(value);
  const match = text.match(/[A-Z.() -]*\d+[A-Z.() /-]*\/\d{4}/i);
  return match ? sanitizeText(match[0]) : '';
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
    judgmentsUrl: ''
  };

  for (const match of String(html || '').matchAll(/<a[^>]*href\s*=\s*['"]?([^'" >]+)['"]?[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolutizeUrl(match[1]);
    const text = sanitizeText(match[2]).toLowerCase();

    if (text.includes('order')) {
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

function formatCaseNumber(input) {
  return `${input.caseType} ${input.caseNumber}/${input.year}`;
}

function normalizeOption(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
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
