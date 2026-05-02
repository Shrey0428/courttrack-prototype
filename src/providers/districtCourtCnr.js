const { chromium } = require('playwright');
const BaseProvider = require('./base');
const { getDelhiDistrictSite } = require('../delhiDistrictSites');

const DISTRICT_NAVIGATION_TIMEOUT_MS = Number(process.env.DISTRICT_NAVIGATION_TIMEOUT_MS || 120000);
const DISTRICT_SELECTOR_TIMEOUT_MS = Number(process.env.DISTRICT_SELECTOR_TIMEOUT_MS || 30000);

class DistrictCourtCnrProvider extends BaseProvider {
  constructor() {
    super('districtCourtCnr');
  }

  get key() {
    return this.name;
  }

  get label() {
    return 'Delhi District Courts (case number + manual CAPTCHA)';
  }

  requiresManualCaptcha() {
    return true;
  }

  async fetchCase() {
    throw new Error('District court lookups require the manual CAPTCHA flow.');
  }

  async listLookupOptions(input) {
    const district = getDelhiDistrictSite(input?.districtSlug);
    if (!district) {
      throw new Error('Choose a Delhi district first.');
    }

    const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== 'false' });
    const context = await browser.newContext({
      userAgent: process.env.PLAYWRIGHT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    try {
      await prepareDistrictLookupPage(page);
      await gotoDistrictPage(page, district.url);

      const courtComplexes = await readSelectOptions(page.locator('#est_code'));
      const courtEstablishments = await readSelectOptions(page.locator('#court_establishment'));

      return {
        sourceUrl: district.url,
        districtSlug: district.slug,
        districtLabel: district.label,
        courtComplexes,
        courtEstablishments
      };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  async listCaseTypeOptions(input) {
    const district = getDelhiDistrictSite(input?.districtSlug);
    if (!district) {
      throw new Error('Choose a Delhi district first.');
    }

    const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== 'false' });
    const context = await browser.newContext({
      userAgent: process.env.PLAYWRIGHT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    try {
      await prepareDistrictLookupPage(page);
      await gotoDistrictPage(page, district.url);

      const prepared = prepareDistrictInput({
        districtSlug: district.slug,
        districtLabel: district.label,
        districtUrl: district.url,
        searchMode: input?.searchMode,
        courtComplex: input?.courtComplex,
        courtComplexValue: input?.courtComplexValue,
        courtEstablishment: input?.courtEstablishment,
        courtEstablishmentValue: input?.courtEstablishmentValue,
        caseNumber: '1',
        year: '2025'
      });

      await ensureDistrictCaseTypeDropdownReady(page, prepared);

      return {
        sourceUrl: district.url,
        caseTypes: await readSelectOptions(page.locator('#case_type'))
      };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  async startLookup(input) {
    const prepared = prepareDistrictInput(input);
    const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== 'false' });
    const context = await browser.newContext({
      userAgent: process.env.PLAYWRIGHT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    await prepareDistrictLookupPage(page);
    await gotoDistrictPage(page, prepared.districtUrl);

    await ensureDistrictCaseTypeDropdownReady(page, prepared);

    const captchaLocator = page.locator('img[id^="siwp_captcha_image_"]').first();
    await captchaLocator.waitFor({ state: 'visible', timeout: DISTRICT_SELECTOR_TIMEOUT_MS });
    const captchaPng = await captchaLocator.screenshot({ type: 'png' });

    return {
      browser,
      context,
      page,
      input: prepared,
      preview: {
        captchaImageBase64: captchaPng.toString('base64'),
        instructions: `Solve the official CAPTCHA from the ${prepared.districtLabel} case-number page, then submit it here to finish the lookup.`,
        sourceUrl: prepared.districtUrl
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

    if (input.caseType) {
      await ensureDistrictCaseTypeDropdownReady(page, input);
      await selectCaseType(page, input.caseType);
    }

    await page.fill('#reg_no', input.caseNumber);
    await page.fill('#reg_year', input.year);
    await page.fill('#siwp_captcha_value_0', cleanedCaptcha);

    const responsePromise = page.waitForResponse((response) => {
      const request = response.request();
      const postData = request.postData() || '';
      return request.method() === 'POST' &&
        response.url().includes('/wp-admin/admin-ajax.php') &&
        postData.includes('action=get_cases');
    }, { timeout: 30000 });

    await page.locator('input[name="submit"]').click();
    const response = await responsePromise;
    const payload = await response.json();

    if (!payload?.success) {
      const message = extractAjaxMessage(payload);
      if (/captcha/i.test(message)) {
        return {
          status: 'invalidCaptcha',
          debug: {
            provider: this.name,
            caseFound: false,
            invalidCaptchaDetected: true,
            caseStatus: message || 'Invalid CAPTCHA. Please load a fresh district CAPTCHA and try again.',
            officialSourceUrl: input.districtUrl,
            sourceUrl: input.districtUrl,
            rawTextPreview: message
          }
        };
      }

      return {
        status: 'success',
        caseData: buildDistrictNotFound(input, message)
      };
    }

    const searchResults = await parseSearchResults(page, payload.data, input);
    const selectedResult = pickDistrictSearchResult(searchResults.rows, input);

    if (!selectedResult) {
      return {
        status: 'success',
        caseData: buildDistrictNotFound(input, 'No matching district case was returned by the official search results.', searchResults)
      };
    }

    const detailPayload = await page.evaluate(async (data) => {
      const response = await fetch('/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          cino: data.cno,
          est_code: data.estCode,
          action: 'get_cnr_details',
          es_ajax_request: '1'
        })
      });
      return response.json();
    }, { cno: selectedResult.cno, estCode: selectedResult.estCode });

    if (!detailPayload?.success) {
      return {
        status: 'success',
        caseData: buildDistrictNotFound(input, extractAjaxMessage(detailPayload), searchResults)
      };
    }

    const detail = await parseDistrictDetails(page, detailPayload.data, {
      input,
      selectedResult,
      searchResults
    });

    return {
      status: 'success',
      caseData: detail
    };
  }
}

async function gotoDistrictPage(page, url) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: DISTRICT_NAVIGATION_TIMEOUT_MS });
      await page.locator('body').waitFor({ state: 'attached', timeout: DISTRICT_SELECTOR_TIMEOUT_MS }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});

      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      if (/ERR_CONNECTION_TIMED_OUT|This site can[’']?t be reached|connection timed out/i.test(bodyText)) {
        throw new Error(`District court page did not load correctly at ${url}.`);
      }

      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await page.waitForTimeout(1500).catch(() => {});
      }
    }
  }

  const message = String(lastError?.message || '').replace(/\s+/g, ' ').trim();
  throw new Error(`District court page could not be opened in time. ${message || url}`);
}

