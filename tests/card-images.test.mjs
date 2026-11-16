import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('  const CDN_BASE'), app.indexOf('  const displayedImageUrls'));
const rawImage = () => new Response(Uint8Array.of(0xff, 0xd8, 0xff));

function imageLoader(fetch, disk = new Map()) {
  const window = {};
  const api = vm.runInNewContext(`${source}
    ({ cardImageBlob, cacheImageBlob, keys: () => [...imgBlobs.keys()] })
  `, {
    window, fetch, AbortController, Blob, Response, setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Image: class {
      naturalWidth = 200;
      naturalHeight = 300;
      set src(value) { queueMicrotask(() => this.onload?.()); }
      removeAttribute() {}
    },
    CanvasRenderingContext2D: class {},
    document: {
      createElement: () => ({
        getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(32 * 18 * 4) }) }),
      }),
    },
    location: { hostname: 'example.github.io', protocol: 'https:' },
    caches: { open: async () => ({
      match: async key => disk.get(key)?.clone(),
      put: async (key, response) => { disk.set(key, response); },
    }) },
  });
  return { ...api, cornerStat: window.__sveCornerFix };
}

test('a clean original is written to persistent cache and is reusable after a reload', async () => {
  const disk = new Map();
  const first = imageLoader(async () => rawImage(), disk);
  const blob = await first.cardImageBlob('clean');
  assert.equal(blob.type, 'image/jpeg');
  assert.equal(first.cornerStat.clean, 1);
  assert.equal(disk.size, 1);
  let networkCalls = 0;
  const reloaded = imageLoader(async () => { networkCalls++; return rawImage(); }, disk);
  assert.equal((await reloaded.cardImageBlob('clean')).size, blob.size);
  assert.equal(networkCalls, 0);
  assert.equal(reloaded.cornerStat.clean, 0);
});

test('a scrolled-out card cancels its reader, preserving a shared original for another view', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let respond;
  const loader = imageLoader((url, { signal }) => {
    started(signal);
    return new Promise(resolve => { respond = resolve; });
  });
  const controller = new AbortController();
  const grid = loader.cardImageBlob('shared', '.jpg', controller.signal);
  const preview = loader.cardImageBlob('shared');
  const upstream = await ready;
  controller.abort();
  assert.equal(await grid, null);
  assert.equal(upstream.aborted, false);
  respond(rawImage());
  assert.equal((await preview).type, 'image/jpeg');
});

test('when the last reader leaves, the original request is canceled and a later reader can retry', async () => {
  let calls = 0;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const loader = imageLoader((url, { signal }) => {
    if (++calls > 1) return Promise.resolve(rawImage());
    started(signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = loader.cardImageBlob('retry', '.png', controller.signal);
  const upstream = await ready;
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(upstream.aborted, true);
  assert.equal((await loader.cardImageBlob('retry', '.png')).size, 3);
  assert.equal(calls, 2);
});

test('the encoded image cache evicts the least recently used blobs', async () => {
  const loader = imageLoader(async () => { throw Error('Unexpected cache miss'); });
  const blob = { size: 10 * 1024 * 1024 };
  loader.cacheImageBlob('a.jpg', blob);
  loader.cacheImageBlob('b.jpg', blob);
  assert.equal(await loader.cardImageBlob('a'), blob);
  loader.cacheImageBlob('c.jpg', blob);
  assert.deepEqual(Array.from(loader.keys()), ['a.jpg', 'c.jpg']);
});
