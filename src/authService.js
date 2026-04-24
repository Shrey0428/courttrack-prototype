const crypto = require('crypto');
const { readDb } = require('./db');

const SESSION_COOKIE_NAME = 'courttrack_session';
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const sessions = new Map();
const PASSWORD_HASH_ITERATIONS = 210000;
const PASSWORD_HASH_KEYLEN = 32;
const PASSWORD_HASH_DIGEST = 'sha256';

function getAuthConfig() {
  return {
    username: String(process.env.APP_LOGIN_USERNAME || 'admin').trim(),
    password: String(process.env.APP_LOGIN_PASSWORD || 'courttrack123').trim(),
    users: getConfiguredUsers()
  };
}

function verifyCredentials(username, password) {
  const normalizedUsername = String(username || '').trim();
  const user = getConfiguredUsers().find((candidate) => candidate.username === normalizedUsername && candidate.disabled !== true);
  if (!user) return false;

  if (user.passwordHash) {
    return verifyPasswordHash(password, user.passwordHash);
  }

  return timingSafeEqualString(String(password || ''), String(user.password || ''));
}

function createAuthSession(username) {
  cleanupExpiredSessions();
  const user = getConfiguredUsers().find((candidate) => candidate.username === username) || { username };
  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    id: token,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || 'user',
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

function getConfiguredUsers() {
  const envUsers = parseUsersJson(process.env.APP_USERS_JSON || process.env.AUTH_USERS_JSON || '');
  if (envUsers.length) return envUsers;

  const dbUsers = readDb().users
    .filter((user) => user && user.username && (user.passwordHash || user.password))
    .map(normalizeUserConfig);
  if (dbUsers.length) return dbUsers;

  return [normalizeUserConfig({
    username: process.env.APP_LOGIN_USERNAME || 'admin',
    password: process.env.APP_LOGIN_PASSWORD || 'courttrack123',
    role: 'admin'
  })];
}

function parseUsersJson(value) {
  if (!String(value || '').trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return (Array.isArray(parsed) ? parsed : [])
      .filter((user) => user && user.username && (user.passwordHash || user.password))
      .map(normalizeUserConfig);
  } catch (error) {
    console.error('[auth] APP_USERS_JSON could not be parsed:', error.message);
    return [];
  }
}

function normalizeUserConfig(user) {
  return {
    username: String(user.username || '').trim(),
    displayName: String(user.displayName || user.name || user.username || '').trim(),
    role: String(user.role || 'user').trim(),
    passwordHash: String(user.passwordHash || '').trim(),
    password: String(user.password || '').trim(),
    disabled: user.disabled === true
  };
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, PASSWORD_HASH_ITERATIONS, PASSWORD_HASH_KEYLEN, PASSWORD_HASH_DIGEST).toString('base64url');
  return `pbkdf2$${PASSWORD_HASH_DIGEST}$${PASSWORD_HASH_ITERATIONS}$${salt}$${hash}`;
}

function verifyPasswordHash(password, encodedHash) {
  const parts = String(encodedHash || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterationsText, salt, expectedHash] = parts;
  const iterations = Number(iterationsText);
  if (!digest || !iterations || !salt || !expectedHash) return false;

  const actual = crypto.pbkdf2Sync(String(password || ''), salt, iterations, Buffer.from(expectedHash, 'base64url').length, digest).toString('base64url');
  return timingSafeEqualString(actual, expectedHash);
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  SESSION_COOKIE_NAME,
  clearAuthCookie,
  createPasswordHash,
  createAuthSession,
  deleteAuthSession,
  getAuthConfig,
  getAuthSessionFromRequest,
  getSessionTokenFromRequest,
  isAuthenticatedRequest,
  setAuthCookie,
  verifyCredentials
};
