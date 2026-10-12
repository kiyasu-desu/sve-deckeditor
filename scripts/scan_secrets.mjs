/**
 * 提交前凭据扫描。
 *
 * 设计要点：**本文件不包含任何本项目的具体密钥值**。
 * 具体值（appKey、uid、昵称等）放在仓库外的本地文件里：
 *     ../ops/secret-patterns.json     形如 ["值1", "值2"]
 * 也可以用环境变量 SVE_SECRET_FILE 指定别的路径。
 *
 * 这样扫描器本身可以安全提交 —— 否则它会变成「把密钥写在源码里的密钥扫描器」，
 * 反而把要保护的东西公开出去。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();                  // 应在 dist/ 下运行

// ---------- 通用形状：不含任何具体值，可以安全提交 ----------
const SHAPE = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '私钥（PEM）' },
  { re: /ssh-(?:ed25519|rsa|ecdsa) AAAA/, why: 'SSH 公钥' },
  { re: /ghp_[A-Za-z0-9]{20,}/, why: 'GitHub PAT' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, why: 'GitHub PAT (fine-grained)' },
  { re: /AKIA[0-9A-Z]{16}/, why: 'AWS Access Key' },
  { re: /AIza[0-9A-Za-z_-]{35}/, why: 'Google API Key' },
  // 32 字节的 base64 常量（AES-256 key 的常见形态）
  { re: /["'][A-Za-z0-9+/]{43}=["']/, why: '疑似 32 字节 base64 密钥' },
  { re: /(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[:=]\s*["'][^"']{8,}["']/i, why: '明文口令 / token 赋值' },
];

// ---------- 项目特定值：从仓库外的本地文件读 ----------
function loadLocalPatterns() {
  const file = process.env.SVE_SECRET_FILE
    || path.resolve(ROOT, '..', 'ops', 'secret-patterns.json');
  if (!fs.existsSync(file)) return { file, list: [] };
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr)) return { file, list: [] };
    return { file, list: arr.filter((s) => typeof s === 'string' && s.length >= 4) };
  } catch (e) {
    return { file, list: [], error: e.message };
  }
}

const local = loadLocalPatterns();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BLOCK = SHAPE.concat(
  local.list.map((v) => ({ re: new RegExp(escape(v)), why: '项目特定值（来自本地模式文件）' })),
);

// ---------- 遍历仓库文件 ----------
const files = [];
const SKIP = new Set([path.join(ROOT, '.git')]);
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.has(p)) continue;
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
}(ROOT));

console.log(`扫描 ${files.length} 个文件`);
console.log(`通用形状规则 ${SHAPE.length} 条`);
if (local.list.length) {
  console.log(`项目特定值 ${local.list.length} 条（来自 ${path.relative(ROOT, local.file)}）`);
} else {
  console.log(`未找到项目特定值文件（${path.relative(ROOT, local.file)}），只做通用形状扫描`);
}
console.log('');

const hits = [];
for (const f of files) {
  const text = fs.readFileSync(f).toString('latin1');
  const rel = path.relative(ROOT, f);
  for (const b of BLOCK) {
    const m = text.match(b.re);
    if (m) hits.push({ file: rel, why: b.why, len: m[0].length });
  }
}

// ---------- 白名单：已知且可接受的情况 ----------
// 按「文件 + 规则」匹配，不写具体值（写了就又变成泄露）。
const ALLOW = [
  {
    file: 'app.js', why: '疑似 32 字节 base64 密钥',
    note: '卡组码的 AES key —— 前端要生成卡组码就必须带着它，本来就是公开常量',
  },
  {
    file: path.join('scripts', 'deckcode.mjs'), why: '疑似 32 字节 base64 密钥',
    note: '同上（卡组码工具）',
  },
  {
    file: '.gitignore', why: '项目特定值（来自本地模式文件）',
    note: '.gitignore 里出现的只是排除用的文件名模式，不是值本身',
  },
];

const allowed = [];
const real = [];
for (const h of hits) {
  const a = ALLOW.find((x) => x.file === h.file && x.why === h.why);
  if (a) allowed.push({ ...h, note: a.note }); else real.push(h);
}

console.log('=== 命中 ===');
if (!hits.length) console.log('  ✓ 无');

if (real.length) {
  console.log('  ✗ 需要处理：');
  for (const h of real) console.log(`      ${h.file}  ${h.why}  （匹配 ${h.len} 字符，值不回显）`);
}

if (allowed.length) {
  console.log('\n  ○ 已知且可接受（白名单）：');
  for (const h of allowed) console.log(`      ${h.file}  —— ${h.note}`);
}

console.log(`\n结论：需处理 ${real.length} 处，白名单 ${allowed.length} 处`);
process.exitCode = real.length ? 1 : 0;
