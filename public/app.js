const sekFormatter = new Intl.NumberFormat('sv-SE', {
  style: 'currency',
  currency: 'SEK',
  maximumFractionDigits: 0
});

const state = {
  search: '',
  category: '',
  store: '',
  favoritesOnly: false,
  discountedOnly: false,
  newOnly: false,
  referenceOnly: false,
  minDiscountPercent: '',
  minPriceSek: '',
  maxPriceSek: '',
  favoriteCategories: [],
  categories: [],
  favoritesEditorOpen: false,
  favoritesSearch: '',
  sortBy: 'discountPercent',
  sortDirection: 'desc',
  currentPage: 1,
  pageSize: 50,
  schedulerEnabled: true,
  schedulerIntervalMinutes: 180,
  schedulerWindowEnabled: false,
  schedulerWindowStart: '07:00',
  schedulerWindowEnd: '00:00',
  schedulerTimeZone: 'Europe/Stockholm',
  schedulerIsInActiveWindow: true,
  schedulerNextRunAt: null,
  schedulerFormDirty: false,
  latestRunStartedAt: null,
  // Default: open on desktop, closed on mobile
  sidebarOpen: window.matchMedia('(min-width: 1025px)').matches
};

const UI_PREFERENCES_STORAGE_KEY = 'elgiganten-outlet-ui-preferences-v1';
const NEW_PRODUCT_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

const elements = {
  noticeBanner: document.querySelector('#notice-banner'),
  statsGrid: document.querySelector('#stats-grid'),
  runSummary: document.querySelector('#run-summary'),
  categoryFilter: document.querySelector('#category-filter'),
  storeFilter: document.querySelector('#store-filter'),
  searchInput: document.querySelector('#search-input'),
  favoritesOnly: document.querySelector('#favorites-only'),
  discountedOnly: document.querySelector('#discounted-only'),
  newOnly: document.querySelector('#new-only'),
  referenceOnly: document.querySelector('#reference-only'),
  minDiscountFilter: document.querySelector('#min-discount-filter'),
  minPriceFilter: document.querySelector('#min-price-filter'),
  maxPriceFilter: document.querySelector('#max-price-filter'),
  clearFiltersButton: document.querySelector('#clear-filters-button'),
  filterPresetButtons: [...document.querySelectorAll('[data-filter-preset]')],
  sidebar: document.querySelector('#sidebar'),
  sidebarToggle: document.querySelector('#sidebar-toggle'),
  sidebarClose: document.querySelector('#sidebar-close'),
  sidebarBackdrop: document.querySelector('#sidebar-backdrop'),
  filterRailBadge: document.querySelector('#filter-rail-badge'),
  railButtons: [...document.querySelectorAll('[data-open-section]')],
  activeFilters: document.querySelector('#active-filters'),
  sourcesList: document.querySelector('#sources-list'),
  scanAllBtn: document.querySelector('#scan-all-btn'),
  sourcesAllOnBtn: document.querySelector('#sources-all-on-btn'),
  sourcesAllOffBtn: document.querySelector('#sources-all-off-btn'),
  favoritesEditor: document.querySelector('#favorites-editor'),
  favoritesEditorWrap: document.querySelector('#favorites-editor-wrap'),
  favoritesSearchInput: document.querySelector('#favorites-search-input'),
  favoritesCount: document.querySelector('#favorites-count'),
  favoriteChips: document.querySelector('#favorite-chips'),
  toggleFavoritesEditor: document.querySelector('#toggle-favorites-editor'),
  schedulerEnabled: document.querySelector('#scheduler-enabled'),
  schedulerInterval: document.querySelector('#scheduler-interval'),
  schedulerWindowEnabled: document.querySelector('#scheduler-window-enabled'),
  schedulerWindowStart: document.querySelector('#scheduler-window-start'),
  schedulerWindowEnd: document.querySelector('#scheduler-window-end'),
  notifyTypeFavorites: document.querySelector('#notify-type-favorites'),
  notifyTypeKeywords: document.querySelector('#notify-type-keywords'),
  notifyTypeCategories: document.querySelector('#notify-type-categories'),
  saveSchedulerButton: null,
  schedulerSaveStatus: null,
  schedulerNextRun: document.querySelector('#scheduler-next-run'),
  modalSchedulerStatus: document.querySelector('#modal-scheduler-status'),
  scannerToggles: null,
  productsCount: document.querySelector('#products-count'),
  productsTable: document.querySelector('#products-table'),
  refreshButton: document.querySelector('#refresh-button'),
  scanButton: document.querySelector('#scan-button'),
  cancelButton: document.querySelector('#cancel-button'),
  scanProgressBar: document.querySelector('#scan-progress-bar'),
  scanProgressFill: document.querySelector('#scan-progress-fill')
};

let scanPollTimer = null;
let filterApplyTimer = null;
let latestProducts = [];
let lastCompletedSources = 0;

function formatSek(value) {
  return Number.isFinite(value) ? sekFormatter.format(Math.round(value)) : 'n/a';
}

function formatDate(value) {
  if (!value) {
    return 'n/a';
  }

  return new Date(value).toLocaleString('sv-SE');
}

function formatRelativeTime(value) {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 0) return formatDate(value);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(value).toLocaleDateString('sv-SE', { month: 'short', day: 'numeric' });
}

