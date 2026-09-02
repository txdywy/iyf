/**
 * 韩剧 & 综艺推荐网站 - 前端应用
 */

(function () {
  'use strict';

  const DATA_URL = 'data/shows.json';
  const DATA_CACHE_VERSION = 2;
  const DATA_CACHE_KEY = `iyf:shows-cache:v${DATA_CACHE_VERSION}`;
  const DATA_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const DATA_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;
  const DATA_REQUEST_TIMEOUT_MS = 10000;
  const INITIAL_RENDER_COUNT = 24;
  const RENDER_BATCH_SIZE = 24;
  const VALID_TABS = new Set(['korean', 'year', 'varietyYear', 'variety', 'new', 'classic', 'tvmaze']);
  const TAB_ALIASES = Object.freeze({
    year2026: 'year',
    variety2026: 'varietyYear',
    // 已下线的快照链接回到主列表，避免旧书签落到空页面。
    trakt: 'korean',
    mdl: 'korean',
  });
  const REMOTE_CACHE_TTL_MS = 15 * 60 * 1000;
  const REMOTE_REQUEST_TIMEOUT_MS = 12000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DATA_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
  const DEFAULT_SORT_BY_TAB = { new: 'newest' };
  const VALID_FILTER_STATUS = new Set(['all', 'ongoing', 'complete']);
  const VALID_FILTER_SCORES = new Set(['0', '7', '8', '9']);
  const VALID_SORTS = new Set(['recommend', 'score', 'newest', 'popular']);
  const REMOTE_TAB_LABELS = { tvmaze: 'TVmaze 韩国电视剧时间表' };
  const REMOTE_LINK_HOSTS = Object.freeze({
    tvmaze: new Set(['www.tvmaze.com']),
    tvmazeImage: new Set(['static.tvmaze.com']),
  });
  const TVMAZE_TIME_ZONE = 'Asia/Seoul';
  let allData = null;
  let currentShows = [];
  let activeTabName = 'korean';
  const _tabSortPreferences = new Map();
  let _tabRequestVersion = 0;
  let _tabAbortController = null;
  let _isTabLoading = false;
  const _tabRequestTimeouts = new WeakMap();
  let _filteredShows = [];
  let _visibleShowCount = INITIAL_RENDER_COUNT;
  let _renderedShows = null;
  let _renderedShowCount = 0;
  let _loadMoreObserver = null;
  let _isLoadingMore = false;
  const AUTO_LOAD_ROOT_MARGIN = '0px 0px 480px 0px';


  // ── 初始化 ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindTabs();
    bindFilters();
    bindLoadMore();
    bindPosterFallbacks();
    window.addEventListener('popstate', handleUrlStateChange);
    window.addEventListener('hashchange', handleUrlStateChange);
    await loadData();
  }

  async function loadData() {
    const cached = readCachedData();
    const renderedFromCache = Boolean(cached);

    if (cached) {
      allData = cached.data;
      updateYearTabLabels();
      renderLoadedData({ animate: true });
      if (!REMOTE_TAB_LABELS[activeTabName]) updateInfo(' · 正在后台更新');
    } else {
      renderSkeletons();
    }

    try {
      // 保持稳定 URL，让浏览器用 ETag/Last-Modified 做条件请求。
      const resp = await fetchWithTimeout(DATA_URL, { cache: 'no-cache' }, DATA_REQUEST_TIMEOUT_MS);
      if (!resp.ok) throw new Error('Data not found');
      const data = await resp.json();
      if (!isShowDataset(data)) throw new Error('Invalid show data');
      allData = data;
      saveDataCache(data);
      updateYearTabLabels();
      if (!REMOTE_TAB_LABELS[activeTabName]) updateInfo();
      if (renderedFromCache) {
        // 后台更新不抢走用户已经切换到的标签或筛选状态。
        if (!REMOTE_TAB_LABELS[activeTabName]) {
          switchTab(activeTabName, { syncUrl: false, animate: false });
        }
      } else {
        renderLoadedData({ animate: true });
      }
    } catch (e) {
      if (renderedFromCache) {
        if (!REMOTE_TAB_LABELS[activeTabName]) updateInfo(' · 网络更新失败，展示本地缓存');
        return;
      }
      document.getElementById('loading').style.display = 'none';
      const grid = document.getElementById('showGrid');
      if (grid) {
        grid.innerHTML = '';
        grid.setAttribute('aria-busy', 'false');
      }
      setEmptyState('😢 暂无推荐数据。数据正在抓取中，请稍后刷新。', '刷新页面', () => location.reload());
      updateStats([]);
      const info = document.getElementById('updateInfo');
      if (info) info.textContent = '推荐数据加载失败，请重试';
    }
  }

  function renderLoadedData({ animate = true } = {}) {
    const urlState = readUrlState();
    restoreFilterControls(urlState);
    if (urlState.sort) _tabSortPreferences.set(urlState.tab, urlState.sort);
    switchTab(urlState.tab, { syncUrl: false, animate });
  }

  function readCachedData() {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(DATA_CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (cached?.version !== DATA_CACHE_VERSION) return null;
      const cachedAt = Number(cached?.cachedAt);
      const age = Date.now() - cachedAt;
      if (!Number.isFinite(cachedAt) || age > DATA_CACHE_MAX_AGE_MS || age < -DATA_CACHE_CLOCK_SKEW_MS) return null;
      if (!isShowDataset(cached?.data)) return null;
      return { data: cached.data, cachedAt };
    } catch {
      return null;
    }
  }

  function saveDataCache(data) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ version: DATA_CACHE_VERSION, cachedAt: Date.now(), data }));
    } catch {
      // 隐私模式或存储空间不足时，在线渲染仍应正常工作。
    }
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = DATA_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  function renderSkeletons(count = 6) {
    const grid = document.getElementById('showGrid');
    if (!grid) return;
    grid.setAttribute('aria-busy', 'true');
    grid.classList.remove('animate');
    grid.innerHTML = Array.from({ length: count }, () => `
      <article class="skeleton-card" aria-hidden="true">
        <div class="skeleton-poster skeleton-shimmer"></div>
        <div class="skeleton-body">
          <div class="skeleton-line skeleton-line-title skeleton-shimmer"></div>
          <div class="skeleton-line skeleton-line-short skeleton-shimmer"></div>
          <div class="skeleton-line skeleton-shimmer"></div>
          <div class="skeleton-line skeleton-line-medium skeleton-shimmer"></div>
        </div>
      </article>
    `).join('');
    updateLoadMore(0, 0);
    const loading = document.getElementById('loading');
    if (loading) loading.style.display = 'block';
  }

  function updateInfo(notice = '') {
    if (!allData) return;
    const el = document.getElementById('updateInfo');
    if (!el) return;
    const time = new Date(allData.lastUpdated);
    const timeStr = Number.isNaN(time.getTime()) ? '未知' : time.toLocaleString('zh-CN', { hour12: false });
    const freshness = getDataFreshness(allData.lastUpdated);
    const kr = allData.stats?.koreanDramas ?? (allData.koreanDramas || []).length;
    const vr = allData.stats?.chineseVariety ?? (allData.chineseVariety || []).length;
    const sourceNotice = allData.sourceStatus === 'degraded' ? ' · 数据源暂不可用，展示上一快照' : '';
    const freshnessNotice = freshness.label ? ` · ${freshness.label}` : '';
    const staleNotice = freshness.stale ? ' · 数据可能过期' : '';
    el.textContent = `最后更新: ${timeStr}${freshnessNotice} · 共 ${kr} 部韩剧 · ${vr} 档综艺${sourceNotice}${staleNotice}${notice}`;
  }

  function getDataFreshness(value, now = Date.now()) {
    const timestamp = new Date(value || 0).getTime();
    if (!Number.isFinite(timestamp)) return { label: '', stale: false };
    const age = now - timestamp;
    if (age < DAY_MS) return { label: age < 60 * 60 * 1000 ? '刚刚更新' : '今天更新', stale: false };
    const days = Math.floor(age / DAY_MS);
    return {
      label: days === 1 ? '昨天更新' : `约${days}天前更新`,
      stale: age >= DATA_STALE_AFTER_MS,
    };
  }

  function readUrlState() {
    const params = new URLSearchParams(location.search);
    const hashTab = location.hash.slice(1).split('?')[0];
    const status = params.get('status');
    const score = params.get('score');
    const sort = params.get('sort');
    return {
      tab: normalizeTabName(hashTab || activeTabName),
      status: VALID_FILTER_STATUS.has(status) ? status : 'all',
      score: VALID_FILTER_SCORES.has(score) ? score : '0',
      sort: VALID_SORTS.has(sort) ? sort : '',
      query: params.get('q') || '',
    };
  }

  function normalizeTabName(tab) {
    const normalized = TAB_ALIASES[tab] || tab;
    return VALID_TABS.has(normalized) ? normalized : 'korean';
  }

  function updateYearTabLabels() {
    const year = getCurrentDataYear();
    const yearLabel = document.getElementById('yearTabLabel');
    const varietyYearLabel = document.getElementById('varietyYearTabLabel');
    if (yearLabel) yearLabel.textContent = `${year} 新剧`;
    if (varietyYearLabel) varietyYearLabel.textContent = `${year} 新综艺`;
  }

  function restoreFilterControls(state) {
    const status = document.getElementById('filterStatus');
    const score = document.getElementById('filterScore');
    const sort = document.getElementById('sortBy');
    const search = document.getElementById('searchInput');
    if (status) status.value = state.status;
    if (score) score.value = state.score;
    if (sort) sort.value = state.sort || DEFAULT_SORT_BY_TAB[state.tab] || 'recommend';
    if (search) search.value = state.query;
    updateResetVisibility();
  }

  function syncUrlState() {
    const currentUrl = typeof location.href === 'string' && location.href
      ? location.href
      : `http://localhost/${location.hash || ''}`;
    const url = new URL(currentUrl);
    const status = document.getElementById('filterStatus')?.value || 'all';
    const score = document.getElementById('filterScore')?.value || '0';
    const sort = document.getElementById('sortBy')?.value || 'recommend';
    const query = document.getElementById('searchInput')?.value.trim() || '';
    if (status === 'all') url.searchParams.delete('status');
    else url.searchParams.set('status', status);
    if (score === '0') url.searchParams.delete('score');
    else url.searchParams.set('score', score);
    const defaultSort = DEFAULT_SORT_BY_TAB[activeTabName] || 'recommend';
    if (sort === defaultSort) url.searchParams.delete('sort');
    else url.searchParams.set('sort', sort);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    url.hash = activeTabName;
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function handleUrlStateChange() {
    const state = readUrlState();
    if (!allData) {
      restoreFilterControls(state);
      return;
    }
    _tabSortPreferences.set(state.tab, state.sort || DEFAULT_SORT_BY_TAB[state.tab] || 'recommend');
    if (state.tab !== activeTabName) {
      switchTab(state.tab, { syncUrl: false });
      restoreFilterControls(state);
      applyFilters();
    } else {
      restoreFilterControls(state);
      applyFilters();
    }
  }

  // ── 标签切换 ──────────────────────────────────────────
  function bindTabs() {
    const tabs = [...document.querySelectorAll('.tab')];
    tabs.forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
      btn.addEventListener('keydown', event => {
        const visibleTabs = [...document.querySelectorAll('.tab')].filter(tab => !tab.hidden);
        const index = visibleTabs.indexOf(btn);
        if (index < 0) return;
        let nextIndex = null;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % visibleTabs.length;
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = visibleTabs.length - 1;
        if (nextIndex == null) return;
        event.preventDefault();
        visibleTabs[nextIndex].focus();
        switchTab(visibleTabs[nextIndex].dataset.tab);
      });
    });
  }

  function switchTab(tab, { syncUrl = true, animate = true } = {}) {
    tab = normalizeTabName(tab);
    const requestVersion = cancelPendingTabRequest();
    const sortSelect = document.getElementById('sortBy');
    if (sortSelect?.value) _tabSortPreferences.set(activeTabName, sortSelect.value);
    activeTabName = tab;
    if (sortSelect) sortSelect.value = _tabSortPreferences.get(tab) || DEFAULT_SORT_BY_TAB[tab] || 'recommend';
    if (syncUrl) syncUrlState();
    let activeButton = null;
    document.querySelectorAll('.tab').forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.tabIndex = active ? 0 : -1;
      if (active) activeButton = b;
    });
    activeButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    document.getElementById('showGrid')?.setAttribute('aria-labelledby', `tab-${tab}`);

    if (!allData) return;
    if (REMOTE_TAB_LABELS[tab]) {
      const info = document.getElementById('updateInfo');
      if (info) info.textContent = `正在加载 ${REMOTE_TAB_LABELS[tab]}...`;
    } else {
      updateInfo();
    }
    let shows = [];
    switch (tab) {
      case 'korean':
        shows = allData.koreanDramas || [];
        break;
      case 'year':
        shows = (allData.koreanDramas || []).filter(s => s.year === getCurrentDataYear());
        break;
      case 'varietyYear':
        // 当年新综艺，经典节目统一放在“经典必看”标签中。
        shows = (allData.chineseVariety || []).filter(s => s.year === getCurrentDataYear());
        break;
      case 'variety':
        shows = allData.chineseVariety || [];
        break;
      case 'new':
        shows = [...(allData.koreanDramas || []), ...(allData.chineseVariety || [])]
          .filter(s => s.isNew === true)
          .sort((a, b) => getNewestSortTime(b) - getNewestSortTime(a));
        break;
      case 'classic':
        shows = [
          ...(allData.koreanDramas || []),
          ...(allData.chineseVariety || [])
        ].filter(s => s.isClassic === true);
        break;
      case 'tvmaze':
        return fetchAndRenderTVmaze(requestVersion);
    }

    currentShows = shows;
    applyFilters(animate);
  }

  // ── 筛选 ──────────────────────────────────────────
  function bindFilters() {
    const applyAndSync = () => {
      syncUrlState();
      applyFilters();
    };
    document.getElementById('filterStatus').addEventListener('change', applyAndSync);
    document.getElementById('filterScore').addEventListener('change', applyAndSync);
    document.getElementById('sortBy').addEventListener('change', applyAndSync);
    document.getElementById('searchInput').addEventListener('input', debounce(applyAndSync, 300));
    document.getElementById('resetFilters').addEventListener('click', () => {
      document.getElementById('filterStatus').value = 'all';
      document.getElementById('filterScore').value = '0';
      document.getElementById('sortBy').value = DEFAULT_SORT_BY_TAB[activeTabName] || 'recommend';
      document.getElementById('searchInput').value = '';
      syncUrlState();
      applyFilters();
    });

    const toggle = document.getElementById('filterToggle');
    const controls = document.getElementById('filterControls');
    toggle?.addEventListener('click', () => {
      const open = controls?.classList.toggle('is-open') ?? false;
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  function bindLoadMore() {
    const sentinel = document.getElementById('loadMore');
    if (!sentinel) return;

    if (typeof window === 'undefined') return;
    const loadMoreOptions = { rootMargin: AUTO_LOAD_ROOT_MARGIN, threshold: 0.01 };
    if (typeof window.IntersectionObserver === 'function') {
      _loadMoreObserver = new window.IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) loadMoreShows();
      }, loadMoreOptions);
      _loadMoreObserver.observe(sentinel);
      return;
    }

    // 极旧浏览器兜底：滚动监听节流到 100ms,避免每个滚动事件都触发重排。
    let scrollCheckTimer = 0;
    const checkPosition = () => {
      if (scrollCheckTimer) return;
      scrollCheckTimer = setTimeout(() => {
        scrollCheckTimer = 0;
        if (!sentinel.hidden && sentinel.getBoundingClientRect().top <= window.innerHeight + 480) loadMoreShows();
      }, 100);
    };
    window.addEventListener('scroll', checkPosition, { passive: true });
    window.addEventListener('resize', checkPosition, { passive: true });
    checkPosition();
  }

  function loadMoreShows() {
    if (_isLoadingMore || _visibleShowCount >= _filteredShows.length) return false;
    _isLoadingMore = true;
    try {
      _visibleShowCount = Math.min(_visibleShowCount + RENDER_BATCH_SIZE, _filteredShows.length);
      renderVisibleShows();
      updateResultSummary(_filteredShows.length, _visibleShowCount);
      return true;
    } finally {
      _isLoadingMore = false;
    }
  }

  function bindPosterFallbacks() {
    const grid = document.getElementById('showGrid');
    grid.addEventListener('error', event => {
      const image = event.target;
      if (!image || image.tagName !== 'IMG' || !image.closest('.card-poster')) return;
      const placeholder = document.createElement('div');
      placeholder.className = 'placeholder';
      placeholder.textContent = image.dataset.fallbackIcon || '🎬';
      image.replaceWith(placeholder);
    }, true);
  }

  function applyFilters(animate = false) {
    // 异步标签仍在加载时保留 loading 状态,避免筛选事件用旧数据覆盖新标签。
    if (_isTabLoading) return;
    let shows = [...currentShows];

    // 状态筛选
    const status = document.getElementById('filterStatus').value;
    if (status === 'ongoing') {
      shows = shows.filter(s => {
        const complete = isShowComplete(s);
        return !complete;
      });
    } else if (status === 'complete') {
      shows = shows.filter(s => {
        const complete = isShowComplete(s);
        return complete;
      });
    }

    // 评分筛选
    const minScore = parseFloat(document.getElementById('filterScore').value);
    if (minScore > 0) {
      shows = shows.filter(s => {
        const score = s.score ?? s.rating?.average ?? s.mdlRating ?? 0;
        return score >= minScore;
      });
    }

    // 搜索
    const query = document.getElementById('searchInput').value.trim().toLowerCase();
    if (query) {
      shows = shows.filter(s => {
        const titleMatches = toText(s.title).toLowerCase().includes(query);
        if (titleMatches) return true;
        return [
          s.titleCn,
          s.titleEn,
          s.originalTitle,
          s.name,
          s.actor,
          s.cast,
          s.contentType,
          s.network,
          Array.isArray(s.titleAliases) ? s.titleAliases.join(' ') : s.titleAliases,
          s.genres,
        ].some(value => toSearchText(value).toLowerCase().includes(query));
      });
    }

    // 排序
    const sort = document.getElementById('sortBy').value;
    switch (sort) {
      case 'recommend':
        shows.sort((a, b) => getShowNumber(b, 'recommend') - getShowNumber(a, 'recommend'));
        break;
      case 'score':
        shows.sort((a, b) => getShowNumber(b, 'score') - getShowNumber(a, 'score'));
        break;
      case 'newest':
        shows.sort((a, b) => getNewestSortTime(b) - getNewestSortTime(a));
        break;
      case 'popular':
        shows.sort((a, b) => getShowNumber(b, 'popular') - getShowNumber(a, 'popular'));
        break;
    }

    renderShows(shows, animate);
    updateStats(shows, animate);
  }

  // ── 渲染 ──────────────────────────────────────────
  function renderShows(shows, animate = false) {
    _filteredShows = Array.isArray(shows) ? shows : [];
    _visibleShowCount = Math.min(INITIAL_RENDER_COUNT, _filteredShows.length);
    renderVisibleShows(animate);
  }

  function renderVisibleShows(animate = false) {
    const grid = document.getElementById('showGrid');
    const loading = document.getElementById('loading');
    const shows = _filteredShows;
    if (!grid) return;

    if (loading) loading.style.display = 'none';
    if (grid) grid.setAttribute('aria-busy', 'false');

    if (!shows.length) {
      if (grid) grid.innerHTML = '';
      _renderedShows = null;
      _renderedShowCount = 0;
      updateLoadMore(0, 0);
      setEmptyState('😢 暂无符合当前条件的推荐');
      return;
    }

    clearEmptyState();
    // 仅在切换标签/首次加载时播放入场动画;筛选/搜索/排序时即时呈现,避免每次按键重放动画造成的抖动。
    grid.classList.toggle('animate', animate);

    const renderer = activeTabName === 'tvmaze' ? renderTVmazeCard : renderCard;

    const visibleShows = shows.slice(0, _visibleShowCount);
    const canAppend = !animate &&
      _renderedShows === shows &&
      _renderedShowCount > 0 &&
      _renderedShowCount < visibleShows.length &&
      grid.children?.length === _renderedShowCount &&
      typeof grid.insertAdjacentHTML === 'function';
    if (canAppend) {
      grid.insertAdjacentHTML('beforeend', visibleShows.slice(_renderedShowCount).map((show, i) => renderer(show, _renderedShowCount + i)).join(''));
    } else {
      grid.innerHTML = visibleShows.map((show, i) => renderer(show, i)).join('');
    }
    _renderedShows = shows;
    _renderedShowCount = visibleShows.length;
    updateLoadMore(visibleShows.length, shows.length);
  }

  function updateLoadMore(visibleCount, totalCount) {
    const sentinel = document.getElementById('loadMore');
    if (!sentinel) return;
    const remaining = Math.max(0, totalCount - visibleCount);
    sentinel.hidden = remaining === 0;
    sentinel.textContent = remaining ? `继续下滑自动加载（还有 ${remaining} 部）` : '已加载全部内容';
  }

  function renderCard(show, index) {
    const badges = [];
    const aiScore = normalizeAIScore(show.aiScore);
    const score = toFiniteNumber(show.score, NaN);
    if (Number.isFinite(aiScore)) badges.push(`<span class="badge badge-ai">🤖 ${escapeHtml(String(aiScore))}/100</span>`);
    if (Number.isFinite(score) && score > 0) badges.push(`<span class="badge badge-score">⭐ ${escapeHtml(String(show.score))}</span>`);
    if (show.isClassic) badges.push('<span class="badge badge-classic">经典</span>');
    if (show.isAutoDiscovered) badges.push('<span class="badge badge-discovered">新发现</span>');
    if (show.tmdbCoverPending === true) badges.push('<span class="badge badge-cover-pending">封面待升级</span>');
    if (show.year >= getCurrentDataYear()) badges.push('<span class="badge badge-new">新剧</span>');
    if (show.isComplete) badges.push('<span class="badge badge-complete">完结</span>');
    else if (show.isSerial) badges.push('<span class="badge badge-ongoing">连载</span>');

    const newBadge = show.isNew ? '<div class="card-new-badge">NEW</div>' : '';

    const posterContent = renderPoster(show.coverImg, show.title, index, '🎬');

    const statusText = show.isComplete
      ? (show.totalEpisodes ? `已完结 · ${show.totalEpisodes}集` : '已完结')
      : show.mediaType === '综艺'
        ? (show.updateStatus || show.updateMsg || '更新中')
        : show.currentEpisode
          ? `更新至第${show.currentEpisode}集${show.totalEpisodes ? ' / 共' + show.totalEpisodes + '集' : ''}`
          : show.updateStatus || '未知';

    const statusClass = show.isComplete ? '' : 'ongoing';

    const playCount = Math.max(0, toFiniteNumber(show.playCount));
    const viewsText = playCount > 10000
      ? (playCount / 10000).toFixed(1) + '万次播放'
      : playCount > 0
        ? playCount + '次播放'
        : '';

    const actors = toText(show.actor).split(',').filter(Boolean).slice(0, 3).join(' / ');

    const tags = [];
    if (show.regional) tags.push(`<span class="meta-tag region">${escapeHtml(show.regional)}</span>`);
    if (toText(show.contentType)) {
      toText(show.contentType).split(/[·/]/).slice(0, 3).forEach(g => {
        tags.push(`<span class="meta-tag">${escapeHtml(g.trim())}</span>`);
      });
    }
    if (show.lang && show.lang !== '国语' && show.lang !== '韩语') {
      tags.push(`<span class="meta-tag">${escapeHtml(show.lang)}</span>`);
    }

    const recommendWidth = getRecommendationWidth(show);

    const primaryAction = renderPrimaryAction(show);
    const secondaryActions = renderSecondaryActions(show, primaryAction?.url || '');

    return `
      <article class="show-card" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster">
          ${posterContent}
          ${newBadge}
          <div class="card-badges">${badges.join('')}</div>
        </div>
        <div class="card-body">
          <div class="recommend-bar" style="width:${recommendWidth}%" role="img" aria-label="相对推荐度 ${recommendWidth}%"></div>
          <h3 class="card-title">${escapeHtml(show.title)}</h3>
          <div class="card-meta">${tags.join('')}</div>
          ${primaryAction ? `<div class="card-primary-action">${primaryAction.html}</div>` : ''}
          ${actors ? `<div class="card-actors">🎭 ${escapeHtml(actors)}</div>` : ''}
          <p class="card-desc">${escapeHtml(show.description || '')}</p>
          ${show.aiReason ? `<p class="card-ai-reason">🤖 AI推荐: ${escapeHtml(show.aiReason)}</p>` : ''}
          <div class="card-footer">
            <span class="card-status ${statusClass}">${escapeHtml(statusText)}</span>
            ${viewsText ? `<span class="card-views">👁 ${viewsText}</span>` : ''}
          </div>
          <div class="card-actions">
            ${secondaryActions}
          </div>
        </div>
      </article>
    `;
  }

  function renderPrimaryAction(show) {
    const yfspUrl = safeExternalUrl(show.yfspUrl || (show.primaryUrlSource === 'yfsp' ? show.primaryUrl : ''));
    const primaryUrl = yfspUrl || safeExternalUrl(show.primaryUrl) || safeExternalUrl(show.tmdbUrl) || safeExternalUrl(show.doubanUrl);
    if (!primaryUrl) return null;
    const label = yfspUrl ? '观看 / 详情' : '查看资料';
    return {
      url: primaryUrl,
      html: `<a class="card-action primary" href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    };
  }

  function renderSecondaryActions(show, primaryUrl) {
    const actions = [];
    addExternalAction(actions, show.tmdbUrl, 'source-tmdb', 'TMDB', primaryUrl);
    addExternalAction(actions, show.doubanUrl, 'source-douban', '豆瓣', primaryUrl);
    addExternalAction(actions, show.wikipediaUrl, 'source-wikipedia', 'Wiki', primaryUrl);
    addExternalAction(actions, show.imdbUrl, 'source-imdb', 'IMDb', primaryUrl);
    if (!actions.length) actions.push('<span class="card-action disabled" aria-disabled="true">暂无其他资料</span>');
    return actions.join('');
  }

  // 兼容旧版回归测试与内部调用方;页面渲染使用上面的分层操作布局。
  function renderCardActions(show) {
    const actions = [];
    const yfspUrl = safeExternalUrl(show.yfspUrl || (show.primaryUrlSource === 'yfsp' ? show.primaryUrl : ''));
    addExternalAction(actions, yfspUrl, 'source-yfsp', '观看/详情');
    addExternalAction(actions, show.tmdbUrl, 'source-tmdb', 'TMDB资料');
    addExternalAction(actions, show.doubanUrl, 'source-douban', '豆瓣资料');
    addExternalAction(actions, show.wikipediaUrl, 'source-wikipedia', 'Wikipedia');
    addExternalAction(actions, show.imdbUrl, 'source-imdb', 'IMDb资料');
    if (!yfspUrl && actions.length) actions.push('<span class="card-action disabled">暂无观看链接</span>');
    if (!actions.length) actions.push('<span class="card-action disabled">待匹配链接</span>');
    return actions.join('');
  }

  function addExternalAction(actions, url, sourceClass, label, excludeUrl = '') {
    const safeUrl = safeExternalUrl(url);
    if (!safeUrl || safeUrl === excludeUrl) return;
    actions.push(`<a class="card-action ${sourceClass}" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  }

  function setEmptyState(message, actionLabel = '', action = null) {
    const empty = document.getElementById('empty');
    const messageElement = document.getElementById('emptyMessage');
    const actionElement = document.getElementById('emptyAction');
    if (messageElement) messageElement.textContent = message;
    if (actionElement) {
      actionElement.textContent = actionLabel;
      actionElement.hidden = typeof action !== 'function';
      actionElement.onclick = typeof action === 'function' ? action : null;
    }
    if (empty) empty.style.display = 'block';
  }

  function clearEmptyState() {
    const empty = document.getElementById('empty');
    const actionElement = document.getElementById('emptyAction');
    if (empty) empty.style.display = 'none';
    if (actionElement) {
      actionElement.hidden = true;
      actionElement.onclick = null;
    }
  }

  function updateResetVisibility() {
    const button = document.getElementById('resetFilters');
    if (!button) return;
    const status = document.getElementById('filterStatus')?.value || 'all';
    const score = document.getElementById('filterScore')?.value || '0';
    const sort = document.getElementById('sortBy')?.value || 'recommend';
    const query = document.getElementById('searchInput')?.value.trim() || '';
    const defaultSort = DEFAULT_SORT_BY_TAB[activeTabName] || 'recommend';
    button.hidden = status === 'all' && score === '0' && sort === defaultSort && !query;
  }

  function updateResultSummary(total, visibleTotal = total) {
    const summary = document.getElementById('resultSummary');
    if (!summary) return;
    if (!total) {
      summary.textContent = '没有符合当前筛选条件的内容';
      return;
    }
    const activeFilters = [];
    const status = document.getElementById('filterStatus')?.value;
    const score = document.getElementById('filterScore')?.value;
    const query = document.getElementById('searchInput')?.value.trim();
    if (status === 'ongoing') activeFilters.push('连载中');
    if (status === 'complete') activeFilters.push('已完结');
    if (score && score !== '0') activeFilters.push(`${score}分以上`);
    if (query) activeFilters.push(`搜索“${query}”`);
    const suffix = activeFilters.length ? ` · ${activeFilters.join(' · ')}` : '';
    const countText = visibleTotal < total ? `显示 ${visibleTotal} / ${total} 个推荐结果` : `显示 ${total} 个推荐结果`;
    summary.textContent = `${countText}${suffix}`;
  }

  function updateStats(shows, animate = false) {
    const total = shows.length;
    const ongoing = shows.filter(s => {
      const complete = isShowComplete(s);
      return !complete;
    }).length;
    const complete = shows.filter(s => {
      const complete = isShowComplete(s);
      return complete;
    }).length;
    const highScore = shows.filter(s => {
      const score = s.score ?? s.rating?.average ?? s.mdlRating ?? 0;
      return score >= 8;
    }).length;

    const updateNumber = animate ? animateNum : setStatNumber;
    updateNumber('statTotal', total);
    updateNumber('statOngoing', ongoing);
    updateNumber('statComplete', complete);
    updateNumber('statHighScore', highScore);
    updateResultSummary(total, Math.min(_visibleShowCount, total));
    updateResetVisibility();
  }

  function resetStats() {
    for (const [id, timer] of _numTimers) {
      clearInterval(timer);
      _numTimers.delete(id);
    }
    ['statTotal', 'statOngoing', 'statComplete', 'statHighScore'].forEach(id => {
      const element = document.getElementById(id);
      if (element) element.textContent = '0';
    });
    updateResultSummary(0);
    updateResetVisibility();
  }

  const _numTimers = new Map();

  function setStatNumber(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    if (_numTimers.has(id)) {
      clearInterval(_numTimers.get(id));
      _numTimers.delete(id);
    }
    el.textContent = target;
  }

  function isShowComplete(show) {
    if (typeof show?.isComplete === 'boolean') return show.isComplete;
    return ['ended', 'canceled', 'cancelled'].includes(toText(show?.status).toLowerCase());
  }

  function animateNum(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;

    // 清理该元素上一次未完成的动画,避免多个 setInterval 叠加导致数字闪烁
    if (_numTimers.has(id)) clearInterval(_numTimers.get(id));

    const prefersReducedMotion = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      el.textContent = target;
      _numTimers.delete(id);
      return;
    }

    const diff = target - current;
    const steps = Math.min(Math.abs(diff), 20);
    const step = diff / steps;
    let i = 0;

    const timer = setInterval(() => {
      i++;
      el.textContent = Math.round(current + step * i);
      if (i >= steps) {
        el.textContent = target;
        clearInterval(timer);
        _numTimers.delete(id);
      }
    }, 30);
    _numTimers.set(id, timer);
  }

  // ── 工具函数 ──────────────────────────────────────
  function getCurrentDataYear() {
    const clientYear = new Date().getFullYear();
    const updatedYear = new Date(allData?.lastUpdated || 0).getFullYear();
    const preferredYear = updatedYear >= 1900 && updatedYear <= clientYear ? updatedYear : clientYear;
    const allShows = [...(allData?.koreanDramas || []), ...(allData?.chineseVariety || [])];
    if (allShows.some(show => toFiniteNumber(show?.year) === preferredYear)) {
      return preferredYear;
    }
    // 数据跨年暂未更新时回退到不晚于客户端年份的最新可用年份；待播预告不能劫持整页。
    const fallbackYear = allShows.reduce((max, s) => {
      const year = toFiniteNumber(s?.year);
      return year >= 1900 && year <= clientYear ? Math.max(max, year) : max;
    }, 0);
    return fallbackYear || clientYear;
  }

  function getValidTime(value) {
    const year = toFiniteNumber(value, NaN);
    if (Number.isInteger(year) && year >= 1900 && year <= 2200) return Date.UTC(year, 0, 1);
    const time = new Date(value || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function getNewestSortTime(show) {
    const value = activeTabName === 'new'
      ? (show?.firstSeenAt || show?.scrapedAt || show?.publishTime || show?.airDate || show?.year)
      : (show?.publishTime || show?.airDate || show?.year);
    return getValidTime(value);
  }

  function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function toText(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }

  function toSearchText(value) {
    if (Array.isArray(value)) return value.map(toSearchText).join(' ');
    return toText(value);
  }

  function getShowNumber(show, kind) {
    const candidates = kind === 'recommend'
      ? [show?.recommendScore, show?.mdlRating, show?.rating?.average]
      : kind === 'score'
        ? [show?.score, show?.rating?.average, show?.mdlRating]
        : [show?.playCount, show?.watchers];
    for (const value of candidates) {
      const number = toFiniteNumber(value, NaN);
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  function normalizeAIScore(value) {
    const score = toFiniteNumber(value, NaN);
    if (!Number.isFinite(score)) return NaN;
    // 旧版 AI 曾把 0-10 评分写入了 0-100 字段。兼容旧快照时按约定量纲修复。
    return score > 0 && score <= 10 ? Math.round(score * 10) : score;
  }

  function getRecommendationWidth(show) {
    const scores = currentShows
      .map(item => getShowNumber(item, 'recommend'))
      .filter(score => score > 0);
    const score = Math.max(0, getShowNumber(show, 'recommend'));
    const maximum = Math.max(1, ...scores, score);
    return Math.round(Math.max(0, Math.min(100, score / maximum * 100)));
  }

  function isShowDataset(value) {
    return !!value && typeof value === 'object' &&
      Array.isArray(value.koreanDramas) &&
      Array.isArray(value.chineseVariety) &&
      [...value.koreanDramas, ...value.chineseVariety].every(show => show && typeof show === 'object' && !Array.isArray(show));
  }

  function updateSourceInfo(label, value) {
    const element = document.getElementById('updateInfo');
    if (!element) return;
    if (!value) {
      element.textContent = `${label} · 时间未知`;
      return;
    }
    const time = new Date(value);
    element.textContent = Number.isNaN(time.getTime())
      ? `${label} · 时间未知`
      : `${label}: ${time.toLocaleDateString('zh-CN')}`;
  }

  // 文本与属性上下文均安全：textContent→innerHTML 不会转义引号,
  // 而本文件所有输出都插入到双引号属性内(src/href/alt),故需显式转义引号。
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
  }

  function safeExternalUrl(value, allowedHosts = null) {
    const url = String(value || '').trim();
    // 拒绝协议注入、属性逃逸、控制字符和含凭据 URL。
    if (!url || /["'<>\u0000-\u001F\u007F]/u.test(url)) return '';
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return '';
      if (allowedHosts && !allowedHosts.has(parsed.hostname.toLowerCase())) return '';
      return parsed.href;
    } catch {
      return '';
    }
  }

  function renderPoster(value, title, index, fallbackIcon) {
    const source = safeExternalUrl(value);
    if (!source) return `<div class="placeholder">${fallbackIcon}</div>`;

    const firstViewport = index < 2;
    let responsive = '';
    try {
      const parsed = new URL(source);
      if (parsed.hostname === 'image.tmdb.org' && /\/t\/p\/(?:original|w\d+)\//u.test(parsed.pathname)) {
        const path185 = parsed.pathname.replace(/\/t\/p\/(?:original|w\d+)\//u, '/t/p/w185/');
        const path342 = parsed.pathname.replace(/\/t\/p\/(?:original|w\d+)\//u, '/t/p/w342/');
        const path500 = parsed.pathname.replace(/\/t\/p\/(?:original|w\d+)\//u, '/t/p/w500/');
        const url185 = `${parsed.origin}${path185}${parsed.search}`;
        const url342 = `${parsed.origin}${path342}${parsed.search}`;
        const url500 = `${parsed.origin}${path500}${parsed.search}`;
        responsive = ` srcset="${escapeHtml(url185)} 185w, ${escapeHtml(url342)} 342w, ${escapeHtml(url500)} 500w" sizes="(max-width: 480px) 112px, (max-width: 768px) calc((100vw - 42px) / 2), 374px"`;
      }
    } catch {}

    return `<img src="${escapeHtml(source)}"${responsive} alt="${escapeHtml(title)}" loading="${firstViewport ? 'eager' : 'lazy'}"${firstViewport ? ' fetchpriority="high"' : ''} decoding="async" data-fallback-icon="${fallbackIcon}">`;
  }

  function cancelPendingTabRequest() {
    _tabRequestVersion++;
    _isTabLoading = false;
    if (_tabAbortController) {
      clearTimeout(_tabRequestTimeouts.get(_tabAbortController));
      _tabAbortController.abort();
    }
    _tabAbortController = null;
    return _tabRequestVersion;
  }

  function startRemoteTabRequest(requestVersion) {
    if (requestVersion !== _tabRequestVersion) return null;
    const controller = new AbortController();
    _tabRequestTimeouts.set(controller, setTimeout(() => controller.abort(), REMOTE_REQUEST_TIMEOUT_MS));
    _tabAbortController = controller;
    _isTabLoading = true;
    currentShows = [];
    _filteredShows = [];
    _visibleShowCount = INITIAL_RENDER_COUNT;
    resetStats();

    renderSkeletons(4);
    clearEmptyState();
    return controller;
  }

  function isActiveTabRequest(tab, requestVersion, controller) {
    return activeTabName === tab &&
      requestVersion === _tabRequestVersion &&
      controller === _tabAbortController;
  }

  function completeRemoteTab(tab, requestVersion, controller, shows) {
    if (!isActiveTabRequest(tab, requestVersion, controller)) return false;
    _isTabLoading = false;
    currentShows = Array.isArray(shows) ? shows : [];
    applyFilters(true);
    return true;
  }

  function showRemoteTabStaleFallback(tab, requestVersion, controller) {
    if (!isActiveTabRequest(tab, requestVersion, controller) || !Array.isArray(_tvmazeCache)) return false;
    _isTabLoading = false;
    currentShows = _tvmazeCache;
    applyFilters(true);
    updateSourceInfo(`${REMOTE_TAB_LABELS[tab]}（缓存可能已过期）`, new Date(_tvmazeCachedAt).toISOString());
    return true;
  }

  function showRemoteTabError(tab, requestVersion, controller, message) {
    if (!isActiveTabRequest(tab, requestVersion, controller)) return;
    _isTabLoading = false;
    const grid = document.getElementById('showGrid');
    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'false');
    document.getElementById('loading').style.display = 'none';
    currentShows = [];
    resetStats();
    const label = REMOTE_TAB_LABELS[tab] || '远程数据';
    const info = document.getElementById('updateInfo');
    if (info) info.textContent = `${label}加载失败，请重试`;
    setEmptyState(message, '重试', () => switchTab(tab));
  }

  function finishRemoteTabRequest(controller) {
    clearTimeout(_tabRequestTimeouts.get(controller));
    _tabRequestTimeouts.delete(controller);
    if (_tabAbortController === controller) _tabAbortController = null;
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ── 外部数据源: TVmaze 韩剧时间表 ─────────────────────────
  let _tvmazeCache = null;
  let _tvmazeCachedAt = 0;

  function getScheduleDateKey(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TVMAZE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function buildScheduleDateKeys(timestamp = Date.now(), days = 7) {
    const [year, month, day] = getScheduleDateKey(timestamp).split('-').map(Number);
    return Array.from({ length: days }, (_, index) =>
      new Date(Date.UTC(year, month - 1, day - index)).toISOString().slice(0, 10)
    );
  }

  function scheduleTimeInMinutes(value) {
    const match = toText(value).match(/^(\d{1,2}):(\d{2})/u);
    if (!match) return Number.POSITIVE_INFINITY;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
      ? hours * 60 + minutes
      : Number.POSITIVE_INFINITY;
  }

  function sortTVmazeShows(shows) {
    return [...shows].sort((a, b) => {
      const dateOrder = toText(b?.airDate).localeCompare(toText(a?.airDate));
      if (dateOrder) return dateOrder;
      const timeOrder = scheduleTimeInMinutes(a?.latestEpisode?.airtime) - scheduleTimeInMinutes(b?.latestEpisode?.airtime);
      if (timeOrder) return timeOrder;
      const ratingOrder = toFiniteNumber(b?.rating?.average) - toFiniteNumber(a?.rating?.average);
      if (ratingOrder) return ratingOrder;
      return toText(a?.name).localeCompare(toText(b?.name), 'zh-CN');
    });
  }

  function isTVmazeDrama(show) {
    const type = toText(show?.type).trim().toLowerCase();
    if (type) return type === 'scripted';
    return (Array.isArray(show?.genres) ? show.genres : [])
      .some(genre => toText(genre).trim().toLowerCase() === 'drama');
  }

  function formatScheduleDate(value) {
    const match = toText(value).match(/^\d{4}-(\d{2})-(\d{2})$/u);
    return match ? `${Number(match[1])}月${Number(match[2])}日` : '';
  }

  async function fetchAndRenderTVmaze(requestVersion) {
    const controller = startRemoteTabRequest(requestVersion);
    if (!controller) return;

    try {
      let shows = _tvmazeCache;
      if (!shows || Date.now() - _tvmazeCachedAt >= REMOTE_CACHE_TTL_MS) {
        // 以韩国本地日期为准；今天失败时继续回溯，避免单日故障让整个时间表变空。
        const showMap = new Map();
        const dates = buildScheduleDateKeys(Date.now());
        let successfulDays = 0;
        const fetchSchedule = async d => {
          const response = await fetch(`https://api.tvmaze.com/schedule?country=KR&date=${d}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`TVmaze HTTP ${response.status}`);
          const data = await response.json();
          if (!Array.isArray(data)) throw new Error('TVmaze returned invalid data');
          successfulDays++;
          return { date: d, data };
        };
        const addSchedule = ({ date, data }) => {
          for (const entry of data) {
            const show = entry?.show;
            if (!show?.id || !isTVmazeDrama(show) || showMap.has(show.id)) continue;
            showMap.set(show.id, { ...show, latestEpisode: entry, airDate: date });
          }
        };

        try {
          addSchedule(await fetchSchedule(dates[0]));
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
        }
        for (let start = 1; start < dates.length && showMap.size < 5; start += 2) {
          const batch = await Promise.all(dates.slice(start, start + 2).map(async d => {
            try {
              return await fetchSchedule(d);
            } catch (error) {
              if (error?.name === 'AbortError') throw error;
              return null;
            }
          }));
          batch.filter(Boolean).forEach(addSchedule);
        }
        if (!successfulDays) throw new Error('TVmaze schedule unavailable');
        shows = sortTVmazeShows([...showMap.values()]);
        _tvmazeCache = shows;
        _tvmazeCachedAt = Date.now();
      }

      if (!completeRemoteTab('tvmaze', requestVersion, controller, shows)) return;
      updateSourceInfo('TVmaze 韩剧时间表', new Date(_tvmazeCachedAt).toISOString());

      if (!shows.length) {
        setEmptyState('📡 今日暂无韩国电视剧播出');
      }
    } catch (e) {
      if (showRemoteTabStaleFallback('tvmaze', requestVersion, controller)) return;
      const message = e?.name === 'AbortError'
        ? '⌛ TVmaze 请求超时，请稍后重试'
        : '😢 TVmaze 数据加载失败，请稍后刷新';
      showRemoteTabError('tvmaze', requestVersion, controller, message);
    } finally {
      finishRemoteTabRequest(controller);
    }
  }

  function renderTVmazeCard(show, index) {
    const ep = show.latestEpisode;
    const epInfo = ep ? `S${ep.season}E${ep.number}` : '';
    const airtime = ep?.airtime || '';
    const airDate = formatScheduleDate(show.airDate);
    const network = show.network?.name || '';
    const genres = Array.isArray(show.genres) ? show.genres.slice(0, 3) : [];
    const rating = toFiniteNumber(show.rating?.average, NaN);
    const img = safeExternalUrl(show.image?.medium || show.image?.original || '', REMOTE_LINK_HOSTS.tvmazeImage);
    const showUrl = safeExternalUrl(show.url, REMOTE_LINK_HOSTS.tvmaze);
    const summary = toText(show.summary).replace(/<[^>]+>/g, '').slice(0, 120);
    const complete = isShowComplete(show);
    const statusText = complete ? '已完结' : show.status === 'Running' ? '连载中' : '待定/筹备';
    const posterContent = img
      ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(show.name)}" loading="lazy" decoding="async" data-fallback-icon="📺">`
      : '<div class="placeholder">📺</div>';

    return `
      <article class="show-card source-tvmaze" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster">${posterContent}</div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(show.name)}</h3>
          <div class="card-meta">
            ${network ? `<span class="meta-tag region">${escapeHtml(network)}</span>` : ''}
            ${genres.map(g => `<span class="meta-tag">${escapeHtml(g)}</span>`).join('')}
          </div>
          <div class="card-schedule">
            ${airDate ? `<span class="schedule-date">${escapeHtml(airDate)}</span>` : ''}
            ${epInfo ? `<span class="schedule-ep">${escapeHtml(epInfo)}</span>` : ''}
            ${airtime ? `<span class="schedule-time">🕐 ${escapeHtml(airtime)}</span>` : ''}
            ${Number.isFinite(rating) ? `<span class="schedule-rating">⭐ ${rating.toFixed(1)}</span>` : ''}
          </div>
          <p class="card-desc">${escapeHtml(summary)}</p>
          <div class="card-footer">
            <span class="card-status ${complete ? '' : 'ongoing'}">${statusText}</span>
            <span class="card-source-label">📡 TVmaze</span>
          </div>
          <div class="card-actions">
            ${showUrl ? `<a class="card-action source-tvmaze-link" href="${escapeHtml(showUrl)}" target="_blank" rel="noopener noreferrer">TVmaze 详情</a>` : ''}
            <a class="card-action source-tmdb" href="https://www.themoviedb.org/search?query=${encodeURIComponent(show.name)}" target="_blank" rel="noopener noreferrer">TMDB</a>
          </div>
        </div>
      </article>`;
  }

})();
