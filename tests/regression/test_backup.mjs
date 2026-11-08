/**
 * 备份导入/导出逻辑的单元测试：
 * 直接抽出 app.js 里的 sanitizeDeck / deckSig / mergeBackup 逻辑，
 * 用真实卡组数据验证「合并」策略不会丢数据、也不会重复。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('app.js', 'utf8');
const need = ['deckSig', 'sanitizeDeck', 'mergeBackup'];
const grabbed = [];
for (const name of need) {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  if (!m) { console.error(`抽不到 ${name}`); process.exit(1); }
  grabbed.push(m[0]);
}

const LIMIT = { basicMin: 40, basicMax: 50, evoMin: 0, evoMax: 10, per: 3 };
const state = {
  decks: [],
  deck: { id: 'x', name: '空', poolId: 'theme:pcr', masterSid: null, basic: {}, evo: {}, saved: false },
  all: [],
  bySid: new Map(),
};
const POOLS = [{ id: 'theme:pcr' }, { id: 'theme:uma' }, { id: 'cls:1' }];
const getPool = (id) => POOLS.find((p) => p.id === id) || null;
const isDraft = (d) => Object.keys(d.basic || {}).length + Object.keys(d.evo || {}).length > 0;
const saveStore = () => {};
const renderAll = () => {};
const toast = () => {};

const api = new Function('state', 'LIMIT', 'getPool', 'isDraft', 'saveStore', 'renderAll', 'toast',
  `${grabbed.join('\n')}
   return { deckSig, sanitizeDeck, mergeBackup };`)(state, LIMIT, getPool, isDraft, saveStore, renderAll, toast);

let fail = 0;
const ck = (ok, m) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${m}`); if (!ok) fail += 1; };

// ---------- 1. sanitizeDeck 防御脏数据 ----------
console.log('── sanitizeDeck ──');
ck(api.sanitizeDeck(null) === null, 'null -> null');
ck(api.sanitizeDeck({ basic: {}, evo: {} }) === null, '空卡组 -> null（不导入）');
const s1 = api.sanitizeDeck({ name: '测试', basic: { 941: 3, 952: '2' }, evo: { 1250: 1 }, masterSid: '881', poolId: 'theme:pcr' });
ck(s1 && s1.basic[941] === 3 && s1.basic[952] === 2, '张数从字符串正确转数字');
ck(s1 && s1.masterSid === 881, 'masterSid 转数字');
const s2 = api.sanitizeDeck({ basic: { 941: 99, '-5': 2, abc: 1 }, evo: {} });
ck(s2 && s2.basic[941] === LIMIT.per, `超量张数被截到上限 ${LIMIT.per}`);
ck(s2 && !('-5' in s2.basic) && !('abc' in s2.basic), '非法 sid 被丢弃');
const s3 = api.sanitizeDeck({ basic: { 941: 3 }, poolId: '不存在的卡池' });
ck(s3 && getPool(s3.poolId) !== null, '非法卡池回退到有效值');
ck(api.sanitizeDeck({ name: 'x'.repeat(50), basic: { 1: 1 } }).name.length === 20, '卡组名截到 20 字');

// ---------- 2. 合并：新数据全部导入 ----------
console.log('\n── 合并：空库导入 ──');
state.decks = [{ id: 'local1', name: '本地卡组', poolId: 'theme:pcr', masterSid: 881, basic: { 100: 2 }, evo: {}, saved: true }];
const r1 = api.mergeBackup([
  { id: 'a', name: 'A', poolId: 'theme:uma', masterSid: 900, basic: { 200: 3 }, evo: {} },
  { id: 'b', name: 'B', poolId: 'theme:pcr', masterSid: 901, basic: { 300: 1 }, evo: { 400: 2 } },
]);
ck(r1.added === 2 && r1.skipped === 0, `新增 2 副（实际 added=${r1.added} skipped=${r1.skipped}）`);
ck(state.decks.length === 3, `库内共 3 副（本地 1 + 导入 2），实际 ${state.decks.length}`);
ck(state.decks.some((d) => d.id === 'local1'), '原有卡组没被删掉');

// ---------- 3. 重复导入同一份：应全部跳过 ----------
console.log('\n── 合并：重复导入 ──');
const r2 = api.mergeBackup([
  { id: 'a', name: 'A', poolId: 'theme:uma', masterSid: 900, basic: { 200: 3 }, evo: {} },
  { id: 'b', name: 'B', poolId: 'theme:pcr', masterSid: 901, basic: { 300: 1 }, evo: { 400: 2 } },
]);
ck(r2.added === 0 && r2.skipped === 2, `全部跳过（实际 added=${r2.added} skipped=${r2.skipped}）`);
ck(state.decks.length === 3, `库内仍是 3 副，没产生副本（实际 ${state.decks.length}）`);

// ---------- 4. id 撞车但内容不同 -> 另存为副本 ----------
console.log('\n── 合并：id 撞车内容不同 ──');
const r3 = api.mergeBackup([{ id: 'local1', name: '另一副', poolId: 'theme:pcr', masterSid: 999, basic: { 500: 1 }, evo: {} }]);
ck(r3.added === 1 && r3.copied === 1, `新增 1 副且标记为副本（added=${r3.added} copied=${r3.copied}）`);
const copy = state.decks.find((d) => d.name.includes('导入'));
ck(!!copy && copy.id !== 'local1', `副本用了新 id（${copy ? copy.id : '-'}）`);
ck(state.decks.find((d) => d.id === 'local1').name === '本地卡组', '原卡组内容未被覆盖');

// ---------- 5. 同一副卡组改了名字：内容指纹相同 -> 跳过（避免改名后重复）----------
console.log('\n── 合并：同内容不同名 ──');
const before = state.decks.length;
const r4 = api.mergeBackup([{ id: 'zzz', name: '改了名字的A', poolId: 'theme:uma', masterSid: 900, basic: { 200: 3 }, evo: {} }]);
ck(r4.added === 0 && state.decks.length === before, '内容相同即视为同一副，跳过');

// ---------- 6. 张数顺序不同但内容相同 ----------
console.log('\n── 合并：字段顺序不影响判定 ──');
const r5 = api.mergeBackup([{ id: 'q', name: 'B', poolId: 'theme:pcr', masterSid: 901, basic: { 300: 1 }, evo: { 400: 2 } }]);
ck(r5.added === 0, 'basic/evo 顺序不同也识别为同一副');

// ---------- 7. 脏数据混在备份里 ----------
console.log('\n── 合并：备份含脏数据 ──');
const n = state.decks.length;
const r6 = api.mergeBackup([null, 'x', { basic: {} }, { name: 'OK', basic: { 777: 2 }, evo: {} }]);
ck(r6.added === 1 && r6.skipped === 3, `1 新增 3 跳过（added=${r6.added} skipped=${r6.skipped}）`);
ck(state.decks.length === n + 1, '库内只多了 1 副');

console.log(`\n${fail === 0 ? '═══ 备份逻辑全部通过 ═══' : `═══ 有 ${fail} 项失败 ═══`}`);
process.exitCode = fail ? 1 : 0;
