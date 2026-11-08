/**
 * 回归测试：新建卡组不应删掉已载入的卡组。
 *
 * 复现步骤（用户报告）：
 *   我的卡组 → 载入一副 → 左上返回 → 开始组卡 → 返回 → 卡组没了
 *
 * 直接抽出真实的 startNewDeck / isDraft / deckCounts / newDeck 逻辑，
 * 用与页面相同的 state 结构跑一遍。
 */
import fs from 'node:fs';

const src = fs.readFileSync('app.js', 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  if (!m) { console.error(`抽不到 ${name}`); process.exit(1); }
  return m[0];
};

const LIMIT = { basicMin: 40, basicMax: 50, evoMin: 0, evoMax: 10, per: 3 };
const state = { decks: [], deck: null };
const saveStore = () => {};
const renderAll = () => {};
const showView = () => {};
const openWizard = () => {};

const api = new Function('state', 'saveStore', 'renderAll', 'showView', 'openWizard',
  `${grab('newDeck')}\n${grab('deckCounts')}\n${grab('isDraft')}\n${grab('startNewDeck')}
   return { newDeck, deckCounts, isDraft, startNewDeck };`)(
  state, saveStore, renderAll, showView, openWizard);

let fail = 0;
const ck = (ok, m) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${m}`); if (!ok) fail += 1; };

// 一副合法的「组好的卡组」
const built = {
  id: 'built1', name: '横马', poolId: 'theme:uma', masterSid: 881,
  basic: { 941: 3, 952: 3, 3903: 3, 3905: 1 }, evo: { 1250: 2 },
  saved: true,
};

console.log('── 场景1：载入已保存的卡组后点「开始组卡」 ──');
state.decks = [built, api.newDeck()];
state.deck = built;                       // 从「我的卡组」载入
api.startNewDeck();
ck(state.decks.some((d) => d.id === 'built1'), '载入的卡组仍在列表里');
const kept = state.decks.find((d) => d.id === 'built1');
ck(kept && kept.basic[941] === 3 && kept.evo[1250] === 2, '内容完好（basic/evo 未被改动）');
ck(kept && kept.name === '横马' && kept.masterSid === 881, '名称与主战者未被改动');
ck(state.deck.id !== 'built1', '当前卡组已切换到新的空卡组');
ck(!api.isDraft(state.deck), '新卡组是空的（可继续走向导）');

console.log('\n── 场景2：连点多次「开始组卡」 ──');
const before = state.decks.filter((d) => api.isDraft(d)).length;
api.startNewDeck(); api.startNewDeck(); api.startNewDeck();
const after = state.decks.filter((d) => api.isDraft(d)).length;
ck(after === before, `有内容的卡组数不变（${before} -> ${after}）`);
ck(state.decks.filter((d) => api.isDraft(d)).some((d) => d.id === 'built1'), 'built1 仍在');
ck(state.decks.filter((d) => !api.isDraft(d)).length <= 1, '空壳卡组不会累积（最多 1 个）');

console.log('\n── 场景3：未完成的草稿也不该被删 ──');
const draft = { id: 'draft1', name: '半成品', poolId: 'theme:pcr', masterSid: null, basic: { 100: 5 }, evo: {}, saved: false };
state.decks.push(draft);
state.deck = draft;
api.startNewDeck();
ck(state.decks.some((d) => d.id === 'draft1'), '未完成的草稿被保留（不会变成孤儿）');

console.log('\n── 场景4：多副卡组共存 ──');
const built2 = { id: 'built2', name: '鲅鱼妖', poolId: 'theme:pcr', masterSid: 900, basic: { 200: 3 }, evo: {}, saved: true };
state.decks.push(built2);
state.deck = built2;
api.startNewDeck();
const ids = state.decks.filter((d) => api.isDraft(d)).map((d) => d.id).sort();
ck(ids.includes('built1') && ids.includes('built2') && ids.includes('draft1'), `全部保留：${ids.join(', ')}`);

console.log('\n── 场景5：空壳卡组仍会被回收（不无限增长）──');
const empties0 = state.decks.filter((d) => !api.isDraft(d)).length;
for (let i = 0; i < 5; i += 1) api.startNewDeck();
const empties1 = state.decks.filter((d) => !api.isDraft(d)).length;
ck(empties1 <= 1, `空壳数量 ${empties0} -> ${empties1}（不会累积）`);

console.log(`\n${fail === 0 ? '═══ 回归测试全部通过 ═══' : `═══ 有 ${fail} 项失败 ═══`}`);
process.exitCode = fail ? 1 : 0;