function formatCountdown(value) {
  if (!value) return null;
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'in < 1 min';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
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

function loadUiPreferences() {
  try {
    const raw = localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveUiPreferences() {
  const payload = {
    search: state.search,
    category: state.category,
    store: state.store,
    favoritesOnly: state.favoritesOnly,
    discountedOnly: state.discountedOnly,
    newOnly: state.newOnly,
    referenceOnly: state.referenceOnly,
    minDiscountPercent: state.minDiscountPercent,
    minPriceSek: state.minPriceSek,
    maxPriceSek: state.maxPriceSek,
    favoritesEditorOpen: state.favoritesEditorOpen,
    favoritesSearch: state.favoritesSearch,
    sortBy: state.sortBy,
    sortDirection: state.sortDirection,
    sidebarOpen: state.sidebarOpen
  };

  try {
    localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore local storage failures.
  }
}

function hydrateUiPreferences() {
  const saved = loadUiPreferences();

  if (typeof saved.search === 'string') {
    state.search = saved.search;
  }

  if (typeof saved.category === 'string') {
    state.category = saved.category;
  }

  if (typeof saved.store === 'string') {
    state.store = saved.store;
  }

  if (typeof saved.favoritesOnly === 'boolean') {
    state.favoritesOnly = saved.favoritesOnly;
  }

  if (typeof saved.discountedOnly === 'boolean') {
    state.discountedOnly = saved.discountedOnly;
  }

  if (typeof saved.newOnly === 'boolean') {
    state.newOnly = saved.newOnly;
  }

  if (typeof saved.referenceOnly === 'boolean') {
    state.referenceOnly = saved.referenceOnly;
  }

  if (typeof saved.minDiscountPercent === 'string') {
    state.minDiscountPercent = saved.minDiscountPercent;
  }

  if (typeof saved.minPriceSek === 'string') {
    state.minPriceSek = saved.minPriceSek;
  }

  if (typeof saved.maxPriceSek === 'string') {
    state.maxPriceSek = saved.maxPriceSek;
  }

  if (typeof saved.favoritesEditorOpen === 'boolean') {
    state.favoritesEditorOpen = saved.favoritesEditorOpen;
  }

  if (typeof saved.favoritesSearch === 'string') {
    state.favoritesSearch = saved.favoritesSearch;
  }

  if (typeof saved.sortBy === 'string') {
    state.sortBy = saved.sortBy;
  }

  if (saved.sortDirection === 'asc' || saved.sortDirection === 'desc') {
    state.sortDirection = saved.sortDirection;
  }

  if (typeof saved.sidebarOpen === 'boolean') {
    state.sidebarOpen = saved.sidebarOpen;
  } else {
    // Default: open on desktop, closed on mobile
    state.sidebarOpen = window.matchMedia('(min-width: 1025px)').matches;
  }

  elements.searchInput.value = state.search;
  elements.favoritesOnly.checked = state.favoritesOnly;
  elements.discountedOnly.checked = state.discountedOnly;
  elements.newOnly.checked = state.newOnly;
  elements.referenceOnly.checked = state.referenceOnly;
  elements.minDiscountFilter.value = state.minDiscountPercent;
  elements.minPriceFilter.value = state.minPriceSek;
  elements.maxPriceFilter.value = state.maxPriceSek;
  elements.favoritesSearchInput.value = state.favoritesSearch;
  renderFilterPresetButtons();
  renderSidebarState();
}

function getFavoriteCategorySet() {
  return new Set(state.favoriteCategories.map((category) => normalizeCategoryKey(category)));
}

function getActiveFilterPreset() {
  const active = [
    state.newOnly ? 'new' : null,
    state.discountedOnly ? 'discounted' : null,
    state.referenceOnly ? 'matched' : null,
    state.favoritesOnly ? 'favorites' : null
  ].filter(Boolean);

  return active.length === 1 ? active[0] : null;
}

function renderFilterPresetButtons() {
  const activePreset = getActiveFilterPreset();

  for (const button of elements.filterPresetButtons) {
    const preset = button.getAttribute('data-filter-preset');
    const isActive = preset === activePreset;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }
}

function applyFilterPreset(preset) {
  state.newOnly = preset === 'new';
  state.discountedOnly = preset === 'discounted';
  state.referenceOnly = preset === 'matched';
  state.favoritesOnly = preset === 'favorites';

  elements.newOnly.checked = state.newOnly;
  elements.discountedOnly.checked = state.discountedOnly;
  elements.referenceOnly.checked = state.referenceOnly;
  elements.favoritesOnly.checked = state.favoritesOnly;

  saveUiPreferences();
  renderFilterPresetButtons();
}

function getActiveFilterCount() {
  let count = 0;
  if (state.search) count++;
  if (state.category) count++;
  if (state.store) count++;
  if (state.favoritesOnly) count++;
  if (state.discountedOnly) count++;
  if (state.newOnly) count++;
  if (state.referenceOnly) count++;
  if (state.minDiscountPercent) count++;
  if (state.minPriceSek) count++;
  if (state.maxPriceSek) count++;
  return count;
}

function renderSidebarState() {
  document.body.classList.toggle('sidebar-open', state.sidebarOpen);
  elements.sidebarToggle.setAttribute('aria-expanded', state.sidebarOpen ? 'true' : 'false');
  elements.sidebarToggle.classList.toggle('active', state.sidebarOpen);

  // Update filter count badge on collapsed rail
  if (elements.filterRailBadge) {
    const count = getActiveFilterCount();
    if (count > 0) {
      elements.filterRailBadge.textContent = count > 9 ? '9+' : String(count);
      elements.filterRailBadge.classList.remove('hidden');
    } else {
      elements.filterRailBadge.classList.add('hidden');
    }
  }
}

function setSidebarOpen(open, { persist = true } = {}) {
  state.sidebarOpen = Boolean(open);
  renderSidebarState();

  if (persist) {
    saveUiPreferences();
  }
}

function sortIndicator(column) {
  if (state.sortBy !== column) {
    return '↕';
  }

  return state.sortDirection === 'asc' ? '↑' : '↓';
}

function defaultDirectionForColumn(column) {
  if (column === 'title' || column === 'category' || column === 'lastSeenAt') {
    return 'asc';
  }

  return 'desc';
}

function compareValues(left, right, type, direction) {
  const normalizedLeft = left == null ? null : left;
  const normalizedRight = right == null ? null : right;

  if (normalizedLeft == null && normalizedRight == null) {
    return 0;
  }

  if (normalizedLeft == null) {
    return 1;
  }

  if (normalizedRight == null) {
    return -1;
  }

  let result = 0;

  if (type === 'text') {
    result = String(normalizedLeft).localeCompare(String(normalizedRight), 'sv-SE');
  } else {
    result = normalizedLeft - normalizedRight;
  }

  return direction === 'asc' ? result : -result;
}

function toTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function isNewProduct(product) {
  const firstSeenTimestamp = toTimestamp(product.firstSeenAt);

  if (firstSeenTimestamp == null) {
    return false;
  }

  const latestRunTimestamp = toTimestamp(state.latestRunStartedAt);

  if (latestRunTimestamp != null) {
    return firstSeenTimestamp >= latestRunTimestamp;
  }

  return Date.now() - firstSeenTimestamp <= NEW_PRODUCT_FALLBACK_WINDOW_MS;
}

function sortProducts(products) {
  const column = state.sortBy;
  const direction = state.sortDirection;

  return [...products].sort((left, right) => {
    let comparison = 0;

    switch (column) {
      case 'title':
      case 'category':
        comparison = compareValues(left[column], right[column], 'text', direction);
        break;
      case 'lastSeenAt':
        comparison = compareValues(toTimestamp(left.lastSeenAt), toTimestamp(right.lastSeenAt), 'number', direction);
        break;
      case 'currentPriceSek':
      case 'initialPriceSek':
      case 'discountSek':
      case 'discountPercent':
      default:
        comparison = compareValues(left[column], right[column], 'number', direction);
        break;
    }

    if (comparison !== 0) {
      return comparison;
    }

    return String(left.title ?? '').localeCompare(String(right.title ?? ''), 'sv-SE');
  });
}

function updateSort(column) {
  if (!column) {
    return;
  }

  if (state.sortBy === column) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortBy = column;
    state.sortDirection = defaultDirectionForColumn(column);
  }

  state.currentPage = 1; // reset to first page on sort change
  saveUiPreferences();
  loadDashboard().catch((error) => setNotice(error.message, 'error'));
}

function renderSortHeader(label, column) {
  const active = state.sortBy === column;
  const activeClass = active ? ' active' : '';

  return `
    <button type="button" class="sort-button${activeClass}" data-sort-key="${escapeHtml(column)}">
      <span>${escapeHtml(label)}</span>
      <span class="sort-indicator" aria-hidden="true">${sortIndicator(column)}</span>
    </button>
  `;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;

    try {
      const payload = await response.json();

      if (payload?.message) {
        message = payload.message;
      }
    } catch {
      // Ignore parsing errors for non-JSON responses.
    }

    throw new Error(message);
  }

  return response.json();
}

function buildProductsQueryString() {
  const params = new URLSearchParams();
  const minDiscountPercent = parsePositiveInteger(state.minDiscountPercent);
  const minPriceSek = parsePositiveInteger(state.minPriceSek);
  const maxPriceSek = parsePositiveInteger(state.maxPriceSek);

  if (state.search) {
    params.set('search', state.search);
  }

  if (state.category) {
    params.set('category', state.category);
  }

  if (state.store) {
    params.set('store', state.store);
  }

  if (state.favoritesOnly) {
    params.set('favoritesOnly', 'true');
  }

  if (state.discountedOnly) {
    params.set('discountedOnly', 'true');
  }

  if (state.newOnly) {
    params.set('newOnly', 'true');
  }

  if (state.referenceOnly) {
    params.set('referenceOnly', 'true');
  }

  if (minDiscountPercent) {
    params.set('minDiscountPercent', String(minDiscountPercent));
  }

  if (minPriceSek) {
    params.set('minPriceSek', String(minPriceSek));
  }

  if (maxPriceSek) {
    params.set('maxPriceSek', String(maxPriceSek));
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

function buildOutletProductsQuery() {
  const params = new URLSearchParams();
  const minDiscountPercent = parsePositiveInteger(state.minDiscountPercent);
  const minPriceSek = parsePositiveInteger(state.minPriceSek);
  const maxPriceSek = parsePositiveInteger(state.maxPriceSek);

  if (state.search) params.set('search', state.search);
  if (state.category) params.set('category', state.category);
  if (state.store) params.set('store', state.store);
  if (state.favoritesOnly) params.set('favoritesOnly', 'true');
  if (state.discountedOnly) params.set('discountedOnly', 'true');
  if (state.newOnly) params.set('newOnly', 'true');
  if (state.referenceOnly) params.set('referenceOnly', 'true');
  if (minDiscountPercent) params.set('minDiscountPercent', String(minDiscountPercent));
  if (minPriceSek) params.set('minPriceSek', String(minPriceSek));
  if (maxPriceSek) params.set('maxPriceSek', String(maxPriceSek));

  params.set('sortBy', state.sortBy);
  params.set('sortDir', state.sortDirection);
  params.set('page', String(state.currentPage));
  params.set('pageSize', String(state.pageSize));

  return `?${params.toString()}`;
}

function setNotice(message = '', variant = 'info') {
  elements.noticeBanner.textContent = message;
  elements.noticeBanner.className = message ? `notice ${variant}` : 'notice hidden';
}

function clearScanPoll() {
  if (scanPollTimer) {
    clearTimeout(scanPollTimer);
    scanPollTimer = null;
  }
}

function scheduleScanPoll(delay = 3000) {
  clearScanPoll();
  scanPollTimer = setTimeout(() => {
    scanPollTimer = null;
    pollScanStatus().catch((error) => {
      setNotice(error.message, 'error');
      elements.runSummary.textContent = error.message;
      scheduleScanPoll(4000);
    });
  }, delay);
}

function scheduleFilterApply(delay = 250) {
  if (filterApplyTimer) {
    clearTimeout(filterApplyTimer);
  }

  filterApplyTimer = setTimeout(() => {
    filterApplyTimer = null;
    loadDashboard().catch((error) => {
      setNotice(error.message, 'error');
      elements.runSummary.textContent = error.message;
    });
  }, delay);
}

function syncScanButton(status) {
  if (!status.isRunning) {
    elements.scanButton.disabled = false;
    elements.scanButton.textContent = 'Scan all';
    if (elements.cancelButton) {
      elements.cancelButton.classList.add('hidden');
      elements.cancelButton.disabled = false;
      elements.cancelButton.textContent = 'Cancel';
    }
    if (elements.scanProgressBar) elements.scanProgressBar.classList.add('hidden');
    return;
  }

  const progress = status.scanProgress ?? {};
  const total = Number(progress.totalSources ?? 0);
  const completed = Number(progress.completedSources ?? 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isCancelling = status.isCancelling;

  elements.scanButton.disabled = true;
  elements.scanButton.textContent = total ? `Scanning ${completed}/${total}` : 'Scanning...';

  if (elements.cancelButton) {
    elements.cancelButton.classList.remove('hidden');
    if (isCancelling) {
      elements.cancelButton.disabled = true;
      elements.cancelButton.textContent = 'Cancelling…';
    } else {
      elements.cancelButton.disabled = false;
      elements.cancelButton.textContent = 'Cancel';
    }
  }

  if (elements.scanProgressBar) {
    elements.scanProgressBar.classList.remove('hidden');
    elements.scanProgressBar.setAttribute('aria-valuenow', pct);
  }
  if (elements.scanProgressFill) {
    elements.scanProgressFill.style.width = `${pct}%`;
  }
}

function renderStats(status, response, categories) {
  const agg = response?.aggregates ?? {};
  const total = response?.total ?? 0;
  const discountedProducts = agg.discounted ?? 0;
  const matchedProducts = agg.matched ?? 0;
  const averageDiscountPercent = agg.avgDiscountPercent ?? null;

  const pills = [
    [status.counts.outletItems, 'tracked'],
    [total, 'filtered'],
    [matchedProducts, 'matched'],
    [discountedProducts, 'discounted'],
    [Number.isFinite(averageDiscountPercent) ? `${averageDiscountPercent}%` : '–', 'avg off'],
    [formatDate(status.lastRunCompletedAt), 'last scan']
  ];

  elements.statsGrid.innerHTML = pills
    .map(([value, label]) => `<span class="stat-pill"><strong>${escapeHtml(String(value))}</strong>&thinsp;${escapeHtml(label)}</span>`)
    .join('');
}

function renderSources(sources, isScanning, sourceProgress) {
  if (!elements.sourcesList || !sources?.length) return;

  elements.sourcesList.innerHTML = sources
    .filter((source) => source.enabled)
    .map((source) => {
      const sp = isScanning ? (sourceProgress?.[source.id] ?? { status: 'queued' }) : null;
      let statusLabel, statusExtra;
      if (sp) {
        if (sp.status === 'running') { statusLabel = 'scanning'; statusExtra = ''; }
        else if (sp.status === 'done') { statusLabel = 'done'; statusExtra = sp.count != null ? ` · ${sp.count}` : ''; }
        else if (sp.status === 'error') { statusLabel = 'error'; statusExtra = ''; }
        else if (sp.status === 'cooling-down') { statusLabel = 'cooling-down'; statusExtra = ''; }
        else { statusLabel = 'queued'; statusExtra = ''; }
      } else {
        statusLabel = source.status;
        statusExtra = '';
      }
      const relTime = formatRelativeTime(source.lastSuccessAt);
      const countText = !sp && source.lastCount != null ? ` · ${source.lastCount} items` : '';
      const lastScanLine = relTime ? `${relTime}${countText}` : 'Never scanned';
      const errorLine = !sp && source.lastError
        ? `<span class="source-error-meta">${escapeHtml(source.lastError)}</span>`
        : (sp?.status === 'error' && sp.message ? `<span class="source-error-meta">${escapeHtml(sp.message)}</span>` : '');
      const autoChecked = source.schedulerEnabled ? 'checked' : '';
      const autoTitle = source.schedulerEnabled ? 'Auto-scan enabled — click to disable' : 'Auto-scan disabled — click to enable';

      return `
        <div class="source-row${source.schedulerEnabled ? '' : ' source-auto-off'}">
          <div class="source-top">
            <span class="source-name">${escapeHtml(source.label)}</span>
            <div class="source-controls">
              <label class="source-auto-toggle" title="${autoTitle}">
                <input type="checkbox" class="source-scheduler-cb" data-source-id="${escapeHtml(source.id)}" ${autoChecked} />
                <span class="source-auto-knob"></span>
              </label>
              <button class="source-scan-btn" data-source-id="${escapeHtml(source.id)}" type="button"${isScanning ? ' disabled' : ''}>Scan</button>
            </div>
          </div>
          <div class="source-bottom">
            <span class="source-status ${escapeHtml(statusLabel)}">${escapeHtml(statusLabel)}${escapeHtml(statusExtra)}</span>
            <span class="source-meta">${escapeHtml(lastScanLine)}</span>
            ${errorLine}
          </div>
        </div>
      `;
    })
    .join('');

  // Per-source scan buttons
  for (const btn of elements.sourcesList.querySelectorAll('.source-scan-btn')) {
    btn.addEventListener('click', () => triggerSourceScan([btn.getAttribute('data-source-id')]));
  }

  // Auto-scan toggles
  for (const cb of elements.sourcesList.querySelectorAll('.source-scheduler-cb')) {
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
        console.error('Failed to toggle source', err);
      } finally {
        cb.disabled = false;
      }
    });
  }
}

async function triggerSourceScan(sourceIds = null) {
  try {
    const body = sourceIds ? { sourceIds } : {};
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      setNotice(data.message || 'Failed to start scan.', 'error');
      return;
    }

    setNotice(data.message || 'Scan started.', 'info');
    scheduleScanPoll(1500);
  } catch (error) {
    setNotice(error.message, 'error');
  }
}

