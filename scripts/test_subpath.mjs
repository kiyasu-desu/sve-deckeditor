/**
 * 模拟 GitHub Pages 的子路径部署：把站点挂在 /sve-deckeditor/ 下，
 * 验证所有资源引用是否仍然可达（根绝对路径会在这里暴露）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PREFIX = '/sve-deckeditor/';       // 模拟 Pages 的子路径
const PORT = 8301;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (!rel.startsWith(PREFIX)) {
    res.writeHead(404).end('outside prefix');
    return;
  }
  rel = rel.slice(PREFIX.length);
  const file = path.join(ROOT, rel === '' ? 'index.html' : rel);
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + rel); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}${PREFIX}`;
console.log(`模拟 Pages 子路径: ${BASE}\n`);

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fail += 1; };

// 1. 首页可访问
const home = await fetch(BASE + 'index.html');
const html = await home.text();
check(home.ok, `首页可访问 (${home.status})`);

// 2. 页面内所有相对引用都能取到
const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
  .filter((r) => !r.startsWith('http') && !r.startsWith('data:'));
console.log(`\n页面引用 ${refs.length} 个资源：`);
for (const r of refs) {
  const url = new URL(r, BASE).href;
  const res = await fetch(url, { method: 'GET' });
  check(res.ok, `${r}  -> ${res.status}`);
}

// 3. 关键数据文件
console.log('\n关键数据：');
for (const p of ['data/cards.json', 'lib/crypto-js.js', 'icons/classButton01.on.png', 'style-mobile.css']) {
  const res = await fetch(BASE + p);
  check(res.ok, `${p}  -> ${res.status}  ${((await res.arrayBuffer()).byteLength / 1024).toFixed(0)}KB`);
}

// 4. 页面里不应存在根绝对路径
const abs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
check(abs.length === 0, `无根绝对路径 ${abs.length ? '（发现 ' + abs.join(', ') + '）' : ''}`);

// 5. app.js 里不应有根绝对请求
const app = fs.readFileSync('app.js', 'utf8');
const appAbs = [...app.matchAll(/fetch\(['"]\/([^'"]*)/g)].map((m) => m[1]);
check(appAbs.length === 0, `app.js 无根绝对 fetch ${appAbs.length ? '（发现 ' + appAbs.join(', ') + '）' : ''}`);

server.close();
console.log(`\n${fail === 0 ? '子路径部署验证通过 ✓' : `有 ${fail} 项失败`}`);
process.exitCode = fail ? 1 : 0;
