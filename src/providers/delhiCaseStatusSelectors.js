async function getCaseTypeDropdown(page) {
  return findFirstVisibleLocator(page, [
    '#case_type',
    'select[name="case_type"]'
  ], 'string');
}

async function getCaseNumberInput(page) {
  return findFirstVisibleLocator(page, [
    '#case_number',
    'input[name="case_number"]'
  ], 'Delhi case number input');
}

async function getYearDropdown(page) {
  return findFirstVisibleLocator(page, [
    '#case_year',
    'select[name="case_year"]'
  ], 'Delhi year dropdown');
}

async function getCaptchaInput(page) {
  return findFirstVisibleLocator(page, [
    '#captchaInput',
    'input[name="captchaInput"]'
  ], 'Delhi CAPTCHA input');3
}

async function getSubmitButton(page) {
  return findFirstVisibleLocator(page, [
    '#search',
    'button#search',
    'button:has-text("Submit")'
  ], 'Delhi submit button');
}

async function getCaptchaImage(page) {
  return findFirstVisibleLocator(page, [
    'img#captcha-image',
    '#captcha-image',
    'label#cap',
    '#captcha-code'
  ], 'Delhi CAPTCHA image');
}

async function getResultsTable(page) {
  return findFirstVisibleLocator(page, [
    '#caseTable',
    'table#caseTable'
  ], 'Delhi results table');
}

async function findFirstVisibleLocator(page, selectors, description) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;

    const visible = await locator.isVisible().catch(() => false);
    if (visible) return locator;
  }

  throw new Error(`Could not find the ${description} on the official Delhi case-status page.`);
}

module.exports = {
  getCaseTypeDropdown,
  getCaseNumberInput,
  getYearDropdown,
  getCaptchaInput,
  getSubmitButton,
  getCaptchaImage,
  getResultsTable
};
