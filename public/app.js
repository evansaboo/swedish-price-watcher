// ═══════════════════════════════════════════════════════════════
// PriceWatch dashboard: plain JS + Shoelace web components.
// Shoelace is vendored and served from /vendor/shoelace/ (no CDN).
// The imports below define every component before any code runs, so
// reading .value/.checked on them is always safe.
// ═══════════════════════════════════════════════════════════════
import '/vendor/shoelace/components/alert/alert.js';
import '/vendor/shoelace/components/badge/badge.js';
import '/vendor/shoelace/components/button/button.js';
import '/vendor/shoelace/components/checkbox/checkbox.js';
import '/vendor/shoelace/components/details/details.js';
import '/vendor/shoelace/components/dialog/dialog.js';
import '/vendor/shoelace/components/drawer/drawer.js';
import '/vendor/shoelace/components/icon/icon.js';
import '/vendor/shoelace/components/icon-button/icon-button.js';
import '/vendor/shoelace/components/input/input.js';
import '/vendor/shoelace/components/option/option.js';
import '/vendor/shoelace/components/select/select.js';
import '/vendor/shoelace/components/skeleton/skeleton.js';
import '/vendor/shoelace/components/spinner/spinner.js';
import '/vendor/shoelace/components/switch/switch.js';
import '/vendor/shoelace/components/tab/tab.js';
import '/vendor/shoelace/components/tab-group/tab-group.js';
import '/vendor/shoelace/components/tab-panel/tab-panel.js';
import '/vendor/shoelace/components/tag/tag.js';
import { setBasePath } from '/vendor/shoelace/utilities/base-path.js';

// Icons and other assets resolve from the vendored copy.
setBasePath('/vendor/shoelace');

const sekFormatter = new Intl.NumberFormat('sv-SE', {
  style: 'currency',
  currency: 'SEK',
  maximumFractionDigits: 0
});

// ── STATE ───────────────────────────────────────────────────────
const state = {
  search: '',
  category: '',
  store: '',
  campaign: '',
  discountedOnly: false,
  newOnly: false,
  referenceOnly: false,
  hotOnly: false,
  wishlistOnly: false,
  minDiscountPercent: '',
  minPriceSek: '',
  maxPriceSek: '',
  categories: [],
  sortBy: 'score',
  sortDirection: 'desc',
  currentPage: 1,
  pageSize: 48,
  viewMode: 'grid', // 'grid' or 'list' (phones always get the compact one-column layout)
  activePreset: 'all',
  // Wishlist: a per-item bookmark with its own filter (no alerts).
  wishlist: new Set()
};

const STORAGE_KEY = 'pricewatch-ui-v2';
// Matches the server's newOnly filter: first seen within the last 24 h.
const NEW_PRODUCT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── DOM REFERENCES ──────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const el = {
  searchInput: $('#search-input'),
  categoryFilter: $('#category-filter'),
  storeFilter: $('#store-filter'),
  campaignFilter: $('#campaign-filter'),
  campaignFilterGroup: $('#campaign-filter-group'),
  minDiscountFilter: $('#min-discount-filter'),
  minPriceFilter: $('#min-price-filter'),
  maxPriceFilter: $('#max-price-filter'),
  newOnly: $('#new-only'),
  discountedOnly: $('#discounted-only'),
  referenceOnly: $('#reference-only'),
  filterPills: $$('[data-filter-preset]'),
  filterExpandBtn: $('#filter-expand-btn'),
  filterDrawer: $('#filter-drawer'),
  filterDoneBtn: $('#filter-done-btn'),
  filterCountBadge: $('#filter-count-badge'),
  clearFiltersBtn: $('#clear-filters-btn'),
  activeFilterTags: $('#active-filter-tags'),
  statsPills: $('#stats-pills'),
  productGrid: $('#product-grid'),
  paginationArea: $('#pagination-area'),
  emptyState: $('#empty-state'),
  sortSelect: $('#sort-select'),
  viewGrid: $('#view-grid'),
  viewList: $('#view-list'),
  settingsBtn: $('#settings-btn'),
  settingsDrawer: $('#settings-drawer'),
  settingsTabs: $('#settings-tabs'),
  hotlistStatus: $('#hotlist-status'),
  elgigantenBlock: $('#elgiganten-block'),
  elgigantenBlockText: $('#elgiganten-block-text'),
  elgigantenBlockRetry: $('#elgiganten-block-retry'),
  hotlistEnabled: $('#hotlist-enabled'),
  hotlistInterval: $('#hotlist-interval'),
  hotlistJitter: $('#hotlist-jitter'),
  hotlistMinDiscount: $('#hotlist-min-discount'),
  hotlistWebhook: $('#hotlist-webhook'),
  hotlistNotifyDrops: $('#hotlist-notify-drops'),
  hotlistGroups: $('#hotlist-groups'),
  hotlistCountLabel: $('#hotlist-count-label'),
  hotlistPollNow: $('#hotlist-poll-now'),
  hotlistAddGroup: $('#hotlist-add-group'),
  kdStatus: $('#kd-status'),
  kdEnabled: $('#kd-enabled'),
  kdInterval: $('#kd-interval'),
  kdJitter: $('#kd-jitter'),
  kdMaxUsd: $('#kd-max-usd'),
  kdDropPct: $('#kd-drop-pct'),
  kdBackInStock: $('#kd-back-in-stock'),
  kdWebhook: $('#kd-webhook'),
  kdCountLabel: $('#kd-count-label'),
  kdPollNow: $('#kd-poll-now'),
  kdCategories: $('#kd-categories'),
  kdAlerts: $('#kd-alerts'),
  kdFinds: $('#kd-finds'),
  inetStatus: $('#inet-status'),
  inetEnabled: $('#inet-enabled'),
  inetFeedDeals: $('#inet-feed-deals'),
  inetFeedOutlet: $('#inet-feed-outlet'),
  inetInterval: $('#inet-interval'),
  inetJitter: $('#inet-jitter'),
  inetMaxUsd: $('#inet-max-usd'),
  inetIntervalHint: $('#inet-interval-hint'),
  inetDropPct: $('#inet-drop-pct'),
  inetBackInStock: $('#inet-back-in-stock'),
  inetWebhook: $('#inet-webhook'),
  inetCountLabel: $('#inet-count-label'),
  inetPollNow: $('#inet-poll-now'),
  inetAddGroup: $('#inet-add-group'),
  inetGroups: $('#inet-groups'),
  inetAlerts: $('#inet-alerts'),
  inetFinds: $('#inet-finds'),
  whStatus: $('#wh-status'),
  whEnabled: $('#wh-enabled'),
  whFeedDeals: $('#wh-feed-deals'),
  whFeedOutlet: $('#wh-feed-outlet'),
  whInterval: $('#wh-interval'),
  whJitter: $('#wh-jitter'),
  whMaxUsd: $('#wh-max-usd'),
  whIntervalHint: $('#wh-interval-hint'),
  whDropPct: $('#wh-drop-pct'),
  whBackInStock: $('#wh-back-in-stock'),
  whWebhook: $('#wh-webhook'),
  whCountLabel: $('#wh-count-label'),
  whPollNow: $('#wh-poll-now'),
  whAddGroup: $('#wh-add-group'),
  whGroups: $('#wh-groups'),
  whAlerts: $('#wh-alerts'),
  whFinds: $('#wh-finds'),
  saveSettingsBtn: $('#save-settings-btn'),
  drawerSaveStatus: $('#drawer-save-status'),
  themeToggle: $('#theme-toggle')
};

let filterApplyTimer = null;
let latestProducts = {};
let lastStatus = null; // cached /api/status for product-only refreshes

// Phones get bottom sheets; wider screens get side panels.
const phoneQuery = window.matchMedia('(max-width: 639px)');

// ── UTILITIES ───────────────────────────────────────────────────
function formatSek(value) {
  return Number.isFinite(value) ? sekFormatter.format(Math.round(value)) : 'n/a';
}

function timeAgo(isoStr) {
  if (!isoStr) return null;
  const diffMs = Date.now() - Date.parse(isoStr);
  if (!Number.isFinite(diffMs) || diffMs < 0) return null;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeCategoryKey(category) {
  return String(category ?? '').trim().toLowerCase();
}

function parsePositiveInteger(input) {
  const parsed = Number.parseInt(String(input ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function isNewProduct(product) {
  const firstSeenTimestamp = toTimestamp(product.firstSeenAt);
  if (firstSeenTimestamp == null) return false;
  return Date.now() - firstSeenTimestamp <= NEW_PRODUCT_WINDOW_MS;
}

// <sl-option> values can't be empty or contain spaces (Shoelace replaces
// spaces with underscores), so filter values are URI-encoded and "all" is a
// sentinel.
const ALL_OPTION = '__all';
const toOptionValue = (value) => (value ? encodeURIComponent(value) : ALL_OPTION);
function fromOptionValue(value) {
  if (!value || value === ALL_OPTION) return '';
  try { return decodeURIComponent(value); } catch { return value; }
}

const inputValue = (input) => String(input?.value ?? '').trim();

// ── PERSISTENCE ─────────────────────────────────────────────────
function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      search: state.search,
      category: state.category,
      store: state.store,
      campaign: state.campaign,
      discountedOnly: state.discountedOnly,
      newOnly: state.newOnly,
      referenceOnly: state.referenceOnly,
      hotOnly: state.hotOnly,
      minDiscountPercent: state.minDiscountPercent,
      minPriceSek: state.minPriceSek,
      maxPriceSek: state.maxPriceSek,
      sortBy: state.sortBy,
      sortDirection: state.sortDirection,
      viewMode: state.viewMode,
      activePreset: state.activePreset
    }));
  } catch {}
}

function hydratePrefs() {
  const s = loadPrefs();
  if (typeof s.search === 'string') state.search = s.search;
  if (typeof s.category === 'string') state.category = s.category;
  if (typeof s.store === 'string') state.store = s.store;
  if (typeof s.campaign === 'string') state.campaign = s.campaign;
  if (typeof s.discountedOnly === 'boolean') state.discountedOnly = s.discountedOnly;
  if (typeof s.newOnly === 'boolean') state.newOnly = s.newOnly;
  if (typeof s.referenceOnly === 'boolean') state.referenceOnly = s.referenceOnly;
  if (typeof s.hotOnly === 'boolean') state.hotOnly = s.hotOnly;
  if (typeof s.minDiscountPercent === 'string') state.minDiscountPercent = s.minDiscountPercent;
  if (typeof s.minPriceSek === 'string') state.minPriceSek = s.minPriceSek;
  if (typeof s.maxPriceSek === 'string') state.maxPriceSek = s.maxPriceSek;
  if (typeof s.sortBy === 'string') state.sortBy = s.sortBy;
  if (s.sortDirection === 'asc' || s.sortDirection === 'desc') state.sortDirection = s.sortDirection;
  if (s.viewMode === 'grid' || s.viewMode === 'list') state.viewMode = s.viewMode;
  if (typeof s.activePreset === 'string') state.activePreset = s.activePreset;
  // The "★ Favorites" preset was removed; an old saved choice falls back to All.
  if (state.activePreset === 'favorites') state.activePreset = 'all';

  // Sync UI
  el.searchInput.value = state.search;
  el.newOnly.checked = state.newOnly;
  el.discountedOnly.checked = state.discountedOnly;
  el.referenceOnly.checked = state.referenceOnly;
  el.minDiscountFilter.value = state.minDiscountPercent;
  el.minPriceFilter.value = state.minPriceSek;
  el.maxPriceFilter.value = state.maxPriceSek;
  el.sortSelect.value = `${state.sortBy}-${state.sortDirection}`;
  syncViewMode();
  syncFilterPresets();
}

// ── TOAST NOTIFICATIONS ─────────────────────────────────────────
const TOAST_STYLE = {
  info: ['primary', 'info-circle'],
  success: ['success', 'check2-circle'],
  error: ['danger', 'exclamation-octagon'],
  warning: ['warning', 'exclamation-triangle']
};

function showToast(message, variant = 'info', duration = 4000) {
  const [slVariant, icon] = TOAST_STYLE[variant] ?? TOAST_STYLE.info;
  const alert = Object.assign(document.createElement('sl-alert'), {
    variant: slVariant,
    closable: true,
    duration: duration > 0 ? duration : Infinity
  });
  alert.innerHTML = `<sl-icon slot="icon" name="${icon}"></sl-icon>${escapeHtml(message)}`;
  document.body.append(alert);
  return alert.toast();
}

