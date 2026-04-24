const { chromium } = require('playwright');
const BaseProvider = require('./base');
const { cacheDocumentBuffer } = require('../documentCache');
const { getDelhiDistrictSite } = require('../delhiDistrictSites');
const { createLookupContext, launchLookupBrowser, prepareLookupPage } = require('../playwrightProfile');

const ECOURTS_URL = 'https://services.ecourts.gov.in/ecourtindia_v6/';
const ECOURTS_CASE_STATUS_URL = `${ECOURTS_URL}?p=casestatus/index&app_token=`;
const COURT_NAME = 'District Court (eCourts)';
const DISTRICT_NAVIGATION_TIMEOUT_MS = Number(process.env.DISTRICT_NAVIGATION_TIMEOUT_MS || 120000);
const DISTRICT_CASE_TYPES_TTL_MS = 12 * 60 * 60 * 1000;
const districtCaseTypesCache = new Map();
const DISTRICT_DEBUG_PREVIEW_LIMIT = 900;
const DELHI_STATE_CODE = '26';

class DistrictCourtCnrProvider extends BaseProvider {
  constructor() {
    super('districtCourtCnr');
  }

  get key() {
    return this.name;
  }

  get label() {
    return 'Delhi District Courts (district + case number + manual CAPTCHA)';
  }

  requiresManualCaptcha() {
    return true;
  }

  async fetchCase() {
    throw new Error('District court lookups require the manual CAPTCHA flow.');
  }

  async listCaseTypes({ districtSlug, courtComplex }) {
    const district = getDelhiDistrictSite(districtSlug);
    if (!district) {
      throw new Error('Select a valid Delhi district court first.');
    }
    if (!String(courtComplex || '').trim()) {
      return [];
    }

    const cacheKey = `${district.slug}::${String(courtComplex).trim()}`;
    const cached = districtCaseTypesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.items;
    }

    const browser = await launchLookupBrowser(chromium);
    const context = await createLookupContext(browser);
    const page = await context.newPage();
    const debug = createDistrictDebugTrace({ lookupMode: 'district_case_types', districtSlug, courtComplex });

    try {
      await prepareLookupPage(page);
      pushDistrictDebug(debug, 'page-created');
      await gotoWithFallback(page, district.url, { timeout: DISTRICT_NAVIGATION_TIMEOUT_MS });
      pushDistrictDebug(debug, 'district-page-opened', await collectDistrictPageSnapshot(page));
      await page.locator('#chkYes').check().catch(() => {});
      pushDistrictDebug(debug, 'terms-checkbox-checked');
      await selectDistrictComplex(page, courtComplex);
      pushDistrictDebug(debug, 'complex-selected', { courtComplex });
      await page.waitForFunction(() => {
        const select = document.querySelector('#case_type');
        return Boolean(select && !select.disabled && select.querySelectorAll('option').length > 1);
      }, { timeout: 15000 }).catch(() => {});

      const items = await page.evaluate(() => {
        return [...document.querySelectorAll('#case_type option')]
          .map((option) => ({
            value: option.value || '',
            label: (option.textContent || '').trim()
          }))
          .filter((option) => option.value && option.label);
      });

      districtCaseTypesCache.set(cacheKey, {
        items,
        expiresAt: Date.now() + DISTRICT_CASE_TYPES_TTL_MS
      });
      pushDistrictDebug(debug, 'case-types-loaded', { caseTypeCount: items.length });
      return items;
    } catch (error) {
      throw await withDistrictDebug(error, debug, page, 'list-case-types');
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  async startLookup({ cnrNumber, districtSlug, courtComplex, caseType, caseNumber, year }) {
    if (String(cnrNumber || '').trim()) {
      return startCnrLookup({ cnrNumber });
    }

    return startDistrictCaseNumberLookup({ districtSlug, courtComplex, caseType, caseNumber, year });
  }

  async completeLookup(session, captchaText) {
    if (!session?.page) {
      throw new Error('Lookup session is missing or expired.');
    }

    const cleanedCaptcha = String(captchaText || '').trim();
    if (!cleanedCaptcha) {
      throw new Error('CAPTCHA text is required.');
    }

    if (session.input?.lookupMode === 'district_case_number' || session.input?.lookupMode === 'district_case_number_ecourts') {
      return completeDistrictCaseNumberLookup(session, cleanedCaptcha);
    }

    return completeCnrLookup(session, cleanedCaptcha);
  }
}

async function startCnrLookup({ cnrNumber }) {
    const cino = normalizeCnr(cnrNumber);
    if (!cino) {
      throw new Error('District court lookup requires a 16-character CNR number.');
    }

      const browser = await launchLookupBrowser(chromium);
      const context = await createLookupContext(browser);
    const page = await context.newPage();
    await prepareLookupPage(page);
    const debug = createDistrictDebugTrace({ lookupMode: 'cnr', cnrNumber: cino });

    try {
      pushDistrictDebug(debug, 'page-created');
      await gotoWithFallback(page, ECOURTS_URL, { timeout: DISTRICT_NAVIGATION_TIMEOUT_MS });
      pushDistrictDebug(debug, 'ecourts-page-opened', await collectDistrictPageSnapshot(page));

      await page.locator('#cino').fill(cino);
      pushDistrictDebug(debug, 'cnr-filled', { cnrNumber: cino });
      const captchaLocator = page.locator('#captcha_image').first();
      await captchaLocator.waitFor({ state: 'visible', timeout: 15000 });
      const captchaPng = await captchaLocator.screenshot({ type: 'png' });
      pushDistrictDebug(debug, 'captcha-captured');

      return {
        browser,
        context,
        page,
        debug,
        input: { lookupMode: 'cnr', cnrNumber: cino },
        preview: {
          captchaImageBase64: captchaPng.toString('base64'),
          instructions: 'Solve the CAPTCHA shown from the official eCourts CNR page, then submit it here to fetch the district court case history.',
          sourceUrl: ECOURTS_URL
        }
      };
    } catch (error) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      throw await withDistrictDebug(error, debug, page, 'start-cnr-lookup');
    }
  }

async function startDistrictCaseNumberLookup({ districtSlug, courtComplex, caseType, caseNumber, year }) {
  return startDistrictCaseNumberLookupViaEcourts({ districtSlug, courtComplex, caseType, caseNumber, year });
}

async function startDistrictCaseNumberLookupViaEcourts({ districtSlug, courtComplex, caseType, caseNumber, year }) {
  const district = getDelhiDistrictSite(districtSlug);
  if (!district) {
    throw new Error('Select a valid Delhi district court first.');
  }
  if (!String(courtComplex || '').trim()) {
    throw new Error('Enter the court complex exactly as it appears on the district court page.');
  }
  if (!String(caseNumber || '').trim() || !String(year || '').trim()) {
    throw new Error('District court lookup requires case number and year.');
  }

  const browser = await launchLookupBrowser(chromium);
  const context = await createLookupContext(browser);
  const page = await context.newPage();
  await prepareLookupPage(page);
  const debug = createDistrictDebugTrace({
    lookupMode: 'district_case_number_ecourts',
    districtSlug,
    courtComplex,
    caseType,
    caseNumber,
    year
  });

  try {
    pushDistrictDebug(debug, 'page-created');
    await gotoWithFallback(page, ECOURTS_CASE_STATUS_URL, { timeout: DISTRICT_NAVIGATION_TIMEOUT_MS });
    pushDistrictDebug(debug, 'ecourts-case-status-opened', await collectDistrictPageSnapshot(page));

    const districtOption = await loadEcourtsDistrictOption(page, district.label);
    pushDistrictDebug(debug, 'district-selected', districtOption);

    const complexOption = await loadEcourtsComplexOption(page, districtOption.value, courtComplex);
    pushDistrictDebug(debug, 'complex-selected', {
      requestedComplex: courtComplex,
      selectedComplex: complexOption.text,
      complexValue: complexOption.value
    });

    const establishmentOptions = await loadEcourtsEstablishmentOptions(page, districtOption.value, complexOption.value);
    pushDistrictDebug(debug, 'establishments-loaded', {
      establishmentCount: establishmentOptions.length,
      establishments: establishmentOptions.map((option) => option.text)
    });

    const captchaPayload = await refreshEcourtsCaptcha(page);
    pushDistrictDebug(debug, 'captcha-refreshed');
    const captchaLocator = page.locator('#captcha_image').first();
    await captchaLocator.waitFor({ state: 'visible', timeout: 15000 });
    const captchaPng = await captchaLocator.screenshot({ type: 'png' });
    pushDistrictDebug(debug, 'captcha-captured', await collectDistrictPageSnapshot(page));

    return {
      browser,
      context,
      page,
      debug,
      input: {
        lookupMode: 'district_case_number_ecourts',
        districtSlug: district.slug,
        districtLabel: district.label,
        districtUrl: district.url,
        ecourtsSourceUrl: ECOURTS_CASE_STATUS_URL,
        stateCode: DELHI_STATE_CODE,
        districtCode: districtOption.value,
        courtComplex: complexOption.text,
        courtComplexValue: complexOption.value,
        courtComplexCode: extractEcourtsComplexCode(complexOption.value),
        courtComplexRequiresEstablishment: ecourtsComplexRequiresEstablishment(complexOption.value),
        establishmentOptions,
        caseType: String(caseType || '').trim(),
        caseNumber: String(caseNumber || '').trim(),
        year: String(year || '').trim()
      },
      preview: {
        captchaImageBase64: captchaPng.toString('base64'),
        instructions: `Solve the CAPTCHA shown from the official eCourts district case-status page, then submit it here to fetch the ${district.label} case history.`,
        sourceUrl: ECOURTS_CASE_STATUS_URL
      }
    };
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw await withDistrictDebug(error, debug, page, 'start-district-case-number-lookup');
  }
}

