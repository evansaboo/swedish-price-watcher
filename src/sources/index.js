import { collectFromBlocket } from './blocket.js';
import { collectFromApifyElgiganten } from './apifyElgiganten.js';
import { collectFromDustin } from './dustin.js';
import { collectFromElgiganten } from './elgiganten.js';
import { collectFromElgigantenCampaigns } from './elgigantenCampaigns.js';
import { collectFromGgDeals } from './ggdeals.js';
import { collectFromInet } from './inet.js';
import { collectFromKjell } from './kjell.js';
import { collectFromKomplettCategory } from './komplett.js';
import { collectFromNetonnet } from './netonnet.js';
import { collectFromPower } from './power.js';
import { collectFromProshop } from './proshop.js';
import { collectFromRss } from './rss.js';
import { collectFromSweclockers } from './sweclockers.js';
import { collectFromTradera } from './tradera.js';
import { collectFromWebhallen } from './webhallen.js';

const handlers = {
  'apify-elgiganten': collectFromApifyElgiganten,
  blocket: collectFromBlocket,
  'dustin-fyndvaror': collectFromDustin,
  'elgiganten-algolia': collectFromElgiganten,
  'elgiganten-campaigns': collectFromElgigantenCampaigns,
  'gg-deals-games': collectFromGgDeals,
  'inet-fyndhornan': collectFromInet,
  'kjell-outlet': collectFromKjell,
  'komplett-category': collectFromKomplettCategory,
  'netonnet-outlet': collectFromNetonnet,
  'power-deals': collectFromPower,
  'proshop-outlet': collectFromProshop,
  rss: collectFromRss,
  'sweclockers-dagensfynd': collectFromSweclockers,
  'tradera-sold': collectFromTradera,
  'webhallen-api': collectFromWebhallen
};

export async function collectSource(args) {
  const handler = handlers[args.source.type];

  if (!handler) {
    throw new Error(`No source handler registered for ${args.source.type}.`);
  }

  return handler(args);
}
