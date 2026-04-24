const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOCUMENT_CACHE_ROOT = process.env.DOCUMENT_CACHE_ROOT
  ? path.resolve(process.env.DOCUMENT_CACHE_ROOT)
  : path.join(__dirname, '..', 'data', 'document-cache');

function ensureDocumentCacheRoot() {
  fs.mkdirSync(DOCUMENT_CACHE_ROOT, { recursive: true });
}

async function cacheDocumentBuffer(caseId, sourceUrl, buffer, options = {}) {
  ensureDocumentCacheRoot();

  const safeCaseId = String(caseId || 'case').replace(/[^a-zA-Z0-9_-]/g, '_');
  const caseDir = path.join(DOCUMENT_CACHE_ROOT, safeCaseId);
  await fs.promises.mkdir(caseDir, { recursive: true });

  const extension = normalizeExtension(options.extension || inferExtension(sourceUrl, buffer, options.contentType));
  const baseName = options.baseName ? slugify(options.baseName) : 'document';
  const hash = crypto.createHash('sha1').update(String(sourceUrl || '')).digest('hex').slice(0, 12);
  const fileName = `${baseName}-${hash}${extension}`;
  const absolutePath = path.join(caseDir, fileName);

  await fs.promises.writeFile(absolutePath, buffer);

  return {
    fileName,
    absolutePath,
    localUrl: `/api/documents/${encodeURIComponent(safeCaseId)}/${encodeURIComponent(fileName)}`
  };
}

function resolveCachedDocument(caseId, fileName) {
  ensureDocumentCacheRoot();
  const safeCaseId = String(caseId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const sanitizedFileName = path.basename(String(fileName || ''));
  const absolutePath = path.join(DOCUMENT_CACHE_ROOT, safeCaseId, sanitizedFileName);
  if (!absolutePath.startsWith(path.join(DOCUMENT_CACHE_ROOT, safeCaseId))) return null;
  if (!fs.existsSync(absolutePath)) return null;
  return absolutePath;
}

function inferExtension(sourceUrl, buffer, contentType) {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('pdf') || isPdfBuffer(buffer)) return '.pdf';
  if (normalizedType.includes('html')) return '.html';
  const pathname = new URL(String(sourceUrl || 'https://example.invalid')).pathname;
  const ext = path.extname(pathname);
  return ext && ext.length <= 8 ? ext : '.bin';
}

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.slice(0, 4).toString() === '%PDF';
}

function normalizeExtension(ext) {
  const value = String(ext || '').trim();
  if (!value) return '.bin';
  return value.startsWith('.') ? value : `.${value}`;
}

function slugify(value) {
  return String(value || 'document')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'document';
}

module.exports = {
  cacheDocumentBuffer,
  resolveCachedDocument
};