function renderCategoryFilter(categories) {
  const hasCurrentCategory = categories.some((category) => category.key === state.category);

  if (state.category && !hasCurrentCategory) {
    state.category = '';
    saveUiPreferences();
  }

  const current = state.category;
  const options = ['<option value="">All categories</option>']
    .concat(
      categories.map((category) => {
        const selected = category.key === current ? ' selected' : '';
        return `<option value="${escapeHtml(category.key)}"${selected}>${escapeHtml(category.name)} (${category.count})</option>`;
      })
    )
    .join('');

  elements.categoryFilter.innerHTML = options;
}

function renderStoreFilter(sources) {
  if (!elements.storeFilter || !Array.isArray(sources)) return;

  const current = state.store;
  const options = ['<option value="">All stores</option>']
    .concat(
      sources.map((s) => {
        const selected = s.id === current ? ' selected' : '';
        return `<option value="${escapeHtml(s.id)}"${selected}>${escapeHtml(s.label)}</option>`;
      })
    )
    .join('');

  elements.storeFilter.innerHTML = options;
}

function renderActiveFilters() {
  const activeFilters = [];
  const minDiscount = parsePositiveInteger(state.minDiscountPercent);
  const minPrice = parsePositiveInteger(state.minPriceSek);
  const maxPrice = parsePositiveInteger(state.maxPriceSek);

  if (state.search) {
    activeFilters.push(`Search: ${state.search}`);
  }

  if (state.category) {
    const selectedCategory = state.categories.find((category) => category.key === state.category);
    activeFilters.push(`Category: ${selectedCategory?.name ?? state.category}`);
  }

  if (state.store) {
    const storeLabel = elements.storeFilter?.querySelector(`option[value="${CSS.escape(state.store)}"]`)?.textContent;
    activeFilters.push(`Store: ${storeLabel ?? state.store}`);
  }

  if (state.favoritesOnly) {
    activeFilters.push('Favorite categories');
  }

  if (state.discountedOnly) {
    activeFilters.push('Discounted only');
  }

  if (state.newOnly) {
    activeFilters.push('New products only');
  }

  if (state.referenceOnly) {
    activeFilters.push('Matched new price');
  }

  if (minDiscount) {
    activeFilters.push(`Min discount: ${minDiscount}%`);
  }

  if (minPrice) {
    activeFilters.push(`Min price: ${formatSek(minPrice)}`);
  }

  if (maxPrice) {
    activeFilters.push(`Max price: ${formatSek(maxPrice)}`);
  }

  if (!activeFilters.length) {
    elements.activeFilters.innerHTML = '<span class="muted-text">No active filters.</span>';
    renderFilterPresetButtons();
    renderSidebarState();
    return;
  }

  elements.activeFilters.innerHTML = activeFilters.map((label) => `<span class="filter-chip">${escapeHtml(label)}</span>`).join('');
  renderFilterPresetButtons();
  renderSidebarState();
}

