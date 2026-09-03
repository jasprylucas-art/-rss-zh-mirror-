#!/usr/bin/env node
/**
 * RSS 中文镜像生成器（GitHub Actions 版）
 *
 * 读取 feeds.txt 里的源 → 抓取 → 翻译标题/分类 → 输出到 docs/*.xml
 * 译文缓存在 cache/translations.json，只有新标题才真正调用翻译接口。
 *
 * 用法：
 *   node scripts/translate.mjs            # 正常跑（命中缓存则跳过）
 *   FORCE=1 node scripts/translate.mjs    # 忽略缓存，全部重翻
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


/**
 * 单文件版：engines.js + feed-translator.js + translate.mjs 已合并在一起。
 * 由 tools/build-single.mjs 自动生成，请勿手工编辑——要改就改 scripts/ 下的源文件再重新生成。
 */

/* ==================== engines.js ==================== */
// 翻译引擎集合：全部为免费或自带 Key 的方案，按配置顺序依次降级。
// 在 Cloudflare Workers 与 Node 22 中均可运行（都依赖全局 fetch）。

const LLM_SYSTEM_PROMPT =
  '你是专业的日语翻译引擎。请把用户给出的日语文本翻译成简体中文。' +
  '要求：只输出译文，不要任何解释或多余符号；' +
  '保留原文中的数字、型号、日期、人名、作品编号、URL 与换行结构；' +
  '对于成人作品标题这类专有表达，直译即可，不要意译或美化。';

async function callGoogle(text, from, to, env) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
    encodeURIComponent(from) +
    '&tl=' +
    encodeURIComponent(to) +
    '&dt=t&q=' +
    encodeURIComponent(text);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error('google status ' + res.status);
  const data = await res.json();
  const out = (data[0] || []).map((seg) => seg && seg[0]).filter(Boolean).join('');
  if (!out) throw new Error('google empty result');
  return out;
}

async function callMyMemory(text, from, to, env) {
  let url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) +
    '&langpair=' +
    encodeURIComponent(from + '|' + to);
  if (env.MYMEMORY_EMAIL) url += '&de=' + encodeURIComponent(env.MYMEMORY_EMAIL);
  const res = await fetch(url);
  if (!res.ok) throw new Error('mymemory status ' + res.status);
  const data = await res.json();
  if (String(data.responseStatus) !== '200') {
    throw new Error('mymemory ' + data.responseStatus + ' ' + (data.responseDetails || ''));
  }
  const out = data?.responseData?.translatedText || '';
  // 免费额度耗尽时 MyMemory 会返回带警告的原文
  if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) {
    throw new Error('mymemory quota or invalid: ' + out.slice(0, 60));
  }
  return out;
}

// Lingva：Google 翻译的开源代理，公共实例免 Key。多实例轮换，任一可用即成功。
const LINGVA_HOSTS = [
  'https://lingva.ml',
  'https://lingva.lunar.icu',
  'https://translate.plausibility.cloud',
];

async function callLingva(text, from, to, env) {
  const custom = (env.LINGVA_HOSTS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const hosts = custom.concat(LINGVA_HOSTS);
  const errors = [];
  for (const host of hosts) {
    try {
      const url =
        host +
        '/api/v1/' +
        encodeURIComponent(from) +
        '/' +
        encodeURIComponent(to) +
        '/' +
        encodeURIComponent(text);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) {
        errors.push(host + ':' + res.status);
        continue;
      }
      const data = await res.json();
      const out = (data && data.translation) || '';
      if (!out) {
        errors.push(host + ':empty');
        continue;
      }
      return out;
    } catch (err) {
      errors.push(host + ':' + err.message);
    }
  }
  throw new Error('lingva failed [' + errors.join(' | ') + ']');
}

