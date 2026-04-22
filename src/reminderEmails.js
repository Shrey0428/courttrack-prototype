const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function parseReminderEmails(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '')
        .split(/[\n,;]+/g)
        .map((value) => value.trim());

  const unique = [];
  const seen = new Set();
  const invalid = [];

  for (const raw of values) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL_PATTERN.test(email)) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    unique.push(email);
  }

  return { emails: unique, invalid };
}

function parseReminderEmailsFromInput(input) {
  if (!input || typeof input !== 'object') {
    return parseReminderEmails('');
  }
  if (Array.isArray(input.reminderEmails)) {
    return parseReminderEmails(input.reminderEmails);
  }
  if (typeof input.reminderEmails === 'string' && input.reminderEmails.trim()) {
    return parseReminderEmails(input.reminderEmails);
  }
  return parseReminderEmails(input.reminderEmail || '');
}

function formatReminderEmails(emails) {
  return (Array.isArray(emails) ? emails : []).join(', ');
}

module.exports = {
  formatReminderEmails,
  parseReminderEmails,
  parseReminderEmailsFromInput
};