async function gotoWithFallback(page, url, options = {}) {
  const timeout = Number(options.timeout || DISTRICT_NAVIGATION_TIMEOUT_MS);
  const attempts = [
    { waitUntil: 'domcontentloaded', timeout },
    { waitUntil: 'load', timeout: Math.max(timeout, 90000) },
    { waitUntil: 'commit', timeout: Math.max(timeout, 120000) }
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const response = await page.goto(url, attempt);
      if (response && response.status() >= 400) {
        throw new Error(`Navigation returned HTTP ${response.status()} for ${url}`);
      }
      await page.waitForSelector('body', { state: 'attached', timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      return response;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Unable to open ${url}`);
}

async function ecourtsPostJsonWithinPage(page, route, data = {}) {
  return page.evaluate(async ({ route: requestRoute, data: requestData, baseUrl }) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(requestData || {})) {
      if (value === undefined || value === null) continue;
      body.set(key, String(value));
    }

    const appToken = document.querySelector('#app_token, input[name="app_token"], [name="app_token"]')?.value
      || globalThis.app_token
      || globalThis.appToken
      || '';
    body.set('ajax_req', 'true');
    body.set('app_token', appToken);

    const response = await fetch(`${baseUrl}?p=${requestRoute}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json, text/javascript, */*; q=0.01'
      },
      body: body.toString()
    });
    return response.json().catch(() => null);
  }, { route, data, baseUrl: ECOURTS_URL });
}

function parseEcourtsOptionHtml(html) {
  return [...String(html || '').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
    .map((match) => ({
      value: extractAttribute(match[1] || '', 'value').trim(),
      text: cleanHtmlText(match[2] || '')
    }))
    .filter((option) => option.value && option.text && !/^select\b/i.test(option.text));
}

function normalizeDistrictLabel(label) {
  return String(label || '')
    .replace(/\bdistrict\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadEcourtsDistrictOption(page, districtLabel) {
  const payload = await ecourtsPostJsonWithinPage(page, 'casestatus/fillDistrict', {
    state_code: DELHI_STATE_CODE
  });
  const options = parseEcourtsOptionHtml(payload?.dist_list);
  const matched = matchOption(options, normalizeDistrictLabel(districtLabel));
  if (!matched) {
    throw new Error(`District not found in eCourts. Available options: ${options.map((option) => option.text).join('; ')}`);
  }
  await page.selectOption('#sess_state_code', DELHI_STATE_CODE).catch(() => {});
  await page.selectOption('#sess_dist_code', matched.value).catch(() => {});
  return matched;
}

async function loadEcourtsComplexOption(page, districtCode, courtComplex) {
  const payload = await ecourtsPostJsonWithinPage(page, 'casestatus/fillcomplex', {
    state_code: DELHI_STATE_CODE,
    dist_code: districtCode
  });
  const options = parseEcourtsOptionHtml(payload?.complex_list);
  const matched = matchOption(options, courtComplex);
  if (!matched) {
    throw new Error(`Court complex not found in eCourts. Available options: ${options.map((option) => option.text).join('; ')}`);
  }
  await page.selectOption('#court_complex_code', matched.value).catch(() => {});
  return matched;
}

async function loadEcourtsEstablishmentOptions(page, districtCode, courtComplexValue) {
  const requiresEstablishment = ecourtsComplexRequiresEstablishment(courtComplexValue);
  const complexCode = extractEcourtsComplexCode(courtComplexValue);
  if (!requiresEstablishment || !complexCode) {
    return [{ value: '', text: '' }];
  }

  const payload = await ecourtsPostJsonWithinPage(page, 'casestatus/fillCourtEstablishment', {
    state_code: DELHI_STATE_CODE,
    dist_code: districtCode,
    court_complex_code: complexCode
  });
  const options = parseEcourtsOptionHtml(payload?.establishment_list);
  if (!options.length) {
    throw new Error('No court establishments were returned for the selected district court complex.');
  }
  return options;
}

function extractEcourtsComplexCode(value) {
  return String(value || '').split('@')[0] || '';
}

function ecourtsComplexRequiresEstablishment(value) {
  return String(value || '').split('@')[2] === 'Y';
}

async function refreshEcourtsCaptcha(page) {
  const payload = await ecourtsPostJsonWithinPage(page, 'casestatus/getCaptcha', {});
  if (payload?.div_captcha) {
    await page.evaluate((html) => {
      const target = document.querySelector('#div_captcha_caseno');
      if (target) target.innerHTML = html;
    }, payload.div_captcha).catch(() => {});
  }
  return payload;
}

function getEcourtsEstablishmentAttempts(input) {
  if (!input?.courtComplexRequiresEstablishment) {
    return [{ value: '', text: '' }];
  }
  const items = Array.isArray(input?.establishmentOptions) ? input.establishmentOptions : [];
  return items.filter((option) => option?.value);
}

async function seedEcourtsCaseNumberResult(page, details) {
  await page.evaluate((payload) => {
    const setValue = (selector, value) => {
      const element = document.querySelector(selector);
      if (!element) return;
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setValue('#sess_state_code', payload.stateCode || '');
    setValue('#sess_dist_code', payload.districtCode || '');
    setValue('#court_complex_code', payload.courtComplexValue || '');
    setValue('#court_est_code', payload.establishmentValue || '');
    setValue('#case_type', payload.caseTypeValue || '');
    setValue('#search_case_no', payload.caseNumber || '');
    setValue('#rgyear', payload.year || '');

    const results = document.querySelector('#case_no_res');
    if (results) results.innerHTML = payload.searchHtml || '';
  }, details);
}

async function openEcourtsCaseNumberDetailsWithinPage(page, input) {
  const targetCaseRef = normalizeChoice(`${input.caseType || ''} ${input.caseNumber || ''}/${input.year || ''}`);
  const rows = page.locator('#case_no_res tr');
  const rowCount = await rows.count().catch(() => 0);
  let clicked = false;

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    const text = normalizeChoice(await row.innerText().catch(() => ''));
    const action = row.locator('[onclick*="viewHistory("]').first();
    const hasAction = await action.count().catch(() => 0);
    if (!hasAction) continue;
    if (targetCaseRef && text && !text.includes(targetCaseRef)) continue;
    await action.click().catch(() => {});
    clicked = true;
    break;
  }

  if (!clicked) {
    const fallback = page.locator('#case_no_res [onclick*="viewHistory("]').first();
    if (await fallback.count().catch(() => 0)) {
      await fallback.click().catch(() => {});
      clicked = true;
    }
  }

  if (!clicked) return '';

  await page.waitForFunction(() => {
    const detail = document.querySelector('#caseBusinessDiv_csNo');
    const summary = document.querySelector('#CScaseNumber');
    const text = (detail?.innerText || summary?.innerText || '').trim();
    return Boolean(text && text.length > 40);
  }, { timeout: 20000 }).catch(() => null);

  return await page.locator('#caseBusinessDiv_csNo').innerHTML().catch(async () => {
    return page.locator('#CScaseNumber').innerHTML().catch(() => '');
  });
}

async function completeCnrLookup(session, cleanedCaptcha) {
  const { page, input } = session;
  const resultPromise = waitForCnrResult(page);

  await page.locator('#fcaptcha_code').fill(cleanedCaptcha);
  await page.locator('#searchbtn').click();

  const result = await resultPromise;
  const payload = result.payload || await readPayloadFromPage(page);
  await page.waitForTimeout(500);

  if (!payload || Number(payload.status) === 0) {
    return {
      status: 'invalidCaptcha',
      debug: buildFailurePayload(input, payload, 'Invalid CAPTCHA or CNR. Load a fresh CAPTCHA and try again.')
    };
  }

  const caseData = parseEcourtsResult(input, payload);
  caseData.rawMetadata = {
    ...(caseData.rawMetadata || {}),
    ecourtsAccess: await captureEcourtsAccess(session).catch(() => null)
  };

  return {
    status: 'success',
    caseData
  };
}

async function completeDistrictCaseNumberLookupViaEcourts(session, cleanedCaptcha) {
  const { page, input } = session;
  const debug = session.debug || createDistrictDebugTrace(input);

  try {
    pushDistrictDebug(debug, 'ecourts-submit-start', { captchaLength: cleanedCaptcha.length });
    const establishments = getEcourtsEstablishmentAttempts(input);
    pushDistrictDebug(debug, 'ecourts-establishment-attempts', {
      establishmentCount: establishments.length,
      establishments: establishments.map((option) => option.text || option.value || '')
    });

    for (const establishment of establishments) {
      const caseTypesPayload = await ecourtsPostJsonWithinPage(page, 'casestatus/fillCaseType', {
        state_code: input.stateCode || DELHI_STATE_CODE,
        dist_code: input.districtCode,
        court_complex_code: input.courtComplexCode || extractEcourtsComplexCode(input.courtComplexValue),
        est_code: establishment.value || '',
        search_type: 'c_no'
      });
      const caseTypeOptions = parseEcourtsOptionHtml(caseTypesPayload?.casetype_list);
      const matchedCaseType = matchOption(caseTypeOptions, input.caseType);
      pushDistrictDebug(debug, 'ecourts-case-types-loaded', {
        establishment: establishment.text || establishment.value || '',
        caseTypeCount: caseTypeOptions.length,
        matchedCaseType: matchedCaseType?.text || ''
      });

      if (!matchedCaseType) {
        continue;
      }

      const submitPayload = await ecourtsPostJsonWithinPage(page, 'casestatus/submitCaseNo', {
        case_type: matchedCaseType.value,
        search_case_no: input.caseNumber,
        rgyear: input.year,
        case_captcha_code: cleanedCaptcha,
        state_code: input.stateCode || DELHI_STATE_CODE,
        dist_code: input.districtCode,
        court_complex_code: input.courtComplexCode || extractEcourtsComplexCode(input.courtComplexValue),
        est_code: establishment.value || '',
        case_no: input.caseNumber
      });

      pushDistrictDebug(debug, 'ecourts-submit-response', {
        establishment: establishment.text || establishment.value || '',
        status: submitPayload?.status ?? null,
        hasCaseData: Boolean(String(submitPayload?.case_data || '').trim()),
        errorMessage: String(submitPayload?.errormsg || '')
      });

      if (Number(submitPayload?.status) === 0 || /invalid captcha/i.test(String(submitPayload?.errormsg || ''))) {
        const failure = buildFailurePayload(input, submitPayload, 'Invalid CAPTCHA. Load a fresh CAPTCHA and try again.');
        failure.invalidCaptchaDetected = true;
        failure.rawMetadata = {
          ...(failure.rawMetadata || {}),
          districtDebug: debug
        };
        return {
          status: 'invalidCaptcha',
          debug: failure
        };
      }

      const searchHtml = String(submitPayload?.case_data || '');
      if (!searchHtml || /case not found|record not found|does not exist/i.test(cleanHtmlText(searchHtml))) {
        continue;
      }

      await seedEcourtsCaseNumberResult(page, {
        stateCode: input.stateCode || DELHI_STATE_CODE,
        districtCode: input.districtCode,
        courtComplexValue: input.courtComplexValue,
        establishmentValue: establishment.value || '',
        caseTypeValue: matchedCaseType.value,
        caseNumber: input.caseNumber,
        year: input.year,
        searchHtml
      });

      const detailHtml = await openEcourtsCaseNumberDetailsWithinPage(page, input).catch(() => '');
      pushDistrictDebug(debug, 'ecourts-details-opened', {
        establishment: establishment.text || establishment.value || '',
        detailHtmlLength: detailHtml.length
      });

      const caseData = parseEcourtsResult({
        ...input,
        lookupMode: 'district_case_number'
      }, {
        status: submitPayload?.status ?? 1,
        casetype_list: detailHtml || searchHtml,
        div_captcha: String(submitPayload?.div_captcha || '')
      });

      caseData.rawMetadata = {
        ...(caseData.rawMetadata || {}),
        searchResults: {
          rawTextPreview: cleanHtmlText(searchHtml).slice(0, 2000)
        },
        ecourtsAccess: await captureEcourtsAccess(session).catch(() => null),
        districtDebug: debug,
        selectedEstablishment: establishment.text || establishment.value || ''
      };

      return {
        status: 'success',
        caseData
      };
    }

    const failure = buildFailurePayload(input, null, 'No matching district court case was found for this case-number search.');
    failure.rawMetadata = {
      ...(failure.rawMetadata || {}),
      districtDebug: debug
    };
    return {
      status: 'success',
      caseData: failure
    };
  } catch (error) {
    throw await withDistrictDebug(error, debug, page, 'complete-district-case-number-lookup');
  }
}

async function completeDistrictCaseNumberLookup(session, cleanedCaptcha) {
  if (session?.input?.lookupMode === 'district_case_number_ecourts') {
    return completeDistrictCaseNumberLookupViaEcourts(session, cleanedCaptcha);
  }

  const { page, input } = session;
  const debug = session.debug || createDistrictDebugTrace(input);
  const resultPromise = waitForDistrictCaseNumberResult(page);

  try {
    pushDistrictDebug(debug, 'captcha-submit-start', { captchaLength: cleanedCaptcha.length });
    await page.locator('#siwp_captcha_value_0').fill(cleanedCaptcha);
    await page.locator('input[name="submit"][value="Search"]').first().click();
    pushDistrictDebug(debug, 'captcha-submitted');

    const result = await resultPromise;
    pushDistrictDebug(debug, 'search-response-received', { responseSource: result?.source || 'unknown' });
    const payload = result.payload || await readDistrictPayloadFromPage(page);
    pushDistrictDebug(debug, 'search-payload-read', {
      invalidCaptchaDetected: Boolean(payload?.invalidCaptchaDetected),
      payloadKeys: Object.keys(payload || {})
    });
    await page.waitForTimeout(500);

    if (!payload || payload.invalidCaptchaDetected) {
      pushDistrictDebug(debug, 'invalid-captcha-detected', await collectDistrictPageSnapshot(page));
      const failure = buildFailurePayload(input, payload, 'Invalid CAPTCHA. Load a fresh CAPTCHA and try again.');
      failure.rawMetadata = {
        ...(failure.rawMetadata || {}),
        districtDebug: debug
      };
      return {
        status: 'invalidCaptcha',
        debug: failure
      };
    }

    const detailHtml = await openDistrictCaseDetailsWithinPage(page, input).catch(() => '');
    pushDistrictDebug(debug, 'details-open-attempted', { detailHtmlLength: detailHtml.length });
    const detailedPayload = detailHtml
      ? { success: true, data: String(payload?.data || ''), detailData: detailHtml, searchData: String(payload?.data || '') }
      : await fetchDistrictCnrDetailsPayload(page, input, payload).catch(() => null);
    pushDistrictDebug(debug, 'details-payload-ready', {
      usedInlineDetails: Boolean(detailHtml),
      hasDetailedPayload: Boolean(detailedPayload)
    });
    const caseData = parseDistrictCaseNumberResult(input, detailedPayload || payload);
    caseData.rawMetadata = {
      ...(caseData.rawMetadata || {}),
      ecourtsAccess: await captureEcourtsAccess(session).catch(() => null),
      districtDebug: debug
    };

    return {
      status: 'success',
      caseData
    };
  } catch (error) {
    throw await withDistrictDebug(error, debug, page, 'complete-district-case-number-lookup');
  }
}

DistrictCourtCnrProvider.prototype.cacheLookupDocuments = async function cacheLookupDocuments(session, caseData, options = {}) {
    const trackedCaseId = String(options.trackedCaseId || '').trim();
    if (!trackedCaseId || !session?.context || !caseData?.caseHistory) {
      return caseData;
    }

    const access = caseData?.rawMetadata?.ecourtsAccess || await captureEcourtsAccess(session).catch(() => null);
    const resolvedCaseData = session.page
      ? await resolveCaseHistoryActionsWithinSession(session.page, caseData).catch(() => caseData)
      : caseData;

    const sourceUrls = collectDownloadableUrls(resolvedCaseData);
    if (!sourceUrls.length) return resolvedCaseData;

    const replacements = new Map();
    for (const url of sourceUrls) {
      const download = await downloadDocumentWithinPageSession(session.page, url).catch(() => null)
        || await downloadDocumentWithAccess(url, access).catch(() => null)
        || await downloadDocumentWithinContext(session.context, url).catch(() => null);
      if (!download?.buffer || !isPdf(download)) continue;

      const cached = await cacheDocumentBuffer(trackedCaseId, url, download.buffer, {
        contentType: download.contentType,
        baseName: buildDocumentBaseName(resolvedCaseData, url)
      }).catch(() => null);
      if (cached?.localUrl) {
        replacements.set(url, cached.localUrl);
      }
    }

    if (!replacements.size) return resolvedCaseData;
    return applyDocumentReplacements(resolvedCaseData, replacements);
  };

DistrictCourtCnrProvider.prototype.resolveOrderAction = async function resolveOrderAction(action, access = null) {
    const normalized = normalizeOrderAction(action);
    if (!normalized) {
      throw new Error('The district court order action is missing or invalid.');
    }

    const params = new URLSearchParams();
    params.set('normal_v', normalized.normal_v);
    params.set('case_val', normalized.case_num);
    params.set('court_code', normalized.court_code);
    params.set('filename', normalized.ofilename);
    params.set('appFlag', normalized.appFlag);

    const headers = {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'user-agent': 'CourtTrackPrototype/1.0 (+district order resolver)'
    };
    const cookieHeader = buildCookieHeader(access?.cookies);
    if (cookieHeader) headers.cookie = cookieHeader;

    const response = await fetch(`${ECOURTS_URL}?p=home/display_pdf`, {
      method: 'POST',
      headers,
      body: `${params.toString()}&ajax_req=true&app_token=${encodeURIComponent(String(access?.appToken || ''))}`
    });

    if (!response.ok) {
      throw new Error(`eCourts order resolver returned HTTP ${response.status}.`);
    }

    const rawText = await response.text();
    const payload = parseDisplayPdfPayload(rawText);
    if (payload?.errormsg && /session timeout/i.test(String(payload.errormsg))) {
      throw new Error('District court order access has expired. Refresh this district case via CAPTCHA once, then open the order again.');
    }
    const orderUrl = extractDisplayPdfOrderUrl(payload, rawText);
    if (orderUrl) {
      return orderUrl;
    }
    const debugSnippet = String(rawText || '').replace(/\s+/g, ' ').slice(0, 280);
    throw new Error(`eCourts did not return a usable order URL. Response preview: ${debugSnippet}`);
  };

DistrictCourtCnrProvider.prototype.downloadOrderAction = async function downloadOrderAction(action, access = null) {
    const orderUrl = await this.resolveOrderAction(action, access);
    const headers = {
      'user-agent': 'CourtTrackPrototype/1.0 (+district order download)'
    };
    const cookieHeader = buildCookieHeader(access?.cookies);
    if (cookieHeader) headers.cookie = cookieHeader;

    const response = await fetch(orderUrl, { headers });
    if (!response.ok) {
      throw new Error(`District court order download failed with HTTP ${response.status}.`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    if (!buffer.length) {
      throw new Error('District court order download returned an empty response.');
    }

    return { orderUrl, buffer, contentType };
  };

async function waitForCnrResult(page) {
  const responsePromise = page.waitForResponse((response) => {
    const url = response.url();
    const method = response.request().method();
    return method === 'POST' && /cnr_status\/searchByCNR\/?/i.test(url);
  }, { timeout: 45000 })
    .then(async (response) => ({ source: 'response', payload: await response.json().catch(() => null) }))
    .catch(() => null);

  const domPromise = page.waitForFunction(() => {
    const history = document.querySelector('#history_cnr');
    const text = (history?.innerText || '').trim();
    return Boolean(text && text.length > 20);
  }, { timeout: 45000 })
    .then(() => ({ source: 'dom', payload: null }))
    .catch(() => null);

  const result = await Promise.race([responsePromise, domPromise]);
  if (result) return result;

  const fallback = await Promise.all([responsePromise, domPromise]).then((items) => items.find(Boolean));
  if (fallback) return fallback;

  throw new Error('Timed out waiting for eCourts CNR results. The eCourts site may be slow; please load a fresh CAPTCHA and try again.');
}

async function waitForDistrictCaseNumberResult(page) {
  const responsePromise = page.waitForResponse((response) => {
    const url = response.url();
    const method = response.request().method();
    const postData = response.request().postData() || '';
    return method === 'POST' && /wp-admin\/admin-ajax\.php/i.test(url) && /action=get_cases/.test(postData);
  }, { timeout: 45000 })
    .then(async (response) => ({ source: 'response', payload: await response.json().catch(() => null) }))
    .catch(() => null);

  const domPromise = page.waitForFunction(() => {
    const results = document.querySelector('#cnrResults');
    const text = (results?.innerText || '').trim();
    return Boolean(text && text.length > 20);
  }, { timeout: 45000 })
    .then(() => ({ source: 'dom', payload: null }))
    .catch(() => null);

  const result = await Promise.race([responsePromise, domPromise]);
  if (result) return result;

  const fallback = await Promise.all([responsePromise, domPromise]).then((items) => items.find(Boolean));
  if (fallback) return fallback;

  throw new Error('Timed out waiting for the district court case-number results. The official site may be slow; please load a fresh CAPTCHA and try again.');
}

async function readPayloadFromPage(page) {
  const html = await page.locator('#history_cnr').innerHTML().catch(() => '');
  const captchaHtml = await page.locator('#div_captcha_cnr').innerHTML().catch(() => '');
  if (!html) return null;
  return {
    status: /invalid captcha|enter valid captcha|captcha/i.test(cleanHtmlText(html)) ? 0 : 1,
    casetype_list: html,
    div_captcha: captchaHtml
  };
}

async function readDistrictPayloadFromPage(page) {
  const html = await page.locator('#cnrResults').innerHTML().catch(() => '');
  const text = cleanHtmlText(html);
  if (!html) return null;
  if (/invalid captcha|captcha/i.test(text)) {
    return { invalidCaptchaDetected: true, success: false, message: 'Invalid CAPTCHA.' };
  }
  return { success: true, data: html };
}

function parseDistrictCaseNumberResult(input, payload) {
  if (payload?.success === false) {
    const parsedMessage = parseDistrictFailureMessage(payload);
    return buildFailurePayload(input, payload, parsedMessage || 'No matching district court case was found for this case-number search.');
  }

  const result = parseEcourtsResult(input, {
    status: 1,
    casetype_list: String(payload?.detailData || payload?.data || ''),
    div_captcha: ''
  });
  if (payload?.searchData) {
    result.rawMetadata = {
      ...(result.rawMetadata || {}),
      searchResults: {
        rawTextPreview: cleanHtmlText(payload.searchData).slice(0, 2000),
        history: extractCaseHistory(payload.searchData)
      }
    };
  }
  return result;
}

async function openDistrictCaseDetailsWithinPage(page, input) {
  const rows = page.locator('#cnrResults tr');
  const rowCount = await rows.count().catch(() => 0);
  let clicked = false;
  const targetCaseRef = normalizeChoice(`${input.caseType || ''} ${input.caseNumber || ''}/${input.year || ''}`);

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    const text = normalizeChoice(await row.innerText().catch(() => ''));
    const action = row.locator('.viewCnrDetails, .caseTransferredToFromCNRDetails').first();
    const hasAction = await action.count().catch(() => 0);
    if (!hasAction) continue;
    if (targetCaseRef && text && !text.includes(targetCaseRef)) continue;
    await action.click().catch(() => {});
    clicked = true;
    break;
  }

  if (!clicked) {
    const fallback = page.locator('#cnrResults .viewCnrDetails, #cnrResults .caseTransferredToFromCNRDetails').first();
    if (await fallback.count().catch(() => 0)) {
      await fallback.click().catch(() => {});
      clicked = true;
    }
  }

  if (!clicked) return '';

  await page.waitForFunction(() => {
    const el = document.querySelector('#cnrResultsDetails');
    const text = (el?.innerText || '').trim();
    return Boolean(text && text.length > 40);
  }, { timeout: 20000 }).catch(() => null);

  return await page.locator('#cnrResultsDetails').innerHTML().catch(() => '');
}

async function fetchDistrictCnrDetailsPayload(page, input, payload) {
  const searchData = String(payload?.data || '');
  if (!searchData) return null;

  const action = findBestDistrictCnrDetailsAction(input, searchData);
  if (!action) return null;

  const response = await page.evaluate(async (requestData) => {
    const body = new URLSearchParams();
    body.set('cino', requestData.cino);
    body.set('est_code', requestData.est_code);
    body.set('action', requestData.renderType === 'cavet' ? 'get_cav_details' : 'get_cnr_details');
    body.set('es_ajax_request', '1');

    const res = await fetch('/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json, text/javascript, */*; q=0.01'
      },
      body: body.toString()
    });
    return res.json().catch(() => null);
  }, action).catch(() => null);

  if (!response?.success || !response?.data) return null;
  return {
    success: true,
    data: response.data,
    detailData: response.data,
    searchData
  };
}