function renderSchedulerStatus() {
  const targets = [elements.schedulerNextRun, elements.modalSchedulerStatus].filter(Boolean);
  if (!targets.length) return;

  const isDisabled = elements.schedulerEnabled.disabled || elements.schedulerInterval.disabled;

  let html;
  if (isDisabled) {
    html = '<span class="scheduler-next-run-unavailable">Scheduler unavailable</span>';
  } else if (!state.schedulerEnabled) {
    html = '<span class="scheduler-next-run-paused">⏸ Paused</span>';
  } else {
    const nextRunAt = state.schedulerNextRunAt
      ? `${formatCountdown(state.schedulerNextRunAt)} (${formatDate(state.schedulerNextRunAt)})`
      : 'Not scheduled';
    const windowStr = state.schedulerWindowEnabled
      ? `${state.schedulerWindowStart}–${state.schedulerWindowEnd} (${state.schedulerIsInActiveWindow ? '✅ in window' : '⏳ outside window'})`
      : 'All day';
    const dirtyBadge = state.schedulerFormDirty ? ' <span class="scheduler-dirty-badge">Unsaved</span>' : '';

    html =
      `<span class="scheduler-next-run-label">Next scan</span>` +
      `<span class="scheduler-next-run-time">${nextRunAt}${dirtyBadge}</span>` +
      `<span class="scheduler-next-run-window">${windowStr}</span>`;
  }

  for (const el of targets) {
    el.innerHTML = html;
  }
}

function syncSchedulerDirtyState() {
  if (
    elements.schedulerEnabled.disabled ||
    elements.schedulerInterval.disabled ||
    elements.schedulerWindowEnabled.disabled ||
    elements.schedulerWindowStart.disabled ||
    elements.schedulerWindowEnd.disabled
  ) {
    state.schedulerFormDirty = false;
    return;
  }

  const draftInterval = parsePositiveInteger(elements.schedulerInterval.value);
  const draftStart = parseTimeOfDay(elements.schedulerWindowStart.value);
  const draftEnd = parseTimeOfDay(elements.schedulerWindowEnd.value);
  state.schedulerFormDirty =
    elements.schedulerEnabled.checked !== state.schedulerEnabled ||
    draftInterval !== state.schedulerIntervalMinutes ||
    elements.schedulerWindowEnabled.checked !== state.schedulerWindowEnabled ||
    draftStart !== state.schedulerWindowStart ||
    draftEnd !== state.schedulerWindowEnd;
}

function renderScheduler(scheduler, options = {}) {
  if (!scheduler) {
    elements.schedulerEnabled.disabled = true;
    elements.schedulerInterval.disabled = true;
    elements.schedulerWindowEnabled.disabled = true;
    elements.schedulerWindowStart.disabled = true;
    elements.schedulerWindowEnd.disabled = true;
    state.schedulerFormDirty = false;
    renderSchedulerStatus();
    return;
  }

  const activeWindow = scheduler.activeWindow ?? {};
  state.schedulerEnabled = Boolean(scheduler.enabled);
  state.schedulerIntervalMinutes = Number.isFinite(scheduler.intervalMinutes) ? scheduler.intervalMinutes : 180;
  state.schedulerWindowEnabled = Boolean(activeWindow.enabled);
  state.schedulerWindowStart = parseTimeOfDay(activeWindow.startTime) ?? '07:00';
  state.schedulerWindowEnd = parseTimeOfDay(activeWindow.endTime) ?? '00:00';
  state.schedulerTimeZone = String(activeWindow.timeZone ?? 'Europe/Stockholm');
  state.schedulerIsInActiveWindow = scheduler.isInActiveWindow !== false;
  state.schedulerNextRunAt = scheduler.nextRunAt ?? null;

  elements.schedulerEnabled.disabled = false;
  elements.schedulerInterval.disabled = false;
  elements.schedulerWindowEnabled.disabled = false;
  elements.schedulerWindowStart.disabled = false;
  elements.schedulerWindowEnd.disabled = false;
  const intervalFocused = document.activeElement === elements.schedulerInterval;
  const windowStartFocused = document.activeElement === elements.schedulerWindowStart;
  const windowEndFocused = document.activeElement === elements.schedulerWindowEnd;
  const keepDraft = Boolean(options.preserveDraft) && (state.schedulerFormDirty || intervalFocused || windowStartFocused || windowEndFocused);

  if (!keepDraft) {
    elements.schedulerEnabled.checked = state.schedulerEnabled;
    elements.schedulerInterval.value = String(state.schedulerIntervalMinutes);
    elements.schedulerWindowEnabled.checked = state.schedulerWindowEnabled;
    elements.schedulerWindowStart.value = state.schedulerWindowStart;
    elements.schedulerWindowEnd.value = state.schedulerWindowEnd;
    state.schedulerFormDirty = false;
  } else {
    syncSchedulerDirtyState();
  }

  renderSchedulerStatus();
}