// ── API HELPERS ─────────────────────────────────────────────────
async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { const p = await response.json(); if (p?.message) message = p.message; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function buildProductsQuery() {
  const params = new URLSearchParams();
  const minDiscount = parsePositiveInteger(state.minDiscountPercent);
  const minPrice = parsePositiveInteger(state.minPriceSek);
  const maxPrice = parsePositiveInteger(state.maxPriceSek);

  if (state.search) params.set('search', state.search);
  if (state.category) params.set('category', state.category);
  if (state.store) params.set('store', state.store);
  if (state.campaign) params.set('campaign', state.campaign);
  if (state.hotOnly) params.set('hotOnly', 'true');
  if (state.discountedOnly) params.set('discountedOnly', 'true');
  if (state.newOnly) params.set('newOnly', 'true');
  if (state.referenceOnly) params.set('referenceOnly', 'true');
  if (state.wishlistOnly) params.set('wishlistOnly', 'true');
  if (minDiscount) params.set('minDiscountPercent', String(minDiscount));
  if (minPrice) params.set('minPriceSek', String(minPrice));
  if (maxPrice) params.set('maxPriceSek', String(maxPrice));

  params.set('sortBy', state.sortBy);
  params.set('sortDir', state.sortDirection);
  params.set('page', String(state.currentPage));
  params.set('pageSize', String(state.pageSize));

  return `?${params.toString()}`;
}

// ── THEME ───────────────────────────────────────────────────────
// Follows the system until the user picks one with the toggle.
function initTheme() {
  const root = document.documentElement;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const saved = () => {
    try { const t = localStorage.getItem('spw-theme'); return t === 'light' || t === 'dark' ? t : null; } catch { return null; }
  };
  function apply(theme) {
    const dark = theme === 'dark';
    root.classList.toggle('sl-theme-dark', dark);
    root.classList.toggle('sl-theme-light', !dark);
    el.themeToggle.name = dark ? 'sun' : 'moon';
    el.themeToggle.label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }
  apply(saved() ?? (systemDark.matches ? 'dark' : 'light'));
  systemDark.addEventListener('change', (e) => { if (!saved()) apply(e.matches ? 'dark' : 'light'); });

  el.themeToggle.addEventListener('click', () => {
    const next = root.classList.contains('sl-theme-dark') ? 'light' : 'dark';
    try { localStorage.setItem('spw-theme', next); } catch {}
    apply(next);
  });
}

// ── VIEW MODE ───────────────────────────────────────────────────
function syncViewMode() {
  el.viewGrid.classList.toggle('active', state.viewMode === 'grid');
  el.viewList.classList.toggle('active', state.viewMode === 'list');
  el.viewGrid.setAttribute('aria-pressed', String(state.viewMode === 'grid'));
  el.viewList.setAttribute('aria-pressed', String(state.viewMode === 'list'));
  el.productGrid.classList.toggle('list-view', state.viewMode === 'list');
}

// ── FILTER PRESETS ──────────────────────────────────────────────
function syncFilterPresets() {
  for (const pill of el.filterPills) {
    const active = pill.getAttribute('data-filter-preset') === state.activePreset;
    pill.variant = active ? 'primary' : 'default';
    pill.setAttribute('aria-pressed', String(active));
    if (pill.dataset.filterPreset === 'wishlist') {
      pill.querySelector('sl-icon')?.setAttribute('name', active ? 'heart-fill' : 'heart');
    }
  }
}

function applyPreset(preset) {
  // Reset boolean filters
  state.newOnly = false;
  state.hotOnly = false;
  state.discountedOnly = false;
  state.referenceOnly = false;
  state.wishlistOnly = false;

  if (preset === 'new') state.newOnly = true;
  else if (preset === 'hot') state.hotOnly = true;
  else if (preset === 'discounted') state.discountedOnly = true;
  else if (preset === 'matched') state.referenceOnly = true;
  else if (preset === 'wishlist') state.wishlistOnly = true;

  state.activePreset = preset;
  el.newOnly.checked = state.newOnly;
  el.discountedOnly.checked = state.discountedOnly;
  el.referenceOnly.checked = state.referenceOnly;
  syncFilterPresets();
  savePrefs();
}

// ── FILTER COUNT ────────────────────────────────────────────────
// Counts what lives in the Filters sheet (search and presets are visible already).
function getActiveFilterCount() {
  let count = 0;
  if (state.category) count++;
  if (state.store) count++;
  if (state.campaign) count++;
  if (state.discountedOnly) count++;
  if (state.newOnly) count++;
  if (state.referenceOnly) count++;
  if (state.minDiscountPercent) count++;
  if (state.minPriceSek) count++;
  if (state.maxPriceSek) count++;
  return count;
}

function syncFilterBadge() {
  const count = getActiveFilterCount();
  el.filterCountBadge.textContent = String(count);
  el.filterCountBadge.classList.toggle('hidden', count === 0);
}

// ── RENDER: ELGIGANTEN BLOCK NOTICE ─────────────────────────────
/**
 * Elgiganten's firewall denies by IP, which silently takes out several sources
 * at once. Surfacing it here means the user sees "blocked until X" instead of
 * an unexplained drop in results.
 */
function renderElgigantenBlock(block) {
  if (!el.elgigantenBlock) return;

  if (!block?.blocked) {
    el.elgigantenBlock.classList.add('hidden');
    return;
  }

  const parts = ['Elgiganten is refusing requests from this network’s IP address, so its sources are paused.'];
  if (block.blockedUntil) {
    const until = new Date(block.blockedUntil);
    if (!Number.isNaN(until.getTime())) {
      parts.push(`Retrying automatically after ${until.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}.`);
    }
  }
  parts.push(block.proxyConfigured
    ? 'A proxy is configured but still blocked — try a different exit IP.'
    : 'Change your public IP (VPN, proxy or a new ISP lease), then hit Retry.');

  el.elgigantenBlockText.textContent = parts.join(' ');
  el.elgigantenBlock.classList.remove('hidden');
}

// ── RENDER: STATS ───────────────────────────────────────────────
function renderStats(status, response) {
  const agg = response?.aggregates ?? {};
  const total = response?.total ?? 0;
  const pills = [
    [total.toLocaleString('sv-SE'), total === 1 ? 'product' : 'products'],
    [status.counts?.listedProducts ?? 0, 'listed'],
    [agg.matched ?? 0, 'matched'],
    [agg.discounted ?? 0, 'discounted'],
    [Number.isFinite(agg.avgDiscountPercent) ? `${agg.avgDiscountPercent}%` : '–', 'avg off']
  ];

  el.statsPills.innerHTML = pills
    .map(([val, label]) => `<span class="stat"><strong>${escapeHtml(String(val))}</strong> ${escapeHtml(label)}</span>`)
    .join('');
}

// ── RENDER: PRODUCTS ────────────────────────────────────────────
const PLACEHOLDER_IMG = '<div class="card-placeholder-img"><sl-icon name="image"></sl-icon></div>';

function renderProducts(response) {
  const products = response?.items ?? [];
  const total = response?.total ?? products.length;
  el.productGrid.setAttribute('aria-busy', 'false');

  if (!total) {
    el.productGrid.innerHTML = '';
    el.paginationArea.innerHTML = '';
    el.emptyState.classList.remove('hidden');
    return;
  }

  el.emptyState.classList.add('hidden');

  const armedKeys = armedSet();
  const cards = products.map((product, idx) => {
    const key = escapeHtml(product.listingKey);
    const isNew = isNewProduct(product);
    const hasDiscount = Number.isFinite(product.discountPercent) && product.discountPercent > 0;
    const score = product.score ?? 0;

    let scoreClass = 's-low';
    if (score >= 75) scoreClass = 's-great';
    else if (score >= 55) scoreClass = 's-good';
    else if (score >= 30) scoreClass = 's-ok';

    // Badges
    const badges = [];
    if (isNew) badges.push('<sl-badge variant="success" pill>New</sl-badge>');
    if (hasDiscount && product.discountPercent >= 20) badges.push(`<sl-badge variant="primary" pill>-${product.discountPercent}%</sl-badge>`);
    if (score >= 75) badges.push('<sl-badge variant="warning" pill>Hot</sl-badge>');
    if (product.affiliate) badges.push('<sl-badge variant="neutral" pill>Annonslänk</sl-badge>');
    const condition = product.conditionLabel && product.conditionLabel !== 'Outlet' ? product.conditionLabel : '';
    if (condition) badges.push(`<sl-badge variant="neutral" pill>${escapeHtml(condition)}</sl-badge>`);

    const imageHtml = product.imageUrl
      ? `<img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
      : PLACEHOLDER_IMG;

    const url = product.url ? escapeHtml(`/api/out/${encodeURIComponent(product.listingKey)}`) : '';
    const titleLink = url
      ? `<a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(product.title)}</a>`
      : escapeHtml(product.title);

    // Reference price
    let refHtml = '';
    if (Number.isFinite(product.initialPriceSek) && product.initialPriceSek > product.currentPriceSek) {
      const conf = product.referenceConfidence;
      const refTitle = conf === 'verified'
        ? 'Reference price corroborated by a catalog match, cross-store prices, or a historical low'
        : conf === 'claimed'
          ? 'Reference price reported by the store only — not independently confirmed'
          : 'Reference price';
      const mark = conf === 'verified'
        ? '<span class="ref-mark verified" title="Verified reference price">✓</span>'
        : conf === 'claimed'
          ? '<span class="ref-mark claimed" title="Store-reported price, unconfirmed">?</span>'
          : '';
      refHtml = `
        <span class="price-ref" title="${escapeHtml(refTitle)}">
          <s class="price-was">${formatSek(product.initialPriceSek)}</s>${mark}
          ${Number.isFinite(product.discountSek) && product.discountSek > 0 ? `<span class="price-save">Save ${formatSek(product.discountSek)}</span>` : ''}
        </span>`;
    }

    // Availability
    const seenText = timeAgo(product.lastSeenAt) ?? '';
    let availDot = 'out';
    let availLabel = 'Unknown';
    if (product.availability === 'in_stock' || product.availability === 'InStock') {
      availDot = 'in-stock'; availLabel = 'In stock';
    } else if (product.availability === 'few_left' || product.availability === 'limited') {
      availDot = 'limited'; availLabel = 'Few left';
    } else if (product.availability === 'out_of_stock') {
      availLabel = 'Out of stock';
    } else if (seenText) {
      availLabel = seenText;
    }
    const availText = seenText && availDot !== 'out' ? `${availLabel} · ${seenText}` : availLabel;

    // Mini sparkline from history
    const historyPoints = product.historyPreview ?? [];
    let sparklineHtml = '';
    if (historyPoints.length >= 2) {
      const prices = historyPoints.map(h => h.priceSek);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const range = maxP - minP || 1;
      const w = 60, h2 = 20;
      const points = prices.map((p, i) => `${(i / (prices.length - 1)) * w},${h2 - ((p - minP) / range) * h2}`).join(' ');
      const trend = prices[prices.length - 1] <= prices[0] ? 'down' : 'up';
      sparklineHtml = `<svg class="sparkline ${trend}" viewBox="0 0 ${w} ${h2}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
    }

    const wish = Boolean(product.wishlisted);
    const armed = armedKeys.has(product.listingKey);
    const cardClass = `product-card${isNew ? ' is-new' : ''}${wish ? ' is-wishlisted' : ''}`;
    const delay = Math.min(idx * 20, 240);

    return `
      <article class="${cardClass}" style="animation-delay:${delay}ms" data-listing-key="${key}">
        <div class="card-media">
          ${imageHtml}
          ${score > 0 ? `<span class="score ${scoreClass}" title="Deal score: ${score}/100">${score}</span>` : ''}
        </div>
        <div class="card-body">
          <div class="card-meta">
            <span class="card-store">${escapeHtml(product.sourceLabel ?? '')}</span>
            <button type="button" class="card-category" data-filter-category="${escapeHtml(product.category)}" title="Filter by this category">${escapeHtml(product.category || 'Uncategorized')}</button>
          </div>
          <h3 class="card-title">${titleLink}</h3>
          ${badges.length ? `<div class="card-badges">${badges.join('')}</div>` : ''}
          <div class="card-pricing">
            <span class="price">${formatSek(product.currentPriceSek)}</span>
            ${refHtml}
          </div>
        </div>
        <div class="card-footer">
          <span class="avail"><span class="avail-dot ${availDot}"></span><span class="avail-text">${escapeHtml(availText)}</span></span>
          <span class="card-actions">
            ${sparklineHtml ? `<button type="button" class="spark-btn" data-listing-key="${key}" aria-label="Price history" title="Price history">${sparklineHtml}</button>` : ''}
            ${isElgigantenListing(product) ? `<sl-icon-button class="arm-btn${armed ? ' active' : ''}" name="${armed ? 'lightning-charge-fill' : 'lightning-charge'}" data-arm-key="${key}" label="${armed ? 'Disarm checkout staging' : 'Arm for checkout staging'}"></sl-icon-button>` : ''}
            <sl-icon-button class="wishlist-btn${wish ? ' active' : ''}" name="${wish ? 'heart-fill' : 'heart'}" data-listing-key="${key}" label="${wish ? 'Remove from wishlist' : 'Add to wishlist'}"></sl-icon-button>
          </span>
        </div>
      </article>
    `;
  }).join('');

  el.productGrid.innerHTML = cards;

  // Broken product images fall back to a neutral placeholder.
  for (const img of el.productGrid.querySelectorAll('.card-media img')) {
    img.addEventListener('error', () => { img.outerHTML = PLACEHOLDER_IMG; }, { once: true });
  }

  // Category chip → filter by that category
  for (const catEl of el.productGrid.querySelectorAll('[data-filter-category]')) {
    catEl.addEventListener('click', () => {
      const catName = catEl.getAttribute('data-filter-category');
      const match = state.categories.find(c => normalizeCategoryKey(c.name) === normalizeCategoryKey(catName));
      el.categoryFilter.value = toOptionValue(match ? match.key : normalizeCategoryKey(catName));
      updateFilters();
    });
  }

  for (const btn of el.productGrid.querySelectorAll('.arm-btn')) {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleArm(btn.getAttribute('data-arm-key'), btn);
    });
  }

  for (const btn of el.productGrid.querySelectorAll('.wishlist-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWishlist(btn.getAttribute('data-listing-key'), btn);
    });
  }

  for (const spark of el.productGrid.querySelectorAll('.spark-btn')) {
    spark.addEventListener('click', () => openPriceHistoryModal(spark.getAttribute('data-listing-key')));
  }

  renderPagination(response);
}