function findBestDistrictCnrDetailsAction(input, html) {
  const history = extractCaseHistory(html);
  const candidates = [];

  for (const table of Array.isArray(history.rawTables) ? history.rawTables : []) {
    for (const row of table.rows || []) {
      const action = (row.actions || []).find((item) => item?.type === 'getCnrDetails');
      if (!action) continue;
      const caseRefCell = row.cells?.find((cell) => /case type|case number|case year/i.test(String(cell.label || '')));
      candidates.push({
        action,
        caseRef: caseRefCell?.text || row.text || ''
      });
    }
  }

  if (!candidates.length) return null;
  const targetCaseRef = normalizeChoice(`${input.caseType || ''} ${input.caseNumber || ''}/${input.year || ''}`);
  if (targetCaseRef) {
    const exact = candidates.find((candidate) => normalizeChoice(candidate.caseRef).includes(targetCaseRef));
    if (exact) return exact.action;
  }

  return candidates[0].action;
}

async function selectDistrictComplex(page, desiredValue) {
  const options = await page.evaluate(() => {
    return [...document.querySelectorAll('#est_code option')]
      .map((option) => ({ value: option.value || '', text: (option.textContent || '').trim() }))
      .filter((option) => option.text && option.value);
  });

  const matched = matchOption(options, desiredValue);
  if (!matched) {
    throw new Error(`Court complex not found. Available options: ${options.map((option) => option.text).join('; ')}`);
  }

  await setSelectValue(page, '#est_code', matched.value);
  return matched;
}