async function saveSchedulerSettings() {
  const intervalMinutes = parsePositiveInteger(elements.schedulerInterval.value);
  const startTime = parseTimeOfDay(elements.schedulerWindowStart.value);
  const endTime = parseTimeOfDay(elements.schedulerWindowEnd.value);

  if (!intervalMinutes) {
    throw new Error('Interval must be a positive number of minutes.');
  }

  if (!startTime || !endTime) {
    throw new Error('Start and end time must use HH:MM.');
  }

  const payload = await fetchJson('/api/scheduler', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      enabled: elements.schedulerEnabled.checked,
      intervalMinutes,
      activeWindow: {
        enabled: elements.schedulerWindowEnabled.checked,
        startTime,
        endTime,
        timeZone: 'Europe/Stockholm'
      }
    })
  });

  state.schedulerFormDirty = false;
  renderScheduler(payload);
}

async function saveFavoriteCategories(categories) {
  const payload = await fetchJson('/api/preferences/favorite-categories', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ categories })
  });

  state.favoriteCategories = payload.favoriteCategories ?? [];
}

function renderFavoriteChips() {
  if (!state.favoriteCategories.length) {
    elements.favoriteChips.innerHTML = '<p class="empty-state">No favorites selected yet. Add a few categories to focus your alerts.</p>';
    return;
  }

  elements.favoriteChips.innerHTML = state.favoriteCategories
    .map(
      (category) => `
        <button type="button" class="category-chip" data-remove-favorite="${escapeHtml(category)}">
          <span>★ ${escapeHtml(category)}</span>
          <span aria-hidden="true">×</span>
        </button>
      `
    )
    .join('');

  for (const button of elements.favoriteChips.querySelectorAll('button[data-remove-favorite]')) {
    button.addEventListener('click', async () => {
      const category = button.getAttribute('data-remove-favorite');
      const next = state.favoriteCategories.filter((entry) => entry !== category);

      try {
        await saveFavoriteCategories(next);
        await loadDashboard();
      } catch (error) {
        setNotice(error.message, 'error');
      }
    });
  }
}

function renderFavoritesEditor() {
  elements.favoritesCount.textContent = `${state.favoriteCategories.length} saved`;
  elements.toggleFavoritesEditor.textContent = state.favoritesEditorOpen ? 'Close' : 'Manage';
  elements.favoritesSearchInput.value = state.favoritesSearch;

  if (!state.favoritesEditorOpen) {
    elements.favoritesEditorWrap.classList.add('hidden');
    return;
  }

  elements.favoritesEditorWrap.classList.remove('hidden');

  if (!state.categories.length) {
    elements.favoritesEditor.innerHTML = '<p class="empty-state">No categories available yet. Run a scan first.</p>';
    return;
  }

  const favoriteSet = getFavoriteCategorySet();
  const query = state.favoritesSearch.trim().toLowerCase();
  const visibleCategories = state.categories.filter(
    (category) => !query || category.name.toLowerCase().includes(query) || category.key.includes(query)
  );

  if (!visibleCategories.length) {
    elements.favoritesEditor.innerHTML = '<p class="empty-state">No categories match your search.</p>';
    return;
  }

  elements.favoritesEditor.innerHTML = visibleCategories
    .map((category) => {
      const favorite = favoriteSet.has(category.key);
      const buttonClass = favorite ? 'favorite-button active' : 'favorite-button';
      const symbol = favorite ? '★' : '☆';

      return `
        <button type="button" class="${buttonClass}" data-favorite-category="${escapeHtml(category.name)}">
          <span class="favorite-symbol">${symbol}</span>
          <span>${escapeHtml(category.name)}</span>
          <span class="favorite-meta">${escapeHtml(category.count)}</span>
        </button>
      `;
    })
    .join('');

  for (const button of elements.favoritesEditor.querySelectorAll('button[data-favorite-category]')) {
    button.addEventListener('click', async () => {
      const category = button.getAttribute('data-favorite-category');
      const next = new Set(state.favoriteCategories.map((entry) => entry.trim()).filter(Boolean));

      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }

      try {
        await saveFavoriteCategories([...next]);
        await loadDashboard();
      } catch (error) {
        setNotice(error.message, 'error');
      }
    });
  }
}

