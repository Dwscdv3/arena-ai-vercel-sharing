'use strict';

/**
 * 极简的 Upstash / Vercel KV REST 客户端（零依赖）。
 * 支持的环境变量（优先取前者）：
 *   KV_REST_API_URL / KV_REST_API_TOKEN        （Vercel KV 自动注入）
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN （Upstash 直接集成注入）
 */
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;

class KvNotConfiguredError extends Error {
  constructor() {
    super('KV storage is not configured. Create a Vercel KV database and link it to this project.');
    this.code = 'KV_NOT_CONFIGURED';
  }
}

function kvConfigured() {
  return Boolean(KV_URL && KV_TOKEN);
}

/** 执行一条 Redis 命令，例如 kv(['GET', 'foo']) */
async function kv(command) {
  if (!kvConfigured()) throw new KvNotConfiguredError();
  const resp = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    throw new Error(`KV request failed with HTTP ${resp.status}`);
  }
  if (!resp.ok || (data && data.error)) {
    throw new Error(`KV error: ${(data && data.error) || resp.status}`);
  }
  return data ? data.result : null;
}

module.exports = { kv, kvConfigured, KvNotConfiguredError };