async function trySelectDistrictCaseType(page, desiredValue) {
  const normalizedDesired = String(desiredValue || '').trim();
  if (!normalizedDesired) return '';

  await page.waitForFunction(() => {
    const select = document.querySelector('#case_type');
    return Boolean(select && !select.disabled);
  }, { timeout: 5000 }).catch(() => {});

  const options = await page.evaluate(() => {
    return [...document.querySelectorAll('#case_type option')]
      .map((option) => ({ value: option.value || '', text: (option.textContent || '').trim() }))
      .filter((option) => option.text && option.value);
  }).catch(() => []);

  const matched = matchOption(options, normalizedDesired);
  if (!matched) return normalizedDesired;

  await setSelectValue(page, '#case_type', matched.value);
  return matched.text;
}

async function getDistrictCaseTypeOptions(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('#case_type option')]
      .map((option) => (option.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 120);
  }).catch(() => []);
}

async function setSelectValue(page, selector, value) {
  await page.evaluate(({ selector: selectSelector, value: selectValue }) => {
    const element = document.querySelector(selectSelector);
    if (!element) return;
    element.value = selectValue;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, { selector, value });
  await page.waitForTimeout(400);
}

function matchOption(options, desiredValue) {
  const normalizedDesired = normalizeChoice(desiredValue);
  if (!normalizedDesired) return null;

  return options.find((option) => normalizeChoice(option.value) === normalizedDesired)
    || options.find((option) => normalizeChoice(option.text) === normalizedDesired)
    || options.find((option) => normalizeChoice(option.text).includes(normalizedDesired))
    || options.find((option) => normalizedDesired.includes(normalizeChoice(option.text)));
}

function normalizeChoice(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseDistrictFailureMessage(payload) {
  if (payload?.message) return String(payload.message);
  if (typeof payload?.data === 'string') {
    try {
      const parsed = JSON.parse(payload.data);
      if (parsed?.message) return String(parsed.message);
    } catch (_error) {
      const text = cleanHtmlText(payload.data);
      if (text) return text;
    }
  }
  return '';
}

function parseEcourtsResult(input, payload) {
  const html = String(payload.casetype_list || '');
  const text = cleanHtmlText(html);
  const fieldMap = extractFieldMap(html);
  const history = extractCaseHistory(html);
  const historyFields = extractHistorySummaryFields(history);
  const isDistrictCaseNumberLookup = input?.lookupMode === 'district_case_number';
  const sourceUrl = input?.ecourtsSourceUrl || input?.districtUrl || ECOURTS_URL;

  if (!html || /case code does not|case not found|does not exist|record not found/i.test(text)) {
    return buildFailurePayload(
      input,
      payload,
      isDistrictCaseNumberLookup
        ? 'No matching district court case was found for this case-number search.'
        : 'No matching district court case was found for this CNR.'
    );
  }

  const caseTitle = historyFields.caseTitle
    || pickField(fieldMap, ['Petitioner and Advocate', 'Petitioner'])
    || extractTitle(text);
  const status = historyFields.caseStatus
    || pickField(fieldMap, ['Case Status', 'Stage of Case', 'Case Stage', 'Status'])
    || '';
  const nextHearingDate = historyFields.nextHearingDate
    || normalizeDate(pickField(fieldMap, ['Next Hearing Date', 'Next Date', 'Next Listing Date']));
  const firstHearingDate = historyFields.firstHearingDate
    || normalizeDate(pickField(fieldMap, ['First Hearing Date']));
  const registrationNumber = historyFields.registrationNumber
    || pickField(fieldMap, ['Registration Number', 'Case Number'])
    || (input.caseNumber && input.year ? `${input.caseNumber}/${input.year}` : '')
    || input.cnrNumber;
  const latestOrder = history.orders[0] || null;

  return {
    provider: 'districtCourtCnr',
    caseFound: true,
    courtName: historyFields.courtName
      || pickField(fieldMap, ['Court Name', 'Court', 'Court Establishment'])
      || input?.districtLabel
      || COURT_NAME,
    caseNumber: registrationNumber,
    cnrNumber: historyFields.cnrNumber || input.cnrNumber,
    caseTitle,
    nextHearingDate,
    statusPageNextHearingDate: nextHearingDate,
    nextHearingDateSource: nextHearingDate ? (isDistrictCaseNumberLookup ? 'district_case_number' : 'ecourts_cnr') : '',
    courtNumber: historyFields.courtNumber || pickField(fieldMap, ['Court Number and Judge', 'Court Number', 'Judge']) || '',
    caseStatus: status || (isDistrictCaseNumberLookup ? 'Found in official district court case-number history' : 'Found in official eCourts CNR history'),
    firstHearingDate,
    lastOrderDate: latestOrder?.date || '',
    officialSourceUrl: sourceUrl,
    sourceUrl,
    ordersUrl: latestOrder?.url || '',
    judgmentsUrl: '',
    caseHistoryUrl: sourceUrl,
    filingsUrl: sourceUrl,
    listingsUrl: sourceUrl,
    latestOrderUrl: latestOrder?.url || '',
    latestOrderDate: latestOrder?.date || '',
    caseHistory: history,
    pageTitle: 'eCourts Services',
    rawTextPreview: text.slice(0, 3000),
    invalidCaptchaDetected: false,
    rawMetadata: {
      fields: fieldMap,
      ecourtsStatus: payload.status,
      history
    }
  };
}

function collectDownloadableUrls(caseData) {
  const history = caseData.caseHistory || {};
  const urls = new Set();

  for (const order of Array.isArray(history.orders) ? history.orders : []) {
    if (isUsableDocumentUrl(order.url)) urls.add(order.url);
  }

  for (const table of Array.isArray(history.rawTables) ? history.rawTables : []) {
    for (const row of table.rows || []) {
      for (const url of row.links || []) {
        if (looksDownloadable(url)) urls.add(url);
      }
      for (const cell of row.cells || []) {
        for (const url of cell.links || []) {
          if (looksDownloadable(url)) urls.add(url);
        }
      }
    }
  }

  if (isUsableDocumentUrl(caseData.latestOrderUrl) && looksDownloadable(caseData.latestOrderUrl)) urls.add(caseData.latestOrderUrl);
  if (isUsableDocumentUrl(caseData.ordersUrl) && looksDownloadable(caseData.ordersUrl)) urls.add(caseData.ordersUrl);
  return Array.from(urls);
}

async function resolveCaseHistoryActionsWithinSession(page, caseData) {
  const history = caseData.caseHistory || {};
  const actionCache = new Map();

  async function resolveAction(action) {
    if (!action || action.type !== 'displayPdf') return '';
    const key = JSON.stringify(action);
    if (actionCache.has(key)) return actionCache.get(key);

    const params = new URLSearchParams();
    params.set('normal_v', action.normal_v || '');
    params.set('case_val', action.case_num || '');
    params.set('court_code', action.court_code || '');
    params.set('filename', action.ofilename || '');
    params.set('appFlag', action.appFlag || '');

    const result = await page.evaluate(async ({ body }) => {
      const appToken = document.querySelector('#app_token, input[name="app_token"], [name="app_token"]')?.value
        || globalThis.app_token
        || globalThis.appToken
        || '';
      const response = await fetch('/ecourtindia_v6/?p=home/display_pdf', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
          'accept': 'application/json, text/javascript, */*; q=0.01'
        },
        body: `${body}&ajax_req=true&app_token=${encodeURIComponent(appToken)}`
      });
      return response.json().catch(() => null);
    }, {
      body: params.toString()
    }).catch(() => null);

    const resolved = normalizeDocumentUrl(absolutizeUrl(result?.order || ''));
    actionCache.set(key, resolved);
    return resolved;
  }

  async function resolveLinks(links, actions) {
    const next = [];
    for (const url of Array.isArray(links) ? links : []) {
      if (isUsableDocumentUrl(url)) next.push(url);
    }
    for (const action of Array.isArray(actions) ? actions : []) {
      const resolved = await resolveAction(action);
      if (resolved) next.push(resolved);
    }
    return Array.from(new Set(next));
  }

  const orders = [];
  for (const order of Array.isArray(history.orders) ? history.orders : []) {
    const resolvedUrls = await resolveLinks([order.url], [order.action]);
    orders.push({
      ...order,
      sourceUrl: order.sourceUrl || order.url || '',
      url: resolvedUrls[0] || ''
    });
  }

  const rawTables = [];
  for (const table of Array.isArray(history.rawTables) ? history.rawTables : []) {
    const rows = [];
    for (const row of table.rows || []) {
      const cells = [];
      for (const cell of row.cells || []) {
        const cellLinks = await resolveLinks(cell.links, cell.actions);
        cells.push({
          ...cell,
          links: cellLinks
        });
      }
      rows.push({
        ...row,
        cells,
        links: Array.from(new Set(cells.flatMap((cell) => cell.links || [])))
      });
    }
    rawTables.push({
      ...table,
      rows
    });
  }

  const latestOrderUrl = orders.find((order) => order.url)?.url || normalizeDocumentUrl(caseData.latestOrderUrl);
  return {
    ...caseData,
    ordersUrl: latestOrderUrl || normalizeDocumentUrl(caseData.ordersUrl),
    latestOrderUrl,
    caseHistory: {
      ...history,
      orders,
      rawTables
    }
  };
}

