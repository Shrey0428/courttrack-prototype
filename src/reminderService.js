const nodemailer = require('nodemailer');
const { readDb, writeDb, id } = require('./db');
const { formatReminderEmails } = require('./reminderEmails');

const REMINDER_INTERVAL_MS = Number(process.env.REMINDER_INTERVAL_MS || 60 * 60 * 1000);
const DAY_MS = 24 * 60 * 60 * 1000;

let transporter;

function getReminderConfig() {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  return {
    host: process.env.SMTP_HOST || '',
    port,
    secure,
    user: process.env.SMTP_USER || '',
    pass: String(process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    replyTo: process.env.SMTP_REPLY_TO || ''
  };
}

function getReminderStatus() {
  const config = getReminderConfig();
  const configured = Boolean(config.host && config.port && config.from);
  const authenticated = Boolean(config.user && config.pass);

  return {
    configured,
    authenticated,
    from: config.from,
    host: config.host,
    port: config.port,
    secure: config.secure
  };
}

async function runReminderSweep() {
  const db = readDb();
  const status = getReminderStatus();
  const now = new Date();
  const today = startOfDay(now);
  const results = [];

  if (!status.configured) {
    return {
      ok: false,
      skipped: true,
      reason: 'SMTP is not configured.',
      results
    };
  }

  for (const trackedCase of db.trackedCases) {
    const eligibility = getReminderEligibility(trackedCase, today);
    if (!eligibility.shouldSend) {
      results.push({
        caseId: trackedCase.id,
        caseNumber: trackedCase.latestCaseNumber || trackedCase.displayLabel,
        sent: false,
        skipped: true,
        reason: eligibility.reason
      });
      continue;
    }

    if (hasSentReminder(db, trackedCase.id, eligibility.dateKey, eligibility.daysUntil)) {
      results.push({
        caseId: trackedCase.id,
        caseNumber: trackedCase.latestCaseNumber || trackedCase.displayLabel,
        sent: false,
        skipped: true,
        reason: 'Reminder already sent for today.'
      });
      continue;
    }

    try {
      await sendReminderEmail(trackedCase, eligibility);
      const recipientLabel = formatReminderEmails(trackedCase.reminderEmails);
      db.reminderDeliveries.push({
        id: id('reminder'),
        trackedCaseId: trackedCase.id,
        status: 'sent',
        reminderDate: eligibility.dateKey,
        daysUntilHearing: eligibility.daysUntil,
        email: recipientLabel,
        emails: trackedCase.reminderEmails,
        createdAt: now.toISOString()
      });
      results.push({
        caseId: trackedCase.id,
        caseNumber: trackedCase.latestCaseNumber || trackedCase.displayLabel,
        sent: true,
        email: recipientLabel,
        emails: trackedCase.reminderEmails,
        daysUntilHearing: eligibility.daysUntil
      });
    } catch (error) {
      const recipientLabel = formatReminderEmails(trackedCase.reminderEmails);
      db.reminderDeliveries.push({
        id: id('reminder'),
        trackedCaseId: trackedCase.id,
        status: 'failed',
        reminderDate: eligibility.dateKey,
        daysUntilHearing: eligibility.daysUntil,
        email: recipientLabel,
        emails: trackedCase.reminderEmails,
        error: error.message,
        createdAt: now.toISOString()
      });
      results.push({
        caseId: trackedCase.id,
        caseNumber: trackedCase.latestCaseNumber || trackedCase.displayLabel,
        sent: false,
        skipped: false,
        reason: error.message
      });
    }
  }

  writeDb(db);
  return {
    ok: true,
    skipped: false,
    results
  };
}

async function sendTestReminderEmail(trackedCase) {
  if (!trackedCase) {
    throw new Error('Tracked case not found.');
  }
  if (!trackedCase.reminderEmails?.length) {
    throw new Error('No reminder emails configured for this case.');
  }

  const hearingDate = parseIndianDate(trackedCase.latestNextHearingDate);
  const eligibility = {
    daysUntil: hearingDate ? Math.max(0, Math.round((hearingDate.getTime() - startOfDay(new Date()).getTime()) / DAY_MS)) : 'unknown',
    hearingDate,
    dateKey: formatDateKey(startOfDay(new Date()))
  };

  const mailer = getTransporter();
  const links = buildDocumentLinks(trackedCase);

  await mailer.sendMail({
    from: getReminderConfig().from,
    to: trackedCase.reminderEmails.join(', '),
    replyTo: getReminderConfig().replyTo || undefined,
    subject: `Test reminder: ${trackedCase.latestCaseNumber || trackedCase.displayLabel}`,
    text: buildReminderText(trackedCase, eligibility, links, true),
    html: buildReminderHtml(trackedCase, eligibility, links, true)
  });

  const db = readDb();
  db.reminderDeliveries.push({
    id: id('reminder'),
    trackedCaseId: trackedCase.id,
    status: 'sent',
    reminderDate: eligibility.dateKey,
    daysUntilHearing: typeof eligibility.daysUntil === 'number' ? eligibility.daysUntil : null,
    email: formatReminderEmails(trackedCase.reminderEmails),
    emails: trackedCase.reminderEmails,
    kind: 'test',
    createdAt: new Date().toISOString()
  });
  writeDb(db);

  return {
    ok: true,
    email: formatReminderEmails(trackedCase.reminderEmails),
    emails: trackedCase.reminderEmails
  };
}

function getReminderEligibility(trackedCase, today) {
  if (!trackedCase.reminderEnabled) {
    return { shouldSend: false, reason: 'Reminders are disabled for this case.' };
  }

  if (!trackedCase.reminderEmails?.length) {
    return { shouldSend: false, reason: 'No reminder emails configured.' };
  }

  if (/disposed/i.test(String(trackedCase.latestStatus || ''))) {
    return { shouldSend: false, reason: 'Disposed cases do not receive reminders.' };
  }

  const hearingDate = parseIndianDate(trackedCase.latestNextHearingDate);
  if (!hearingDate) {
    return { shouldSend: false, reason: 'No valid next hearing date available.' };
  }

  const daysUntil = Math.round((hearingDate.getTime() - today.getTime()) / DAY_MS);
  if (daysUntil < 0 || daysUntil > 3) {
    return { shouldSend: false, reason: 'Hearing is not within the reminder window.' };
  }

  return {
    shouldSend: true,
    daysUntil,
    hearingDate,
    dateKey: formatDateKey(today)
  };
}

function hasSentReminder(db, trackedCaseId, reminderDate, daysUntilHearing) {
  return db.reminderDeliveries.some((delivery) =>
    delivery.trackedCaseId === trackedCaseId &&
    delivery.status === 'sent' &&
    delivery.reminderDate === reminderDate &&
    delivery.daysUntilHearing === daysUntilHearing
  );
}

async function sendReminderEmail(trackedCase, eligibility) {
  const mailer = getTransporter();
  const subject = buildReminderSubject(trackedCase, eligibility.daysUntil);
  const links = buildDocumentLinks(trackedCase);

  await mailer.sendMail({
    from: getReminderConfig().from,
    to: trackedCase.reminderEmails.join(', '),
    replyTo: getReminderConfig().replyTo || undefined,
    subject,
    text: buildReminderText(trackedCase, eligibility, links, false),
    html: buildReminderHtml(trackedCase, eligibility, links, false)
  });
}

function getTransporter() {
  if (transporter) return transporter;

  const config = getReminderConfig();
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined
  });

  return transporter;
}

