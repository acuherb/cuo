/**
 * 错题舱本地服务（零依赖）。
 * 1) 托管静态文件（严格白名单，避免把密钥、备份、.git 暴露出去）
 * 2) 提供 /api/deepseek 代理：API Key 只存在于服务端环境变量，永不下发到浏览器
 * 启动：DEEPSEEK_API_KEY=sk-xxx npm start   或   npm start 后用「直连模式」
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 12 * 1024 * 1024;
const AI_TIMEOUT_MS = 90_000;

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/README.md', ['README.md', 'text/markdown; charset=utf-8']],
]);

/** 只解析白名单路径；任何路径穿越、未知文件都返回 null */
export function resolveStatic(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (!p.startsWith('/')) return null;
  return STATIC_FILES.get(p) || null;
}

/** 拒绝把本机代理当成任意网站的免费转发器 */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host || '');
  } catch {
    return false;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error('请求体过大（上限 12MB）');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleAI(req, res) {
  if (!isSameOrigin(req)) return send(res, 403, { error: { message: '跨源请求被拒绝' } });

  const key = process.env.DEEPSEEK_API_KEY || '';
  if (!key) {
    return send(res, 503, {
      error: { message: '服务端未配置 DEEPSEEK_API_KEY。请设置环境变量后重启服务，或在「设置」里切换为直连模式。' },
    });
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
    if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) {
      throw new Error('缺少 messages');
    }
  } catch (err) {
    return send(res, err.status || 400, { error: { message: '无效请求：' + err.message } });
  }

  // 白名单转发字段：不把浏览器提交的任何额外字段透传给上游
  const safe = {
    model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : 'deepseek-flash',
    messages: payload.messages,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.1,
    max_tokens: Math.min(Math.max(Number(payload.max_tokens) || 1200, 1), 4096),
    stream: false,
  };
  if (payload.response_format?.type === 'json_object') safe.response_format = { type: 'json_object' };

  const base = (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
  try {
    const upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(safe),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      let detail = '';
      try { detail = JSON.parse(text)?.error?.message || ''; } catch { /* 非 JSON 响应 */ }
      return send(res, upstream.status, {
        error: { message: `DeepSeek 请求失败 ${upstream.status}${detail ? '：' + detail : ''}` },
      });
    }
    return send(res, 200, text);
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return send(res, timeout ? 504 : 502, {
      error: { message: timeout ? '上游请求超时，请稍后重试' : '无法连接上游服务：' + err.message },
    });
  }
}

async function handleStatic(res, pathname) {
  const hit = resolveStatic(pathname);
  if (!hit) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  try {
    const buf = await readFile(path.join(ROOT, hit[0]));
    return send(res, 200, buf, hit[1]);
  } catch {
    return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, ai: { configured: Boolean(process.env.DEEPSEEK_API_KEY) } });
      }
      if (url.pathname === '/api/deepseek') {
        if (req.method !== 'POST') return send(res, 405, { error: { message: '仅支持 POST' } });
        return await handleAI(req, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { error: { message: '不支持的请求方法' } });
      }
      return await handleStatic(res, url.pathname);
    } catch (err) {
      return send(res, 500, { error: { message: '服务端错误：' + err.message } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  createServer().listen(PORT, HOST, () => {
    console.log(`错题舱已启动：http://${HOST}:${PORT}/`);
    console.log(process.env.DEEPSEEK_API_KEY
      ? 'AI 代理：已配置 DEEPSEEK_API_KEY（推荐在「设置」中使用代理模式）'
      : 'AI 代理：未配置密钥；可在「设置」中使用直连模式，或设置 DEEPSEEK_API_KEY 后重启');
  });
}
