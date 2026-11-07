import { collectFromElgigantenHotlist } from './elgigantenHotlist.js';

// Only the Elgiganten hotlist is collected through this registry. The Komplett
// demo and Inet watchers run their own loops. Every other
// scraper was archived on 2026-10-31; see archive/scrapers/README.md for how
// to bring one back.
const handlers = {
  'elgiganten-hotlist': collectFromElgigantenHotlist
};

export async function collectSource(args) {
  const handler = handlers[args.source.type];

  if (!handler) {
    throw new Error(`No source handler registered for ${args.source.type}.`);
  }

  return handler(args);
}
