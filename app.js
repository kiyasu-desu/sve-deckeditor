/**
 * 口袋影之诗 · 卡组编辑器  v3
 *
 * 卡组码算法还原自 app（bundle 内 decryGroupCode / generateGroupCode）：
 *   code = Base64( AES-CBC-Pkcs7( JSON.stringify({
 *            1: 卡池名, 2: 主战者shortId, 3: [基础卡shortId...], 4: [进化卡shortId...]
 *          }), key, iv ) )
 * key/IV 按普通字符串的 UTF-8 字节使用（非 base64 解码），必须用 CryptoJS 复现。
 *
 * v3 变更：新建卡组走「选卡池 → 选主战者 → 组卡」向导；联动主题限定卡盒；卡图走本地代理并带加载诊断。
 */
(function () {
  'use strict';

  const KEY = 'kcrsJtKRaoxBQSaPD1qO/IWKza0AfzLauCv7RgEbPyM=';
  const IV = 'g6rMfAsWbbacxpMyR7wGfA==';
  const VERSION = 'v46';

  // 联动主题 -> 卡盒（已用真实卡组码/card_name 验证）
  const THEME_POOLS = [
    { id: 'uma', name: '赛马娘', boxes: ['CP01', 'CSD01', 'ECP01'] },
    { id: 'imas', name: '灰姑娘女孩', boxes: ['CP02'] },
    { id: 'pcr', name: '公主连结', boxes: ['CP04'] },
  ];

  // 职业 / 主题图标：取自官方包 Resources.assets.game.button.classButtonNN{On,Off}Png
  //   00 中立 · 01 精灵 · 02 皇家护卫 · 03 巫师 · 04 龙族 · 05 梦魇 · 06 主教
  //   07 赛马娘 · 08 灰姑娘女孩 · 09 公主连结
  const POOL_ICON = {
    中立: 0, 精灵: 1, 皇家护卫: 2, 巫师: 3, 龙族: 4, 梦魇: 5, 主教: 6,
    赛马娘: 7, 灰姑娘女孩: 8, 公主连结: 9,
  };
  // 07/08/09 只有 On 图，为统一效果一律用 On 图，未选时靠 CSS 调暗
  const poolIconUrl = (name) => {
    const idx = POOL_ICON[name];
    return idx === undefined ? '' : `icons/classButton${String(idx).padStart(2, '0')}.on.png?v=${VERSION}`;
  };

  // ============================================================ 卡图加载
  // 纯静态方案：浏览器直连网易 CDN 取图，无需后端。
  // CDN 返回的不是图片字节，而是「路径前缀 + base64」文本（如 "152/a/a/iVBORw0KGgo…"），
  // 因此必须在浏览器端剥前缀 → base64 解码 → Blob → 交给 <img>。
  // 解码结果写入 Cache API，二次访问直接命中，不再走网络。
  // 若 CDN 连续失败，自动回退到同源 /img/ 代理（本地开发或自建服务器时可用）。
  const CDN_BASE = 'https://betasystem.gsf.netease.com/';
  const IMG_CACHE_NAME = 'sve-img-v1';
  const IMG_CONCURRENCY = 6;

  let imgCacheStore = null;       // Cache API 句柄（不可用时为 null）
  let imgCdnFails = 0;            // CDN 连续失败次数，超过阈值改走同源代理
  const imgUrlMap = new Map();    // "md5.ext" -> Promise<string>
  let imgRunning = 0;
  const imgQueue = [];

  async function openImgCache() {
    if (imgCacheStore) return imgCacheStore;
    try {
      // Cache API 只在安全上下文可用（https / localhost / 127.0.0.1）
      if (typeof caches !== 'undefined') imgCacheStore = await caches.open(IMG_CACHE_NAME);
    } catch (e) { imgCacheStore = null; }
    return imgCacheStore;
  }

  /** base64 文本 → 真正的图片字节（返回 { bytes, mime } 或 null） */
  function decodeGsfText(txt) {
    const pngAt = txt.indexOf('iVBORw0KGgo');
    const jpgAt = txt.indexOf('/9j/');
    let at = -1;
    let mime = 'image/png';
    if (pngAt >= 0 && (jpgAt < 0 || pngAt < jpgAt)) { at = pngAt; mime = 'image/png'; }
    else if (jpgAt >= 0) { at = jpgAt; mime = 'image/jpeg'; }
    if (at < 0) return null;
    try {
      const b64 = txt.slice(at).replace(/[^A-Za-z0-9+/=]/g, '');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      if (bytes[0] === 0xFF && bytes[1] === 0xD8) mime = 'image/jpeg';
      else if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = 'image/png';
      return { bytes, mime };
    } catch (e) { return null; }
  }

  // 简单的并发闸门，避免 200 张卡同时发请求把连接打满
  function withSlot(fn) {
    return new Promise((resolve) => {
      const run = async () => {
        imgRunning += 1;
        try { resolve(await fn()); } finally {
          imgRunning -= 1;
          const next = imgQueue.shift();
          if (next) next();
        }
      };
      if (imgRunning < IMG_CONCURRENCY) run();
      else imgQueue.push(run);
    });
  }

  /** 取某张卡的可显示 URL；失败返回 ''（调用方负责显示占位） */
  function cardImageUrl(md5, ext) {
    if (!md5) return Promise.resolve('');
    const key = md5 + (ext || '.jpg');
    const hit = imgUrlMap.get(key);
    if (hit) return hit;

    const task = withSlot(async () => {
      const cache = await openImgCache();
      const reqUrl = `${CDN_BASE}${md5}${ext || '.jpg'}`;
      const cacheKey = new Request(reqUrl);

      // 1) Cache API
      if (cache) {
        try {
          const c = await cache.match(cacheKey);
          if (c) return URL.createObjectURL(await c.blob());
        } catch (e) { /* 继续走网络 */ }
      }

      // 2) 网络：默认直连网易 CDN。
      //    本机开发时若 serve.mjs 在跑，优先走同源 /img/ 代理（用本地磁盘缓存，比走公网快）；
      //    CDN 连续失败 3 次也自动切到代理（自建服务器部署时可用）。
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
      const useProxy = location.protocol !== 'file:' && (isLocal || imgCdnFails >= 3);
      const src = useProxy ? `/img/${md5}${ext || '.jpg'}` : `${CDN_BASE}${md5}${ext || '.jpg'}`;
      try {
        const r = await fetch(src);
        if (!r.ok) throw new Error('http ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        let bytes = buf;
        let mime = 'image/jpeg';
        // 同源代理返回的已是解码好的图片；CDN 原始内容是 base64 文本
        if (buf[0] === 0xFF || buf[0] === 0x89) {
          mime = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
        } else {
          const dec = decodeGsfText(new TextDecoder('ascii').decode(buf));
          if (!dec) throw new Error('decode failed');
          bytes = dec.bytes;
          mime = dec.mime;
        }
        if (!useProxy) imgCdnFails = 0;
        const blob = new Blob([bytes], { type: mime });
        if (cache) {
          cache.put(cacheKey, new Response(blob, { headers: { 'content-type': mime } })).catch(() => {});
        }
        return URL.createObjectURL(blob);
      } catch (e) {
        if (!useProxy) imgCdnFails += 1;
        return '';
      }
    });

    // 失败时从表里移除，允许后续重试
    const guarded = task.then((u) => { if (!u) imgUrlMap.delete(key); return u; });
    imgUrlMap.set(key, guarded);
    return guarded;
  }

  /** 把图片挂到 <img> 上（懒加载：进入视口才开始取图） */
  function attachCardImage(img, md5, ext, onFail) {
    const load = async () => {
      const url = await cardImageUrl(md5, ext);
      if (!url) { if (onFail) onFail(); return; }
      img.src = url;
    };
    if (typeof IntersectionObserver === 'undefined') { load(); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { io.disconnect(); load(); return; }
      }
    }, { rootMargin: '300px' });
    io.observe(img);
  }

  // 基础卡组 40~50 张；进化卡组 0~10 张；同名卡（两个分区合计）最多 3 张
  const LIMIT = { basicMin: 40, basicMax: 50, evoMin: 0, evoMax: 10, per: 3 };

  // 费用档位（筛选与费用曲线共用）：1- 表示 1 费及以下，8+ 表示 8 费及以上
  const COST_LABELS = ['1-', '2', '3', '4', '5', '6', '7', '8+'];
  function costBucket(raw) {
    const v = typeof raw === 'number' ? raw : 0;
    if (v <= 1) return COST_LABELS[0];
    if (v >= 8) return COST_LABELS[COST_LABELS.length - 1];
    return COST_LABELS[v - 1];
  }

  const LS_DECKS = 'sve-editor-decks';
  const LS_CUR = 'sve-editor-current';

  const $ = (id) => document.getElementById(id);
  const state = {
    all: [], bySid: new Map(), byId: new Map(),
    cls: [], types: [], rares: [], troops: [], boxes: [],
    clsOptions: [], clsExclusive: false,
    filter: { text: '', costs: new Set(), types: new Set(), troops: new Set(), rares: new Set(), boxes: new Set(), classes: new Set(), troopText: '' },
    side: 'basic',
    deck: null, decks: [],
    wizard: { poolId: null, masterSid: null, mode: 'new' },
    imgOk: 0, imgFail: 0, imgTotal: 0,
    thumbs: {},          // md5 -> base64(webp)：卡图内联，避免浏览器发起图片请求
  };

  // ------------------------------------------------------------ 卡组码
  function encryptDeckCode(obj) {
    return CryptoJS.AES.encrypt(JSON.stringify(obj), CryptoJS.enc.Utf8.parse(KEY), {
      iv: CryptoJS.enc.Utf8.parse(IV), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
    }).toString();
  }
  function decryptDeckCode(code) {
    const norm = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Base64.parse(String(code).trim()));
    const plain = CryptoJS.AES.decrypt(norm, CryptoJS.enc.Utf8.parse(KEY), {
      iv: CryptoJS.enc.Utf8.parse(IV), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
    }).toString(CryptoJS.enc.Utf8);
    if (!plain) throw new Error('解密结果为空（卡组码不正确？）');
    return JSON.parse(plain);
  }

  // ------------------------------------------------------------ 卡池
  function listPools() {
    // 只统计「真正能组进卡组」的卡：基础卡组 + 进化卡组（排除 token / 主战者）
    const stat = (cards) => {
      const bt = cards.filter((c) => sideOf(c) === 'basic');
      const et = cards.filter((c) => sideOf(c) === 'evo');
      return {
        total: bt.length + et.length,
        usable: bt.filter((c) => c.sid).length,
        usableEvo: et.filter((c) => c.sid).length,
        usableAll: bt.filter((c) => c.sid).length + et.filter((c) => c.sid).length,
      };
    };
    const pools = [];
    for (const t of THEME_POOLS) {
      const cards = state.all.filter((c) => t.boxes.includes(c.box));
      pools.push(Object.assign({
        id: 'theme:' + t.id, kind: 'theme', name: t.name,
        sub: t.boxes.join(' / '), cards,
      }, stat(cards)));
    }
    // 职业卡池只按真正的职业生成，中立不作为卡池
    for (const cl of state.cls.filter((c) => c !== '中立')) {
      // 职业卡池 = 该职业 + 中立
      const cards = state.all.filter((c) => c.cls === cl || c.cls === '中立');
      pools.push(Object.assign({
        id: 'cls:' + cl, kind: 'class', name: cl, sub: `${cl} + 中立`, cards,
      }, stat(cards)));
    }
    return pools;
  }

  let POOLS = [];
  function getPool(poolId) { return POOLS.find((p) => p.id === poolId) || null; }
  function poolMatch(poolId, card) {
    const p = getPool(poolId);
    if (!p) return true;
    if (p.kind === 'theme') return THEME_POOLS.find((t) => 'theme:' + t.id === poolId).boxes.includes(card.box);
    const cl = poolId.slice(4);
    return card.cls === cl || card.cls === '中立';
  }
  function poolDisplayName(poolId) {
    const p = getPool(poolId);
    return p ? p.name : (poolId || '—');
  }
  // 卡组码字段1 = 卡池名（app 侧使用的名字）
  function poolCodeName(poolId) {
    const p = getPool(poolId);
    if (!p) return poolId;
    return p.kind === 'theme' ? p.name : p.name;   // 职业卡池直接用职业名（已用「精灵」验证）
  }

  // ------------------------------------------------------------ 工具
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms || 1800);
  }

  // ------------------------------------------------------------ 视图切换
  function showView(name) {
    $('viewHome').classList.toggle('hidden', name !== 'home');
    $('viewEditor').classList.toggle('hidden', name !== 'editor');
    try { localStorage.setItem('sve-view', name); } catch (e) { /* ignore */ }
    if (name === 'home') updateHome();
  }
  function updateHome() {
    const saved = state.decks.filter((d) => d.saved && isDraft(d));
    $('homeDeckCount').textContent = saved.length;
    const d = state.deck;
    const draft = isDraft(d);
    const n = d ? deckCounts(d) : { total: 0 };
    $('homeDeckInfo').textContent = draft
      ? `（编辑中：${d.name} · ${poolDisplayName(d.poolId)} · ${n.total}/50`
        + (d.masterSid ? '' : ' · 未选主战者') + '）'
      : '（暂无编辑中的卡组）';
    // 没有内容时禁用「继续组卡」
    const btn = $('btnResume');
    btn.disabled = !draft;
    btn.title = draft ? `继续编辑「${d.name}」（${n.total}/50）` : '当前没有编辑中的卡组';
    // 没有保存过的卡组时禁用「我的卡组」
    const my = $('btnMyDecks');
    my.disabled = saved.length === 0;
    my.title = saved.length ? `查看已保存的 ${saved.length} 副卡组` : '还没有保存过卡组';
  }
  function updateDiag() {
    const base = `${VERSION} · 图片 ${state.imgOk}/${state.imgTotal}`
      + (state.imgFail ? `（失败 ${state.imgFail}）` : '');
    for (const id of ['diag', 'diag2']) {
      const el = $(id);
      if (!el) continue;
      el.textContent = base;
      el.className = 'diag' + (state.imgFail ? ' bad' : (state.imgOk && state.imgOk === state.imgTotal ? ' ok' : ''));
    }
    scheduleSizeCheck();
  }

  // 尺寸自检：把「卡片/图框/原图」的实际像素尺寸显示出来，便于定位布局问题
  let sizeTimer = null;
  function scheduleSizeCheck() {
    if (sizeTimer || !$('diag2')) return;
    sizeTimer = setTimeout(() => {
      sizeTimer = null;
      const card = document.querySelector('#grid .card');
      const img = card && card.querySelector('img');
      if (!card) return;
      const cr = card.getBoundingClientRect();
      const ir = img ? img.getBoundingClientRect() : null;
      const info = `卡片 ${Math.round(cr.width)}×${Math.round(cr.height)}`
        + (ir ? ` · 图框 ${Math.round(ir.width)}×${Math.round(ir.height)}` : '')
        + (img ? ` · 原图 ${img.naturalWidth}×${img.naturalHeight}` : '')
        + ` · 视口 ${window.innerWidth}×${window.innerHeight} · dpr ${window.devicePixelRatio}`;
      const el = $('diag2');
      if (el) el.textContent = `${VERSION} · ${info}`;
      console.log('[SVE size]', info);
    }, 500);
  }
  // mode: 'input' 可编辑输入框 / 'code' 只读显示（自动全选）/ 'plain' 纯确认框
  function modal(title, desc, text, mode) {
    $('modalTitle').textContent = title;
    $('modalDesc').textContent = desc || '';
    const ta = $('modalText');
    ta.value = text || '';
    const show = mode !== 'plain';
    ta.classList.toggle('hidden', !show);
    ta.readOnly = mode !== 'input';
    // 只读展示时也允许选中复制，因此仍然聚焦并全选
    if (show) { ta.focus(); ta.select(); }
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }
  function newDeck(poolId) {
    return {
      id: 'd' + Date.now().toString(36), name: '新卡组',
      poolId: poolId || 'theme:pcr', masterSid: null,
      basic: {}, evo: {}, saved: false,
    };
  }
  function deckCounts(deck) {
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const basic = sum(deck.basic), evo = sum(deck.evo);
    return { basic, evo, total: basic + evo };
  }

  // ------------------------------------------------------------ 持久化
  // 两个判据，用途不同：
  //   isDraft —— 有内容（≥1 张）：算「编辑中的卡组」，自动保存、下次可继续、列表里可见
  //   isLegal —— 张数达标且已选主战者：才允许导出卡组码
  function isDraft(d) { return !!d && deckCounts(d).total > 0; }
  function isLegal(d) {
    if (!d || !d.masterSid) return false;
    const n = deckCounts(d);
    return n.basic >= LIMIT.basicMin && n.basic <= LIMIT.basicMax
      && n.evo >= LIMIT.evoMin && n.evo <= LIMIT.evoMax;
  }

  function loadStore() {
    try { state.decks = JSON.parse(localStorage.getItem(LS_DECKS) || '[]'); } catch { state.decks = []; }
    state.decks = state.decks.filter((d) => d && d.id);
    // 丢弃历史遗留的空卡组（只保留一份空卡组作为新建容器）
    if (!state.decks.length) state.decks = [newDeck()];
    const cur = localStorage.getItem(LS_CUR);
    const found = state.decks.find((d) => d.id === cur);
    // 上次编辑的卡组若为 0 张，不加载它
    state.deck = (found && isDraft(found)) ? found : (state.decks.find(isDraft) || state.decks[0]);
    state.hasDraft = isDraft(state.deck);
  }
  function saveStore() {
    localStorage.setItem(LS_DECKS, JSON.stringify(state.decks));
    // 只有真正有内容的卡组才记为「上次编辑」
    if (isDraft(state.deck)) localStorage.setItem(LS_CUR, state.deck.id);
    else localStorage.removeItem(LS_CUR);
    state.hasDraft = isDraft(state.deck);
  }

  // ------------------------------------------------------------ 卡牌归类
  // 规则以官方真实卡组码为准（已用 3 个真实卡组验证）：
  //   基础卡组 = type ∈ {随从, 护符, 法术} 且 非进化
  //   进化卡组 = is_evolve == '进化'（「萝卜」=胡萝卜 这类进化法术也在此列）
  //   主战者 / token / 装备 / 进化点 一律不参与组卡
  function sideOf(c) {
    // token 的可靠标记是 category_2 = '衍生物'：
    // 不少 token（BP09-T03SC 妖精、PR-165SC 妖精…）的 card_mode 是"基础"甚至为空，
    // 只按 mode 判会漏掉；进化卡的 category_2 是"进化"，不受影响。
    if (c.type2 === '衍生物') return null;
    if (c.evo === '进化') return 'evo';
    if (c.mode === '主战者' || c.type === '主战者') return null;
    if (c.mode === '衍生物') return null;
    if (c.type === '进化点' || c.type === '装备') return null;
    if (c.type === '随从' || c.type === '法术' || c.type === '护符') return 'basic';
    return null;
  }
  function cardKind(c) {
    const s = sideOf(c);
    if (s === 'evo') return 'evocard';
    if (s === 'basic') return 'basic';
    if (c.type2 === '衍生物' || c.mode === '衍生物') return 'token';
    if (c.mode === '主战者' || c.type === '主战者') return 'master';
    if (c.type === '进化点') return 'evopoint';
    return 'other';
  }
  const KIND_LABEL = { basic: '随从/法术/护符', evocard: '进化卡', token: 'token', master: '主战者', evopoint: '进化点' };
  // 兵种（type 列 / category_3）：多兵种用 ・ 分隔，例如「精灵族·公主」。
  // 注意排除「公主连结·〈吉奥·矶汉拿〉」这类势力/地名的尖括号片段（不是兵种）。
  function troopList(c) {
    return String(c.type3 == null ? '' : c.type3)
      .split(/[・·、,，/]/)
      .map((s) => s.trim())
      .filter((s) => s && s !== 'nan' && !/[〈〉<>]/.test(s));
  }

  // ------------------------------------------------------------ 渲染：卡池
  function inDeckCount(sid) { return (state.deck.basic[sid] || 0) + (state.deck.evo[sid] || 0); }
  function sideCount(sid, side) { return state.deck[side][sid] || 0; }
  // 同名卡计数：不同卡号但卡名相同的算同一张，跨基础/进化两个分区合计
  function sameNameCount(name) {
    if (!name) return 0;
    let n = 0;
    for (const side of ['basic', 'evo']) {
      for (const [sid, cnt] of Object.entries(state.deck[side])) {
        const cc = state.bySid.get(Number(sid));
        if (cc && cc.name === name) n += cnt;
      }
    }
    return n;
  }

  function filteredCards() {
    const f = state.filter;
    const txt = f.text.trim().toLowerCase();
    const side = state.side;                       // basic | evo
    return state.all.filter((c) => {
      if (sideOf(c) !== side) return false;        // 分类过滤：基础卡组 / 进化卡组
      if (!poolMatch(state.deck.poolId, c)) return false;
      if (f.costs.size && !f.costs.has(costBucket(c.cost))) return false;
      if (f.types.size && !f.types.has(c.type)) return false;
      if (f.rares.size && !f.rares.has(c.rare)) return false;
      if (f.boxes.size && !f.boxes.has(c.box)) return false;
      if (f.classes.size && !f.classes.has(c.cls)) return false;
      if (f.troops.size && !troopList(c).some((t) => f.troops.has(t))) return false;
      if (txt) {
        const hay = `${c.name || ''} ${c.id} ${c.no || ''}`;
        if (!hay.toLowerCase().includes(txt)) return false;
      }
      return true;
    });
  }

  function makeNoImg(text) {
    const d = document.createElement('div');
    d.className = 'noimg';
    d.textContent = text;
    return d;
  }

  // ------------------------------------------------------------ 长按放大卡图
  function showZoom(c) {
    const img = $('zoomImg');
    const b64 = c.md5 ? state.thumbs[c.md5] : null;
    img.onerror = null;
    if (!c.md5) {
      img.src = b64 ? `data:image/webp;base64,${b64}` : '';
    } else {
      img.src = '';                       // 先清空，避免显示上一张
      cardImageUrl(c.md5, c.imgExt).then((url) => {
        if (url) img.src = url;
        else if (b64) img.src = `data:image/webp;base64,${b64}`;
      });
    }
    const troops = troopList(c);
    $('zoomInfo').innerHTML = `<b>${c.name || c.id}</b>　${c.id}<br>`
      + `费用 ${c.cost ?? '-'} · ${c.cls || '-'} · ${c.rare || '-'}`
      + (troops.length ? ` · ${troops.join('・')}` : '')
      + (c.skillText ? `<div class="zoom-skill">${c.skillText}</div>` : '<div class="t-none">（暂无效果文本）</div>')
      + '<div class="zoom-close">点击任意处关闭</div>';
    $('zoom').classList.remove('hidden');
  }
  function hideZoom() { $('zoom').classList.add('hidden'); }

  // 悬停效果提示（不含 shortId）
  function showTip(c, e) {
    const t = $('tip');
    const troops = troopList(c);
    t.innerHTML = `<div class="t-name">${c.name || c.id}</div>`
      + `<div class="t-meta">${c.id} · 费用 ${c.cost ?? '-'} · ${c.cls || '-'} · ${c.rare || '-'}`
      + (troops.length ? ` · ${troops.join('・')}` : '') + '</div>'
      + (c.skillText ? `<div class="t-skill">${c.skillText}</div>` : '<div class="t-none">（暂无效果文本）</div>');
    t.classList.remove('hidden');
    moveTip(e);
  }
  function moveTip(e) {
    const t = $('tip');
    if (t.classList.contains('hidden')) return;
    const pad = 16;
    const r = t.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, e.clientX - r.width - pad);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, e.clientY - r.height - pad);
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }
  function hideTip() { $('tip').classList.add('hidden'); }

  // 长按(400ms)放大预览；长按之后松手不会再触发加卡
  function bindCardPress(el, c) {
    // 悬停 1 秒后才显示效果提示（避免鼠标扫过时乱弹）
    let tipTimer = null;
    let lastX = 0;
    let lastY = 0;
    el.addEventListener('mouseenter', (e) => {
      lastX = e.clientX; lastY = e.clientY;
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        tipTimer = null;
        showTip(c, { clientX: lastX, clientY: lastY });
      }, 1000);
    });
    el.addEventListener('mousemove', (e) => {
      lastX = e.clientX; lastY = e.clientY;
      if (!tipTimer) moveTip(e);
    });
    el.addEventListener('mouseleave', () => {
      if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
      hideTip();
    });

    let timer = null;
    let longPressed = false;
    let sx = 0;
    let sy = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      sx = e.clientX; sy = e.clientY;
      longPressed = false;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        longPressed = true;
        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        hideTip();
        showZoom(c);
      }, 400);
    });
    el.addEventListener('pointermove', (e) => {
      if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerleave', () => { cancel(); hideTip(); });
    // 阻止长按时被文本选中 / 图片拖拽打断
    el.addEventListener('dragstart', (e) => e.preventDefault());
    el.addEventListener('selectstart', (e) => e.preventDefault());

    el.addEventListener('click', (e) => {
      if (longPressed) { longPressed = false; return; }
      addCard(c, e.shiftKey ? -1 : 1);
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); addCard(c, -1); });
  }

  function renderGrid() {
    const list = filteredCards();

    const grid = $('grid');
    const frag = document.createDocumentFragment();
    for (const c of list) {
      const el = document.createElement('div');
      el.className = 'card' + (c.sid ? '' : ' nosid');
      el.draggable = false;

      if (c.md5) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.width = 128;          // 预留 128:178 比例，加载前也占位，避免高度塌陷
        img.height = 178;
        const b64 = state.thumbs[c.md5];
        // 进入视口后才去 CDN 取图（解码结果进 Cache API）；失败时退回内联缩略图
        state.imgTotal += 1;
        img.addEventListener('load', () => { state.imgOk += 1; updateDiag(); });
        attachCardImage(img, c.md5, c.imgExt, () => {
          state.imgFail += 1; updateDiag();
          if (b64) { img.src = `data:image/webp;base64,${b64}`; return; }
          img.replaceWith(makeNoImg(c.name || c.id));
        });
        el.appendChild(img);
      } else {
        el.appendChild(makeNoImg(c.id));
      }

      const cost = document.createElement('div');
      cost.className = 'cost';
      cost.textContent = c.cost ?? '-';
      el.appendChild(cost);

      const n = inDeckCount(c.sid);
      if (n) {
        const cnt = document.createElement('div');
        cnt.className = 'cnt';
        cnt.textContent = n;
        el.appendChild(cnt);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<div class="nm">${c.name || c.id}</div><div class="sub"><span>${c.cls || ''}</span><span>${c.rare || ''}</span></div>`;
      el.appendChild(meta);

      bindCardPress(el, c);
      frag.appendChild(el);
    }
    grid.replaceChildren(frag);
    updateDiag();
  }

  function addCard(c, delta) {
    if (!state.deck.masterSid) { toast('请先选择主战者', 2200); return; }
    if (!c.sid) { toast('该卡没有 shortId 映射，无法加入卡组'); return; }
    const side = state.side;
    const belong = sideOf(c);
    // 只在「加入」时校验分区归属；移除时允许（可能在另一个分区里）
    if (delta > 0 && belong !== side) {
      toast(`「${c.name || c.id}」属于${belong === 'evo' ? '进化卡组' : '基础卡组'}，不能放入当前分区`, 2600);
      return;
    }
    const cur = sideCount(c.sid, side);
    const total = deckCounts(state.deck);
    if (delta > 0) {
      // 按「卡号」限 3 张（与官方 app 一致：同名但不同卡号不共享名额，两个分区也各自独立）
      if (cur >= LIMIT.per) { toast(`该卡最多 ${LIMIT.per} 张`); return; }
      const max = side === 'basic' ? LIMIT.basicMax : LIMIT.evoMax;
      if (total[side] >= max) {
        toast(`${side === 'basic' ? '基础' : '进化'}卡组最多 ${max} 张`, 2200);
        return;
      }
      state.deck[side][c.sid] = cur + 1;
    } else {
      if (cur <= 0) return;
      if (cur === 1) delete state.deck[side][c.sid]; else state.deck[side][c.sid] = cur - 1;
    }
    saveStore();
    renderGrid();
    renderDeck();
  }

  // ------------------------------------------------------------ 渲染：卡组
  function renderDeck() {
    const d = state.deck;
    $('deckName').value = d.name;
    $('dPool').textContent = poolDisplayName(d.poolId);
    const mc = d.masterSid ? state.bySid.get(Number(d.masterSid)) : null;
    $('dMasterName').textContent = mc ? (mc.name || mc.id) : '— 未选择 —';
    renderClsFilter();     // 职业筛选项取决于当前卡池是职业还是主题

    for (const side of ['basic', 'evo']) {
      const box = $(side === 'basic' ? 'listBasic' : 'listEvo');
      const entries = Object.entries(d[side]).sort((a, b) => Number(a[0]) - Number(b[0]));
      const frag = document.createDocumentFragment();
      for (const [sid, cnt] of entries) {
        const c = state.bySid.get(Number(sid));
        const row = document.createElement('div');
        row.className = 'deck-item';
        row.innerHTML = `<span class="dn" title="${c ? c.id : sid}">${c ? (c.name || c.id) : '未知卡'}</span>`
          + `<button data-act="minus">−</button><span class="dc">${cnt}</span><button data-act="plus">+</button>`;
        row.querySelector('[data-act=minus]').onclick = () => { if (c) addCard(c, -1); };
        row.querySelector('[data-act=plus]').onclick = () => { if (c) { state.side = side; addCard(c, 1); } };
        frag.appendChild(row);
      }
      box.replaceChildren(frag);
      // 进化卡组为空时收起列表，把空间全留给基础卡组
      if (side === 'evo') {
        const row = box.closest('.deck-row');
        if (row) row.classList.toggle('empty', entries.length === 0);
      }
    }

    const n = deckCounts(d);
    $('cBasic').textContent = n.basic;
    $('cEvo').textContent = n.evo;
    $('cTotal').textContent = n.total;
    $('nBasic').textContent = n.basic;
    $('nEvo').textContent = n.evo;

    const w = $('warn');
    const problems = [];
    if (!d.masterSid) problems.push('① 请先选择主战者');
    if (n.basic < LIMIT.basicMin || n.basic > LIMIT.basicMax) problems.push(`基础卡组需 ${LIMIT.basicMin}-${LIMIT.basicMax} 张（当前 ${n.basic}）`);
    if (n.evo < LIMIT.evoMin || n.evo > LIMIT.evoMax) problems.push(`进化卡组需 ${LIMIT.evoMin}-${LIMIT.evoMax} 张（当前 ${n.evo}）`);
    if (problems.length) { w.className = 'warn bad'; w.textContent = problems.join('；'); }
    else { w.className = 'warn ok'; w.textContent = '✓ 卡组合法，可导出卡组码'; }
  }

  // ------------------------------------------------------------ 向导
  function openWizard(mode) {
    state.wizard.mode = mode || 'new';
    state.wizard.poolId = (mode === 'pool') ? state.deck.poolId : null;
    state.wizard.masterSid = null;
    renderWizard();          // 标题与按钮文案由 renderWizard 统一决定
    $('wizard').classList.remove('hidden');
  }
  function closeWizard() { $('wizard').classList.add('hidden'); }

  // 职业与主战者同层展示：选完职业后主战者区即时刷新
  function renderWizard() {
    const w = state.wizard;

    // 职业 / 联动主题：官方按钮图，选中打勾（按官方编号排序，中立不列出）
    const pl = $('poolList');
    pl.replaceChildren();
    const order = [...POOLS]
      .filter((p) => POOL_ICON[p.name] !== 0)          // 中立不作为卡池
      .sort((a, b) => (POOL_ICON[a.name] ?? 99) - (POOL_ICON[b.name] ?? 99));
    for (const p of order) {
      const el = document.createElement('div');
      const on = p.id === w.poolId;
      const icon = poolIconUrl(p.name);
      el.className = 'pool-tile' + (on ? ' on' : '') + (p.usableAll ? '' : ' disabled');
      el.innerHTML = `<div class="pt-iconwrap">${icon ? `<img class="pt-icon" src="${icon}" alt="" loading="lazy">` : ''}</div>`
        + `<div class="pt-name">${p.name}</div>`
        + '<span class="pt-tick">✓</span>';
      if (p.usableAll) {
        el.onclick = () => { w.poolId = p.id; w.masterSid = null; renderWizard(); };
      } else {
        el.title = '该卡池暂时没有可组卡（缺少 shortId 映射）';
      }
      pl.appendChild(el);
    }

    // 主战者
    const pool = w.poolId ? getPool(w.poolId) : null;
    $('wizPoolTag').textContent = pool ? `· ${pool.name}` : '';
    const ml = $('masterList');
    ml.replaceChildren();
    if (!w.poolId) {
      ml.innerHTML = '<div class="empty">请先在上方选择职业或主题</div>';
    } else {
      const masters = state.all.filter((c) => c.mode === '主战者' && c.sid && poolMatch(w.poolId, c));
      if (!masters.length) ml.innerHTML = '<div class="empty">该卡池暂无可选主战者（缺 shortId 映射）</div>';
      for (const m of masters) {
        const el = document.createElement('div');
        el.className = 'master-item' + (String(m.sid) === String(w.masterSid) ? ' on' : '');
        if (m.md5) {
          const im = document.createElement('img');
          im.loading = 'lazy';
          im.alt = '';
          attachCardImage(im, m.md5, m.imgExt);
          el.appendChild(im);
        }
        const nm = document.createElement('div');
        nm.className = 'mn';
        nm.textContent = m.name || m.id;
        el.appendChild(nm);
        el.onclick = () => { w.masterSid = m.sid; renderWizard(); };
        ml.appendChild(el);
      }
    }

    $('wizOk').disabled = !(w.poolId && w.masterSid);
  }

  function commitWizard() {
    const w = state.wizard;
    if (w.mode === 'master') {
      state.deck.masterSid = w.masterSid;
      saveStore(); closeWizard(); renderDeck();
      toast('已更换主战者');
      return;
    }
    if (w.mode === 'pool') {
      state.deck.poolId = w.poolId;
      state.deck.masterSid = w.masterSid;
      state.deck.basic = {}; state.deck.evo = {};
      saveStore(); closeWizard(); renderGrid(); renderDeck();
      toast('已更换卡池并清空卡组');
      return;
    }
    const d = newDeck(w.poolId);
    d.masterSid = w.masterSid;
    state.decks.push(d);
    state.deck = d;
    saveStore(); closeWizard(); renderAll();
    toast('卡组已创建，开始组卡吧');
  }

  // ------------------------------------------------------------ 卡组码
  function exportCode() {
    const d = state.deck;
    const n = deckCounts(d);
    const problems = [];
    if (!d.masterSid) problems.push('未选择主战者');
    if (n.basic < LIMIT.basicMin || n.basic > LIMIT.basicMax) problems.push(`基础卡组需 ${LIMIT.basicMin}-${LIMIT.basicMax} 张（当前 ${n.basic}）`);
    if (n.evo < LIMIT.evoMin || n.evo > LIMIT.evoMax) problems.push(`进化卡组需 ${LIMIT.evoMin}-${LIMIT.evoMax} 张（当前 ${n.evo}）`);
    if (problems.length) { toast('卡组不完整：' + problems.join('；'), 2600); return; }

    const expand = (o) => {
      const arr = [];
      for (const [sid, cnt] of Object.entries(o)) for (let i = 0; i < cnt; i += 1) arr.push(Number(sid));
      return arr;
    };
    const obj = { 1: poolCodeName(d.poolId), 2: Number(d.masterSid), 3: expand(d.basic), 4: expand(d.evo) };
    const code = encryptDeckCode(obj);
    modal('卡组码（可直接在官方 app 导入）',
      `${poolCodeName(d.poolId)} · 基础 ${obj[3].length} + 进化 ${obj[4].length} · 长度 ${code.length}`,
      code, 'code');
  }

  function importCode() {
    modal('导入卡组码', '粘贴卡组码后点「确定」。卡池与主战者将由卡组码决定。', '', 'input');
    $('modalOk').dataset.mode = 'import';
  }

  // ------------------------------------------------------------ 查看卡组
  // 展开成「逐张」列表。排序以卡名为单位：同名卡必定相邻，
  // 组与组之间按该卡名的最小费用排（同一张卡的不同版本/异画费用可能不一致）。
  function expandDeckList(map) {
    const items = [];
    for (const [sid, cnt] of Object.entries(map)) {
      for (let i = 0; i < cnt; i += 1) items.push({ sid, c: state.bySid.get(Number(sid)) });
    }
    const nameOf = (it) => (it.c ? (it.c.name || it.c.id) : `#${it.sid}`);
    const costOf = (it) => (it.c && typeof it.c.cost === 'number' ? it.c.cost : 99);

    const nameCost = new Map();
    for (const it of items) {
      const n = nameOf(it);
      const c = costOf(it);
      if (!nameCost.has(n) || c < nameCost.get(n)) nameCost.set(n, c);
    }

    items.sort((a, b) => {
      const na = nameOf(a);
      const nb = nameOf(b);
      const ga = nameCost.get(na);
      const gb = nameCost.get(nb);
      if (ga !== gb) return ga - gb;
      if (na !== nb) return na.localeCompare(nb, 'zh');
      return costOf(a) - costOf(b) || Number(a.sid) - Number(b.sid);
    });
    return items;
  }

  // 平铺渲染：有几张就画几张图
  function renderPreviewList(id, map) {
    const box = $(id);
    const items = expandDeckList(map);
    if (!items.length) { box.innerHTML = '<div class="preview-empty">（空）</div>'; return; }

    box.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'pv-card';
      const c = it.c;
      card.title = c ? (c.name || c.id) : '未知卡';
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.alt = '';
      if (c && c.md5) attachCardImage(im, c.md5, c.imgExt);
      card.appendChild(im);
      const cost = document.createElement('span');
      cost.className = 'pv-cost';
      cost.textContent = c && typeof c.cost === 'number' ? c.cost : '–';
      card.appendChild(cost);
      frag.appendChild(card);
    }
    box.appendChild(frag);
  }

  function openPreview() {
    const d = state.deck;
    const n = deckCounts(d);
    const mc = d.masterSid ? state.bySid.get(Number(d.masterSid)) : null;

    $('pvName').textContent = d.name || '未命名卡组';
    $('pvCount').textContent = `${n.total}/50`;

    // 主战者卡图（信息区左侧）。新布局不再单列主战者名，名字放进悬停提示。
    const mImg = $('pvMasterImg');
    if (mc && mc.md5) {
      mImg.alt = mc.name || mc.id;
      mImg.title = `${mc.name || mc.id}（${mc.id}）`;
      mImg.removeAttribute('src');
      cardImageUrl(mc.md5, mc.imgExt).then((u) => { if (u) mImg.src = u; });
    } else {
      mImg.removeAttribute('src');
      mImg.alt = '未选择主战者';
      mImg.title = '未选择主战者';
    }

    // 卡牌构成（基础卡组按类型统计）+ 进化张数
    const byType = { 随从: 0, 法术: 0, 护符: 0 };
    for (const [sid, cnt] of Object.entries(d.basic)) {
      const c = state.bySid.get(Number(sid));
      if (c && byType[c.type] !== undefined) byType[c.type] += cnt;
    }
    $('pvCls').textContent = poolDisplayName(d.poolId);
    $('pvFollower').textContent = byType['随从'];
    $('pvSpell').textContent = byType['法术'];
    $('pvAmulet').textContent = byType['护符'];
    $('pvEvoCnt').textContent = n.evo;

    // 费用曲线：只统计基础卡组，档位与筛选用同一套（1- / 2..7 / 8+）
    const curve = new Array(COST_LABELS.length).fill(0);
    for (const [sid, cnt] of Object.entries(d.basic)) {
      const c = state.bySid.get(Number(sid));
      if (!c) continue;
      curve[COST_LABELS.indexOf(costBucket(c.cost))] += cnt;
    }
    const max = Math.max(1, ...curve);
    $('pvCurveChart').innerHTML = curve.map((v, i) =>
      `<div class="curve-bar" title="${COST_LABELS[i]} 费：${v} 张">`
      + `<span class="cb-n">${v || ''}</span>`
      + `<div class="cb-track"><div class="cb-fill" style="height:${v ? Math.max(4, (v / max) * 100) : 0}%"></div></div>`
      + `<span class="cb-x">${COST_LABELS[i]}</span></div>`).join('');

    // 只有合规的卡组才能导出卡组码
    const legal = isLegal(d);
    const btn = $('pvExport');
    btn.disabled = !legal;
    btn.textContent = legal ? '生成卡组码' : '未达组卡要求，无法生成';
    btn.title = legal ? '' : `需要 基础 ${LIMIT.basicMin}-${LIMIT.basicMax} 张、进化 ${LIMIT.evoMin}-${LIMIT.evoMax} 张，且已选主战者`;

    renderPreviewList('pvBasic', d.basic);
    renderPreviewList('pvEvo', d.evo);
    $('pvBasicN').textContent = n.basic;
    $('pvEvoN').textContent = n.evo;
    $('preview').classList.remove('hidden');
  }

  function closePreview() { $('preview').classList.add('hidden'); }

  // ------------------------------------------------------------ 卡组图片
  // 只展示卡图：基础在上、进化在下，紧凑平铺，不带任何文字信息
  function openDeckImage() {
    const d = state.deck;
    const basic = expandDeckList(d.basic);
    const evo = expandDeckList(d.evo);
    const grid = (items) => {
      const g = document.createElement('div');
      g.className = 'di-grid';
      for (const it of items) {
        const im = document.createElement('img');
        im.loading = 'lazy';
        im.alt = '';
        if (it.c && it.c.md5) attachCardImage(im, it.c.md5, it.c.imgExt);
        g.appendChild(im);
      }
      return g;
    };
    $('diTitle').textContent = `${d.name} · ${basic.length + evo.length} 张`;
    const body = $('diBody');
    body.replaceChildren();
    if (basic.length || evo.length) {
      if (basic.length) body.appendChild(grid(basic));
      if (evo.length) body.appendChild(grid(evo));
    } else {
      const e = document.createElement('div');
      e.className = 'preview-empty';
      e.textContent = '（空）';
      body.appendChild(e);
    }
    $('deckImage').classList.remove('hidden');
  }
  function closeDeckImage() { $('deckImage').classList.add('hidden'); }

  // 把整套卡图画到 canvas 上，再导出为 PNG 下载
  async function downloadDeckImage() {
    const d = state.deck;
    const basic = expandDeckList(d.basic);
    const evo = expandDeckList(d.evo);
    if (!basic.length && !evo.length) { toast('卡组是空的'); return; }

    const btn = $('diSaveImg');
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '生成中…';

    const COLS = 10;
    const CW = 150;
    const CH = 209;
    const GAP = 4;
    const PAD = 18;
    const SEC = 24;
    const rowsOf = (n) => Math.ceil(n / COLS);
    const bRows = basic.length ? rowsOf(basic.length) : 0;
    const eRows = evo.length ? rowsOf(evo.length) : 0;

    let H = PAD * 2;
    if (bRows) H += bRows * CH + (bRows - 1) * GAP + GAP;
    if (eRows) H += SEC + eRows * CH + (eRows - 1) * GAP;
    const W = PAD * 2 + COLS * CW + (COLS - 1) * GAP;

    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#11151b';
    ctx.fillRect(0, 0, W, H);

    const loadImg = (url) => new Promise((res) => {
      if (!url) { res(null); return; }
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = url;
    });

    const drawBlock = async (items, y0) => {
      for (let i = 0; i < items.length; i += 1) {
        const x = PAD + (i % COLS) * (CW + GAP);
        const y = y0 + Math.floor(i / COLS) * (CH + GAP);
        const c = items[i].c;
        const url = c && c.md5 ? await cardImageUrl(c.md5, c.imgExt) : '';
        const im = await loadImg(url);
        if (im) ctx.drawImage(im, x, y, CW, CH);
        else { ctx.fillStyle = '#232a34'; ctx.fillRect(x, y, CW, CH); }
      }
      return y0 + rowsOf(items.length) * CH + (rowsOf(items.length) - 1) * GAP;
    };

    let y = PAD;
    if (basic.length) { y = await drawBlock(basic, y) + GAP; }
    if (evo.length) { y += SEC; await drawBlock(evo, y); }

    cv.toBlob((blob) => {
      btn.disabled = false;
      btn.textContent = oldText;
      if (!blob) { toast('图片生成失败'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${d.name || '卡组'}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('已下载卡组图片');
    }, 'image/png');
  }

  // 清空当前卡组（二次确认）
  function clearDeck() {
    const d = state.deck;
    const n = deckCounts(d);
    if (n.total === 0) { toast('卡组已经是空的'); return; }
    modal('清空卡组', `确定要清空「${d.name}」的全部 ${n.total} 张卡吗？此操作不可撤销。`, '', 'plain');
    $('modalOk').dataset.mode = 'clear';
  }

  // 保存：合法 → 正式保存（会出现在「我的卡组」）；不合法 → 暂存（半成品，可继续编辑）
  function saveDeck() {
    const d = state.deck;
    const n = deckCounts(d);
    const legal = isLegal(d);
    d.saved = legal;
    saveStore();
    if (legal) toast(`已保存「${d.name}」（${n.total}/50）`);
    else if (n.total) toast(`已暂存「${d.name}」（${n.total}/50，未完成）`, 2400);
    else toast('卡组为空，已回首页');
  }

  // 新建卡组：丢弃旧草稿（编辑中的卡组只保留一份），并走向导选卡池+主战者
  function startNewDeck() {
    const keep = state.decks.filter((d) => d.id !== state.deck.id && isDraft(d));
    const fresh = newDeck(null);
    state.decks = keep.concat(fresh);
    state.deck = fresh;
    saveStore();
    renderAll();
    showView('editor');
    openWizard('pool');
  }

  function doImport() {
    const code = $('modalText').value.replace(/\s+/g, '');
    if (!code) { toast('请输入卡组码'); return; }
    let obj;
    try { obj = decryptDeckCode(code); } catch (e) { toast('卡组码解析失败：' + e.message, 2800); return; }
    const basic = {}, evo = {};
    for (const sid of obj['3'] || []) basic[sid] = (basic[sid] || 0) + 1;
    for (const sid of obj['4'] || []) evo[sid] = (evo[sid] || 0) + 1;

    // 依据主战者所在卡盒判断卡池
    const mc = state.bySid.get(Number(obj['2']));
    let poolId = state.deck.poolId;
    const theme = THEME_POOLS.find((t) => t.name === obj['1']);
    if (theme) poolId = 'theme:' + theme.id;
    else if (mc) {
      const byTheme = THEME_POOLS.find((t) => t.boxes.includes(mc.box));
      if (byTheme) poolId = 'theme:' + byTheme.id;
      else if (mc.cls && state.cls.includes(mc.cls)) poolId = 'cls:' + mc.cls;
    }

    state.deck = {
      id: 'd' + Date.now().toString(36),
      name: obj['1'] || '导入卡组',
      poolId, masterSid: Number(obj['2']) || null, basic, evo,
    };
    state.decks.push(state.deck);
    saveStore(); closeModal(); renderAll();
    const nb = Object.values(basic).reduce((a, b) => a + b, 0);
    const ne = Object.values(evo).reduce((a, b) => a + b, 0);
    const unknown = [...Object.keys(basic), ...Object.keys(evo)].filter((s) => !state.bySid.has(Number(s))).length;
    toast(`已导入：卡池 ${obj['1']}，基础 ${nb} + 进化 ${ne} 张` + (unknown ? `（${unknown} 种卡本地无数据）` : ''), 3000);
    showView('editor');   // 导入完成后再进入组卡界面
  }

  // ------------------------------------------------------------ 我的卡组
  // 只列「正式保存过」的卡组（即已达组卡要求）；暂存的半成品留在首页「继续组卡」
  function renderMyDecks() {
    const list = state.decks.filter((d) => d.saved && isDraft(d)).slice().reverse();
    const box = $('myList');
    if (!list.length) {
      box.innerHTML = '<div class="mysaved-empty">还没有保存过卡组，点「开始组卡」新建一副吧</div>';
      return;
    }
    box.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const d of list) {
      const n = deckCounts(d);
      const legal = isLegal(d);
      const mc = d.masterSid ? state.bySid.get(Number(d.masterSid)) : null;

      const row = document.createElement('div');
      row.className = 'my-deck';
      row.dataset.id = d.id;

      const im = document.createElement('img');
      im.loading = 'lazy';
      im.alt = '';
      if (mc && mc.md5) attachCardImage(im, mc.md5, mc.imgExt);
      row.appendChild(im);

      const info = document.createElement('div');
      info.className = 'md-info';
      const nm = document.createElement('div');
      nm.className = 'md-name';
      nm.textContent = d.name;
      const sub = document.createElement('div');
      sub.className = 'md-sub';
      sub.innerHTML = `${poolDisplayName(d.poolId)} · ${mc ? (mc.name || mc.id) : '未选主战者'}`
        + ` · <b>${n.total}</b>/50（基础 ${n.basic} · 进化 ${n.evo}）`;
      info.append(nm, sub);
      row.appendChild(info);

      const badge = document.createElement('span');
      badge.className = `md-badge ${legal ? 'ok' : 'no'}`;
      badge.textContent = legal ? '可导出' : '未完成';
      row.appendChild(badge);

      const del = document.createElement('button');
      del.className = 'md-del';
      del.dataset.del = '1';
      del.title = '删除这副卡组';
      del.textContent = '删除';
      row.appendChild(del);

      frag.appendChild(row);
    }
    box.appendChild(frag);

    box.querySelectorAll('.my-deck').forEach((el) => {
      el.onclick = (e) => {
        const id = el.dataset.id;
        if (e.target.dataset.del) {
          state.decks = state.decks.filter((d) => d.id !== id);
          if (state.deck.id === id) {
            state.deck = state.decks.find(isDraft) || state.decks[0] || newDeck();
            if (!state.decks.length) state.decks = [state.deck];
          }
          saveStore(); renderMyDecks(); updateHome();
          toast('已删除该卡组');
          return;
        }
        const d = state.decks.find((x) => x.id === id);
        if (!d) return;
        state.deck = d;
        saveStore();
        closeMyDecks();
        showView('editor');
        renderAll();
      };
    });
  }

  function openMyDecks() { renderMyDecks(); $('myDecks').classList.remove('hidden'); }
  function closeMyDecks() { $('myDecks').classList.add('hidden'); }

  // ------------------------------------------------------------ 初始化
  function buildStaticOptions() {
    // 筛选项只从「可组卡」里生成（随从/护符/法术，排除主战者、token、萝卜、adv），
    // 避免 LD(主战者稀有度)、nan 等噪声进入筛选器。
    const playable = state.all.filter((c) => ['随从', '法术', '护符'].includes(c.type));

    // 类型：与官方筛选一致的可组卡类型（衍生物不参与组卡，故不列出）
    state.types = ['随从', '法术', '护符'];

    // 稀有度：按官方 app 筛选面板的顺序与种类（BR SR GR LG SL UR SP SSP），
    // 数据里额外出现的稀有度（如 SLG）追加在末尾，避免有卡筛不到。
    const RARE_ORDER = ['BR', 'SR', 'GR', 'LG', 'SL', 'UR', 'SP', 'SSP'];
    const rareSet = new Set(playable.map((c) => c.rare).filter((r) => r && r !== 'nan'));
    state.rares = RARE_ORDER.filter((r) => rareSet.has(r))
      .concat([...rareSet].filter((r) => !RARE_ORDER.includes(r)).sort());

    // 兵种（category_3，多兵种用 ・ 分隔）
    const troops = new Set();
    for (const c of playable) {
      for (const s of troopList(c)) troops.add(s);
    }
    state.troops = [...troops].sort((a, b) => a.localeCompare(b, 'zh'));

    // 卡盒：PR 单独一盒（官方就是这么分的），按卡盒号排序
    const boxSet = new Set(playable.map((c) => c.box).filter(Boolean));
    state.boxes = [...boxSet].sort((a, b) => {
      if (a === 'PR') return 1;           // PR 促销卡排最后
      if (b === 'PR') return -1;
      return a.localeCompare(b);
    });

    // 职业：真正的职业 + 中立（用于筛选标签）
    state.cls = [...new Set(state.all.filter((c) => c.cls).map((c) => c.cls))].sort();

    $('fType').innerHTML = state.types.map((t) => `<span class="chip" data-v="${t}">${t}</span>`).join('');
    // 卡盒 / 兵种 / 职业：一行一个，行末打勾标记
    const pick = (t) => `<div class="pick" data-v="${t}"><span class="pn">${t}</span><i class="tick"></i></div>`;
    $('fBox').innerHTML = state.boxes.map(pick).join('');
    renderTroopOptions();
    $('fRare').innerHTML = state.rares.map((t) => `<span class="chip" data-v="${t}">${t}</span>`).join('');
    // 费用档位与费用曲线保持一致：1- / 2..7 / 8+
    $('fCost').innerHTML = COST_LABELS.map((t) => `<span class="chip" data-v="${t}">${t}</span>`).join('');
    $('fBoxCount').textContent = `(${state.boxes.length})`;
    POOLS = listPools();
  }

  // 职业筛选项随卡池类型变化：
  //   职业卡池 → 两个互斥标签（所选职业 + 中立）
  //   主题卡池 → 六个职业 + 中立，可多选
  function renderClsFilter() {
    const pool = getPool(state.deck.poolId);
    if (!pool) { state.clsOptions = []; $('fCls').innerHTML = ''; $('fClsCount').textContent = ''; return; }
    if (pool.kind === 'class') {
      const own = pool.name;
      state.clsOptions = [own, '中立'].filter((x) => state.cls.includes(x));
      state.clsExclusive = true;
    } else {
      state.clsOptions = state.cls;          // 已含中立
      state.clsExclusive = false;
    }
    $('fCls').innerHTML = state.clsOptions
      .map((t) => `<div class="pick" data-v="${t}"><span class="pn">${t}</span><i class="tick"></i></div>`)
      .join('');
    $('fClsCount').textContent = `(${state.clsOptions.length})`;
    // 卡池切换后清掉不再可用的选择
    for (const v of [...state.filter.classes]) {
      if (!state.clsOptions.includes(v)) state.filter.classes.delete(v);
    }
  }

  // 兵种列表：支持关键词过滤，重建时保留已选状态
  function renderTroopOptions() {
    const kw = (state.filter.troopText || '').toLowerCase();
    const list = kw ? state.troops.filter((t) => t.toLowerCase().includes(kw)) : state.troops;
    $('fTroop').innerHTML = list.map((t) => {
      const on = state.filter.troops.has(t) ? ' on' : '';
      return `<div class="pick${on}" data-v="${t}"><span class="pn">${t}</span><i class="tick"></i></div>`;
    }).join('');
    $('fTroopCount').textContent = state.filter.troops.size
      ? `(${state.filter.troops.size}/${state.troops.length})`
      : `(${state.troops.length})`;
  }

  function bindEvents() {
    $('fText').oninput = (e) => { state.filter.text = e.target.value; renderGrid(); };

    // 兵种关键词搜索
    $('fTroopSearch').oninput = (e) => {
      state.filter.troopText = e.target.value.trim().toLowerCase();
      renderTroopOptions();
    };

    // 费用 / 类型（chips）与 卡盒 / 兵种 / 职业（pick 列表）统一多选，全部未选 = 全部
    // exclusive=true 时互斥（职业卡池下只允许「所选职业」与「中立」二选一）
    const bindChips = (id, set, exclusive) => {
      $(id).onclick = (e) => {
        const t = e.target.closest('.chip, .pick');
        if (!t || t.dataset.v === undefined) return;
        const v = t.dataset.v;
        if (exclusive) {
          const had = set.has(v);
          set.clear();
          if (!had) set.add(v);
          $(id).querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
          if (!had) t.classList.add('on');
        } else {
          if (set.has(v)) set.delete(v); else set.add(v);
          t.classList.toggle('on');
        }
        renderGrid();
      };
    };
    bindChips('fCost', state.filter.costs);
    bindChips('fType', state.filter.types);
    bindChips('fTroop', state.filter.troops);
    bindChips('fRare', state.filter.rares);
    bindChips('fBox', state.filter.boxes);
    $('fCls').onclick = (e) => {
      const t = e.target.closest('.pick');
      if (!t || t.dataset.v === undefined) return;
      const v = t.dataset.v;
      const set = state.filter.classes;
      if (state.clsExclusive) {
        const had = set.has(v);
        set.clear();
        if (!had) set.add(v);
        $('fCls').querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
        if (!had) t.classList.add('on');
      } else {
        if (set.has(v)) set.delete(v); else set.add(v);
        t.classList.toggle('on');
      }
      renderGrid();
    };

    $('btnClearFilter').onclick = () => {
      state.filter.text = '';
      state.filter.troopText = '';
      state.filter.costs.clear();
      state.filter.types.clear();
      state.filter.troops.clear();
      state.filter.rares.clear();
      state.filter.boxes.clear();
      state.filter.classes.clear();
      $('fText').value = '';
      $('fTroopSearch').value = '';
      renderTroopOptions();
      document.querySelectorAll('.filters .chip.on, .filters .pick.on').forEach((c) => c.classList.remove('on'));
      renderGrid();
    };

    document.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        state.side = t.dataset.side;
        $('poolHint').textContent = state.side === 'basic'
          ? `左键加入基础卡组 · 右键移除（随从/护符/法术，同名卡合计最多 ${LIMIT.per} 张，共 ${LIMIT.basicMin}-${LIMIT.basicMax} 张）`
          : `左键加入进化卡组 · 右键移除（进化卡/萝卜/adv，共 ${LIMIT.evoMin}-${LIMIT.evoMax} 张）`;
        renderGrid();          // 切换分区要重新过滤卡池
      };
    });

    $('deckName').onchange = (e) => { state.deck.name = e.target.value || '未命名'; saveStore(); };

    // 左右两栏折叠（非全屏时给卡池腾地方）
    const togglePane = (which) => {
      const isFilters = which === 'filters';
      const cls = isFilters ? 'hide-filters' : 'hide-deck';
      const main = $('main');
      main.classList.toggle(cls);
      const hidden = main.classList.contains(cls);
      $(isFilters ? 'btnFiltersToggle' : 'btnDeckToggle').textContent =
        isFilters ? (hidden ? '›' : '‹') : (hidden ? '‹' : '›');
    };
    $('btnFiltersToggle').onclick = () => togglePane('filters');
    $('btnDeckToggle').onclick = () => togglePane('deck');

    // 首页「继续组卡」：回到上次编辑中的那份卡组
    $('btnResume').onclick = () => {
      if (!isDraft(state.deck)) { toast('没有正在编辑的卡组'); return; }
      showView('editor');
      renderAll();
    };

    // 首页「开始组卡」：新建卡组。
    // 合规的卡组会自动保存，新建不会丢内容，无需提示；
    // 只有「已经放了卡但还不合规」的半成品才需要确认。
    $('btnStart').onclick = () => {
      const d = state.deck;
      const n = deckCounts(d);
      if (!isLegal(d) && n.total > 0) {
        modal('新建卡组',
          `当前「${d.name}」放了 ${n.total} 张卡，还未达到组卡要求`
          + `（基础 ${LIMIT.basicMin}-${LIMIT.basicMax} 张、进化 ${LIMIT.evoMin}-${LIMIT.evoMax} 张）。`
          + '新建会丢弃这份未完成的卡组。', '', 'plain');
        $('modalOk').dataset.mode = 'newdeck';
        return;
      }
      startNewDeck();
    };
    $('btnBackHome').onclick = () => { saveStore(); showView('home'); };

    // 卡池与主战者在向导里一次确定；组卡页不再提供「更换卡池」，改为「清空卡组」
    $('btnClearDeck').onclick = clearDeck;

    // 顶栏「保存」：合法 → 正式保存；不合法 → 暂存（半成品，下次可继续）
    $('btnStash').onclick = () => { saveDeck(); showView('home'); };
    $('btnDel').onclick = () => {
      state.deck.basic = {};
      state.deck.evo = {};
      state.deck.masterSid = null;
      state.deck.saved = false;
      saveStore();
      showView('home');
      toast('已删除当前卡组');
    };

    // 卡组码只从「查看卡组」弹窗里生成，组卡界面不再放导出按钮
    $('btnImport').onclick = importCode;

    // 首页「我的卡组」
    $('btnMyDecks').onclick = openMyDecks;
    $('myClose').onclick = closeMyDecks;
    $('myClose2').onclick = closeMyDecks;
    $('myDecks').addEventListener('click', (e) => { if (e.target.id === 'myDecks') closeMyDecks(); });

    // 查看卡组弹窗
    $('btnPreviewDeck').onclick = openPreview;
    $('pvClose').onclick = closePreview;
    $('pvSave').onclick = () => {
      saveDeck();
      closePreview();
      showView('home');
    };
    // 生成卡组码时不关闭查看卡组窗口
    $('pvExport').onclick = () => exportCode();
    $('preview').addEventListener('click', (e) => { if (e.target.id === 'preview') closePreview(); });

    // 卡组图片弹窗
    $('pvImage').onclick = openDeckImage;
    $('diClose').onclick = closeDeckImage;
    $('diSaveImg').onclick = downloadDeckImage;
    $('deckImage').addEventListener('click', (e) => { if (e.target.id === 'deckImage') closeDeckImage(); });

    // 向导在选定职业+主战者之前不能被关掉（不响应 ESC、不响应点遮罩），
    // 只能通过「返回」离开，且返回后回到 index。
    $('wizCancel').onclick = () => {
      closeWizard();
      showView('home');
    };
    $('wizOk').onclick = commitWizard;
    // 故意不绑定遮罩点击关闭

    $('modalOk').onclick = () => {
      const mode = $('modalOk').dataset.mode;
      $('modalOk').dataset.mode = '';
      if (mode === 'import') doImport();
      else if (mode === 'clear') {
        state.deck.basic = {};
        state.deck.evo = {};
        saveStore(); closeModal(); renderAll();
        toast('已清空卡组');
      } else if (mode === 'newdeck') { closeModal(); startNewDeck(); }
      else closeModal();
    };
    $('modalCopy').onclick = async () => {
      const t = $('modalText');
      t.select();
      try { await navigator.clipboard.writeText(t.value); toast('已复制到剪贴板'); }
      catch { document.execCommand('copy'); toast('已复制'); }
    };
    $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
    $('zoom').addEventListener('click', hideZoom);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      hideZoom();
      // 向导必须先完成「职业 + 主战者」的选择，ESC 不允许关掉它
      if (!$('wizard').classList.contains('hidden')) return;
      closeModal();
      closeDeckImage();
      closePreview();
      closeMyDecks();
    });
  }

  function renderAll() {
    renderGrid();
    renderDeck();
  }

  async function boot() {
    $('ver').textContent = VERSION;
    let cards;
    try {
      const res = await fetch('data/cards.json?v=' + VERSION);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      cards = await res.json();
    } catch (e) {
      document.body.innerHTML = `<pre style="color:#ff6b6b;padding:20px;white-space:pre-wrap">数据加载失败：${e.message}

请通过 HTTP 打开本页（不要直接双击 index.html）：
  http://127.0.0.1:8099/</pre>`;
      return;
    }
    state.all = cards;
    for (const c of state.all) {
      if (c.sid) state.bySid.set(Number(c.sid), c);
      state.byId.set(c.id, c);
    }
    // 卡图内联数据（GSF 图片是 base64+前缀包装，已离线解码压成 webp）
    try {
      const tr = await fetch('data/thumbs.json?v=' + VERSION);
      if (tr.ok) state.thumbs = await tr.json();
    } catch (e) { state.thumbs = {}; }
    console.log(`[SVE ${VERSION}] thumbs loaded: ${Object.keys(state.thumbs).length}`);
    buildStaticOptions();
    loadStore();
    if (!getPool(state.deck.poolId)) state.deck.poolId = 'theme:pcr';
    bindEvents();
    $('poolHint').textContent = `左键加入基础卡组 · 右键移除（同名卡合计最多 ${LIMIT.per} 张，共 ${LIMIT.basicMin}-${LIMIT.basicMax} 张）`;
    renderAll();
    // 刷新后回到上次所在的界面（只有已选定主战者的卡组才允许直接进组卡界面）
    let savedView = 'home';
    try { savedView = localStorage.getItem('sve-view') || 'home'; } catch (e) { /* ignore */ }
    // 只有「有内容且已选主战者」的草稿才允许直接回到组卡界面
    const canResume = isDraft(state.deck) && state.deck.masterSid;
    showView(savedView === 'editor' && canResume ? 'editor' : 'home');
    updateDiag();
    console.log(`[SVE ${VERSION}] cards=${state.all.length} indexed=${state.bySid.size} pools=${POOLS.length} thumbs=${Object.keys(state.thumbs).length}`);
  }

  boot();
})();