function renderPagination(response) {
  const { page, totalPages, total, pageSize } = response;
  if (totalPages <= 1) return '';

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  // Build page number list with ellipses
  const pages = new Set([1, totalPages, page, page - 1, page + 1, page - 2, page + 2]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let buttons = '';
  let lastPage = 0;
  for (const p of sorted) {
    if (lastPage && p - lastPage > 1) buttons += `<span class="page-ellipsis">…</span>`;
    const active = p === page ? ' active' : '';
    buttons += `<button type="button" class="page-btn${active}" data-page="${p}" aria-label="Page ${p}"${p === page ? ' aria-current="page"' : ''}>${p}</button>`;
    lastPage = p;
  }

  return `
    <div class="pagination">
      <span class="pagination-info">Showing ${start}–${end} of ${total}</span>
      <div class="pagination-controls">
        <button type="button" class="page-btn page-nav" data-page="${page - 1}" aria-label="Previous page"${page <= 1 ? ' disabled' : ''}>‹</button>
        ${buttons}
        <button type="button" class="page-btn page-nav" data-page="${page + 1}" aria-label="Next page"${page >= totalPages ? ' disabled' : ''}>›</button>
      </div>
    </div>
  `;
}

function renderProducts(response) {
  const products = response?.items ?? [];
  const total = response?.total ?? products.length;

  elements.productsCount.textContent = `${total} results`;

  if (!total) {
    elements.productsTable.innerHTML = '<p class="empty-state">No outlet products match the current filters.</p>';
    return;
  }

  const favoriteSet = getFavoriteCategorySet();
  const rows = products
    .map((product) => {
      const categoryFavorite = favoriteSet.has(normalizeCategoryKey(product.category));
      const newProduct = isNewProduct(product);
      const dealClass = Number.isFinite(product.discountPercent) && product.discountPercent >= 30 ? 'deal-tag hot' : 'deal-tag';
      const dealLabel = Number.isFinite(product.discountPercent) && product.discountPercent > 0
        ? `${product.discountPercent}% off`
        : Number.isFinite(product.initialPriceSek) ? 'No discount' : 'No ref price';
      const rowClass = newProduct ? 'new-product-row' : '';
      const newBadge = newProduct ? '<span class="deal-tag new">New</span>' : '';
      const storeBadge = product.sourceLabel ? `<span class="store-badge">${escapeHtml(product.sourceLabel)}</span>` : '';

      const rowUrl = product.url ? escapeHtml(product.url) : '';
      const titleContent = rowUrl
        ? `<a href="${rowUrl}" target="_blank" rel="noreferrer" class="product-title-link">${escapeHtml(product.title)}<svg class="product-link-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`
        : `<strong>${escapeHtml(product.title)}</strong>`;
      return `
        <tr class="${rowClass}">
          <td data-label="Product">
            <div class="product-title">${titleContent}</div>
            <div class="meta-row">
              ${newBadge}
              ${storeBadge}
              <span class="${dealClass}">${escapeHtml(dealLabel)}</span>
            </div>
          </td>
          <td data-label="Category">
            <span class="category-pill">${categoryFavorite ? '★ ' : ''}${escapeHtml(product.category)}</span>
          </td>
          <td data-label="Price">${formatSek(product.currentPriceSek)}</td>
          <td data-label="New price">${Number.isFinite(product.initialPriceSek) ? formatSek(product.initialPriceSek) : '—'}</td>
          <td data-label="Discount">${Number.isFinite(product.discountSek) ? formatSek(product.discountSek) : 'n/a'}</td>
          <td data-label="Discount %">${Number.isFinite(product.discountPercent) ? `${product.discountPercent}%` : 'n/a'}</td>
          <td data-label="Last seen">${formatDate(product.lastSeenAt)}</td>
          <td data-label="Link" class="link-cell">${rowUrl ? `<a href="${rowUrl}" target="_blank" rel="noreferrer" class="row-link-icon" tabindex="-1" aria-label="Open ${escapeHtml(product.title)} in new tab" title="Open in new tab"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>` : ''}</td>
        </tr>
      `;
    })
    .join('');

  elements.productsTable.innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>${renderSortHeader('Product', 'title')}</th>
            <th>${renderSortHeader('Category', 'category')}</th>
            <th>${renderSortHeader('Price', 'currentPriceSek')}</th>
            <th>${renderSortHeader('New price', 'initialPriceSek')}</th>
            <th>${renderSortHeader('Discount', 'discountSek')}</th>
            <th>${renderSortHeader('Discount %', 'discountPercent')}</th>
            <th>${renderSortHeader('Last seen', 'lastSeenAt')}</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(response)}
  `;

  for (const sortButton of elements.productsTable.querySelectorAll('button[data-sort-key]')) {
    sortButton.addEventListener('click', () => {
      updateSort(sortButton.getAttribute('data-sort-key'));
    });
  }


  for (const pageButton of elements.productsTable.querySelectorAll('button[data-page]')) {
    pageButton.addEventListener('click', () => {
      const targetPage = Number(pageButton.getAttribute('data-page'));
      if (!Number.isFinite(targetPage) || targetPage < 1) return;
      state.currentPage = targetPage;
      loadDashboard().catch((error) => setNotice(error.message, 'error'));
    });
  }
}

function renderNotice(status, response) {
  if (status.isRunning) {
    // Progress bar handles the visual — just clear any stale notice
    setNotice('', '');
    return;
  }

  if (status.lastError) {
    setNotice(`Last scan error: ${status.lastError}`, 'error');
    return;
  }

  const total = response?.total ?? 0;
  const unmatched = response?.aggregates ? (total - (response.aggregates.matched ?? 0)) : 0;

  if (!total) {
    setNotice('No outlet products available for the selected filters. Run another scan or adjust filters.', 'warning');
    return;
  }

  const referenceNote = unmatched > 0 ? ` ${unmatched} products are still waiting for a non-outlet price match.` : '';
  setNotice(`Outlet products loaded.${referenceNote}`, 'info');
}

function applyCurrentFilterState() {
  state.search = elements.searchInput.value.trim();
  state.category = elements.categoryFilter.value;
  state.store = elements.storeFilter?.value ?? '';
  state.favoritesOnly = elements.favoritesOnly.checked;
  state.discountedOnly = elements.discountedOnly.checked;
  state.newOnly = elements.newOnly.checked;
  state.referenceOnly = elements.referenceOnly.checked;
  state.minDiscountPercent = elements.minDiscountFilter.value.trim();
  state.minPriceSek = elements.minPriceFilter?.value.trim() ?? '';
  state.maxPriceSek = elements.maxPriceFilter.value.trim();
  saveUiPreferences();
  renderFilterPresetButtons();
}

function resetFilters() {
  state.search = '';
  state.category = '';
  state.store = '';
  state.favoritesOnly = false;
  state.discountedOnly = false;
  state.newOnly = false;
  state.referenceOnly = false;
  state.minDiscountPercent = '';
  state.minPriceSek = '';
  state.maxPriceSek = '';

  elements.searchInput.value = '';
  elements.categoryFilter.value = '';
  if (elements.storeFilter) elements.storeFilter.value = '';
  elements.favoritesOnly.checked = false;
  elements.discountedOnly.checked = false;
  elements.newOnly.checked = false;
  elements.referenceOnly.checked = false;
  elements.minDiscountFilter.value = '';
  elements.minPriceFilter.value = '';
  elements.maxPriceFilter.value = '';
  saveUiPreferences();
  renderFilterPresetButtons();
}

async function loadDashboard() {
  const [status, categories, preferences, sources, outletSources] = await Promise.all([
    fetchJson('/api/status'),
    fetchJson('/api/outlet-categories'),
    fetchJson('/api/preferences'),
    fetchJson('/api/sources'),
    fetchJson('/api/outlet-sources')
  ]);

  state.latestRunStartedAt = status.lastRunSummary?.startedAt ?? status.lastRunStartedAt ?? null;
  state.favoriteCategories = preferences.favoriteCategories ?? [];
  state.categories = categories ?? [];

  if (state.category && !state.categories.some((category) => category.key === state.category)) {
    state.category = '';
    elements.categoryFilter.value = '';
    saveUiPreferences();
  }

  const query = buildOutletProductsQuery();
  const response = await fetchJson(`/api/outlet-products${query}`);
  latestProducts = response;

  syncScanButton(status);
  renderStats(status, response, categories);
  renderSources(sources, status.isRunning, status.scanProgress?.sourceProgress);
  renderCategoryFilter(categories);
  renderStoreFilter(outletSources ?? []);
  renderActiveFilters();
  renderScheduler(status.scheduler);
  renderFavoriteChips();
  renderFavoritesEditor();
  renderProducts(response);
  renderNotice(status, response);
  elements.runSummary.textContent = JSON.stringify(status.lastRunSummary ?? {}, null, 2);

  if (status.isRunning) {
    scheduleScanPoll();
  } else {
    clearScanPoll();
  }
}

async function pollScanStatus() {
  const [status, sources] = await Promise.all([
    fetchJson('/api/status'),
    fetchJson('/api/sources')
  ]);
  syncScanButton(status);
  renderSources(sources, status.isRunning, status.scanProgress?.sourceProgress);
  renderScheduler(status.scheduler, { preserveDraft: true });
  renderNotice(status, latestProducts);
  elements.runSummary.textContent = JSON.stringify(status.lastRunSummary ?? {}, null, 2);

  if (status.isRunning) {
    // Refresh the products table whenever a source finishes (completedSources ticks up)
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

function updateFilters({ debounce = false } = {}) {
  applyCurrentFilterState();
  state.currentPage = 1; // reset to first page on any filter change

  if (debounce) {
    scheduleFilterApply();
    return;
  }

  loadDashboard().catch((error) => {
    setNotice(error.message, 'error');
    elements.runSummary.textContent = error.message;
  });
}

elements.searchInput.addEventListener('input', () => updateFilters({ debounce: true }));
elements.categoryFilter.addEventListener('change', () => updateFilters());
elements.storeFilter?.addEventListener('change', () => updateFilters());
elements.favoritesOnly.addEventListener('change', () => updateFilters());
elements.discountedOnly.addEventListener('change', () => updateFilters());
elements.newOnly.addEventListener('change', () => updateFilters());
elements.referenceOnly.addEventListener('change', () => updateFilters());
elements.minDiscountFilter.addEventListener('input', () => updateFilters({ debounce: true }));
elements.minPriceFilter.addEventListener('input', () => updateFilters({ debounce: true }));
elements.maxPriceFilter.addEventListener('input', () => updateFilters({ debounce: true }));
elements.sidebarToggle.addEventListener('click', () => {
  setSidebarOpen(!state.sidebarOpen);
});
elements.sidebarClose.addEventListener('click', () => {
  setSidebarOpen(false);
});
elements.sidebarBackdrop.addEventListener('click', () => {
  setSidebarOpen(false);
});

// Icon rail buttons: expand sidebar and scroll to section
for (const btn of elements.railButtons) {
  btn.addEventListener('click', () => {
    const sectionId = btn.getAttribute('data-open-section');
    setSidebarOpen(true);
    if (sectionId) {
      // Wait for sidebar transition then scroll within the sidebar-scroll container
      setTimeout(() => {
        const scrollContainer = document.querySelector('.sidebar-scroll');
        const section = document.getElementById(sectionId);
        if (scrollContainer && section) {
          // Calculate position relative to the scroll container
          const containerRect = scrollContainer.getBoundingClientRect();
          const sectionRect = section.getBoundingClientRect();
          scrollContainer.scrollTop += sectionRect.top - containerRect.top - 8;
        }
      }, 230); // match sidebar transition duration
    }
  });
}
for (const button of elements.filterPresetButtons) {
  button.addEventListener('click', () => {
    applyFilterPreset(button.getAttribute('data-filter-preset'));
    loadDashboard().catch((error) => {
      setNotice(error.message, 'error');
      elements.runSummary.textContent = error.message;
    });
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.sidebarOpen) {
    setSidebarOpen(false);
  }
});

elements.clearFiltersButton.addEventListener('click', () => {
  resetFilters();
  loadDashboard().catch((error) => {
    setNotice(error.message, 'error');
    elements.runSummary.textContent = error.message;
  });
});

elements.toggleFavoritesEditor.addEventListener('click', () => {
  state.favoritesEditorOpen = !state.favoritesEditorOpen;
  saveUiPreferences();
  renderFavoritesEditor();
});

elements.favoritesSearchInput.addEventListener('input', () => {
  state.favoritesSearch = elements.favoritesSearchInput.value;
  saveUiPreferences();
  renderFavoritesEditor();
});

elements.refreshButton.addEventListener('click', () => {
  loadDashboard().catch((error) => {
    setNotice(error.message, 'error');
    elements.runSummary.textContent = error.message;
  });
});

elements.schedulerEnabled.addEventListener('change', () => {
  syncSchedulerDirtyState();
  renderSchedulerStatus();
});

elements.schedulerInterval.addEventListener('input', () => {
  syncSchedulerDirtyState();
  renderSchedulerStatus();
});

elements.schedulerWindowEnabled.addEventListener('change', () => {
  syncSchedulerDirtyState();
  renderSchedulerStatus();
});

elements.schedulerWindowStart.addEventListener('input', () => {
  syncSchedulerDirtyState();
  renderSchedulerStatus();
});

elements.schedulerWindowEnd.addEventListener('input', () => {
  syncSchedulerDirtyState();
  renderSchedulerStatus();
});

elements.scanButton.addEventListener('click', () => triggerSourceScan(null));

if (elements.cancelButton) {
  elements.cancelButton.addEventListener('click', async () => {
    elements.cancelButton.disabled = true;
    elements.cancelButton.textContent = 'Cancelling…';
    try {
      await fetch('/api/cancel', { method: 'POST' });
    } catch {
      // ignore — the next poll will reflect the final state
    }
  });
}

// "Scan all" button in the sidebar Sources section
if (elements.scanAllBtn) {
  elements.scanAllBtn.addEventListener('click', () => triggerSourceScan(null));

async function bulkToggleSources(enabled) {
  const sources = await fetchJson('/api/sources');
  const targets = sources.filter((s) => s.enabled && s.schedulerEnabled !== enabled);
  await Promise.all(targets.map((s) =>
    fetch(`/api/sources/${encodeURIComponent(s.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    })
  ));
  const updated = await fetchJson('/api/sources');
  renderSources(updated, false);
}

