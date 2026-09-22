const test = require('node:test');
const assert = require('node:assert/strict');
const createVoiceService = require('../app/src/main/assets/voice-service.js');

function setup(overrides = {}) {
  const env = { setTimeout, clearTimeout, AbortController, ...overrides };
  return { env, service: createVoiceService(env) };
}

function response(status, body) {
  return { status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
}

test('web sends one request directly to the selected speech endpoint', async () => {
  for (const mode of ['mandarin', 'minnan']) {
    const calls = [];
    const { service } = setup({ fetch: async (url, options) => {
      calls.push({ url, options });
      return response(200, { text: ' test transcript ', mode });
    }});
    const result = await service.recognize('dGVzdA==', mode, 'http://test.invalid/');
    assert.equal(result.text, 'test transcript');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://test.invalid/api/asr' + (mode === 'minnan' ? '/minnan' : ''));
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      audio_base64: 'dGVzdA==', format: 'wav', lang: mode
    });
  }
});

test('native upload bypasses WebView fetch and correlates callbacks', async () => {
  const calls = [];
  const { env, service } = setup({
    AndroidVoice: { recognize: (...args) => calls.push(args) },
    fetch: () => { throw new Error('must not call WebView fetch'); }
  });
  const first = service.recognize('first', 'mandarin', 'unused');
  const second = service.recognize('second', 'minnan', 'unused');
  env.onNativeAsrResult(calls[1][2], { status: 200, body: '{"text":"second"}' });
  env.onNativeAsrResult(calls[0][2], { status: 200, body: '{"text":"first"}' });
  assert.equal((await first).text, 'first');
  assert.equal((await second).text, 'second');
  env.onNativeAsrResult(calls[0][2], { status: 200, body: '{"text":"duplicate"}' });
});

test('older APK bridge without upload falls back to browser transport', async () => {
  const { service } = setup({
    AndroidVoice: { startRecording() {} },
    fetch: async () => response(200, { text: 'fallback' })
  });
  assert.equal((await service.recognize('audio', 'mandarin', 'http://test.invalid')).text, 'fallback');
});

test('HTTP error codes remain distinguishable', async () => {
  for (const status of [401, 403, 404, 413, 422, 429, 500, 502, 503]) {
    const { service } = setup({ fetch: async () => response(status, 'error') });
    await assert.rejects(service.recognize('audio', 'minnan', 'http://test.invalid'), error => {
      assert.equal(error.code, 'http');
      assert.equal(error.status, status);
      if (status !== 413) assert.ok(service.errorMessage(error).includes(String(status)));
      return true;
    });
  }
});

