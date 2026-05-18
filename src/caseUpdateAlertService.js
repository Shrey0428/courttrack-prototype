const nodemailer = require('nodemailer');
const { id } = require('./db');
const { formatReminderEmails } = require('./reminderEmails');

let transporter;

const ALERTABLE_EVENT_TYPES = new Set([
  'listing_added',
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

  const baselineDate = getBaselineDate(trackedCase);
  const pendingEvents = (Array.isArray(events) ? events : [])
    .filter((event) => ALERTABLE_EVENT_TYPES.has(event.type))
    .filter((event) => isEventAfterBaseline(event, baselineDate, snapshotPayload))
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

function isEventAfterBaseline(event, baselineDate, snapshotPayload) {
  if (!baselineDate) return true;

  if (event.type === 'filing_added' || event.type === 'listing_added' || event.type === 'order_added' || event.type === 'judgment_published') {
    return (event.details?.items || []).some((item) => {
      const value = item?.date || item?.judgmentDate || item?.listDate || '';
      return compareDates(value, baselineDate) > 0;
    });
  }

  if (event.type === 'latest_order_uploaded') {
    return compareDates(snapshotPayload?.latestOrderDate || '', baselineDate) > 0;
  }

  if (event.type === 'hearing_date_changed') {
    return compareDates(snapshotPayload?.latestOrderDate || '', baselineDate) > 0;
  }

  return true;
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
    const detailItems = renderEventItemsHtml(event.details?.items)
      .map((item) => `<li style="margin-bottom:10px;">${item}</li>`)
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
        <tr><td style="padding:4px 12px 4px 0;"><strong>Case history</strong></td><td>${trackedCase.latestCaseHistoryUrl ? renderEmailButton(trackedCase.latestCaseHistoryUrl, 'Open case history') : 'Not available'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Orders</strong></td><td>${trackedCase.latestOrdersUrl ? renderEmailButton(trackedCase.latestOrdersUrl, 'Open orders') : 'Not available'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><strong>Judgments</strong></td><td>${trackedCase.latestJudgmentsUrl ? renderEmailButton(trackedCase.latestJudgmentsUrl, 'Open judgments') : 'Not available'}</td></tr>
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

function renderEventItemsHtml(items) {
  const list = Array.isArray(items) ? items.slice(0, 6) : [];
  return list.map((item) => {
    const summary = [
      item?.caseNumber || item?.caseTitle,
      item?.judgmentDate || item?.listDate || item?.date,
      item?.details,
      item?.diaryNumber,
      item?.status
    ].filter(Boolean).join(' | ');

    const actionUrl = item?.pdfUrl || item?.orderUrl || item?.url || '';
    const actionLabel = item?.pdfUrl
      ? 'Open PDF'
      : (item?.orderUrl || item?.url ? 'Open document' : '');

    return `
      <div>${escapeHtml(summary || 'New activity detected')}</div>
      ${actionUrl ? `<div style="margin-top:6px;">${renderEmailButton(actionUrl, actionLabel)}</div>` : ''}
    `;
  });
}

function getBaselineDate(trackedCase) {
  return normalizeDate(trackedCase?.activityAlertBaselineDate || '');
}

function compareDates(left, right) {
  return toSortableDate(left) - toSortableDate(right);
}

function toSortableDate(value) {
  const normalized = normalizeDate(value);
  if (!normalized) return 0;
  const [day, month, year] = normalized.split('-').map(Number);
  return new Date(year, month - 1, day).getTime();
}

function normalizeDate(value) {
  const input = String(value || '').trim();
  const direct = input.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (direct) {
    return `${String(direct[1]).padStart(2, '0')}-${String(direct[2]).padStart(2, '0')}-${direct[3]}`;
  }

  const named = input.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (named) {
    const month = monthNumber(named[2]);
    if (month) {
      return `${String(named[1]).padStart(2, '0')}-${month}-${named[3]}`;
    }
  }

  return '';
}

function monthNumber(name) {
  const lookup = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12'
  };
  return lookup[String(name || '').trim().toLowerCase().slice(0, 3)] || '';
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
  if (source === 'latest_listing_pending_official_refresh') return 'Latest listing row (pending official refresh)';
  if (source === 'manual_override') return 'Manual override';
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

function renderEmailButton(url, label) {
  if (!url) return '';
  return `<a href="${url}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#2a427f;color:#ffffff !important;text-decoration:none;font-weight:700;">${escapeHtml(label)}</a>`;
}

module.exports = {
  sendCaseUpdateAlerts,
  shouldSendCaseUpdateAlerts
};