function renderPagination(response) {
  const { page, totalPages, total, pageSize } = response;
  if (totalPages <= 1) { el.paginationArea.innerHTML = ''; return; }

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const pages = new Set([1, totalPages, page, page - 1, page + 1, page - 2, page + 2]);
  const sorted = [...pages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let buttons = '';
  let lastP = 0;
  for (const p of sorted) {
    if (lastP && p - lastP > 1) buttons += '<span class="page-ellipsis">…</span>';
    buttons += `<sl-button class="page-btn" variant="${p === page ? 'primary' : 'default'}" data-page="${p}"${p === page ? ' aria-current="page"' : ''}>${p}</sl-button>`;
    lastP = p;
  }

  el.paginationArea.innerHTML = `
    <div class="pagination-controls">
      <sl-button class="page-nav" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''} aria-label="Previous page"><sl-icon name="chevron-left"></sl-icon></sl-button>
      <span class="page-numbers">${buttons}</span>
      <span class="page-compact">Page ${page} of ${totalPages}</span>
      <sl-button class="page-nav" data-page="${page + 1}"${page >= totalPages ? ' disabled' : ''} aria-label="Next page"><sl-icon name="chevron-right"></sl-icon></sl-button>
    </div>
    <span class="pagination-info">Showing ${start}–${end} of ${total.toLocaleString('sv-SE')}</span>
  `;

  for (const btn of el.paginationArea.querySelectorAll('[data-page]')) {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const target = Number(btn.getAttribute('data-page'));
      if (!Number.isFinite(target) || target < 1 || target > totalPages) return;
      state.currentPage = target;
      loadProducts().catch(err => showToast(err.message, 'error'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}

// ── WISHLIST ────────────────────────────────────────────────────
async function toggleWishlist(listingKey, btnEl) {
  if (!listingKey) return;
  const isWishlisted = state.wishlist.has(listingKey);
  const method = isWishlisted ? 'DELETE' : 'POST';

  try {
    await fetch(`/api/wishlist/${encodeURIComponent(listingKey)}`, { method });
    if (isWishlisted) state.wishlist.delete(listingKey);
    else state.wishlist.add(listingKey);
    const nowWishlisted = !isWishlisted;
    btnEl.classList.toggle('active', nowWishlisted);
    btnEl.name = nowWishlisted ? 'heart-fill' : 'heart';
    btnEl.label = nowWishlisted ? 'Remove from wishlist' : 'Add to wishlist';
    btnEl.closest('.product-card')?.classList.toggle('is-wishlisted', nowWishlisted);
  } catch (err) {
    showToast('Failed to update wishlist', 'error');
  }
}

async function loadWishlist() {
  try {
    const { items } = await fetchJson('/api/wishlist');
    state.wishlist = new Set(items ?? []);
  } catch { state.wishlist = new Set(); }
}

// ── PRICE HISTORY ───────────────────────────────────────────────
async function openPriceHistoryModal(listingKey) {
  const modal = document.getElementById('price-history-modal');
  const chartContainer = document.getElementById('ph-chart-container');
  const statsEl = document.getElementById('ph-stats');

  modal.label = 'Price history';
  chartContainer.innerHTML = '<div class="centered"><sl-spinner></sl-spinner></div>';
  statsEl.innerHTML = '';
  modal.show();

  try {
    const data = await fetchJson(`/api/price-history/${encodeURIComponent(listingKey)}`);
    modal.label = data.title ? `${data.title.slice(0, 60)}${data.title.length > 60 ? '…' : ''}` : 'Price history';

    const history = data.history ?? [];
    if (history.length < 2) {
      chartContainer.innerHTML = '<p class="centered muted">Not enough data points yet</p>';
      return;
    }

    const prices = history.map(h => h.priceSek);
    const dates = history.map(h => new Date(h.seenAt));
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice || 1;

    const chartW = 500, chartH = 220, padL = 70, padR = 16, padY = 24;
    const plotW = chartW - padL - padR, plotH = chartH - padY * 2;

    const points = prices.map((p, i) => {
      const x = padL + (i / (prices.length - 1)) * plotW;
      const y = padY + plotH - ((p - minPrice) / priceRange) * plotH;
      return `${x},${y}`;
    });

    const ySteps = 4;
    let yLabels = '';
    for (let i = 0; i <= ySteps; i++) {
      const val = minPrice + (i / ySteps) * priceRange;
      const y = padY + plotH - (i / ySteps) * plotH;
      yLabels += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" class="chart-label">${formatSek(val)}</text>`;
      yLabels += `<line x1="${padL}" y1="${y}" x2="${chartW - padR}" y2="${y}" class="chart-grid"/>`;
    }

    const xLabels = [0, Math.floor(dates.length / 2), dates.length - 1]
      .map((i, n) => {
        const x = padL + (i / (dates.length - 1)) * plotW;
        const anchor = n === 0 ? 'start' : n === 2 ? 'end' : 'middle';
        return `<text x="${x}" y="${chartH - 4}" text-anchor="${anchor}" class="chart-label">${dates[i].toLocaleDateString('sv-SE', { month: 'short', day: 'numeric' })}</text>`;
      }).join('');

    const trend = prices[prices.length - 1] <= prices[0] ? 'down' : 'up';
    const areaPoints = `${padL},${padY + plotH} ${points.join(' ')} ${chartW - padR},${padY + plotH}`;
    const [lastX, lastY] = points[points.length - 1].split(',');

    chartContainer.innerHTML = `
      <svg class="ph-chart ${trend}" viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Price history chart">
        ${yLabels}
        ${xLabels}
        <polygon class="ph-area" points="${areaPoints}"/>
        <polyline class="ph-line" points="${points.join(' ')}" fill="none" stroke-width="2" stroke-linejoin="round"/>
        <circle class="ph-dot" cx="${lastX}" cy="${lastY}" r="4"/>
      </svg>
    `;

    const currentPrice = prices[prices.length - 1];
    const priceChange = currentPrice - prices[0];
    const changePercent = prices[0] > 0 ? Math.round((priceChange / prices[0]) * 100) : 0;
    const changeClass = priceChange <= 0 ? 'good' : 'bad';

    statsEl.innerHTML = `
      <div class="ph-stat"><span>Current</span><strong>${formatSek(currentPrice)}</strong></div>
      <div class="ph-stat"><span>Lowest</span><strong>${formatSek(data.lowestPriceSek)}</strong></div>
      <div class="ph-stat"><span>Highest</span><strong>${formatSek(data.highestPriceSek)}</strong></div>
      <div class="ph-stat ${changeClass}"><span>Change</span><strong>${priceChange <= 0 ? '' : '+'}${formatSek(priceChange)} (${changePercent}%)</strong></div>
      <div class="ph-stat"><span>Data points</span><strong>${history.length}</strong></div>
    `;
  } catch (err) {
    chartContainer.innerHTML = `<p class="centered error-text">${escapeHtml(err.message)}</p>`;
  }
}

// ── RENDER: FILTERS ─────────────────────────────────────────────
function renderCategoryFilter(categories) {
  if (state.category && !categories.some(c => c.key === state.category)) {
    state.category = '';
    savePrefs();
  }
  el.categoryFilter.innerHTML = [`<sl-option value="${ALL_OPTION}">All categories</sl-option>`]
    .concat(categories.map(c => `<sl-option value="${escapeHtml(toOptionValue(c.key))}">${escapeHtml(c.name)} (${c.count})</sl-option>`))
    .join('');
  el.categoryFilter.value = toOptionValue(state.category);
}

function renderStoreFilter(sources) {
  if (!el.storeFilter || !Array.isArray(sources)) return;
  el.storeFilter.innerHTML = [`<sl-option value="${ALL_OPTION}">All stores</sl-option>`]
    .concat(sources.map(s => {
      const count = Number.isFinite(s.count) ? ` (${s.count})` : '';
      return `<sl-option value="${escapeHtml(toOptionValue(s.id))}">${escapeHtml(s.label)}${count}</sl-option>`;
    })).join('');
  el.storeFilter.value = toOptionValue(state.store);
}

function renderCampaignFilter(campaigns) {
  if (!el.campaignFilter || !Array.isArray(campaigns)) return;
  el.campaignFilter.innerHTML = [`<sl-option value="${ALL_OPTION}">All conditions</sl-option>`]
    .concat(campaigns.map(({ label, value }) => `<sl-option value="${escapeHtml(toOptionValue(value))}">${escapeHtml(label)}</sl-option>`))
    .join('');
  el.campaignFilter.value = toOptionValue(state.campaign);
  el.campaignFilterGroup?.classList.toggle('hidden', campaigns.length === 0);
}

// Active filters as removable tags under the toolbar: one tap clears one.
const FILTER_TAG_CLEARERS = {
  search: () => { el.searchInput.value = ''; },
  category: () => { el.categoryFilter.value = ALL_OPTION; },
  store: () => { el.storeFilter.value = ALL_OPTION; },
  campaign: () => { el.campaignFilter.value = ALL_OPTION; },
  minDiscountPercent: () => { el.minDiscountFilter.value = ''; },
  minPriceSek: () => { el.minPriceFilter.value = ''; },
  maxPriceSek: () => { el.maxPriceFilter.value = ''; },
  newOnly: () => { el.newOnly.checked = false; },
  discountedOnly: () => { el.discountedOnly.checked = false; },
  referenceOnly: () => { el.referenceOnly.checked = false; }
};

function renderActiveFilterTags() {
  const tags = [];
  if (state.search) tags.push(['search', `“${state.search}”`]);
  if (state.category) {
    const cat = state.categories.find(c => c.key === state.category);
    tags.push(['category', cat?.name ?? state.category]);
  }
  if (state.store) {
    const store = (state.sources ?? []).find(s => s.id === state.store);
    tags.push(['store', store?.label ?? state.store]);
  }
  if (state.campaign) tags.push(['campaign', `Condition: ${state.campaign}`]);
  if (state.minDiscountPercent) tags.push(['minDiscountPercent', `≥ ${state.minDiscountPercent}% off`]);
  if (state.minPriceSek) tags.push(['minPriceSek', `Min ${formatSek(Number(state.minPriceSek))}`]);
  if (state.maxPriceSek) tags.push(['maxPriceSek', `Max ${formatSek(Number(state.maxPriceSek))}`]);
  // Presets already show these; only tag them when combined in the sheet.
  if (state.activePreset === '') {
    if (state.newOnly) tags.push(['newOnly', 'New only']);
    if (state.discountedOnly) tags.push(['discountedOnly', 'Discounted']);
    if (state.referenceOnly) tags.push(['referenceOnly', 'Matched price']);
  }

  el.activeFilterTags.innerHTML = tags
    .map(([key, text]) => `<sl-tag size="small" pill removable data-clear="${key}">${escapeHtml(text)}</sl-tag>`)
    .join('');
  for (const tag of el.activeFilterTags.querySelectorAll('sl-tag')) {
    tag.addEventListener('sl-remove', () => {
      FILTER_TAG_CLEARERS[tag.dataset.clear]?.();
      updateFilters();
    });
  }
  syncFilterBadge();
}

// ── FILTER LOGIC ────────────────────────────────────────────────
function applyCurrentFilters() {
  state.search = inputValue(el.searchInput);
  state.category = fromOptionValue(el.categoryFilter.value);
  state.store = fromOptionValue(el.storeFilter?.value);
  state.campaign = fromOptionValue(el.campaignFilter?.value);
  state.discountedOnly = el.discountedOnly.checked;
  state.newOnly = el.newOnly.checked;
  state.referenceOnly = el.referenceOnly.checked;
  state.minDiscountPercent = inputValue(el.minDiscountFilter);
  state.minPriceSek = inputValue(el.minPriceFilter);
  state.maxPriceSek = inputValue(el.maxPriceFilter);

  // Determine active preset
  const presetMap = { new: state.newOnly, hot: state.hotOnly, discounted: state.discountedOnly, matched: state.referenceOnly, wishlist: state.wishlistOnly };
  const activePresets = Object.entries(presetMap).filter(([, v]) => v);
  state.activePreset = activePresets.length === 1 ? activePresets[0][0] : (activePresets.length === 0 ? 'all' : '');
  syncFilterPresets();
  savePrefs();
}

function resetFilters() {
  state.search = '';
  state.category = '';
  state.store = '';
  state.campaign = '';
  state.discountedOnly = false;
  state.newOnly = false;
  state.hotOnly = false;
  state.referenceOnly = false;
  state.wishlistOnly = false;
  state.minDiscountPercent = '';
  state.minPriceSek = '';
  state.maxPriceSek = '';
  state.activePreset = 'all';

  el.searchInput.value = '';
  el.categoryFilter.value = ALL_OPTION;
  if (el.storeFilter) el.storeFilter.value = ALL_OPTION;
  if (el.campaignFilter) el.campaignFilter.value = ALL_OPTION;
  el.discountedOnly.checked = false;
  el.newOnly.checked = false;
  el.referenceOnly.checked = false;
  el.minDiscountFilter.value = '';
  el.minPriceFilter.value = '';
  el.maxPriceFilter.value = '';
  syncFilterPresets();
  savePrefs();
}

function updateFilters({ debounce = false } = {}) {
  applyCurrentFilters();
  state.currentPage = 1;
  if (debounce) {
    if (filterApplyTimer) clearTimeout(filterApplyTimer);
    filterApplyTimer = setTimeout(() => {
      filterApplyTimer = null;
      loadProducts().catch(err => showToast(err.message, 'error'));
    }, 250);
    return;
  }
  loadProducts().catch(err => showToast(err.message, 'error'));
}

// ── MAIN LOAD ───────────────────────────────────────────────────
// Lightweight refresh: only re-fetches the filtered product list.
// Used by filter/sort/pagination changes — metadata (categories, stores)
// rarely changes, so re-fetching it per keystroke just adds latency.
async function loadProducts() {
  const query = buildProductsQuery();
  el.productGrid.classList.add('is-loading');
  try {
    const response = await fetchJson(`/api/outlet-products${query}`);
    latestProducts = response;
    if (lastStatus) renderStats(lastStatus, response);
    renderActiveFilterTags();
    renderProducts(response);
  } finally {
    el.productGrid.classList.remove('is-loading');
  }
}

async function loadDashboard() {
  const [status, categories, outletSources, outletCampaigns] = await Promise.all([
    fetchJson('/api/status'),
    fetchJson('/api/outlet-categories'),
    fetchJson('/api/outlet-sources'),
    fetchJson('/api/outlet-campaigns')
  ]);

  lastStatus = status;
  state.categories = categories ?? [];
  state.sources = outletSources ?? [];

  if (state.category && !state.categories.some(c => c.key === state.category)) {
    state.category = '';
    savePrefs();
  }

  const query = buildProductsQuery();
  const response = await fetchJson(`/api/outlet-products${query}`);
  latestProducts = response;

  renderCategoryFilter(categories ?? []);
  renderStoreFilter(outletSources ?? []);
  renderCampaignFilter(outletCampaigns ?? []);
  renderElgigantenBlock(status.elgigantenBlock);

  renderStats(status, response);
  renderActiveFilterTags();
  renderProducts(response);
}

// ── SHEETS: placement follows the screen size ───────────────────
function placeSheet(drawer) {
  drawer.placement = phoneQuery.matches ? 'bottom' : 'end';
}

// ── SETTINGS DRAWER ─────────────────────────────────────────────
async function openDrawer(tab) {
  placeSheet(el.settingsDrawer);
  if (tab) {
    await el.settingsTabs.updateComplete;
    el.settingsTabs.show(tab);
  }
  if (!el.settingsDrawer.open) {
    el.settingsDrawer.show();
    loadDrawerData();
    startHotlistStatusPolling();
  }
}

function closeDrawer() {
  el.settingsDrawer.hide();
}

function activeSettingsTab() {
  return el.settingsTabs.querySelector('sl-tab[active]')?.panel ?? 'hotlist';
}

function loadDrawerData() {
  // Hotlist config, status and the Elgiganten category catalogue, plus the
  // Komplett demo, Inet and Webhallen watchers. Each loads independently; a
  // failure hides its tab.
  loadHotlist();
  loadKomplettDemo();
  loadInet();
  loadWebhallen();
}

function hideSettingsTab(name) {
  const tab = el.settingsTabs.querySelector(`sl-tab[panel="${name}"]`);
  const panel = el.settingsTabs.querySelector(`sl-tab-panel[name="${name}"]`);
  if (tab) tab.hidden = true;
  if (panel) panel.hidden = true;
  if (activeSettingsTab() === name) {
    const next = el.settingsTabs.querySelector('sl-tab:not([hidden])');
    if (next) el.settingsTabs.show(next.panel);
  }
}

// ── CHIP INPUT (hotlist categories, brands, keywords) ───────────
function wireChipInput({ container, items, onAdd, onRemove, allOptions, placeholder }) {
  const chipList = container.querySelector('.chip-list');
  const textInput = container.querySelector('.chip-text-input');
  const dropdown = container.querySelector('.kw-cat-dropdown');
  if (placeholder) textInput.setAttribute('placeholder', placeholder);

  function refreshChips() {
    chipList.innerHTML = items
      .map(v => `<sl-tag class="chip" size="medium" pill removable data-val="${escapeHtml(v)}">${escapeHtml(v)}</sl-tag>`)
      .join('');
    chipList.querySelectorAll('sl-tag').forEach(tag => {
      tag.addEventListener('sl-remove', e => {
        e.stopPropagation();
        const val = tag.dataset.val;
        const idx = items.indexOf(val);
        if (idx !== -1) items.splice(idx, 1);
        onRemove(val);
        refreshChips();
        if (dropdown) renderDropdown();
      });
    });
    container.classList.toggle('has-chips', items.length > 0);
  }

  function addValue(val) {
    val = val.trim();
    if (!val || items.includes(val)) return;
    items.push(val);
    onAdd(val);
    textInput.value = '';
    refreshChips();
    if (dropdown) renderDropdown();
  }

  function renderDropdown() {
    if (!dropdown || !allOptions) return;
    const search = textInput.value.toLowerCase().trim();
    const available = allOptions.filter(o => !items.includes(o));
    const filtered = search ? available.filter(o => o.toLowerCase().includes(search)) : available;
    dropdown.innerHTML = filtered.length
      ? filtered.slice(0, 30).map(o => `<li class="kw-cat-option" data-cat="${escapeHtml(o)}">${escapeHtml(o)}</li>`).join('')
      : '<li class="kw-cat-option kw-cat-empty">No matches</li>';
    for (const li of dropdown.querySelectorAll('.kw-cat-option[data-cat]')) {
      li.addEventListener('mousedown', e => { e.preventDefault(); addValue(li.dataset.cat); dropdown.classList.add('hidden'); });
    }
  }

  // Phone keyboards often don't send usable key events (Android IME reports
  // keyCode 229 / "Unidentified"), so Enter/comma keydown alone isn't enough.
  // Free-text inputs (no fixed option list) also commit via an Add button,
  // a typed comma, the keyboard's Done key, and leaving the field.
  const freeText = !allOptions;
  textInput.setAttribute('enterkeyhint', 'done');
  const commitTyped = () => {
    const parts = textInput.value.split(',');
    for (const part of parts) addValue(part);
    textInput.value = '';
  };
  if (freeText) {
    const addBtn = document.createElement('sl-button');
    addBtn.className = 'chip-add-btn';
    addBtn.variant = 'primary';
    addBtn.outline = true;
    addBtn.textContent = 'Add';
    // pointerdown + preventDefault keeps focus (and the keyboard) on the input.
    addBtn.addEventListener('pointerdown', e => e.preventDefault());
    addBtn.addEventListener('click', () => { commitTyped(); textInput.focus(); });
    textInput.insertAdjacentElement('afterend', addBtn);
    textInput.addEventListener('input', () => {
      if (textInput.value.includes(',')) {
        const parts = textInput.value.split(',');
        const rest = parts.pop();
        for (const part of parts) addValue(part);
        textInput.value = rest;
      }
    });
    textInput.addEventListener('blur', () => { if (textInput.value.trim()) commitTyped(); });
  }
  textInput.addEventListener('keyup', e => {
    // Android: Enter often arrives only as keyup (keydown is 229 during composition).
    if ((e.key === 'Enter' || e.keyCode === 13) && textInput.value.trim()) { commitTyped(); if (dropdown) dropdown.classList.add('hidden'); }
  });

  textInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addValue(textInput.value); if (dropdown) dropdown.classList.add('hidden'); }
    else if (e.key === 'Escape') {
      // Close the suggestion list without also closing the whole drawer.
      if (dropdown && !dropdown.classList.contains('hidden')) e.stopPropagation();
      if (dropdown) dropdown.classList.add('hidden');
      textInput.blur();
    }
    else if (e.key === 'Backspace' && !textInput.value && items.length) { const last = items[items.length - 1]; items.splice(items.length - 1, 1); onRemove(last); refreshChips(); }
  });

  if (dropdown) {
    textInput.addEventListener('focus', () => {
      if (allOptions) { renderDropdown(); dropdown.classList.remove('hidden'); }
    });
    textInput.addEventListener('input', () => {
      if (allOptions) { renderDropdown(); dropdown.classList.remove('hidden'); }
    });
    textInput.addEventListener('blur', () => { setTimeout(() => dropdown.classList.add('hidden'), 150); });
  }
  refreshChips();
}

// ── HOTLIST (continuous Elgiganten poller) ──────────────────────
// The hotlist polls on its own fast loop, so it gets its own settings tab
// covering cadence and what to watch.

let hotlistConfig = null;
let hotlistCatalog = { categories: [], brands: [] };
let hotlistStatusTimer = null;
// Which watch groups are expanded, so a re-render keeps them open.
const hotlistOpenGroups = new Set();

function relativeTime(iso, { assumePast = false } = {}) {
  if (!iso) return null;
  let deltaMs = Date.parse(iso) - Date.now();
  if (!Number.isFinite(deltaMs)) return null;
  // The server and browser clocks drift by a second or two, which would other-
  // wise render a poll that has already happened as "in 1s".
  if (assumePast && deltaMs > 0) deltaMs = 0;
  const seconds = Math.round(Math.abs(deltaMs) / 1000);
  if (seconds < 5) return assumePast ? 'just now' : 'any moment';
  const text = seconds < 60
    ? `${seconds}s`
    : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
  return deltaMs >= 0 ? `in ${text}` : `${text} ago`;
}

function statusCardHtml({ stateClass, stateLabel, meta, stats, error, notes }) {
  return `
    <div class="status-head">
      <span class="status-dot ${stateClass}"></span>
      <strong>${escapeHtml(stateLabel)}</strong>
      ${meta ? `<span class="status-meta">${escapeHtml(meta)}</span>` : ''}
    </div>
    <dl class="status-grid">
      ${stats.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}
    </dl>
    ${error ? `<p class="status-error">${escapeHtml(error)}</p>` : ''}
    ${(notes ?? []).map((note) => `<p class="status-note">${escapeHtml(note)}</p>`).join('')}`;
}

function renderHotlistStatus(status) {
  if (!el.hotlistStatus) return;
  if (!status) { el.hotlistStatus.innerHTML = ''; return; }

  el.hotlistStatus.innerHTML = statusCardHtml({
    stateClass: status.lastError ? 'error' : status.enabled ? 'ok' : 'idle',
    stateLabel: status.lastError ? 'Failing' : !status.enabled ? 'Paused' : status.running ? 'Polling…' : 'Watching',
    meta: status.lastDurationMs != null ? `${status.lastDurationMs} ms/poll` : '',
    stats: [
      ['Deals tracked', status.lastCount ?? '—'],
      ['Last poll', relativeTime(status.lastSuccessAt, { assumePast: true }) ?? 'never'],
      ['Next poll', status.enabled ? (relativeTime(status.nextPollAt) ?? '—') : 'paused'],
      ['Polls', status.pollCount ?? 0]
    ],
    error: status.lastError,
    notes: status.lastNewListings ? [`${status.lastNewListings} new listing(s) on the last poll.`] : []
  });
}

function createEmptyHotlistGroup() {
  return {
    id: `hg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    label: '',
    enabled: true,
    stores: ['elgiganten-hotlist'],
    taxonomyIds: [],
    taxonomyNames: [],
    brands: [],
    keywords: [],
    strictKeywordMatch: true,
    minDiscountPct: null,
    minPriceSek: null,
    maxPriceSek: null
  };
}

function chipFieldHtml({ id, label, hint, placeholder }) {
  return `
    <div class="chip-field">
      <span class="field-label">${escapeHtml(label)} <span class="field-hint-inline">${escapeHtml(hint)}</span></span>
      <div class="chip-input-wrap" id="${id}">
        <div class="chip-list"></div>
        <div class="chip-entry"><input type="text" class="chip-text-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" autocapitalize="off" /></div>
        <ul class="kw-cat-dropdown hidden"></ul>
      </div>
    </div>`;
}

function hotlistGroupSummary(group) {
  const parts = [];
  if (group.keywords.length) parts.push(`${group.keywords.length} keyword${group.keywords.length === 1 ? '' : 's'}`);
  if (group.taxonomyNames.length) parts.push(`${group.taxonomyNames.length} categor${group.taxonomyNames.length === 1 ? 'y' : 'ies'}`);
  if (group.brands.length) parts.push(`${group.brands.length} brand${group.brands.length === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'Nothing to match yet';
}

function createHotlistGroupElement(group) {
  const details = document.createElement('sl-details');
  details.className = `watch${group.enabled ? '' : ' is-disabled'}`;
  details.open = hotlistOpenGroups.has(group.id);
  const numeric = (value) => (value != null ? value : '');
  // Amazon.se was archived on 2026-10-31, so Elgiganten is the only store left.
  // A watch saved as Amazon-only would silently never run; say so and offer
  // to switch it over.
  const storesKnown = Array.isArray(group.stores) && group.stores.length > 0;
  const watchesElgiganten = !storesKnown || group.stores.includes('elgiganten-hotlist') || group.stores.includes('all');

  details.innerHTML = `
    <div slot="summary" class="watch-summary">
      <span class="watch-title">
        <span class="watch-name"></span>
        <sl-badge class="watch-off" variant="neutral" pill>Off</sl-badge>
      </span>
      <span class="watch-meta"></span>
    </div>
    <div class="watch-body">
      ${watchesElgiganten ? '' : '<sl-alert variant="warning" open class="legacy-note">This watch only targeted Amazon.se, which is no longer polled. <sl-button size="small" class="hl-use-elgiganten">Watch on Elgiganten</sl-button></sl-alert>'}
      <div class="watch-top">
        <sl-switch class="hl-enabled-cb" ${group.enabled ? 'checked' : ''}>Enabled</sl-switch>
        <sl-button class="hl-delete-btn" variant="danger" outline size="small"><sl-icon slot="prefix" name="trash3"></sl-icon>Delete</sl-button>
      </div>
      <sl-input class="hl-label-input" label="Watch name" placeholder="e.g. GPU flips" value="${escapeHtml(group.label)}"></sl-input>
      ${chipFieldHtml({ id: `hl-kw-${group.id}`, label: 'Keywords', hint: 'type, then tap Add (or comma/Enter)', placeholder: 'e.g. RTX 5090, MacBook M3' })}
      <sl-switch class="hl-strict-cb" ${group.strictKeywordMatch !== false ? 'checked' : ''} help-text="Require the keyword to appear in the product title.">Exact title match</sl-switch>
      ${chipFieldHtml({ id: `hl-cat-${group.id}`, label: 'Categories', hint: 'e.g. GPU, Laptop, SSD', placeholder: 'Search categories…' })}
      ${chipFieldHtml({ id: `hl-brand-${group.id}`, label: 'Brands', hint: 'e.g. Apple, Asus, Sony', placeholder: 'e.g. Apple' })}
      <div class="form-grid-3">
        <sl-input class="hl-mindiscount" label="Min off %" type="number" inputmode="numeric" placeholder="default" min="0" max="99" step="1" value="${numeric(group.minDiscountPct)}"></sl-input>
        <sl-input class="hl-minprice" label="Min price" type="number" inputmode="numeric" placeholder="any" min="0" step="100" value="${numeric(group.minPriceSek)}"></sl-input>
        <sl-input class="hl-maxprice" label="Max price" type="number" inputmode="numeric" placeholder="any" min="0" step="100" value="${numeric(group.maxPriceSek)}"></sl-input>
      </div>
      ${group.taxonomyIds?.length ? `<p class="muted small">Also matching legacy category ${group.taxonomyIds.map(escapeHtml).join(', ')}</p>` : ''}
    </div>`;

  const syncSummary = () => {
    details.querySelector('.watch-name').textContent = group.label || 'Untitled watch';
    details.querySelector('.watch-meta').textContent = hotlistGroupSummary(group);
    details.classList.toggle('is-disabled', !group.enabled);
  };
  syncSummary();

  details.addEventListener('sl-show', (e) => { if (e.target === details) hotlistOpenGroups.add(group.id); });
  details.addEventListener('sl-hide', (e) => { if (e.target === details) hotlistOpenGroups.delete(group.id); });

  details.querySelector('.hl-use-elgiganten')?.addEventListener('click', () => {
    group.stores = [...new Set([...(group.stores ?? []), 'elgiganten-hotlist'])];
    renderHotlistGroups();
  });

  details.querySelector('.hl-enabled-cb').addEventListener('sl-change', (e) => {
    group.enabled = e.target.checked;
    syncSummary();
    renderHotlistCount();
  });
  details.querySelector('.hl-label-input').addEventListener('sl-input', (e) => { group.label = e.target.value; syncSummary(); });
  details.querySelector('.hl-strict-cb').addEventListener('sl-change', (e) => { group.strictKeywordMatch = e.target.checked; });
  details.querySelector('.hl-delete-btn').addEventListener('click', () => {
    hotlistConfig.groups = hotlistConfig.groups.filter((g) => g.id !== group.id);
    hotlistOpenGroups.delete(group.id);
    renderHotlistGroups();
  });

  const numberField = (selector, key) => {
    details.querySelector(selector).addEventListener('sl-input', (e) => {
      const raw = String(e.target.value ?? '').trim();
      const parsed = Number(raw);
      group[key] = raw === '' || !Number.isFinite(parsed) ? null : parsed;
    });
  };
  numberField('.hl-mindiscount', 'minDiscountPct');
  numberField('.hl-minprice', 'minPriceSek');
  numberField('.hl-maxprice', 'maxPriceSek');

  wireChipInput({
    container: details.querySelector(`#hl-cat-${group.id}`),
    items: group.taxonomyNames,
    onAdd: syncSummary, onRemove: syncSummary,
    allOptions: hotlistCatalog.categories
  });
  wireChipInput({
    container: details.querySelector(`#hl-brand-${group.id}`),
    items: group.brands,
    onAdd: syncSummary, onRemove: syncSummary,
    allOptions: hotlistCatalog.brands
  });
  wireChipInput({
    container: details.querySelector(`#hl-kw-${group.id}`),
    items: group.keywords,
    onAdd: () => { syncSummary(); renderHotlistCount(); },
    onRemove: () => { syncSummary(); renderHotlistCount(); },
    allOptions: null
  });

  return details;
}

function renderHotlistCount() {
  if (!el.hotlistCountLabel || !hotlistConfig) return;
  const groups = hotlistConfig.groups ?? [];
  const active = groups.filter((g) => g.enabled);
  const queries = active.reduce((sum, g) => sum + Math.max(g.keywords.length, 1), 0);
  el.hotlistCountLabel.textContent = groups.length
    ? `${active.length}/${groups.length} active · ${queries} quer${queries === 1 ? 'y' : 'ies'} per poll`
    : 'No watches';
}

function renderHotlistGroups() {
  if (!el.hotlistGroups || !hotlistConfig) return;
  el.hotlistGroups.innerHTML = '';
  renderHotlistCount();

  if (!hotlistConfig.groups.length) {
    el.hotlistGroups.innerHTML = '<div class="empty-mini"><sl-icon name="lightning-charge"></sl-icon><strong>Nothing on the hotlist</strong><span>Add a watch to poll Elgiganten continuously for a category, brand or keyword.</span></div>';
    return;
  }
  for (const group of hotlistConfig.groups) {
    el.hotlistGroups.appendChild(createHotlistGroupElement(group));
  }
}

// Live "checks every X–Y s" hint for the hotlist interval and jitter fields.
// Mirrors the server: 30 s floor and 3600 s cap (hotlistConfig.js), jitter up to 50%.
const HOTLIST_MIN_INTERVAL_S = 30;
function renderHotlistIntervalHint() {
  const hint = document.getElementById('hotlist-interval-hint');
  if (!hint) return;
  const raw = Number(el.hotlistInterval.value);
  const base = Math.min(3600, Math.max(HOTLIST_MIN_INTERVAL_S, Number.isFinite(raw) && raw > 0 ? raw : HOTLIST_MIN_INTERVAL_S));
  const jitter = Math.min(50, Math.max(0, Number(el.hotlistJitter.value) || 0));
  const lo = Math.round(base * (1 - jitter / 100));
  const hi = Math.round(base * (1 + jitter / 100));
  const clamped = Number.isFinite(raw) && raw > 0 && raw < HOTLIST_MIN_INTERVAL_S ? ` (raised to the ${HOTLIST_MIN_INTERVAL_S} s minimum)` : '';
  hint.textContent = jitter
    ? `Checks Elgiganten at random every ${lo}–${hi} s (~${base} s)${clamped}. Minimum ${HOTLIST_MIN_INTERVAL_S} s, to keep your IP safe.`
    : `Checks Elgiganten every ${base} s${clamped}. Add jitter so checks don't follow a fixed rhythm. Minimum ${HOTLIST_MIN_INTERVAL_S} s.`;
}
for (const input of [el.hotlistInterval, el.hotlistJitter]) {
  input?.addEventListener('sl-input', renderHotlistIntervalHint);
  input?.addEventListener('input', renderHotlistIntervalHint);
}

function renderHotlistForm() {
  if (!hotlistConfig) return;
  el.hotlistEnabled.checked = hotlistConfig.enabled !== false;
  el.hotlistInterval.value = String(hotlistConfig.intervalSeconds ?? '');
  el.hotlistJitter.value = String(hotlistConfig.jitterPct ?? '');
  renderHotlistIntervalHint();
  el.hotlistMinDiscount.value = String(hotlistConfig.minDiscountPct ?? '');
  if (el.hotlistWebhook) el.hotlistWebhook.value = hotlistConfig.webhookUrl ?? '';
  if (el.hotlistNotifyDrops) el.hotlistNotifyDrops.checked = hotlistConfig.notifyPriceDrops !== false;
  renderHotlistGroups();
}

async function loadHotlistCatalog() {
  if (hotlistCatalog.categories.length) return;
  try {
    const catalog = await fetchJson('/api/hotlist/catalog?limit=1000');
    hotlistCatalog = {
      categories: catalog.categories.map((entry) => entry.value),
      brands: catalog.brands.map((entry) => entry.value)
    };
  } catch {
    // A missing catalogue only costs autocomplete — typing a name still works.
    hotlistCatalog = { categories: [], brands: [] };
  }
}

async function loadHotlist() {
  try {
    const payload = await fetchJson('/api/hotlist');
    hotlistConfig = payload.config;
    renderHotlistStatus(payload.status);
    await loadHotlistCatalog();
    renderHotlistForm();
  } catch {
    // No hotlist source configured — hide the tab rather than show a dead one.
    hideSettingsTab('hotlist');
  }
}

async function refreshHotlistStatus() {
  try {
    const payload = await fetchJson('/api/hotlist');
    renderHotlistStatus(payload.status);
  } catch { /* transient — the next tick retries */ }
}

function startHotlistStatusPolling() {
  stopHotlistStatusPolling();
  hotlistStatusTimer = setInterval(() => {
    refreshHotlistStatus();
    refreshKomplettDemoStatus();
    refreshInetStatus();
    refreshWebhallenStatus();
  }, 10_000);
}

function stopHotlistStatusPolling() {
  if (hotlistStatusTimer) clearInterval(hotlistStatusTimer);
  hotlistStatusTimer = null;
}

function collectHotlistConfig() {
  const toNumber = (input, fallback) => {
    const raw = inputValue(input);
    const parsed = Number(raw);
    return raw !== '' && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    enabled: el.hotlistEnabled.checked,
    intervalSeconds: toNumber(el.hotlistInterval, hotlistConfig.intervalSeconds),
    jitterPct: toNumber(el.hotlistJitter, hotlistConfig.jitterPct),
    minDiscountPct: toNumber(el.hotlistMinDiscount, hotlistConfig.minDiscountPct),
    webhookUrl: el.hotlistWebhook ? inputValue(el.hotlistWebhook) : (hotlistConfig.webhookUrl ?? ''),
    notifyPriceDrops: el.hotlistNotifyDrops ? el.hotlistNotifyDrops.checked : hotlistConfig.notifyPriceDrops !== false,
    // `sources` (the per-store switches) is left out: the server merges over the
    // saved config, so the stored value is kept as is.
    groups: hotlistConfig.groups
  };
}

// ── KOMPLETT DEMO (B-grade demovaror watcher) ───────────────────
// Its own randomised loop like the hotlist; each check is one Apify run, so
// the status line shows this month's Apify spend against the cap.

let komplettDemo = null; // { config, catalog, limits, lastStatus }
// Which category groups are expanded (null = not decided yet: open the ones in use).
let kdOpenGroups = null;

const KD_REASON_LABELS = { 'new': 'New', 'price-drop': 'Price drop', 'back-in-stock': 'Back in stock' };
const KD_REASON_VARIANTS = { 'new': 'success', 'price-drop': 'primary', 'back-in-stock': 'warning' };

function formatUsd(value, digits = 3) {
  return Number.isFinite(value) ? `$${value.toFixed(digits)}` : '—';
}

function renderKomplettDemoStatus(status) {
  if (!el.kdStatus) return;
  if (!status) { el.kdStatus.innerHTML = ''; return; }
  if (komplettDemo) komplettDemo.lastStatus = status;

  const guard = status.costGuard ?? {};
  const notes = [];
  if (guard.stretched && !guard.exhausted) {
    notes.push(`Cost guard: checking every ~${Math.round(status.effectiveIntervalMinutes)} min to stay under ${formatUsd(guard.maxMonthlyUsd, 2)} this month.`);
  }
  if (guard.exhausted) notes.push('This month\'s Apify cap is used up; automatic checks resume next month.');
  if (status.lastWarning) notes.push(status.lastWarning);
  if (status.lastAlertCount) notes.push(`${status.lastAlertCount} alert(s) on the last check.`);
  if (status.pendingAlerts) notes.push(`${status.pendingAlerts} Discord alert(s) waiting to be retried.`);

  el.kdStatus.innerHTML = statusCardHtml({
    stateClass: status.lastError ? 'error' : status.enabled ? 'ok' : 'idle',
    stateLabel: status.lastError
      ? 'Failing'
      : !status.enabled ? 'Paused'
        : status.running ? 'Checking…'
          : guard.exhausted ? 'Monthly cap reached' : 'Watching',
    meta: `${status.categories?.length ?? 0} categories · ${status.trackedProducts ?? 0} tracked · ${status.pollCount ?? 0} checks`,
    stats: [
      ['Last check', relativeTime(status.lastSuccessAt, { assumePast: true }) ?? 'never'],
      ['Next check', status.enabled ? (relativeTime(status.nextPollAt) ?? '—') : 'paused'],
      ['Apify this month', `${formatUsd(guard.spentUsd)} / ${formatUsd(guard.maxMonthlyUsd, 2)}`],
      ['Projected', `${formatUsd(guard.projectedMonthUsd, 2)}`]
    ],
    error: status.lastError,
    notes
  });

  renderKomplettDemoFinds(status);
  renderKomplettDemoCategoryMeta(status);
}

function kdFindItem(entry, { reason = null } = {}) {
  const when = reason ? timeAgo(entry.at) : timeAgo(entry.firstSeenAt);
  const priceLine = reason === 'price-drop' && Number.isFinite(entry.previousPriceSek)
    ? `${formatSek(entry.priceSek)} <s>${formatSek(entry.previousPriceSek)}</s>`
    : formatSek(entry.priceSek);
  const tags = [
    reason ? `<sl-badge variant="${KD_REASON_VARIANTS[reason] ?? 'neutral'}" pill>${escapeHtml(KD_REASON_LABELS[reason] ?? reason)}</sl-badge>` : '',
    reason && entry.delivered === false ? `<sl-badge variant="neutral" pill title="${escapeHtml(entry.note ?? '')}">not sent</sl-badge>` : ''
  ].join('');
  return `
    <li class="find">
      ${entry.imageUrl ? `<img src="${escapeHtml(entry.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="find-noimg"></span>'}
      <div class="find-body">
        <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.title)}</a>
        <div class="find-meta">
          <strong>${priceLine}</strong>
          <span>${escapeHtml(entry.categoryLabel ?? '')}</span>
          ${when ? `<span>${escapeHtml(when)}</span>` : ''}
          ${tags}
        </div>
      </div>
    </li>`;
}

function renderKomplettDemoFinds(status) {
  if (!el.kdAlerts || !el.kdFinds) return;
  const alerts = (status?.recentAlerts ?? []).slice(0, 10);
  const finds = status?.latestFinds ?? [];
  el.kdAlerts.innerHTML = alerts.map((entry) => kdFindItem(entry, { reason: entry.reason })).join('');
  el.kdAlerts.classList.toggle('hidden', alerts.length === 0);
  el.kdFinds.innerHTML = finds.length
    ? finds.map((entry) => kdFindItem(entry)).join('')
    : `<li class="find-empty">${status?.categories?.length ? 'Nothing recorded yet. The first check records what is listed now, without alerts.' : 'Pick at least one category above.'}</li>`;
  // Images from Komplett that fail (offline, moved) just disappear.
  for (const img of el.kdAlerts.querySelectorAll('img')) img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'find-noimg' })), { once: true });
  for (const img of el.kdFinds.querySelectorAll('img')) img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'find-noimg' })), { once: true });
}

function renderKomplettDemoCount() {
  if (!el.kdCountLabel || !komplettDemo) return;
  const count = komplettDemo.config.categories.length;
  el.kdCountLabel.textContent = count
    ? `${count} categor${count === 1 ? 'y' : 'ies'} selected · 1 Apify run per check`
    : 'No categories selected';
}

function renderKomplettDemoCategoryMeta(status) {
  if (!el.kdCategories) return;
  const byId = new Map((status?.categories ?? []).map((c) => [c.id, c]));
  for (const meta of el.kdCategories.querySelectorAll('[data-kd-meta]')) {
    const info = byId.get(meta.dataset.kdMeta);
    if (!info) { meta.textContent = ''; meta.title = ''; meta.className = 'kd-cat-meta'; continue; }
    meta.textContent = info.lastError ? '⚠' : Number.isFinite(info.total) ? `${info.total}` : (info.seeded ? '' : 'new');
    meta.className = `kd-cat-meta${info.lastError ? ' warn' : ''}`;
    meta.title = info.lastError
      ? info.lastError
      : Number.isFinite(info.total) ? `${info.total} demo products listed` : (info.seeded ? '' : 'Recorded silently on the next check');
  }
}

function syncKomplettDemoGroupBoxes() {
  if (!el.kdCategories || !komplettDemo) return;
  const selected = new Set(komplettDemo.config.categories);
  for (const groupBox of el.kdCategories.querySelectorAll('sl-checkbox[data-kd-group]')) {
    const group = komplettDemo.catalog.find((g) => g.group === groupBox.dataset.kdGroup);
    const picked = group ? group.categories.filter((c) => selected.has(c.id)).length : 0;
    const total = group?.categories.length ?? 0;
    groupBox.checked = group ? picked === total : false;
    groupBox.indeterminate = picked > 0 && picked < total;
    const badge = el.kdCategories.querySelector(`[data-kd-group-count="${CSS.escape(groupBox.dataset.kdGroup)}"]`);
    if (badge) {
      badge.textContent = `${picked}/${total}`;
      badge.variant = picked > 0 ? 'primary' : 'neutral';
    }
  }
  renderKomplettDemoCount();
}

function renderKomplettDemoCategories() {
  if (!el.kdCategories || !komplettDemo) return;
  const selected = new Set(komplettDemo.config.categories);
  if (!kdOpenGroups) {
    kdOpenGroups = new Set(komplettDemo.catalog
      .filter((g) => g.categories.some((c) => selected.has(c.id)))
      .map((g) => g.group));
  }
  el.kdCategories.innerHTML = komplettDemo.catalog.map((group) => `
    <sl-details class="kd-group" data-kd-details="${escapeHtml(group.group)}" ${kdOpenGroups.has(group.group) ? 'open' : ''}>
      <div slot="summary" class="kd-summary">
        <span>${escapeHtml(group.label)}</span>
        <sl-badge variant="neutral" pill data-kd-group-count="${escapeHtml(group.group)}"></sl-badge>
      </div>
      ${group.categories.length > 1 ? `<sl-checkbox class="kd-all" data-kd-group="${escapeHtml(group.group)}">Select all</sl-checkbox>` : `<sl-checkbox class="kd-all hidden" data-kd-group="${escapeHtml(group.group)}"></sl-checkbox>`}
      <div class="kd-cat-list">
        ${group.categories.map((category) => `
          <div class="kd-cat">
            <sl-checkbox data-kd-cat="${escapeHtml(category.id)}" ${selected.has(category.id) ? 'checked' : ''}>${escapeHtml(category.label)}</sl-checkbox>
            <span class="kd-cat-meta" data-kd-meta="${escapeHtml(category.id)}"></span>
            <a class="kd-cat-link" href="${escapeHtml(category.url)}" target="_blank" rel="noopener noreferrer" title="Open on Komplett" aria-label="Open ${escapeHtml(category.label)} on Komplett"><sl-icon name="box-arrow-up-right"></sl-icon></a>
          </div>`).join('')}
      </div>
    </sl-details>`).join('');
  for (const details of el.kdCategories.querySelectorAll('sl-details')) {
    details.addEventListener('sl-show', (e) => { if (e.target === details) kdOpenGroups.add(details.dataset.kdDetails); });
    details.addEventListener('sl-hide', (e) => { if (e.target === details) kdOpenGroups.delete(details.dataset.kdDetails); });
  }
  syncKomplettDemoGroupBoxes();
  renderKomplettDemoCategoryMeta(komplettDemo.lastStatus);
}

function setKomplettDemoCategories(ids) {
  // Keep catalog order so the saved list is stable.
  const wanted = new Set(ids);
  komplettDemo.config.categories = komplettDemo.catalog
    .flatMap((g) => g.categories.map((c) => c.id))
    .filter((id) => wanted.has(id));
}

function onKomplettDemoCategoryChange(event) {
  const target = event.target;
  if (target?.tagName !== 'SL-CHECKBOX' || !komplettDemo) return;
  const selected = new Set(komplettDemo.config.categories);
  if (target.dataset.kdGroup) {
    const group = komplettDemo.catalog.find((g) => g.group === target.dataset.kdGroup);
    for (const category of group?.categories ?? []) {
      if (target.checked) selected.add(category.id); else selected.delete(category.id);
    }
    for (const box of el.kdCategories.querySelectorAll('sl-checkbox[data-kd-cat]')) {
      if (group?.categories.some((c) => c.id === box.dataset.kdCat)) box.checked = target.checked;
    }
  } else if (target.dataset.kdCat) {
    if (target.checked) selected.add(target.dataset.kdCat); else selected.delete(target.dataset.kdCat);
  } else {
    return;
  }
  setKomplettDemoCategories([...selected]);
  syncKomplettDemoGroupBoxes();
}

function renderKomplettDemoForm() {
  if (!komplettDemo) return;
  const cfg = komplettDemo.config;
  el.kdEnabled.checked = cfg.enabled === true;
  el.kdInterval.value = String(cfg.intervalMinutes ?? '');
  el.kdJitter.value = String(cfg.jitterPct ?? '');
  el.kdMaxUsd.value = String(cfg.maxMonthlyUsd ?? '');
  el.kdDropPct.value = String(cfg.notifyPriceDropPercent ?? '');
  el.kdBackInStock.checked = cfg.notifyBackInStock !== false;
  el.kdWebhook.value = cfg.discordWebhookUrl ?? '';
  renderKomplettDemoCategories();
}

async function loadKomplettDemo() {
  try {
    const payload = await fetchJson('/api/komplett-demo');
    komplettDemo = { config: payload.config, catalog: payload.catalog ?? [], limits: payload.limits ?? {}, lastStatus: payload.status };
    renderKomplettDemoForm();
    renderKomplettDemoStatus(payload.status);
  } catch {
    hideSettingsTab('komplett-demo');
  }
}

async function refreshKomplettDemoStatus() {
  if (!komplettDemo) return;
  try {
    renderKomplettDemoStatus(await fetchJson('/api/komplett-demo/status'));
  } catch { /* the next tick retries */ }
}

function collectKomplettDemoConfig() {
  const cfg = komplettDemo.config;
  const toNumber = (input, fallback) => {
    const raw = inputValue(input);
    const parsed = Number(raw);
    return raw !== '' && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    enabled: el.kdEnabled.checked,
    categories: cfg.categories,
    intervalMinutes: toNumber(el.kdInterval, cfg.intervalMinutes),
    jitterPct: toNumber(el.kdJitter, cfg.jitterPct),
    maxMonthlyUsd: toNumber(el.kdMaxUsd, cfg.maxMonthlyUsd),
    notifyPriceDropPercent: toNumber(el.kdDropPct, cfg.notifyPriceDropPercent),
    notifyBackInStock: el.kdBackInStock.checked,
    discordWebhookUrl: inputValue(el.kdWebhook)
  };
}

// ── INET (campaign deals + Fyndhörnan outlet watcher) ───────────
// Like the Komplett watcher: one Apify run per check, with the month's
// spend shown against the cap. What to alert on comes from watch groups
// (keywords, Inet categories, filters), like the Elgiganten hotlist.

let inetData = null; // { config, catalog, limits, lastStatus }
const inetOpenGroups = new Set();
const INET_FEED_LABELS = { deals: 'Kampanj', outlet: 'Fyndhörnan' };
const INET_GROUP_FEEDS = { both: 'Deals and outlet', deals: 'Campaign deals only', outlet: 'Outlet only' };
const INET_MIN_INTERVAL_MIN = 0.5;

// Catalog names ↔ template ids. A duplicate name gets its id appended so
// every chip maps back to exactly one category.
function inetCatalogMaps() {
  const catalog = inetData?.catalog ?? [];
  const counts = new Map();
  for (const entry of catalog) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const idToName = new Map();
  const nameToId = new Map();
  for (const entry of catalog) {
    const name = counts.get(entry.name) > 1 ? `${entry.name} (#${entry.id})` : entry.name;
    idToName.set(String(entry.id), name);
    nameToId.set(name, String(entry.id));
  }
  return { idToName, nameToId, names: [...nameToId.keys()] };
}

function inetCategoryLabel(id, maps = inetCatalogMaps()) {
  return maps.idToName.get(String(id)) ?? `#${id}`;
}

function createEmptyInetGroup() {
  return {
    id: `ig-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: '',
    enabled: true,
    feeds: 'both',
    keywords: [],
    strictKeywordMatch: true,
    categories: [],
    minDiscountPct: null,
    maxPriceSek: null,
    inStockOnly: false,
    priceDropPct: null
  };
}

function inetGroupIsActive(group) {
  return Boolean(group.enabled && (group.keywords.length || group.categories.length || (group.minDiscountPct ?? 0) > 0));
}

function inetGroupSummary(group) {
  const parts = [];
  if (group.keywords.length) parts.push(`${group.keywords.length} keyword${group.keywords.length === 1 ? '' : 's'}`);
  if (group.categories.length) parts.push(`${group.categories.length} categor${group.categories.length === 1 ? 'y' : 'ies'}`);
  if ((group.minDiscountPct ?? 0) > 0) parts.push(`≥${group.minDiscountPct}% off`);
  if (group.feeds !== 'both') parts.push(group.feeds === 'deals' ? 'deals' : 'outlet');
  const info = (inetData?.lastStatus?.groups ?? []).find((g) => g.id === group.id);
  if (info?.active && Number.isFinite(info.matches)) parts.push(`${info.matches} match${info.matches === 1 ? '' : 'es'} now`);
  return parts.join(' · ') || 'Add a keyword, category or min discount';
}

function createInetGroupElement(group) {
  const details = document.createElement('sl-details');
  details.className = `watch${group.enabled ? '' : ' is-disabled'}`;
  details.open = inetOpenGroups.has(group.id);
  const numeric = (value) => (value != null ? value : '');
  const maps = inetCatalogMaps();
  const categoryChips = group.categories.map((id) => inetCategoryLabel(id, maps));

  details.innerHTML = `
    <div slot="summary" class="watch-summary">
      <span class="watch-title">
        <span class="watch-name"></span>
        <sl-badge class="watch-off" variant="neutral" pill>Off</sl-badge>
      </span>
      <span class="watch-meta"></span>
    </div>
    <div class="watch-body">
      <div class="watch-top">
        <sl-switch class="ig-enabled" ${group.enabled ? 'checked' : ''}>Enabled</sl-switch>
        <sl-button class="ig-delete" variant="danger" outline size="small"><sl-icon slot="prefix" name="trash3"></sl-icon>Delete</sl-button>
      </div>
      <sl-input class="ig-name" label="Group name" placeholder="e.g. Monitors" value="${escapeHtml(group.name)}"></sl-input>
      <sl-select class="ig-feeds" label="Feeds" value="${escapeHtml(group.feeds)}">
        ${Object.entries(INET_GROUP_FEEDS).map(([value, label]) => `<sl-option value="${value}">${escapeHtml(label)}</sl-option>`).join('')}
      </sl-select>
      ${chipFieldHtml({ id: `ig-kw-${group.id}`, label: 'Keywords', hint: 'any one matches; type, then tap Add', placeholder: 'e.g. RTX 5090, OLED' })}
      <sl-switch class="ig-strict" ${group.strictKeywordMatch !== false ? 'checked' : ''} help-text="On: every word must be a whole word of the title. Off: also matches inside words (5090 → 5090D).">Exact title match</sl-switch>
      ${chipFieldHtml({ id: `ig-cat-${group.id}`, label: 'Categories', hint: 'any one matches', placeholder: maps.names.length ? 'Search Inet categories…' : 'No categories loaded yet' })}
      ${maps.names.length ? '' : '<p class="ig-cat-hint muted small">Inet’s categories load with the first check. Keywords work without them.</p>'}
      <div class="form-grid-3">
        <sl-input class="ig-mindiscount" label="Min off %" type="number" inputmode="numeric" placeholder="any" min="0" max="99" step="1" value="${numeric(group.minDiscountPct)}"></sl-input>
        <sl-input class="ig-maxprice" label="Max price" type="number" inputmode="numeric" placeholder="any" min="0" step="100" value="${numeric(group.maxPriceSek)}"></sl-input>
        <sl-input class="ig-droppct" label="Drop alert %" type="number" inputmode="numeric" placeholder="global" min="0" max="90" step="1" value="${numeric(group.priceDropPct)}"></sl-input>
      </div>
      <sl-switch class="ig-instock" ${group.inStockOnly ? 'checked' : ''} help-text="Web or store stock. Outlet units are held in a store.">In stock only</sl-switch>
    </div>`;

  const syncSummary = () => {
    details.querySelector('.watch-name').textContent = group.name || 'Untitled group';
    details.querySelector('.watch-meta').textContent = inetGroupSummary(group);
    details.classList.toggle('is-disabled', !group.enabled);
    renderInetCount();
  };
  syncSummary();

  details.addEventListener('sl-show', (e) => { if (e.target === details) inetOpenGroups.add(group.id); });
  details.addEventListener('sl-hide', (e) => { if (e.target === details) inetOpenGroups.delete(group.id); });
  details.querySelector('.ig-enabled').addEventListener('sl-change', (e) => { group.enabled = e.target.checked; syncSummary(); });
  details.querySelector('.ig-name').addEventListener('sl-input', (e) => { group.name = e.target.value; syncSummary(); });
  details.querySelector('.ig-feeds').addEventListener('sl-change', (e) => { group.feeds = e.target.value || 'both'; syncSummary(); });
  details.querySelector('.ig-strict').addEventListener('sl-change', (e) => { group.strictKeywordMatch = e.target.checked; });
  details.querySelector('.ig-instock').addEventListener('sl-change', (e) => { group.inStockOnly = e.target.checked; });
  details.querySelector('.ig-delete').addEventListener('click', () => {
    inetData.config.groups = inetData.config.groups.filter((g) => g.id !== group.id);
    inetOpenGroups.delete(group.id);
    renderInetGroups();
  });
  const numberField = (selector, key) => {
    details.querySelector(selector).addEventListener('sl-input', (e) => {
      const raw = String(e.target.value ?? '').trim();
      const parsed = Number(raw);
      group[key] = raw === '' || !Number.isFinite(parsed) ? null : parsed;
      syncSummary();
    });
  };
  numberField('.ig-mindiscount', 'minDiscountPct');
  numberField('.ig-maxprice', 'maxPriceSek');
  numberField('.ig-droppct', 'priceDropPct');

  wireChipInput({
    container: details.querySelector(`#ig-kw-${group.id}`),
    items: group.keywords,
    onAdd: syncSummary, onRemove: syncSummary,
    allOptions: null
  });
  wireChipInput({
    container: details.querySelector(`#ig-cat-${group.id}`),
    items: categoryChips,
    onAdd: (name) => {
      const id = maps.nameToId.get(name);
      if (!id) {
        // Only catalog categories can be picked (the list comes from Inet).
        categoryChips.splice(categoryChips.indexOf(name), 1);
        showToast(maps.names.length ? `“${name}” is not an Inet category. Pick one from the list.` : 'Inet’s categories load with the first check.', 'warning');
        return;
      }
      if (!group.categories.includes(id)) group.categories.push(id);
      syncSummary();
    },
    onRemove: (name) => {
      const id = maps.nameToId.get(name) ?? (name.match(/^#(\d+)$/)?.[1] ?? null);
      group.categories = group.categories.filter((c) => c !== id);
      syncSummary();
    },
    allOptions: maps.names
  });

  return details;
}

function renderInetCount() {
  if (!el.inetCountLabel || !inetData) return;
  const groups = inetData.config.groups ?? [];
  const active = groups.filter(inetGroupIsActive).length;
  el.inetCountLabel.textContent = groups.length ? `${active}/${groups.length} active · 1 Apify run per check` : 'No watch groups';
}

function renderInetGroups() {
  if (!el.inetGroups || !inetData) return;
  el.inetGroups.innerHTML = '';
  renderInetCount();
  if (!inetData.config.groups.length) {
    el.inetGroups.innerHTML = '<div class="empty-mini"><sl-icon name="bell"></sl-icon><strong>No watch groups yet</strong><span>Add a group with keywords or categories to get Discord alerts. Without groups, Inet items still appear in the listing.</span></div>';
    return;
  }
  for (const group of inetData.config.groups) el.inetGroups.appendChild(createInetGroupElement(group));
}

function renderInetIntervalHint() {
  if (!el.inetIntervalHint) return;
  const raw = Number(el.inetInterval.value);
  const base = Math.min(240, Math.max(INET_MIN_INTERVAL_MIN, Number.isFinite(raw) && raw > 0 ? raw : INET_MIN_INTERVAL_MIN));
  const jitter = Math.min(50, Math.max(0, Number(el.inetJitter.value) || 0));
  const lo = Math.max(INET_MIN_INTERVAL_MIN, Math.round(base * (1 - jitter / 100) * 10) / 10);
  const hi = Math.round(base * (1 + jitter / 100) * 10) / 10;
  const runUsd = inetData?.lastStatus?.costGuard?.estimatedRunUsd;
  const monthly = Number.isFinite(runUsd)
    ? (runUsd === 0 ? ' Free via proxy ($0/month on Apify).' : ` About ${formatUsd(runUsd * (30 * 24 * 60) / base, 2)}/month at this rate, before the cost guard.`)
    : '';
  el.inetIntervalHint.textContent = (jitter
    ? `Checks Inet at random every ${lo}–${hi} min (~${base} min).`
    : `Checks Inet every ${base} min.`) + ` Minimum ${INET_MIN_INTERVAL_MIN} min.${monthly}`;
}
for (const input of [el.inetInterval, el.inetJitter]) {
  input?.addEventListener('sl-input', renderInetIntervalHint);
  input?.addEventListener('input', renderInetIntervalHint);
}

function renderInetStatus(status) {
  if (!el.inetStatus) return;
  if (!status) { el.inetStatus.innerHTML = ''; return; }
  if (inetData) inetData.lastStatus = status;
  const guard = status.costGuard ?? {};
  const feeds = status.feeds ?? [];
  const notes = [];
  if (guard.stretched && !guard.exhausted) {
    notes.push(`Cost guard: checking every ~${Math.round(status.effectiveIntervalMinutes)} min to stay under ${formatUsd(guard.maxMonthlyUsd, 2)} this month.`);
  }
  if (guard.exhausted) notes.push('This month\'s Apify cap is used up; automatic checks resume next month.');
  if (status.lastWarning) notes.push(status.lastWarning);
  for (const feed of feeds) if (feed.enabled && feed.lastError) notes.push(`${feed.label}: ${feed.lastError}`);
  if (status.lastAlertCount) notes.push(`${status.lastAlertCount} alert(s) on the last check.`);
  if (status.pendingAlerts) notes.push(`${status.pendingAlerts} Discord alert(s) waiting to be retried.`);
  const feedStat = (id) => {
    const feed = feeds.find((f) => f.id === id);
    if (!feed?.enabled) return 'off';
    if (!feed.seeded && !feed.tracked) return 'not yet';
    return `${feed.tracked} items · ${feed.inStock} in stock`;
  };
  const activeGroups = (status.groups ?? []).filter((g) => g.active).length;

  el.inetStatus.innerHTML = statusCardHtml({
    stateClass: status.lastError ? 'error' : status.enabled ? 'ok' : 'idle',
    stateLabel: status.lastError
      ? 'Failing'
      : !status.enabled ? 'Paused'
        : status.running ? 'Checking…'
          : guard.exhausted ? 'Monthly cap reached'
            : guard.stretched ? 'Watching (slowed by cost guard)' : 'Watching',
    meta: `${status.trackedProducts ?? 0} items · ${activeGroups} active group${activeGroups === 1 ? '' : 's'} · ${status.pollCount ?? 0} checks`,
    stats: [
      ['Last check', relativeTime(status.lastSuccessAt, { assumePast: true }) ?? 'never'],
      ['Next check', status.enabled ? (relativeTime(status.nextPollAt) ?? '—') : 'paused'],
      ['Apify this month', `${formatUsd(guard.spentUsd)} / ${formatUsd(guard.maxMonthlyUsd, 2)}`],
      ['Projected', formatUsd(guard.projectedMonthUsd, 2)],
      ['Kampanj', feedStat('deals')],
      ['Fyndhörnan', feedStat('outlet')]
    ],
    error: status.lastError,
    notes
  });

  renderInetFinds(status);
  renderInetIntervalHint();
  // Refresh the group summaries' match counts without rebuilding the editors.
  if (el.inetGroups && inetData) {
    const metas = el.inetGroups.querySelectorAll('sl-details.watch .watch-meta');
    inetData.config.groups.forEach((group, index) => { if (metas[index]) metas[index].textContent = inetGroupSummary(group); });
  }
}

function inetFindItem(entry, { reason = null } = {}) {
  const when = reason ? timeAgo(entry.at) : timeAgo(entry.firstSeenAt);
  const was = reason === 'price-drop' && Number.isFinite(entry.previousPriceSek)
    ? entry.previousPriceSek
    : (Number.isFinite(entry.listPriceSek) && entry.listPriceSek > entry.priceSek ? entry.listPriceSek : null);
  const priceLine = was ? `${formatSek(entry.priceSek)} <s>${formatSek(was)}</s>` : formatSek(entry.priceSek);
  const off = Number.isFinite(entry.discountPct) && entry.discountPct > 0 ? `−${entry.discountPct}%` : '';
  const tags = [
    `<sl-badge variant="neutral" pill>${escapeHtml(INET_FEED_LABELS[entry.feed] ?? entry.feed ?? '')}</sl-badge>`,
    reason ? `<sl-badge variant="${KD_REASON_VARIANTS[reason] ?? 'neutral'}" pill>${escapeHtml(KD_REASON_LABELS[reason] ?? reason)}</sl-badge>` : '',
    reason && entry.delivered === false ? `<sl-badge variant="neutral" pill title="${escapeHtml(entry.note ?? '')}">not sent</sl-badge>` : '',
    entry.inStock === false ? '<sl-badge variant="neutral" pill>out of stock</sl-badge>' : ''
  ].join('');
  const groups = (entry.groupNames ?? []).join(', ');
  return `
    <li class="find">
      ${entry.imageUrl ? `<img src="${escapeHtml(entry.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="find-noimg"></span>'}
      <div class="find-body">
        <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.title)}</a>
        <div class="find-meta">
          <strong>${priceLine}</strong>
          ${off ? `<span>${escapeHtml(off)}</span>` : ''}
          ${entry.categoryLabel ? `<span>${escapeHtml(entry.categoryLabel)}</span>` : ''}
          ${groups ? `<span>${escapeHtml(groups)}</span>` : ''}
          ${when ? `<span>${escapeHtml(when)}</span>` : ''}
          ${tags}
        </div>
      </div>
    </li>`;
}

function renderInetFinds(status) {
  if (!el.inetAlerts || !el.inetFinds) return;
  const alerts = (status?.recentAlerts ?? []).slice(0, 10);
  const finds = status?.latestFinds ?? [];
  el.inetAlerts.innerHTML = alerts.map((entry) => inetFindItem(entry, { reason: entry.reason })).join('');
  el.inetAlerts.classList.toggle('hidden', alerts.length === 0);
  const anyFeed = (status?.feeds ?? []).some((f) => f.enabled);
  el.inetFinds.innerHTML = finds.length
    ? finds.map((entry) => inetFindItem(entry)).join('')
    : `<li class="find-empty">${!anyFeed ? 'Switch on at least one feed above.' : (status?.trackedProducts ? 'No current item matches your watch groups.' : 'Nothing recorded yet. The first check records what is listed now, without alerts.')}</li>`;
  for (const img of [...el.inetAlerts.querySelectorAll('img'), ...el.inetFinds.querySelectorAll('img')]) {
    img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'find-noimg' })), { once: true });
  }
}

function renderInetForm() {
  if (!inetData) return;
  const cfg = inetData.config;
  el.inetEnabled.checked = cfg.enabled === true;
  el.inetFeedDeals.checked = cfg.feeds?.deals !== false;
  el.inetFeedOutlet.checked = cfg.feeds?.outlet !== false;
  el.inetInterval.value = String(cfg.intervalMinutes ?? '');
  el.inetJitter.value = String(cfg.jitterPct ?? '');
  el.inetMaxUsd.value = String(cfg.maxMonthlyUsd ?? '');
  el.inetDropPct.value = String(cfg.notifyPriceDropPercent ?? '');
  el.inetBackInStock.checked = cfg.notifyBackInStock !== false;
  el.inetWebhook.value = cfg.discordWebhookUrl ?? '';
  renderInetIntervalHint();
  renderInetGroups();
}

async function loadInet() {
  try {
    const payload = await fetchJson('/api/inet');
    inetData = { config: payload.config, catalog: payload.catalog ?? [], limits: payload.limits ?? {}, lastStatus: payload.status };
    renderInetForm();
    renderInetStatus(payload.status);
  } catch {
    hideSettingsTab('inet');
  }
}

async function refreshInetStatus() {
  if (!inetData) return;
  try {
    renderInetStatus(await fetchJson('/api/inet/status'));
  } catch { /* the next tick retries */ }
}

function collectInetConfig() {
  const cfg = inetData.config;
  const toNumber = (input, fallback) => {
    const raw = inputValue(input);
    const parsed = Number(raw);
    return raw !== '' && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    enabled: el.inetEnabled.checked,
    feeds: { deals: el.inetFeedDeals.checked, outlet: el.inetFeedOutlet.checked },
    intervalMinutes: toNumber(el.inetInterval, cfg.intervalMinutes),
    jitterPct: toNumber(el.inetJitter, cfg.jitterPct),
    maxMonthlyUsd: toNumber(el.inetMaxUsd, cfg.maxMonthlyUsd),
    notifyPriceDropPercent: toNumber(el.inetDropPct, cfg.notifyPriceDropPercent),
    notifyBackInStock: el.inetBackInStock.checked,
    discordWebhookUrl: inputValue(el.inetWebhook),
    groups: cfg.groups
  };
}

// ── WEBHALLEN (campaign deals + Fyndvaror outlet watcher) ───────
// Same architecture and configurable settings as the Inet watcher: one Apify
// run per check sweeping both feeds, monthly spend cap, and watch groups.

let webhallenData = null; // { config, catalog, limits, lastStatus }
const webhallenOpenGroups = new Set();
const WEBHALLEN_FEED_LABELS = { deals: 'Kampanjer', outlet: 'Fyndvaror' };
const WEBHALLEN_GROUP_FEEDS = { both: 'Deals and outlet', deals: 'Campaign deals only', outlet: 'Outlet only' };
const WEBHALLEN_MIN_INTERVAL_MIN = 0.5;

function webhallenCatalogMaps() {
  const catalog = webhallenData?.catalog ?? [];
  const counts = new Map();
  for (const entry of catalog) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const idToName = new Map();
  const nameToId = new Map();
  for (const entry of catalog) {
    const name = counts.get(entry.name) > 1 ? `${entry.name} (${entry.id})` : entry.name;
    idToName.set(String(entry.id), name);
    nameToId.set(name, String(entry.id));
  }
  return { idToName, nameToId, names: [...nameToId.keys()] };
}

function webhallenCategoryLabel(id, maps = webhallenCatalogMaps()) {
  return maps.idToName.get(String(id)) ?? String(id);
}

function createEmptyWebhallenGroup() {
  return {
    id: `wg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: '',
    enabled: true,
    feeds: 'both',
    keywords: [],
    strictKeywordMatch: true,
    categories: [],
    minDiscountPct: null,
    maxPriceSek: null,
    inStockOnly: false,
    priceDropPct: null
  };
}

