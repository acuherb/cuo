import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createServer, resolveStatic, isSameOrigin } from '../server.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* 用最小 DOM stub 执行内联脚本，取出纯逻辑函数；阻止 init() 自启动 */
function loadCore(){
  const el = () => ({
    innerHTML: '', hidden: false, value: '', checked: false, textContent: '', style: {},
    classList: { add(){}, remove(){}, toggle(){} },
    setAttribute(){}, addEventListener(){}, appendChild(){}, removeChild(){},
    querySelectorAll(){ return []; }, scrollIntoView(){}, remove(){},
  });
  const ctx = {
    document: {
      querySelector: () => el(),
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => el(),
      body: { insertAdjacentHTML(){} },
    },
    window: {},
    location: { protocol: 'http:', href: 'http://127.0.0.1:8080/index.html' },
    navigator: {},
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    indexedDB: { open(){ return {}; } },
    console, setTimeout, clearTimeout, URL, Blob,
    Image: class {}, FileReader: class {},
    atob, btoa, confirm: () => true,
    fetch: async () => { throw new Error('测试中不发起网络请求'); },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const code = script.replace(/init\(\)\.catch\([\s\S]*?\n\}\);\s*$/, '');
  const expose = `
;globalThis.__core = { esc, clamp, parseJSONSafe, mastery, isTodo, nextSchedule,
  normalizeBox, normalizeQuestion, validateBackup, waitForImages, settings, INTERVALS,
  loadSettings, refreshAIUI, switchView, applyKeyboardBox };`;
  vm.runInContext(code + expose, ctx);
  return ctx.__core;
}

const core = loadCore();

