// ═══════════════════════════════════════════════════════════════
// PriceWatch — Modern Ecommerce Frontend
// ═══════════════════════════════════════════════════════════════

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
  favoritesOnly: false,
  discountedOnly: false,
  newOnly: false,
  referenceOnly: false,
  hotOnly: false,
  minDiscountPercent: '',
  minPriceSek: '',
  maxPriceSek: '',
  favoriteCategories: [],
  categories: [],
  sortBy: 'score',
  sortDirection: 'desc',
  currentPage: 1,
  pageSize: 48,
  viewMode: 'grid', // 'grid' or 'list'
  filterPanelOpen: false,
  activePreset: 'all',
  // Scheduler
  schedulerEnabled: true,
  schedulerIntervalMinutes: 180,
  schedulerWindowEnabled: false,
  schedulerWindowStart: '07:00',
  schedulerWindowEnd: '00:00',
  schedulerTimeZone: 'Europe/Stockholm',
  schedulerIsInActiveWindow: true,
  schedulerNextRunAt: null,
  schedulerFormDirty: false,
  latestRunStartedAt: null
};

const STORAGE_KEY = 'pricewatch-ui-v2';
const NEW_PRODUCT_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  favoritesOnly: $('#favorites-only'),
  referenceOnly: $('#reference-only'),
  filterPills: $$('[data-filter-preset]'),
  filterExpandBtn: $('#filter-expand-btn'),
  filterPanel: $('#filter-panel'),
  filterCountBadge: $('#filter-count-badge'),
  clearFiltersBtn: $('#clear-filters-btn'),
  activeFilterTags: $('#active-filter-tags'),
  statsPills: $('#stats-pills'),
  productsCount: $('#products-count'),
  productGrid: $('#product-grid'),
  paginationArea: $('#pagination-area'),
  emptyState: $('#empty-state'),
  sortSelect: $('#sort-select'),
  viewGrid: $('#view-grid'),
  viewList: $('#view-list'),
  scanBtn: $('#scan-btn'),
  cancelBtn: $('#cancel-btn'),
  scanProgress: $('#scan-progress'),
  scanProgressBar: $('#scan-progress-bar'),
  scanProgressText: $('#scan-progress-text'),
  schedulerStatus: $('#scheduler-status'),
  schedulerText: $('#scheduler-text'),
  settingsBtn: $('#settings-btn'),
  settingsDrawer: $('#settings-drawer'),
  settingsOverlay: $('#settings-overlay'),
  drawerClose: $('#drawer-close'),
  drawerTabs: $$('.drawer-tab'),
  sourcesList: $('#sources-list'),
  sourcesAllOn: $('#sources-all-on'),
  sourcesAllOff: $('#sources-all-off'),
  notificationsEnabledToggle: $('#notifications-enabled-toggle'),
  addRuleBtn: $('#add-rule-btn'),
  rulesList: $('#rules-list'),
  rulesCountLabel: $('#rules-count-label'),
  schedulerEnabled: $('#scheduler-enabled'),
  schedulerInterval: $('#scheduler-interval'),
  schedulerWindowEnabled: $('#scheduler-window-enabled'),
  schedulerWindowStart: $('#scheduler-window-start'),
  schedulerWindowEnd: $('#scheduler-window-end'),
  modalSchedulerStatus: $('#modal-scheduler-status'),
  favoriteChips: $('#favorite-chips'),
  favoritesSearchInput: $('#favorites-search-input'),
  favoritesEditor: $('#favorites-editor'),
  saveSettingsBtn: $('#save-settings-btn'),
  drawerSaveStatus: $('#drawer-save-status'),
  toastContainer: $('#toast-container'),
  runSummary: $('#run-summary'),
  themeToggle: $('#theme-toggle')
};

let scanPollTimer = null;
let filterApplyTimer = null;
let latestProducts = {};
let lastCompletedSources = 0;

// Notification settings
let notifSettings = { notificationsEnabled: true, alertRules: [] };
let allCategories = [];
let allSources = [];

// ── UTILITIES ───────────────────────────────────────────────────
function formatSek(value) {
  return Number.isFinite(value) ? sekFormatter.format(Math.round(value)) : 'n/a';
}

function formatDate(value) {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString('sv-SE');
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

function formatCountdown(value) {
  if (!value) return null;
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return '< 1 min';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
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

function parseTimeOfDay(input) {
  const value = String(input ?? '').trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value) ? value : null;
}

function toTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function isNewProduct(product) {
  const firstSeenTimestamp = toTimestamp(product.firstSeenAt);
  if (firstSeenTimestamp == null) return false;
  const latestRunTimestamp = toTimestamp(state.latestRunStartedAt);
  if (latestRunTimestamp != null) return firstSeenTimestamp >= latestRunTimestamp;
  return Date.now() - firstSeenTimestamp <= NEW_PRODUCT_FALLBACK_WINDOW_MS;
}

function getFavoriteCategorySet() {
  return new Set(state.favoriteCategories.map(c => normalizeCategoryKey(c)));
}

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
      favoritesOnly: state.favoritesOnly,
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
  if (typeof s.favoritesOnly === 'boolean') state.favoritesOnly = s.favoritesOnly;
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

  // Sync UI
  el.searchInput.value = state.search;
  el.newOnly.checked = state.newOnly;
  el.discountedOnly.checked = state.discountedOnly;
  el.favoritesOnly.checked = state.favoritesOnly;
  el.referenceOnly.checked = state.referenceOnly;
  el.minDiscountFilter.value = state.minDiscountPercent;
  el.minPriceFilter.value = state.minPriceSek;
  el.maxPriceFilter.value = state.maxPriceSek;
  el.sortSelect.value = `${state.sortBy}-${state.sortDirection}`;
  syncViewMode();
  syncFilterPresets();
}

