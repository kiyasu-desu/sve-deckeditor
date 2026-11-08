import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import CryptoJS from '../lib/crypto-js.js';
import {
  DISCOVERY_URL, PRODUCTION_API, CDN, parseCsv, parseManifest, selectProductionServer,
  resourceUrl, buildCards, validateCards, themeOf, sha256,
} from '../scripts/card-pool.mjs';
import { updateCards, downloadText } from '../scripts/update-cards.mjs';

const columns = ['card_box_id', 'card_id', 'card_id_jpn', 'card_mode', 'is_evolve', 'rarity',
  'card_name', 'illustration_id', 'class', 'category_1', 'category_2', 'type', 'cost', 'attack',
  'life', 'skill_text', 'extra_text', 'link_cards', 'deckType', '备注', 'maxcount'];
const row = (overrides = {}) => Object.fromEntries(columns.map((k) => [k, ({
  card_box_id: 'BP01', card_id: 'BP01-001SC', card_id_jpn: 'BP01-001', card_mode: '基本',
  rarity: 'LG', card_name: '测试卡', class: '精灵', category_1: '随从', type: '植物族',
  cost: '1', attack: '2', life: '3', skill_text: '效果，包含逗号\n以及"引号"', ...overrides,
})[k] || '']));
const table = (rows, header = columns) => ({ header, rows });
const sids = (rows) => table(rows, ['card_id', 'short_id']);
const manifestUrl = CDN + 'shadowverse_card/manifest/test-all_manifest.manifest';
const server = { address: PRODUCTION_API, platform: 'android', appVer: '1.2.0',
  channel: 'all', isDebug: '0', server: '正式服android-1.2.0', manifest_all_url: manifestUrl };