async function ensureDistrictCaseTypeDropdownReady(page, input) {
  const searchMode = input?.searchMode === 'courtEstablishment' ? 'courtEstablishment' : 'courtComplex';
  const targetSelector = searchMode === 'courtEstablishment' ? '#court_establishment' : '#est_code';
  const targetValue = searchMode === 'courtEstablishment'
    ? String(input?.courtEstablishmentValue || '').trim()
    : String(input?.courtComplexValue || '').trim();
  const targetLabel = searchMode === 'courtEstablishment'
    ? String(input?.courtEstablishment || '').trim()
    : String(input?.courtComplex || '').trim();

  if (!targetValue) {
    throw new Error(`Choose a valid ${searchMode === 'courtEstablishment' ? 'court establishment' : 'court complex'} for the selected district.`);
  }

  await page.locator(searchMode === 'courtEstablishment' ? '#chkNo' : '#chkYes').waitFor({ state: 'attached', timeout: DISTRICT_SELECTOR_TIMEOUT_MS }).catch(() => {});
  await page.locator(targetSelector).waitFor({ state: 'attached', timeout: DISTRICT_SELECTOR_TIMEOUT_MS });
  await page.check(searchMode === 'courtEstablishment' ? '#chkNo' : '#chkYes').catch(() => {});
  await waitForDistrictScriptsReady(page);

  await page.waitForFunction((selector) => {
    const select = document.querySelector(selector);
    return Boolean(select && select.options && select.options.length > 1);
  }, targetSelector, { timeout: DISTRICT_SELECTOR_TIMEOUT_MS }).catch(() => {});

  const currentValue = await page.locator(targetSelector).inputValue().catch(() => '');
  const caseTypeReady = await page.locator('#case_type').evaluate((select) => {
    return Boolean(select && !select.disabled && select.options.length > 1);
  }).catch(() => false);

  if (currentValue !== targetValue || !caseTypeReady) {
    const responsePromise = page.waitForResponse((response) => {
      const request = response.request();
      const postData = request.postData() || '';
      return request.method() === 'POST' &&
        response.url().includes('/wp-admin/admin-ajax.php') &&
        postData.includes('action=get_case_types');
    }, { timeout: DISTRICT_SELECTOR_TIMEOUT_MS }).catch(() => null);

    await selectDistrictDropdownOption(page.locator(targetSelector), targetValue, targetLabel, searchMode === 'courtEstablishment' ? 'court establishment' : 'court complex');
    await responsePromise;
  }

  await page.waitForFunction(() => {
    const select = document.querySelector('#case_type');
    return Boolean(select && !select.disabled && select.options.length > 1);
  }, { timeout: DISTRICT_SELECTOR_TIMEOUT_MS });
}

