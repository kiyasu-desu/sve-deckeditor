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
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; }
  replaceChildren(...cs) { this.children = []; cs.forEach((c) => this.appendChild(c)); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  closest() { return null; }
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

const need = ['qtyCount', 'closeQtyCard', 'attachQtyOverlay', 'openQtyCard', 'restoreQtyCard'];
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
  `${need.map(pick).join('\n')}
   return { qtyCount, closeQtyCard, attachQtyOverlay, openQtyCard, restoreQtyCard,
            get openCardEl(){return openCardEl}, get openCardData(){return openCardData},
            setGrid(g){ grid = g; } };`.replace(/function (\w+)/g, 'function $1'),
);
// 用闭包内的 openCardEl 变量名，需在函数体内可访问
const api = factory(LIMIT, sideOf, state, toast, addCard, $);

const card = { sid: 2747, id: 'BP09-T03SC', name: '妖精', evo: '', cost: 1 };

let pass = 0;
const check = (name, cond) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}`); if (cond) pass += 1; };

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

console.log(`\n${pass}/7 项通过`);