async function downloadDocumentWithinContext(context, url) {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    if (!response || !response.ok()) return null;
    const buffer = await response.body();
    return {
      buffer,
      contentType: response.headers()['content-type'] || ''
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function downloadDocumentWithinPageSession(page, url) {
  if (!page) return null;

  const absoluteUrl = absolutizeUrl(url);
  const responsePromise = page.waitForResponse((response) => {
    const responseUrl = response.url();
    return responseUrl === absoluteUrl || responseUrl.startsWith(absoluteUrl);
  }, { timeout: 30000 }).catch(() => null);

  const triggerResult = await page.evaluate(async (targetUrl) => {
    const response = await fetch(targetUrl, {
      credentials: 'include',
      headers: {
        'accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8'
      }
    });
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') || ''
    };
  }, absoluteUrl).catch(() => null);

  const response = await responsePromise;
  if (!response?.ok() || !triggerResult?.ok) return null;

  return {
    buffer: Buffer.from(await response.body()),
    contentType: response.headers()['content-type'] || triggerResult.contentType || ''
  };
}

async function downloadDocumentWithAccess(url, access) {
  const headers = {
    'accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
    'referer': ECOURTS_URL,
    'user-agent': 'CourtTrackPrototype/1.0 (+district document cache)'
  };
  const cookieHeader = buildCookieHeader(access?.cookies);
  if (cookieHeader) headers.cookie = cookieHeader;

  const response = await fetch(absolutizeUrl(url), { headers });
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    contentType: response.headers.get('content-type') || ''
  };
}

