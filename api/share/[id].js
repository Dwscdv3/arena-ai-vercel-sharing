'use strict';

const { kv } = require('../_kv');
const { sendJson, parseCookies, getShareId, handleKvUnavailable } = require('../_kit');

const EMPTY_TALLIES = { a: 0, b: 0, tie: 0, bad: 0, total: 0 };

async function readTallies(id) {
  const raw = await kv(['GET', `votes:${id}`]);
  if (!raw) return { ...EMPTY_TALLIES };
  try {
    const parsed = JSON.parse(raw);
    const a = Number(parsed.a) || 0;
    const b = Number(parsed.b) || 0;
    const tie = Number(parsed.tie) || 0;
    const bad = Number(parsed.bad) || 0;
    return { a, b, tie, bad, total: a + b + tie + bad };
  } catch {
    return { ...EMPTY_TALLIES };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const id = getShareId(req);
  if (!id) {
    sendJson(res, 400, { error: 'INVALID_ID', message: '分享 ID 不合法。' });
    return;
  }

  let share;
  try {
    const raw = await kv(['GET', `share:${id}`]);
    share = raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (handleKvUnavailable(res, err)) return;
    console.error('Failed to read share:', err);
    sendJson(res, 502, { error: 'STORAGE_ERROR', message: '读取存储失败，请稍后重试。' });
    return;
  }

  if (!share) {
    sendJson(res, 404, { error: 'NOT_FOUND', message: '分享不存在或已被删除。' });
    return;
  }

  const cookies = parseCookies(req);
  const voted = cookies[`voted_${id}`] === '1';

  let tallies = null;
  try {
    if (voted) tallies = await readTallies(id);
  } catch (err) {
    console.error('Failed to read tallies:', err);
    tallies = null;
  }

  sendJson(res, 200, {
    id: share.id,
    created_at: share.created_at,
    title: share.title,
    source_url: share.source_url,
    turns: share.turns,
    // 投票前像 arena.ai 一样隐藏模型名称；投过票的浏览器才会返回真名和统计
    models: voted ? share.models : null,
    voted,
    tallies,
  });
};