const discovery = (items = [server]) => ({ status: 'success', items });
const image = (id, hash = 'a'.repeat(32)) => ({ name: `Resources.卡牌图片.${id.replaceAll('-', '')}Jpg`, hash, size: 100, ext: '.jpg' });
const imageMap = (...ids) => new Map(ids.map((id) => { const e = image(id); return [e.name, e]; }));
const baseCards = () => buildCards(table([row()]), sids([{ card_id: 'BP01-001SC', short_id: '1' }]), imageMap('BP01-001SC'));
const csv = (header, rows) => '\uFEFF' + [header, ...rows.map((r) => header.map((k) => r[k] || ''))]
  .map((r) => r.map((s) => '"' + s.replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';

test('CSV handles BOM, quoted commas, embedded newlines and escaped quotes', () => {
  assert.deepEqual(parseCsv(csv(columns, [row()])), table([row()]));
  assert.throws(() => parseCsv('id,name\n1,"broken'), /Unterminated/);
  assert.throws(() => parseCsv('id,name\n1,2,3'), /width/);
  assert.throws(() => parseCsv('id,id\n1,2'), /header/);
});

test('discovery selects the exact production configuration, never a newer test server', () => {
  const payload = discovery([{ ...server, address: 'https://test.invalid', server: '测试服', manifest_all_url: CDN + 'newer' }, server]);
  assert.deepEqual(selectProductionServer(payload), server);
  assert.throws(() => selectProductionServer(discovery([{ ...server, server: '测试服' }])), /exactly one/);
  assert.throws(() => selectProductionServer(discovery([{ ...server, appVer: '9.0' }])), /exactly one/);
  assert.throws(() => selectProductionServer(discovery([server, server])), /exactly one/);
  assert.throws(() => selectProductionServer(discovery([{ ...server, manifest_all_url: 'https://other.invalid/x' }])), /approved CDN/);
  assert.throws(() => resourceUrl('https://user:pass@betasystem.gsf.netease.com/x'), /approved CDN/);
});

test('manifest rejects malformed or conflicting resources', () => {
  const line = `Resources.配表.test,${'a'.repeat(32)},10,.csv`;
  assert.equal(parseManifest(line).size, 1);
  assert.equal(parseManifest(line + '\n' + line).size, 1);
  assert.throws(() => parseManifest(line + '\n' + line.replace(',10,', ',11,')), /Conflicting/);
  assert.throws(() => parseManifest('bad,data'), /Malformed/);
});

test('theme attribution handles PR reprints and mixed-case starter boxes', () => {
  assert.equal(themeOf(row({ card_box_id: 'PR', card_id_jpn: 'CP04-048SC' })), 'pcr');
  assert.equal(themeOf(row({ card_box_id: 'CSD02b' })), 'imas');
  assert.equal(themeOf(row({ card_box_id: 'PR', type: '赛马娘·其他' })), 'uma');
  assert.equal(themeOf(row()), undefined);
});

test('known duplicate conflicts preserve the published identity; new conflicts stop', () => {
  const a = row({ card_id: 'PR-113SC', card_name: '大自然的导引', cost: '' });
  const b = { ...a, cost: '1' };
  const st = sids([{ card_id: a.card_id, short_id: '1944' }, { card_id: a.card_id, short_id: '2355' }]);
  const cards = buildCards(table([a, b]), st, imageMap(a.card_id));
  assert.equal(cards[0].sid, 2355);
  assert.equal(cards[0].cost, 1);
  assert.deepEqual(buildCards(table([b, a]), st, imageMap(a.card_id)), cards);
  assert.throws(() => buildCards(table([a, { ...b, skill_text: 'new conflict' }]), st, imageMap(a.card_id)), /conflict field/);
  assert.throws(() => buildCards(table([row(), row({ cost: '2' })]), sids([]), imageMap('BP01-001SC')), /Unreviewed duplicate/);
  const royal = row({ card_id: 'BP15-SSP08SC', card_name: '空绝篡夺·奥克托丽丝', class: '皇家护卫' });
  const nightmare = { ...royal, card_name: '爱绝沉沦·巴娜蕾卡', class: '梦魇' };
  const bp15 = buildCards(table([nightmare, royal]), sids([
    { card_id: royal.card_id, short_id: '4544' }, { card_id: royal.card_id, short_id: '4548' },
  ]), imageMap(royal.card_id));
  assert.equal(bp15[0].sid, 4548); assert.equal(bp15[0].cls, '梦魇');
});

test('validation protects old deck references, themes, IDs and image data', () => {
  const cards = baseCards();
  assert.equal(validateCards(cards).count, 1);
  assert.throws(() => validateCards(cards, [{ ...cards[0], id: 'missing' }]), /removed/);
  assert.throws(() => validateCards(cards, [{ ...cards[0], sid: 2 }]), /shortId changed/);
  assert.throws(() => validateCards(cards, [{ ...cards[0], theme: 'pcr' }]), /theme changed/);
  assert.throws(() => validateCards([{ ...cards[0], skillText: '' }], cards), /effect text removed/);
  assert.throws(() => validateCards([...cards, cards[0]]), /duplicate card ID/);
  assert.throws(() => validateCards([...cards, { ...cards[0], id: 'other' }]), /duplicate shortId/);
  assert.throws(() => validateCards([{ ...cards[0], md5: '' }]), /image mapping/);
  assert.throws(() => buildCards(table([row({ maxcount: '4' })]), sids([]), imageMap('BP01-001SC')), /Unsupported maxcount/);
  assert.throws(() => buildCards(table([row({ card_box_id: 'CP99' })]), sids([{ card_id: 'BP01-001SC', short_id: '1' }]), imageMap('BP01-001SC')), /Unreviewed theme/);
  assert.throws(() => buildCards(table([row()]), sids([]), new Map()), /Missing image/);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sve-pool-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  const cards = baseCards();
  const oldText = JSON.stringify(cards);
  await fs.writeFile(path.join(root, 'data/cards.json'), oldText);
  const key = 'fixture-only';
  const added = row({ card_id: 'BP20-001SC', card_box_id: 'BP20' });
  const inputs = [table([row(), added]), sids([{ card_id: 'BP01-001SC', short_id: '1' }, { card_id: added.card_id, short_id: '2' }]),
    table([{ cardbox_id: 'BP20', cardbox_name: '测试卡盒', release_day: '2026.11.5' }], ['cardbox_id', 'cardbox_name', 'release_day'])];
  const names = ['卡牌配表Utf8Csv', 'cardMasterShortIdCsv', '卡盒配表Utf8Csv'];
  const resources = inputs.map((_, i) => ({ name: 'Resources.配表.' + names[i], hash: String(i + 1).repeat(32), size: 100, ext: '.csv' }));
  const all = [...resources, image('BP01-001SC'), image(added.card_id)];
  const responses = new Map([[DISCOVERY_URL, JSON.stringify(discovery())],
    [manifestUrl, all.map((e) => [e.name, e.hash, e.size, e.ext].join(',')).join('\n')]]);
  const encrypt = (input) => CryptoJS.AES.encrypt(csv(input.header, input.rows), CryptoJS.enc.Utf8.parse(key),
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString();
  const setTable = (index) => responses.set(CDN + resources[index].hash + '.csv', encrypt(inputs[index]));
  inputs.forEach((_, i) => setTable(i));
  const fetchImpl = async (url) => {
    assert(responses.has(url), 'Unexpected network request: ' + url);
    return new Response(responses.get(url));
  };
  return { root, key, fetchImpl, responses, inputs, setTable, oldText };
}

test('updater dry run writes nothing; apply is repeatable and metadata matches the bytes', async (t) => {
  const f = await fixture(t);
  const dry = await updateCards(f);
  assert.equal(dry.changed, true); assert.equal(dry.applied, false); assert.equal(dry.added, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'data/cards.json'), 'utf8'), f.oldText);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), ['cards.json']);
  const first = await updateCards({ ...f, apply: true, now: () => '2026-11-08T00:00:00.000Z' });
  assert.equal(first.applied, true);
  const text = await fs.readFile(path.join(f.root, 'data/cards.json'), 'utf8');
  const metadataText = await fs.readFile(path.join(f.root, 'data/pool-version.json'), 'utf8');
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.dataVersion, sha256(text)); assert.equal(metadata.count, 2);
  const second = await updateCards({ ...f, apply: true, now: () => '2030-01-01T00:00:00.000Z' });
  assert.equal(second.changed, false); assert.equal(second.applied, false);
  assert.equal(await fs.readFile(path.join(f.root, 'data/pool-version.json'), 'utf8'), metadataText);
});

