/** Run from any directory: node scripts/update-cards.mjs [--apply]. Default is read-only. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import CryptoJS from '../lib/crypto-js.js';
import {
  DISCOVERY_URL, CDN, sha256, parseCsv, parseManifest, selectProductionServer,
  resourceUrl, buildCards, validateCards, poolMetadata,
} from './card-pool.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_BYTES = 12 * 1024 * 1024;

// Redirects and response sizes are bounded; no authenticated requests are made.
export async function downloadText(url, fetchImpl = fetch) {
  assertUrl(url);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) throw new Error('Response exceeds size limit');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (attempt === 2) throw new Error(`Download failed: ${new URL(url).pathname}: ${error.message}`);
    }
  }
}

function assertUrl(url) {
  if (url !== DISCOVERY_URL) resourceUrl(url);
}

export async function updateCards({ root = DEFAULT_ROOT, key = process.env.SVE_TABLE_KEY,
  apply = false, fetchImpl = fetch, now = () => new Date().toISOString(),
  appVersion = process.env.SVE_APP_VERSION || '1.2.0' } = {}) {
  if (!key) throw new Error('SVE_TABLE_KEY is required; configure it outside the public repository');
  const cardsPath = path.join(root, 'data/cards.json');
  const metadataPath = path.join(root, 'data/pool-version.json');
  const previousText = await fs.readFile(cardsPath, 'utf8');
  const previous = JSON.parse(previousText);
  validateCards(previous);
  let previousMeta = null;
  try { previousMeta = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const server = selectProductionServer(JSON.parse(await downloadText(DISCOVERY_URL, fetchImpl)), { appVersion });
  const manifestText = await downloadText(server.manifest_all_url, fetchImpl);
  const entries = parseManifest(manifestText);
  const tableNames = ['卡牌配表Utf8Csv', 'cardMasterShortIdCsv', '卡盒配表Utf8Csv'];
  const tableResources = tableNames.map((name) => {
    const entry = entries.get('Resources.配表.' + name);
    if (!entry || entry.ext !== '.csv') throw new Error(`Missing table resource: ${name}`);
    return entry;
  });
  const tables = await Promise.all(tableResources.map(async (e) => {
    const text = await downloadText(CDN + e.hash + e.ext, fetchImpl);
    let plain;
    try {
      plain = CryptoJS.AES.decrypt(text.trim(), CryptoJS.enc.Utf8.parse(key), {
        mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7,
      }).toString(CryptoJS.enc.Utf8);
    } catch { throw new Error(`Cannot decrypt table: ${e.name}`); }
    if (!plain || !plain.includes(',')) throw new Error(`Empty or invalid decrypted table: ${e.name}`);
    return parseCsv(plain);
  }));
  const cards = buildCards(tables[0], tables[1], entries);
  validateCards(cards, previous);
  const text = JSON.stringify(cards);
  const source = {
    discoveryUrl: DISCOVERY_URL, manifestUrl: server.manifest_all_url,
    manifestSha256: sha256(manifestText), platform: server.platform,
    appVersion: server.appVer, channel: server.channel,
    tables: Object.fromEntries(tableResources.map((e) => [e.name, e.hash])),
  };
  const metadata = poolMetadata(cards, text, source, tables[2], now());
  // Do not rewrite updatedAt on an unchanged run. Source-only changes remain reviewable updates.
  const stable = (m) => m && JSON.stringify({ ...m, updatedAt: null });
  const changed = text !== previousText || stable(metadata) !== stable(previousMeta);
  const previousIds = new Set(previous.map((c) => c.id));
  const result = { changed, applied: apply && changed, count: cards.length,
    added: cards.filter((c) => !previousIds.has(c.id)).length,
    latestBox: metadata.latestBox.id, dataVersion: metadata.dataVersion };
  if (apply && changed) {
    // Both candidates are validated before touching either published file. Git publishes the pair together.
    const staged = [cardsPath + '.tmp', metadataPath + '.tmp'];
    try {
      await fs.writeFile(staged[0], text);
      await fs.writeFile(staged[1], JSON.stringify(metadata, null, 2) + '\n');
      await fs.rename(staged[0], cardsPath);
      await fs.rename(staged[1], metadataPath);
    } finally {
      await Promise.all(staged.map((p) => fs.rm(p, { force: true })));
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--apply')) throw new Error('Usage: node scripts/update-cards.mjs [--apply]');
    const result = await updateCards({ apply: args.includes('--apply') });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${result.applied}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `卡池检查：${result.count} 张，新增 ${result.added} 张，最新 ${result.latestBox}。${result.applied ? '已生成候选更新。' : '未写入文件。'}\n`);
  } catch (error) {
    console.error('Card-pool update stopped:', error.message);
    process.exitCode = 1;
  }
}
