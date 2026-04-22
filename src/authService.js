const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'courttrack_session';
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const sessions = new Map();

function getAuthConfig() {
  return {
    username: String(process.env.APP_LOGIN_USERNAME || 'admin').trim(),
    password: String(process.env.APP_LOGIN_PASSWORD || 'courttrack123').trim()
  };
}

function verifyCredentials(username, password) {
  const config = getAuthConfig();
  return username === config.username && password === config.password;
}

function createAuthSession(username) {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    id: token,
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  sessions.set(token, session);
  return session;
}

function getAuthSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function deleteAuthSession(token) {
  if (!token) return;
  sessions.delete(token);
}

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, pair) => {
      const index = pair.indexOf('=');
      if (index === -1) return cookies;
      const key = decodeURIComponent(pair.slice(0, index).trim());
      const value = decodeURIComponent(pair.slice(index + 1).trim());
      cookies[key] = value;
      return cookies;
    }, {});
}

function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || '';
}

function getAuthSessionFromRequest(req) {
  return getAuthSession(getSessionTokenFromRequest(req));
}

function isAuthenticatedRequest(req) {
  return Boolean(getAuthSessionFromRequest(req));
}

function setAuthCookie(res, sessionId) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];

  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    parts.push('Secure');
  }

  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

module.exports = {
  SESSION_COOKIE_NAME,
  clearAuthCookie,
  createAuthSession,
  deleteAuthSession,
  getAuthConfig,
  getAuthSessionFromRequest,
  getSessionTokenFromRequest,
  isAuthenticatedRequest,
  setAuthCookie,
  verifyCredentials
};