function isPdf(download) {
  return String(download.contentType || '').toLowerCase().includes('pdf') || download.buffer.slice(0, 4).toString() === '%PDF';
}

function buildDocumentBaseName(caseData, url) {
  const text = `${caseData.caseNumber || caseData.cnrNumber || 'district-court'} ${url}`;
  if (/downloadorder|order/i.test(url)) return `${text} order`;
  return `${text} pdf`;
}

function applyDocumentReplacements(caseData, replacements) {
  const nextCaseData = {
    ...caseData,
    ordersUrl: replacements.get(caseData.ordersUrl) || caseData.ordersUrl || '',
    latestOrderUrl: replacements.get(caseData.latestOrderUrl) || caseData.latestOrderUrl || ''
  };

  const history = caseData.caseHistory || {};
  nextCaseData.caseHistory = {
    ...history,
    orders: (Array.isArray(history.orders) ? history.orders : []).map((order) => ({
      ...order,
      sourceUrl: order.sourceUrl || order.url || '',
      url: replacements.get(order.url) || order.url
    })),
    rawTables: (Array.isArray(history.rawTables) ? history.rawTables : []).map((table) => ({
      ...table,
      rows: (table.rows || []).map((row) => ({
        ...row,
        links: (row.links || []).map((url) => replacements.get(url) || url),
        cells: (row.cells || []).map((cell) => ({
          ...cell,
          links: (cell.links || []).map((url) => replacements.get(url) || url)
        }))
      }))
    }))
  };

  return nextCaseData;
}

function looksDownloadable(url) {
  return isUsableDocumentUrl(url) && /download|display_pdf|showlogo|\.pdf(?:$|[/?])/i.test(String(url || ''));
}

function extractFieldMap(html) {
  const fields = {};
  const rows = [...String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((match) => cleanHtmlText(match[1]))
      .filter(Boolean);
    if (cells.length < 2) continue;

    for (let index = 0; index < cells.length - 1; index += 2) {
      const label = normalizeLabel(cells[index]);
      const value = cells[index + 1];
      if (label && value && !fields[label]) fields[label] = value;
    }

    if (cells.length === 2) {
      const label = normalizeLabel(cells[0]);
      if (label && cells[1] && !fields[label]) fields[label] = cells[1];
    }
  }

  return fields;
}

function extractCaseHistory(html) {
  const tables = [...String(html || '').matchAll(/<table[\s\S]*?<\/table>/gi)].map((match) => match[0]);
  const history = {
    filings: [],
    listings: [],
    hearings: [],
    orders: [],
    rawTables: []
  };

  for (const table of tables) {
    const header = cleanHtmlText((table.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i) || [])[1] || table).toLowerCase();
    const rows = extractRows(table);
    if (rows.length) {
      history.rawTables.push({
        title: classifyHistoryTable(header),
        columns: rows[0].map((cell, index) => cell.label || `Column ${index + 1}`),
        rows: rows.map((cells) => ({
          cells: cells.map((cell, index) => ({
            label: cell.label || `Column ${index + 1}`,
            text: cell.text,
            links: cell.links,
            actions: cell.actions
          })),
          text: cells.map((cell) => cell.text).filter(Boolean).join(' | '),
          links: cells.flatMap((cell) => cell.links),
          actions: cells.flatMap((cell) => cell.actions || [])
        }))
      });
    }

    if (/filing|objection|scrutiny/.test(header)) {
      history.filings.push(...rows.map(parseGenericRow).filter((row) => row.date || row.details));
    } else if (/business|hearing|purpose/.test(header)) {
      history.hearings.push(...rows.map(parseHearingRow).filter((row) => row.businessDate || row.nextDate || row.purpose || row.business));
    } else if (/order|judg/.test(header)) {
      history.orders.push(...rows.map(parseOrderRow).filter((row) => row.date || row.url || row.details));
    }
  }

  history.listings = history.hearings.map((hearing, index) => ({
    serialNumber: hearing.serialNumber || String(index + 1),
    date: hearing.nextDate || hearing.businessDate || '',
    details: [hearing.purpose, hearing.business].filter(Boolean).join(' | '),
    orderUrl: ''
  })).filter((row) => row.date || row.details);

  history.orders.sort((a, b) => dateSortValue(b.date) - dateSortValue(a.date));
  return history;
}

function classifyHistoryTable(header) {
  if (/filing|objection|scrutiny/.test(header)) return 'Filing Details';
  if (/business|hearing|purpose/.test(header)) return 'Case History';
  if (/order|judg/.test(header)) return 'Orders';
  return 'Case History';
}