async function waitForDistrictScriptsReady(page) {
  await page.waitForFunction(() => {
    const select = document.querySelector('#est_code') || document.querySelector('#court_establishment');
    const $ = window.jQuery;
    if (!select || typeof $ !== 'function' || typeof $._data !== 'function') {
      return false;
    }
    const events = $._data(select, 'events');
    return Boolean(events && Array.isArray(events.change) && events.change.length);
  }, { timeout: DISTRICT_SELECTOR_TIMEOUT_MS }).catch(async () => {
    await page.waitForTimeout(1500).catch(() => {});
  });
}

async function prepareDistrictLookupPage(page) {
  await page.route('**/*', (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();

    if (['font', 'media'].includes(resourceType)) {
      return route.abort().catch(() => {});
    }

    if (/google-analytics|googletagmanager|doubleclick|facebook|youtube|gravatar|fontawesome/i.test(url)) {
      return route.abort().catch(() => {});
    }

    return route.continue().catch(() => {});
  }).catch(() => {});

  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        get: () => undefined
      });
    } catch (_error) {}
  }).catch(() => {});
}

function prepareDistrictInput(input) {
  const district = getDelhiDistrictSite(input?.districtSlug);
  if (!district) {
    throw new Error('Choose a Delhi district first.');
  }

  const searchMode = input?.searchMode === 'courtEstablishment' ? 'courtEstablishment' : 'courtComplex';
  const districtLabel = input?.districtLabel || district.label;
  const districtUrl = input?.districtUrl || district.url;
  const courtComplexValue = String(input?.courtComplexValue || '').trim();
  const courtEstablishmentValue = String(input?.courtEstablishmentValue || '').trim();
  const courtComplex = district.courtComplexes.find((entry) => entry.value === courtComplexValue || entry.label === String(input?.courtComplex || '').trim()) || null;
  const courtEstablishment = String(input?.courtEstablishment || '').trim();

  const caseNumber = String(input?.caseNumber || '').trim();
  const year = String(input?.year || '').trim();
  if (!caseNumber || !year) {
    throw new Error('District lookup requires a case number and year.');
  }

  return {
    lookupMode: 'district_case_number',
    districtSlug: district.slug,
    districtLabel,
    districtUrl,
    searchMode,
    courtComplex: courtComplex?.label || String(input?.courtComplex || '').trim(),
    courtComplexValue: courtComplex?.value || courtComplexValue,
    courtEstablishment,
    courtEstablishmentValue,
    caseType: String(input?.caseType || '').trim(),
    caseNumber,
    year
  };
}

