import { collectFromApifyElgiganten } from './apifyElgiganten.js';
import { collectFromApifyKomplett } from './apifyKomplett.js';
import { collectFromHtml } from './html.js';
import { collectFromKomplettCategory, collectFromKomplettSitemap } from './komplett.js';
import { collectFromNetonnet } from './netonnet.js';
import { collectFromPower } from './power.js';
import { collectFromProshop } from './proshop.js';
import { collectFromRss } from './rss.js';
import { collectFromWebhallen } from './webhallen.js';

const handlers = {
  'apify-elgiganten': collectFromApifyElgiganten,
  'apify-komplett': collectFromApifyKomplett,
  'komplett-category': collectFromKomplettCategory,
  'komplett-sitemap': collectFromKomplettSitemap,
  'netonnet-outlet': collectFromNetonnet,
  'power-deals': collectFromPower,
  'proshop-outlet': collectFromProshop,
  rss: collectFromRss,
  'html-page': collectFromHtml,
  'html-list': collectFromHtml,
  'webhallen-api': collectFromWebhallen
};

export async function collectSource(args) {
  const handler = handlers[args.source.type];

  if (!handler) {
    throw new Error(`No source handler registered for ${args.source.type}.`);
  }

  return handler(args);
}
