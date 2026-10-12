/** 发布前总检：语法、结构、凭据、子路径、数据完整性一次跑完。 */
import fs from 'node:fs';
import zlib from 'node:zlib';

let fail = 0;
const say = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fail += 1; };
const section = (t) => console.log(`\n── ${t} ──`);

// ---------- 1. 语法 ----------
section('语法');
// 注意：本沙箱禁止 spawn 子进程（EPERM），因此用进程内解析校验语法
function syntaxOk(file) {
  try {
    let src = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.mjs')) {
      // ESM：剥掉顶层 import 语句后用 Function 解析其余部分
      src = src.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
      src = src.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
      // 顶层 await 在 Function 里不合法，包进 async IIFE
      src = `(async()=>{\n${src}\n})`;
    }
    new Function(src);   // eslint-disable-line no-new-func
    return true;
  } catch (e) {
    console.log(`      ${e.message}`);
    return false;
  }
}
say(syntaxOk('app.js'), 'app.js 语法正确');
say(syntaxOk('serve.mjs'), 'serve.mjs 语法正确');

// ---------- 2. 结构 ----------
section('结构');
const app = fs.readFileSync('app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const used = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !html.includes(`id="${id}"`));
say(missing.length === 0, `$() 引用的 ${used.size} 个元素都存在`);
const all = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const dup = [...new Set(all.filter((x, i) => all.indexOf(x) !== i))];
say(dup.length === 0, `无重复 id（共 ${all.length} 个）`);
say(!/(href|src)="\//.test(html), 'HTML 无根绝对路径');

// ---------- 3. 数据 ----------
section('数据');
const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
say(cards.length === 6053, `卡表 ${cards.length} 张（应为 6053）`);
say(cards.every((c) => c.sid), '所有卡都有 shortId');
const withImg = cards.filter((c) => c.md5);
say(withImg.length === 6053, `有卡图 ${withImg.length} 张（应为 6053，即全部）`);
const withSkill = cards.filter((c) => c.skillText && c.skillText.length > 1);
say(withSkill.length === 5823, `有效果文本 ${withSkill.length} 张（应为 5823）`);

// 不再依赖 thumbs.json
say(!app.includes('thumbs.json'), '已不依赖 thumbs.json');
say(!fs.existsSync('data/thumbs.json'), 'thumbs.json 未随仓库发布');

// ---------- 4. 图标 ----------
section('图标');
function pngRows(buf) {
  const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
  const ch = buf[25] === 6 ? 4 : buf[25] === 2 ? 3 : 1;
  const idats = []; let pos = 8; let complete = false;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const t = buf.subarray(pos + 4, pos + 8).toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(t)) break;
    const end = pos + 8 + len + 4;
    if (end > buf.length) { idats.push(buf.subarray(pos + 8, buf.length)); break; }
    if (t === 'IDAT') idats.push(buf.subarray(pos + 8, pos + 8 + len));
    if (t === 'IEND') { complete = true; break; }
    pos = end;
  }
  const out = [];
  const inf = zlib.createInflate();
  return new Promise((res) => {
    inf.on('data', (c) => out.push(c));
    inf.on('end', () => res({ lines: Math.floor(Buffer.concat(out).length / (1 + w * ch)), h, complete }));
    inf.on('error', () => res({ lines: Math.floor(Buffer.concat(out).length / (1 + w * ch)), h, complete }));
    inf.end(Buffer.concat(idats));
  });
}
const ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9];
let iconOk = 0;
for (const i of ORDER) {
  const f = `icons/classButton${String(i).padStart(2, '0')}.on.png`;
  const r = await pngRows(fs.readFileSync(f));
  if (r.lines >= r.h) iconOk += 1;
}
say(iconOk === 9, `9 张职业图标全部可完整渲染（${iconOk}/9）`);

// ---------- 5. 卡组码算法 ----------
section('卡组码');
say(fs.existsSync('lib/crypto-js.js'), 'crypto-js 已随仓库发布');
say(app.includes('encryptDeckCode') || app.includes('CryptoJS.AES.encrypt'), 'app.js 含加密实现');
// 配表解密密钥的具体值不写在这里（那本身就是泄露）。
// 按确切值检查请用 scan_secrets.mjs（它从仓库外的本地文件读具体值）。
// 这里只做一个粗检查：仓库里不应出现「配表解密」相关的工具脚本。
say(!fs.existsSync('scripts/decrypt_tables.mjs') && !fs.existsSync('scripts/rebuild_from_tables.mjs'),
  '不含配表解密工具');

// ---------- 6. 移动端 ----------
section('移动端');
const mcss = fs.readFileSync('style-mobile.css', 'utf8');
say(html.includes('style-mobile.css'), '引入了移动端样式');
say(mcss.includes('.qty-overlay'), '含卡片数量浮层样式');
say(app.includes('IS_TOUCH'), '含触摸设备判定');
say(app.includes('attachQtyOverlay'), '含浮层挂载逻辑');
say(app.includes('restoreQtyCard'), '含重绘后恢复浮层');

// ---------- 7. 体积 ----------
section('体积');
const walk = (d, acc = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
};
const files = walk('.');
const bytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
say(bytes < 5 * 1024 * 1024, `仓库 ${(bytes / 1024 / 1024).toFixed(2)} MB（目标 <5MB）`);
const big = files.filter((f) => fs.statSync(f).size > 100 * 1024 * 1024);
say(big.length === 0, '无超过 GitHub 100MB 单文件限制的文件');
say(fs.existsSync('.nojekyll'), '.nojekyll 已就位（Pages 跳过 Jekyll）');
say(fs.existsSync('push.ps1'), 'push.ps1 已就位');


// ---------- 8. 版本号一致性 ----------
section('版本号');
const htmlV = [...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
const appV = (app.match(/const VERSION = 'v(\d+)'/) || [])[1];
say(htmlV.length > 0 && new Set(htmlV).size === 1, `index.html 引用版本统一（${[...new Set(htmlV)].join(',')}）`);
say(appV && htmlV.every((v) => v === appV), `app.js VERSION=v${appV} 与引用一致`);
console.log(`\n${fail === 0 ? '═══ 发布前总检全部通过 ═══' : `═══ 有 ${fail} 项失败 ═══`}`);
process.exitCode = fail ? 1 : 0;
