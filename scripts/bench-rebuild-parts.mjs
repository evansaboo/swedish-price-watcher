import process from 'node:process';
import { SqliteStore } from '../src/lib/store.js';
import { loadConfig } from '../src/config.js';
import { buildIdentityGroups, computeArbitrage } from '../src/services/dealEngine.js';
import { buildResaleIndex, computeFlips, DEFAULT_RESALE_OPTIONS } from '../src/services/resaleEngine.js';

const config = await loadConfig();
const store = new SqliteStore(config.dataFile.replace(/\.json$/, '.db'));
await store.load();
const state = store.getState();
const items = Object.values(state.items);

function time(label, fn, runs = 5) {
  fn();
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  console.log(`${label.padEnd(28)} median ${ts[Math.floor(ts.length / 2)].toFixed(1)} ms`);
}

const buyable = items.filter((i) =>
  ['outlet', 'digital', 'deal', 'used'].includes(i.condition) && !i.soldComp && i.availability !== 'sold' && Number.isFinite(i.latestPriceSek));
const used = items.filter((i) => i.condition === 'used');
const flipCands = items.filter((i) => ['outlet', 'deal', 'new'].includes(i.condition) && Number.isFinite(i.latestPriceSek));
console.log(`items=${items.length} buyable=${buyable.length} used=${used.length} flipCands=${flipCands.length}`);

const pbk = new Map();
time('buildIdentityGroups(buyable)', () => buildIdentityGroups(buyable));
time('computeArbitrage', () => computeArbitrage(buyable, pbk));
let idx;
time('buildResaleIndex(used)', () => { idx = buildResaleIndex(used, {}); });
time('computeFlips', () => computeFlips(flipCands, idx, { ...DEFAULT_RESALE_OPTIONS }));

process.exit(0);
