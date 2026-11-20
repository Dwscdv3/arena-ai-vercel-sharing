'use strict';

const { kv } = require('../_kv');
const {
  sendJson,
  readJsonBody,
  parseCookies,
  getShareId,
  handleKvUnavailable,
  parseVotesDoc,
  serializeVotesDoc,
  bumpTally,
  EMPTY_TALLIES,
} = require('../_kit');

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

  const turn = body && (typeof body.turn === 'number' ? body.turn : Number(body.turn));
  if (!Number.isInteger(turn) || turn < 0) {
    sendJson(res, 400, { error: 'INVALID_TURN', message: 'turn 必须是 >= 0 的整数（对应第几轮对话，从 0 开始）。' });
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

  const turnCount = Array.isArray(share.turns) ? share.turns.length : 0;
  if (turn >= turnCount) {
    sendJson(res, 400, { error: 'INVALID_TURN', message: `turn 超出范围：本分享共 ${turnCount} 轮（0 ~ ${turnCount - 1}）。` });
    return;
  }

  // 同一浏览器对每一轮分别去重；旧版 voted_<id> cookie 视为所有轮次都已投过
  const cookies = parseCookies(req);
  const legacyVoted = cookies[`voted_${id}`] === '1';
  const turnVoted = cookies[`voted_${id}_${turn}`] === '1';
  const alreadyVoted = legacyVoted || turnVoted;

  let turnTallies;
  try {
    const rawVotes = await kv(['GET', `votes:${id}`]);
    const { overall, turns } = parseVotesDoc(rawVotes);
    let nextOverall = overall;
    let nextTurns = turns;
    if (!alreadyVoted) {
      nextOverall = bumpTally(overall, choice);
      nextTurns = { ...turns, [String(turn)]: bumpTally(turns[String(turn)] || EMPTY_TALLIES, choice) };
      await kv(['SET', `votes:${id}`, serializeVotesDoc(nextOverall, nextTurns)]);
    }
    turnTallies = { ...(nextTurns[String(turn)] || EMPTY_TALLIES) };
  } catch (err) {
    if (handleKvUnavailable(res, err)) return;
    console.error('Failed to record vote:', err);
    sendJson(res, 502, { error: 'STORAGE_ERROR', message: '写入投票失败，请稍后重试。' });
    return;
  }

  const cookie = [
    `voted_${id}_${turn}=1`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 365}`,
  ].join('; ');

  sendJson(res, 200, {
    id,
    turn,
    voted: true,
    already_voted: alreadyVoted,
    choice: alreadyVoted ? null : choice,
    models: share.models,
    tallies: turnTallies,
  }, { 'Set-Cookie': cookie });
};