function extractRows(tableHtml) {
  const body = String(tableHtml || '').match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || tableHtml;
  const headers = [...String(tableHtml || '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => normalizeLabel(cleanHtmlText(match[1])));

  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) => {
      const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cellMatch, index) => ({
        label: headers[index] || '',
        text: cleanHtmlText(cellMatch[1]),
        links: extractLinks(cellMatch[1]),
        actions: extractActions(cellMatch[1])
      }));
      return cells;
    })
    .filter((cells) => cells.length && cells.some((cell) => cell.text || cell.links.length));
}

function parseGenericRow(cells) {
  const byLabel = Object.fromEntries(cells.map((cell) => [cell.label, cell]));
  return {
    serialNumber: firstText(byLabel, cells, ['Sr No', 'Serial No']) || cells[0]?.text || '',
    date: normalizeDate(firstText(byLabel, cells, ['Date', 'Filing Date', 'Registration Date']) || findDate(cells.map((cell) => cell.text).join(' '))),
    details: firstText(byLabel, cells, ['Filing Details', 'Details', 'Case Details']) || cells.map((cell) => cell.text).filter(Boolean).slice(1).join(' | '),
    diaryNumber: String(cells.map((cell) => cell.text).join(' ')).match(/diary\s+no\.?\s*[:\-]?\s*([0-9/ -]+)/i)?.[1]?.trim() || '',
    status: String(cells.map((cell) => cell.text).join(' ')).match(/\bstatus\s*[:\-]?\s*([A-Z][A-Z ]{0,30})\b/i)?.[1]?.trim() || ''
  };
}

function parseHearingRow(cells) {
  const byLabel = Object.fromEntries(cells.map((cell) => [cell.label, cell]));
  return {
    serialNumber: firstText(byLabel, cells, ['Sr No', 'Serial No']) || cells[0]?.text || '',
    judge: firstText(byLabel, cells, ['Judge', 'Court Judge']) || '',
    businessDate: normalizeDate(firstText(byLabel, cells, ['Business On Date', 'Hearing Date', 'Last Hearing Date']) || findDate(cells.map((cell) => cell.text).join(' '))),
    nextDate: normalizeDate(firstText(byLabel, cells, ['Next Hearing Date', 'Next Date', 'Next Listing Date']) || ''),
    purpose: firstText(byLabel, cells, ['Purpose Of Hearing', 'Purpose', 'Next Purpose']) || '',
    business: firstText(byLabel, cells, ['Business', 'Short Order', 'Proceedings']) || ''
  };
}

function parseOrderRow(cells) {
  const byLabel = Object.fromEntries(cells.map((cell) => [cell.label, cell]));
  const allLinks = cells.flatMap((cell) => cell.links);
  const allActions = cells.flatMap((cell) => cell.actions || []);
  return {
    serialNumber: firstText(byLabel, cells, ['Order Number', 'Sr No', 'Serial No']) || cells[0]?.text || '',
    date: normalizeDate(firstText(byLabel, cells, ['Order Date', 'Date Of Order', 'Date']) || findDate(cells.map((cell) => cell.text).join(' '))),
    details: firstText(byLabel, cells, ['Order Details', 'Details', 'Order']) || cells.map((cell) => cell.text).filter(Boolean).join(' | '),
    url: allLinks.find((url) => isUsableDocumentUrl(url)) || '',
    action: allActions.find((action) => action.type === 'displayPdf') || null
  };
}

function firstText(byLabel, cells, labels) {
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    if (byLabel[normalized]?.text) return byLabel[normalized].text;
  }

  for (const label of labels) {
    const normalized = normalizeLabel(label).toLowerCase();
    const match = cells.find((cell) => cell.label.toLowerCase().includes(normalized));
    if (match?.text) return match.text;
  }

  return '';
}

function pickField(fields, names) {
  for (const name of names) {
    const normalized = normalizeLabel(name);
    if (fields[normalized]) return fields[normalized];
  }
  const lowered = Object.entries(fields).find(([key]) => names.some((name) => key.toLowerCase().includes(normalizeLabel(name).toLowerCase())));
  return lowered?.[1] || '';
}

function extractHistorySummaryFields(history) {
  const petitioner = pickHistoryField(history, ['Petitioner and Advocate', 'Petitioner']);
  const respondent = pickHistoryField(history, ['Respondent and Advocate', 'Respondent']);
  return {
    caseTitle: buildCaseTitle(petitioner, respondent),
    caseStatus: pickHistoryField(history, ['Case Status', 'Status', 'Stage of Case', 'Case Stage']),
    nextHearingDate: normalizeDate(pickHistoryField(history, ['Next Hearing Date', 'Next Date', 'Next Listing Date'])),
    firstHearingDate: normalizeDate(pickHistoryField(history, ['First Hearing Date'])),
    registrationNumber: pickHistoryField(history, ['Registration Number', 'Case Number']),
    cnrNumber: pickHistoryField(history, ['CNR Number', 'CNR No']),
    courtName: pickHistoryField(history, ['Court Name', 'Court', 'Court Establishment']),
    courtNumber: pickHistoryField(history, ['Court Number and Judge', 'Court Number', 'Judge'])
  };
}

function pickHistoryField(history, names) {
  const wanted = names.map((name) => normalizeLabel(name).toLowerCase());
  for (const table of Array.isArray(history?.rawTables) ? history.rawTables : []) {
    for (const row of Array.isArray(table.rows) ? table.rows : []) {
      for (const cell of Array.isArray(row.cells) ? row.cells : []) {
        const label = normalizeLabel(cell.label).toLowerCase();
        if (!label || !String(cell.text || '').trim()) continue;
        if (wanted.includes(label)) return cell.text;
      }
    }
  }

  for (const table of Array.isArray(history?.rawTables) ? history.rawTables : []) {
    for (const row of Array.isArray(table.rows) ? table.rows : []) {
      for (const cell of Array.isArray(row.cells) ? row.cells : []) {
        const label = normalizeLabel(cell.label).toLowerCase();
        if (!label || !String(cell.text || '').trim()) continue;
        if (wanted.some((name) => label.includes(name) || name.includes(label))) return cell.text;
      }
    }
  }
  return '';
}

function buildCaseTitle(petitioner, respondent) {
  const left = normalizePartyName(petitioner);
  const right = normalizePartyName(respondent);
  if (left && right) return `${left} VS. ${right}`;
  return left || right || '';
}

function normalizePartyName(value) {
  return String(value || '')
    .split(/\badvocate\b/i)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html) {
  return extractAnchorDescriptors(html)
    .flatMap((anchor) => {
      const urls = [];
      if (isUsableDocumentUrl(anchor.href)) urls.push(anchor.href);
      for (const quoted of anchor.quotedUrls) {
        if (isUsableDocumentUrl(quoted)) urls.push(quoted);
      }
      return urls;
    })
    .filter(Boolean);
}

