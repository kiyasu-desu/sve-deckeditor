/**
 * 卡组编辑器静态服务器（无依赖）。
 *
 * 除静态文件外，还提供卡图代理：
 *   GET /img/<md5>.jpg  →  本地缓存命中则直接返回，否则回源网易 CDN 并落盘缓存。
 * 这样浏览器只访问本地，避免直连内测域名可能出现的解析/证书/网络问题，
 * 第二次加载起即为本地读取，滚动不再卡。
 *
 * 用法: node serve.mjs   （PORT 环境变量可改端口，默认 8099）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8099);
const CACHE_DIR = path.join(ROOT, '.imgcache');
const CDN = 'https://betasystem.gsf.netease.com/';

fs.mkdirSync(CACHE_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let cacheHits = 0;
let cacheMiss = 0;

/**
 * GSF 的图片资源并不是真正的图片文件：
 *   文件内容 = base64 文本 → 解码后 = [若干字节资源前缀] + [真正的 JPEG 或 PNG]
 * 两种格式都要认（BP14/BP15/ECP01 等新卡盒的资源就是 PNG）。
 * 返回 { buf, mime }。
 */
const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

function sniff(buf) {
  if (buf.length > 3 && buf.subarray(0, 3).equals(JPEG_MAGIC)) return { buf, mime: 'image/jpeg' };
  if (buf.length > 4 && buf.subarray(0, 4).equals(PNG_MAGIC)) return { buf, mime: 'image/png' };
  return null;
}

function decodeGsfImage(buf) {
  const direct = sniff(buf);
  if (direct) return direct;                       // 已是标准图片
  try {
    const txt = buf.toString('ascii').trim();
    // 资源文本形如 "152/a/a/iVBORw0KGgoAAAAN..." —— 前面还有一段路径前缀，
    // 直接整体 base64 解码会错位（错位结果甚至可能碰巧以 FF D8 FF 开头），
    // 因此直接定位真正的图片 base64 签名。
    const pngAt = txt.indexOf('iVBORw0KGgo');      // PNG 的 base64 开头
    const jpgAt = txt.indexOf('/9j/');             // JPEG 的 base64 开头
    let at = -1;
    let mime = 'image/png';
    if (pngAt >= 0 && (jpgAt < 0 || pngAt < jpgAt)) { at = pngAt; mime = 'image/png'; }
    else if (jpgAt >= 0) { at = jpgAt; mime = 'image/jpeg'; }
    if (at < 0) return { buf, mime: 'application/octet-stream' };

    const b64 = txt.slice(at).replace(/[^A-Za-z0-9+/=]/g, '');
    const bin = Buffer.from(b64, 'base64');
    const got = sniff(bin);
    return got || { buf: bin, mime };
  } catch (e) {
    return { buf, mime: 'application/octet-stream' };
  }
}

function sendImage(res, file) {
  const buf = fs.readFileSync(file);
  const { mime } = sniff(buf) || { mime: 'image/jpeg' };
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=604800' });
  res.end(buf);
}

async function imageProxy(res, md5, ext) {
  if (!/^[0-9a-f]{32}$/.test(md5)) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('bad md5');
    return;
  }
  const cached = path.join(CACHE_DIR, `${md5}.jpg`);   // 本地统一存成 jpg
  if (fs.existsSync(cached)) {
    cacheHits += 1;
    sendImage(res, cached);
    return;
  }
  cacheMiss += 1;
  // 部分卡图在 CDN 上是 .png，按「指定扩展名 → jpg → png」依次尝试
  const exts = [...new Set([ext, '.jpg', '.png'].filter(Boolean))];
  try {
    for (const e of exts) {
      const r = await fetch(`${CDN}${md5}${e}`);
      if (!r.ok) continue;
      const { buf, mime } = decodeGsfImage(Buffer.from(await r.arrayBuffer()));
      fs.writeFileSync(cached, buf);
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=604800' });
      res.end(buf);
      if (cacheMiss % 50 === 0) {
        console.log(`[img] fetched ${cacheMiss} (cached ${cacheHits})`);
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('cdn 404 (tried ' + exts.join(' ') + ')');
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('cdn error: ' + e.message);
  }
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);

  if (rel.startsWith('/img/')) {
    const tail = rel.slice(5);
    const dot = tail.lastIndexOf('.');
    const md5 = dot > 0 ? tail.slice(0, dot) : tail;
    const ext = dot > 0 ? tail.slice(dot).toLowerCase() : '';
    imageProxy(res, md5, ext === '.png' ? '.png' : '.jpg');
    return;
  }

  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found: ' + rel);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    // data/ 下的 json 与页面代码（html/css/js）都随版本变化，必须每次校验；
    // 只有图片可以长缓存。
    const noStore = ext === '.html' || ext === '.css' || ext === '.js' || ext === '.json';
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': noStore ? 'no-cache, no-store, must-revalidate' : 'public, max-age=604800',
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[SVE deck editor] http://127.0.0.1:${PORT}/`);
  console.log(`root:  ${ROOT}`);
  console.log(`cache: ${CACHE_DIR}`);
});
