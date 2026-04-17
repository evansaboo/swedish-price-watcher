import { collectFromApifyElgiganten } from './apifyElgiganten.js';
import { collectFromHtml } from './html.js';
import { collectFromKomplettSitemap } from './komplett.js';
import { collectFromRss } from './rss.js';

const handlers = {
  'apify-elgiganten': collectFromApifyElgiganten,
  'komplett-sitemap': collectFromKomplettSitemap,
  rss: collectFromRss,
  'html-page': collectFromHtml,
  'html-list': collectFromHtml
};

export async function collectSource(args) {
  const handler = handlers[args.source.type];

  if (!handler) {
    throw new Error(`No source handler registered for ${args.source.type}.`);
  }

  return handler(args);
}