async function selectCaseType(page, desiredValue) {
  const select = page.locator('#case_type');
  const exactValue = String(desiredValue || '').trim();
  const target = normalizeDistrictOption(exactValue);
  const flexibleTarget = normalizeFlexibleDistrictOption(exactValue);
  const options = await select.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: node.getAttribute('value') || '',
      text: (node.textContent || '').trim()
    }))
  );
  const match = options.find((option) => normalizeDistrictOption(option.value) === target || normalizeDistrictOption(option.text) === target) ||
    options.find((option) => normalizeFlexibleDistrictOption(option.value) === flexibleTarget || normalizeFlexibleDistrictOption(option.text) === flexibleTarget) ||
    options.find((option) => normalizeFlexibleDistrictOption(option.value).includes(flexibleTarget) || normalizeFlexibleDistrictOption(option.text).includes(flexibleTarget)) ||
    options.find((option) => flexibleTarget.includes(normalizeFlexibleDistrictOption(option.value)) || flexibleTarget.includes(normalizeFlexibleDistrictOption(option.text)));
  if (!match) {
    throw new Error(`Could not find district case type "${desiredValue}" in the official dropdown.`);
  }
  await select.selectOption(match.value);
}

async function selectDistrictDropdownOption(selectLocator, desiredValue, desiredLabel, fieldName) {
  const rawValue = String(desiredValue || '').trim();
  const rawLabel = String(desiredLabel || '').trim();
  const normalizedValue = normalizeFlexibleDistrictOption(rawValue);
  const normalizedLabel = normalizeFlexibleDistrictOption(rawLabel);
  const options = await selectLocator.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: node.getAttribute('value') || '',
      text: (node.textContent || '').trim()
    }))
  );

  const match = options.find((option) => option.value === rawValue || option.text === rawLabel) ||
    options.find((option) => normalizeFlexibleDistrictOption(option.value) === normalizedValue || normalizeFlexibleDistrictOption(option.text) === normalizedValue) ||
    options.find((option) => normalizeFlexibleDistrictOption(option.value) === normalizedLabel || normalizeFlexibleDistrictOption(option.text) === normalizedLabel) ||
    options.find((option) => normalizeFlexibleDistrictOption(option.value).includes(normalizedValue) || normalizeFlexibleDistrictOption(option.text).includes(normalizedValue)) ||
    options.find((option) => normalizeFlexibleDistrictOption(option.value).includes(normalizedLabel) || normalizeFlexibleDistrictOption(option.text).includes(normalizedLabel)) ||
    options.find((option) => normalizedLabel && (normalizedLabel.includes(normalizeFlexibleDistrictOption(option.value)) || normalizedLabel.includes(normalizeFlexibleDistrictOption(option.text))));

  if (!match) {
    throw new Error(`Could not find district ${fieldName} "${desiredLabel || desiredValue}" in the official dropdown.`);
  }

  await selectLocator.selectOption(match.value);
}

