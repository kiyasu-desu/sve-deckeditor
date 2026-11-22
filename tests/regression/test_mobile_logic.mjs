/**
 * 移动端交互逻辑核验：在 Node 里模拟 DOM，跑通「点卡片 → 浮层 → 增减」的流程。
 * 目的：在不启动浏览器的情况下验证浮层的状态机与边界条件。
 */
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');

// ---- 极简 DOM 桩，够跑通浮层逻辑 ----
class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this._cls = new Set();
    this._html = '';
    this._text = '';
    this.listeners = {};
    this.style = {};
    this.classList = {
      add: (...c) => c.forEach((x) => this._cls.add(x)),
      remove: (...c) => c.forEach((x) => this._cls.delete(x)),
      contains: (c) => this._cls.has(c),
      toggle: (c, on) => { if (on === undefined) { this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c); } else if (on) this._cls.add(c); else this._cls.delete(c); },
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    const tagRe = /<([a-zA-Z0-9]+)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    for (const m of this._html.matchAll(tagRe)) {
      const child = new El(m[1]);
      const attrs = m[2];
      const clsMatch = attrs.match(/\bclass="([^"]*)"/);
      if (clsMatch) child.className = clsMatch[1];
      for (const dm of attrs.matchAll(/\bdata-([a-zA-Z0-9-]+)="([^"]*)"/g)) {
        child.dataset[dm[1]] = dm[2];
      }
      child.textContent = m[3];
      this.appendChild(child);
    }
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; }
  replaceChildren(...cs) { this.children = []; cs.forEach((c) => this.appendChild(c)); }
  matches(sel) {
    const m = sel.trim().match(/^(?:([a-zA-Z0-9_-]+))?(?:\.([a-zA-Z0-9_-]+))?(?:\[data-([a-zA-Z0-9_-]+)="([^"]*)"\])?$/);
    if (!m || !m[0]) return false;
    const [, tag, cls, dataKey, dataVal] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (cls && !this.classList.contains(cls)) return false;
    if (dataKey !== undefined && String(this.dataset[dataKey]) !== dataVal) return false;
    return true;
  }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return [];
    const findPart = (root, part) => {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.matches(part)) out.push(c);
          walk(c);
        }
      };
      walk(root);
      return out;
    };
    let matches = findPart(this, parts[0]);
    for (let i = 1; i < parts.length; i += 1) {
      const next = [];
      const seen = new Set();
      for (const m of matches) {
        for (const hit of findPart(m, parts[i])) {
          if (!seen.has(hit)) { seen.add(hit); next.push(hit); }
        }
      }
      matches = next;
    }
    return matches;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, ev = {}) {
    let stopped = false;
    const event = Object.assign({
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() { stopped = true; },
    }, ev);
    let node = this;
    while (node && !stopped) {
      event.currentTarget = node;
      for (const fn of (node.listeners[type] || []).slice()) {
        fn.call(node, event);
      }
      node = node.parentNode;
    }
    return event;
  }
  setAttribute() {}
  removeAttribute() {}
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}
global.document = {
  createElement: (t) => new El(t),
  createDocumentFragment: () => new El('frag'),
  addEventListener: () => {},
  body: new El('body'),
};
global.window = { addEventListener: () => {} };
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node', maxTouchPoints: 0 },
  configurable: true,
  writable: true,
});
global.matchMedia = () => ({ matches: false });
global.location = { protocol: 'http:', hostname: '127.0.0.1' };