async function callDeepL(text, from, to, env) {
  if (!env.DEEPL_API_KEY) throw new Error('deepl key missing');
  const base = env.DEEPL_API_URL || 'https://api-free.deepl.com';
  const res = await fetch(base + '/v2/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'DeepL-Auth-Key ' + env.DEEPL_API_KEY,
    },
    body: JSON.stringify({
      text: [text],
      source_lang: from.toUpperCase(),
      target_lang: to.toUpperCase() === 'ZH-CN' ? 'ZH' : to.toUpperCase(),
    }),
  });
  if (!res.ok) throw new Error('deepl status ' + res.status);
  const data = await res.json();
  const out = data?.translations?.[0]?.text;
  if (!out) throw new Error('deepl empty result');
  return out;
}

async function callLLM(text, from, to, env) {
  if (!env.LLM_API_KEY || !env.LLM_BASE_URL) throw new Error('llm config missing');
  const res = await fetch(env.LLM_BASE_URL.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.LLM_API_KEY,
    },
    body: JSON.stringify({
      model: env.LLM_MODEL || 'deepseek-chat',
      temperature: 0.2,
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error('llm status ' + res.status);
  const data = await res.json();
  const out = (data?.choices?.[0]?.message?.content || '').trim();
  if (!out) throw new Error('llm empty result');
  return out;
}

const ENGINES = {
  google: callGoogle,
  lingva: callLingva,
  mymemory: callMyMemory,
  llm: callLLM,
  deepl: callDeepL,
};

/** 默认降级顺序：免 Key 的免费引擎在前，配了 Key 的高质量引擎在后 */
const DEFAULT_ORDER = ['google', 'lingva', 'mymemory', 'llm', 'deepl'];

/**
 * 生成翻译函数：按 order 顺序尝试各引擎，任一成功即返回。
 * @param {string[]} order 例如 ['google','mymemory','llm','deepl']
 */
function makeTranslator(order, env) {
  return async function translate(text, from, to) {
    const errors = [];
    for (const name of order) {
      const fn = ENGINES[name];
      if (!fn) continue;
      try {
        const out = await fn(text, from, to, env || {});
        if (out && out.trim()) return out.trim();
        errors.push(name + ': empty');
      } catch (err) {
        errors.push(name + ': ' + err.message);
      }
    }
    throw new Error('all engines failed [' + errors.join(' | ') + ']');
  };
}

{ LLM_SYSTEM_PROMPT };

/* ==================== feed-translator.js ==================== */
// RSS / Atom 翻译核心：原地替换标题等字段，保留其余所有结构（图片、正文、命名空间、GUID 等）。
// 纯逻辑，不依赖任何平台 API，便于本地测试与在 Worker 中复用。

const DEFAULTS = {
  from: 'ja',
  to: 'zh-CN',
  translateTitle: true,
  translateCategories: true,
  translateDescription: false,
  translateContent: false,
  keepOriginal: true, // 在 description 里追加【原文】，方便回看与搜索
  onlyJapanese: true, // 只翻含日文字符的文本，跳过数字/英文/链接
  maxCharsPerField: 300, // 超长截断，控制免费额度消耗
  maxItems: 40,
  concurrency: 3,
  translationTtl: 60 * 60 * 24 * 30, // 单条译文缓存 30 天
};

// 含假名/汉字即视为需要翻译
const JA_RE =
  /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f\uff01-\uff60]/;

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cdataSafe(s) {
  return String(s).replace(/\]\]>/g, ']]]]><![CDATA[>');
}

/** 同步哈希，用作缓存键（Worker 与 Node 都可用） */
function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 把标签内容还原成待翻译的纯文本；返回 null 表示跳过 */
function normalizeTagContent(inner, cfg) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  let text = decodeEntities(cdata ? cdata[1] : inner);
  text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > cfg.maxCharsPerField) text = text.slice(0, cfg.maxCharsPerField);
  return text;
}

function targetTags(cfg) {
  const tags = [];
  if (cfg.translateTitle) tags.push('title');
  if (cfg.translateCategories) tags.push('category');
  if (cfg.translateDescription) tags.push('description', 'summary');
  if (cfg.translateContent) tags.push('content:encoded', 'content');
  return tags;
}