elements.sourcesAllOnBtn?.addEventListener('click', () => bulkToggleSources(true));
elements.sourcesAllOffBtn?.addEventListener('click', () => bulkToggleSources(false));
}

loadDashboard().catch((error) => {
  setNotice(error.message, 'error');
  elements.runSummary.textContent = error.message;
});

// ─────────────────────────────────────────────────────────
// NOTIFICATION SETTINGS MODAL
// ─────────────────────────────────────────────────────────

const notifModal = {
  overlay: document.querySelector('#notif-settings-modal'),
  closeBtn: document.querySelector('#notif-modal-close'),
  tabs: [...document.querySelectorAll('.modal-tab')],
  tabContents: { keywords: document.querySelector('#tab-keywords'), categories: document.querySelector('#tab-categories'), filters: document.querySelector('#tab-filters'), scheduler: document.querySelector('#tab-scheduler') },
  keywordWebhookInput: document.querySelector('#keyword-webhook-input'),
  newKeywordInput: document.querySelector('#new-keyword-input'),
  newKeywordCategory: document.querySelector('#new-keyword-category'),
  addKeywordBtn: document.querySelector('#add-keyword-btn'),
  keywordsList: document.querySelector('#keywords-list'),
  addCategoryBtn: document.querySelector('#add-category-btn'),
  categoriesList: document.querySelector('#categories-list'),
  saveBtn: document.querySelector('#save-notif-settings-btn'),
  saveStatus: document.querySelector('#notif-save-status'),
  openBtn: document.querySelector('#notif-settings-btn')
};

// In-memory settings state (loaded from API when modal opens)
let notifSettings = { keywordWebhook: '', keywords: [], categoryWebhooks: [] };

function renderKeywordsList() {
  notifModal.keywordsList.innerHTML = '';
  if (!notifSettings.keywords.length) {
    notifModal.keywordsList.innerHTML = '<li class="modal-empty">No keywords yet. Add one above.</li>';
    return;
  }
  for (const kw of notifSettings.keywords) {
    const li = document.createElement('li');
    li.className = 'modal-item';
    li.dataset.id = kw.id;
    const catPill = kw.category
      ? `<span class="kw-category-pill">${escapeHtml(kw.category)}</span>`
      : '';
    li.innerHTML = `
      <label class="modal-item-toggle">
        <input type="checkbox" class="kw-enabled" ${kw.enabled ? 'checked' : ''} />
        <span class="modal-item-label">${escapeHtml(kw.keyword)}${catPill}</span>
      </label>
      <button type="button" class="modal-item-remove" aria-label="Remove ${escapeHtml(kw.keyword)}">✕</button>
    `;
    li.querySelector('.kw-enabled').addEventListener('change', (e) => {
      kw.enabled = e.target.checked;
    });
    li.querySelector('.modal-item-remove').addEventListener('click', () => {
      notifSettings.keywords = notifSettings.keywords.filter((k) => k.id !== kw.id);
      renderKeywordsList();
    });
    notifModal.keywordsList.appendChild(li);
  }
}