// ── TOAST NOTIFICATIONS ─────────────────────────────────────────
function showToast(message, variant = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast ${variant}`;
  toast.innerHTML = `
    <span class="toast-message">${escapeHtml(message)}</span>
    <button type="button" class="toast-close" aria-label="Dismiss">×</button>
  `;
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  el.toastContainer.appendChild(toast);
  if (duration > 0) setTimeout(() => toast.remove(), duration);
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
  if (state.favoritesOnly) params.set('favoritesOnly', 'true');
  if (state.hotOnly) params.set('hotOnly', 'true');
  if (state.discountedOnly) params.set('discountedOnly', 'true');
  if (state.newOnly) params.set('newOnly', 'true');
  if (state.referenceOnly) params.set('referenceOnly', 'true');
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
function initTheme() {
  function getTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('spw-theme', theme); } catch {}
  }
  try {
    const saved = localStorage.getItem('spw-theme');
    if (saved === 'light' || saved === 'dark') apply(saved);
    else apply('dark');
  } catch { apply('dark'); }

  el.themeToggle.addEventListener('click', () => {
    apply(getTheme() === 'dark' ? 'light' : 'dark');
  });
}

// ── VIEW MODE ───────────────────────────────────────────────────
function syncViewMode() {
  el.viewGrid.classList.toggle('active', state.viewMode === 'grid');
  el.viewList.classList.toggle('active', state.viewMode === 'list');
  el.viewGrid.setAttribute('aria-pressed', state.viewMode === 'grid');
  el.viewList.setAttribute('aria-pressed', state.viewMode === 'list');
  el.productGrid.classList.toggle('list-view', state.viewMode === 'list');
}

// ── FILTER PRESETS ──────────────────────────────────────────────
function syncFilterPresets() {
  for (const pill of el.filterPills) {
    const preset = pill.getAttribute('data-filter-preset');
    pill.classList.toggle('active', preset === state.activePreset);
  }
}

function applyPreset(preset) {
  // Reset boolean filters
  state.newOnly = false;
  state.hotOnly = false;
  state.discountedOnly = false;
  state.referenceOnly = false;
  state.favoritesOnly = false;

  if (preset === 'new') state.newOnly = true;
  else if (preset === 'hot') state.hotOnly = true;
  else if (preset === 'discounted') state.discountedOnly = true;
  else if (preset === 'matched') state.referenceOnly = true;
  else if (preset === 'favorites') state.favoritesOnly = true;

  state.activePreset = preset;
  el.newOnly.checked = state.newOnly;
  el.discountedOnly.checked = state.discountedOnly;
  el.favoritesOnly.checked = state.favoritesOnly;
  el.referenceOnly.checked = state.referenceOnly;
  syncFilterPresets();
  savePrefs();
}

// ── FILTER COUNT ────────────────────────────────────────────────
function getActiveFilterCount() {
  let count = 0;
  if (state.search) count++;
  if (state.category) count++;
  if (state.store) count++;
  if (state.campaign) count++;
  if (state.favoritesOnly) count++;
  if (state.hotOnly) count++;
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
  if (count > 0) {
    el.filterCountBadge.textContent = count;
    el.filterCountBadge.classList.remove('hidden');
  } else {
    el.filterCountBadge.classList.add('hidden');
  }
}

// ── RENDER: STATS ───────────────────────────────────────────────
function renderStats(status, response) {
  const agg = response?.aggregates ?? {};
  const total = response?.total ?? 0;
  const pills = [
    [status.counts?.outletItems ?? 0, 'tracked'],
    [total, 'filtered'],
    [agg.matched ?? 0, 'matched'],
    [agg.discounted ?? 0, 'discounted'],
    [Number.isFinite(agg.avgDiscountPercent) ? `${agg.avgDiscountPercent}%` : '–', 'avg off']
  ];

  el.statsPills.innerHTML = pills
    .map(([val, label]) => `<span class="stat-pill"><strong>${escapeHtml(String(val))}</strong> ${escapeHtml(label)}</span>`)
    .join('');
  el.productsCount.textContent = `${total} products`;
}

// ── RENDER: SOURCES ─────────────────────────────────────────────
function renderSources(sources, isScanning, sourceProgress) {
  if (!el.sourcesList || !sources?.length) return;

  el.sourcesList.innerHTML = sources
    .filter(s => s.enabled)
    .map(source => {
      const sp = isScanning ? (sourceProgress?.[source.id] ?? { status: 'queued' }) : null;
      let statusLabel;
      if (sp) {
        statusLabel = sp.status === 'running' ? 'scanning' : sp.status === 'done' ? 'done' : sp.status === 'error' ? 'error' : 'queued';
      } else {
        statusLabel = source.status || 'idle';
      }
      const relTime = timeAgo(source.lastSuccessAt);
      const lastScan = relTime ? relTime : 'Never';
      const count = !sp && source.lastCount != null ? `${source.lastCount} items` : '';
      const autoChecked = source.schedulerEnabled ? 'checked' : '';

      return `
        <div class="source-card${source.schedulerEnabled ? '' : ' auto-off'}">
          <div class="source-info">
            <span class="source-name">${escapeHtml(source.label)}</span>
            <div class="source-meta">
              <span class="source-status-dot ${escapeHtml(statusLabel)}"></span>
              <span>${escapeHtml(statusLabel)}</span>
              <span>${escapeHtml(lastScan)}</span>
              ${count ? `<span>${escapeHtml(count)}</span>` : ''}
            </div>
          </div>
          <div class="source-controls">
            <label class="toggle-switch" title="${source.schedulerEnabled ? 'Auto-scan on' : 'Auto-scan off'}">
              <input type="checkbox" class="source-auto-cb" data-source-id="${escapeHtml(source.id)}" ${autoChecked} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
            <button class="source-scan-btn" data-source-id="${escapeHtml(source.id)}" type="button"${isScanning ? ' disabled' : ''}>Scan</button>
          </div>
        </div>
      `;
    }).join('');

  // Wire source scan buttons
  for (const btn of el.sourcesList.querySelectorAll('.source-scan-btn')) {
    btn.addEventListener('click', () => triggerScan([btn.getAttribute('data-source-id')]));
  }
  // Wire auto-scan toggles
  for (const cb of el.sourcesList.querySelectorAll('.source-auto-cb')) {
    cb.addEventListener('change', async () => {
      const sourceId = cb.getAttribute('data-source-id');
      const enabled = cb.checked;
      cb.disabled = true;
      try {
        await fetch(`/api/sources/${encodeURIComponent(sourceId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        const sources = await fetchJson('/api/sources');
        renderSources(sources, false);
      } catch (err) {
        cb.checked = !enabled;
        showToast('Failed to toggle source', 'error');
      } finally { cb.disabled = false; }
    });
  }
}

