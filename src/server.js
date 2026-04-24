require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const {
  clearAuthCookie,
  createAuthSession,
  deleteAuthSession,
  getAuthSessionFromRequest,
  getSessionTokenFromRequest,
  isAuthenticatedRequest,
  setAuthCookie,
  verifyCredentials
} = require('./authService');
const {
  listProviders,
  getProvider,
  listCases,
  getCase,
  addCase,
  deleteCase,
  updateCaseMetadata,
  updateCaseReminderSettings,
  syncCase,
  syncCaseWithNormalizedResult,
  syncAllCases
} = require('./syncService');
const { createSession, getSession, deleteSession } = require('./sessionStore');
const { REMINDER_INTERVAL_MS, getReminderStatus, runReminderSweep, sendTestReminderEmail } = require('./reminderService');
const { parseReminderEmailsFromInput } = require('./reminderEmails');
const { cacheDocumentBuffer, resolveCachedDocument } = require('./documentCache');
const { listDelhiDistrictSites } = require('./delhiDistrictSites');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTO_SYNC_MS = Number(process.env.AUTO_SYNC_MS || 60000);
const DELETE_CASE_PASSWORD = '5858';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/login', (req, res) => {
  const next = req.query.next ? `?next=${encodeURIComponent(String(req.query.next))}` : '';
  res.redirect(`/login.html${next}`);
});

app.get('/auth/status', (req, res) => {
  const session = getAuthSessionFromRequest(req);
  res.json({
    authenticated: Boolean(session),
    username: session?.username || '',
    displayName: session?.displayName || '',
    role: session?.role || ''
  });
});

app.post('/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!verifyCredentials(username, password)) {
    clearAuthCookie(res);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const session = createAuthSession(username);
  setAuthCookie(res, session.id);
  res.json({ ok: true, username: session.username });
});

