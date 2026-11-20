// ==UserScript==
// @name         Arena Blind Share
// @namespace    https://github.com/Dwscdv3/arena-ai-vercel-sharing
// @version      1.0.0
// @description  把当前 arena.ai 对战对话保存下来，生成「投票后才揭晓模型名」的匿名分享链接（由 Vercel 后端托管）
// @author       Dwscdv3
// @homepage     https://github.com/Dwscdv3/arena-ai-vercel-sharing
// @match        https://arena.ai/*
// @match        https://www.arena.ai/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_setClipboard
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* global GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_registerMenuCommand, GM_notification, GM_setClipboard */

(function () {
  'use strict';

  // 部署完成后，脚本默认指向该地址；也可以通过菜单“设置 API 地址”改成自己的实例
  var DEFAULT_API_BASE = 'https://arena-blind-share.vercel.app';

  var TOKEN_KEY = 'share_token';
  var API_KEY = 'api_base';

  function getToken() { return GM_getValue(TOKEN_KEY, ''); }
  function getApiBase() {
    return String(GM_getValue(API_KEY, DEFAULT_API_BASE) || DEFAULT_API_BASE).replace(/\/+$/, '');
  }

  function notify(text) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title: 'Arena Blind Share', text: text, timeout: 5000 });
        return;
      }
    } catch (_) { /* fall through */ }
    alert(text);
  }

  function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; }
    } catch (_) { /* fall through */ }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* fall through */ }
    return false;
  }

  // ---------- 对话提取 ----------

  function getText(el) {
    return (el.innerText || '').trim();
  }

  function dedupeNested(nodes) {
    var kept = [];
    nodes.forEach(function (node) {
      if (node.closest && node.closest('[data-abs-ignore]')) return;
      for (var i = 0; i < kept.length; i++) {
        if (kept[i].contains(node) || node.contains(kept[i])) {
          // 保留最外层（内容更完整）
          if (node.contains(kept[i])) kept[i] = node;
          return;
        }
      }
      kept.push(node);
    });
    return kept;
  }

  function isUserNode(el) {
    if (!el.getAttribute) return false;
    var role = (el.getAttribute('data-role') || el.getAttribute('data-author') || '').toLowerCase();
    if (role === 'user' || role === 'human') return true;
    var cls = (el.className && el.className.toString ? el.className.toString() : '').toLowerCase();
    if (/(^|\s|_|-)(user|human|question|prompt)(-|_|\s|$)/.test(cls)) return true;
    var testid = (el.getAttribute('data-testid') || '').toLowerCase();
    if (/user|human|question|prompt/.test(testid)) return true;
    return false;
  }

  function isAssistantNode(el) {
    if (isUserNode(el)) return false;
    var role = ((el.getAttribute('data-role') || el.getAttribute('data-author') || '') + '').toLowerCase();
    if (role === 'assistant' || role === 'model' || role === 'bot') return true;
    var cls = (el.className && el.className.toString ? el.className.toString() : '').toLowerCase();
    if (/prose|markdown|assistant|model-response|answer/.test(cls)) return true;
    if (el.classList && el.classList.contains('prose')) return true;
    return false;
  }

  function sideOf(el) {
    try {
      var rect = el.getBoundingClientRect();
      var mid = (rect.left + rect.right) / 2;
      return mid < window.innerWidth / 2 ? 'a' : 'b';
    } catch (_) {
      return 'a';
    }
  }

  var KNOWN_MODEL_RE = /(gpt[-\w.]*|o[134](?:-[\w.]+)*|claude[-\w.]*|gemini[-\w.]*|llama[-\w.]*|qwen[-\w.]*|grok[-\w.]*|deepseek[-\w.]*|mistral[-\w.]*|mixtral[-\w.]*|command[-\w.]*|nova[-\w.]*|glm[-\w.]*|yi[-\w.]*|phi[-\w.]*|kimi[-\w.]*|doubao[-\w.]*|ernie[-\w.]*|o1-preview|chatgpt)/i;

  function detectModelNames() {
    var found = [];
    var candidates = document.querySelectorAll('[class*="model" i], [class*="Model"], [data-model], [data-testid*="model" i]');
    candidates.forEach(function (el) {
      var text = getText(el);
      if (!text || text.length > 80) return;
      var m = KNOWN_MODEL_RE.exec(text);
      if (m) {
        var name = m[0].trim();
        if (found.indexOf(name) === -1) found.push({ name: name, left: el.getBoundingClientRect().left });
      }
    });
    found.sort(function (x, y) { return x.left - y.left; });
    return found.map(function (f) { return f.name; });
  }

  function extractConversation() {
    var raw = Array.prototype.slice.call(
      document.querySelectorAll('.prose, [data-role], [data-author], [data-testid*="message" i], [class*="message" i], [class*="response" i]')
    ).filter(function (el) { return getText(el).length > 0; });

    var nodes = dedupeNested(raw)
      // 过滤不可见节点
      .filter(function (el) {
        try {
          var rect = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          return rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        } catch (_) { return true; }
      })
      .filter(function (el) { return isUserNode(el) || isAssistantNode(el); });

    // 按文档顺序
    nodes.sort(function (a, b) {
      if (a === b) return 0;
      var pos = a.compareDocumentPosition(b);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    var turns = [];
    var current = null;
    var seen = new Set();

    nodes.forEach(function (el) {
      var text = getText(el);
      if (!text) return;
      var key = text.slice(0, 200);
      // 跳过完全相同的重复文本（嵌套去重后仍可能漏掉）
      if (seen.has(key)) return;
      seen.add(key);

      if (isUserNode(el)) {
        current = { prompt: text, responses: { a: '', b: '' } };
        turns.push(current);
        return;
      }
      if (!current) {
        current = { prompt: '', responses: { a: '', b: '' } };
        turns.push(current);
      }
      var side = sideOf(el);
      if (current.responses[side]) side = side === 'a' ? 'b' : 'a';
      if (!current.responses[side]) current.responses[side] = text;
    });

    // 清理完全为空的轮次
    turns = turns.filter(function (t) {
      return (t.prompt && t.prompt.trim()) || t.responses.a.trim() || t.responses.b.trim();
    });

    var modelNames = detectModelNames();
    var models = null;
    if (modelNames.length >= 2) {
      models = { a: modelNames[0], b: modelNames[1] };
    } else if (modelNames.length === 1) {
      models = { a: modelNames[0], b: '' };
    }

    var title = (document.title || '').replace(/[-–|]\s*arena\.ai.*$/i, '').trim();
    if (!title || /^arena\.ai$/i.test(title)) {
      title = (turns[0] && (turns[0].prompt || turns[0].responses.a) || '未命名对话').replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    return {
      version: 1,
      created_at: new Date().toISOString(),
      source: 'arena.ai',
      source_url: window.location.href,
      title: title,
      models: models,
      turns: turns,
    };
  }

  // ---------- 审核 / 发送 UI ----------

  function buildPayload() {
    var extracted = extractConversation();
    if (!extracted.turns.length) return null;
    return extracted;
  }

  function showReviewModal(payload) {
    closeModal();
    var overlay = document.createElement('div');
    overlay.id = 'abs-overlay';
    overlay.setAttribute('data-abs-ignore', '1');
    overlay.innerHTML =
      '<div class="abs-modal" role="dialog" aria-modal="true">' +
        '<div class="abs-head"><span>分享当前对话</span><button class="abs-close" title="关闭">×</button></div>' +
        '<div class="abs-body">' +
          '<p class="abs-hint">抓取结果如下。你可以直接编辑 JSON（例如修正模型名或删掉多余内容），确认后点击发送。模型名留空将保持匿名。</p>' +
          '<textarea class="abs-json" spellcheck="false"></textarea>' +
          '<p class="abs-meta"></p>' +
        '</div>' +
        '<div class="abs-foot">' +
          '<button class="abs-btn abs-secondary" data-act="regrab">重新抓取</button>' +
          '<button class="abs-btn abs-primary" data-act="send">生成分享链接</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var textarea = overlay.querySelector('.abs-json');
    var meta = overlay.querySelector('.abs-meta');
    var apiBase = getApiBase();
    var tokenReady = Boolean(getToken());
    textarea.value = JSON.stringify(payload, null, 2);
    meta.textContent = 'API：' + apiBase + (tokenReady ? ' · token 已设置' : ' · ⚠ 尚未设置 SHARE_TOKEN（菜单 → 设置 SHARE_TOKEN）');

    overlay.querySelector('.abs-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

    overlay.querySelector('[data-act="regrab"]').addEventListener('click', function () {
      var fresh = buildPayload();
      if (fresh) textarea.value = JSON.stringify(fresh, null, 2);
    });

    overlay.querySelector('[data-act="send"]').addEventListener('click', function () {
      var parsed;
      try { parsed = JSON.parse(textarea.value); } catch (e) {
        notify('JSON 解析失败：' + e.message);
        return;
      }
      if (!Array.isArray(parsed.turns) || !parsed.turns.length) {
        notify('turns 必须是非空数组。');
        return;
      }
      sendShare(parsed, overlay);
    });
  }

  function showResultModal(url) {
    closeModal();
    var overlay = document.createElement('div');
    overlay.id = 'abs-overlay';
    overlay.setAttribute('data-abs-ignore', '1');
    overlay.innerHTML =
      '<div class="abs-modal" role="dialog" aria-modal="true">' +
        '<div class="abs-head"><span>分享链接已生成</span><button class="abs-close" title="关闭">×</button></div>' +
        '<div class="abs-body">' +
          '<p class="abs-hint">把链接发给别人吧。访客投票前看到的是匿名模型，投票后揭晓。</p>' +
          '<div class="abs-link"></div>' +
          '<p class="abs-meta"></p>' +
        '</div>' +
        '<div class="abs-foot">' +
          '<button class="abs-btn abs-secondary" data-act="copy">复制链接</button>' +
          '<a class="abs-btn abs-primary" data-act="open" target="_blank" rel="noopener noreferrer">打开链接</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.abs-link').textContent = url;
    var openBtn = overlay.querySelector('[data-act="open"]');
    openBtn.href = url;
    overlay.querySelector('.abs-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    overlay.querySelector('[data-act="copy"]').addEventListener('click', function () {
      var ok = copyText(url);
      overlay.querySelector('.abs-meta').textContent = ok ? '已复制到剪贴板。' : '复制失败，请手动选择上方链接。';
    });
  }

  function closeModal() {
    var existing = document.getElementById('abs-overlay');
    if (existing) existing.remove();
  }

  function sendShare(payload, overlay) {
    var token = getToken();
    if (!token) {
      notify('尚未设置 SHARE_TOKEN。请打开油猴菜单 → “Arena Blind Share: 设置 SHARE_TOKEN”。');
      return;
    }
    var apiBase = getApiBase();
    var sendBtn = overlay && overlay.querySelector('[data-act="send"]');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '正在发送…'; }

    GM_xmlhttpRequest({
      method: 'POST',
      url: apiBase + '/api/shares',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      data: JSON.stringify(payload),
      timeout: 30000,
      onload: function (resp) {
        var body = {};
        try { body = JSON.parse(resp.responseText || '{}'); } catch (_) { /* keep {} */ }
        if (resp.status >= 200 && resp.status < 300 && body.url) {
          showResultModal(body.url);
        } else {
          if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '生成分享链接'; }
          notify('发送失败（HTTP ' + resp.status + '）：' + ((body && (body.message || body.error)) || resp.responseText.slice(0, 200)));
        }
      },
      onerror: function () {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '生成分享链接'; }
        notify('网络错误：无法连接到 ' + apiBase);
      },
      ontimeout: function () {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '生成分享链接'; }
        notify('请求超时，请稍后重试。');
      },
    });
  }

  function startShareFlow() {
    var payload = buildPayload();
    if (!payload) {
      // 抓取失败：给一个可手动填写的空模板
      payload = {
        version: 1,
        created_at: new Date().toISOString(),
        source: 'arena.ai',
        source_url: window.location.href,
        title: (document.title || '').replace(/[-–|]\s*arena\.ai.*$/i, '').trim() || '未命名对话',
        models: null,
        turns: [{ prompt: '', responses: { a: '', b: '' } }],
      };
      notify('未能从页面自动抓取到对话内容，已打开手动填写窗口。');
    }
    showReviewModal(payload);
  }

  // ---------- 浮动按钮 ----------

  function ensureStyles() {
    if (document.getElementById('abs-styles')) return;
    var style = document.createElement('style');
    style.id = 'abs-styles';
    style.textContent =
      '#abs-share-btn{position:fixed;right:18px;bottom:84px;z-index:2147483000;display:flex;align-items:center;gap:8px;' +
        'background:#0f1117;color:#e2e8f0;border:1px solid rgba(125,211,252,.4);border-radius:999px;' +
        'padding:10px 16px;font:600 13px/1 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.45);opacity:.92;transition:opacity .15s,transform .15s}' +
      '#abs-share-btn:hover{opacity:1;transform:translateY(-1px)}' +
      '#abs-share-btn svg{width:16px;height:16px;stroke:#7dd3fc}' +
      '#abs-overlay{position:fixed;inset:0;z-index:2147483640;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px}' +
      '.abs-modal{background:#0f1117;border:1px solid rgba(148,163,184,.25);border-radius:16px;max-width:720px;width:100%;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6);color:#e2e8f0;font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}' +
      '.abs-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(148,163,184,.15);font-weight:700}' +
      '.abs-close{background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;line-height:1;padding:2px 8px;border-radius:8px}' +
      '.abs-close:hover{color:#e2e8f0;background:rgba(148,163,184,.1)}' +
      '.abs-body{padding:16px 18px;overflow:auto}' +
      '.abs-hint{color:#94a3b8;font-size:12.5px;margin-bottom:10px}' +
      '.abs-json{width:100%;min-height:260px;background:#1e293b;color:#e2e8f0;border:1px solid rgba(148,163,184,.25);border-radius:10px;padding:12px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;outline:none}' +
      '.abs-json:focus{border-color:#7dd3fc}' +
      '.abs-meta{color:#64748b;font-size:12px;margin-top:10px;word-break:break-all}' +
      '.abs-link{background:#1e293b;border:1px solid rgba(125,211,252,.35);border-radius:10px;padding:12px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7dd3fc;word-break:break-all;user-select:all}' +
      '.abs-foot{display:flex;gap:10px;justify-content:flex-end;padding:14px 18px;border-top:1px solid rgba(148,163,184,.15)}' +
      '.abs-btn{border-radius:10px;padding:9px 18px;font:600 13px/1 inherit;cursor:pointer;text-decoration:none;border:none;display:inline-flex;align-items:center}' +
      '.abs-primary{background:#e2e8f0;color:#0f1117}' +
      '.abs-primary:hover{background:#fff}' +
      '.abs-primary[disabled]{opacity:.6;cursor:default}' +
      '.abs-secondary{background:transparent;color:#cbd5e1;border:1px solid rgba(148,163,184,.4)}' +
      '.abs-secondary:hover{border-color:#cbd5e1}';
    document.head.appendChild(style);
  }

  function ensureShareButton() {
    ensureStyles();
    if (document.getElementById('abs-share-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'abs-share-btn';
    btn.setAttribute('data-abs-ignore', '1');
    btn.title = '把当前对话生成匿名分享链接';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>' +
        '<path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>' +
      '</svg>分享对话';
    btn.addEventListener('click', startShareFlow);
    (document.body || document.documentElement).appendChild(btn);
  }

  // ---------- 菜单 ----------

  GM_registerMenuCommand('Arena Blind Share: 设置 SHARE_TOKEN', function () {
    var current = getToken();
    var value = window.prompt('输入 SHARE_TOKEN（只保存在本机油猴存储中，不会写入仓库）：', current ? '********' : '');
    if (value === null) return;
    value = value.trim();
    if (value === '********') return;
    GM_setValue(TOKEN_KEY, value);
    notify(value ? 'SHARE_TOKEN 已保存到本地存储。' : 'SHARE_TOKEN 已清空。');
  });

  GM_registerMenuCommand('Arena Blind Share: 设置 API 地址', function () {
    var value = window.prompt('API 地址（你的 Vercel 部署地址）：', getApiBase());
    if (value === null) return;
    value = value.trim().replace(/\/+$/, '');
    if (!value) { notify('API 地址不能为空。'); return; }
    GM_setValue(API_KEY, value);
    notify('API 地址已更新为 ' + value);
  });

  GM_registerMenuCommand('Arena Blind Share: 立即分享当前对话', startShareFlow);

  // SPA 页面跳转后按钮可能被移除，定时确保存在
  ensureShareButton();
  setInterval(ensureShareButton, 2000);
})();