function webhallenGroupIsActive(group) {
  return Boolean(group.enabled && (group.keywords.length || group.categories.length || (group.minDiscountPct ?? 0) > 0));
}

function webhallenGroupSummary(group) {
  const parts = [];
  if (group.keywords.length) parts.push(`${group.keywords.length} keyword${group.keywords.length === 1 ? '' : 's'}`);
  if (group.categories.length) parts.push(`${group.categories.length} categor${group.categories.length === 1 ? 'y' : 'ies'}`);
  if ((group.minDiscountPct ?? 0) > 0) parts.push(`≥${group.minDiscountPct}% off`);
  if (group.feeds !== 'both') parts.push(group.feeds === 'deals' ? 'deals' : 'outlet');
  const info = (webhallenData?.lastStatus?.groups ?? []).find((g) => g.id === group.id);
  if (info?.active && Number.isFinite(info.matches)) parts.push(`${info.matches} match${info.matches === 1 ? '' : 'es'} now`);
  return parts.join(' · ') || 'Add a keyword, category or min discount';
}

function createWebhallenGroupElement(group) {
  const details = document.createElement('sl-details');
  details.className = `watch${group.enabled ? '' : ' is-disabled'}`;
  details.open = webhallenOpenGroups.has(group.id);
  const numeric = (value) => (value != null ? value : '');
  const maps = webhallenCatalogMaps();
  const categoryChips = group.categories.map((id) => webhallenCategoryLabel(id, maps));

  details.innerHTML = `
    <div slot="summary" class="watch-summary">
      <span class="watch-title">
        <span class="watch-name"></span>
        <sl-badge class="watch-off" variant="neutral" pill>Off</sl-badge>
      </span>
      <span class="watch-meta"></span>
    </div>
    <div class="watch-body">
      <div class="watch-top">
        <sl-switch class="wg-enabled" ${group.enabled ? 'checked' : ''}>Enabled</sl-switch>
        <sl-button class="wg-delete" variant="danger" outline size="small"><sl-icon slot="prefix" name="trash3"></sl-icon>Delete</sl-button>
      </div>
      <sl-input class="wg-name" label="Group name" placeholder="e.g. Monitors" value="${escapeHtml(group.name)}"></sl-input>
      <sl-select class="wg-feeds" label="Feeds" value="${escapeHtml(group.feeds)}">
        ${Object.entries(WEBHALLEN_GROUP_FEEDS).map(([value, label]) => `<sl-option value="${value}">${escapeHtml(label)}</sl-option>`).join('')}
      </sl-select>
      ${chipFieldHtml({ id: `wg-kw-${group.id}`, label: 'Keywords', hint: 'any one matches; type, then tap Add', placeholder: 'e.g. RTX 5090, OLED' })}
      <sl-switch class="wg-strict" ${group.strictKeywordMatch !== false ? 'checked' : ''} help-text="On: every word must be a whole word of the title. Off: also matches inside words (5090 → 5090D).">Exact title match</sl-switch>
      ${chipFieldHtml({ id: `wg-cat-${group.id}`, label: 'Categories', hint: 'any one matches', placeholder: maps.names.length ? 'Search Webhallen categories…' : 'No categories loaded yet' })}
      ${maps.names.length ? '' : '<p class="wg-cat-hint muted small">Webhallen’s categories load with the first check. Keywords work without them.</p>'}
      <div class="form-grid-3">
        <sl-input class="wg-mindiscount" label="Min off %" type="number" inputmode="numeric" placeholder="any" min="0" max="99" step="1" value="${numeric(group.minDiscountPct)}"></sl-input>
        <sl-input class="wg-maxprice" label="Max price" type="number" inputmode="numeric" placeholder="any" min="0" step="100" value="${numeric(group.maxPriceSek)}"></sl-input>
        <sl-input class="wg-droppct" label="Drop alert %" type="number" inputmode="numeric" placeholder="global" min="0" max="90" step="1" value="${numeric(group.priceDropPct)}"></sl-input>
      </div>
      <sl-switch class="wg-instock" ${group.inStockOnly ? 'checked' : ''} help-text="Web or store stock. Some Fyndvaror are held in a store.">In stock only</sl-switch>
    </div>`;

  const syncSummary = () => {
    details.querySelector('.watch-name').textContent = group.name || 'Untitled group';
    details.querySelector('.watch-meta').textContent = webhallenGroupSummary(group);
    details.classList.toggle('is-disabled', !group.enabled);
    renderWebhallenCount();
  };
  syncSummary();

  details.addEventListener('sl-show', (e) => { if (e.target === details) webhallenOpenGroups.add(group.id); });
  details.addEventListener('sl-hide', (e) => { if (e.target === details) webhallenOpenGroups.delete(group.id); });
  details.querySelector('.wg-enabled').addEventListener('sl-change', (e) => { group.enabled = e.target.checked; syncSummary(); });
  details.querySelector('.wg-name').addEventListener('sl-input', (e) => { group.name = e.target.value; syncSummary(); });
  details.querySelector('.wg-feeds').addEventListener('sl-change', (e) => { group.feeds = e.target.value || 'both'; syncSummary(); });
  details.querySelector('.wg-strict').addEventListener('sl-change', (e) => { group.strictKeywordMatch = e.target.checked; });
  details.querySelector('.wg-instock').addEventListener('sl-change', (e) => { group.inStockOnly = e.target.checked; });
  details.querySelector('.wg-delete').addEventListener('click', () => {
    webhallenData.config.groups = webhallenData.config.groups.filter((g) => g.id !== group.id);
    webhallenOpenGroups.delete(group.id);
    renderWebhallenGroups();
  });
  const numberField = (selector, key) => {
    details.querySelector(selector).addEventListener('sl-input', (e) => {
      const raw = String(e.target.value ?? '').trim();
      const parsed = Number(raw);
      group[key] = raw === '' || !Number.isFinite(parsed) ? null : parsed;
      syncSummary();
    });
  };
  numberField('.wg-mindiscount', 'minDiscountPct');
  numberField('.wg-maxprice', 'maxPriceSek');
  numberField('.wg-droppct', 'priceDropPct');

  wireChipInput({
    container: details.querySelector(`#wg-kw-${group.id}`),
    items: group.keywords,
    onAdd: syncSummary, onRemove: syncSummary,
    allOptions: null
  });
  wireChipInput({
    container: details.querySelector(`#wg-cat-${group.id}`),
    items: categoryChips,
    onAdd: (name) => {
      const id = maps.nameToId.get(name);
      if (!id) {
        categoryChips.splice(categoryChips.indexOf(name), 1);
        showToast(maps.names.length ? `“${name}” is not a Webhallen category. Pick one from the list.` : 'Webhallen’s categories load with the first check.', 'warning');
        return;
      }
      if (!group.categories.includes(id)) group.categories.push(id);
      syncSummary();
    },
    onRemove: (name) => {
      const id = maps.nameToId.get(name) ?? name;
      group.categories = group.categories.filter((c) => c !== id);
      syncSummary();
    },
    allOptions: maps.names
  });

  return details;
}

