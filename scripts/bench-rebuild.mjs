import process from 'node:process';
import { SqliteStore } from '../src/lib/store.js';
import { loadConfig } from '../src/config.js';
import { computeDeals } from '../src/services/dealEngine.js';
import { ProductCache } from '../src/services/productCache.js';

const config = await loadConfig();
const dbPath = process.env.DB_PATH || './data/store.db';
const store = new SqliteStore(dbPath);
await store.load();
const state = store.getState();
const itemCount = Object.keys(state.items).length;
const sourceLabelMap = new Map(config.sources.map((s) => [s.id, s.label || s.id]));

function time(label, fn, runs = 5) {
  // warm up
  fn();
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    ts.push(Number(t1 - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`${label.padEnd(28)} median ${med.toFixed(1)} ms  (min ${ts[0].toFixed(1)} / max ${ts[ts.length - 1].toFixed(1)})`);
  return med;
}

console.log(`Items in state: ${itemCount}`);
const cache = new ProductCache(config.resale);

const tDeals = time('computeDeals', () => { state.deals = computeDeals(state, config.thresholds); });
const tRebuild = time('productCache.rebuild', () => cache.rebuild(state, sourceLabelMap));

const perSource = tDeals + tRebuild;
console.log(`\nPer-source cost (computeDeals + rebuild): ${perSource.toFixed(1)} ms`);
console.log(`x14 sources per scan: ${(perSource * 14).toFixed(0)} ms of event-loop blocking`);

process.exit(0);