function buildReminderSubject(trackedCase, daysUntil) {
  const prefix = daysUntil === 0 ? 'Hearing today' : `Hearing in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
  return `${prefix}: ${trackedCase.latestCaseNumber || trackedCase.displayLabel}`;
}

function buildReminderText(trackedCase, eligibility, links, isTest) {
  const lines = [
    `${isTest ? 'Test reminder' : 'Court hearing reminder'} for ${trackedCase.latestCaseNumber || trackedCase.displayLabel}`,
    '',
    `Case title: ${trackedCase.latestCaseTitle || 'Not available'}`,
    `Court: ${trackedCase.latestCourtName || 'High Court of Delhi'}`,
    `Status: ${trackedCase.latestStatus || 'Not available'}`,
    `Next hearing date: ${trackedCase.latestNextHearingDate || 'Not available'}`,
    `Court number: ${trackedCase.latestCourtNumber || 'Not available'}`,
    `Days until hearing: ${eligibility.daysUntil}`,
    `Official source: ${trackedCase.officialSourceUrl || 'Not available'}`
  ];

  if (links.ordersUrl) lines.push(`Orders: ${links.ordersUrl}`);
  if (links.judgmentsUrl) lines.push(`Judgments: ${links.judgmentsUrl}`);

  return lines.join('\n');
}

function buildReminderHtml(trackedCase, eligibility, links, isTest) {
  const detailRows = [
    ['Case title', escapeHtml(trackedCase.latestCaseTitle || 'Not available')],
    ['Court', escapeHtml(trackedCase.latestCourtName || 'High Court of Delhi')],
    ['Status', escapeHtml(trackedCase.latestStatus || 'Not available')],
    ['Next hearing date', escapeHtml(trackedCase.latestNextHearingDate || 'Not available')],
    ['Court number', escapeHtml(trackedCase.latestCourtNumber || 'Not available')],
    ['Days until hearing', String(eligibility.daysUntil)],
    ['Official source', trackedCase.officialSourceUrl ? `<a href="${trackedCase.officialSourceUrl}">${escapeHtml(trackedCase.officialSourceUrl)}</a>` : 'Not available']
  ];

  const documents = [links.ordersUrl ? `<a href="${links.ordersUrl}">Orders</a>` : '', links.judgmentsUrl ? `<a href="${links.judgmentsUrl}">Judgments</a>` : '']
    .filter(Boolean)
    .join(' | ') || 'Not available';

  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #14213d;">
      <h2 style="margin-bottom: 8px;">${isTest ? 'Test reminder' : 'Court hearing reminder'}</h2>
      <p style="margin-top: 0;"><strong>${escapeHtml(trackedCase.latestCaseNumber || trackedCase.displayLabel)}</strong></p>
      <table style="border-collapse: collapse;">
        ${detailRows.map(([label, value]) => `<tr><td style="padding: 4px 12px 4px 0;"><strong>${label}</strong></td><td style="padding: 4px 0;">${value}</td></tr>`).join('')}
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Documents</strong></td><td style="padding: 4px 0;">${documents}</td></tr>
      </table>
    </div>
  `;
}

function buildDocumentLinks(trackedCase) {
  return {
    ordersUrl: trackedCase.latestOrdersUrl || '',
    judgmentsUrl: trackedCase.latestJudgmentsUrl || ''
  };
}

function parseIndianDate(value) {
  const match = String(value || '').trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;

  const [, dd, mm, yyyy] = match;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return Number.isNaN(date.getTime()) ? null : startOfDay(date);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  REMINDER_INTERVAL_MS,
  getReminderStatus,
  runReminderSweep,
  sendTestReminderEmail
};
