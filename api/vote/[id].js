'use strict';

const { kv } = require('../_kv');
const { sendJson, readJsonBody, parseCookies, getShareId, handleKvUnavailable } = require('../_kit');

const CHOICES = new Set(['a', 'b', 'tie', 'bad']);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const id = getShareId(req);
  if (!id) {
    sendJson(res, 400, { error: 'INVALID_ID', message: '分享 ID 不合法。' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err && err.message === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      return;
    }
    throw err;
  }

  const choice = body && typeof body.choice === 'string' ? body.choice.toLowerCase() : '';
  if (!CHOICES.has(choice)) {
    sendJson(res, 400, { error: 'INVALID_CHOICE', message: "choice 必须是 'a' / 'b' / 'tie' / 'bad' 之一。" });
    return;
  }

  // 分享必须存在才接受投票
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

  // 防止同一浏览器重复计票：已投过则直接返回当前结果
  const cookies = parseCookies(req);
  const alreadyVoted = cookies[`voted_${id}`] === '1';

  let tallies;
  try {
    const rawVotes = await kv(['GET', `votes:${id}`]);
    const votes = rawVotes ? JSON.parse(rawVotes) : { a: 0, b: 0, tie: 0, bad: 0 };
    if (!alreadyVoted) {
      votes[choice] = (Number(votes[choice]) || 0) + 1;
      await kv(['SET', `votes:${id}`, JSON.stringify(votes)]);
    }
    const a = Number(votes.a) || 0;
    const b = Number(votes.b) || 0;
    const tie = Number(votes.tie) || 0;
    const bad = Number(votes.bad) || 0;
    tallies = { a, b, tie, bad, total: a + b + tie + bad };
  } catch (err) {
    if (handleKvUnavailable(res, err)) return;
    console.error('Failed to record vote:', err);
    sendJson(res, 502, { error: 'STORAGE_ERROR', message: '写入投票失败，请稍后重试。' });
    return;
  }

  const cookie = [
    `voted_${id}=1`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 365}`,
  ].join('; ');

  sendJson(res, 200, {
    id,
    voted: true,
    already_voted: alreadyVoted,
    choice: alreadyVoted ? null : choice,
    models: share.models,
    tallies,
  }, { 'Set-Cookie': cookie });
};