test('network failures are not labeled as a stopped server', async () => {
  const { service } = setup({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(service.recognize('audio', 'mandarin', 'http://test.invalid'), error => {
    assert.equal(error.code, 'network');
    assert.ok(service.errorMessage(error).includes('ASR-NETWORK'));
    return true;
  });
});

test('invalid JSON and malformed success bodies report response errors', async () => {
  for (const body of ['<html>proxy error</html>', 'null', '[]', '{}', '{"text":1}']) {
    const { service } = setup({ fetch: async () => response(200, body) });
    await assert.rejects(service.recognize('audio', 'mandarin', 'http://test.invalid'), { code: 'invalid_response' });
  }
});

test('provider errors and no-speech results are preserved', async () => {
  const detail = 'provider quota exhausted';
  const { service } = setup({ fetch: async () => response(200, { text: '', error: detail }) });
  await assert.rejects(service.recognize('audio', 'mandarin', 'http://test.invalid'), error => {
    assert.equal(error.code, 'recognition');
    assert.equal(service.errorMessage(error), detail);
    return true;
  });
  const empty = setup({ fetch: async () => response(200, { text: '', error: '' }) });
  await assert.rejects(empty.service.recognize('audio', 'mandarin', 'http://test.invalid'), { code: 'no_speech' });
});

test('web timeout aborts a stalled response body', async () => {
  let signal;
  const { service } = setup({
    voiceTimeoutMs: 10,
    fetch: async (_url, options) => {
      signal = options.signal;
      return { status: 200, text: () => new Promise(() => {}) };
    }
  });
  await assert.rejects(service.recognize('audio', 'mandarin', 'http://test.invalid'), { code: 'timeout' });
  assert.equal(signal.aborted, true);
});

test('native timeout discards late results and permits a new request', async () => {
  const calls = [];
  const { env, service } = setup({
    voiceTimeoutMs: 10,
    AndroidVoice: { recognize: (...args) => calls.push(args) }
  });
  await assert.rejects(service.recognize('audio', 'mandarin'), { code: 'timeout' });
  const next = service.recognize('audio', 'mandarin');
  env.onNativeAsrResult(calls[0][2], { status: 200, body: '{"text":"old"}' });
  env.onNativeAsrResult(calls[1][2], { status: 200, body: '{"text":"new"}' });
  assert.equal((await next).text, 'new');
});

test('native error callbacks preserve network and timeout categories', async () => {
  for (const code of ['network', 'network_vpn', 'timeout', 'busy', 'invalid_audio', 'audio_too_large']) {
    let requestId;
    const { env, service } = setup({ AndroidVoice: { recognize: (_audio, _lang, id) => { requestId = id; } } });
    const task = service.recognize('audio', 'mandarin');
    env.onNativeAsrResult(requestId, { code });
    await assert.rejects(task, { code });
  }
});

test('empty and oversized audio fail before any network access', async () => {
  const { service } = setup({ fetch: () => assert.fail('unexpected upload') });
  await assert.rejects(service.recognize('', 'mandarin'), { code: 'invalid_audio' });
  await assert.rejects(service.recognize('a'.repeat(2796205), 'mandarin'), { code: 'audio_too_large' });
});

test('Hakka uses its dedicated endpoint and never becomes Mandarin', async () => {
  const calls = [];
  const { service } = setup({ fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response(200, { text: 'hakka transcript', engine: '16k_zh_en', mode: 'hakka' });
  }});
  const result = await service.recognize('audio', 'hakka', 'http://test.invalid');
  assert.equal(result.mode, 'hakka');
  assert.equal(calls[0].url, 'http://test.invalid/api/asr/hakka');
  assert.equal(calls[0].body.lang, 'hakka');
  assert.equal(calls.length, 1);
});

test('Hakka uses legacy multilingual route only on 404 and verifies model', async () => {
  const calls = [];
  const { service } = setup({ fetch: async url => {
    calls.push(url);
    return url.endsWith('/hakka') ? response(404, '')
      : response(200, { text: 'legacy result', mode: 'minnan', engine: '16k_zh_en' });
  }});
  assert.equal((await service.recognize('audio', 'hakka', 'http://test.invalid')).mode, 'hakka');
  assert.deepEqual(calls, ['http://test.invalid/api/asr/hakka', 'http://test.invalid/api/asr/minnan']);
  const wrong = setup({ fetch: async () => response(200, { text: 'wrong engine', engine: '16k_zh' }) });
  await assert.rejects(wrong.service.recognize('audio', 'hakka', 'http://test.invalid'), { code: 'unsupported_engine' });
});

test('Hakka does not retry failed jobs on 503 and validates native model too', async () => {
  let count = 0;
  const failed = setup({ fetch: async () => { count++; return response(503, ''); } });
  await assert.rejects(failed.service.recognize('audio', 'hakka', 'http://test.invalid'), { status: 503 });
  assert.equal(count, 1);
  let id;
  const native = setup({ AndroidVoice: { recognize: (_audio, lang, requestId) => { assert.equal(lang, 'hakka'); id = requestId; } } });
  const task = native.service.recognize('audio', 'hakka');
  native.env.onNativeAsrResult(id, { status: 200, body: JSON.stringify({ text: 'native hakka', engine: '16k_zh_en_2.0' }) });
  assert.equal((await task).mode, 'hakka');
});
