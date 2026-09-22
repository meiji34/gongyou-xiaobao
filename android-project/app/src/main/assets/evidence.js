(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.Evidence = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (env) {
  'use strict';
  const pending = new Map();
  let sequence = 0;

  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text || '').split('\n')) {
      let line = '';
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > maxWidth) {
          lines.push(line);
          line = char;
        } else line += char;
      }
      lines.push(line);
    }
    return lines;
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async function render(records, contract) {
    if (!Array.isArray(records) || !records.length) throw new Error('no_records');
    const pages = [];
    const width = 900, maxHeight = 1600, pad = 44;
    const stamp = new Date().toLocaleString('zh-CN');
    const fileStamp = Date.now();
    const days = new Set(records.map(record => record.date).filter(Boolean)).size;
    const hours = records.reduce((sum, record) => sum + number(record.hours), 0);
    const wage = records.reduce((sum, record) => sum + number(record.wage), 0);
    let canvas, ctx, y;
    function startPage() {
      canvas = env.document.createElement('canvas');
      canvas.width = width;
      canvas.height = maxHeight;
      ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas_unavailable');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, maxHeight);
      ctx.fillStyle = '#292D32';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText('上工记录', pad, 66);
      ctx.fillStyle = '#687078';
      ctx.font = '20px sans-serif';
      ctx.fillText('生成时间：' + stamp, pad, 104);
      ctx.font = 'bold 24px sans-serif';
      ctx.fillStyle = '#292D32';
      const totals = `共 ${records.length} 条 · 上工 ${days} 天 · ${hours.toFixed(1)} 小时\n约定工资合计：¥${wage.toFixed(2)}`;
      y = 148;
      for (const line of wrapText(ctx, totals, width - 2 * pad)) {
        ctx.fillText(line, pad, y);
        y += 34;
      }
      y += 24;
    }
    function endPage() {
      pages.push({ canvas, contentHeight: y });
    }
    startPage();
    records.forEach((record, index) => {
      const sections = [
        { font: 'bold 24px sans-serif', text: `${index + 1}. ${record.date || '日期待补充'}${record.pending ? ' · 待补充' : ''}` },
        { font: '23px sans-serif', text: record.place || record.note || '地点待补充' },
        { font: '21px sans-serif', text: `${number(record.hours) ? number(record.hours) + ' 小时' : '工时待补充'} · ${number(record.wage) ? '约定工资 ¥' + number(record.wage).toFixed(2) : '工资未填写'}` }
      ];
      const rowHeight = sections.reduce((height, section) => {
        ctx.font = section.font;
        return height + wrapText(ctx, section.text, width - 2 * pad).length * 32;
      }, 24);
      if (rowHeight < maxHeight - 400 && y + rowHeight > maxHeight - 110) {
        endPage();
        startPage();
      }
      for (const section of sections) {
        ctx.font = section.font;
        const lines = wrapText(ctx, section.text, width - 2 * pad);
        for (const line of lines) {
          if (y > maxHeight - 130) { endPage(); startPage(); }
          ctx.font = section.font;
          ctx.fillStyle = '#292D32';
          ctx.fillText(line, pad, y);
          y += 32;
        }
      }
      y += 24;
    });
    endPage();
    const assets = pages.map((page, index) => {
      const output = env.document.createElement('canvas');
      output.width = width;
      output.height = Math.min(maxHeight, Math.max(400, page.contentHeight + 90));
      const outputCtx = output.getContext('2d');
      outputCtx.drawImage(page.canvas, 0, 0);
      outputCtx.font = '18px sans-serif';
      outputCtx.fillStyle = '#687078';
      outputCtx.fillText('个人上工记录，具体结算以核实结果为准。', pad, output.height - 50);
      outputCtx.fillText(`${index + 1} / ${pages.length}`, width - pad - 75, output.height - 50);
      return { dataUrl: output.toDataURL('image/png'), filename: `work-records-${fileStamp}-${index + 1}.png`, label: `上工记录 ${index + 1}/${pages.length}` };
    });
    if (contract && /^data:image\/(png|jpeg);base64,/.test(contract)) {
      const image = await new Promise((resolve, reject) => {
        const img = new env.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('contract_unreadable'));
        img.src = contract;
      });
      const output = env.document.createElement('canvas');
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      output.width = Math.max(1, Math.round(image.width * scale));
      output.height = Math.max(1, Math.round(image.height * scale));
      output.getContext('2d').drawImage(image, 0, 0, output.width, output.height);
      assets.push({ dataUrl: output.toDataURL('image/png'), filename: `work-records-${fileStamp}-contract.png`, label: '合同附件' });
    }
    return assets;
  }

  env.onNativeImageSaved = function (id, result) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    env.clearTimeout(request.timer);
    if (result && result.ok) request.resolve(result.message || '图片已保存');
    else request.reject(new Error(result?.message || '图片保存失败，请重试'));
  };

  function save(asset) {
    if (!asset || !asset.dataUrl?.startsWith('data:image/png;base64,')) return Promise.reject(new Error('图片尚未生成'));
    if (env.AndroidFiles && typeof env.AndroidFiles.saveImage === 'function') {
      return new Promise((resolve, reject) => {
        const id = 'image_' + (++sequence);
        const timer = env.setTimeout(() => { pending.delete(id); reject(new Error('保存等待超时，请重试')); }, 180000);
        pending.set(id, { resolve, reject, timer });
        try { env.AndroidFiles.saveImage(asset.dataUrl, asset.filename, id); }
        catch (_) { env.onNativeImageSaved(id, { ok: false, message: '无法调用图片保存，请更新应用后重试' }); }
      });
    }
    try {
      const binary = env.atob(asset.dataUrl.split(',')[1]);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const url = env.URL.createObjectURL(new env.Blob([bytes], { type: 'image/png' }));
      const link = env.document.createElement('a');
      link.href = url;
      link.download = asset.filename;
      env.document.body.appendChild(link);
      link.click();
      link.remove();
      env.setTimeout(() => env.URL.revokeObjectURL(url), 60000);
      return Promise.resolve('已发起图片下载');
    } catch (_) {
      return Promise.reject(new Error('当前环境无法保存图片，请使用新版应用'));
    }
  }

  return { render, save, wrapText };
});
