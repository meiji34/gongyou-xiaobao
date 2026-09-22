const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/app.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const sample = '9\u670819\u65e5 4\u53f7\u697c 3\u5c0f\u65f6 100\u5143';
const place = '4\u53f7\u697c';

function setup(now = new Date(2026, 8, 20, 12).getTime()) {
  const storage = new Map();
  const elements = new Map();
  const messages = [];
  const context = {
    window: {}, console,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    document: {
      addEventListener() {}, querySelectorAll: () => [],
      createElement: () => ({ textContent: '', innerHTML: '' }),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', appendChild() {} });
        return elements.get(id);
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  context.addAgentBotMessage = (_type, message) => messages.push(message);
  return { context, storage, elements, messages };
}

function fields(entry) {
  return { date: entry.date, place: entry.place, hours: entry.hours, wage: entry.wage, pending: entry.pending };
}

const expected = { date: '2026-09-19', place, hours: 3, wage: 100, pending: false };

test('the reported short note extracts all four fields and preserves the original', () => {
  const entry = setup().context.parseWorkLogNote(sample);
  assert.deepEqual(fields(entry), expected);
  assert.equal(entry.note, sample);
  assert.equal(entry.source, 'ai');
});

for (const [name, note] of [
  ['Chinese punctuation', sample.replaceAll(' ', '\uff0c')],
  ['ASCII punctuation', sample.replaceAll(' ', ',')],
  ['no separators', sample.replaceAll(' ', '')],
  ['line breaks', sample.replaceAll(' ', '\n')],
  ['reordered fields', '100\u5143 4\u53f7\u697c 9\u670819\u65e5 3\u5c0f\u65f6'],
  ['full-width digits', '\uff19\u6708\uff11\uff19\u65e5 \uff14\u53f7\u697c \uff13\u5c0f\u65f6 \uff11\uff10\uff10\u5143'],
  ['conversational phrasing', '9\u670819\u65e5\u6211\u57284\u53f7\u697c\u5e72\u4e863\u4e2a\u5c0f\u65f6\uff0c\u5de5\u8d44100\u5143'],
  ['explicit labels', '\u65e5\u671f\uff1a9\u670819\u65e5 \u5730\u70b9\uff1a4\u53f7\u697c \u5de5\u65f6\uff1a3\u5c0f\u65f6 \u7ea6\u5b9a\u5de5\u8d44\uff1a100\u5143']
]) {
  test(`short notes support ${name}`, () => {
    assert.deepEqual(fields(setup().context.parseWorkLogNote(note)), expected);
  });
}

for (const date of ['2026-9-19', '2026/9/19', '2026\u5e749\u670819\u65e5', '9/19', '9-19', '9\u670819\u53f7']) {
  test(`date format ${JSON.stringify(date)} is independent of the building number`, () => {
    assert.deepEqual(fields(setup().context.parseWorkLogNote(`${date} ${place} 3\u5c0f\u65f6 100\u5143`)), expected);
  });
}

for (const wage of ['100\u5757', '100\u5757\u94b1', '\uffe5100', '\u00a5100', '\u5de5\u94b1100', '\u65e5\u85aa100', '\u5de5\u8d44\u662f100\u5143']) {
  test(`wage format ${JSON.stringify(wage)} is recognized`, () => {
    assert.deepEqual(fields(setup().context.parseWorkLogNote(`9\u670819\u65e5 ${place} 3\u5c0f\u65f6 ${wage}`)), expected);
  });
}

test('Chinese numbers from speech and half hours are supported', () => {
  const entry = setup().context.parseWorkLogNote('\u4e5d\u6708\u5341\u4e5d\u65e5 \u56db\u53f7\u697c \u4e09\u4e2a\u5c0f\u65f6\u534a \u4e00\u767e\u5143');
  assert.deepEqual(fields(entry), { ...expected, place: '\u56db\u53f7\u697c', hours: 3.5 });
});

test('decimal hours and wages do not become part of the place', () => {
  const entry = setup().context.parseWorkLogNote('9\u670819\u65e5\u57284\u53f7\u697c\u7ed1\u94a2\u7b4b\u5e72\u4e863.5\u5c0f\u65f6\u5de5\u8d44100.50\u5143');
  assert.deepEqual(fields(entry), { ...expected, place: place + '\u7ed1\u94a2\u7b4b', hours: 3.5, wage: 100.5 });
});

test('relative dates use calendar days across the year boundary', () => {
  const { context } = setup(new Date(2027, 0, 1, 0, 30).getTime());
  for (const [label, date] of [['\u4eca\u5929', '2027-01-01'], ['\u6628\u5929', '2026-12-31'], ['\u524d\u5929', '2026-12-30']]) {
    assert.equal(context.parseWorkLogNote(`${label} ${place} 3\u5c0f\u65f6 100\u5143`).date, date);
  }
});

test('month/day dates use the current year, not a hard-coded year', () => {
  assert.equal(setup(new Date(2027, 8, 20).getTime()).context.parseWorkLogNote(sample).date, '2027-09-19');
});

test('an invalid explicit date stays pending instead of silently using today', () => {
  const entry = setup().context.parseWorkLogNote(`2\u670830\u65e5 ${place} 3\u5c0f\u65f6 100\u5143`);
  assert.equal(entry.date, '');
  assert.equal(entry.pending, true);
});

test('missing fields are not inferred from dates, building numbers or hours', () => {
  const { context } = setup();
  assert.deepEqual(fields(context.parseWorkLogNote('9\u670819\u65e5 3\u5c0f\u65f6 100\u5143')), { ...expected, place: '', pending: true });
  assert.deepEqual(fields(context.parseWorkLogNote('9\u670819\u65e5 4\u53f7\u697c 100\u5143')), { ...expected, hours: 0, pending: true });
  assert.deepEqual(fields(context.parseWorkLogNote('9\u670819\u65e5 4\u53f7\u697c 3\u5c0f\u65f6')), { ...expected, wage: 0 });
  assert.equal(context.parseWorkLogNote('').pending, true);
});

test('saving persists all fields and refreshes the list and totals', () => {
  const { context, storage, elements } = setup();
  context.saveAiWorkLog(sample);
  const saved = JSON.parse(storage.get('gygj_worklogs'));
  assert.equal(saved.length, 1);
  assert.deepEqual(fields(saved[0]), expected);
  assert.equal(elements.get('wl-total-days').textContent, 1);
  assert.equal(elements.get('wl-total-hours').textContent, '3.0');
  assert.equal(elements.get('wl-total-wage').textContent, '\u00a5100');
});

test('chat confirmation echoes actual results without claiming missing wages were filled', async () => {
  const { context, messages } = setup();
  context.startAgentFlow('worklog');
  await context.dispatchUserMessage('rights', sample);
  assert.ok(messages.at(-1).includes('2026-09-19'));
  assert.ok(messages.at(-1).includes(place));
  assert.ok(messages.at(-1).includes('100\u5143'));
  context.startAgentFlow('worklog');
  await context.dispatchUserMessage('rights', '9\u670819\u65e5 4\u53f7\u697c 3\u5c0f\u65f6');
  assert.ok(messages.at(-1).includes('\u5de5\u8d44\u5f85\u8865\u5145'));
});