function renderWebhallenCount() {
  if (!el.whCountLabel || !webhallenData) return;
  const groups = webhallenData.config.groups ?? [];
  const active = groups.filter(webhallenGroupIsActive).length;
  el.whCountLabel.textContent = groups.length ? `${active}/${groups.length} active · 1 Apify run per check` : 'No watch groups';
}

function renderWebhallenGroups() {
  if (!el.whGroups || !webhallenData) return;
  el.whGroups.innerHTML = '';
  renderWebhallenCount();
  if (!webhallenData.config.groups.length) {
    el.whGroups.innerHTML = '<div class="empty-mini"><sl-icon name="bell"></sl-icon><strong>No watch groups yet</strong><span>Add a group with keywords or categories to get Discord alerts. Without groups, Webhallen items still appear in the listing.</span></div>';
    return;
  }
  for (const group of webhallenData.config.groups) el.whGroups.appendChild(createWebhallenGroupElement(group));
}

function renderWebhallenIntervalHint() {
  if (!el.whIntervalHint) return;
  const raw = Number(el.whInterval.value);
  const base = Math.min(240, Math.max(WEBHALLEN_MIN_INTERVAL_MIN, Number.isFinite(raw) && raw > 0 ? raw : WEBHALLEN_MIN_INTERVAL_MIN));
  const jitter = Math.min(50, Math.max(0, Number(el.whJitter.value) || 0));
  const lo = Math.max(WEBHALLEN_MIN_INTERVAL_MIN, Math.round(base * (1 - jitter / 100) * 10) / 10);
  const hi = Math.round(base * (1 + jitter / 100) * 10) / 10;
  const runUsd = webhallenData?.lastStatus?.costGuard?.estimatedRunUsd;
  const monthly = Number.isFinite(runUsd)
    ? (runUsd === 0 ? ' Free via proxy ($0/month on Apify).' : ` About ${formatUsd(runUsd * (30 * 24 * 60) / base, 2)}/month at this rate, before the cost guard.`)
    : '';
  el.whIntervalHint.textContent = (jitter
    ? `Checks Webhallen at random every ${lo}–${hi} min (~${base} min).`
    : `Checks Webhallen every ${base} min.`) + ` Minimum ${WEBHALLEN_MIN_INTERVAL_MIN} min.${monthly}`;
}
for (const input of [el.whInterval, el.whJitter]) {
  input?.addEventListener('sl-input', renderWebhallenIntervalHint);
  input?.addEventListener('input', renderWebhallenIntervalHint);
}

