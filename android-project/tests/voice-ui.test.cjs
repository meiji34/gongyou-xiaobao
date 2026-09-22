const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/app.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

function setup(recognize) {
  const elements = new Map();
  function element() {
    return {
      children: [], value: '', textContent: '', innerHTML: '', scrollHeight: 0,
      appendChild(child) { child.parent = this; this.children.push(child); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    };
  }
  const context = {
    console, delivered: [],
    setTimeout: () => 1, clearTimeout() {},
    VoiceService: { recognize, errorMessage: error => error.code },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      createElement: element,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      }
    },
    localStorage: { getItem: () => null },
    window: {}
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  vm.runInContext('dispatchUserMessage = async (type, text) => { delivered.push({ type, text }); };', context);
  return { context, elements };
}

test('successful speech reaches the original chat and clears processing state', async () => {
  let release;
  const { context, elements } = setup(() => new Promise(resolve => { release = resolve; }));
  const task = context.uploadForAsr('audio', 'talk', 'mandarin');
  assert.equal(vm.runInContext('voiceProcessing', context), true);
  assert.equal(elements.get('chat-talk').children.length, 1);
  release({ text: 'test transcript' });
  await task;
  assert.equal(vm.runInContext('voiceProcessing', context), false);
  assert.equal(elements.get('chat-talk').children.length, 0);
  assert.equal(context.delivered[0].type, 'talk');
  assert.equal(context.delivered[0].text, 'test transcript');
});

test('speech failure clears the spinner and never dispatches a chat message', async () => {
  const { context, elements } = setup(async () => { throw { code: 'network_vpn' }; });
  await context.uploadForAsr('audio', 'rights', 'mandarin');
  assert.equal(vm.runInContext('voiceProcessing', context), false);
  assert.equal(context.delivered.length, 0);
  assert.equal(elements.get('chat-rights').children.length, 1);
  assert.ok(!elements.get('chat-rights').children[0].innerHTML.includes('typing-dots'));
});

test('downstream chat failure retains transcript instead of reporting speech failure', async () => {
  const { context, elements } = setup(async () => ({ text: 'retained transcript' }));
  vm.runInContext('dispatchUserMessage = async () => { throw new Error("storage_full"); };', context);
  await context.uploadForAsr('audio', 'rights', 'mandarin');
  assert.equal(elements.get('rights-input').value, 'retained transcript');
  assert.equal(vm.runInContext('voiceProcessing', context), false);
});

test('record button cannot start another recording while speech is uploading', () => {
  const { context } = setup(async () => ({ text: 'test' }));
  let started = false;
  context.window.AndroidVoice = { startRecording: () => { started = true; } };
  vm.runInContext('voiceProcessing = true;', context);
  context.onVoicePressStart({ preventDefault() {}, currentTarget: { dataset: { voiceType: 'talk' } } });
  assert.equal(started, false);
});
