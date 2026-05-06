const nodemailer = require('nodemailer');
const { id } = require('./db');
const { formatReminderEmails } = require('./reminderEmails');

let transporter;

const ALERTABLE_EVENT_TYPES = new Set([
  'filing_added',
  'listing_added',
  'order_added',
  'latest_order_uploaded',
  'judgment_published',
  'hearing_date_changed'
]);

function getMailConfig() {
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

function isMailConfigured() {
  const config = getMailConfig();
  return Boolean(config.host && config.port && config.from);
}

function shouldSendCaseUpdateAlerts(trackedCase) {
  return Boolean(
    trackedCase &&
    trackedCase.provider === 'delhiManualCaptcha' &&
    trackedCase.reminderEnabled &&
    Array.isArray(trackedCase.reminderEmails) &&
    trackedCase.reminderEmails.length &&
    isMailConfigured()
  );
}

async function sendCaseUpdateAlerts(db, trackedCase, events, snapshotPayload) {
  if (!shouldSendCaseUpdateAlerts(trackedCase)) {
    return { sent: false, skipped: true, reason: 'Alerts disabled or SMTP not configured.' };
  }

  const pendingEvents = (Array.isArray(events) ? events : [])
    .filter((event) => ALERTABLE_EVENT_TYPES.has(event.type))
    .filter((event) => !hasSentEventAlert(db, trackedCase.id, buildEventFingerprint(event)));

  if (!pendingEvents.length) {
    return { sent: false, skipped: true, reason: 'No new alertable events.' };
  }

  try {
    await getTransporter().sendMail({
      from: getMailConfig().from,
      to: trackedCase.reminderEmails.join(', '),
      replyTo: getMailConfig().replyTo || undefined,
      subject: buildSubject(trackedCase, pendingEvents),
      text: buildText(trackedCase, pendingEvents, snapshotPayload),
      html: buildHtml(trackedCase, pendingEvents, snapshotPayload)
    });

    const createdAt = new Date().toISOString();
    for (const event of pendingEvents) {
      db.reminderDeliveries.push({
        id: id('reminder'),
        trackedCaseId: trackedCase.id,
        status: 'sent',
        reminderDate: createdAt.slice(0, 10),
        daysUntilHearing: null,
        email: formatReminderEmails(trackedCase.reminderEmails),
        emails: trackedCase.reminderEmails,
        kind: 'case_update',
        eventType: event.type,
        eventFingerprint: buildEventFingerprint(event),
        createdAt
      });
    }

    return { sent: true, skipped: false, count: pendingEvents.length };
  } catch (error) {
    const createdAt = new Date().toISOString();
    for (const event of pendingEvents) {
      db.reminderDeliveries.push({
        id: id('reminder'),
        trackedCaseId: trackedCase.id,
        status: 'failed',
        reminderDate: createdAt.slice(0, 10),
        daysUntilHearing: null,
        email: formatReminderEmails(trackedCase.reminderEmails),
        emails: trackedCase.reminderEmails,
        kind: 'case_update',
        eventType: event.type,
        eventFingerprint: buildEventFingerprint(event),
        error: error.message,
        createdAt
      });
    }

    return { sent: false, skipped: false, reason: error.message };
  }
}

function hasSentEventAlert(db, trackedCaseId, fingerprint) {
  return db.reminderDeliveries.some((delivery) =>
    delivery.trackedCaseId === trackedCaseId &&
    delivery.kind === 'case_update' &&
    delivery.status === 'sent' &&
    delivery.eventFingerprint === fingerprint
  );
}

function buildEventFingerprint(event) {
  return JSON.stringify({
    type: event?.type || '',
    message: event?.message || '',
    details: event?.details || {}
  });
}

function buildSubject(trackedCase, events) {
  const label = trackedCase.latestCaseNumber || trackedCase.displayLabel || 'Tracked case';
  const headline = events.length === 1 ? humanizeType(events[0].type) : `${events.length} case updates`;
  return `${headline}: ${label}`;
}

function buildText(trackedCase, events, snapshotPayload) {
  const lines = [
    `Automatic case update for ${trackedCase.latestCaseNumber || trackedCase.displayLabel || 'tracked case'}`,
    '',
    `Case title: ${trackedCase.latestCaseTitle || trackedCase.manualCaseTitle || 'Not available'}`,
    `Court: ${trackedCase.latestCourtName || 'High Court of Delhi'}`,
    `Status: ${trackedCase.latestStatus || 'Not available'}`,
    `Next hearing date: ${trackedCase.latestNextHearingDate || 'Not available'}`,
    `Date source: ${formatDateSource(trackedCase.latestNextHearingDateSource)}`,
    `Case history page: ${trackedCase.latestCaseHistoryUrl || 'Not available'}`,
    `Orders page: ${trackedCase.latestOrdersUrl || 'Not available'}`,
    `Judgments page: ${trackedCase.latestJudgmentsUrl || 'Not available'}`,
    ''
  ];

  for (const event of events) {
    lines.push(`- ${humanizeType(event.type)}: ${event.message}`);
    for (const item of summarizeItems(event.details?.items)) {
      lines.push(`  - ${item}`);
    }
  }

  if (snapshotPayload?.rawMetadata?.orderMonitor?.usedLatestOrderFallback) {
    lines.push('');
    lines.push(`Latest order suggests next hearing on ${snapshotPayload.nextHearingDate}.`);
  }

  return lines.join('\n');
}

function buildHtml(trackedCase, events, snapshotPayload) {
  const listItems = events.map((event) => {
    const detailItems = summarizeItems(event.details?.items)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join('');

    return `
      <li style="margin-bottom:12px;">
        <strong>${escapeHtml(humanizeType(event.type))}</strong>: ${escapeHtml(event.message)}
        ${detailItems ? `<ul style="margin:8px 0 0 18px;">${detailItems}</ul>` : ''}
      </li>
    `;
  }).join('');

  const orderFallback = snapshotPayload?.rawMetadata?.orderMonitor?.usedLatestOrderFallback
    ? `<p><strong>Latest order suggests next hearing on ${escapeHtml(snapshotPayload.nextHearingDate || '')}.</strong></p>`
    : '';

  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #14213d;">
      <h2 style="margin-bottom: 8px;">Automatic case update</h2>
      <p><strong>${escapeHtml(trackedCase.latestCaseNumber || trackedCase.displayLabel || 'Tracked case')}</strong></p>
      <table style="border-collapse: collapse;">
        <tr><td style="padding:4px 12px 4px 0;"><strong>Case title</strong></td><td>${escapeHtml(trackedCase.latestCaseTitle || trackedCase.manualCaseTitle || 'Not available')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Status</strong></td><td>${escapeHtml(trackedCase.latestStatus || 'Not available')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Next hearing</strong></td><td>${escapeHtml(trackedCase.latestNextHearingDate || 'Not available')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Date source</strong></td><td>${escapeHtml(formatDateSource(trackedCase.latestNextHearingDateSource))}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Case history</strong></td><td>${trackedCase.latestCaseHistoryUrl ? `<a href="${trackedCase.latestCaseHistoryUrl}">${escapeHtml(trackedCase.latestCaseHistoryUrl)}</a>` : 'Not available'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Orders</strong></td><td>${trackedCase.latestOrdersUrl ? `<a href="${trackedCase.latestOrdersUrl}">${escapeHtml(trackedCase.latestOrdersUrl)}</a>` : 'Not available'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Judgments</strong></td><td>${trackedCase.latestJudgmentsUrl ? `<a href="${trackedCase.latestJudgmentsUrl}">${escapeHtml(trackedCase.latestJudgmentsUrl)}</a>` : 'Not available'}</td></tr>
      </table>
      ${orderFallback}
      <h3 style="margin:18px 0 8px;">What changed</h3>
      <ul style="padding-left: 18px; margin: 0;">${listItems}</ul>
    </div>
  `;
}

function summarizeItems(items) {
  const list = Array.isArray(items) ? items.slice(0, 6) : [];
  return list.map((item) => {
    if (item?.pdfUrl) {
      return [item.caseNumber || item.caseTitle || 'Judgment', item.judgmentDate || item.listDate || '', item.pdfUrl]
        .filter(Boolean)
        .join(' | ');
    }

    return [
      item?.date,
      item?.details,
      item?.diaryNumber,
      item?.status,
      item?.orderUrl || item?.url
    ].filter(Boolean).join(' | ');
  });
}

function humanizeType(type) {
  switch (type) {
    case 'filing_added': return 'New filing';
    case 'listing_added': return 'New listing';
    case 'order_added': return 'New order';
    case 'latest_order_uploaded': return 'Latest order uploaded';
    case 'judgment_published': return 'New judgment';
    case 'hearing_date_changed': return 'Hearing date changed';
    default: return 'Case update';
  }
}

function formatDateSource(source) {
  if (source === 'latest_order') return 'Latest order';
  if (source === 'latest_order_pending_official_refresh') return 'Latest order (pending official refresh)';
  if (source === 'case_status_page') return 'Delhi High Court case-status page';
  return 'Not available';
}

function getTransporter() {
  if (transporter) return transporter;
  const config = getMailConfig();
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined
  });
  return transporter;
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
  sendCaseUpdateAlerts,
  shouldSendCaseUpdateAlerts
};
