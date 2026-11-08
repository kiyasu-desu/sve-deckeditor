import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { sha256 } from '../scripts/card-pool.mjs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const source = app.match(/async function loadCardPool\(\) \{[\s\S]*?\n  \}\n\n/)[0];
const text = JSON.stringify([{ id: 'BP20-001SC', sid: 6058 }]);
const metadata = { schemaVersion: 1, dataVersion: sha256(text), count: 1 };
function loader(fetch) {
  return vm.runInNewContext(`${source}; loadCardPool`, {
    fetch, VERSION: 'v64', crypto: webcrypto, TextDecoder, Uint8Array,
  });
}

test('browser requests fresh metadata and keys cards by data content, independently of app version', async () => {
  const calls = [];
  const result = await loader(async (url, options) => {
    calls.push({ url, options });
    return new Response(url.includes('pool-version') ? JSON.stringify(metadata) : text);
  })();
  assert.equal(result.cards[0].sid, 6058);
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[1].url, 'data/cards.json?v=' + metadata.dataVersion);
});

test('older deployment without metadata remains loadable', async () => {
  const calls = [];
  const result = await loader(async (url) => {
    calls.push(url);
    return url.includes('pool-version') ? new Response('', { status: 404 }) : new Response(text);
  })();
  assert.equal(result.cards.length, 1);
  assert.equal(result.metadata, null);
  assert.equal(calls[1], 'data/cards.json?v=v64');
});

test('mixed cached deployments retry the pair; persistent content corruption stops boot', async () => {
  let cardRequests = 0;
  const result = await loader(async (url) => {
    if (url.includes('pool-version')) return new Response(JSON.stringify(metadata));
    cardRequests += 1;
    return new Response(cardRequests === 1 ? '[{"stale":true}]' : text);
  })();
  assert.equal(cardRequests, 2); assert.equal(result.cards[0].id, 'BP20-001SC');
  await assert.rejects(loader(async (url) => new Response(url.includes('pool-version')
    ? JSON.stringify(metadata) : '[{"corrupt":true}]'))(), /版本不一致/);
});
