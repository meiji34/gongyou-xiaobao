(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
  } else {
    root.VoiceService = factory(root);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (env) {
  'use strict';

  const pending = new Map();
  const timeoutMs = env.voiceTimeoutMs || 75000;
  let sequence = 0;

  function failure(code, status, detail) {
    const error = new Error(detail || code);
    error.code = code;
    error.status = status || 0;
    return error;
  }

  function parseResult(status, body) {
    if (!Number.isInteger(status)) throw failure('invalid_response');
    if (status < 200 || status >= 300) throw failure('http', status);
    let data;
    try {
      data = JSON.parse(body);
    } catch (_) {
      throw failure('invalid_response');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('invalid_response');
    if (typeof data.text === 'string' && data.text.trim()) return { ...data, text: data.text.trim() };
    if (typeof data.error === 'string' && data.error.trim()) throw failure('recognition', 0, data.error);
    if (data.text === '') throw failure('no_speech');
    throw failure('invalid_response');
  }

  function finishNative(id, result) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    env.clearTimeout(request.timer);
    try {
      if (!result || result.code) throw failure(result?.code || 'invalid_response');
      request.resolve(parseResult(result.status, result.body));
    } catch (error) {
      request.reject(error);
    }
  }

  env.onNativeAsrResult = finishNative;

  function recognizeNative(audioBase64, lang) {
    return new Promise((resolve, reject) => {
      const id = 'asr_' + (++sequence);
      const timer = env.setTimeout(() => {
        pending.delete(id);
        reject(failure('timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        env.AndroidVoice.recognize(audioBase64, lang, id);
      } catch (_) {
        finishNative(id, { code: 'native_error' });
      }
    });
  }

  async function recognizeWeb(audioBase64, lang, baseUrl) {
    const controller = env.AbortController ? new env.AbortController() : null;
    let timer;
    let timedOut = false;
    try {
      // The deadline includes reading the response body, not just its headers.
      const request = (async () => {
        const endpoint = lang === 'mandarin' ? '/api/asr' : '/api/asr/' + lang;
        const options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_base64: audioBase64, format: 'wav', lang }),
          ...(controller ? { signal: controller.signal } : {})
        };
        let response = await env.fetch(baseUrl.replace(/\/$/, '') + endpoint, options);
        if (lang === 'hakka' && response.status === 404) {
          // Older deployments expose the same multilingual model under this route.
          response = await env.fetch(baseUrl.replace(/\/$/, '') + '/api/asr/minnan', options);
        }
        return parseResult(response.status, await response.text());
      })();
      const deadline = new Promise((_, reject) => {
        timer = env.setTimeout(() => {
          timedOut = true;
          if (controller) controller.abort();
          reject(failure('timeout'));
        }, timeoutMs);
      });
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (timedOut) throw failure('timeout');
      if (error.code) throw error;
      throw failure('network');
    } finally {
      env.clearTimeout(timer);
    }
  }

  async function recognize(audioBase64, language, baseUrl) {
    if (typeof audioBase64 !== 'string' || !audioBase64) throw failure('invalid_audio');
    if (audioBase64.length > 2796204) throw failure('audio_too_large');
    const lang = language || 'mandarin';
    if (!['mandarin', 'minnan', 'hakka'].includes(lang)) throw failure('unsupported_language');
    let result;
    if (env.AndroidVoice && typeof env.AndroidVoice.recognize === 'function') {
      result = await recognizeNative(audioBase64, lang);
    } else {
      if (!baseUrl) throw failure('network');
      result = await recognizeWeb(audioBase64, lang, baseUrl);
    }
    if (lang === 'hakka' && !['16k_zh_en', '16k_zh_en_2.0'].includes(result.engine)) {
      throw failure('unsupported_engine');
    }
    return { ...result, mode: lang };
  }

  function errorMessage(error) {
    if (error.code === 'unsupported_language') return '当前语音模式不受支持，请重新选择。';
    if (error.code === 'unsupported_engine') return '服务器尚未启用支持客家话的多方言模型，请更新语音服务配置。';
    if (error.code === 'recognition') return error.message;
    if (error.code === 'timeout') return '语音识别等待超时，请换个网络后重试。（ASR-TIMEOUT）';
    if (error.code === 'network') return '手机暂时连不上语音服务器，请切换 Wi-Fi 或移动数据后重试。（ASR-NETWORK）';
    if (error.code === 'network_vpn') return '语音服务器连接失败，检测到手机正在使用 VPN/代理。请检查分流设置或暂停代理后重试。（ASR-VPN）';
    if (error.code === 'invalid_response') return '语音接口返回了无法读取的结果，请将此提示反馈给管理员。（ASR-RESPONSE）';
    if (error.code === 'busy') return '上一段语音还在识别，请稍后再试。（ASR-BUSY）';
    if (error.code === 'no_speech') return '没有识别到说话声，请靠近麦克风再说一次。';
    if (error.code === 'invalid_audio') return '录音数据不完整，请重新录制。（ASR-AUDIO）';
    if (error.code === 'audio_too_large' || error.status === 413) return '录音太长了，请控制在一分钟内再试。';
    if (error.code === 'http') {
      if (error.status === 404) return '服务器没有当前语音接口，需要检查服务部署版本。（HTTP 404）';
      if (error.status === 401 || error.status === 403) return '语音请求被服务器拒绝，请检查接口访问权限。（HTTP ' + error.status + '）';
      if (error.status === 429) return '语音服务请求过多，请稍后再试。（HTTP 429）';
      return '语音服务器返回异常，请将此提示反馈给管理员。（HTTP ' + error.status + '）';
    }
    return '应用的语音上传出现异常，请关闭应用后重新打开。（ASR-CLIENT）';
  }

  return { recognize, errorMessage };
});
