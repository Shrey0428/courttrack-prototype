require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
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
  updateCaseReminderSettings,
  updateCaseDetails,
  syncCase,
  syncCaseWithNormalizedResult,
  syncAllCases
} = require('./syncService');
const { createSession, getSession, deleteSession } = require('./sessionStore');
const {
  DEFAULT_REMINDER_EMAIL,
  REMINDER_INTERVAL_MS,
  getNextReminderRunAt,
  getReminderStatus,
  runReminderSweep,
  sendTestReminderEmail
} = require('./reminderService');
const { parseReminderEmailsFromInput } = require('./reminderEmails');
const { listDelhiDistrictSites } = require('./delhiDistrictSites');
const { resolveCachedDocument } = require('./documentCache');
const { getTodayCauseListOverview, refreshTodayCauseListOverview } = require('./causeListService');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTO_SYNC_MS = Number(process.env.AUTO_SYNC_MS || 60000);
const optionsCache = new Map();

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
    username: session?.username || ''
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

app.post('/auth/verify-password', (req, res) => {
  const session = getAuthSessionFromRequest(req);
  if (!session?.username) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const password = String(req.body?.password || '');
  if (!password) {
    return res.status(400).json({ error: 'Password is required.' });
  }

  if (!verifyCredentials(session.username, password)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

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

app.get('/api/district-courts', (_req, res) => {
  res.json({ districts: listDelhiDistrictSites() });
});

app.get('/api/high-court-lookup-options', async (_req, res) => {
  try {
    const provider = getProvider('delhiManualCaptcha');
    const payload = await getCachedLookupOptions('highCourt:lookup-options', () => provider.listLookupOptions());
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/district-lookup-options', async (req, res) => {
  try {
    const districtSlug = String(req.query?.districtSlug || '').trim();
    if (!districtSlug) {
      return res.status(400).json({ error: 'districtSlug is required.' });
    }

    const provider = getProvider('districtCourtCnr');
    const payload = await getCachedLookupOptions(`district:lookup-options:${districtSlug}`, () =>
      provider.listLookupOptions({ districtSlug })
    );
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/district-case-types', async (req, res) => {
  try {
    const districtSlug = String(req.query?.districtSlug || '').trim();
    const searchMode = String(req.query?.searchMode || 'courtComplex').trim();
    const courtComplexValue = String(req.query?.courtComplexValue || '').trim();
    const courtEstablishmentValue = String(req.query?.courtEstablishmentValue || '').trim();

    if (!districtSlug) {
      return res.status(400).json({ error: 'districtSlug is required.' });
    }

    if (searchMode === 'courtEstablishment' && !courtEstablishmentValue) {
      return res.status(400).json({ error: 'courtEstablishmentValue is required for court establishment lookups.' });
    }

    if (searchMode !== 'courtEstablishment' && !courtComplexValue) {
      return res.status(400).json({ error: 'courtComplexValue is required for court complex lookups.' });
    }

    const provider = getProvider('districtCourtCnr');
    const cacheKey = [
      'district:case-types',
      districtSlug,
      searchMode,
      courtComplexValue || '-',
      courtEstablishmentValue || '-'
    ].join(':');
    const payload = await getCachedLookupOptions(cacheKey, () =>
      provider.listCaseTypeOptions({
        districtSlug,
        searchMode,
        courtComplexValue,
        courtEstablishmentValue
      })
    );
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/cases', (_req, res) => {
  res.json(listCases());
});

app.get('/api/cause-lists/today', async (_req, res) => {
  try {
    const payload = await getTodayCauseListOverview();
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cause-lists/today/refresh', async (_req, res) => {
  try {
    const payload = await refreshTodayCauseListOverview();
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/cases/:id', (req, res) => {
  const trackedCase = getCase(req.params.id);
  if (!trackedCase) return res.status(404).json({ error: 'Case not found' });
  res.json(trackedCase);
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
    const trackedCase = updateCaseDetails(req.params.id, req.body || {});
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

app.delete('/api/cases/:id', (req, res) => {
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
    forceSend: req.body?.forceSend === true
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

app.get('/api/documents/:caseId/:fileName', (req, res) => {
  const absolutePath = resolveCachedDocument(req.params.caseId, req.params.fileName);
  if (!absolutePath) {
    return res.status(404).json({ error: 'Document not found.' });
  }
  const stat = fs.statSync(absolutePath);
  res.setHeader('Content-Length', stat.size);
  if (absolutePath.toLowerCase().endsWith('.pdf')) {
    res.type('application/pdf');
  }
  res.sendFile(absolutePath);
});

app.post('/lookup/start', async (req, res) => {
  try {
    const { provider = 'delhiManualCaptcha', trackedCaseId } = req.body;
    const providerInstance = getProvider(provider);
    if (typeof providerInstance.startLookup !== 'function') {
      return res.status(400).json({ error: 'This provider does not support the manual CAPTCHA lookup flow.' });
    }

    const parsedReminderEmails = parseReminderEmailsFromInput(withDefaultReminderInput(req.body || {}));
    if (parsedReminderEmails.invalid.length) {
      return res.status(400).json({ error: `Invalid reminder email(s): ${parsedReminderEmails.invalid.join(', ')}` });
    }

    const startArgs = provider === 'districtCourtCnr'
      ? {
          districtSlug: req.body?.districtSlug,
          searchMode: req.body?.searchMode,
          courtComplex: req.body?.courtComplex,
          courtComplexValue: req.body?.courtComplexValue,
          courtEstablishment: req.body?.courtEstablishment,
          courtEstablishmentValue: req.body?.courtEstablishmentValue,
          caseType: req.body?.caseType,
          caseNumber: req.body?.caseNumber,
          year: req.body?.year
        }
      : {
          caseType: req.body?.caseType,
          caseNumber: req.body?.caseNumber,
          year: req.body?.year
        };

    const state = await providerInstance.startLookup(startArgs);
    const session = createSession({
      provider,
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
    res.status(500).json({ error: formatLookupError(error) });
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
        const existingCase = findTrackedCase(session.provider, session.input);
        if (existingCase) {
          targetCaseId = existingCase.id;
          trackedCase = existingCase;
        } else {
          trackedCase = addCase(buildTrackedCaseInput(session.provider, session.input, session.reminderEmails));
          targetCaseId = trackedCase.id;
        }
      }

      syncResult = await syncCaseWithNormalizedResult(targetCaseId, lookupResult.caseData);
      trackedCase = syncResult.trackedCase;

      if (session.reminderEmails?.length) {
        trackedCase = updateCaseReminderSettings(targetCaseId, {
          reminderEmails: session.reminderEmails,
          reminderEnabled: true,
          reminderDaysBefore: trackedCase.reminderDaysBefore,
          reminderSkipDisposed: trackedCase.reminderSkipDisposed
        });
      }
    }

    res.json({
      caseData: lookupResult.caseData,
      trackedCase,
      syncResult
    });
  } catch (error) {
    res.status(500).json({ error: formatLookupError(error) });
  } finally {
    await deleteSession(session.id);
  }
});

app.delete('/lookup/:sessionId', async (req, res) => {
  await deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

function buildTrackedCaseInput(provider, input, reminderEmails) {
  if (provider === 'districtCourtCnr') {
    const caseLookup = formatDistrictLookup(input);
    return {
      provider,
      caseLookup,
      displayLabel: caseLookup,
      queryMeta: { ...input },
      reminderEmails
    };
  }

  const caseLookup = formatDelhiLookup(input);
  return {
    provider,
    caseLookup,
    displayLabel: caseLookup,
    queryMeta: { ...input },
    reminderEmails
  };
}

function formatDelhiLookup(input) {
  return `${input.caseType} ${input.caseNumber}/${input.year}`;
}

function formatDistrictLookup(input) {
  const venueLabel = input.searchMode === 'courtEstablishment'
    ? input.courtEstablishment
    : input.courtComplex;
  const prefix = [input.districtLabel, venueLabel].filter(Boolean).join(' | ');
  const suffix = [input.caseType, `${input.caseNumber}/${input.year}`].filter(Boolean).join(' ');
  return [prefix, suffix].filter(Boolean).join(' | ');
}

function findTrackedCase(provider, input) {
  if (provider === 'districtCourtCnr') {
    return listCases().find((trackedCase) => {
      return trackedCase.provider === 'districtCourtCnr' &&
        String(trackedCase.queryMeta?.districtSlug || '') === String(input.districtSlug || '') &&
        String(trackedCase.queryMeta?.searchMode || 'courtComplex') === String(input.searchMode || 'courtComplex') &&
        String(trackedCase.queryMeta?.courtComplexValue || trackedCase.queryMeta?.courtComplex || '') === String(input.courtComplexValue || input.courtComplex || '') &&
        String(trackedCase.queryMeta?.courtEstablishmentValue || trackedCase.queryMeta?.courtEstablishment || '') === String(input.courtEstablishmentValue || input.courtEstablishment || '') &&
        String(trackedCase.queryMeta?.caseType || '') === String(input.caseType || '') &&
        String(trackedCase.queryMeta?.caseNumber || '') === String(input.caseNumber || '') &&
        String(trackedCase.queryMeta?.year || '') === String(input.year || '');
    }) || null;
  }

  const formattedLookup = formatDelhiLookup(input);
  return listCases().find((trackedCase) => {
    return trackedCase.provider === provider &&
      (
        (
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
  const message = String(error?.message || 'Request failed.');
  if (message.includes('page.waitForResponse')) {
    return 'The official court site did not return the expected response in time. Please load a fresh CAPTCHA and try again.';
  }
  return message;
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

scheduleReminderSweep();

app.listen(PORT, () => {
  console.log(`CourtTrack Prototype running on http://localhost:${PORT}`);
  console.log(`Auto sync interval: ${AUTO_SYNC_MS} ms`);
  console.log(`Reminder interval: ${REMINDER_INTERVAL_MS} ms`);
});

function withDefaultReminderInput(input) {
  const reminderEmail = typeof input?.reminderEmail === 'string' ? input.reminderEmail.trim() : '';
  const reminderEmails = Array.isArray(input?.reminderEmails)
    ? input.reminderEmails.filter((value) => String(value || '').trim())
    : (typeof input?.reminderEmails === 'string' ? input.reminderEmails.trim() : '');

  if (reminderEmail || (Array.isArray(reminderEmails) ? reminderEmails.length : reminderEmails)) {
    return input;
  }

  return {
    ...input,
    reminderEmails: DEFAULT_REMINDER_EMAIL
  };
}

async function getCachedLookupOptions(cacheKey, producer, ttlMs = 6 * 60 * 60 * 1000) {
  const now = Date.now();
  const cached = optionsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const data = await producer();
  optionsCache.set(cacheKey, {
    data,
    expiresAt: now + ttlMs
  });
  return data;
}

function scheduleReminderSweep() {
  const nextRunAt = getNextReminderRunAt();
  const delay = Math.max(1000, nextRunAt.getTime() - Date.now());

  console.log(`[reminders] next scheduled sweep at ${nextRunAt.toISOString()}`);

  const timer = setTimeout(async () => {
    try {
      const result = await runReminderSweep();
      if (!result.skipped) {
        console.log(`[reminders] checked ${result.results.length} case(s) at ${new Date().toISOString()}`);
      }
    } catch (error) {
      console.error('[reminders] failed', error.message);
    } finally {
      scheduleReminderSweep();
    }
  }, delay);

  timer.unref();
}