function renderWebhallenStatus(status) {
  if (!el.whStatus) return;
  if (!status) { el.whStatus.innerHTML = ''; return; }
  if (webhallenData) webhallenData.lastStatus = status;
  const guard = status.costGuard ?? {};
  const feeds = status.feeds ?? [];
  const notes = [];
  if (guard.stretched && !guard.exhausted) {
    notes.push(`Cost guard: checking every ~${Math.round(status.effectiveIntervalMinutes)} min to stay under ${formatUsd(guard.maxMonthlyUsd, 2)} this month.`);
  }
  if (guard.exhausted) notes.push('This month\'s Apify cap is used up; automatic checks resume next month.');
  if (status.lastWarning) notes.push(status.lastWarning);
  for (const feed of feeds) if (feed.enabled && feed.lastError) notes.push(`${feed.label}: ${feed.lastError}`);
  if (status.lastAlertCount) notes.push(`${status.lastAlertCount} alert(s) on the last check.`);
  if (status.pendingAlerts) notes.push(`${status.pendingAlerts} Discord alert(s) waiting to be retried.`);
  const feedStat = (id) => {
    const feed = feeds.find((f) => f.id === id);
    if (!feed?.enabled) return 'off';
    if (!feed.seeded && !feed.tracked) return 'not yet';
    return `${feed.tracked} items · ${feed.inStock} in stock`;
  };
  const activeGroups = (status.groups ?? []).filter((g) => g.active).length;

  el.whStatus.innerHTML = statusCardHtml({
    stateClass: status.lastError ? 'error' : status.enabled ? 'ok' : 'idle',
    stateLabel: status.lastError
      ? 'Failing'
      : !status.enabled ? 'Paused'
        : status.running ? 'Checking…'
          : guard.exhausted ? 'Monthly cap reached'
            : guard.stretched ? 'Watching (slowed by cost guard)' : 'Watching',
    meta: `${status.trackedProducts ?? 0} items · ${activeGroups} active group${activeGroups === 1 ? '' : 's'} · ${status.pollCount ?? 0} checks`,
    stats: [
      ['Last check', relativeTime(status.lastSuccessAt, { assumePast: true }) ?? 'never'],
      ['Next check', status.enabled ? (relativeTime(status.nextPollAt) ?? '—') : 'paused'],
      ['Apify this month', `${formatUsd(guard.spentUsd)} / ${formatUsd(guard.maxMonthlyUsd, 2)}`],
      ['Projected', formatUsd(guard.projectedMonthUsd, 2)],
      ['Kampanjer', feedStat('deals')],
      ['Fyndvaror', feedStat('outlet')]
    ],
    error: status.lastError,
    notes
  });

  renderWebhallenFinds(status);
  renderWebhallenIntervalHint();
  if (el.whGroups && webhallenData) {
    const metas = el.whGroups.querySelectorAll('sl-details.watch .watch-meta');
    webhallenData.config.groups.forEach((group, index) => { if (metas[index]) metas[index].textContent = webhallenGroupSummary(group); });
  }
}

