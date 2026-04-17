const sekFormatter = new Intl.NumberFormat('sv-SE', {
  style: 'currency',
  currency: 'SEK',
  maximumFractionDigits: 0
});

const state = {
  search: '',
  category: '',
  favoritesOnly: false,
  discountedOnly: false,
  referenceOnly: false,
  minDiscountPercent: '',
  maxPriceSek: '',
  favoriteCategories: [],
  categories: [],
  favoritesEditorOpen: false,
  favoritesSearch: '',
  sortBy: 'discountPercent',
  sortDirection: 'desc',
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

const UI_PREFERENCES_STORAGE_KEY = 'elgiganten-outlet-ui-preferences-v1';
const NEW_PRODUCT_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

const elements = {
  noticeBanner: document.querySelector('#notice-banner'),
  statsGrid: document.querySelector('#stats-grid'),
  runSummary: document.querySelector('#run-summary'),
  categoryFilter: document.querySelector('#category-filter'),
  searchInput: document.querySelector('#search-input'),
  favoritesOnly: document.querySelector('#favorites-only'),
  discountedOnly: document.querySelector('#discounted-only'),
  referenceOnly: document.querySelector('#reference-only'),
  minDiscountFilter: document.querySelector('#min-discount-filter'),
  maxPriceFilter: document.querySelector('#max-price-filter'),
  clearFiltersButton: document.querySelector('#clear-filters-button'),
  activeFilters: document.querySelector('#active-filters'),
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
  saveSchedulerButton: document.querySelector('#save-scheduler-button'),
  schedulerStatus: document.querySelector('#scheduler-status'),
  productsCount: document.querySelector('#products-count'),
  productsTable: document.querySelector('#products-table'),
  refreshButton: document.querySelector('#refresh-button'),
  scanButton: document.querySelector('#scan-button')
};

let scanPollTimer = null;
let filterApplyTimer = null;
let latestProducts = [];

function formatSek(value) {
  return Number.isFinite(value) ? sekFormatter.format(Math.round(value)) : 'n/a';
}

function formatDate(value) {
  if (!value) {
    return 'n/a';
  }

  return new Date(value).toLocaleString('sv-SE');
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
    favoritesOnly: state.favoritesOnly,
    discountedOnly: state.discountedOnly,
    referenceOnly: state.referenceOnly,
    minDiscountPercent: state.minDiscountPercent,
    maxPriceSek: state.maxPriceSek,
    favoritesEditorOpen: state.favoritesEditorOpen,
    favoritesSearch: state.favoritesSearch,
    sortBy: state.sortBy,
    sortDirection: state.sortDirection
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

  if (typeof saved.favoritesOnly === 'boolean') {
    state.favoritesOnly = saved.favoritesOnly;
  }

  if (typeof saved.discountedOnly === 'boolean') {
    state.discountedOnly = saved.discountedOnly;
  }

  if (typeof saved.referenceOnly === 'boolean') {
    state.referenceOnly = saved.referenceOnly;
  }

  if (typeof saved.minDiscountPercent === 'string') {
    state.minDiscountPercent = saved.minDiscountPercent;
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

  elements.searchInput.value = state.search;
  elements.favoritesOnly.checked = state.favoritesOnly;
  elements.discountedOnly.checked = state.discountedOnly;
  elements.referenceOnly.checked = state.referenceOnly;
  elements.minDiscountFilter.value = state.minDiscountPercent;
  elements.maxPriceFilter.value = state.maxPriceSek;
  elements.favoritesSearchInput.value = state.favoritesSearch;
}

function getFavoriteCategorySet() {
  return new Set(state.favoriteCategories.map((category) => normalizeCategoryKey(category)));
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

function updateSort(column, products) {
  if (!column) {
    return;
  }

  if (state.sortBy === column) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortBy = column;
    state.sortDirection = defaultDirectionForColumn(column);
  }

  saveUiPreferences();
  renderProducts(products);
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
  const maxPriceSek = parsePositiveInteger(state.maxPriceSek);

  if (state.search) {
    params.set('search', state.search);
  }

  if (state.category) {
    params.set('category', state.category);
  }

  if (state.favoritesOnly) {
    params.set('favoritesOnly', 'true');
  }

  if (state.discountedOnly) {
    params.set('discountedOnly', 'true');
  }

  if (state.referenceOnly) {
    params.set('referenceOnly', 'true');
  }

  if (minDiscountPercent) {
    params.set('minDiscountPercent', String(minDiscountPercent));
  }

  if (maxPriceSek) {
    params.set('maxPriceSek', String(maxPriceSek));
  }

  const query = params.toString();
  return query ? `?${query}` : '';
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
    elements.scanButton.textContent = 'Run scan';
    return;
  }

  const progress = status.scanProgress ?? {};
  const total = Number(progress.totalSources ?? 0);
  const completed = Number(progress.completedSources ?? 0);
  const activeStep = progress.currentSourceId ? Math.min(completed + 1, total || completed + 1) : completed;

  elements.scanButton.disabled = true;
  elements.scanButton.textContent = total ? `Scanning ${activeStep}/${total}` : 'Scanning...';
}

function renderStats(status, products, categories) {
  const discountedProducts = products.filter((product) => Number.isFinite(product.discountSek) && product.discountSek > 0).length;
  const matchedProducts = products.filter((product) => Number.isFinite(product.initialPriceSek)).length;
  const discountValues = products.map((product) => product.discountPercent).filter((value) => Number.isFinite(value));
  const averageDiscountPercent = discountValues.length
    ? Math.round(discountValues.reduce((sum, value) => sum + value, 0) / discountValues.length)
    : null;
  const cards = [
    ['Tracked outlet products', status.counts.outletItems],
    ['Shown in table', products.length],
    ['Matched new price', matchedProducts],
    ['Discounted products', discountedProducts],
    ['Avg discount', Number.isFinite(averageDiscountPercent) ? `${averageDiscountPercent}%` : 'n/a'],
    ['Favorite categories', state.favoriteCategories.length],
    ['Categories', categories.length],
    ['Last completed', formatDate(status.lastRunCompletedAt)]
  ];

  elements.statsGrid.innerHTML = cards
    .map(
      ([label, value]) => `
        <article class="stat-card">
          <span class="stat-label">${escapeHtml(label)}</span>
          <strong class="stat-value">${escapeHtml(value)}</strong>
        </article>
      `
    )
    .join('');
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

function renderActiveFilters() {
  const activeFilters = [];
  const minDiscount = parsePositiveInteger(state.minDiscountPercent);
  const maxPrice = parsePositiveInteger(state.maxPriceSek);

  if (state.search) {
    activeFilters.push(`Search: ${state.search}`);
  }

  if (state.category) {
    const selectedCategory = state.categories.find((category) => category.key === state.category);
    activeFilters.push(`Category: ${selectedCategory?.name ?? state.category}`);
  }

  if (state.favoritesOnly) {
    activeFilters.push('Favorite categories');
  }

  if (state.discountedOnly) {
    activeFilters.push('Discounted only');
  }

  if (state.referenceOnly) {
    activeFilters.push('Matched new price');
  }

  if (minDiscount) {
    activeFilters.push(`Min discount: ${minDiscount}%`);
  }

  if (maxPrice) {
    activeFilters.push(`Max price: ${formatSek(maxPrice)}`);
  }

  if (!activeFilters.length) {
    elements.activeFilters.innerHTML = '<span class="muted-inline">No active filters.</span>';
    return;
  }

  elements.activeFilters.innerHTML = activeFilters.map((label) => `<span class="filter-chip">${escapeHtml(label)}</span>`).join('');
}

function renderSchedulerStatus() {
  if (
    elements.schedulerEnabled.disabled ||
    elements.schedulerInterval.disabled ||
    elements.schedulerWindowEnabled.disabled ||
    elements.schedulerWindowStart.disabled ||
    elements.schedulerWindowEnd.disabled
  ) {
    elements.schedulerStatus.textContent = 'Unavailable';
    return;
  }

  const nextRunAt = state.schedulerNextRunAt ? formatDate(state.schedulerNextRunAt) : 'n/a';
  const scheduleStatus = state.schedulerEnabled ? `Next run: ${nextRunAt}` : 'Paused';
  const windowStatus = state.schedulerWindowEnabled
    ? `${state.schedulerWindowStart}-${state.schedulerWindowEnd} Sweden (${state.schedulerIsInActiveWindow ? 'inside window' : 'outside window'})`
    : 'All day (Sweden time)';
  const baseStatus = `${scheduleStatus} · ${windowStatus}`;
  elements.schedulerStatus.textContent = state.schedulerFormDirty ? `${baseStatus} · Unsaved changes` : baseStatus;
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
    elements.saveSchedulerButton.disabled = true;
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

  elements.saveSchedulerButton.disabled = false;

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

function renderProducts(products) {
  elements.productsCount.textContent = `${products.length} shown`;

  if (!products.length) {
    elements.productsTable.innerHTML = '<p class="empty-state">No outlet products match the current filters.</p>';
    return;
  }

  const favoriteSet = getFavoriteCategorySet();
  const sortedProducts = sortProducts(products);
  const rows = sortedProducts
    .map((product) => {
      const categoryFavorite = favoriteSet.has(normalizeCategoryKey(product.category));
      const newProduct = isNewProduct(product);
      const dealClass = Number.isFinite(product.discountPercent) && product.discountPercent >= 30 ? 'deal-tag hot' : 'deal-tag';
      const dealLabel = Number.isFinite(product.discountPercent) ? `${product.discountPercent}% off` : 'Awaiting match';
      const matchLabel = Number.isFinite(product.initialPriceSek) ? 'Matched new price' : 'Match pending';
      const rowClass = newProduct ? 'new-product-row' : '';
      const newBadge = newProduct ? '<span class="deal-tag new">New</span>' : '';

      return `
        <tr class="${rowClass}">
          <td>
            <div class="product-title">
              <strong>${escapeHtml(product.title)}</strong>
            </div>
            <div class="meta-row">
              ${newBadge}
              <span class="${dealClass}">${escapeHtml(dealLabel)}</span>
              <span class="meta">${escapeHtml(matchLabel)}</span>
            </div>
          </td>
          <td>
            <span class="category-pill">${categoryFavorite ? '★ ' : ''}${escapeHtml(product.category)}</span>
          </td>
          <td>${formatSek(product.currentPriceSek)}</td>
          <td>${Number.isFinite(product.initialPriceSek) ? formatSek(product.initialPriceSek) : 'match pending'}</td>
          <td>${Number.isFinite(product.discountSek) ? formatSek(product.discountSek) : 'n/a'}</td>
          <td>${Number.isFinite(product.discountPercent) ? `${product.discountPercent}%` : 'n/a'}</td>
          <td>${formatDate(product.lastSeenAt)}</td>
          <td><a href="${escapeHtml(product.url)}" target="_blank" rel="noreferrer">Open</a></td>
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
  `;

  for (const sortButton of elements.productsTable.querySelectorAll('button[data-sort-key]')) {
    sortButton.addEventListener('click', () => {
      updateSort(sortButton.getAttribute('data-sort-key'), products);
    });
  }
}

function renderNotice(status, products) {
  if (status.isRunning) {
    const progress = status.scanProgress ?? {};
    const total = Number(progress.totalSources ?? 0);
    const completed = Number(progress.completedSources ?? 0);
    const activeStep = progress.currentSourceId ? Math.min(completed + 1, total || completed + 1) : completed;
    const sourceText = progress.currentSourceLabel ? ` (${progress.currentSourceLabel})` : '';

    setNotice(`Scan running ${total ? `${activeStep}/${total}` : 'in progress'}${sourceText}.`, 'info');
    return;
  }

  if (status.lastError) {
    setNotice(`Last scan error: ${status.lastError}`, 'error');
    return;
  }

  if (!products.length) {
    setNotice('No outlet products available for the selected filters. Run another scan or adjust filters.', 'warning');
    return;
  }

  const missingReferenceCount = products.filter((product) => !Number.isFinite(product.initialPriceSek)).length;
  const referenceNote =
    missingReferenceCount > 0
      ? ` ${missingReferenceCount} products are still waiting for a non-outlet price match.`
      : '';

  setNotice(`Outlet products loaded.${referenceNote}`, 'info');
}

function applyCurrentFilterState() {
  state.search = elements.searchInput.value.trim();
  state.category = elements.categoryFilter.value;
  state.favoritesOnly = elements.favoritesOnly.checked;
  state.discountedOnly = elements.discountedOnly.checked;
  state.referenceOnly = elements.referenceOnly.checked;
  state.minDiscountPercent = elements.minDiscountFilter.value.trim();
  state.maxPriceSek = elements.maxPriceFilter.value.trim();
  saveUiPreferences();
}

function resetFilters() {
  state.search = '';
  state.category = '';
  state.favoritesOnly = false;
  state.discountedOnly = false;
  state.referenceOnly = false;
  state.minDiscountPercent = '';
  state.maxPriceSek = '';

  elements.searchInput.value = '';
  elements.categoryFilter.value = '';
  elements.favoritesOnly.checked = false;
  elements.discountedOnly.checked = false;
  elements.referenceOnly.checked = false;
  elements.minDiscountFilter.value = '';
  elements.maxPriceFilter.value = '';
  saveUiPreferences();
}

async function loadDashboard() {
  const [status, categories, preferences] = await Promise.all([
    fetchJson('/api/status'),
    fetchJson('/api/outlet-categories'),
    fetchJson('/api/preferences')
  ]);

  state.latestRunStartedAt = status.lastRunSummary?.startedAt ?? status.lastRunStartedAt ?? null;
  state.favoriteCategories = preferences.favoriteCategories ?? [];
  state.categories = categories ?? [];

  if (state.category && !state.categories.some((category) => category.key === state.category)) {
    state.category = '';
    elements.categoryFilter.value = '';
    saveUiPreferences();
  }

  const query = buildProductsQueryString();
  const products = await fetchJson(`/api/outlet-products${query}`);
  latestProducts = products;

  syncScanButton(status);
  renderStats(status, products, categories);
  renderCategoryFilter(categories);
  renderActiveFilters();
  renderScheduler(status.scheduler);
  renderFavoriteChips();
  renderFavoritesEditor();
  renderProducts(products);
  renderNotice(status, products);
  elements.runSummary.textContent = JSON.stringify(status.lastRunSummary ?? {}, null, 2);

  if (status.isRunning) {
    scheduleScanPoll();
  } else {
    clearScanPoll();
  }
}

async function pollScanStatus() {
  const status = await fetchJson('/api/status');
  syncScanButton(status);
  renderScheduler(status.scheduler, { preserveDraft: true });
  renderNotice(status, latestProducts);
  elements.runSummary.textContent = JSON.stringify(status.lastRunSummary ?? {}, null, 2);

  if (status.isRunning) {
    scheduleScanPoll();
    return;
  }

  await loadDashboard();
}

function updateFilters({ debounce = false } = {}) {
  applyCurrentFilterState();

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
elements.favoritesOnly.addEventListener('change', () => updateFilters());
elements.discountedOnly.addEventListener('change', () => updateFilters());
elements.referenceOnly.addEventListener('change', () => updateFilters());
elements.minDiscountFilter.addEventListener('input', () => updateFilters({ debounce: true }));
elements.maxPriceFilter.addEventListener('input', () => updateFilters({ debounce: true }));
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

elements.saveSchedulerButton.addEventListener('click', async () => {
  elements.saveSchedulerButton.disabled = true;

  try {
    await saveSchedulerSettings();
    setNotice('Scheduler settings saved.', 'info');
    await loadDashboard();
  } catch (error) {
    setNotice(error.message, 'error');
    elements.runSummary.textContent = error.message;
  } finally {
    elements.saveSchedulerButton.disabled = false;
  }
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

elements.scanButton.addEventListener('click', async () => {
  elements.scanButton.disabled = true;
  elements.scanButton.textContent = 'Starting...';

  try {
    const response = await fetchJson('/api/run', { method: 'POST' });
    setNotice(response.message ?? 'Live scan started.', 'info');
    await loadDashboard();
  } catch (error) {
    setNotice(error.message, 'error');
    elements.runSummary.textContent = error.message;
    elements.scanButton.disabled = false;
    elements.scanButton.textContent = 'Run scan';
  }
});

hydrateUiPreferences();

loadDashboard().catch((error) => {
  setNotice(error.message, 'error');
  elements.runSummary.textContent = error.message;
});