// ---- 抽出被测函数 ----
const pick = (name) => {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`);
  const m = app.match(re);
  return m ? m[0] : null;
};

const need = ['qtyCount', 'closeQtyCard', 'attachQtyOverlay', 'openQtyCard', 'restoreQtyCard', 'refreshQtyCard'];
const missing = need.filter((n) => !pick(n));
if (missing.length) { console.error('未抽到函数:', missing); process.exit(1); }
console.log('已从 app.js 抽出:', need.join(', '), '\n');

// 用真实 state 结构 + 最小依赖拼装执行环境
const LIMIT = { basicMin: 40, basicMax: 50, evoMin: 0, evoMax: 10, per: 3 };
const sideOf = (c) => (c.evo === '进化' ? 'evo' : 'basic');
const state = { deck: { basic: {}, evo: {} }, side: 'basic' };
const toast = () => {};
const addCard = (c, d) => {
  const s = state.side;
  const cur = state.deck[s][c.sid] || 0;
  if (d > 0 && cur >= LIMIT.per) return;
  if (d < 0 && cur <= 0) return;
  if (d < 0 && cur === 1) delete state.deck[s][c.sid];
  else state.deck[s][c.sid] = cur + d;
};
let grid = new El('div');
const $ = (id) => (id === 'grid' ? grid : new El('div'));
const openCardRef = { el: null, data: null };

const factory = new Function(
  'LIMIT', 'sideOf', 'state', 'toast', 'addCard', '$',
  `let openCardEl = null;\nlet openCardData = null;\n${need.map(pick).join('\n')}
   return { qtyCount, closeQtyCard, attachQtyOverlay, openQtyCard, restoreQtyCard, refreshQtyCard,
            get openCardEl(){return openCardEl}, get openCardData(){return openCardData},
            setGrid(g){ grid = g; } };`,
);
// 用闭包内的 openCardEl 变量名，需在函数体内可访问
const api = factory(LIMIT, sideOf, state, toast, addCard, $);

const card = { sid: 2747, id: 'BP09-T03SC', name: '妖精', evo: '', cost: 1 };

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}`);
  if (cond) pass += 1; else fail += 1;
};

// 1. 初始计数为 0
check('初始数量为 0', api.qtyCount(card) === 0);

// 2. 挂浮层
const el = new El('div');
el.className = 'card';
api.attachQtyOverlay(el, card);
check('浮层已挂到卡片上', el.children.length === 1 && el.children[0].classList.contains('qty-overlay'));
check('卡片带 qty-open 类', el.classList.contains('qty-open'));
check('浮层含增减两个按钮', (el.children[0].innerHTML.match(/qty-b/g) || []).length === 2);
check('浮层显示数量', /class="qty-n">0</.test(el.children[0].innerHTML));

// 3. 关闭
api.closeQtyCard();
check('关闭后移除 qty-open', !el.classList.contains('qty-open'));

// 4. 上限 3
state.deck.basic[card.sid] = 3;
check('满 3 张时计数正确', api.qtyCount(card) === 3);
state.deck.basic = {};

// 5. 在卡池网格内展开浮层并点击 + / -（不重绘网格）
el.dataset.sid = String(card.sid);
grid.appendChild(el);
api.openQtyCard(el, card);
const numText = (cardEl) => cardEl.querySelector('.qty-overlay .qty-n')?.textContent;
check('openQtyCard 展开浮层且初始数字为 0', api.openCardEl === el && numText(el) === '0');

const clickBtn = (cardEl, q) => {
  const btn = cardEl.querySelectorAll('.qty-b').find((b) => String(b.dataset.q) === String(q));
  btn?.dispatch('click');
};

clickBtn(el, 1);
check('点 + 后卡组数为 1、保持原卡片元素且数字刷新为 1',
  state.deck.basic[card.sid] === 1 && api.openCardEl === el && numText(el) === '1');

clickBtn(el, 1);
check('再点 + 后数字刷新为 2', state.deck.basic[card.sid] === 2 && numText(el) === '2');

clickBtn(el, 1);
check('第三次点 + 后数字刷新为 3', state.deck.basic[card.sid] === 3 && numText(el) === '3');

clickBtn(el, 1);
check('达到上限 3 后再点 + 仍保持为 3', state.deck.basic[card.sid] === 3 && numText(el) === '3');

clickBtn(el, -1);
check('点 - 后卡组数减为 2 且数字刷新为 2', state.deck.basic[card.sid] === 2 && numText(el) === '2');

// 6. 网格节点重建后 restoreQtyCard 挂回浮层并保留数量
grid.replaceChildren();
const el2 = new El('div');
el2.className = 'card';
el2.dataset.sid = String(card.sid);
grid.appendChild(el2);
api.restoreQtyCard();
check('节点重建后 restoreQtyCard 将浮层挂回新节点且数字为 2',
  api.openCardEl === el2 && el2.classList.contains('qty-open') && numText(el2) === '2');

console.log(`\n${pass}/${pass + fail} 项通过`);
if (fail) process.exitCode = 1;
