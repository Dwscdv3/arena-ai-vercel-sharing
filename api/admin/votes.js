'use strict';

const { kv } = require('../_kv');
const { sendJson, isAuthorized, baseUrl, handleKvUnavailable, parseVotesDoc, EMPTY_TALLIES } = require('../_kit');

function snippet(text, max) {
  const clean = String(text || '')
    .replace(/<[^>]*>/g, ' ')          // 新版分享存的是 HTML：先剥掉标签
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + '…';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const auth = isAuthorized(req);
  if (!auth.ok) {
    if (auth.reason === 'SHARE_TOKEN_NOT_CONFIGURED') {
      sendJson(res, 500, { error: 'SHARE_TOKEN_NOT_CONFIGURED', message: '服务器未配置 SHARE_TOKEN。' });
      return;
    }
    sendJson(res, 401, { error: 'UNAUTHORIZED', message: '查看投票统计需要 SHARE_TOKEN（Authorization: Bearer <token>）。' });
    return;
  }

  try {
    const rawIndex = await kv(['GET', 'shares:index']);
    let index = [];
    if (rawIndex) {
      try { index = JSON.parse(rawIndex); } catch { index = []; }
      if (!Array.isArray(index)) index = [];
    }

    const base = baseUrl(req);
    const shares = await Promise.all(
      index.map(async (entry) => {
        try {
          const [rawShare, rawVotes] = await Promise.all([
            kv(['GET', `share:${entry.id}`]),
            kv(['GET', `votes:${entry.id}`]),
          ]);
          const share = rawShare ? JSON.parse(rawShare) : null;
          const turnCount = share && Array.isArray(share.turns) ? share.turns.length : 0;
          const { overall, turns: perTurn } = parseVotesDoc(rawVotes);
          const turns = [];
          for (let i = 0; i < turnCount; i += 1) {
            turns.push({
              index: i,
              prompt: snippet(share.turns[i] && share.turns[i].prompt, 80),
              tallies: { ...(perTurn[String(i)] || EMPTY_TALLIES) },
              models: (share.turns[i] && share.turns[i].models) || null,
            });
          }
          return {
            id: entry.id,
            url: `${base}/share.html?id=${entry.id}`,
            title: entry.title || (share && share.title) || '',
            created_at: entry.created_at || (share && share.created_at) || null,
            models: share ? share.models : null,
            source_url: share ? share.source_url : null,
            turn_count: turnCount,
            tallies: overall,
            turns,
          };
        } catch (err) {
          console.error(`Failed to load share ${entry.id}:`, err);
          return {
            id: entry.id,
            url: `${base}/share.html?id=${entry.id}`,
            title: entry.title || '',
            created_at: entry.created_at || null,
            models: null,
            source_url: null,
            turn_count: 0,
            tallies: { ...EMPTY_TALLIES },
            turns: [],
            error: 'LOAD_FAILED',
          };
        }
      })
    );

    const totals = shares.reduce(
      (acc, s) => {
        acc.a += s.tallies.a;
        acc.b += s.tallies.b;
        acc.tie += s.tallies.tie;
        acc.bad += s.tallies.bad;
        acc.total += s.tallies.total;
        return acc;
      },
      { a: 0, b: 0, tie: 0, bad: 0, total: 0 }
    );

    sendJson(res, 200, {
      generated_at: new Date().toISOString(),
      share_count: shares.length,
      totals,
      shares,
    });
  } catch (err) {
    if (handleKvUnavailable(res, err)) return;
    console.error('Failed to build admin report:', err);
    sendJson(res, 502, { error: 'STORAGE_ERROR', message: '读取存储失败，请稍后重试。' });
  }
};
