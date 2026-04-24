function getPlaywrightLaunchOptions() {
  return {
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  };
}

function getPlaywrightContextOptions() {
  return {
    userAgent: process.env.PLAYWRIGHT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true
  };
}

async function launchLookupBrowser(chromium) {
  return chromium.launch(getPlaywrightLaunchOptions());
}

async function createLookupContext(browser) {
  try {
    return await browser.newContext(getPlaywrightContextOptions());
  } catch (error) {
    const message = String(error?.message || error || '');
    if (!/expected pattern|string did not match/i.test(message)) {
      throw error;
    }
    return browser.newContext({
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true
    });
  }
}

async function prepareLookupPage(page) {
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

module.exports = {
  createLookupContext,
  getPlaywrightLaunchOptions,
  getPlaywrightContextOptions,
  launchLookupBrowser,
  prepareLookupPage
};