app.post('/auth/logout', (req, res) => {
  deleteAuthSession(getSessionTokenFromRequest(req));
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (
    req.path === '/login' ||
    req.path === '/login.html' ||
    req.path.startsWith('/auth/') ||
    req.path === '/favicon.ico'
  ) {
    return next();
  }

  if (isAuthenticatedRequest(req)) {
    return next();
  }

  if (req.path.startsWith('/api/') || req.path.startsWith('/lookup/')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login.html?next=${nextUrl}`);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'CourtTrack Prototype' });
});

app.get('/api/providers', (_req, res) => {
  res.json({ providers: listProviders() });
});

app.get('/api/lookup-options/delhi-case-types', async (_req, res) => {
  try {
    const provider = getProvider('delhiManualCaptcha');
    const caseTypes = await provider.listCaseTypes();
    res.json({ caseTypes });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not load Delhi case types.' });
  }
});

app.get('/api/lookup-options/district-case-types', async (req, res) => {
  try {
    const provider = getProvider('districtCourtCnr');
    const caseTypes = await provider.listCaseTypes({
      districtSlug: String(req.query.districtSlug || '').trim(),
      courtComplex: String(req.query.courtComplex || '').trim()
    });
    res.json({ caseTypes });
  } catch (error) {
    logLookupDebug('district-case-types', error);
    res.status(500).json({ error: formatLookupError(error), debug: extractLookupDebug(error) });
  }
});

app.get('/api/district-courts', (_req, res) => {
  res.json({ districts: listDelhiDistrictSites() });
});

app.get('/api/cases', (_req, res) => {
  res.json(listCases());
});

app.get('/api/cases/:id', (req, res) => {
  const trackedCase = getCase(req.params.id);
  if (!trackedCase) return res.status(404).json({ error: 'Case not found' });
  res.json(trackedCase);
});

app.get('/api/documents/:caseId/:fileName', (req, res) => {
  const absolutePath = resolveCachedDocument(req.params.caseId, req.params.fileName);
  if (!absolutePath) {
    return res.status(404).json({ error: 'Document not found' });
  }
  res.sendFile(absolutePath);
});

app.post('/api/cases', (req, res) => {
  try {
    const { provider, cnrNumber, caseLookup, displayLabel, queryMeta, reminderEmail, reminderEmails } = req.body;
    if (!cnrNumber && !caseLookup) {
      return res.status(400).json({ error: 'Provide cnrNumber or caseLookup' });
    }
    const trackedCase = addCase({ provider: provider || 'mockHighCourt', cnrNumber, caseLookup, displayLabel, queryMeta, reminderEmail, reminderEmails });
    res.status(201).json(trackedCase);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/cases/:id', (req, res) => {
  try {
    const trackedCase = updateCaseMetadata(req.params.id, req.body || {});
    res.json(trackedCase);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/cases/:id/reminders', (req, res) => {
  try {
    const trackedCase = updateCaseReminderSettings(req.params.id, req.body || {});
    res.json({ trackedCase, reminderStatus: getReminderStatus() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/cases/:id/district-order', async (req, res) => {
  try {
    const trackedCase = getCase(req.params.id);
    if (!trackedCase) {
      return res.status(404).json({ error: 'Case not found' });
    }
    if (trackedCase.provider !== 'districtCourtCnr') {
      return res.status(400).json({ error: 'This order route is only available for district court cases.' });
    }

    const actionPayload = String(req.query.action || '').trim();
    if (!actionPayload) {
      return res.status(400).json({ error: 'Order action is required.' });
    }

    let action;
    try {
      action = JSON.parse(actionPayload);
    } catch (_error) {
      return res.status(400).json({ error: 'Order action could not be parsed.' });
    }

    const provider = getProvider('districtCourtCnr');
    const access = trackedCase.snapshots?.[0]?.payload?.rawMetadata?.ecourtsAccess || null;
    if (!access?.appToken || !Array.isArray(access.cookies) || !access.cookies.length) {
      return res.status(409).json({ error: 'Refresh this district case via CAPTCHA once, then try opening the order again.' });
    }
    const download = await provider.downloadOrderAction(action, access);
    if (!download?.buffer?.length) {
      return res.status(404).json({ error: 'The order could not be fetched from eCourts.' });
    }

    const cached = await cacheDocumentBuffer(trackedCase.id, download.orderUrl || JSON.stringify(action), download.buffer, {
      contentType: download.contentType,
      baseName: `${trackedCase.latestCaseNumber || trackedCase.cnrNumber || trackedCase.displayLabel || 'district-court'} order`
    }).catch(() => null);

    if (cached?.absolutePath) {
      return res.sendFile(cached.absolutePath, {
        headers: { 'Content-Type': download.contentType || 'application/pdf' }
      });
    }

    res.setHeader('Content-Type', download.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.send(download.buffer);
  } catch (error) {
    res.status(500).json({ error: error.message || 'The district court order could not be opened.' });
  }
});

app.delete('/api/cases/:id', (req, res) => {
  const deletePassword = String(req.body?.deletePassword || '').trim();
  if (deletePassword !== DELETE_CASE_PASSWORD) {
    return res.status(403).json({ error: 'Incorrect delete password.' });
  }
  deleteCase(req.params.id);
  res.json({ ok: true });
});

app.post('/api/cases/:id/refresh', async (req, res) => {
  try {
    const result = await syncCase(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync-all', async (_req, res) => {
  const results = await syncAllCases();
  res.json(results);
});

app.get('/api/reminders/status', (_req, res) => {
  res.json(getReminderStatus());
});

app.post('/api/reminders/run', async (req, res) => {
  const result = await runReminderSweep({
    caseId: req.body?.caseId,
    forceSend: req.body?.forceSend
  });
  res.json(result);
});

app.post('/api/cases/:id/reminders/test', async (req, res) => {
  try {
    const trackedCase = getCase(req.params.id);
    if (!trackedCase) {
      return res.status(404).json({ error: 'Case not found' });
    }
    const result = await sendTestReminderEmail(trackedCase);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/lookup/start', async (req, res) => {
  try {
    const { provider = 'delhiManualCaptcha', caseType, caseNumber, year, cnrNumber, districtSlug, courtComplex, trackedCaseId } = req.body;
    const providerInstance = getProvider(provider);
    if (typeof providerInstance.startLookup !== 'function') {
      return res.status(400).json({ error: 'This provider does not support the manual CAPTCHA lookup flow.' });
    }

    const parsedReminderEmails = parseReminderEmailsFromInput(req.body || {});
    if (parsedReminderEmails.invalid.length) {
      return res.status(400).json({ error: `Invalid reminder email(s): ${parsedReminderEmails.invalid.join(', ')}` });
    }

    const state = await providerInstance.startLookup({ caseType, caseNumber, year, cnrNumber, districtSlug, courtComplex });
    const session = createSession({
      provider,
      caseType: state.input.caseType || caseType || '',
      caseNumber: state.input.caseNumber || caseNumber || '',
      year: state.input.year || year || '',
      cnrNumber: state.input.cnrNumber || cnrNumber || '',
      districtSlug: state.input.districtSlug || districtSlug || '',
      districtLabel: state.input.districtLabel || '',
      courtComplex: state.input.courtComplex || courtComplex || '',
      trackedCaseId: trackedCaseId || '',
      reminderEmails: parsedReminderEmails.emails,
      browser: state.browser,
      context: state.context,
      page: state.page,
      input: state.input,
      cleanup: async () => {
        await state.context?.close().catch(() => {});
        await state.browser?.close().catch(() => {});
      }
    });

    res.json({
      sessionId: session.id,
      captchaImageBase64: state.preview.captchaImageBase64,
      instructions: state.preview.instructions,
      sourceUrl: state.preview.sourceUrl
    });
  } catch (error) {
    logLookupDebug('lookup/start', error);
    res.status(500).json({ error: formatLookupError(error), debug: extractLookupDebug(error) });
  }
});

app.post('/lookup/complete', async (req, res) => {
  const { sessionId, captchaText } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'CAPTCHA session expired. Please start again.' });
  }

  try {
    const provider = getProvider(session.provider);
    const lookupResult = await provider.completeLookup(session, captchaText || '');

    if (lookupResult.status === 'invalidCaptcha') {
      return res.status(422).json(lookupResult.debug);
    }

    let trackedCase = null;
    let syncResult = null;

    if (lookupResult.caseData.caseFound) {
      let targetCaseId = session.trackedCaseId;
      if (!targetCaseId) {
        const existingCase = findTrackedManualCase(session.provider, session.input);
        if (existingCase) {
          targetCaseId = existingCase.id;
          trackedCase = existingCase;
        } else {
          const caseLookup = formatManualLookup(session.input);
          trackedCase = addCase({
            provider: session.provider,
            caseLookup,
            cnrNumber: session.input.cnrNumber || '',
            displayLabel: caseLookup,
            queryMeta: { ...session.input },
            reminderEmails: session.reminderEmails
          });
          targetCaseId = trackedCase.id;
        }
      }

      if (typeof provider.cacheLookupDocuments === 'function') {
        try {
          lookupResult.caseData = await provider.cacheLookupDocuments(session, lookupResult.caseData, { trackedCaseId: targetCaseId });
        } catch (error) {
          console.warn(`[lookup/complete] document caching skipped for ${targetCaseId}: ${error.message}`);
        }
      }

      syncResult = await syncCaseWithNormalizedResult(targetCaseId, lookupResult.caseData);
      trackedCase = syncResult.trackedCase;

      if (session.reminderEmails?.length) {
        trackedCase = updateCaseReminderSettings(targetCaseId, {
          reminderEmails: session.reminderEmails,
          reminderEnabled: true
        });
      }
    }

    res.json({
      caseData: lookupResult.caseData,
      trackedCase,
      syncResult
    });
  } catch (error) {
    logLookupDebug('lookup/complete', error);
    res.status(500).json({ error: formatLookupError(error), debug: extractLookupDebug(error) });
  } finally {
    await deleteSession(session.id);
  }
});

app.delete('/lookup/:sessionId', async (req, res) => {
  await deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

function formatManualLookup(input) {
  if (input.cnrNumber) return input.cnrNumber;
  if (input.districtSlug || input.courtComplex || input.courtEstablishment || input.districtLabel) {
    const prefix = [input.districtLabel || input.districtSlug || '', input.courtComplex || input.courtEstablishment || '']
      .filter(Boolean)
      .join(' | ');
    const caseRef = `${input.caseType ? `${input.caseType} ` : ''}${input.caseNumber}/${input.year}`.trim();
    return [prefix, caseRef].filter(Boolean).join(' | ');
  }
  return `${input.caseType} ${input.caseNumber}/${input.year}`;
}

function findTrackedManualCase(provider, input) {
  if (provider === 'districtCourtCnr') {
    const cnrNumber = String(input.cnrNumber || '').trim();
    if (cnrNumber) {
      return listCases().find((trackedCase) => {
        return trackedCase.provider === provider && (
          trackedCase.cnrNumber === cnrNumber ||
          trackedCase.caseLookup === cnrNumber ||
          trackedCase.displayLabel === cnrNumber ||
          trackedCase.queryMeta?.cnrNumber === cnrNumber
        );
      }) || null;
    }

    const formattedLookup = formatManualLookup(input);
    return listCases().find((trackedCase) => {
      return trackedCase.provider === provider && (
        (
          String(trackedCase.queryMeta?.districtSlug || '') === String(input.districtSlug || '') &&
          String(trackedCase.queryMeta?.courtComplex || trackedCase.queryMeta?.courtEstablishment || '') === String(input.courtComplex || input.courtEstablishment || '') &&
          String(trackedCase.queryMeta?.caseNumber || '') === String(input.caseNumber || '') &&
          String(trackedCase.queryMeta?.year || '') === String(input.year || '') &&
          String(trackedCase.queryMeta?.caseType || '') === String(input.caseType || '')
        ) ||
        trackedCase.caseLookup === formattedLookup ||
        trackedCase.displayLabel === formattedLookup
      );
    }) || null;
  }

  const formattedLookup = formatManualLookup(input);
  const hasStructuredCaseLookup = Boolean(input.caseType || input.caseNumber || input.year);
  return listCases().find((trackedCase) => {
    return trackedCase.provider === provider &&
      (
        (
          hasStructuredCaseLookup &&
          String(trackedCase.queryMeta?.caseType || '') === String(input.caseType || '') &&
          String(trackedCase.queryMeta?.caseNumber || '') === String(input.caseNumber || '') &&
          String(trackedCase.queryMeta?.year || '') === String(input.year || '')
        ) ||
        trackedCase.caseLookup === formattedLookup ||
        trackedCase.displayLabel === formattedLookup
      );
  }) || null;
}

function formatLookupError(error) {
  const message = String(error?.message || error || 'Lookup failed.');
  if (error?.districtDebug?.events?.length) {
    const lastEvent = error.districtDebug.events[error.districtDebug.events.length - 1];
    if (lastEvent?.stage && /district:/i.test(message)) {
      return `${message}. Last stage: ${lastEvent.stage}`;
    }
  }
  if (/page\.waitForResponse: Timeout/i.test(message) || /waiting for event "response"/i.test(message)) {
    return 'The official court site did not return the expected response in time. Please load a fresh CAPTCHA and try again.';
  }
  if (/Timeout .* exceeded/i.test(message) && /captcha|response|locator|wait/i.test(message)) {
    return 'The official court site took too long to respond. Please load a fresh CAPTCHA and try again.';
  }
  return message;
}

function extractLookupDebug(error) {
  if (error?.districtDebug) {
    return { districtDebug: error.districtDebug };
  }
  return undefined;
}

function logLookupDebug(scope, error) {
  if (error?.districtDebug) {
    console.error(`[${scope}] district debug`, JSON.stringify(error.districtDebug, null, 2));
    return;
  }
  console.error(`[${scope}]`, String(error?.message || error || 'Lookup failed'));
}

setInterval(async () => {
  if (listCases().length === 0) return;
  try {
    await syncAllCases();
    console.log(`[auto-sync] completed at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('[auto-sync] failed', error.message);
  }
}, AUTO_SYNC_MS).unref();

setInterval(async () => {
  try {
    const result = await runReminderSweep();
    if (!result.skipped) {
      console.log(`[reminders] checked ${result.results.length} case(s) at ${new Date().toISOString()}`);
    }
  } catch (error) {
    console.error('[reminders] failed', error.message);
  }
}, REMINDER_INTERVAL_MS).unref();

app.listen(PORT, () => {
  console.log(`CourtTrack Prototype running on http://localhost:${PORT}`);
  console.log(`Auto sync interval: ${AUTO_SYNC_MS} ms`);
  console.log(`Reminder interval: ${REMINDER_INTERVAL_MS} ms`);
});