test('failed download, bad key, missing image or changed old shortId never replace published data', async (t) => {
  const f = await fixture(t);
  await assert.rejects(updateCards({ ...f, key: '', apply: true }), /SVE_TABLE_KEY/);
  await assert.rejects(updateCards({ ...f, key: 'wrong-fixture-key', apply: true }), /decrypt|decrypted/);
  f.inputs[1].rows[0].short_id = '999'; f.setTable(1);
  await assert.rejects(updateCards({ ...f, apply: true }), /shortId changed/);
  f.inputs[1].rows[0].short_id = '1'; f.setTable(1);
  f.responses.set(manifestUrl, f.responses.get(manifestUrl).split('\n').filter((l) => !l.includes('BP20001SC')).join('\n'));
  await assert.rejects(updateCards({ ...f, apply: true }), /Missing image/);
  await assert.rejects(updateCards({ ...f, apply: true, fetchImpl: async () => new Response('', { status: 503 }) }), /HTTP 503/);
  assert.equal(await fs.readFile(path.join(f.root, 'data/cards.json'), 'utf8'), f.oldText);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), ['cards.json']);
});

test('downloader retries transient failures and refuses redirects outside the allowlist', async () => {
  let attempts = 0;
  const text = await downloadText(DISCOVERY_URL, async (_, options) => {
    assert.equal(options.redirect, 'error');
    attempts += 1;
    return new Response(attempts === 1 ? '' : 'ok', { status: attempts === 1 ? 503 : 200 });
  });
  assert.equal(text, 'ok'); assert.equal(attempts, 2);
  await assert.rejects(downloadText('https://untrusted.invalid/'), /approved CDN/);
});