function webhallenFindItem(entry, { reason = null } = {}) {
  const when = reason ? timeAgo(entry.at) : timeAgo(entry.firstSeenAt);
  const was = reason === 'price-drop' && Number.isFinite(entry.previousPriceSek)
    ? entry.previousPriceSek
    : (Number.isFinite(entry.listPriceSek) && entry.listPriceSek > entry.priceSek ? entry.listPriceSek : null);
  const priceLine = was ? `${formatSek(entry.priceSek)} <s>${formatSek(was)}</s>` : formatSek(entry.priceSek);
  const off = Number.isFinite(entry.discountPct) && entry.discountPct > 0 ? `−${entry.discountPct}%` : '';
  const tags = [
    `<sl-badge variant="neutral" pill>${escapeHtml(WEBHALLEN_FEED_LABELS[entry.feed] ?? entry.feed ?? '')}</sl-badge>`,
    reason ? `<sl-badge variant="${KD_REASON_VARIANTS[reason] ?? 'neutral'}" pill>${escapeHtml(KD_REASON_LABELS[reason] ?? reason)}</sl-badge>` : '',
    reason && entry.delivered === false ? `<sl-badge variant="neutral" pill title="${escapeHtml(entry.note ?? '')}">not sent</sl-badge>` : '',
    entry.inStock === false ? '<sl-badge variant="neutral" pill>out of stock</sl-badge>' : ''
  ].join('');
  const groups = (entry.groupNames ?? []).join(', ');
  return `
    <li class="find">
      ${entry.imageUrl ? `<img src="${escapeHtml(entry.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="find-noimg"></span>'}
      <div class="find-body">
        <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.title)}</a>
        <div class="find-meta">
          <strong>${priceLine}</strong>
          ${off ? `<span>${escapeHtml(off)}</span>` : ''}
          ${entry.categoryLabel ? `<span>${escapeHtml(entry.categoryLabel)}</span>` : ''}
          ${groups ? `<span>${escapeHtml(groups)}</span>` : ''}
          ${when ? `<span>${escapeHtml(when)}</span>` : ''}
          ${tags}
        </div>
      </div>
    </li>`;
}

function renderWebhallenFinds(status) {
  if (!el.whAlerts || !el.whFinds) return;
  const alerts = (status?.recentAlerts ?? []).slice(0, 10);
  const finds = status?.latestFinds ?? [];
  el.whAlerts.innerHTML = alerts.map((entry) => webhallenFindItem(entry, { reason: entry.reason })).join('');
  el.whAlerts.classList.toggle('hidden', alerts.length === 0);
  const anyFeed = (status?.feeds ?? []).some((f) => f.enabled);
  el.whFinds.innerHTML = finds.length
    ? finds.map((entry) => webhallenFindItem(entry)).join('')
    : `<li class="find-empty">${!anyFeed ? 'Switch on at least one feed above.' : (status?.trackedProducts ? 'No current item matches your watch groups.' : 'Nothing recorded yet. The first check records what is listed now, without alerts.')}</li>`;
  for (const img of [...el.whAlerts.querySelectorAll('img'), ...el.whFinds.querySelectorAll('img')]) {
    img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'find-noimg' })), { once: true });
  }
}

function renderWebhallenForm() {
  if (!webhallenData) return;
  const cfg = webhallenData.config;
  el.whEnabled.checked = cfg.enabled === true;
  el.whFeedDeals.checked = cfg.feeds?.deals !== false;
  el.whFeedOutlet.checked = cfg.feeds?.outlet !== false;
  el.whInterval.value = String(cfg.intervalMinutes ?? '');
  el.whJitter.value = String(cfg.jitterPct ?? '');
  el.whMaxUsd.value = String(cfg.maxMonthlyUsd ?? '');
  el.whDropPct.value = String(cfg.notifyPriceDropPercent ?? '');
  el.whBackInStock.checked = cfg.notifyBackInStock !== false;
  el.whWebhook.value = cfg.discordWebhookUrl ?? '';
  renderWebhallenIntervalHint();
  renderWebhallenGroups();
}

async function loadWebhallen() {
  try {
    const payload = await fetchJson('/api/webhallen');
    webhallenData = { config: payload.config, catalog: payload.catalog ?? [], limits: payload.limits ?? {}, lastStatus: payload.status };
    renderWebhallenForm();
    renderWebhallenStatus(payload.status);
  } catch {
    hideSettingsTab('webhallen');
  }
}

async function refreshWebhallenStatus() {
  if (!webhallenData) return;
  try {
    renderWebhallenStatus(await fetchJson('/api/webhallen/status'));
  } catch { /* the next tick retries */ }
}

function collectWebhallenConfig() {
  const cfg = webhallenData.config;
  const toNumber = (input, fallback) => {
    const raw = inputValue(input);
    const parsed = Number(raw);
    return raw !== '' && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    enabled: el.whEnabled.checked,
    feeds: { deals: el.whFeedDeals.checked, outlet: el.whFeedOutlet.checked },
    intervalMinutes: toNumber(el.whInterval, cfg.intervalMinutes),
    jitterPct: toNumber(el.whJitter, cfg.jitterPct),
    maxMonthlyUsd: toNumber(el.whMaxUsd, cfg.maxMonthlyUsd),
    notifyPriceDropPercent: toNumber(el.whDropPct, cfg.notifyPriceDropPercent),
    notifyBackInStock: el.whBackInStock.checked,
    discordWebhookUrl: inputValue(el.whWebhook),
    groups: cfg.groups
  };
}

// ── SAVE SETTINGS ───────────────────────────────────────────────
async function saveAllSettings() {
  el.saveSettingsBtn.loading = true;
  el.drawerSaveStatus.textContent = 'Saving…';
  el.drawerSaveStatus.className = 'save-status';

  try {
    // Save hotlist
    if (hotlistConfig) {
      const payload = await fetchJson('/api/hotlist', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collectHotlistConfig())
      });
      hotlistConfig = payload.config;
      renderHotlistStatus(payload.status);
      renderHotlistForm();
    }

    // Save the Komplett demo watcher
    if (komplettDemo) {
      const payload = await fetchJson('/api/komplett-demo/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collectKomplettDemoConfig())
      });
      komplettDemo.config = payload.config;
      renderKomplettDemoForm();
      renderKomplettDemoStatus(payload.status);
    }

    // Save the Inet watcher
    if (inetData) {
      const payload = await fetchJson('/api/inet/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collectInetConfig())
      });
      inetData.config = payload.config;
      renderInetForm();
      renderInetStatus(payload.status);
    }

    // Save the Webhallen watcher
    if (webhallenData) {
      const payload = await fetchJson('/api/webhallen/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collectWebhallenConfig())
      });
      webhallenData.config = payload.config;
      renderWebhallenForm();
      renderWebhallenStatus(payload.status);
    }

    el.drawerSaveStatus.textContent = '✓ Saved';
    el.drawerSaveStatus.className = 'save-status ok';
    setTimeout(() => { el.drawerSaveStatus.textContent = ''; }, 2500);
    // A deselected Komplett category leaves the listing straight away.
    loadDashboard().catch(() => {});
  } catch (err) {
    el.drawerSaveStatus.textContent = 'Save failed';
    el.drawerSaveStatus.className = 'save-status error';
    showToast(`Save failed: ${err.message}`, 'error');
  } finally {
    el.saveSettingsBtn.loading = false;
  }
}

// ── EVENT LISTENERS ─────────────────────────────────────────────
function bindEvents() {
  // Search (Shoelace fires sl-input on typing and on the clear button)
  el.searchInput.addEventListener('sl-input', () => updateFilters({ debounce: true }));
  el.searchInput.addEventListener('keydown', (e) => {
    // The phone "Search" key: apply now and drop the keyboard.
    if (e.key === 'Enter') { updateFilters(); el.searchInput.blur(); }
  });

  // Filter selects
  el.categoryFilter.addEventListener('sl-change', () => updateFilters());
  el.storeFilter?.addEventListener('sl-change', () => updateFilters());
  el.campaignFilter?.addEventListener('sl-change', () => updateFilters());

  // Filter checkboxes
  el.newOnly.addEventListener('sl-change', () => updateFilters());
  el.discountedOnly.addEventListener('sl-change', () => updateFilters());
  el.referenceOnly.addEventListener('sl-change', () => updateFilters());

  // Filter inputs
  el.minDiscountFilter.addEventListener('sl-input', () => updateFilters({ debounce: true }));
  el.minPriceFilter.addEventListener('sl-input', () => updateFilters({ debounce: true }));
  el.maxPriceFilter.addEventListener('sl-input', () => updateFilters({ debounce: true }));

  // Clear filters
  el.clearFiltersBtn.addEventListener('click', () => { resetFilters(); loadProducts().catch(err => showToast(err.message, 'error')); });

  // Export CSV — same filters as the product list, minus pagination
  document.getElementById('export-csv-btn')?.addEventListener('click', () => {
    const params = new URLSearchParams(buildProductsQuery().slice(1));
    params.delete('page');
    params.delete('pageSize');
    window.open(`/api/export.csv?${params.toString()}`, '_blank');
  });

  // Filter presets
  for (const pill of el.filterPills) {
    pill.addEventListener('click', () => {
      applyPreset(pill.getAttribute('data-filter-preset'));
      state.currentPage = 1;
      loadProducts().catch(err => showToast(err.message, 'error'));
    });
  }

  // Filters sheet
  el.filterExpandBtn.addEventListener('click', () => { placeSheet(el.filterDrawer); el.filterDrawer.show(); });
  el.filterDoneBtn.addEventListener('click', () => el.filterDrawer.hide());

  // Sort
  el.sortSelect.addEventListener('sl-change', () => {
    const [col, dir] = String(el.sortSelect.value).split('-');
    state.sortBy = col;
    state.sortDirection = dir;
    state.currentPage = 1;
    savePrefs();
    loadProducts().catch(err => showToast(err.message, 'error'));
  });

  // View mode
  el.viewGrid.addEventListener('click', () => { state.viewMode = 'grid'; syncViewMode(); savePrefs(); });
  el.viewList.addEventListener('click', () => { state.viewMode = 'list'; syncViewMode(); savePrefs(); });

  // Settings drawer
  el.settingsBtn.addEventListener('click', () => openDrawer());
  el.settingsDrawer.addEventListener('sl-after-hide', (e) => {
    // Nested selects/details emit their own sl-*-hide events; only react to the drawer's.
    if (e.target !== el.settingsDrawer) return;
    stopHotlistStatusPolling();
  });
  el.settingsTabs.addEventListener('sl-tab-show', (e) => {
    // Each tab starts at its top, not wherever the previous one was scrolled to.
    const body = el.settingsTabs.shadowRoot?.querySelector('.tab-group__body');
    if (body) body.scrollTop = 0;
  });

  // Save settings
  el.saveSettingsBtn.addEventListener('click', saveAllSettings);

  // Hotlist
  el.hotlistAddGroup?.addEventListener('click', () => {
    if (!hotlistConfig) return;
    const group = createEmptyHotlistGroup();
    hotlistOpenGroups.add(group.id);
    hotlistConfig.groups.push(group);
    renderHotlistGroups();
    el.hotlistGroups.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  el.hotlistPollNow?.addEventListener('click', async () => {
    el.hotlistPollNow.loading = true;
    try {
      const res = await fetchJson('/api/hotlist/poll', { method: 'POST' });
      renderHotlistStatus(res.status);
      showToast(`Elgiganten Hotlist: ${res.result?.count ?? 0} deal(s), ${res.result?.newCount ?? 0} new.`, 'success');
      loadDashboard().catch(() => {});
    } catch (err) {
      showToast(`Elgiganten Hotlist poll failed: ${err.message}`, 'error');
      refreshHotlistStatus();
    } finally {
      el.hotlistPollNow.loading = false;
    }
  });

  // Komplett demo watcher
  el.kdCategories?.addEventListener('sl-change', onKomplettDemoCategoryChange);
  el.kdPollNow?.addEventListener('click', async () => {
    if (!komplettDemo) return;
    if (!komplettDemo.config.categories.length) {
      showToast('Pick at least one Komplett demo category and save first.', 'error');
      return;
    }
    el.kdPollNow.loading = true;
    try {
      const res = await fetchJson('/api/komplett-demo/poll', { method: 'POST' });
      renderKomplettDemoStatus(res.status);
      const r = res.result ?? {};
      showToast(`Komplett demo: ${r.count ?? 0} product(s), ${r.alertCount ?? 0} alert(s).`, 'success');
      loadDashboard().catch(() => {});
    } catch (err) {
      showToast(`Komplett demo check failed: ${err.message}`, 'error');
      refreshKomplettDemoStatus();
    } finally {
      el.kdPollNow.loading = false;
    }
  });

  // Inet watcher
  el.inetAddGroup?.addEventListener('click', () => {
    if (!inetData) return;
    const group = createEmptyInetGroup();
    inetOpenGroups.add(group.id);
    inetData.config.groups.push(group);
    renderInetGroups();
    el.inetGroups.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  el.inetPollNow?.addEventListener('click', async () => {
    if (!inetData) return;
    if (!el.inetFeedDeals.checked && !el.inetFeedOutlet.checked) {
      showToast('Switch on at least one Inet feed and save first.', 'error');
      return;
    }
    el.inetPollNow.loading = true;
    try {
      const res = await fetchJson('/api/inet/poll', { method: 'POST' });
      renderInetStatus(res.status);
      const r = res.result ?? {};
      showToast(`Inet: ${r.count ?? 0} item(s), ${r.alertCount ?? 0} alert(s).`, 'success');
      // The first check fills the category list.
      fetchJson('/api/inet/catalog').then((catalog) => { inetData.catalog = catalog; renderInetGroups(); }).catch(() => {});
      loadDashboard().catch(() => {});
    } catch (err) {
      showToast(`Inet check failed: ${err.message}`, 'error');
      refreshInetStatus();
    } finally {
      el.inetPollNow.loading = false;
    }
  });

  // Webhallen watcher
  el.whAddGroup?.addEventListener('click', () => {
    if (!webhallenData) return;
    const group = createEmptyWebhallenGroup();
    webhallenOpenGroups.add(group.id);
    webhallenData.config.groups.push(group);
    renderWebhallenGroups();
    el.whGroups.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  el.whPollNow?.addEventListener('click', async () => {
    if (!webhallenData) return;
    if (!el.whFeedDeals.checked && !el.whFeedOutlet.checked) {
      showToast('Switch on at least one Webhallen feed and save first.', 'error');
      return;
    }
    el.whPollNow.loading = true;
    try {
      const res = await fetchJson('/api/webhallen/poll', { method: 'POST' });
      renderWebhallenStatus(res.status);
      const r = res.result ?? {};
      showToast(`Webhallen: ${r.count ?? 0} item(s), ${r.alertCount ?? 0} alert(s).`, 'success');
      // The first check fills the category list.
      fetchJson('/api/webhallen/catalog').then((catalog) => { webhallenData.catalog = catalog; renderWebhallenGroups(); }).catch(() => {});
      loadDashboard().catch(() => {});
    } catch (err) {
      showToast(`Webhallen check failed: ${err.message}`, 'error');
      refreshWebhallenStatus();
    } finally {
      el.whPollNow.loading = false;
    }
  });

  // Clear the Elgiganten cooldown after the user changes their egress IP.
  el.elgigantenBlockRetry?.addEventListener('click', async () => {
    el.elgigantenBlockRetry.loading = true;
    try {
      const res = await fetchJson('/api/elgiganten/retry', { method: 'POST' });
      // Only hide the banner if the IP is actually unblocked now.
      showToast(res.message, res.stillBlocked ? 'error' : 'success');
      if (!res.stillBlocked) el.elgigantenBlock.classList.add('hidden');
      loadDashboard().catch(() => {});
    } catch (err) {
      showToast(`Retry failed: ${err.message}`, 'error');
    } finally {
      el.elgigantenBlockRetry.loading = false;
    }
  });

  // "/" focuses search (Escape is handled by the Shoelace drawers/dialogs).
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName ?? '';
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SL-INPUT', 'SL-TEXTAREA', 'SL-SELECT'].includes(tag)) {
      e.preventDefault();
      el.searchInput.focus();
    }
  });

}

// ── INIT ────────────────────────────────────────────────────────
initTheme();
hydratePrefs();
bindEvents();
loadWishlist().then(() => loadDashboard()).catch(err => showToast(err.message, 'error'));
loadVersionInfo();

async function loadVersionInfo() {
  const badge = document.getElementById('version-badge');
  const text = document.getElementById('version-text');
  if (!badge || !text) return;
  try {
    const res = await fetch('/api/version');
    if (!res.ok) throw new Error('unavailable');
    const v = await res.json();
    const sha = v.shortSha ?? v.sha?.slice(0, 7) ?? '?';
    const deployedAt = v.deployedAt ? new Date(v.deployedAt) : null;
    const timeStr = deployedAt
      ? deployedAt.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
      : null;
    text.textContent = timeStr ? `${sha} · deployed ${timeStr}` : sha;
    badge.title = [
      `Commit: ${v.sha ?? sha}`,
      v.message ? `Message: ${v.message}` : null,
      v.author ? `By: ${v.author}` : null,
      deployedAt ? `Deployed: ${deployedAt.toLocaleString('sv-SE')}` : null,
    ].filter(Boolean).join('\n');
  } catch {
    text.textContent = 'dev';
    badge.title = 'Version info not available (dev mode)';
  }
}

/* ══════════════════════════════════════════════════════════════════
   PURCHASE / CHECKOUT CONTROLS
   Three checkout models share this panel. The admin token lives only in
   this browser's localStorage and is sent as a bearer token; the server
   refuses every purchase route without it.
   ══════════════════════════════════════════════════════════════════ */

const PURCHASE_TOKEN_KEY = 'spw.adminToken';
const purchaseState = { data: null };

function purchaseToken() {
  return localStorage.getItem(PURCHASE_TOKEN_KEY) ?? '';
}

async function purchaseFetch(path, options = {}) {
  const token = purchaseToken();
  if (!token) throw new Error('Enter your admin API token first.');
  // Only advertise a JSON body when one is actually present — Fastify rejects
  // a request that declares application/json but sends an empty body.
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) };
  if (options.body !== undefined && options.body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
  return body;
}

function setPurchaseStatus(message, kind = 'info') {
  const node = document.getElementById('purchase-status');
  if (!node) return;
  node.textContent = message ?? '';
  node.className = message ? `purchase-status ${kind}` : 'purchase-status hidden';
}

function isElgigantenListing(product) {
  return typeof product?.url === 'string' && product.url.startsWith('https://www.elgiganten.se/');
}

function armedSet() {
  return new Set((purchaseState.data?.armed ?? []).map((arm) => arm.listingKey));
}

async function refreshPurchasePanel() {
  const panel = document.getElementById('purchase-panel');
  try {
    const data = await purchaseFetch('/api/purchase');
    purchaseState.data = data;
    panel?.classList.remove('hidden');
    setPurchaseStatus('');

    document.getElementById('purchase-mode').value = data.mode;
    document.getElementById('purchase-max-price').value = String(data.maxPriceSek ?? '');
    document.getElementById('purchase-ttl').value = String(data.defaultTtlMinutes ?? '');
    document.getElementById('purchase-rate').value = String(data.maxStagesPerHour ?? '');

    const caps = document.getElementById('purchase-capabilities');
    if (caps) {
      caps.textContent = data.credentialsConfigured ? '✓ Signed-in staging' : '✗ Anonymous cart staging';
    }

    renderArmedList(data.armed ?? []);
    renderAttempts(data.attempts ?? []);
  } catch (error) {
    panel?.classList.add('hidden');
    setPurchaseStatus(error.message, 'error');
  }
}

function renderArmedList(armed) {
  const node = document.getElementById('purchase-armed');
  if (!node) return;
  if (!armed.length) {
    node.innerHTML = '<p class="muted small">Nothing armed. Use the ⚡ button on any Elgiganten card.</p>';
    return;
  }
  node.innerHTML = armed.map((arm) => `
    <div class="purchase-row">
      <div class="purchase-row-main">
        <span class="purchase-row-title">${escapeHtml(arm.label ?? arm.listingKey)}</span>
        <span class="purchase-row-meta">
          ${escapeHtml(arm.mode)} · cap ${formatSek(arm.maxPriceSek)} ·
          ${arm.uses}/${arm.maxUses} used · expires ${new Date(arm.expiresAt).toLocaleString('sv-SE')}
        </span>
      </div>
      <div class="purchase-row-actions">
        <sl-button size="small" variant="primary" outline data-stage-key="${escapeHtml(arm.listingKey)}">Stage cart</sl-button>
        <sl-button size="small" data-disarm-key="${escapeHtml(arm.listingKey)}">Disarm</sl-button>
      </div>
    </div>
  `).join('');

  for (const btn of node.querySelectorAll('[data-disarm-key]')) {
    btn.addEventListener('click', async () => {
      try {
        await purchaseFetch(`/api/purchase/arm/${encodeURIComponent(btn.dataset.disarmKey)}`, { method: 'DELETE' });
        await refreshPurchasePanel();
        loadDashboard();
      } catch (error) { setPurchaseStatus(error.message, 'error'); }
    });
  }
  for (const btn of node.querySelectorAll('[data-stage-key]')) {
    btn.addEventListener('click', async () => {
      btn.loading = true;
      setPurchaseStatus('Staging cart — this opens a real browser session and takes ~20s.', 'info');
      try {
        const result = await purchaseFetch(`/api/purchase/stage/${encodeURIComponent(btn.dataset.stageKey)}`, { method: 'POST' });
        setPurchaseStatus(`Cart staged. Complete payment: ${result.checkoutUrl}`, 'ok');
      } catch (error) {
        setPurchaseStatus(error.message, 'error');
      } finally {
        await refreshPurchasePanel();
      }
    });
  }
}

function renderAttempts(attempts) {
  const node = document.getElementById('purchase-attempts');
  if (!node) return;
  if (!attempts.length) {
    node.innerHTML = '<p class="muted small">No staging attempts yet.</p>';
    return;
  }
  const icon = { staged: '✅', refused: '⛔', failed: '⚠️' };
  node.innerHTML = attempts.slice(0, 15).map((a) => `
    <div class="purchase-row compact">
      <div class="purchase-row-main">
        <span class="purchase-row-title">${icon[a.status] ?? '•'} ${escapeHtml(a.title ?? a.listingKey ?? 'unknown')}</span>
        <span class="purchase-row-meta">
          ${new Date(a.at).toLocaleString('sv-SE')} · via ${escapeHtml(a.via ?? '?')}
          ${a.reason ? ` · ${escapeHtml(a.reason)}` : ''}
          ${a.priceSek ? ` · ${formatSek(a.priceSek)}` : ''}
        </span>
      </div>
    </div>
  `).join('');
}

async function toggleArm(listingKey, button) {
  const armed = armedSet().has(listingKey);
  try {
    if (armed) {
      await purchaseFetch(`/api/purchase/arm/${encodeURIComponent(listingKey)}`, { method: 'DELETE' });
    } else {
      await purchaseFetch(`/api/purchase/arm/${encodeURIComponent(listingKey)}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    }
    if (button) {
      button.classList.toggle('active', !armed);
      button.name = armed ? 'lightning-charge' : 'lightning-charge-fill';
      button.label = armed ? 'Arm for checkout staging' : 'Disarm checkout staging';
    }
    await refreshPurchasePanel();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function initPurchaseControls() {
  const modal = document.getElementById('purchase-modal');
  const openBtn = document.getElementById('purchase-open-btn');
  const tokenInput = document.getElementById('purchase-token');
  if (!modal || !openBtn) return;

  tokenInput.value = purchaseToken();
  tokenInput.addEventListener('sl-change', async () => {
    localStorage.setItem(PURCHASE_TOKEN_KEY, inputValue(tokenInput));
    await refreshPurchasePanel();
  });

  openBtn.addEventListener('click', async () => {
    modal.show();
    if (purchaseToken()) await refreshPurchasePanel();
    else setPurchaseStatus('Enter your admin API token to unlock buy controls.', 'info');
  });

  document.getElementById('purchase-save')?.addEventListener('click', async () => {
    try {
      await purchaseFetch('/api/purchase/settings', {
        method: 'PUT',
        body: JSON.stringify({
          mode: document.getElementById('purchase-mode').value,
          maxPriceSek: Number(document.getElementById('purchase-max-price').value),
          defaultTtlMinutes: Number(document.getElementById('purchase-ttl').value),
          maxStagesPerHour: Number(document.getElementById('purchase-rate').value),
        }),
      });
      setPurchaseStatus('Defaults saved.', 'ok');
      await refreshPurchasePanel();
    } catch (error) {
      setPurchaseStatus(error.message, 'error');
    }
  });

  // Load quietly on boot so card ⚡ buttons reflect armed state.
  if (purchaseToken()) refreshPurchasePanel().catch(() => {});
}

initPurchaseControls();
