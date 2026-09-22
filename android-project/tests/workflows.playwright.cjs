const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const assets = path.resolve(__dirname, '../app/src/main/assets');
const output = path.resolve(__dirname, '../app/build/qa-2.3');
fs.mkdirSync(output, { recursive: true });

async function main() {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const target = path.resolve(assets, '.' + pathname);
    if (!target.startsWith(assets + path.sep) || !fs.existsSync(target)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
    const stream = fs.createReadStream(target);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const requests = [];
    await context.route('http://23.26.204.65:8000/**', route => {
      const req = route.request();
      requests.push({ url: req.url(), body: req.postDataJSON() });
      if (req.url().endsWith('/api/asr/hakka')) return route.fulfill({ status: 404, body: '{}' });
      if (req.url().endsWith('/api/asr/minnan')) return route.fulfill({ json: { text: '模拟客家话转写', engine: '16k_zh_en', mode: 'minnan' } });
      if (req.url().endsWith('/api/health')) return route.fulfill({ json: { status: 'ok' } });
      return route.fulfill({ json: { reply: '测试回复' } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      if (localStorage.getItem('qa-seeded')) return;
      localStorage.setItem('qa-seeded', 'yes');
      localStorage.setItem('gygj_user_id', 'qa-user');
      localStorage.setItem('gygj_worklogs', JSON.stringify(Array.from({ length: 42 }, (_, i) => ({ date: '2026-09-19', place: '测试项目第' + (i + 1) + '号楼钢筋作业区', hours: 8, wage: 350, ts: i + 1 }))));
      localStorage.setItem('gygj_community', JSON.stringify([{ id: 'qa-post', user: '工友甲', authorId: 'other', role: '工友', tag: '日常', content: '测试动态', time: '刚刚', likes: 0, liked: false, comments: [{ user: '我', text: '我的旧评论' }, { user: '工友乙', text: '别人的评论' }] }]));
    });
    const url = `http://127.0.0.1:${server.address().port}/app.html`;
    await page.goto(url);
    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: path.join(output, `home-${viewport.width}.png`) });
      const mascot = await page.locator('.mascot-hero img').evaluate(img => ({ loaded: img.complete && img.naturalWidth > 0, fit: getComputedStyle(img).objectFit }));
      assert.equal(mascot.loaded, true);
      assert.equal(mascot.fit, 'contain');
      const enclosed = await page.locator('.mascot-hero').evaluate(hero => {
        const box = hero.getBoundingClientRect();
        const card = hero.parentElement.getBoundingClientRect();
        return box.top >= card.top && box.bottom <= card.bottom && box.left >= card.left && box.right <= card.right;
      });
      assert.equal(enclosed, true, 'mascot must not be clipped by its parent');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#page-home .voice-consult-card').click();
    await page.getByRole('button', { name: /帮填工单/ }).click();
    const worklogNote = '9月19日 4号楼 3小时 100元';
    const worklogDate = await page.evaluate(() => `${new Date().getFullYear()}-09-19`);
    await page.locator('#rights-input').fill(worklogNote);
    await page.locator('#page-rights .send-btn').click();
    await page.waitForFunction(note => getWorkLogs()[0].note === note, worklogNote);
    const recorded = await page.evaluate(() => getWorkLogs()[0]);
    assert.deepEqual({ date: recorded.date, place: recorded.place, hours: recorded.hours, wage: recorded.wage, pending: recorded.pending },
      { date: worklogDate, place: '4号楼', hours: 3, wage: 100, pending: false });
    const confirmation = await page.locator('#chat-rights .bot-message .msg-text').last().innerText();
    for (const value of [worklogDate, '4号楼', '3小时', '100元']) assert.ok(confirmation.includes(value));
    assert.equal(requests.filter(req => req.url.endsWith('/api/chat')).length, 0);
    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#chat-rights .bot-message').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `worklog-chat-${viewport.width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.reload();
    await page.locator('#page-home .tab-item').nth(1).click();
    assert.equal(await page.locator('#worklog-list .wl-entry').count(), 43);
    assert.equal(await page.locator('#worklog-list .wl-entry-date').first().innerText(), worklogDate);
    assert.equal(await page.locator('#worklog-list .wl-entry-detail').first().innerText(), '4号楼 · 3小时');
    assert.equal(await page.locator('#worklog-list .wl-entry-wage').first().innerText(), '¥100');
    assert.equal(await page.locator('#wl-total-hours').innerText(), '339.0');
    assert.equal(await page.locator('#wl-total-wage').innerText(), '¥14800');
    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#worklog-list .wl-entry').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `worklog-result-${viewport.width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#page-worklog .evidence-btn').click();
    await page.locator('#page-evidence.active').waitFor();
    assert.equal(await context.pages().length, 1);
    const count = Number((await page.locator('#evidence-counter').innerText()).split('/')[1].trim());
    assert.ok(count > 1);
    assert.equal(await page.locator('#evidence-image').evaluate(img => img.naturalWidth), 900);
    await page.screenshot({ path: path.join(output, 'evidence-preview.png') });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存图片', exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = path.join(output, download.suggestedFilename());
    await download.saveAs(downloadPath);
    const metadata = await sharp(downloadPath).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 900);
    assert.equal(await page.url(), url);
    await page.getByRole('button', { name: '下一张', exact: true }).click();
    assert.ok((await page.locator('#evidence-counter').innerText()).startsWith('2'));
    await page.getByRole('button', { name: '返回工单', exact: true }).click();
    await page.locator('#page-worklog.active').waitFor();
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 600; canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 400);
      ctx.fillStyle = '#292D32'; ctx.font = '36px sans-serif';
      ctx.fillText('测试合同附件', 40, 100);
      localStorage.setItem('gygj_contract', canvas.toDataURL('image/png'));
    });
    await page.locator('#page-worklog .evidence-btn').click();
    await page.locator('#page-evidence.active').waitFor();
    assert.equal(Number((await page.locator('#evidence-counter').innerText()).split('/')[1].trim()), count + 1);
    for (let i = 0; i < count; i++) await page.getByRole('button', { name: '下一张', exact: true }).click();
    assert.equal(await page.locator('#evidence-label').innerText(), '合同附件');
    const contractDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存图片', exact: true }).click();
    const contract = await contractDownload;
    assert.ok(contract.suggestedFilename().endsWith('-contract.png'));
    await contract.saveAs(path.join(output, contract.suggestedFilename()));
    assert.equal(await page.evaluate(() => handleAppBack()), true);
    await page.locator('#page-worklog.active').waitFor();
    await page.locator('#page-worklog .evidence-btn').click();
    await page.getByRole('button', { name: '回首页', exact: true }).click();
    await page.locator('#page-home.active').waitFor();

    await page.locator('#page-home .tab-item').nth(2).click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '删除我的评论', exact: true }).click();
    assert.ok((await page.locator('#community-feed').innerText()).includes('我的旧评论'));
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '删除我的评论', exact: true }).click();
    assert.ok(!(await page.locator('#community-feed').innerText()).includes('我的旧评论'));
    assert.ok((await page.locator('#community-feed').innerText()).includes('别人的评论'));
    await page.locator('#comment-qa-post').fill('新增测试评论');
    await page.locator('#page-community .comment-send').click();
    await page.screenshot({ path: path.join(output, 'community-comment.png') });
    await page.reload();
    await page.locator('#page-home .tab-item').nth(2).click();
    assert.ok((await page.locator('#community-feed').innerText()).includes('新增测试评论'));
    assert.ok(!(await page.locator('#community-feed').innerText()).includes('我的旧评论'));
    await page.locator('#community-input').fill('可删除的测试动态');
    await page.locator('#page-community .community-post-btn').click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '删除我的动态', exact: true }).click();
    assert.ok(!(await page.locator('#community-feed').innerText()).includes('可删除的测试动态'));

    await page.locator('#page-community .tab-item').first().click();
    await page.locator('#page-home .voice-consult-card').click();
    await page.locator('#page-rights [data-voice-mode="hakka"]').click();
    assert.equal(await page.locator('#page-rights [data-voice-mode="hakka"]').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => uploadForAsr('dGVzdA==', 'rights', 'hakka'));
    await page.waitForFunction(() => !document.getElementById('app-toast') || getComputedStyle(document.getElementById('app-toast')).opacity === '0');
    assert.ok((await page.locator('#chat-rights').innerText()).includes('模拟客家话转写'));
    assert.deepEqual(requests.filter(req => req.url.includes('/api/asr')).map(req => req.body.lang), ['hakka', 'hakka']);
    await page.screenshot({ path: path.join(output, 'hakka-rights.png') });
    await page.locator('#page-rights .back-btn').click();
    await page.locator('#page-home .action-card').first().click();
    assert.equal(await page.locator('#page-talk [data-voice-mode="hakka"]').getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(output, 'hakka-talk.png') });
    await page.reload();
    assert.equal(await page.evaluate(() => localStorage.getItem('gygj_voice_mode')), 'hakka');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, png: downloadPath, evidencePages: count, viewports: [320, 390, 1280], screenshots: output, pageErrors: errors }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
