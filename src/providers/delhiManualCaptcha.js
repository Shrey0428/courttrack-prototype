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
      caseData: await parseDelhiResult(page, input, resultsPayload)
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

  const { listingDate, courtNumber } = parseListingCell(bestRow.listingDateAndCourtNo);

  return {
    provider: 'delhiManualCaptcha',
    caseFound: true,
    courtName: COURT_NAME,
    caseNumber: bestRow.caseNumber || formatCaseNumber(input),
    cnrNumber: '',
    caseTitle: bestRow.parties || '',
    nextHearingDate: listingDate,
    courtNumber,
    caseStatus: bestRow.caseStatus || 'Found in official Delhi case-status results',
    lastOrderDate: '',
    officialSourceUrl: sourceUrl,
    sourceUrl,
    ordersUrl: bestRow.links.ordersUrl,
    judgmentsUrl: bestRow.links.judgmentsUrl,
    pageTitle,
    rawTextPreview,
    invalidCaptchaDetected: false,
    rawMetadata: {
      resultsCount: rows.length,
      results: rows
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
  const dateMatch = text.match(/\b\d{2}[-/]\d{2}[-/]\d{4}\b/);
  const courtMatch = text.match(/court\s*no\.?\s*[:\-]?\s*([a-z0-9-]+)/i);

  return {
    listingDate: dateMatch ? dateMatch[0].replace(/\//g, '-') : text,
    courtNumber: courtMatch ? courtMatch[1].trim().toUpperCase() : ''
  };
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
