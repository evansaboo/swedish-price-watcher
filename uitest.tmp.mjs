import { chromium } from 'playwright-core';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', e => errs.push(e.message));

await p.goto('https://deals.evansaboo.com/', { waitUntil: 'networkidle', timeout: 60000 });

// Open Settings drawer, then the Hotlist tab.
const openers = ['#settings-btn', '#open-settings', '[data-open="settings"]', 'button[aria-label*="ettings"]'];
for (const sel of openers) { const el = await p.$(sel); if (el) { await el.click(); break; } }
await p.waitForTimeout(1200);
const tab = await p.$('.drawer-tab[data-tab="hotlist"]');
if (tab) { await tab.click(); await p.waitForTimeout(1200); }

const r = await p.evaluate(() => {
  const w = document.getElementById('hotlist-webhook');
  const d = document.getElementById('hotlist-notify-drops');
  const hint = document.querySelector('#tab-hotlist .field-hint');
  const vis = (e) => !!(e && e.offsetParent !== null);
  return {
    webhookExists: !!w, webhookVisible: vis(w), webhookValue: w ? (w.value ? 'populated' : 'EMPTY') : null,
    dropsExists: !!d, dropsChecked: d ? d.checked : null,
    hintVisible: vis(hint), hintText: hint ? hint.textContent.trim().slice(0, 60) : null
  };
});
console.log(JSON.stringify(r, null, 1));
console.log('console errors:', errs.length ? errs.slice(0, 3) : 'none');
await p.screenshot({ path: '/tmp/hotlist-tab.png' });
await b.close();
