'use strict';

const crypto = require('crypto');
const { kv } = require('./_kv');
const { sendJson, readJsonBody, isAuthorized, baseUrl, handleKvUnavailable, setCors } = require('./_kit');

const MAX_TURNS = 50;
const MAX_FIELD = 200_000; // 单字段字符上限
const MAX_TITLE = 200;

function sanitizeSharePayload(body) {
  if (!body || typeof body !== 'object') return { error: 'INVALID_BODY' };
  const { turns, models, title, source_url } = body;

  if (!Array.isArray(turns) || turns.length === 0) {
    return { error: 'TURNS_REQUIRED', message: 'turns 必须是非空数组' };
  }
  if (turns.length > MAX_TURNS) {
    return { error: 'TOO_MANY_TURNS', message: `turns 最多 ${MAX_TURNS} 轮` };
  }

  const cleanTurns = [];
  for (const [i, turn] of turns.entries()) {
    if (!turn || typeof turn !== 'object') return { error: 'INVALID_TURN', message: `第 ${i + 1} 轮格式错误` };
    const prompt = typeof turn.prompt === 'string' ? turn.prompt : '';
    const responses = turn.responses && typeof turn.responses === 'object' ? turn.responses : {};
    const a = typeof responses.a === 'string' ? responses.a : '';
    const b = typeof responses.b === 'string' ? responses.b : '';
    if (!prompt.trim() && !a.trim() && !b.trim()) {
      return { error: 'EMPTY_TURN', message: `第 ${i + 1} 轮没有内容` };
    }
    if (prompt.length > MAX_FIELD || a.length > MAX_FIELD || b.length > MAX_FIELD) {
      return { error: 'FIELD_TOO_LARGE', message: `第 ${i + 1} 轮内容超出长度限制` };
    }
    cleanTurns.push({ prompt, responses: { a, b } });
  }

  let cleanModels = null;
  if (models && typeof models === 'object') {
    const ma = typeof models.a === 'string' ? models.a.slice(0, MAX_TITLE) : '';
    const mb = typeof models.b === 'string' ? models.b.slice(0, MAX_TITLE) : '';
    if (ma.trim() || mb.trim()) cleanModels = { a: ma.trim(), b: mb.trim() };
  }

  const firstPrompt = (cleanTurns[0].prompt || cleanTurns[0].responses.a || '').replace(/\s+/g, ' ').trim();
  const cleanTitle = (typeof title === 'string' && title.trim()
    ? title.trim()
    : firstPrompt
  ).slice(0, MAX_TITLE) || '未命名对话';

  const cleanSourceUrl = typeof source_url === 'string' && /^https?:\/\//i.test(source_url)
    ? source_url.slice(0, 2048)
    : null;

  return { value: { turns: cleanTurns, models: cleanModels, title: cleanTitle, source_url: cleanSourceUrl } };
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const auth = isAuthorized(req);
  if (!auth.ok) {
    if (auth.reason === 'SHARE_TOKEN_NOT_CONFIGURED') {
      sendJson(res, 500, { error: 'SHARE_TOKEN_NOT_CONFIGURED', message: '服务器未配置 SHARE_TOKEN。' });
      return;
    }
    sendJson(res, 401, { error: 'UNAUTHORIZED', message: '创建分享链接需要有效的 SHARE_TOKEN（Authorization: Bearer <token>）。' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err && err.message === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE', message: '内容超过 2 MB 限制。' });
      return;
    }
    throw err;
  }
  if (body === null) {
    sendJson(res, 400, { error: 'INVALID_JSON', message: '请求体不是合法的 JSON。' });
    return;
  }

  const { value, error, message } = sanitizeSharePayload(body);
  if (error) {
    sendJson(res, 400, { error, message });
    return;
  }

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const share = { id, created_at, ...value };

  try {
    await kv(['SET', `share:${id}`, JSON.stringify(share)]);
    // 维护一个有序索引（最新在前），供管理接口使用；失败不影响主流程
    try {
      const rawIndex = await kv(['GET', 'shares:index']);
      let index = [];
      if (rawIndex) {
        try { index = JSON.parse(rawIndex); } catch { index = []; }
        if (!Array.isArray(index)) index = [];
      }
      index.unshift({ id, created_at, title: share.title });
      if (index.length > 1000) index = index.slice(0, 1000);
      await kv(['SET', 'shares:index', JSON.stringify(index)]);
    } catch (indexErr) {
      console.error('Failed to update shares:index:', indexErr);
    }
  } catch (err) {
    if (handleKvUnavailable(res, err)) return;
    console.error('Failed to store share:', err);
    sendJson(res, 502, { error: 'STORAGE_ERROR', message: '写入存储失败，请稍后重试。' });
    return;
  }

  sendJson(res, 201, { id, url: `${baseUrl(req)}/share.html?id=${id}`, created_at });
};