function normalizeDistrictOption(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFlexibleDistrictOption(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function readSelectOptions(selectLocator) {
  return selectLocator.locator('option').evaluateAll((nodes) =>
    nodes
      .map((node) => ({
        value: node.getAttribute('value') || '',
        label: (node.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter((option) => option.value && option.label && !/^select/i.test(option.label) && !/^--select/i.test(option.label))
  );
}

async function parseSearchResults(page, html, input) {
  return page.evaluate((markup) => {
    const container = document.createElement('div');
    container.innerHTML = markup;
    const table = container.querySelector('table');
    const columns = Array.from(table?.querySelectorAll('thead th') || []).map((node) => clean(node.textContent));
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row, index) => {
      const cells = Array.from(row.querySelectorAll('td')).map((cell, cellIndex) => {
        const text = clean(cell.textContent);
        const links = Array.from(cell.querySelectorAll('a[href]')).map((link) => link.href);
        const viewNode = cell.querySelector('.viewCnrDetails, [data-cno]');
        return {
          label: columns[cellIndex] || `Column ${cellIndex + 1}`,
          text,
          links,
          cno: viewNode?.getAttribute('data-cno') || '',
          estCode: viewNode?.getAttribute('data-est-code') || ''
        };
      });
      const combined = cells.map((cell) => cell.text).join(' | ');
      return {
        serialNumber: cells[0]?.text || String(index + 1),
        caseNumberText: cells[1]?.text || '',
        parties: cells[2]?.text || '',
        viewText: cells[3]?.text || '',
        cno: cells.find((cell) => cell.cno)?.cno || '',
        estCode: cells.find((cell) => cell.estCode)?.estCode || '',
        text: combined
      };
    });

    return {
      rawTextPreview: clean(container.textContent).slice(0, 3000),
      history: {
        filings: [],
        listings: [],
        hearings: [],
        orders: [],
        rawTables: table ? [toRawTable(table, 'Case History')] : []
      },
      rows
    };

    function toRawTable(tableNode, title) {
      const headers = Array.from(tableNode.querySelectorAll('thead th')).map((node) => clean(node.textContent));
      return {
        title,
        columns: headers,
        rows: Array.from(tableNode.querySelectorAll('tbody tr')).map((rowNode) => ({
          cells: Array.from(rowNode.querySelectorAll('td')).map((cellNode, index) => ({
            label: headers[index] || `Column ${index + 1}`,
            text: clean(cellNode.textContent),
            links: Array.from(cellNode.querySelectorAll('a[href]')).map((link) => link.href),
            actions: []
          })),
          text: clean(rowNode.textContent),
          links: Array.from(rowNode.querySelectorAll('a[href]')).map((link) => link.href),
          actions: []
        }))
      };
    }

    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }
  }, html);
}

function pickDistrictSearchResult(rows, input) {
  if (!rows.length) return null;
  const exactNeedle = [input.caseType, input.caseNumber, input.year].filter(Boolean).join('/').replace(/\s+/g, '').toLowerCase();
  const exact = rows.find((row) => row.cno && row.caseNumberText.replace(/\s+/g, '').toLowerCase().includes(exactNeedle));
  return exact || rows.find((row) => row.cno) || null;
}

async function parseDistrictDetails(page, html, context) {
  const parsed = await page.evaluate((markup) => {
    const container = document.createElement('div');
    container.innerHTML = markup;
    const tables = Array.from(container.querySelectorAll('table'));
    const rawTables = tables.map((table, index) => {
      const titleNode = table.previousElementSibling && /^h\d$/i.test(table.previousElementSibling.tagName)
        ? table.previousElementSibling
        : table.closest('.table-responsive, .table-holder, .service-box')?.querySelector('h2,h3,h4');
      const columns = Array.from(table.querySelectorAll('thead th')).map((node) => clean(node.textContent));
      const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
      const rows = bodyRows.map((row) => {
        const cells = Array.from(row.querySelectorAll('td')).map((cell, cellIndex) => ({
          label: columns[cellIndex] || inferLabelFromRow(row, cellIndex),
          text: clean(cell.textContent),
          links: Array.from(cell.querySelectorAll('a[href]')).map((link) => link.href),
          actions: []
        }));
        return {
          cells,
          text: clean(row.textContent),
          links: Array.from(row.querySelectorAll('a[href]')).map((link) => link.href),
          actions: []
        };
      });

      return {
        title: clean(titleNode?.textContent) || `Table ${index + 1}`,
        columns,
        rows
      };
    });

    const summaryTable = rawTables.find((table) => table.columns.includes('Next Hearing Date') || table.columns.includes('Case Status'));
    const summaryRow = summaryTable?.rows[0] || null;
    const summaryLookup = Object.fromEntries((summaryRow?.cells || []).map((cell) => [cell.label, cell.text]));

    const filingTable = rawTables.find((table) => /filing details/i.test(table.title));
    const hearingsTable = rawTables.find((table) => table.columns.includes('Business On Date') && table.columns.includes('Hearing Date'));
    const ordersTable = rawTables.find((table) => /orders/i.test(table.title));

    const filings = (filingTable?.rows || []).map((row, index) => {
      const values = row.cells.map((cell) => cell.text);
      return {
        serialNumber: String(index + 1),
        date: normalizeDate(values[2]),
        details: values.filter(Boolean).join(' | '),
        diaryNumber: '',
        status: ''
      };
    });

    const hearings = (hearingsTable?.rows || []).map((row) => {
      const lookup = Object.fromEntries(row.cells.map((cell) => [cell.label, cell.text]));
      return {
        serialNumber: lookup['Registration Number'] || '',
        judge: lookup.Judge || '',
        businessDate: normalizeDate(lookup['Business On Date']),
        nextDate: normalizeDate(lookup['Hearing Date']),
        purpose: lookup['Purpose of hearing'] || '',
        business: lookup['Business On Date'] || ''
      };
    });

    const listings = hearings.map((entry) => ({
      serialNumber: entry.serialNumber,
      date: entry.nextDate,
      details: [entry.purpose, entry.nextDate].filter(Boolean).join(' | '),
      orderUrl: ''
    }));

    const orders = (ordersTable?.rows || []).map((row) => {
      const lookup = Object.fromEntries(row.cells.map((cell) => [cell.label, cell.text]));
      const firstLinkedCell = row.cells.find((cell) => Array.isArray(cell.links) && cell.links.length);
      const url = firstLinkedCell?.links?.[0] || row.links?.[0] || '';
      return {
        serialNumber: lookup['Order Number'] || '',
        date: normalizeDate(lookup['Order Date']),
        details: lookup['Order Details'] || row.text,
        url,
        action: null,
        sourceUrl: url
      };
    });

    const latestOrder = orders.slice().sort((left, right) => toTime(left.date) - toTime(right.date)).slice(-1)[0] || null;
    const hearingDate = normalizeDate(summaryLookup['Next Hearing Date']) || (hearings.length ? hearings[hearings.length - 1].nextDate : '');
    const courtNumberAndJudge = clean(summaryLookup['Court Number and Judge']);

    return {
      pageTitle: document.title,
      rawTextPreview: clean(container.textContent).slice(0, 4000),
      caseHistory: {
        filings,
        listings,
        hearings,
        orders,
        rawTables
      },
      nextHearingDate: hearingDate,
      caseStatus: clean(summaryLookup['Case Status']),
      firstHearingDate: normalizeDate(summaryLookup['First Hearing Date']),
      stageOfCase: clean(summaryLookup['Stage of Case']),
      courtNumber: courtNumberAndJudge,
      latestOrderUrl: latestOrder?.url || '',
      latestOrderDate: latestOrder?.date || ''
    };

    function inferLabelFromRow(rowNode, cellIndex) {
      const headingCell = rowNode.querySelectorAll('th')[cellIndex];
      return clean(headingCell?.textContent) || `Column ${cellIndex + 1}`;
    }

    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeDate(value) {
      const text = clean(value);
      if (!text) return '';
      const numeric = text.match(/(\\d{1,2})[-/](\\d{1,2})[-/](\\d{4})/);
      if (numeric) return `${pad(numeric[1])}-${pad(numeric[2])}-${numeric[3]}`;
      const monthName = text.match(/(\\d{1,2})[- ]([A-Za-z]+)[- ,](\\d{4})/);
      if (monthName) {
        const month = {
          january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
          july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
        }[monthName[2].toLowerCase()];
        if (month) return `${pad(monthName[1])}-${month}-${monthName[3]}`;
      }
      return '';
    }

    function pad(value) {
      return String(value).padStart(2, '0');
    }

    function toTime(value) {
      const normalized = normalizeDate(value);
      if (!normalized) return 0;
      const [day, month, year] = normalized.split('-').map(Number);
      return new Date(year, month - 1, day).getTime();
    }
  }, html);

  const caseTitle = deriveDistrictCaseTitle(context.selectedResult.parties);
  const caseNumber = deriveDistrictCaseNumber(context.selectedResult.caseNumberText, context.input);

  return {
    provider: 'districtCourtCnr',
    caseFound: true,
    courtName: context.input.districtLabel,
    caseNumber,
    cnrNumber: findCnrNumber(parsed.caseHistory.rawTables),
    caseTitle,
    nextHearingDate: parsed.nextHearingDate,
    statusPageNextHearingDate: parsed.nextHearingDate,
    nextHearingDateSource: 'district_case_number',
    courtNumber: parsed.courtNumber,
    caseStatus: parsed.caseStatus,
    firstHearingDate: parsed.firstHearingDate,
    lastOrderDate: parsed.latestOrderDate,
    officialSourceUrl: context.input.districtUrl,
    sourceUrl: context.input.districtUrl,
    ordersUrl: parsed.latestOrderUrl,
    judgmentsUrl: '',
    caseHistoryUrl: context.input.districtUrl,
    filingsUrl: context.input.districtUrl,
    listingsUrl: context.input.districtUrl,
    latestOrderUrl: parsed.latestOrderUrl,
    latestOrderDate: parsed.latestOrderDate,
    caseHistory: parsed.caseHistory,
    pageTitle: parsed.pageTitle,
    rawTextPreview: parsed.rawTextPreview,
    invalidCaptchaDetected: false,
    rawMetadata: {
      stageOfCase: parsed.stageOfCase,
      searchResults: context.searchResults
    }
  };
}

function buildDistrictNotFound(input, message, searchResults) {
  return {
    provider: 'districtCourtCnr',
    caseFound: false,
    courtName: input.districtLabel,
    caseNumber: `${input.caseType ? `${input.caseType} ` : ''}${input.caseNumber}/${input.year}`.trim(),
    cnrNumber: '',
    caseTitle: '',
    nextHearingDate: '',
    statusPageNextHearingDate: '',
    nextHearingDateSource: 'district_case_number',
    courtNumber: '',
    caseStatus: message || 'No matching case found in the official district search results.',
    firstHearingDate: '',
    lastOrderDate: '',
    officialSourceUrl: input.districtUrl,
    sourceUrl: input.districtUrl,
    ordersUrl: '',
    judgmentsUrl: '',
    caseHistoryUrl: input.districtUrl,
    filingsUrl: input.districtUrl,
    listingsUrl: input.districtUrl,
    latestOrderUrl: '',
    latestOrderDate: '',
    caseHistory: { filings: [], listings: [], hearings: [], orders: [], rawTables: searchResults?.history?.rawTables || [] },
    pageTitle: '',
    rawTextPreview: searchResults?.rawTextPreview || message || '',
    invalidCaptchaDetected: false,
    rawMetadata: searchResults ? { searchResults } : {}
  };
}

function extractAjaxMessage(payload) {
  if (!payload) return '';
  if (typeof payload.data === 'string') {
    try {
      const parsed = JSON.parse(payload.data);
      return String(parsed?.message || '').trim();
    } catch (error) {
      return String(payload.data || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return String(payload.message || '').trim();
}

function deriveDistrictCaseTitle(parties) {
  return String(parties || '').trim();
}

function deriveDistrictCaseNumber(caseNumberText, input) {
  const direct = String(caseNumberText || '').replace(/\s+/g, ' ').trim();
  const match = direct.match(/([A-Z.() ]+\/)?(\d+)\/(\d{4})/i);
  if (match) return `${match[2]}/${match[3]}`;
  return `${input.caseNumber}/${input.year}`;
}

function findCnrNumber(rawTables) {
  for (const table of rawTables || []) {
    for (const row of table.rows || []) {
      for (const cell of row.cells || []) {
        if (cell.label === 'CNR Number' && cell.text) {
          return cell.text;
        }
      }
    }
  }
  return '';
}

module.exports = new DistrictCourtCnrProvider();
