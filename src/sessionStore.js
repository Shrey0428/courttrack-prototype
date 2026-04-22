const { id } = require('./db');

const sessions = new Map();
const TTL_MS = Number(process.env.CAPTCHA_SESSION_TTL_MS || 10 * 60 * 1000);

function createSession(data) {
  const sessionId = id('captcha');
  const record = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...data
  };
  sessions.set(sessionId, record);
  return record;
}

function getSession(sessionId) {
  cleanupExpired();
  return sessions.get(sessionId) || null;
}

function updateSession(sessionId, patch) {
  const current = getSession(sessionId);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  sessions.set(sessionId, next);
  return next;
}

async function deleteSession(sessionId) {
  const current = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (current?.cleanup) {
    try {
      await current.cleanup();
    } catch (_error) {
      // ignore cleanup failures in prototype
    }
  }
}

function cleanupExpired() {
  const now = Date.now();
  for (const [sessionId, record] of sessions.entries()) {
    const age = now - new Date(record.updatedAt || record.createdAt).getTime();
    if (age > TTL_MS) {
      deleteSession(sessionId).catch(() => {});
    }
  }
}

setInterval(() => {
  cleanupExpired();
}, 60 * 1000).unref();

module.exports = { createSession, getSession, updateSession, deleteSession };