function extractActions(html) {
  const actions = [
    ...extractAnchorDescriptors(html).flatMap((anchor) => anchor.actions || []),
    ...extractElementActionDescriptors(html).flatMap((element) => element.actions || [])
  ].filter(Boolean);

  const seen = new Set();
  return actions.filter((action) => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractAnchorDescriptors(html) {
  return [...String(html || '').matchAll(/<a\b([^>]*)>/gi)].map((match) => {
    const attrs = match[1] || '';
    const rawHref = extractAttribute(attrs, 'href').replace(/\\\//g, '/');
    const href = looksLikeUrlCandidate(rawHref) ? absolutizeUrl(rawHref) : '';
    const onclick = extractAttribute(attrs, 'onclick');
    const className = extractAttribute(attrs, 'class');
    const actions = [];
    if (/displayPdf\s*\(/i.test(onclick)) {
      const args = extractJsStringArgs(onclick);
      if (args.length >= 4) {
        actions.push({
          type: 'displayPdf',
          normal_v: args[0] || '',
          case_num: args[1] || '',
          court_code: args[2] || '',
          ofilename: args[3] || '',
          appFlag: args[4] || ''
        });
      }
    }
    if (/\bviewCnrDetails\b|\bcaseTransferredToFromCNRDetails\b/.test(className)) {
      const cino = extractAttribute(attrs, 'data-cno');
      const est_code = extractAttribute(attrs, 'data-est-code');
      const renderType = extractAttribute(attrs, 'data-render-type');
      if (cino && est_code) {
        actions.push({
          type: 'getCnrDetails',
          cino,
          est_code,
          renderType
        });
      }
    }
    const quotedUrls = extractJsStringArgs(onclick)
      .map((value) => String(value || '').replace(/\\\//g, '/'))
      .filter((value) => looksLikeUrlCandidate(value))
      .map((value) => absolutizeUrl(value))
      .filter(Boolean);
    return { href, actions, quotedUrls };
  });
}

function extractElementActionDescriptors(html) {
  return [...String(html || '').matchAll(/<([a-z0-9:-]+)\b([^>]*)>/gi)].map((match) => {
    const attrs = match[2] || '';
    const onclick = extractAttribute(attrs, 'onclick');
    const className = extractAttribute(attrs, 'class');
    const actions = [];

    if (/displayPdf\s*\(/i.test(onclick)) {
      const args = extractJsStringArgs(onclick);
      if (args.length >= 4) {
        actions.push({
          type: 'displayPdf',
          normal_v: args[0] || '',
          case_num: args[1] || '',
          court_code: args[2] || '',
          ofilename: args[3] || '',
          appFlag: args[4] || ''
        });
      }
    }

    if (/\bviewCnrDetails\b|\bcaseTransferredToFromCNRDetails\b/.test(className)) {
      const cino = extractAttribute(attrs, 'data-cno');
      const est_code = extractAttribute(attrs, 'data-est-code');
      const renderType = extractAttribute(attrs, 'data-render-type');
      if (cino && est_code) {
        actions.push({
          type: 'getCnrDetails',
          cino,
          est_code,
          renderType
        });
      }
    }

    return { actions };
  }).filter((entry) => entry.actions.length);
}

function extractAttribute(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i'));
  if (match) return match[2] || '';
  const bare = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, 'i'));
  return bare?.[1] || '';
}

function extractJsStringArgs(value) {
  return [...String(value || '').matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2] ?? '');
}

function buildFailurePayload(input, payload, message) {
  const sourceUrl = input?.ecourtsSourceUrl || input?.districtUrl || ECOURTS_URL;
  return {
    provider: 'districtCourtCnr',
    caseFound: false,
    courtName: input?.districtLabel || COURT_NAME,
    caseNumber: input.caseNumber ? `${input.caseType ? `${input.caseType} ` : ''}${input.caseNumber}/${input.year || ''}`.trim() : (input.cnrNumber || ''),
    cnrNumber: input.cnrNumber || '',
    caseTitle: '',
    nextHearingDate: '',
    courtNumber: '',
    caseStatus: message,
    lastOrderDate: '',
    officialSourceUrl: sourceUrl,
    sourceUrl,
    invalidCaptchaDetected: /captcha/i.test(message),
    rawTextPreview: cleanHtmlText(payload?.casetype_list || '').slice(0, 1200),
    rawMetadata: { ecourtsStatus: payload?.status ?? null }
  };
}

function createDistrictDebugTrace(input) {
  return {
    lookupMode: input?.lookupMode || '',
    startedAt: new Date().toISOString(),
    events: []
  };
}

function pushDistrictDebug(trace, stage, details = {}) {
  if (!trace || !Array.isArray(trace.events)) return;
  trace.events.push({
    at: new Date().toISOString(),
    stage,
    ...details
  });
}

async function collectDistrictPageSnapshot(page) {
  if (!page) return {};
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    bodyPreview: await page.locator('body').innerText().then((text) => cleanHtmlText(text).slice(0, DISTRICT_DEBUG_PREVIEW_LIMIT)).catch(() => ''),
    hasCaptchaImage: await page.locator('#siwp_captcha_image_0, #captcha_image').first().count().then((count) => count > 0).catch(() => false),
    complexOptions: await page.locator('#est_code option').count().catch(() => 0),
    caseTypeDisabled: await page.locator('#case_type').evaluate((element) => Boolean(element?.disabled)).catch(() => null),
    caseTypeOptions: await page.locator('#case_type option').count().catch(() => 0)
  };
}

async function withDistrictDebug(error, trace, page, stage) {
  pushDistrictDebug(trace, 'error', {
    stage,
    message: String(error?.message || error || 'Unknown district court error'),
    snapshot: await collectDistrictPageSnapshot(page)
  });

  const wrapped = new Error(`[district:${stage}] ${String(error?.message || error || 'Unknown district court error')}`);
  wrapped.districtDebug = trace;
  wrapped.cause = error;
  return wrapped;
}

function normalizeCnr(value) {
  const cnr = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cnr.length === 16 ? cnr : '';
}

function normalizeLabel(value) {
  return cleanHtmlText(value).replace(/[:：]+$/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  const numericMatch = String(value || '').match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (numericMatch) {
    return [
      numericMatch[1].padStart(2, '0'),
      numericMatch[2].padStart(2, '0'),
      numericMatch[3]
    ].join('-');
  }

  const cleaned = String(value || '')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .replace(/,/g, ' ');
  const namedMatch = cleaned.match(/\b(\d{1,2})[-/.\s]+([A-Za-z]{3,9})[-/.\s]+(\d{4})\b/);
  if (!namedMatch) return '';
  const month = parseMonthToken(namedMatch[2]);
  if (!month) return '';
  return [
    namedMatch[1].padStart(2, '0'),
    String(month).padStart(2, '0'),
    namedMatch[3]
  ].join('-');
}

function findDate(value) {
  return normalizeDate(value);
}

function parseMonthToken(value) {
  const token = String(value || '').trim().toLowerCase();
  const months = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12
  };
  return months[token] || 0;
}

function dateSortValue(value) {
  const match = String(value || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return 0;
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime();
}

function extractTitle(text) {
  const match = String(text || '').match(/([A-Z][A-Z .'-]+)\s+(?:versus|vs\.?|v\.)\s+([A-Z][A-Z .'-]+)/i);
  return match ? `${match[1].trim()} VS. ${match[2].trim()}` : '';
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

function absolutizeUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `https://services.ecourts.gov.in${url}`;
  return `https://services.ecourts.gov.in/ecourtindia_v6/${url.replace(/^\.\//, '')}`;
}

function parseDisplayPdfPayload(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_error) {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch (_nestedError) {
        return null;
      }
    }
    return null;
  }
}

function extractDisplayPdfOrderUrl(payload, rawText) {
  const candidates = [
    payload?.order,
    payload?.url,
    payload?.pdf,
    payload?.pdf_url,
    payload?.file,
    payload?.filename
  ];

  for (const candidate of candidates) {
    const normalized = normalizeDocumentUrl(absolutizeUrl(String(candidate || '').replace(/\\\//g, '/')));
    if (normalized) return normalized;
  }

  const text = String(rawText || '');
  const explicitMatch = text.match(/"order"\s*:\s*"([^"]+)"/i)
    || text.match(/"url"\s*:\s*"([^"]+)"/i)
    || text.match(/"pdf(?:_url)?"\s*:\s*"([^"]+)"/i)
    || text.match(/(\/ecourtindia_v6\/[^"'\\s>]+(?:pdf|download)[^"'\\s>]*)/i);
  if (!explicitMatch?.[1]) return '';

  return normalizeDocumentUrl(absolutizeUrl(String(explicitMatch[1] || '').replace(/\\\//g, '/')));
}

function normalizeDocumentUrl(url) {
  return isUsableDocumentUrl(url) ? url : '';
}

function isUsableDocumentUrl(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (value === '#' || value.endsWith('/#') || value.endsWith('#')) return false;
  return /^(https?:\/\/|\/)/i.test(value);
}

function looksLikeUrlCandidate(value) {
  return /^(https?:\/\/|\/|\.\/)/i.test(String(value || '')) || /(display_pdf|download|showlogo|\.pdf(?:$|[/?]))/i.test(String(value || ''));
}

function normalizeOrderAction(action) {
  if (!action || typeof action !== 'object') return null;
  const normalized = {
    normal_v: String(action.normal_v || '').trim(),
    case_num: String(action.case_num || '').trim(),
    court_code: String(action.court_code || '').trim(),
    ofilename: String(action.ofilename || '').trim(),
    appFlag: String(action.appFlag || '').trim()
  };
  return normalized.normal_v && normalized.case_num && normalized.court_code && normalized.ofilename ? normalized : null;
}

async function captureEcourtsAccess(session) {
  const appToken = await session?.page?.evaluate(() => {
    return document.querySelector('#app_token, input[name="app_token"], [name="app_token"]')?.value
      || globalThis.app_token
      || globalThis.appToken
      || '';
  }).catch(() => '') || '';
  const cookies = await session?.context?.cookies(ECOURTS_URL).catch(() => []) || [];
  return { appToken, cookies };
}

function buildCookieHeader(cookies) {
  return Array.isArray(cookies)
    ? cookies
      .filter((cookie) => cookie?.name && cookie?.value)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
    : '';
}

module.exports = new DistrictCourtCnrProvider();
