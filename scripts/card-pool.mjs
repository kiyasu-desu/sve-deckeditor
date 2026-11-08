/** Pure parsing and validation for the official card-pool updater. No network or secrets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const DISCOVERY_URL = 'https://api-sve.nie.netease.com/sve/api/v1/server_list';
export const PRODUCTION_API = 'https://api-sve.nie.netease.com/sve';
export const CDN = 'https://betasystem.gsf.netease.com/';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const normalize = (s) => String(s).toLowerCase().replace(/[-_\s.]/g, '');

export function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { value += '"'; i += 1; }
        else quoted = false;
      } else value += ch;
    } else if (ch === '"') {
      assert.equal(value, '', 'Quote inside an unquoted CSV field');
      quoted = true;
    } else if (ch === ',') { row.push(value); value = ''; }
    else if (ch === '\n') { row.push(value); rows.push(row); row = []; value = ''; }
    else if (ch !== '\r') value += ch;
  }
  assert(!quoted, 'Unterminated quoted CSV field');
  if (value || row.length) { row.push(value); rows.push(row); }
  const header = (rows.shift() || []).map((s) => s.trim().replace(/^#+|#+$/g, ''));
  assert(header.length && new Set(header).size === header.length, 'Invalid CSV header');
  return {
    header,
    rows: rows.filter((r) => r.some((s) => s.trim())).map((r) => {
      assert.equal(r.length, header.length, 'CSV row width does not match header');
      return Object.fromEntries(header.map((h, i) => [h, r[i].trim()]));
    }),
  };
}

export function requireColumns(table, columns) {
  for (const column of columns) assert(table.header.includes(column), `Missing column: ${column}`);
}

export function resourceUrl(url) {
  const parsed = new URL(url);
  assert(parsed.origin === new URL(CDN).origin && !parsed.username && !parsed.password
    && !parsed.search && !parsed.hash, 'Resource URL is outside the approved CDN');
  return parsed.href;
}

export function selectProductionServer(payload, { platform = 'android', appVersion = '1.2.0', channel = 'all' } = {}) {
  assert(payload?.status === 'success' && Array.isArray(payload.items), 'Invalid server-list response');
  const candidates = payload.items.filter((s) => s.address === PRODUCTION_API
    && s.platform === platform && s.appVer === appVersion && s.channel === channel
    && String(s.isDebug) === '0' && !/测试|test/i.test(s.server || ''));
  assert.equal(candidates.length, 1, 'Expected exactly one matching production server; review configuration');
  resourceUrl(candidates[0].manifest_all_url);
  return candidates[0];
}

export function parseManifest(text) {
  const entries = new Map();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, hash, size, ext, ...extra] = line.trim().split(',');
    assert(!extra.length && name && /^[a-f0-9]{32}$/.test(hash)
      && /^\d+$/.test(size) && /^\.[a-z0-9]+$/i.test(ext), 'Malformed resource manifest entry');
    const entry = { name, hash, size: Number(size), ext };
    if (entries.has(name)) assert.deepEqual(entries.get(name), entry, `Conflicting resource: ${name}`);
    entries.set(name, entry);
  }
  assert(entries.size, 'Empty resource manifest');
  return entries;
}

// Explicit compatibility decisions for upstream duplicate IDs, not a general "last row wins" rule.
// A new conflicting duplicate must stop publication, even if it already has a local card.
const DUPLICATES = {
  'PR-113SC': { sids: [1944, 2355], chosen: 2355, names: ['大自然的导引'], cost: '1' },
  'BP15-SSP08SC': { sids: [4544, 4548], chosen: 4548, names: ['空绝篡夺·奥克托丽丝', '爱绝沉沦·巴娜蕾卡'], name: '爱绝沉沦·巴娜蕾卡' },
};

function groupById(rows) {
  const groups = new Map();
  for (const row of rows) {
    assert(row.card_id && row.card_id !== 'nan', 'Missing card_id');
    groups.set(row.card_id, [...(groups.get(row.card_id) || []), row]);
  }
  return groups;
}

function resolveRows(rows, shortIds = false) {
  const result = new Map();
  for (const [id, group] of groupById(rows)) {
    const distinct = [...new Map(group.map((r) => [JSON.stringify(r), r])).values()];
    if (distinct.length === 1) { result.set(id, distinct[0]); continue; }
    const rule = DUPLICATES[id];
    assert(rule && distinct.length === 2, `Unreviewed duplicate card_id: ${id}`);
    if (shortIds) {
      assert.deepEqual(distinct.map((r) => Number(r.short_id)).sort((a, b) => a - b), rule.sids,
        `Changed duplicate shortId conflict: ${id}`);
      result.set(id, distinct.find((r) => Number(r.short_id) === rule.chosen));
    } else {
      assert.deepEqual([...new Set(distinct.map((r) => r.card_name))].sort(), [...rule.names].sort(),
        `Changed duplicate identity: ${id}`);
      const allowed = id === 'PR-113SC' ? ['cost']
        : ['card_name', 'illustration_id', 'class', 'type', 'cost', 'attack', 'life'];
      for (const field of Object.keys(distinct[0])) {
        assert(allowed.includes(field) || distinct[0][field] === distinct[1][field],
          `Changed duplicate conflict field: ${id}/${field}`);
      }
      const chosen = distinct.filter((r) => rule.name ? r.card_name === rule.name : r.cost === rule.cost);
      assert.equal(chosen.length, 1, `Cannot resolve known duplicate: ${id}`);
      result.set(id, chosen[0]);
    }
  }
  return result;
}

const THEMES = [
  { id: 'uma', boxes: ['CP01', 'CSD01', 'ECP01'], prefix: '赛马娘' },
  { id: 'imas', boxes: ['CP02', 'CSD02A', 'CSD02B', 'CSD02C'], prefix: '灰姑娘偶像' },
  { id: 'pcr', boxes: ['CP04'], prefix: '公主连结' },
];

export function themeOf(row) {
  const boxOf = (s) => (/^([A-Za-z]+\d*[a-z]?)/.exec(s || '')?.[1] || '').toUpperCase();
  return (THEMES.find((t) => t.boxes.includes(boxOf(row.card_box_id)))
    || THEMES.find((t) => t.boxes.includes(boxOf(row.card_id_jpn)))
    || THEMES.find((t) => (row.type || '').startsWith(t.prefix)))?.id;
}

export function buildCards(cardTable, sidTable, entries) {
  requireColumns(cardTable, ['card_id', 'card_box_id', 'card_id_jpn', 'card_name', 'card_mode', 'is_evolve',
    'rarity', 'class', 'category_1', 'category_2', 'type', 'cost', 'attack', 'life', 'skill_text', 'extra_text', 'deckType', '备注']);
  requireColumns(sidTable, ['card_id', 'short_id']);
  const rows = resolveRows(cardTable.rows);
  const sids = resolveRows(sidTable.rows, true);
  const images = new Map();
  for (const e of entries.values()) {
    const match = /^Resources\.卡牌图片\.(.+?)(Jpg|Png)$/.exec(e.name);
    if (match && /^\.(jpg|png)$/.test(e.ext) && !images.has(normalize(match[1]))) {
      images.set(normalize(match[1]), e);
    }
  }
  const number = (s) => s === '' ? null : Number(s);
  return [...rows.values()].map((r) => {
    assert(!r.maxcount || r.maxcount === '3', `Unsupported maxcount for ${r.card_id}`);
    const image = images.get(normalize(r.card_id));
    assert(image, `Missing image mapping: ${r.card_id}`);
    const card = {
      id: r.card_id, box: r.card_box_id, no: r.card_id_jpn, name: r.card_name,
      mode: r.card_mode, evo: r.is_evolve, rare: r.rarity, cls: r.class,
      type: r.category_1, type2: r.category_2, type3: r.type,
      cost: number(r.cost), atk: number(r.attack), life: number(r.life),
      skillText: r.skill_text, extraText: r.extra_text, deckType: r.deckType, note: r['备注'],
      sid: Number(sids.get(r.card_id)?.short_id), md5: image.hash, imgExt: image.ext,
    };
    const theme = themeOf(r);
    assert(!/^(CP|CSD|ECP)\d/i.test(r.card_box_id) || theme, `Unreviewed theme box: ${r.card_box_id}`);
    if (theme) card.theme = theme;
    return card;
  });
}

export function validateCards(cards, previous = []) {
  assert(Array.isArray(cards) && cards.length > 0, 'Card pool must be a nonempty array');
  const ids = new Set(), sids = new Set();
  for (const c of cards) {
    assert(c && typeof c.id === 'string' && c.id && !ids.has(c.id), `Invalid/duplicate card ID: ${c?.id}`);
    assert(Number.isSafeInteger(c.sid) && c.sid > 0 && !sids.has(c.sid), `Invalid/duplicate shortId: ${c.id}`);
    ids.add(c.id); sids.add(c.sid);
    assert(typeof c.name === 'string' && c.name && typeof c.box === 'string' && c.box, `Missing identity: ${c.id}`);
    assert(/^[a-f0-9]{32}$/.test(c.md5) && /^\.(jpg|png)$/.test(c.imgExt), `Invalid image mapping: ${c.id}`);
    for (const key of ['cost', 'atk', 'life']) assert(c[key] === null || Number.isFinite(c[key]), `Invalid ${key}: ${c.id}`);
    for (const key of ['mode', 'evo', 'rare', 'cls', 'type', 'type2', 'type3', 'skillText', 'extraText', 'deckType', 'note']) {
      assert.equal(typeof c[key], 'string', `Invalid ${key}: ${c.id}`);
    }
    assert(!c.theme || THEMES.some((t) => t.id === c.theme), `Unknown theme: ${c.id}`);
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const old of previous) {
    assert(byId.has(old.id), `Previously published card removed: ${old.id}`);
    assert.equal(byId.get(old.id).sid, old.sid, `Previously published shortId changed: ${old.id}`);
    assert(!old.theme || byId.get(old.id).theme === old.theme, `Previously published theme changed: ${old.id}`);
    assert(!old.skillText || byId.get(old.id).skillText, `Previously published effect text removed: ${old.id}`);
  }
  return { count: cards.length, skillTextCount: cards.filter((c) => c.skillText.length > 1).length };
}

export function poolMetadata(cards, cardsText, source, boxTable, updatedAt) {
  requireColumns(boxTable, ['cardbox_id', 'cardbox_name', 'release_day']);
  const boxes = {};
  for (const c of cards) boxes[c.box] = (boxes[c.box] || 0) + 1;
  const bp = Object.keys(boxes).filter((b) => /^BP\d+$/.test(b)).sort((a, b) => Number(b.slice(2)) - Number(a.slice(2)))[0];
  const box = boxTable.rows.find((r) => r.cardbox_id === bp);
  assert(box && box.cardbox_name && /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(box.release_day), 'Missing latest BP box details');
  return {
    schemaVersion: 1, dataVersion: sha256(cardsText), updatedAt,
    ...validateCards(cards), boxes,
    latestBox: { id: bp, name: box.cardbox_name, releaseDay: box.release_day }, source,
  };
}