// ── RENDER: PRODUCTS ────────────────────────────────────────────
function renderProducts(response) {
  const products = response?.items ?? [];
  const total = response?.total ?? products.length;

  if (!total) {
    el.productGrid.innerHTML = '';
    el.paginationArea.innerHTML = '';
    el.emptyState.classList.remove('hidden');
    return;
  }

  el.emptyState.classList.add('hidden');
  const favoriteSet = getFavoriteCategorySet();

  const cards = products.map((product, idx) => {
    const isNew = isNewProduct(product);
    const hasDiscount = Number.isFinite(product.discountPercent) && product.discountPercent > 0;
    const isHot = (product.score ?? 0) >= 75 || (hasDiscount && product.discountPercent >= 30);
    const score = product.score ?? 0;

    // Score class
    let scoreClass = 'neutral';
    if (score >= 75) scoreClass = 'fire';
    else if (score >= 55) scoreClass = 'hot';
    else if (score >= 30) scoreClass = 'warm';

    // Badges
    let badges = '';
    if (isNew) badges += '<span class="card-badge new">New</span>';
    if (isHot) badges += '<span class="card-badge hot">Hot</span>';
    if (product.sourceLabel) badges += `<span class="card-badge store">${escapeHtml(product.sourceLabel)}</span>`;

    // Image
    const imgSrc = product.imageUrl;
    const imageHtml = imgSrc
      ? `<img src="${escapeHtml(imgSrc)}" alt="" loading="lazy" />`
      : `<div class="card-image-placeholder">📦</div>`;

    // Price
    const priceHtml = formatSek(product.currentPriceSek);
    const origPrice = Number.isFinite(product.initialPriceSek)
      ? `<span class="card-price-original">${formatSek(product.initialPriceSek)}</span>` : '';
    const discountHtml = hasDiscount
      ? `<span class="card-discount">-${product.discountPercent}%</span>` : '';

    // Meta
    const seenText = timeAgo(product.lastSeenAt) ?? '';
    const condition = product.conditionLabel && product.conditionLabel !== 'Outlet' ? product.conditionLabel : '';

    // URL
    const url = product.url ? escapeHtml(product.url) : '';
    const titleLink = url
      ? `<a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(product.title)}</a>`
      : escapeHtml(product.title);

    const cardClass = `product-card${isNew ? ' is-new' : ''}`;
    const delay = Math.min(idx * 30, 300);

    return `
      <article class="${cardClass}" style="animation-delay:${delay}ms">
        <div class="card-image">
          ${imageHtml}
          <div class="card-badges">${badges}</div>
          ${score > 0 ? `<div class="card-score ${scoreClass}" title="Deal score: ${score}/100">${score}</div>` : ''}
        </div>
        <div class="card-body">
          <div class="card-info">
            <span class="card-category" data-filter-category="${escapeHtml(product.category)}">${favoriteSet.has(normalizeCategoryKey(product.category)) ? '★ ' : ''}${escapeHtml(product.category || 'Uncategorized')}</span>
            <h3 class="card-title">${titleLink}</h3>
          </div>
          <div class="card-pricing">
            <div class="card-price-row">
              <span class="card-price">${priceHtml}</span>
              ${origPrice}
              ${discountHtml}
            </div>
            <div class="card-meta">
              ${condition ? `<span>${escapeHtml(condition)}</span><span class="card-meta-dot"></span>` : ''}
              ${seenText ? `<span>${escapeHtml(seenText)}</span>` : ''}
              ${Number.isFinite(product.discountSek) && product.discountSek > 0 ? `<span class="card-meta-dot"></span><span>Save ${formatSek(product.discountSek)}</span>` : ''}
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');

  el.productGrid.innerHTML = cards;

  // Wire category click handlers
  for (const catEl of el.productGrid.querySelectorAll('[data-filter-category]')) {
    catEl.addEventListener('click', () => {
      const catName = catEl.getAttribute('data-filter-category');
      const match = state.categories.find(c => normalizeCategoryKey(c.name) === normalizeCategoryKey(catName));
      el.categoryFilter.value = match ? match.key : normalizeCategoryKey(catName);
      updateFilters();
    });
  }

  // Pagination
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
    buttons += `<button type="button" class="page-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`;
    lastP = p;
  }

  el.paginationArea.innerHTML = `
    <span class="pagination-info">Showing ${start}–${end} of ${total}</span>
    <div class="pagination-controls">
      <button type="button" class="page-btn" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>‹</button>
      ${buttons}
      <button type="button" class="page-btn" data-page="${page + 1}"${page >= totalPages ? ' disabled' : ''}>›</button>
    </div>
  `;

  for (const btn of el.paginationArea.querySelectorAll('[data-page]')) {
    btn.addEventListener('click', () => {
      const target = Number(btn.getAttribute('data-page'));
      if (!Number.isFinite(target) || target < 1) return;
      state.currentPage = target;
      loadDashboard().catch(err => showToast(err.message, 'error'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}

// ── RENDER: FILTERS ─────────────────────────────────────────────
function renderCategoryFilter(categories) {
  if (state.category && !categories.some(c => c.key === state.category)) {
    state.category = '';
    savePrefs();
  }
  const options = ['<option value="">All categories</option>']
    .concat(categories.map(c => {
      const selected = c.key === state.category ? ' selected' : '';
      return `<option value="${escapeHtml(c.key)}"${selected}>${escapeHtml(c.name)} (${c.count})</option>`;
    })).join('');
  el.categoryFilter.innerHTML = options;
}

function renderStoreFilter(sources) {
  if (!el.storeFilter || !Array.isArray(sources)) return;
  const options = ['<option value="">All stores</option>']
    .concat(sources.map(s => {
      const selected = s.id === state.store ? ' selected' : '';
      return `<option value="${escapeHtml(s.id)}"${selected}>${escapeHtml(s.label)}</option>`;
    })).join('');
  el.storeFilter.innerHTML = options;
}

function renderCampaignFilter(campaigns) {
  if (!el.campaignFilter || !Array.isArray(campaigns)) return;
  const options = ['<option value="">All campaigns</option>']
    .concat(campaigns.map(({ label, value }) => {
      const selected = value === state.campaign ? ' selected' : '';
      return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    })).join('');
  el.campaignFilter.innerHTML = options;
  el.campaignFilterGroup?.classList.toggle('hidden', campaigns.length === 0);
}

function renderActiveFilterTags() {
  const tags = [];
  if (state.search) tags.push(`Search: ${state.search}`);
  if (state.category) {
    const cat = state.categories.find(c => c.key === state.category);
    tags.push(`Category: ${cat?.name ?? state.category}`);
  }
  if (state.store) tags.push(`Store: ${state.store}`);
  if (state.minDiscountPercent) tags.push(`Min discount: ${state.minDiscountPercent}%`);
  if (state.minPriceSek) tags.push(`Min: ${formatSek(Number(state.minPriceSek))}`);
  if (state.maxPriceSek) tags.push(`Max: ${formatSek(Number(state.maxPriceSek))}`);

  el.activeFilterTags.innerHTML = tags.map(t => `<span class="filter-tag">${escapeHtml(t)}</span>`).join('');
  syncFilterBadge();
}

// ── RENDER: SCHEDULER STATUS ────────────────────────────────────
function renderSchedulerPill() {
  if (!state.schedulerEnabled) {
    el.schedulerStatus.classList.remove('hidden');
    el.schedulerStatus.classList.add('paused');
    el.schedulerText.textContent = 'Paused';
    return;
  }
  if (state.schedulerNextRunAt) {
    el.schedulerStatus.classList.remove('hidden', 'paused');
    el.schedulerText.textContent = `Next: ${formatCountdown(state.schedulerNextRunAt)}`;
  } else {
    el.schedulerStatus.classList.add('hidden');
  }
}

function renderSchedulerForm(scheduler) {
  if (!scheduler) {
    el.schedulerEnabled.disabled = true;
    el.schedulerInterval.disabled = true;
    return;
  }

  const aw = scheduler.activeWindow ?? {};
  state.schedulerEnabled = Boolean(scheduler.enabled);
  state.schedulerIntervalMinutes = Number.isFinite(scheduler.intervalMinutes) ? scheduler.intervalMinutes : 180;
  state.schedulerWindowEnabled = Boolean(aw.enabled);
  state.schedulerWindowStart = parseTimeOfDay(aw.startTime) ?? '07:00';
  state.schedulerWindowEnd = parseTimeOfDay(aw.endTime) ?? '00:00';
  state.schedulerIsInActiveWindow = scheduler.isInActiveWindow !== false;
  state.schedulerNextRunAt = scheduler.nextRunAt ?? null;

  el.schedulerEnabled.checked = state.schedulerEnabled;
  el.schedulerInterval.value = String(state.schedulerIntervalMinutes);
  el.schedulerWindowEnabled.checked = state.schedulerWindowEnabled;
  el.schedulerWindowStart.value = state.schedulerWindowStart;
  el.schedulerWindowEnd.value = state.schedulerWindowEnd;
  el.schedulerEnabled.disabled = false;
  el.schedulerInterval.disabled = false;

  // Status in drawer
  const nextText = state.schedulerNextRunAt ? formatCountdown(state.schedulerNextRunAt) : 'Not scheduled';
  const windowText = state.schedulerWindowEnabled
    ? `${state.schedulerWindowStart}–${state.schedulerWindowEnd} (${state.schedulerIsInActiveWindow ? '✅ in window' : '⏳ outside'})`
    : 'All day';
  el.modalSchedulerStatus.innerHTML = `
    <div><strong>Next scan:</strong> ${escapeHtml(nextText)}</div>
    <div><strong>Active window:</strong> ${escapeHtml(windowText)}</div>
  `;

  renderSchedulerPill();
}

// ── RENDER: FAVORITES ───────────────────────────────────────────
function renderFavoriteChips() {
  if (!state.favoriteCategories.length) {
    el.favoriteChips.innerHTML = '<p style="font-size:0.8rem;color:var(--text-tertiary)">No favorites yet. Add categories below.</p>';
    return;
  }
  el.favoriteChips.innerHTML = state.favoriteCategories.map(cat => `
    <span class="fav-chip">
      <span>★ ${escapeHtml(cat)}</span>
      <button type="button" class="fav-chip-remove" data-remove-fav="${escapeHtml(cat)}" aria-label="Remove">×</button>
    </span>
  `).join('');

  for (const btn of el.favoriteChips.querySelectorAll('[data-remove-fav]')) {
    btn.addEventListener('click', async () => {
      const cat = btn.getAttribute('data-remove-fav');
      const next = state.favoriteCategories.filter(c => c !== cat);
      try {
        await saveFavoriteCategories(next);
        renderFavoriteChips();
        renderFavoritesEditor();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
}

function renderFavoritesEditor() {
  if (!state.categories.length) {
    el.favoritesEditor.innerHTML = '<p style="font-size:0.8rem;color:var(--text-tertiary)">Run a scan first to see categories.</p>';
    return;
  }

  const favSet = getFavoriteCategorySet();
  const query = (el.favoritesSearchInput?.value ?? '').trim().toLowerCase();
  const visible = state.categories.filter(c => !query || c.name.toLowerCase().includes(query));

  el.favoritesEditor.innerHTML = visible.map(c => {
    const isFav = favSet.has(c.key);
    return `
      <button type="button" class="fav-grid-item${isFav ? ' active' : ''}" data-fav-cat="${escapeHtml(c.name)}">
        <span class="fav-star">${isFav ? '★' : '☆'}</span>
        <span>${escapeHtml(c.name)}</span>
        <span class="fav-count">${c.count}</span>
      </button>
    `;
  }).join('');

  for (const btn of el.favoritesEditor.querySelectorAll('[data-fav-cat]')) {
    btn.addEventListener('click', async () => {
      const cat = btn.getAttribute('data-fav-cat');
      const next = new Set(state.favoriteCategories);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      try {
        await saveFavoriteCategories([...next]);
        renderFavoriteChips();
        renderFavoritesEditor();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
}

async function saveFavoriteCategories(categories) {
  const payload = await fetchJson('/api/preferences/favorite-categories', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ categories })
  });
  state.favoriteCategories = payload.favoriteCategories ?? [];
}

// ── SCAN CONTROL ────────────────────────────────────────────────
async function triggerScan(sourceIds = null) {
  try {
    const body = sourceIds ? { sourceIds } : {};
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) { showToast(data.message || 'Failed to start scan.', 'error'); return; }
    showToast(data.message || 'Scan started', 'info');
    scheduleScanPoll(1500);
  } catch (err) { showToast(err.message, 'error'); }
}

function syncScanUI(status) {
  if (!status.isRunning) {
    el.scanBtn.disabled = false;
    el.scanBtn.querySelector('.scan-btn-label').textContent = 'Scan';
    el.cancelBtn.classList.add('hidden');
    el.scanProgress.classList.add('hidden');
    return;
  }

  const progress = status.scanProgress ?? {};
  const total = Number(progress.totalSources ?? 0);
  const completed = Number(progress.completedSources ?? 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  el.scanBtn.disabled = true;
  el.scanBtn.querySelector('.scan-btn-label').textContent = total ? `${completed}/${total}` : '...';
  el.cancelBtn.classList.remove('hidden');
  el.cancelBtn.disabled = Boolean(status.isCancelling);
  el.cancelBtn.textContent = status.isCancelling ? 'Cancelling...' : 'Cancel';
  el.scanProgress.classList.remove('hidden');
  el.scanProgressBar.style.width = `${pct}%`;
  el.scanProgressText.textContent = total ? `Scanning ${completed}/${total} sources` : 'Starting scan...';
}

function clearScanPoll() {
  if (scanPollTimer) { clearTimeout(scanPollTimer); scanPollTimer = null; }
}

function scheduleScanPoll(delay = 3000) {
  clearScanPoll();
  scanPollTimer = setTimeout(() => {
    scanPollTimer = null;
    pollScanStatus().catch(err => {
      showToast(err.message, 'error');
      scheduleScanPoll(5000);
    });
  }, delay);
}

async function pollScanStatus() {
  const [status, sources] = await Promise.all([
    fetchJson('/api/status'),
    fetchJson('/api/sources')
  ]);
  syncScanUI(status);
  renderSources(sources, status.isRunning, status.scanProgress?.sourceProgress);
  renderSchedulerForm(status.scheduler);
  el.runSummary.textContent = JSON.stringify(status.lastRunSummary ?? {}, null, 2);

  if (status.isRunning) {
    const currentCompleted = status.scanProgress?.completedSources ?? 0;
    if (currentCompleted > lastCompletedSources) {
      lastCompletedSources = currentCompleted;
      loadDashboard().catch(() => {});
    }
    scheduleScanPoll();
    return;
  }

  lastCompletedSources = 0;
  await loadDashboard();
}

// ── FILTER LOGIC ────────────────────────────────────────────────
function applyCurrentFilters() {
  state.search = el.searchInput.value.trim();
  state.category = el.categoryFilter.value;
  state.store = el.storeFilter?.value ?? '';
  state.campaign = el.campaignFilter?.value ?? '';
  state.favoritesOnly = el.favoritesOnly.checked;
  state.discountedOnly = el.discountedOnly.checked;
  state.newOnly = el.newOnly.checked;
  state.referenceOnly = el.referenceOnly.checked;
  state.minDiscountPercent = el.minDiscountFilter.value.trim();
  state.minPriceSek = el.minPriceFilter.value.trim();
  state.maxPriceSek = el.maxPriceFilter.value.trim();

  // Determine active preset
  const presetMap = { new: state.newOnly, hot: state.hotOnly, discounted: state.discountedOnly, matched: state.referenceOnly, favorites: state.favoritesOnly };
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
  state.favoritesOnly = false;
  state.discountedOnly = false;
  state.newOnly = false;
  state.hotOnly = false;
  state.referenceOnly = false;
  state.minDiscountPercent = '';
  state.minPriceSek = '';
  state.maxPriceSek = '';
  state.activePreset = 'all';

  el.searchInput.value = '';
  el.categoryFilter.value = '';
  if (el.storeFilter) el.storeFilter.value = '';
  if (el.campaignFilter) el.campaignFilter.value = '';
  el.favoritesOnly.checked = false;
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
      loadDashboard().catch(err => showToast(err.message, 'error'));
    }, 250);
    return;
  }
  loadDashboard().catch(err => showToast(err.message, 'error'));
}

// ── MAIN LOAD ───────────────────────────────────────────────────
async function loadDashboard() {
  const [status, categories, preferences, sources, outletSources, outletCampaigns] = await Promise.all([
    fetchJson('/api/status'),
    fetchJson('/api/outlet-categories'),
    fetchJson('/api/preferences'),
    fetchJson('/api/sources'),
    fetchJson('/api/outlet-sources'),
    fetchJson('/api/outlet-campaigns')
  ]);

  state.latestRunStartedAt = status.lastRunSummary?.startedAt ?? status.lastRunStartedAt ?? null;
  state.favoriteCategories = preferences.favoriteCategories ?? [];
  state.categories = categories ?? [];

  if (state.category && !state.categories.some(c => c.key === state.category)) {
    state.category = '';
    el.categoryFilter.value = '';
    savePrefs();
  }

  const query = buildProductsQuery();
  const response = await fetchJson(`/api/outlet-products${query}`);
  latestProducts = response;

  syncScanUI(status);
  renderStats(status, response);
  renderSources(sources, status.isRunning, status.scanProgress?.sourceProgress);
  renderCategoryFilter(categories);
  renderStoreFilter(outletSources ?? []);
  renderCampaignFilter(outletCampaigns ?? []);
  renderActiveFilterTags();
  renderSchedulerForm(status.scheduler);
  renderProducts(response);
  el.runSummary.textContent = JSON.stringify(status.lastRunSummary ?? {}, null, 2);

  if (status.isRunning) { scheduleScanPoll(); } else { clearScanPoll(); }
}

// ── SETTINGS DRAWER ─────────────────────────────────────────────
function openDrawer() {
  el.settingsDrawer.classList.remove('hidden');
  el.settingsOverlay.classList.remove('hidden');
  el.settingsOverlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  loadDrawerData();
}

function closeDrawer() {
  el.settingsDrawer.classList.add('hidden');
  el.settingsOverlay.classList.add('hidden');
  el.settingsOverlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function loadDrawerData() {
  // Load notification settings
  try {
    const res = await fetch('/api/notification-settings');
    if (res.ok) notifSettings = await res.json();
    if (!Array.isArray(notifSettings.alertRules)) notifSettings.alertRules = [];
  } catch {}

  // Load categories
  try {
    const cats = await fetchJson('/api/outlet-categories');
    if (Array.isArray(cats)) {
      allCategories = cats.map(c => typeof c === 'string' ? c : c.name).filter(Boolean).sort((a, b) => a.localeCompare(b, 'sv-SE'));
    }
  } catch { allCategories = []; }

  // Load sources
  try {
    const srcs = await fetchJson('/api/sources');
    if (Array.isArray(srcs)) {
      allSources = srcs.filter(s => s.enabled).map(s => ({ id: s.id, label: s.label }));
    }
  } catch { allSources = []; }

  if (el.notificationsEnabledToggle) {
    el.notificationsEnabledToggle.checked = notifSettings.notificationsEnabled !== false;
  }

  renderRuleList();
  renderFavoriteChips();
  renderFavoritesEditor();

  // Load scheduler
  try {
    const sched = await fetchJson('/api/scheduler');
    renderSchedulerForm(sched);
  } catch {}
}

// ── ALERT RULES ─────────────────────────────────────────────────
function createEmptyRule() {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label: '',
    enabled: true,
    keywords: [],
    categories: [],
    excludedSources: [],
    webhooks: [''],
    maxPriceSek: null
  };
}

function wireChipInput({ container, items, onAdd, onRemove, allOptions, placeholder }) {
  const chipList = container.querySelector('.chip-list');
  const textInput = container.querySelector('.chip-text-input');
  const dropdown = container.querySelector('.kw-cat-dropdown');
  if (placeholder) textInput.setAttribute('placeholder', placeholder);

  function refreshChips() {
    chipList.innerHTML = items
      .map(v => `<span class="chip" data-val="${escapeHtml(v)}">${escapeHtml(v)}<button type="button" class="chip-remove" tabindex="-1">×</button></span>`)
      .join('');
    chipList.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const val = btn.closest('.chip').dataset.val;
        const idx = items.indexOf(val);
        if (idx !== -1) items.splice(idx, 1);
        onRemove(val);
        refreshChips();
        if (dropdown) renderDropdown();
      });
    });
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

  textInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addValue(textInput.value); if (dropdown) dropdown.classList.add('hidden'); }
    else if (e.key === 'Escape') { if (dropdown) dropdown.classList.add('hidden'); textInput.blur(); }
    else if (e.key === 'Backspace' && !textInput.value && items.length) { const last = items[items.length - 1]; items.splice(items.length - 1, 1); onRemove(last); refreshChips(); }
  });

  if (dropdown) {
    textInput.addEventListener('focus', () => { renderDropdown(); dropdown.classList.remove('hidden'); });
    textInput.addEventListener('input', () => { renderDropdown(); dropdown.classList.remove('hidden'); });
    textInput.addEventListener('blur', () => { setTimeout(() => dropdown.classList.add('hidden'), 150); });
  }
  refreshChips();
}

function createRuleElement(rule) {
  const li = document.createElement('li');
  li.className = 'rule-item';
  if (!rule.enabled) li.classList.add('rule-disabled');
  li.dataset.ruleId = rule.id;

  const webhooksHtml = (rule.webhooks.length ? rule.webhooks : ['']).map(w => `
    <div class="webhook-row">
      <input type="url" class="modal-input rule-webhook-input" placeholder="https://discord.com/api/webhooks/…" value="${escapeHtml(w)}" />
      <button type="button" class="btn-icon-sm remove-webhook-btn" style="visibility:hidden">×</button>
    </div>`).join('');

  li.innerHTML = `
    <div class="rule-header">
      <label class="toggle-switch" title="${rule.enabled ? 'Enabled' : 'Disabled'}">
        <input type="checkbox" class="rule-enabled-cb" ${rule.enabled ? 'checked' : ''} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
      <input type="text" class="rule-label-input" placeholder="Alert name (e.g. GPU Deals)" value="${escapeHtml(rule.label)}" />
      <button type="button" class="rule-delete-btn" title="Delete">✕</button>
    </div>
    <div class="rule-body">
      <div class="rule-row rule-row-two-col">
        <div class="rule-field">
          <label class="rule-field-label">Keywords <span class="rule-hint">Enter/comma to add</span></label>
          <div class="chip-input-wrap" id="kw-chips-${rule.id}"><div class="chip-list"></div><input type="text" class="chip-text-input" placeholder="e.g. RTX 5070" autocomplete="off" /></div>
        </div>
        <div class="rule-field">
          <label class="rule-field-label">Categories <span class="rule-hint">Optional filter</span></label>
          <div class="chip-input-wrap" id="cat-chips-${rule.id}"><div class="chip-list"></div><input type="text" class="chip-text-input" placeholder="Search…" autocomplete="off" /><ul class="kw-cat-dropdown hidden"></ul></div>
        </div>
      </div>
      <div class="rule-row">
        <div class="rule-field">
          <label class="rule-field-label">Exclude sources <span class="rule-hint">Optional</span></label>
          <div class="chip-input-wrap" id="src-chips-${rule.id}"><div class="chip-list"></div><input type="text" class="chip-text-input" placeholder="Search…" autocomplete="off" /><ul class="kw-cat-dropdown hidden"></ul></div>
        </div>
      </div>
      <div class="rule-row">
        <div class="rule-field">
          <label class="rule-field-label">Discord webhook(s)</label>
          <div class="webhooks-list">${webhooksHtml}</div>
          <button type="button" class="ghost-btn add-webhook-btn" style="margin-top:0.375rem">+ Add webhook</button>
        </div>
        <div class="rule-field">
          <label class="rule-field-label">Max price (SEK)</label>
          <input type="number" class="modal-input rule-maxprice-input" placeholder="e.g. 5000" min="0" step="100" value="${rule.maxPriceSek != null ? rule.maxPriceSek : ''}" />
        </div>
      </div>
    </div>`;

  // Wire events
  li.querySelector('.rule-enabled-cb').addEventListener('change', e => { rule.enabled = e.target.checked; li.classList.toggle('rule-disabled', !rule.enabled); });
  li.querySelector('.rule-label-input').addEventListener('input', e => { rule.label = e.target.value; });
  li.querySelector('.rule-delete-btn').addEventListener('click', () => {
    notifSettings.alertRules = notifSettings.alertRules.filter(r => r.id !== rule.id);
    li.remove();
    renderRuleList();
  });

  wireChipInput({ container: li.querySelector(`#kw-chips-${rule.id}`), items: rule.keywords, onAdd: () => {}, onRemove: () => {}, allOptions: null });
  wireChipInput({ container: li.querySelector(`#cat-chips-${rule.id}`), items: rule.categories, onAdd: () => {}, onRemove: () => {}, allOptions: allCategories });

  // Excluded sources
  if (!Array.isArray(rule.excludedSources)) rule.excludedSources = [];
  const sourceLabels = allSources.map(s => s.label);
  const labelToId = Object.fromEntries(allSources.map(s => [s.label, s.id]));
  const idToLabel = Object.fromEntries(allSources.map(s => [s.id, s.label]));
  const excludedLabels = rule.excludedSources.map(id => idToLabel[id] ?? id);
  wireChipInput({
    container: li.querySelector(`#src-chips-${rule.id}`),
    items: excludedLabels,
    onAdd: label => { const id = labelToId[label] ?? label; if (!rule.excludedSources.includes(id)) rule.excludedSources.push(id); },
    onRemove: label => { const id = labelToId[label] ?? label; const idx = rule.excludedSources.indexOf(id); if (idx !== -1) rule.excludedSources.splice(idx, 1); },
    allOptions: sourceLabels
  });

  // Webhooks
  const webhooksList = li.querySelector('.webhooks-list');
  const addWebhookBtn = li.querySelector('.add-webhook-btn');
  function syncWebhooks() {
    rule.webhooks = [...webhooksList.querySelectorAll('.rule-webhook-input')].map(i => i.value.trim());
    const rows = webhooksList.querySelectorAll('.webhook-row');
    rows.forEach(row => { const btn = row.querySelector('.remove-webhook-btn'); if (btn) btn.style.visibility = rows.length > 1 ? 'visible' : 'hidden'; });
  }
  webhooksList.addEventListener('input', () => { rule.webhooks = [...webhooksList.querySelectorAll('.rule-webhook-input')].map(i => i.value.trim()); });
  webhooksList.addEventListener('click', e => { if (e.target.classList.contains('remove-webhook-btn')) { e.target.closest('.webhook-row').remove(); syncWebhooks(); } });
  addWebhookBtn.addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'webhook-row';
    row.innerHTML = '<input type="url" class="modal-input rule-webhook-input" placeholder="https://discord.com/api/webhooks/…" /><button type="button" class="btn-icon-sm remove-webhook-btn">×</button>';
    webhooksList.appendChild(row);
    syncWebhooks();
  });
  syncWebhooks();

  // Max price
  li.querySelector('.rule-maxprice-input').addEventListener('input', e => {
    const v = Number(e.target.value);
    rule.maxPriceSek = e.target.value.trim() === '' ? null : (Number.isFinite(v) && v >= 0 ? v : null);
  });

  return li;
}

