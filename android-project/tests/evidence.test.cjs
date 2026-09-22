const test = require('node:test');
const assert = require('node:assert/strict');
const createEvidence = require('../app/src/main/assets/evidence.js');

function setup(overrides = {}) {
  const drawn = [];
  const canvases = [];
  const env = {
    setTimeout, clearTimeout,
    document: { createElement: tag => {
      assert.equal(tag, 'canvas');
      const ctx = { measureText: text => ({ width: [...text].length * 12 }), fillRect() {}, drawImage() {}, fillText: (text, x, y) => drawn.push({ text, x, y }) };
      const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,dGVzdA==' };
      canvases.push(canvas);
      return canvas;
    } },
    ...overrides
  };
  return { env, service: createEvidence(env), drawn, canvases };
}

test('all work logs are included across bounded pages, including long places', async () => {
  const { service, drawn, canvases } = setup();
  const logs = Array.from({ length: 45 }, (_, i) => ({ date: '2026-09-19', place: 'long-place-' + i + 'x'.repeat(120), hours: 8, wage: 300 }));
  const pages = await service.render(logs);
  assert.ok(pages.length > 1);
  assert.ok(drawn.some(row => row.text.startsWith('45. ')));
  assert.ok(canvases.every(canvas => canvas.height <= 1600 && canvas.width === 900));
  assert.equal(new Set(pages.map(page => page.filename)).size, pages.length);
  assert.ok(pages.every(page => page.dataUrl.startsWith('data:image/png;base64,')));
});

test('wrapping preserves characters and limits rendered width', () => {
  const { service } = setup();
  const ctx = { measureText: text => ({ width: [...text].length * 10 }) };
  const lines = service.wrapText(ctx, 'abcdefghij\nklmnopqrst', 30);
  assert.equal(lines.join(''), 'abcdefghijklmnopqrst');
  assert.ok(lines.every(line => ctx.measureText(line).width <= 30));
});

test('empty logs fail explicitly', async () => {
  await assert.rejects(setup().service.render([]), /no_records/);
});

test('native save succeeds only after a successful OS callback', async () => {
  let id;
  const { env, service } = setup({ AndroidFiles: { saveImage: (_data, _name, requestId) => { id = requestId; } } });
  const task = service.save({ dataUrl: 'data:image/png;base64,dGVzdA==', filename: 'work-records-1-1.png' });
  env.onNativeImageSaved(id, { ok: true, message: 'saved' });
  assert.equal(await task, 'saved');
});

test('native cancellation/failure rejects and a subsequent save can succeed', async () => {
  const ids = [];
  const { env, service } = setup({ AndroidFiles: { saveImage: (_data, _name, id) => ids.push(id) } });
  const asset = { dataUrl: 'data:image/png;base64,dGVzdA==', filename: 'work-records-1-1.png' };
  const first = service.save(asset);
  env.onNativeImageSaved(ids[0], { ok: false, message: 'cancelled' });
  await assert.rejects(first, /cancelled/);
  const second = service.save(asset);
  env.onNativeImageSaved(ids[1], { ok: true, message: 'saved' });
  assert.equal(await second, 'saved');
});

test('browser save uses a downloadable PNG blob and keeps the app document', async () => {
  let clicked = false;
  let blob;
  const anchor = { click() { clicked = true; }, remove() {} };
  const { service } = setup({
    Blob, atob,
    setTimeout: () => 1,
    URL: { createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
    document: { createElement: () => anchor, body: { appendChild() {} } }
  });
  await service.save({ dataUrl: 'data:image/png;base64,dGVzdA==', filename: 'work-records-1-1.png' });
  assert.equal(clicked, true);
  assert.equal(blob.type, 'image/png');
  assert.equal(anchor.download, 'work-records-1-1.png');
});
