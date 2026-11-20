'use strict';

const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB，足够长的对话

function sendJson(res, status, payload, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(JSON.stringify(payload));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 解析请求体：Vercel 已解析 JSON 时直接用，否则手动读取。 */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const raw = await readRawBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 从 Authorization: Bearer xxx 取出 token 并与 SHARE_TOKEN 比对（timing safe）。 */
function isAuthorized(req) {
  const expected = process.env.SHARE_TOKEN;
  if (!expected) return { ok: false, reason: 'SHARE_TOKEN_NOT_CONFIGURED' };
  const header = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return { ok: false, reason: 'MISSING_TOKEN' };
  return { ok: safeEqual(m[1].trim(), expected), reason: 'INVALID_TOKEN' };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function getShareId(req) {
  const id = req.query && (req.query.id || (Array.isArray(req.query.id) ? req.query.id[0] : undefined));
  const candidate = Array.isArray(id) ? id[0] : id;
  if (!candidate || !UUID_RE.test(candidate)) return null;
  return candidate.toLowerCase();
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${proto}://${host}`;
}

function handleKvUnavailable(res, err) {
  if (err && (err.code === 'KV_NOT_CONFIGURED' || /KV storage is not configured/.test(err.message || ''))) {
    sendJson(res, 503, { error: 'STORAGE_NOT_CONFIGURED', message: 'Vercel KV 尚未创建或未与项目关联，请先在 Vercel Storage 中创建 KV 数据库并连接到本项目。' });
    return true;
  }
  return false;
}

// ---------- 投票存储（每轮分别计票） ----------
// KV 文档 votes:<id> 的结构：
//   { a, b, tie, bad,            // 全场总票数（兼容旧版平铺字段）
//     turns: { "<轮次>": { a, b, tie, bad } } }  // 每轮明细（旧数据没有该字段）
const EMPTY_TALLIES = Object.freeze({ a: 0, b: 0, tie: 0, bad: 0, total: 0 });

function normalizeTally(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const a = Number(o.a) || 0;
  const b = Number(o.b) || 0;
  const tie = Number(o.tie) || 0;
  const bad = Number(o.bad) || 0;
  return { a, b, tie, bad, total: a + b + tie + bad };
}

function parseVotesDoc(raw) {
  let doc = {};
  if (raw) {
    try { doc = JSON.parse(raw); } catch { doc = {}; }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  const overall = normalizeTally(doc);
  const turns = {};
  if (doc.turns && typeof doc.turns === 'object' && !Array.isArray(doc.turns)) {
    for (const key of Object.keys(doc.turns)) {
      if (/^\d+$/.test(key)) turns[key] = normalizeTally(doc.turns[key]);
    }
  }
  return { overall, turns };
}

function serializeVotesDoc(overall, turns) {
  const turnsOut = {};
  for (const key of Object.keys(turns)) {
    const t = normalizeTally(turns[key]);
    turnsOut[key] = { a: t.a, b: t.b, tie: t.tie, bad: t.bad };
  }
  return JSON.stringify({
    a: overall.a,
    b: overall.b,
    tie: overall.tie,
    bad: overall.bad,
    turns: turnsOut,
  });
}

function bumpTally(t, choice) {
  const next = { ...t };
  next[choice] = (Number(next[choice]) || 0) + 1;
  next.total = next.a + next.b + next.tie + next.bad;
  return next;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

module.exports = {
  sendJson,
  readJsonBody,
  isAuthorized,
  parseCookies,
  getShareId,
  baseUrl,
  handleKvUnavailable,
  setCors,
  UUID_RE,
  EMPTY_TALLIES,
  normalizeTally,
  parseVotesDoc,
  serializeVotesDoc,
  bumpTally,
};