function renderRuleList() {
  el.rulesList.innerHTML = '';
  el.rulesCountLabel.textContent = notifSettings.alertRules.length
    ? `${notifSettings.alertRules.length} rule${notifSettings.alertRules.length !== 1 ? 's' : ''}`
    : 'No rules';

  if (!notifSettings.alertRules.length) {
    el.rulesList.innerHTML = '<li class="rules-empty-state"><div class="rules-empty-icon">🔔</div><p class="rules-empty-title">No alert rules</p><p class="rules-empty-sub">Create a rule to get Discord notifications for matching products.</p></li>';
    return;
  }
  for (const rule of notifSettings.alertRules) {
    el.rulesList.appendChild(createRuleElement(rule));
  }
}

// ── SAVE SETTINGS ───────────────────────────────────────────────
async function saveAllSettings() {
  el.saveSettingsBtn.disabled = true;
  el.drawerSaveStatus.textContent = 'Saving…';

  try {
    // Save notification settings
    notifSettings.notificationsEnabled = el.notificationsEnabledToggle?.checked !== false;
    const res = await fetch('/api/notification-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notifSettings)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notifSettings = await res.json();
    if (!Array.isArray(notifSettings.alertRules)) notifSettings.alertRules = [];

    // Save scheduler
    const intervalMinutes = parsePositiveInteger(el.schedulerInterval.value);
    const startTime = parseTimeOfDay(el.schedulerWindowStart.value);
    const endTime = parseTimeOfDay(el.schedulerWindowEnd.value);
    if (intervalMinutes && startTime && endTime) {
      const sched = await fetchJson('/api/scheduler', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: el.schedulerEnabled.checked,
          intervalMinutes,
          activeWindow: { enabled: el.schedulerWindowEnabled.checked, startTime, endTime, timeZone: 'Europe/Stockholm' }
        })
      });
      renderSchedulerForm(sched);
    }

    el.drawerSaveStatus.textContent = '✓ Saved';
    setTimeout(() => { el.drawerSaveStatus.textContent = ''; }, 2500);
    renderRuleList();
  } catch (err) {
    el.drawerSaveStatus.textContent = `Error: ${err.message}`;
    showToast(`Save failed: ${err.message}`, 'error');
  } finally {
    el.saveSettingsBtn.disabled = false;
  }
}