function tagRegex(tag) {
  return new RegExp('<' + tag + '(\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
}

/** 扫描整份文档，收集所有需要翻译的文本（去重） */
function collectTexts(xml, cfg) {
  const found = new Set();
  for (const tag of targetTags(cfg)) {
    const re = tagRegex(tag);
    let m;
    while ((m = re.exec(xml)) !== null) {
      const text = normalizeTagContent(m[2], cfg);
      if (!text) continue;
      if (cfg.onlyJapanese && !JA_RE.test(text)) continue;
      found.add(text);
    }
  }
  return [...found];
}

/** 批量翻译：去重 + 缓存 + 并发控制 */
async function translateTexts(texts, ctx) {
  const cfg = ctx.config;
  const cacheGet = ctx.cacheGet || (async () => null);
  const cachePut = ctx.cachePut || (async () => {});
  const result = new Map();
  const pending = [];

  for (const text of texts) {
    const key = 't1:' + cfg.from + '>' + cfg.to + ':' + hash(text);
    let hit = null;
    try {
      hit = await cacheGet(key);
    } catch {
      hit = null;
    }
    if (hit) {
      result.set(text, hit);
      ctx.stats.cached++;
    } else {
      pending.push({ text, key });
    }
  }

  let cursor = 0;
  const workers = new Array(Math.max(1, cfg.concurrency)).fill(0).map(async () => {
    while (cursor < pending.length) {
      const index = cursor++;
      const job = pending[index];
      try {
        const out = await ctx.translate(job.text, cfg.from, cfg.to);
        result.set(job.text, out);
        ctx.stats.translated++;
        try {
          await cachePut(job.key, out, cfg.translationTtl);
        } catch {
          /* 缓存写失败不影响主流程 */
        }
      } catch (err) {
        ctx.stats.failed++;
        ctx.errors.push(job.text.slice(0, 30) + ' -> ' + err.message);
      }
    }
  });
  await Promise.all(workers);
  return result;
}

/** 对单个 item/entry 区块做替换，并可追加原文 */
function applyToBlock(block, map, cfg) {
  let originalTitle = null;
  const titleRe = tagRegex('title');
  const firstTitle = titleRe.exec(block);
  if (firstTitle) originalTitle = normalizeTagContent(firstTitle[2], cfg);

  let out = block;
  for (const tag of targetTags(cfg)) {
    out = out.replace(tagRegex(tag), (m, attrs, inner) => {
      const text = normalizeTagContent(inner, cfg);
      const translated = text ? map.get(text) : null;
      if (!translated) return m;
      const isCdata = /^\s*<!\[CDATA\[/.test(inner);
      const body = isCdata
        ? '<![CDATA[' + cdataSafe(translated) + ']]>'
        : escapeXml(translated);
      return '<' + tag + (attrs || '') + '>' + body + '</' + tag + '>';
    });
  }

  if (cfg.keepOriginal && originalTitle) {
    // 追加到已有的 description（RSS）或 summary（Atom）。
    // 两者都没有时宁可不标原文：在 Atom 里插入无命名空间的 <description>
    // 属于非法元素，部分阅读器会据此判为解析失败。
    const marker = '【原文】' + originalTitle;
    out = out.replace(
      /<(description|summary)(\s[^>]*)?>([\s\S]*?)<\/\1>/i,
      (m, tag, attrs, inner) => {
        const isCdata = /^\s*<!\[CDATA\[/.test(inner);
        const text = normalizeTagContent(inner, cfg) || '';
        const merged = text ? text + '\n' + marker : marker;
        const body = isCdata
          ? '<![CDATA[' + cdataSafe(merged) + ']]>'
          : escapeXml(merged);
        return '<' + tag + (attrs || '') + '>' + body + '</' + tag + '>';
      }
    );
  }
  return out;
}

/**
 * 主入口：把原始 feed XML 转成译文 feed XML。
 * @param {string} xml 源 feed 原文
 * @param {object} ctx { config, translate, cacheGet, cachePut, stats, errors }
 */
async function translateFeedXml(xml, ctx) {
  const cfg = { ...DEFAULTS, ...(ctx.config || {}) };
  ctx.config = cfg;

  // 1) 切出 item / entry 区块，限制数量，超出部分原样保留
  const blockRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  const blocks = [];
  let m;
  while ((m = blockRe.exec(xml)) !== null && blocks.length < cfg.maxItems) {
    blocks.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }

  const head =
    blocks.length > 0 ? xml.slice(0, blocks[0].start) : xml;
  const tail = blocks.length > 0 ? xml.slice(blocks[blocks.length - 1].end) : '';

  // 2) 收集文本（头部 + 各区块）
  const texts = new Set(collectTexts(head, cfg));
  for (const b of blocks) {
    for (const t of collectTexts(b.text, cfg)) texts.add(t);
  }

  // 3) 翻译
  const map = await translateTexts([...texts], ctx);

  // 4) 重建文档
  let newHead = head;
  for (const tag of targetTags(cfg)) {
    newHead = newHead.replace(tagRegex(tag), (mm, attrs, inner) => {
      const text = normalizeTagContent(inner, cfg);
      const translated = text ? map.get(text) : null;
      if (!translated) return mm;
      const isCdata = /^\s*<!\[CDATA\[/.test(inner);
      const body = isCdata
        ? '<![CDATA[' + cdataSafe(translated) + ']]>'
        : escapeXml(translated);
      return '<' + tag + (attrs || '') + '>' + body + '</' + tag + '>';
    });
  }

  const newBlocks = blocks.map((b) => applyToBlock(b.text, map, cfg));

  return newHead + newBlocks.join('') + tail;
}

function newStats() {
  return { cached: 0, translated: 0, failed: 0 };
}

/* ==================== translate.mjs ==================== */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const CACHE_FILE = path.join(ROOT, 'cache', 'translations.json');
const FEEDS_FILE = path.join(ROOT, 'feeds.txt');
const DEFAULT_FEED = 'https://2chav.com/feed';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const env = process.env;
const FORCE = /^(1|true|yes)$/i.test(env.FORCE || '');
const bool = (v, d) =>
  v === undefined || v === null || v === '' ? d : /^(1|true|yes|on)$/i.test(v);

const config = {
  from: env.FROM_LANG || DEFAULTS.from,
  to: env.TO_LANG || DEFAULTS.to,
  translateTitle: bool(env.TRANSLATE_TITLE, DEFAULTS.translateTitle),
  translateCategories: bool(env.TRANSLATE_CATEGORIES, DEFAULTS.translateCategories),
  translateDescription: bool(env.TRANSLATE_DESCRIPTION, DEFAULTS.translateDescription),
  translateContent: bool(env.TRANSLATE_CONTENT, DEFAULTS.translateContent),
  keepOriginal: bool(env.KEEP_ORIGINAL, DEFAULTS.keepOriginal),
  onlyJapanese: DEFAULTS.onlyJapanese,
  maxCharsPerField: Number(env.MAX_CHARS || DEFAULTS.maxCharsPerField),
  maxItems: Number(env.MAX_ITEMS || DEFAULTS.maxItems),
  concurrency: Number(env.CONCURRENCY || DEFAULTS.concurrency),
  translationTtl: Number(env.TRANSLATION_TTL_DAYS || 30) * 86400,
};

const translators = (env.TRANSLATORS || DEFAULT_ORDER.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/* ------------------------------ feeds.txt ------------------------------ */

function parseFeeds(text) {
  const list = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const url = parts[0];
    if (!/^https?:\/\//i.test(url)) continue;
    list.push({ url, name: parts[1] || '' });
  }
  return list;
}

async function readFeeds() {
  if (!existsSync(FEEDS_FILE)) {
    const seed =
      '# 每行一个订阅源；行尾可加空格 + 自定义文件名（英文），# 开头为注释\n' +
      DEFAULT_FEED;
    await writeFile(FEEDS_FILE, seed, 'utf8');
    console.log('[feeds] 未找到 feeds.txt，已自动创建并填入默认源：' + DEFAULT_FEED);
  }
  const list = parseFeeds(await readFile(FEEDS_FILE, 'utf8'));
  if (list.length === 0) throw new Error('feeds.txt 中没有有效的 http(s) 订阅源');
  return list;
}

function safeName(s) {
  return (
    String(s)
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'feed'
  );
}

// 常见后缀，生成文件名时去掉，避免 2chav.com 变成 2chav-com
const COMMON_TLD = new Set([
  'com', 'net', 'org', 'jp', 'cn', 'io', 'co', 'me', 'info',
  'tv', 'cc', 'xyz', 'blog', 'news', 'dev', 'app', 'rss',
]);

function pickFileName(entry, index, used) {
  let base;
  if (entry.name) {
    base = safeName(entry.name);
  } else {
    try {
      let host = new URL(entry.url).hostname.replace(/^www\./, '').toLowerCase();
      const parts = host.split('.');
      if (parts.length > 1 && COMMON_TLD.has(parts[parts.length - 1])) parts.pop();
      base = safeName(parts.join('-'));
    } catch {
      base = 'feed';
    }
  }
  let name = base;
  let n = 2;
  while (used.has(name)) name = base + '-' + n++;
  used.add(name);
  return name;
}

/* -------------------------------- 缓存 -------------------------------- */

async function loadCache() {
  try {
    const data = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  const ttl = config.translationTtl * 1000;
  const now = Date.now();
  let kept = 0;
  let dropped = 0;
  for (const [k, v] of Object.entries(cache)) {
    if (v && typeof v === 'object' && v.t && now - v.t > ttl * 3) {
      delete cache[k];
      dropped++;
    } else kept++;
  }
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');
  console.log(`[cache] 保存 ${kept} 条译文，清理过期 ${dropped} 条`);
}

/* ------------------------------- 抓源 -------------------------------- */

async function fetchUpstream(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept:
            'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < 2) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

function extractChannelTitle(xml) {
  const m = /<title(?:\s[^>]*)>([\s\S]*?)<\/title>/i.exec(xml);
  if (!m) return '(无标题)';
  return m[1]
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function countItems(xml) {
  return (xml.match(/<(item|entry)\b/gi) || []).length;
}

/* ------------------------------ index.html ------------------------------ */

function buildIndex(results) {
  // 本地运行时没有 Actions 的环境变量，用占位符而不是空字符串，避免出现坏链接
  const parts = (env.GITHUB_REPOSITORY || '').split('/').filter(Boolean);
  const owner = parts[0] || '你的用户名';
  const repoName = parts[1] || 'rss-zh-mirror';
  const branch = env.GITHUB_REF_NAME || 'main';
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/docs`;
  const pagesBase = `https://${owner.toLowerCase()}.github.io/${repoName}`;

  const cards = results
    .map(
      (r) => `
    <div class="card${r.ok ? '' : ' bad'}">
      <div class="row">
        <div class="title">${escapeHtml(r.title)}</div>
        <div class="tag">${r.ok ? r.items + ' 条' : '失败'}</div>
      </div>
      <div class="src">${escapeHtml(r.url)}</div>
      ${
        r.ok
          ? `
      <div class="linkbox">
        <span class="lab">Pages 地址（推荐）</span>
        <div class="line"><code id="p-${r.file}">${pagesBase}/${r.file}.xml</code><button onclick="cp('p-${r.file}',this)">复制</button></div>
      </div>
      <div class="linkbox">
        <span class="lab">Raw 地址（免设置，立即可用）</span>
        <div class="line"><code id="r-${r.file}">${rawBase}/${r.file}.xml</code><button onclick="cp('r-${r.file}',this)">复制</button></div>
      </div>
      <div class="meta">译文 ${r.stats.translated} 条 · 命中缓存 ${r.stats.cached} 条${
        r.stats.failed ? ' · 失败 ' + r.stats.failed + ' 条' : ''
      }</div>${
        r.stats.translated === 0 && r.stats.cached === 0
          ? `<div class="warn bad2">一条都没译出来，标题仍是原文。多半是免费翻译额度用尽或被限流。
             <br>① 到 Settings → Secrets and variables → Actions → Variables 添加
             <code class="inl">MYMEMORY_EMAIL</code>（填任意邮箱，额度从 5 千提到 5 万字符/天）；
             <br>② 或配置 <code class="inl">LLM_API_KEY</code> 走大模型；
             <br>③ 改完到 Actions 点 Run workflow 重跑。</div>`
          : r.stats.failed > 0
          ? `<div class="warn">有 ${r.stats.failed} 条翻译失败（已保留原文，不影响订阅）。
             通常是额度到了，加个 <code class="inl">MYMEMORY_EMAIL</code> 变量即可。</div>`
          : ''
      }`
          : `<div class="meta err">${escapeHtml(r.error)}</div>`
      }
    </div>`
    )
    .join('\n');

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const okCount = results.filter((r) => r.ok).length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RSS 中文镜像</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--bd:#e5e7eb;--tx:#1f2328;--sub:#6b7280;--ac:#2563eb}
*{box-sizing:border-box}
body{margin:0;padding:32px 16px 64px;background:var(--bg);color:var(--tx);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:22px;margin:0 0 6px}
.sub{color:var(--sub);font-size:13px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px 18px;margin-bottom:14px}
.card.bad{border-color:#f3c2c2}
.row{display:flex;align-items:center;gap:10px;justify-content:space-between}
.title{font-weight:600;font-size:16px}
.tag{font-size:12px;color:var(--sub);background:#f3f4f6;border-radius:20px;padding:2px 10px;white-space:nowrap}
.src{color:var(--sub);font-size:12px;word-break:break-all;margin:4px 0 12px}
.linkbox{margin-top:10px}
.lab{font-size:12px;color:var(--sub)}
.line{display:flex;gap:8px;align-items:center;margin-top:4px}
code{flex:1;background:#f3f4f6;border-radius:6px;padding:7px 10px;font-size:12.5px;
word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace}
button{border:1px solid var(--bd);background:#fff;border-radius:6px;padding:6px 12px;
font-size:12.5px;cursor:pointer;color:var(--tx);white-space:nowrap}
button:hover{border-color:var(--ac);color:var(--ac)}
.meta{margin-top:12px;font-size:12px;color:var(--sub)}
.meta.err{color:#b91c1c}
.warn{margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12.5px;line-height:1.7;
background:#fffbeb;border:1px solid #fde68a;color:#92400e}
.warn.bad2{background:#fef2f2;border-color:#fecaca;color:#991b1b}
.tip{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;
font-size:13px;color:#1e40af;margin-bottom:20px}
h2{font-size:15px;margin:28px 0 10px}
ol{margin:0;padding-left:20px;font-size:13.5px;color:#374151}
ol li{margin-bottom:6px}
code.inl{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:12.5px}
</style>
</head>
<body>
<div class="wrap">
  <h1>RSS 中文镜像</h1>
  <div class="sub">共 ${results.length} 个源，成功 ${okCount} 个 · 最近更新 ${now}</div>

  <div class="tip">
    把下面的地址填进 Read You（订阅 → 添加 → 输入链接）即可。<br>
    <strong>Pages 地址</strong>需要你在仓库 Settings → Pages 里把来源设为 <code class="inl">main / docs</code>；
    <strong>Raw 地址</strong>开箱即用、不用任何设置，但如果 Read You 提示解析失败，请改用 Pages 地址。
  </div>

  ${cards}

  <h2>怎么加更多源？</h2>
  <ol>
    <li>打开仓库里的 <code class="inl">feeds.txt</code>，点右上角铅笔图标编辑</li>
    <li>每行粘贴一个 RSS 地址（<code class="inl">#</code> 开头的行为注释）</li>
    <li>提交后到 Actions → 翻译 RSS → Run workflow，约 1 分钟生效</li>
  </ol>

  <h2>自动更新</h2>
  <ol>
    <li>默认每小时第 17 分钟自动跑一次（GitHub 可能延迟几分钟）</li>
    <li>公开仓库完全免费；私有仓库的定时会被 GitHub 在闲置 60 天后停用</li>
  </ol>
</div>
<script>
function cp(id, btn){
  var t=document.getElementById(id).textContent;
  navigator.clipboard.writeText(t).then(function(){
    var o=btn.textContent; btn.textContent='已复制'; btn.style.color='#16a34a';
    setTimeout(function(){btn.textContent=o; btn.style.color='';},1500);
  });
}
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/* -------------------------------- 主流程 ------------------------------- */

async function main() {
  const feeds = await readFeeds();
  const disk = await loadCache(); // 磁盘上的历史译文
  const fresh = {}; // 本次新译的，最后合并回磁盘
  const translate = makeTranslator(translators, env);
  const usedNames = new Set();
  const results = [];

  await mkdir(DOCS, { recursive: true });
  console.log(`[start] ${feeds.length} 个源 | 引擎顺序：${translators.join(' → ')}`);
  if (FORCE) console.log('[start] FORCE 模式：忽略已有译文缓存');

  for (let i = 0; i < feeds.length; i++) {
    const entry = feeds[i];
    const file = pickFileName(entry, i, usedNames);
    const stats = newStats();
    const errors = [];
    console.log(`\n[${i + 1}/${feeds.length}] ${entry.url}`);

    try {
      const xml = await fetchUpstream(entry.url);
      console.log(`  抓取 ${xml.length} bytes`);

      const translated = await translateFeedXml(xml, {
        config,
        stats,
        errors,
        translate,
        // FORCE 时只忽略磁盘上的旧译文，但新译文仍会写回磁盘，
        // 否则一次 force 就会把积累的缓存清空，下次整份重翻、白烧额度。
        cacheGet: async (k) => (FORCE ? null : (disk[k]?.v ?? null)),
        cachePut: async (k, v) => {
          fresh[k] = { v, t: Date.now() };
        },
      });

      await writeFile(path.join(DOCS, file + '.xml'), translated, 'utf8');
      console.log(
        `  翻译 ${stats.translated} / 缓存 ${stats.cached} / 失败 ${stats.failed}`
      );
      if (errors.length) console.log('  错误样本：' + errors.slice(0, 2).join(' ; '));

      results.push({
        ok: true,
        file,
        url: entry.url,
        title: extractChannelTitle(translated),
        items: countItems(translated),
        stats,
      });
    } catch (err) {
      console.log('  失败：' + err.message);
      results.push({ ok: false, file, url: entry.url, title: entry.url, error: err.message });
    }
  }

  await writeFile(path.join(DOCS, 'index.html'), buildIndex(results), 'utf8');
  await saveCache({ ...disk, ...fresh });

  const ok = results.filter((r) => r.ok).length;
  const t = results.reduce((a, r) => a + (r.stats?.translated || 0), 0);
  const c = results.reduce((a, r) => a + (r.stats?.cached || 0), 0);
  const f = results.reduce((a, r) => a + (r.stats?.failed || 0), 0);
  console.log(`\n[done] 成功 ${ok}/${results.length} | 新译 ${t} | 缓存 ${c} | 失败 ${f}`);

  if (env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## 翻译结果',
      '',
      `成功 **${ok}/${results.length}** 个源 · 新译 ${t} 条 · 命中缓存 ${c} 条 · 失败 ${f} 条`,
      '',
      '| 订阅源 | 输出文件 | 结果 |',
      '| --- | --- | --- |',
      ...results.map(
        (r) =>
          `| ${r.title} | \`${r.file}.xml\` | ${
            r.ok ? `${r.items} 条，新译 ${r.stats.translated}` : '失败：' + r.error
          } |`
      ),
    ];
    await writeFile(env.GITHUB_STEP_SUMMARY, lines.join('\n'), 'utf8');
  }

  if (ok === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
