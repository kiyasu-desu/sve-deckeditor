/**
 * 运行时验证：在 Node 里搭一个最小 DOM，真正执行 app.js 的 boot() 流程。
 * 目的：捕获静态检查发现不了的运行时错误（未定义函数、错误的 API 用法等）。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

// ---------------- 最小 DOM ----------------
class ClassList {
  constructor(el) { this.el = el; this.s = new Set(); }
  add(...c) { c.forEach((x) => x && this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  contains(c) { return this.s.has(c); }
  toggle(c, on) {
    if (on === undefined) { this.s.has(c) ? this.s.delete(c) : this.s.add(c); return this.s.has(c); }
    on ? this.s.add(c) : this.s.delete(c);
    return on;
  }
  get value() { return [...this.s].join(' '); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.classList = new ClassList(this);
    this.style = {};
    this.attrs = {};
    this._text = '';
    this._html = '';
    this.listeners = {};
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.readOnly = false;
    this.files = [];
    // 布局相关的桩
    this.clientWidth = 1200;
    this.clientHeight = 800;
    this.scrollTop = 0;
  }
  get className() { return this.classList.value; }
  set className(v) { this.classList.s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  appendChild(c) { if (!c) return c; c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  prepend(c) { c.parentNode = this; this.children.unshift(c); return c; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
    this.parentNode = null;
  }
  replaceWith(n) {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) { n.parentNode = this.parentNode; this.parentNode.children[i] = n; }
  }
  replaceChildren(...cs) { this.children = []; cs.forEach((c) => { if (c && c.tagName === 'FRAGMENT') c.children.forEach((x) => this.appendChild(x)); else this.appendChild(c); }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    if (this.listeners[t]) this.listeners[t] = this.listeners[t].filter((f) => f !== fn);
  }
  dispatch(type, ev) {
    const e = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {}, closest: () => null }, ev);
    (this.listeners[type] || []).forEach((f) => f(e));
  }
  closest(sel) {
    const cls = sel.replace(/^\./, '');
    let n = this;
    while (n) { if (n.classList && n.classList.contains(cls)) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) {
    const cls = sel.replace(/^\./, '').replace(/\[.*\]$/, '');
    const walk = (n) => {
      for (const c of n.children) {
        if (c.classList && c.classList.contains(cls)) return c;
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '').replace(/\[.*\]$/, '');
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.classList && c.classList.contains(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  focus() {}
  select() {}
  click() { this.dispatch('click'); }
  getBoundingClientRect() { return { x: 0, y: 0, width: 128, height: 178, top: 0, left: 0, right: 128, bottom: 178 }; }
  getContext() {
    return {
      fillRect() {}, drawImage() {}, fillStyle: '', font: '', fillText() {},
      clearRect() {}, save() {}, restore() {}, translate() {}, scale() {},
    };
  }
  toBlob(cb) { cb(null); }
}

// 按 id 登记的元素：直接从 index.html 解析，避免手工维护清单
const byId = new Map();
const htmlSrc = fs.readFileSync('index.html', 'utf8');
const IDS = [...new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))];
for (const id of IDS) {
  const el = new El(id.startsWith('btn') || id.startsWith('wiz') && id !== 'wizard' ? 'button' : 'div');
  el.id = id;
  if (id === 'modalText') { el.tagName = 'TEXTAREA'; }
  if (id === 'deckName' || id === 'fText' || id === 'fTroopSearch') { el.tagName = 'INPUT'; }
  byId.set(id, el);
}

const documentStub = {
  body: new El('body'),
  head: new El('head'),
  documentElement: new El('html'),
  createElement: (t) => new El(t),
  createDocumentFragment: () => new El('fragment'),
  getElementById: (id) => byId.get(id) || null,
  querySelector: (sel) => (sel.startsWith('#') ? byId.get(sel.slice(1)) || null : null),
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  readyState: 'complete',
  hidden: false,
  title: '',
};
documentStub.body.classList.add('x');   // 确保 body.classList 可用

// ---------------- 其他浏览器 API ----------------
const storage = new Map();
const localStorageStub = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
  get length() { return storage.size; },
};

const objectUrls = [];
const URLStub = {
  createObjectURL: (b) => { const u = `blob:stub/${objectUrls.length}`; objectUrls.push({ u, b }); return u; },
  revokeObjectURL: () => {},
};

let ioCount = 0;
class IntersectionObserverStub {
  constructor(cb) { this.cb = cb; ioCount += 1; }
  observe(el) {
    // 立刻视为进入视口，触发懒加载
    setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 0);
  }
  disconnect() {}
  unobserve() {}
}

const sandbox = {
  document: documentStub,
  localStorage: localStorageStub,
  sessionStorage: localStorageStub,
  navigator: { userAgent: 'node-harness', maxTouchPoints: 0, onLine: true },
  location: { protocol: 'http:', hostname: '127.0.0.1', href: 'http://127.0.0.1:8199/', search: '', hash: '' },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  IntersectionObserver: IntersectionObserverStub,
  URL: URLStub,
  Blob: class Blob { constructor(parts, opts) { this.parts = parts; this.type = (opts || {}).type || ''; this.size = (parts || []).reduce((s, p) => s + (p.length || p.byteLength || 0), 0); } },
  Response: class Response { constructor(b, o) { this.body = b; this.headers = (o || {}).headers || {}; } },
  Request: class Request { constructor(u) { this.url = u; } },
  caches: undefined,                      // 模拟非安全上下文：代码应能降级
  atob,
  btoa,
  TextDecoder,
  TextEncoder,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  console,
  fetch: (...a) => fetch(...a),
  Image: class Image { constructor() { this.onload = null; this.onerror = null; } set src(v) { this._src = v; } get src() { return this._src; } },
  performance: { now: () => Date.now() },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  alert: () => {},
  confirm: () => true,
  prompt: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  devicePixelRatio: 1,
  innerWidth: 1200,
  innerHeight: 800,
  crypto: { randomUUID: () => 'stub-uuid' },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// 让 data/*.json 走本地文件而不是网络
const origFetch = globalThis.fetch;
sandbox.fetch = async (url, opts) => {
  const u = String(url);
  const m = /(?:^|\/)data\/([^?]+)/.exec(u);
  if (m) {
    const p = `data/${m[1]}`;
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), text: async () => buf.toString('utf8'), arrayBuffer: async () => buf };
    }
    return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
  }
  // 图片请求：返回一个最小合法 JPEG 的 base64 包装，模拟 CDN
  return {
    ok: true,
    status: 200,
    text: async () => '152/a/a/' + '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg=',
    arrayBuffer: async () => Buffer.from('152/a/a/' + '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg=', 'ascii'),
  };
};

// ---------------- 预置一个「已选主战者」的卡组 ----------------
// 否则 addCard 会因为没主战者而拒绝，测不到增量更新
storage.set('sve-editor-decks', JSON.stringify([{
  id: 'harness-deck', name: '测试卡组', poolId: 'theme:pcr',
  masterSid: 881, basic: {}, evo: {}, saved: false,
}]));
storage.set('sve-editor-current', 'harness-deck');

// ---------------- 执行 ----------------
const src = fs.readFileSync('app.js', 'utf8');
const ctx = vm.createContext(sandbox);

const errors = [];
const warnings = [];
const origError = console.error;
const origWarn = console.warn;
sandbox.console = {
  log: (...a) => console.log('   [app]', ...a.map(String).join(' ')),
  info: () => {},
  warn: (...a) => warnings.push(a.map(String).join(' ')),
  error: (...a) => errors.push(a.map(String).join(' ')),
  debug: () => {},
};

console.log('执行 app.js ...\n');
let threw = null;
try {
  vm.runInContext(src, ctx, { filename: 'app.js', timeout: 30000 });
} catch (e) {
  threw = e;
}

// 等待异步 boot 完成
await new Promise((r) => setTimeout(r, 1500));

console.log('\n── 结果 ──');
let fail = 0;
const say = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fail += 1; };

say(!threw, `同步执行未抛异常${threw ? `：${threw.message}` : ''}`);
if (threw) console.log('      ' + (threw.stack || '').split('\n').slice(0, 3).join('\n      '));
say(errors.length === 0, `无 console.error${errors.length ? `（${errors.length} 条）` : ''}`);
for (const e of errors.slice(0, 3)) console.log('      ' + e.slice(0, 160));

// boot 后的状态：网格里是否真的渲染出了卡片
const grid = byId.get('grid');
say(grid.children.length > 0, `卡池网格渲染出 ${grid.children.length} 个卡片元素`);

const fCost = byId.get('fCost');
const costN = (fCost.innerHTML.match(/class="chip"/g) || []).length;
say(costN === 8, `费用筛选渲染 ${costN} 个档位（应为 8）`);

const fType = byId.get('fType');
const typeN = (fType.innerHTML.match(/class="chip"/g) || []).length;
say(typeN === 3, `类型筛选渲染 ${typeN} 项（应为 3）`);

// 诊断信息已从界面移除，页面里不应再有这些元素
say(!byId.has('poolHint') && !byId.has('diag') && !byId.has('diag2') && !byId.has('ver'),
  '首页/页头的诊断元素已从 HTML 移除');

// ---------- 增量更新：增删卡牌不应重建网格 ----------
// 这是「所有卡图闪一下重新加载」那个 bug 的回归测试：
// 走真实用户路径（点卡片）触发 addCard，再确认卡片元素还是同一个对象。
console.log('\n── 增量更新（卡图闪烁问题）──');
{
  const target = grid.children.find((el) => el.dataset && el.dataset.sid);
  if (!target) {
    say(false, '网格里没有带 sid 的卡片');
  } else {
    const sid = target.dataset.sid;
    const before = target;
    const beforeCount = grid.children.length;

    target.dispatch('click', { shiftKey: false });

    const after = grid.children.find((el) => el.dataset && el.dataset.sid === sid);
    say(!!after, '点击后卡片仍在网格里');
    say(after === before, '卡片元素是同一个对象（未整体重绘 → 卡图不会闪）');
    say(grid.children.length === beforeCount, `网格元素数不变（${beforeCount} -> ${grid.children.length}）`);

    const cnt = after && after.children.find((x) => x.classList && x.classList.contains('cnt'));
    say(!!cnt && String(cnt.textContent) === '1', `角标更新为 ${cnt ? cnt.textContent : '(无)'}（应为 1）`);

    // 右键（contextmenu）移除一张，角标应消失
    after.dispatch('contextmenu', {});
    const after2 = grid.children.find((el) => el.dataset && el.dataset.sid === sid);
    say(after2 === before, '移除后仍是同一个元素');
    const cnt2 = after2 && after2.children.find((x) => x.classList && x.classList.contains('cnt'));
    say(!cnt2, '角标已移除（回到 0 张）');
  }
}

console.log(`\n${fail === 0 ? '运行时验证通过' : `有 ${fail} 项失败`}`);
process.exitCode = fail ? 1 : 0;