test('HTML 转义与 JSON 容错解析', () => {
  assert.equal(core.esc('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
  assert.equal(core.esc(null), '');
  /* vm realm 的对象与主 realm 原型不同，用属性断言避免跨 realm 深比较 */
  assert.equal(core.parseJSONSafe('```json\n{"a":1}\n```').a, 1);
  assert.equal(core.parseJSONSafe('说明 {"a":2} 结束').a, 2);
  assert.throws(() => core.parseJSONSafe(''));
  assert.equal(core.clamp(9, 0, 1), 1);
});

test('间隔复习算法与掌握度', () => {
  assert.equal(core.mastery({ level: 3 }), 50);
  assert.equal(core.INTERVALS.length, 7);
  assert.equal(core.isTodo({ level: 1 }), true);
  assert.equal(core.isTodo({ level: 2 }), false);

  const easy = core.nextSchedule({ level: 2, reviewCount: 1, lapses: 0 }, 'easy');
  assert.equal(easy.level, 3);
  assert.equal(easy.reviewCount, 2);
  assert.ok(easy.dueAt > Date.now());

  const hard = core.nextSchedule({ level: 2 }, 'hard');
  assert.equal(hard.level, 2);

  const forgot = core.nextSchedule({ level: 5 }, 'forgot');
  assert.equal(forgot.level, 0);

  const wrong = core.nextSchedule({ level: 5, lapses: 2 }, 'wrong');
  assert.equal(wrong.level, 0);
  assert.equal(wrong.lapses, 3);
});

test('题目规范化补齐缺省字段并约束取值', () => {
  const q = core.normalizeQuestion({
    id: 'q1', imageId: 'i1', box: { x: -0.2, y: 0.1, w: 2, h: 0.3 },
    cause: '不存在的错因', level: 99,
  });
  assert.equal(q.box.x, 0);
  assert.equal(q.box.w, 1);
  assert.equal(q.cause, '知识缺口');
  assert.equal(q.knowledge, '未标注');
  assert.equal(q.level, core.INTERVALS.length - 1);
  assert.ok(q.dueAt > 0);
  assert.equal(q.reviewCount, 0);

  assert.throws(() => core.normalizeQuestion({ id: 'q', imageId: 'i', box: { w: 0, h: 0 } }));
  assert.throws(() => core.normalizeQuestion({ id: '', imageId: 'i', box: { w: 1, h: 1 } }));
});

test('备份导入校验', () => {
  const dataUrl = 'data:image/jpeg;base64,/9j/AAA';
  const backup = core.validateBackup({
    version: 2,
    images: [{ id: 'i1', w: 100, h: 200, data: dataUrl }],
    questions: [{ id: 'q1', imageId: 'i1', box: { x: 0, y: 0, w: 0.5, h: 0.2 } }],
  });
  assert.equal(backup.version, 2);
  assert.equal(backup.questions[0].knowledge, '未标注');

  assert.throws(() => core.validateBackup(null), /对象/);
  assert.throws(() => core.validateBackup({ images: [] }), /数组/);
  assert.throws(() => core.validateBackup({ version: 99, images: [], questions: [] }), /过新/);
  assert.throws(() => core.validateBackup({ images: [{ id: 'i', data: 'not-a-data-url' }], questions: [] }), /图片记录/);
  assert.throws(() => core.validateBackup({ images: [], questions: [{ id: 'q' }] }), /id/);
});

test('打印前等待图片完成', async () => {
  let loaded = false;
  const root = {
    querySelectorAll: () => [
      { complete: true },
      { complete: false, addEventListener: (ev, fn) => { if (ev === 'load') { loaded = true; setTimeout(fn, 0); } } },
    ],
  };
  await core.waitForImages(root, 200);
  assert.equal(loaded, true);
});

test('HTML 关键安全与功能约束', () => {
  assert.doesNotMatch(html, /sk-[A-Za-z0-9]{16,}/, '页面里不能出现硬编码密钥');
  assert.match(html, /\[hidden\]\{display:none!important\}/, 'hidden 必须能覆盖组件 display');
  assert.ok(html.indexOf('await waitForImages(area)') < html.indexOf('window.print()'), '打印前必须等图片');
  assert.match(html, /mode === 'self'[\s\S]{0,600}printAnswers/, '自测卷答案必须单独成页');
  assert.match(html, /class AICancelled/, 'AI 请求必须可取消');
  assert.match(html, /AI_TIMEOUT_MS = 60_000/, 'AI 请求必须有超时');
  assert.match(html, /DB_VER = 2/, '数据库必须带迁移版本');
  assert.match(html, /validateBackup\(/, '导入必须校验备份');
  assert.match(html, /aiJudge\(q,/, 'AI 判分必须被真正调用');
  assert.match(html, /navigator\.serviceWorker\.register/, '必须注册离线缓存');
  assert.doesNotMatch(html, /localStorage\.setItem\(SETTINGS_KEY, JSON\.stringify\(settings\)\)/, '设置里不得再明文存密钥');
  assert.match(html, /role="tablist"/, '导航需有 tablist 语义');

  /* 脚本里引用的所有元素 ID 都必须真实存在，且不能重复，避免初始化后静默报错 */
  const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'HTML 的 id 不能重复');
  const used = [...new Set([...script.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]))];
  const missing = used.filter(id => !htmlIds.includes(id));
  assert.deepEqual(missing, [], `脚本引用了不存在的元素：${missing.join(', ')}`);
});

test('设置加载、视图切换与键盘框选在最小 DOM 下不报错', () => {
  assert.doesNotThrow(() => core.loadSettings());
  assert.equal(core.settings.aiMode, 'proxy');
  assert.doesNotThrow(() => core.refreshAIUI());
  assert.doesNotThrow(() => core.applyKeyboardBox());
  for (const view of ['capture', 'bank', 'review', 'stats', 'paper', 'settings']) {
    assert.doesNotThrow(() => core.switchView(view), `切换到 ${view} 不应报错`);
  }
});

test('服务端静态路径白名单', () => {
  assert.deepEqual(resolveStatic('/'), ['index.html', 'text/html; charset=utf-8']);
  assert.ok(resolveStatic('/index.html'));
  assert.ok(resolveStatic('/sw.js'));
  assert.equal(resolveStatic('/../cuo-key.md'), null);
  assert.equal(resolveStatic('/%2e%2e/cuo-key.md'), null);
  assert.equal(resolveStatic('/.git/config'), null);
  assert.equal(resolveStatic('/api/deepseek'), null);
  assert.equal(resolveStatic('index.html'), null);
});

test('服务端拒绝跨源调用', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:8080' } }), true);
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' } }), true);
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:8080', origin: 'https://evil.example' } }), false);
});

test('服务端接口冒烟', async t => {
  const prevKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const server = createServer();
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  t.after(() => {
    server.close();
    if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /错题舱/);

  assert.equal((await fetch(base + '/cuo-key.md')).status, 404);
  assert.equal((await fetch(base + '/.git/config')).status, 404);

  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.ai.configured, false);

  const noKey = await fetch(base + '/api/deepseek', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(noKey.status, 503);
  assert.match((await noKey.json()).error.message, /DEEPSEEK_API_KEY/);

  const badOrigin = await fetch(base + '/api/deepseek', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(badOrigin.status, 403);
});
