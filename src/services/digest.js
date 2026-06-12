// ═══════════════════════════════════════════════════════════════
// Daily Discord digest — top new deals by score, once per day at a
// configured Stockholm time. An alternative to per-item alert rules.
// ═══════════════════════════════════════════════════════════════

import { formatSek } from '../lib/utils.js';

const TIME_ZONE = 'Europe/Stockholm';
const NEW_WINDOW_MS = 24 * 60 * 60 * 1000;

function stockholmDay(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function stockholmMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date);
  const hours = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '', 10);
  const minutes = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '', 10);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

function parseTimeOfDay(value, fallback = 8 * 60) {
  const m = String(value ?? '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10) : fallback;
}

/**
 * Fire when: enabled + webhook set, Stockholm time has passed the target,
 * and nothing was sent today. ">= target" (not "== target") makes the digest
 * catch up after restarts or downtime instead of skipping the day.
 */
export function shouldSendDigest(digest, lastSentAt, now = new Date()) {
  if (!digest || digest.enabled !== true) return false;
  if (typeof digest.webhook !== 'string' || !digest.webhook.trim()) return false;

  const currentMinutes = stockholmMinutes(now);
  if (currentMinutes == null || currentMinutes < parseTimeOfDay(digest.time)) return false;

  if (lastSentAt) {
    const last = new Date(lastSentAt);
    if (!Number.isNaN(last.getTime()) && stockholmDay(last) === stockholmDay(now)) return false;
  }
  return true;
}

/** Top deals among items first seen in the last 24 h, sorted by score. */
export function buildDigestDeals(state, { maxItems = 10, minScore = 0 } = {}, now = Date.now()) {
  const cutoff = now - NEW_WINDOW_MS;
  const result = [];

  // state.deals is already sorted by score desc
  for (const deal of state.deals ?? []) {
    if (deal.score < minScore) continue;
    const item = state.items[deal.listingKey];
    const firstSeen = Date.parse(item?.firstSeenAt ?? '');
    if (Number.isNaN(firstSeen) || firstSeen < cutoff) continue;
    result.push(deal);
    if (result.length >= maxItems) break;
  }
  return result;
}

/** One embed; description lines per deal, capped to Discord's 4096-char limit. */
export function buildDigestPayload(deals, now = new Date()) {
  const lines = deals.map((deal, i) => {
    const discount = Number.isFinite(deal.discountPercent) && deal.discountPercent > 0 ? ` (−${deal.discountPercent}%)` : '';
    const line = `**${i + 1}.** [${deal.title}](${deal.url}) — ${formatSek(deal.currentPriceSek)}${discount} • ${deal.sourceLabel}`;
    return line.length > 350 ? line.slice(0, 347) + '…' : line;
  });

  let description = '';
  for (const line of lines) {
    if (description.length + line.length + 1 > 4000) break;
    description += (description ? '\n' : '') + line;
  }

  return {
    username: 'Price Watcher',
    content: `📋 **Daily digest** — top ${deals.length} new deal${deals.length === 1 ? '' : 's'} (${stockholmDay(now)})`,
    embeds: [{ description, color: 0xf0b232 }]
  };
}