// ── BULK SOURCE TOGGLE ──────────────────────────────────────────
async function bulkToggleSources(enabled) {
  const sources = await fetchJson('/api/sources');
  const targets = sources.filter(s => s.enabled && s.schedulerEnabled !== enabled);
  await Promise.all(targets.map(s =>
    fetch(`/api/sources/${encodeURIComponent(s.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    })
  ));
  const updated = await fetchJson('/api/sources');
  renderSources(updated, false);
}

// ── EVENT LISTENERS ─────────────────────────────────────────────
function bindEvents() {
  // Search
  el.searchInput.addEventListener('input', () => updateFilters({ debounce: true }));

  // Filter selects
  el.categoryFilter.addEventListener('change', () => updateFilters());
  el.storeFilter?.addEventListener('change', () => updateFilters());
  el.campaignFilter?.addEventListener('change', () => updateFilters());

  // Filter checkboxes
  el.newOnly.addEventListener('change', () => updateFilters());
  el.discountedOnly.addEventListener('change', () => updateFilters());
  el.favoritesOnly.addEventListener('change', () => updateFilters());
  el.referenceOnly.addEventListener('change', () => updateFilters());

  // Filter inputs
  el.minDiscountFilter.addEventListener('input', () => updateFilters({ debounce: true }));
  el.minPriceFilter.addEventListener('input', () => updateFilters({ debounce: true }));
  el.maxPriceFilter.addEventListener('input', () => updateFilters({ debounce: true }));

  // Clear filters
  el.clearFiltersBtn.addEventListener('click', () => { resetFilters(); loadDashboard().catch(err => showToast(err.message, 'error')); });

  // Filter presets
  for (const pill of el.filterPills) {
    pill.addEventListener('click', () => {
      applyPreset(pill.getAttribute('data-filter-preset'));
      state.currentPage = 1;
      loadDashboard().catch(err => showToast(err.message, 'error'));
    });
  }

  // Filter panel toggle
  el.filterExpandBtn.addEventListener('click', () => {
    state.filterPanelOpen = !state.filterPanelOpen;
    el.filterPanel.classList.toggle('hidden', !state.filterPanelOpen);
    el.filterExpandBtn.classList.toggle('active', state.filterPanelOpen);
  });

  // Sort
  el.sortSelect.addEventListener('change', () => {
    const [col, dir] = el.sortSelect.value.split('-');
    state.sortBy = col;
    state.sortDirection = dir;
    state.currentPage = 1;
    savePrefs();
    loadDashboard().catch(err => showToast(err.message, 'error'));
  });

  // View mode
  el.viewGrid.addEventListener('click', () => { state.viewMode = 'grid'; syncViewMode(); savePrefs(); });
  el.viewList.addEventListener('click', () => { state.viewMode = 'list'; syncViewMode(); savePrefs(); });

  // Scan
  el.scanBtn.addEventListener('click', () => triggerScan(null));
  el.cancelBtn.addEventListener('click', async () => {
    el.cancelBtn.disabled = true;
    el.cancelBtn.textContent = 'Cancelling...';
    try { await fetch('/api/cancel', { method: 'POST' }); } catch {}
  });

  // Settings drawer
  el.settingsBtn.addEventListener('click', openDrawer);
  el.drawerClose.addEventListener('click', closeDrawer);
  el.settingsOverlay.addEventListener('click', closeDrawer);

  // Drawer tabs
  for (const tab of el.drawerTabs) {
    tab.addEventListener('click', () => {
      el.drawerTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      $$('.drawer-tab-content').forEach(c => c.classList.add('hidden'));
      const target = $(`#tab-${tab.dataset.tab}`);
      if (target) target.classList.remove('hidden');
    });
  }

  // Save settings
  el.saveSettingsBtn.addEventListener('click', saveAllSettings);

  // Add rule
  el.addRuleBtn.addEventListener('click', () => {
    const rule = createEmptyRule();
    notifSettings.alertRules.push(rule);
    el.rulesList.innerHTML = '';
    renderRuleList();
  });

  // Source bulk toggles
  el.sourcesAllOn?.addEventListener('click', () => bulkToggleSources(true));
  el.sourcesAllOff?.addEventListener('click', () => bulkToggleSources(false));

  // Favorites search
  el.favoritesSearchInput?.addEventListener('input', () => renderFavoritesEditor());

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      el.searchInput.focus();
    }
    if (e.key === 'Escape') {
      if (!el.settingsDrawer.classList.contains('hidden')) closeDrawer();
      else if (state.filterPanelOpen) { state.filterPanelOpen = false; el.filterPanel.classList.add('hidden'); el.filterExpandBtn.classList.remove('active'); }
    }
  });
}

// ── INIT ────────────────────────────────────────────────────────
initTheme();
hydratePrefs();
bindEvents();
loadDashboard().catch(err => showToast(err.message, 'error'));
