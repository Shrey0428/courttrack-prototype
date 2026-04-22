const fs = require('fs');
const path = require('path');
const { formatReminderEmails, parseReminderEmails } = require('./reminderEmails');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'db.json');

const initialDb = {
  trackedCases: [],
  snapshots: [],
  events: [],
  scrapeRuns: [],
  reminderDeliveries: []
};

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDb, null, 2));
  }
}

function readDb() {
  ensureDb();
  return normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function id(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDb(db) {
  const nextDb = {
    ...initialDb,
    ...db
  };

  nextDb.trackedCases = Array.isArray(nextDb.trackedCases)
    ? nextDb.trackedCases.map((trackedCase) => ({
        reminderEmails: [],
        reminderEmail: '',
        reminderEnabled: false,
        latestOrdersUrl: '',
        latestJudgmentsUrl: '',
        ...trackedCase,
        reminderEmails: (() => {
          const parsed = parseReminderEmails(trackedCase.reminderEmails || trackedCase.reminderEmail || '');
          return parsed.emails;
        })()
      }))
    : [];

  nextDb.snapshots = Array.isArray(nextDb.snapshots) ? nextDb.snapshots : [];
  nextDb.events = Array.isArray(nextDb.events) ? nextDb.events : [];
  nextDb.scrapeRuns = Array.isArray(nextDb.scrapeRuns) ? nextDb.scrapeRuns : [];
  nextDb.reminderDeliveries = Array.isArray(nextDb.reminderDeliveries) ? nextDb.reminderDeliveries : [];

  for (const trackedCase of nextDb.trackedCases) {
    trackedCase.reminderEmail = trackedCase.reminderEmails[0] || '';
    trackedCase.reminderEmailsLabel = formatReminderEmails(trackedCase.reminderEmails);

    if (trackedCase.latestOrdersUrl && trackedCase.latestJudgmentsUrl) continue;

    const latestSnapshot = nextDb.snapshots
      .filter((snapshot) => snapshot.trackedCaseId === trackedCase.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (!latestSnapshot?.payload) continue;

    trackedCase.latestOrdersUrl = trackedCase.latestOrdersUrl || latestSnapshot.payload.ordersUrl || '';
    trackedCase.latestJudgmentsUrl = trackedCase.latestJudgmentsUrl || latestSnapshot.payload.judgmentsUrl || '';
  }

  return nextDb;
}

module.exports = { readDb, writeDb, id, DB_PATH };
