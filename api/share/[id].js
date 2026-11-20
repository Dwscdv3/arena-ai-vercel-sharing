'use strict';

const { kv } = require('../_kv');
const { sendJson, parseCookies, getShareId, handleKvUnavailable, parseVotesDoc, EMPTY_TALLIES } = require('../_kit');

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

  const turns = Array.isArray(share.turns) ? share.turns : [];

  // 每轮分别去重；旧版 voted_<id> cookie 视为所有轮次都已投过
  const cookies = parseCookies(req);
  const legacyVoted = cookies[`voted_${id}`] === '1';
  const votedTurns = [];
  for (let i = 0; i < turns.length; i += 1) {
    if (legacyVoted || cookies[`voted_${id}_${i}`] === '1') votedTurns.push(i);
  }
  const anyVoted = votedTurns.length > 0;

  let tallies = null;
  let turnTallies = null;
  try {
    if (anyVoted) {
      const rawVotes = await kv(['GET', `votes:${id}`]);
      const { overall, turns: perTurn } = parseVotesDoc(rawVotes);
      tallies = overall;
      turnTallies = turns.map((_, i) => ({ ...(perTurn[String(i)] || EMPTY_TALLIES) }));
    }
  } catch (err) {
    console.error('Failed to read tallies:', err);
    tallies = null;
    turnTallies = null;
  }

  // 每轮模型名：仅对该轮已投票的浏览器返回；顶层 models 仅为旧版（无每轮模型名）的回退
  const hasPerTurn = turns.some((t) => t && t.models && ((t.models.a && t.models.a.trim()) || (t.models.b && t.models.b.trim())));
  const turnsOut = turns.map((t, i) => {
    const base = { prompt: (t && t.prompt) || '', responses: (t && t.responses) || { a: '', b: '' } };
    if (t && t.models && ((t.models.a && t.models.a.trim()) || (t.models.b && t.models.b.trim()))) {
      base.models = votedTurns.includes(i) ? { a: t.models.a || '', b: t.models.b || '' } : null;
    }
    return base;
  });

  sendJson(res, 200, {
    id: share.id,
    created_at: share.created_at,
    title: share.title,
    source_url: share.source_url,
    turns: turnsOut,
    // 新版分享：每轮各自揭晓；旧版分享（无每轮模型名）：投过任意一轮后整场解锁
    models: hasPerTurn ? null : (anyVoted ? share.models : null),
    voted: legacyVoted,
    voted_turns: votedTurns,
    tallies,
    turn_tallies: turnTallies,
  });
};