function renderCategoryList() {
  notifModal.categoriesList.innerHTML = '';
  if (!notifSettings.categoryWebhooks.length) {
    notifModal.categoriesList.innerHTML = '<li class="modal-empty">No category mappings yet. Click "+ Add mapping" to create one.</li>';
    return;
  }
  for (const cw of notifSettings.categoryWebhooks) {
    const li = document.createElement('li');
    li.className = 'modal-item modal-item-category';
    li.dataset.id = cw.id;
    li.innerHTML = `
      <div class="modal-category-fields">
        <input type="text" class="modal-input modal-input-sm cw-pattern" placeholder="Category pattern (e.g. grafikkort)" value="${escapeHtml(cw.pattern)}" />
        <input type="text" class="modal-input modal-input-sm cw-label" placeholder="Label (e.g. GPU)" value="${escapeHtml(cw.label)}" />
        <input type="url" class="modal-input cw-webhook" placeholder="Discord webhook URL" value="${escapeHtml(cw.webhook)}" />
      </div>
      <button type="button" class="modal-item-remove" aria-label="Remove mapping">✕</button>
    `;
    li.querySelector('.cw-pattern').addEventListener('input', (e) => { cw.pattern = e.target.value; });
    li.querySelector('.cw-label').addEventListener('input', (e) => { cw.label = e.target.value; });
    li.querySelector('.cw-webhook').addEventListener('input', (e) => { cw.webhook = e.target.value; });
    li.querySelector('.modal-item-remove').addEventListener('click', () => {
      notifSettings.categoryWebhooks = notifSettings.categoryWebhooks.filter((c) => c.id !== cw.id);
      renderCategoryList();
    });
    notifModal.categoriesList.appendChild(li);
  }
}

async function openNotifModal() {
  try {
    const res = await fetch('/api/notification-settings');
    if (res.ok) notifSettings = await res.json();
  } catch {/* use in-memory defaults */}

  // Populate keyword category select from known outlet categories
  try {
    const cats = await fetchJson('/api/outlet-categories');
    if (notifModal.newKeywordCategory && Array.isArray(cats)) {
      const current = notifModal.newKeywordCategory.value;
      notifModal.newKeywordCategory.innerHTML = '<option value="">Any category</option>' +
        cats.map((c) => `<option value="${escapeHtml(c)}"${c === current ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
    }
  } catch { /* categories unavailable — select stays as "Any category" only */ }

  // populate keyword/category fields
  notifModal.keywordWebhookInput.value = notifSettings.keywordWebhook ?? '';
  renderKeywordsList();
  renderCategoryList();

  // Populate scheduler fields from scheduler endpoint
  try {
    const schedRes = await fetch('/api/scheduler');
    if (schedRes.ok) {
      const sched = await schedRes.json();
      renderScheduler(sched);
    }
  } catch (err) {
    // ignore scheduler fetch failures
  }

  // Populate scheduler-specific notification type checkboxes from saved notification settings
  const schedTypes = notifSettings.schedulerNotificationTypes ?? { favorites: true, keywords: true, categories: true };
  if (elements.notifyTypeFavorites) elements.notifyTypeFavorites.checked = Boolean(schedTypes.favorites);
  if (elements.notifyTypeKeywords) elements.notifyTypeKeywords.checked = Boolean(schedTypes.keywords);
  if (elements.notifyTypeCategories) elements.notifyTypeCategories.checked = Boolean(schedTypes.categories);

  notifModal.overlay.classList.remove('hidden');
  notifModal.saveStatus.textContent = '';
  document.body.style.overflow = 'hidden';
}

function closeNotifModal() {
  notifModal.overlay.classList.add('hidden');
  document.body.style.overflow = '';
}

// Tab switching
notifModal.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    notifModal.tabs.forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    Object.values(notifModal.tabContents).forEach((el) => el.classList.add('hidden'));
    notifModal.tabContents[tab.dataset.tab]?.classList.remove('hidden');
  });
});

// Add keyword
notifModal.addKeywordBtn.addEventListener('click', () => {
  const kw = notifModal.newKeywordInput.value.trim();
  if (!kw) return;
  const isDupe = notifSettings.keywords.some((k) => k.keyword.toLowerCase() === kw.toLowerCase());
  if (isDupe) { notifModal.newKeywordInput.classList.add('input-error'); return; }
  notifModal.newKeywordInput.classList.remove('input-error');
  const category = notifModal.newKeywordCategory?.value || '';
  const entry = { id: `kw-${Date.now()}`, keyword: kw, enabled: true };
  if (category) entry.category = category;
  notifSettings.keywords.push(entry);
  notifModal.newKeywordInput.value = '';
  if (notifModal.newKeywordCategory) notifModal.newKeywordCategory.value = '';
  renderKeywordsList();
});
notifModal.newKeywordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') notifModal.addKeywordBtn.click(); });

// Add category mapping
notifModal.addCategoryBtn.addEventListener('click', () => {
  notifSettings.categoryWebhooks.push({ id: `cw-${Date.now()}`, pattern: '', label: '', webhook: '' });
  renderCategoryList();
  // Scroll to bottom of list
  notifModal.categoriesList.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// Save settings
notifModal.saveBtn.addEventListener('click', async () => {
  // gather notification settings
  notifSettings.keywordWebhook = notifModal.keywordWebhookInput.value.trim();

  // include scheduler-driven notification choices
  notifSettings.schedulerNotificationTypes = {
    favorites: Boolean(elements.notifyTypeFavorites?.checked),
    keywords: Boolean(elements.notifyTypeKeywords?.checked),
    categories: Boolean(elements.notifyTypeCategories?.checked)
  };

  notifModal.saveBtn.disabled = true;
  notifModal.saveStatus.textContent = 'Saving…';
  try {
    const res = await fetch('/api/notification-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notifSettings)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notifSettings = await res.json();
    renderKeywordsList();
    renderCategoryList();

    // Persist scheduler settings as well
    try {
      await saveSchedulerSettings();
    } catch (err) {
      console.warn('[scheduler-save]', err.message);
    }

    notifModal.saveStatus.textContent = '✓ Saved';
    setTimeout(() => { notifModal.saveStatus.textContent = ''; }, 2500);
  } catch (err) {
    notifModal.saveStatus.textContent = `Error: ${err.message}`;
  } finally {
    notifModal.saveBtn.disabled = false;
  }
});

// Open / close
notifModal.openBtn.addEventListener('click', openNotifModal);
notifModal.closeBtn.addEventListener('click', closeNotifModal);
notifModal.overlay.addEventListener('click', (e) => { if (e.target === notifModal.overlay) closeNotifModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !notifModal.overlay.classList.contains('hidden')) closeNotifModal(); });

// Rail scheduler icon → open notification modal on the Scheduler tab
const railSchedulerBtn = document.querySelector('#rail-scheduler-btn');
if (railSchedulerBtn) {
  railSchedulerBtn.addEventListener('click', () => {
    notifModal.tabs.forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    const schedTab = notifModal.tabs.find((t) => t.dataset.tab === 'scheduler');
    if (schedTab) { schedTab.classList.add('active'); schedTab.setAttribute('aria-selected', 'true'); }
    Object.values(notifModal.tabContents).forEach((el) => el?.classList.add('hidden'));
    notifModal.tabContents.scheduler?.classList.remove('hidden');
    openNotifModal();
  });
}
