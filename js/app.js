/**
 * 韩剧 & 综艺推荐网站 - 前端应用
 */

(function () {
  'use strict';

  const DATA_URL = 'data/shows.json';
  const DATA_CACHE_VERSION = 3;
  const DATA_CACHE_KEY = `iyf:shows-cache:v${DATA_CACHE_VERSION}`;
  const DATA_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const DATA_CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;
  // 内容未变的后台响应不必每次重写整份缓存；超过一天再刷新确认时间，保留过期判断的意义。
  const DATA_CACHE_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
  const DATA_REQUEST_TIMEOUT_MS = 10000;
  const INITIAL_RENDER_COUNT = 24;
  const RENDER_BATCH_SIZE = 24;
  const VALID_TABS = new Set(['korean', 'year', 'varietyYear', 'variety', 'new', 'classic', 'mine', 'tvmaze']);
  const TAB_ALIASES = Object.freeze({
    year2026: 'year',
    variety2026: 'varietyYear',
    // 已下线的快照链接回到主列表，避免旧书签落到空页面。
    trakt: 'korean',
    mdl: 'korean',
  });
  const REMOTE_CACHE_TTL_MS = 15 * 60 * 1000;
  const REMOTE_PARTIAL_CACHE_TTL_MS = 60 * 1000;
  const REMOTE_REQUEST_TIMEOUT_MS = 12000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DATA_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
  const DEFAULT_SORT_BY_TAB = { new: 'newest', tvmaze: 'newest' };
  const VALID_FILTER_STATUS = new Set(['all', 'ongoing', 'complete']);
  const VALID_FILTER_SCORES = new Set(['0', '7', '8', '9']);
  const VALID_SORTS = new Set(['recommend', 'score', 'newest', 'popular']);
  // 时间表没有播放量、完结筛选意义有限，也没有爱壹帆播放源；这些控件在该标签中隐藏。
  const TVMAZE_HIDDEN_SORTS = new Set(['popular']);
  const TVMAZE_HIDDEN_STATUS = new Set(['complete']);
  const YEAR_FILTERED_TABS = new Set(['year', 'varietyYear']);
  const AI_BADGE_MIN_SCORE = 70;
  // 最后一次实际观测超过 14 天的播放量已冻结，只能作为历史参考。
  const PLAY_COUNT_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
  // 简介超过约两行（窄屏）或三行（宽屏）时提供展开按钮，截断文字始终可读。
  const DESCRIPTION_TOGGLE_MIN_LENGTH = 28;
  const DESCRIPTION_WIDE_TOGGLE_MIN_LENGTH = 48;
  const REMOTE_TAB_LABELS = { tvmaze: 'TVmaze 韩国电视剧时间表' };
  const REMOTE_LINK_HOSTS = Object.freeze({
    tvmaze: new Set(['www.tvmaze.com']),
    tvmazeImage: new Set(['static.tvmaze.com']),
  });
  const TVMAZE_TIME_ZONE = 'Asia/Seoul';
  // “看过/想看”只存在本机浏览器；以片名+年份为键，来源 ID 变化后标记仍然有效。
  const MARKS_KEY = 'iyf:marks:v1';
  const MARKS_MAX_ENTRIES = 2000;
  const MARK_KINDS = ['want', 'seen'];
  const MARK_LABELS = { want: '想看', seen: '看过' };
  // 快捷类型标签：至少 3 部、且不超过当前分类一半（“剧情”“真人秀”这类几乎全选的类型没有筛选意义）。
  const QUICK_GENRE_MIN_COUNT = 3;
  const QUICK_GENRE_MAX_SHARE = 0.5;
  const QUICK_GENRE_LIMIT = 6;
  const GENRE_MAX_LENGTH = 12;
  const SEARCH_PLACEHOLDER = '搜索全部韩剧和综艺的剧名/演员…';
  const SEARCH_PLACEHOLDER_SCHEDULE = '搜索时间表中的剧名…';
  let allData = null;
  let _dataLoadFailed = false;
  let _dataLoadNotice = '';
  let _dataRequestVersion = 0;
  let currentShows = [];
  let activeTabName = 'korean';
  const _tabSortPreferences = new Map();
  let _tabRequestVersion = 0;
  let _tabAbortController = null;
  let _isTabLoading = false;
  let _tabLoadError = null;
  const _tabRequestTimeouts = new WeakMap();
  let _filteredShows = [];
  let _visibleShowCount = INITIAL_RENDER_COUNT;
  let _renderedShowItems = [];
  let _renderedContext = null;
  let _renderedShowCount = 0;
  let _loadMoreObserver = null;
  let _isLoadingMore = false;
  let _recommendationMaximum = 1;
  let _genreFilter = '';
  // 搜索跨全部分类时，来自当前标签之外的结果；卡片上标出所属分类。
  let _outsideShows = new Set();
  let _outsideResultCount = 0;
  let _marks = loadMarks();
  const AUTO_LOAD_ROOT_MARGIN = '0px 0px 480px 0px';


  // ── 初始化 ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindTabs();
    bindFilters();
    bindLoadMore();
    bindPosterFallbacks();
    bindCardActions();
    bindQuickFilters();
    bindContentNavigation();
    bindBackToTop();
    window.addEventListener('popstate', handleUrlStateChange);
    window.addEventListener('hashchange', handleUrlStateChange);
    // 时间表是独立来源，不应等待推荐 JSON 成功后才允许打开。
    renderLoadedData();
    await loadData();
  }

  async function loadData() {
    const requestVersion = ++_dataRequestVersion;
    const cached = readCachedData();
    let renderedFromCache = false;
    _dataLoadFailed = false;
    _dataLoadNotice = cached ? ' · 正在后台更新' : '';

    try {
      if (cached) {
        allData = cached.data;
        updateYearTabLabels();
        if (!REMOTE_TAB_LABELS[activeTabName]) switchTab(activeTabName, { syncUrl: false, animate: false, scrollToTab: false });
        if (!REMOTE_TAB_LABELS[activeTabName]) updateInfo();
        renderedFromCache = true;
      } else if (!REMOTE_TAB_LABELS[activeTabName]) {
        showDataLoading();
      }
    } catch {
      // 缓存绘制失败也要继续在线恢复，不能在发出请求前永久卡住重试。
      allData = null;
      _dataLoadNotice = '';
      if (!REMOTE_TAB_LABELS[activeTabName]) showDataLoading();
    }

    try {
      // 保持稳定 URL，让浏览器用 ETag/Last-Modified 做条件请求。
      const data = await fetchJSONWithTimeout(DATA_URL, { cache: 'no-cache' }, DATA_REQUEST_TIMEOUT_MS);
      if (requestVersion !== _dataRequestVersion) return;
      if (!isShowDataset(data)) throw new Error('Invalid show data');
      const unchanged = allData && JSON.stringify(data) === JSON.stringify(allData);
      // 内容相同的响应沿用原快照对象，后续筛选仍能保留已渲染卡片。
      allData = unchanged ? allData : data;
      _dataLoadFailed = false;
      _dataLoadNotice = '';
      updateYearTabLabels();
      if (!REMOTE_TAB_LABELS[activeTabName]) updateInfo();
      // 同一快照无需重建卡片，保留阅读位置与当前焦点；近期确认过的缓存也无需重写。
      if (unchanged && renderedFromCache) {
        if (!(Date.now() - cached.cachedAt < DATA_CACHE_REFRESH_AFTER_MS)) saveDataCache(data);
        return;
      }
      if (renderedFromCache) {
        // 后台更新不抢走用户已经切换到的标签或筛选状态。
        if (!REMOTE_TAB_LABELS[activeTabName]) {
          const readingState = captureReadingState();
          switchTab(activeTabName, { syncUrl: false, animate: false, preserveVisibleCount: true, scrollToTab: false });
          restoreReadingState(readingState);
        }
      } else if (!REMOTE_TAB_LABELS[activeTabName]) {
        switchTab(activeTabName, { syncUrl: false, animate: false, scrollToTab: false });
      }
      saveDataCache(data);
    } catch (e) {
      if (requestVersion !== _dataRequestVersion) return;
      if (renderedFromCache) {
        _dataLoadNotice = ' · 网络更新失败，展示本地缓存';
        if (!REMOTE_TAB_LABELS[activeTabName]) updateInfo();
        return;
      }
      _dataLoadFailed = true;
      if (REMOTE_TAB_LABELS[activeTabName]) return;
      showDataLoadError();
    }
  }

  function showDataLoadError() {
    document.getElementById('loading').style.display = 'none';
    const grid = document.getElementById('showGrid');
    if (grid) {
      resetRenderedShows();
      grid.innerHTML = '';
      grid.setAttribute('aria-busy', 'false');
    }
    updateLoadMore(0, 0);
    setEmptyState('😢 推荐数据加载失败，请检查网络后重试。', '重试', loadData);
    updateStats([]);
    const info = document.getElementById('updateInfo');
    if (info) info.textContent = '推荐数据加载失败，请重试';
  }

  function showDataLoading() {
    clearEmptyState();
    renderSkeletons();
    const info = document.getElementById('updateInfo');
    const summary = document.getElementById('resultSummary');
    if (info) info.textContent = '正在加载推荐数据…';
    if (summary) summary.textContent = '正在加载推荐数据…';
  }

  function renderLoadedData({ animate = true } = {}) {
    const urlState = readUrlState();
    restoreFilterControls(urlState);
    if (urlState.sort) _tabSortPreferences.set(urlState.tab, urlState.sort);
    switchTab(urlState.tab, { syncUrl: false, animate, rememberSort: false });
  }

  function captureReadingState() {
    const cards = [...(document.getElementById('showGrid')?.children || [])];
    const focused = document.activeElement;
    const focusedIndex = cards.findIndex(card => card === focused || card.contains?.(focused));
    const viewportTop = document.querySelector?.('.tabs')?.getBoundingClientRect?.().bottom || 0;
    const isVisible = card => {
      const rect = card.getBoundingClientRect?.();
      return rect && rect.bottom > viewportTop && rect.top < window.innerHeight;
    };
    const anchorIndex = focusedIndex >= 0 && isVisible(cards[focusedIndex])
      ? focusedIndex : cards.findIndex(isVisible);
    return {
      focusedIndex,
      focusedId: _filteredShows[focusedIndex]?.id,
      focusedHref: focused?.getAttribute?.('href') || '',
      loadMoreFocused: focused === document.getElementById('loadMoreButton'),
      anchorIndex,
      anchorId: _filteredShows[anchorIndex]?.id,
      anchorTop: cards[anchorIndex]?.getBoundingClientRect?.().top,
    };
  }

  function restoreReadingState(state) {
    const findIndex = (id, previousIndex) => {
      if (previousIndex < 0 || !_filteredShows.length) return -1;
      const index = _filteredShows.findIndex(show => show.id === id);
      return index >= 0 ? index : Math.min(previousIndex, _filteredShows.length - 1);
    };
    const focusedIndex = findIndex(state.focusedId, state.focusedIndex);
    const anchorIndex = findIndex(state.anchorId, state.anchorIndex);
    const neededCount = Math.max(focusedIndex, anchorIndex) + 1;
    if (neededCount > _visibleShowCount) {
      _visibleShowCount = neededCount;
      renderVisibleShows();
      updateResultSummary(_filteredShows.length, _visibleShowCount);
    }
    const cards = document.getElementById('showGrid')?.children || [];
    if (state.focusedIndex >= 0 || (state.loadMoreFocused && document.getElementById('loadMore')?.hidden)) {
      const card = cards[state.focusedIndex >= 0 ? focusedIndex : cards.length - 1];
      const link = card && [...card.querySelectorAll('a[href]')]
        .find(element => state.focusedHref && element.getAttribute('href') === state.focusedHref);
      const target = link || card || document.getElementById('mainContent');
      if (target) {
        if (!link) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }
    const anchorTop = cards[anchorIndex]?.getBoundingClientRect?.().top;
    if (Number.isFinite(anchorTop) && Number.isFinite(state.anchorTop)) {
      window.scrollBy?.(0, anchorTop - state.anchorTop);
    }
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

  async function fetchJSONWithTimeout(url, options = {}, timeoutMs = DATA_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error('Data not found');
      // 正文仍在传输时继续计时，避免只收到响应头后页面无限等待。
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function renderSkeletons(count = 6, label = '正在加载推荐数据...') {
    const grid = document.getElementById('showGrid');
    if (!grid) return;
    resetRenderedShows();
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
    const loadingText = loading?.querySelector?.('p');
    if (loadingText && loadingText.textContent !== label) loadingText.textContent = label;
    if (loading) loading.style.display = 'block';
  }

  function updateInfo(notice = _dataLoadNotice) {
    if (!allData) return;
    const el = document.getElementById('updateInfo');
    if (!el) return;
    const time = new Date(allData.lastUpdated);
    const timeStr = Number.isNaN(time.getTime()) ? '未知' : time.toLocaleString('zh-CN', { hour12: false });
    const freshness = getDataFreshness(allData.lastUpdated);
    const kr = allData.stats?.koreanDramas ?? (allData.koreanDramas || []).length;
    const vr = allData.stats?.chineseVariety ?? (allData.chineseVariety || []).length;
    const degraded = allData.sourceStatus === 'degraded';
    // 播放源降级时 lastUpdated 停在最近一次健康快照；新剧与 TMDB 资料仍按 generatedAt 刷新，分开说明以免误判整站停更。
    const generated = new Date(allData.generatedAt || 0);
    const refreshedSince = degraded && Number.isFinite(generated.getTime()) && generated.getTime() > time.getTime()
      ? getDataFreshness(allData.generatedAt) : null;
    const generatedStr = refreshedSince
      ? generated.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const sourceNotice = !degraded ? ''
      : refreshedSince ? ` · 爱壹帆播放源暂不可用，播放数据停在上述时间；新剧与资料更新于 ${generatedStr}`
        : ' · 数据源暂不可用，展示上一快照';
    const freshnessNotice = freshness.label ? ` · ${freshness.label}` : '';
    const staleNotice = freshness.stale && !(refreshedSince && !refreshedSince.stale) ? ' · 数据可能过期' : '';
    const text = `最后更新: ${timeStr}${freshnessNotice} · 共 ${kr} 部韩剧 · ${vr} 档综艺${sourceNotice}${staleNotice}${notice}`;
    // role=status 会朗读每次写入；内容未变时不重复播报。
    if (el.textContent !== text) el.textContent = text;
  }

  function getDataFreshness(value, now = Date.now()) {
    const timestamp = new Date(value || 0).getTime();
    if (!Number.isFinite(timestamp)) return { label: '', stale: false };
    const age = now - timestamp;
    if (age < 60 * 60 * 1000) return { label: '刚刚更新', stale: false };
    // “今天/昨天”按客户端日历计算，不能把跨午夜的昨晚更新当成今天。
    const updatedDate = new Date(timestamp);
    const currentDate = new Date(now);
    const calendarTime = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const calendarDays = Math.round((calendarTime(currentDate) - calendarTime(updatedDate)) / DAY_MS);
    const elapsedDays = Math.max(1, Math.floor(age / DAY_MS));
    return {
      label: calendarDays <= 0 ? '今天更新' : calendarDays === 1 ? '昨天更新' : `约${elapsedDays}天前更新`,
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
      // 旧书签没有该参数时保持不过滤。
      playable: params.get('playable') === '1',
      genre: normalizeGenre(params.get('genre')),
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
    const playable = document.getElementById('filterPlayable');
    if (status) status.value = state.status;
    if (score) score.value = state.score;
    if (sort) sort.value = state.sort || DEFAULT_SORT_BY_TAB[state.tab] || 'recommend';
    if (search) search.value = state.query;
    if (playable) playable.checked = state.playable === true;
    _genreFilter = normalizeGenre(state.genre);
    updateTabSpecificControls();
    updateResetVisibility();
  }

  // 读取筛选控件；时间表标签没有播放源，“只看可播放”在该标签中不生效。
  function readFilterState() {
    return {
      status: document.getElementById('filterStatus')?.value || 'all',
      score: document.getElementById('filterScore')?.value || '0',
      sort: document.getElementById('sortBy')?.value || 'recommend',
      query: document.getElementById('searchInput')?.value.trim() || '',
      playable: activeTabName !== 'tvmaze' && document.getElementById('filterPlayable')?.checked === true,
      // 类型与“隐藏看过”只作用于推荐标签；时间表没有这些信息。
      genre: activeTabName !== 'tvmaze' ? _genreFilter : '',
      hideSeen: activeTabName !== 'tvmaze' && _marks.hideSeen === true,
    };
  }

  function hasActiveResultFilters(state = readFilterState()) {
    return state.status !== 'all' || state.score !== '0' || !!state.query || state.playable || !!state.genre || state.hideSeen;
  }

  function normalizeGenre(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return Array.from(text).length <= GENRE_MAX_LENGTH && !/[<>"'&\u0000-\u001F]/u.test(text) ? text : '';
  }

  function getShowGenres(show) {
    return toText(show?.contentType).split(/[·/]/u).map(genre => genre.trim()).filter(Boolean);
  }

  // 隐藏与当前标签无关的排序/筛选选项；已选中的隐藏项回到该标签的默认值。
  function updateTabSpecificControls() {
    const isSchedule = activeTabName === 'tvmaze';
    const sort = document.getElementById('sortBy');
    const status = document.getElementById('filterStatus');
    for (const value of TVMAZE_HIDDEN_SORTS) {
      const option = sort?.querySelector?.(`option[value="${value}"]`);
      if (option) option.hidden = isSchedule;
    }
    for (const value of TVMAZE_HIDDEN_STATUS) {
      const option = status?.querySelector?.(`option[value="${value}"]`);
      if (option) option.hidden = isSchedule;
    }
    if (isSchedule && sort && TVMAZE_HIDDEN_SORTS.has(sort.value)) sort.value = DEFAULT_SORT_BY_TAB.tvmaze;
    if (isSchedule && status && TVMAZE_HIDDEN_STATUS.has(status.value)) status.value = 'all';
    const playableGroup = document.getElementById('playableFilterGroup');
    if (playableGroup) playableGroup.hidden = isSchedule;
    const search = document.getElementById('searchInput');
    const placeholder = isSchedule ? SEARCH_PLACEHOLDER_SCHEDULE : SEARCH_PLACEHOLDER;
    if (search && search.placeholder !== placeholder) {
      search.placeholder = placeholder;
      search.setAttribute?.('aria-label', placeholder.replace(/…$/u, ''));
    }
  }

  function syncUrlState({ push = false } = {}) {
    const currentUrl = typeof location.href === 'string' && location.href
      ? location.href
      : `http://localhost/${location.hash || ''}`;
    const url = new URL(currentUrl);
    const { status, score, sort, query } = readFilterState();
    // 时间表中隐藏的“只看可播放”仍保留在地址里，回到推荐标签时继续生效。
    const playable = document.getElementById('filterPlayable')?.checked === true;
    if (status === 'all') url.searchParams.delete('status');
    else url.searchParams.set('status', status);
    if (score === '0') url.searchParams.delete('score');
    else url.searchParams.set('score', score);
    const defaultSort = DEFAULT_SORT_BY_TAB[activeTabName] || 'recommend';
    if (sort === defaultSort) url.searchParams.delete('sort');
    else url.searchParams.set('sort', sort);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    if (playable) url.searchParams.set('playable', '1');
    else url.searchParams.delete('playable');
    if (_genreFilter) url.searchParams.set('genre', _genreFilter);
    else url.searchParams.delete('genre');
    url.hash = activeTabName;
    // 用户主动切换分类时留下历史记录，手机上的返回手势回到上一个分类而不是离开网站；
    // 筛选、搜索等连续输入只替换当前记录。
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (push && typeof history.pushState === 'function' && url.hash !== location.hash) history.pushState(null, '', target);
    else history.replaceState(null, '', target);
  }

  function handleUrlStateChange() {
    if (location.hash === '#mainContent') return;
    const state = readUrlState();
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

  function bindContentNavigation() {
    document.getElementById('skipLink')?.addEventListener('click', event => {
      const main = document.getElementById('mainContent');
      if (!main) return;
      event.preventDefault();
      main.focus({ preventScroll: true });
      main.scrollIntoView?.({ block: 'start' });
    });

    const tabs = document.querySelector?.('.tabs');
    if (!tabs) return;
    const updateTabsScrollOffset = () => {
      const height = tabs.getBoundingClientRect().height;
      if (Number.isFinite(height) && height > 0) {
        document.documentElement.style.setProperty('--tabs-scroll-offset', `${Math.ceil(height)}px`);
      }
    };
    // 导航在窄屏或字体缩放后会增高，跳转与原生焦点滚动都需避开其真实高度。
    updateTabsScrollOffset();
    if (typeof window.ResizeObserver === 'function') {
      const observer = new window.ResizeObserver(updateTabsScrollOffset);
      observer.observe(tabs);
    } else {
      window.addEventListener('resize', updateTabsScrollOffset, { passive: true });
    }
  }

  // ── 标签切换 ──────────────────────────────────────────
  function bindTabs() {
    const tabs = [...document.querySelectorAll('.tab')];
    tabs.forEach(btn => {
      btn.addEventListener('click', () => selectTabByUser(btn.dataset.tab));
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
        visibleTabs[nextIndex].focus({ preventScroll: true });
        selectTabByUser(visibleTabs[nextIndex].dataset.tab);
      });
    });
  }

  // 用户切换到另一个分类时从结果开头阅读；后台刷新和重复点击当前标签保持原阅读位置。
  function selectTabByUser(tab) {
    const changed = normalizeTabName(tab) !== activeTabName;
    if (!changed) return;
    switchTab(tab, { pushHistory: true });
    const main = document.getElementById('mainContent');
    const top = main?.getBoundingClientRect?.().top;
    const offset = parseFloat(window.getComputedStyle?.(document.documentElement)?.getPropertyValue?.('--tabs-scroll-offset')) || 0;
    if (Number.isFinite(top) && top < offset) main.scrollIntoView({ block: 'start' });
  }

  function revealTabHorizontally(button) {
    const container = button?.parentElement;
    if (!container) return;
    const viewport = container.getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    const style = window.getComputedStyle?.(container);
    const left = viewport.left + (parseFloat(style?.paddingLeft) || 0);
    const right = viewport.right - (parseFloat(style?.paddingRight) || 0);
    const offset = bounds.left < left ? bounds.left - left : bounds.right > right ? bounds.right - right : 0;
    // 只移动标签容器，避免 sticky 标签的 scrollIntoView 连带改变正文阅读位置。
    if (offset) container.scrollLeft += offset;
  }

  function switchTab(tab, { syncUrl = true, animate = true, rememberSort = true, preserveVisibleCount = false, scrollToTab = true, pushHistory = false } = {}) {
    tab = normalizeTabName(tab);
    const requestVersion = cancelPendingTabRequest();
    const sortSelect = document.getElementById('sortBy');
    if (rememberSort && sortSelect?.value) _tabSortPreferences.set(activeTabName, sortSelect.value);
    activeTabName = tab;
    if (sortSelect) sortSelect.value = _tabSortPreferences.get(tab) || DEFAULT_SORT_BY_TAB[tab] || 'recommend';
    updateTabSpecificControls();
    if (syncUrl) syncUrlState({ push: pushHistory });
    let activeButton = null;
    document.querySelectorAll('.tab').forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.tabIndex = active ? 0 : -1;
      if (active) activeButton = b;
    });
    if (scrollToTab) revealTabHorizontally(activeButton);
    document.getElementById('showGrid')?.setAttribute('aria-labelledby', `tab-${tab}`);

    const newestOption = sortSelect?.querySelector?.('option[value="newest"]');
    if (newestOption) newestOption.textContent = tab === 'tvmaze' ? '播出时间' : tab === 'new' ? '最近加入' : '最新发布';
    if (!allData && !REMOTE_TAB_LABELS[tab]) {
      currentShows = [];
      _filteredShows = [];
      _visibleShowCount = 0;
      resetStats();
      clearEmptyState();
      if (_dataLoadFailed) showDataLoadError();
      else showDataLoading();
      return;
    }
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
      case 'year': {
        const dataYear = getCurrentDataYear();
        shows = (allData.koreanDramas || []).filter(s => s.year === dataYear);
        break;
      }
      case 'varietyYear': {
        const dataYear = getCurrentDataYear();
        // 当年新综艺，经典节目统一放在“经典必看”标签中。
        shows = (allData.chineseVariety || []).filter(s => s.year === dataYear);
        break;
      }
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
      case 'mine':
        shows = getAllRecommendationShows().filter(show => getShowMark(show));
        break;
      case 'tvmaze':
        return fetchAndRenderTVmaze(requestVersion);
    }

    currentShows = shows;
    applyFilters(animate, { preserveVisibleCount });
  }

  // ── 筛选 ──────────────────────────────────────────
  const STAT_SHORTCUTS = {
    ongoing: { control: 'filterStatus', value: 'ongoing', off: 'all' },
    complete: { control: 'filterStatus', value: 'complete', off: 'all' },
    highScore: { control: 'filterScore', value: '8', off: '0' },
  };

  function updateStatShortcuts() {
    for (const button of document.querySelectorAll?.('[data-stat-filter]') || []) {
      const shortcut = STAT_SHORTCUTS[button.dataset.statFilter];
      const select = shortcut && document.getElementById(shortcut.control);
      button.setAttribute('aria-pressed', select?.value === shortcut?.value ? 'true' : 'false');
    }
  }

  // ── 回到顶部 ──────────────────────────────────────
  function bindBackToTop() {
    const button = document.getElementById('backToTop');
    if (!button) return;
    let scheduled = false;
    const update = () => {
      scheduled = false;
      const show = (window.scrollY || 0) > (window.innerHeight || 0) * 1.5;
      // 隐藏前先把焦点交给当前分类标签，避免焦点落在不可见按钮上。
      if (!show && document.activeElement === button) document.querySelector('.tab.active')?.focus({ preventScroll: true });
      button.hidden = !show;
    };
    window.addEventListener('scroll', () => {
      if (scheduled) return;
      scheduled = true;
      (window.requestAnimationFrame || setTimeout)(update);
    }, { passive: true });
    button.addEventListener('click', () => {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      document.querySelector('.tab.active')?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }

  function bindFilters() {
    const applyAndSync = () => {
      syncUrlState();
      applyFilters();
    };
    document.getElementById('filterStatus').addEventListener('change', applyAndSync);
    document.getElementById('filterScore').addEventListener('change', applyAndSync);
    document.getElementById('sortBy').addEventListener('change', applyAndSync);
    document.getElementById('filterPlayable')?.addEventListener('change', applyAndSync);
    // 统计数字兼作快捷筛选：再点一次取消。
    for (const button of document.querySelectorAll?.('[data-stat-filter]') || []) {
      button.addEventListener('click', () => {
        const shortcut = STAT_SHORTCUTS[button.dataset.statFilter];
        const select = shortcut && document.getElementById(shortcut.control);
        if (!select || select.querySelector?.(`option[value="${shortcut.value}"]`)?.hidden) return;
        select.value = select.value === shortcut.value ? shortcut.off : shortcut.value;
        applyAndSync();
      });
    }
    const searchInput = document.getElementById('searchInput');
    let isComposing = false;
    const debouncedSearch = debounce(() => {
      if (!isComposing) applyAndSync();
    }, 300);
    // 中文输入法组字期间的拼音字母不是查询词；组字结束后再筛选。
    searchInput.addEventListener('compositionstart', () => {
      isComposing = true;
      debouncedSearch.cancel();
    });
    searchInput.addEventListener('input', event => {
      if (!isComposing && !event?.isComposing) debouncedSearch();
    });
    searchInput.addEventListener('compositionend', () => {
      isComposing = false;
      debouncedSearch();
    });
    document.getElementById('resetFilters').addEventListener('click', () => resetFilters());

    const toggle = document.getElementById('filterToggle');
    const controls = document.getElementById('filterControls');
    toggle?.addEventListener('click', () => {
      const open = controls?.classList.toggle('is-open') ?? false;
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // 顶部“清除筛选”与空结果中的同名按钮共用；两者清除后都会隐藏，焦点回到搜索框。
  function resetFilters({ focusSearch = false } = {}) {
    const status = document.getElementById('filterStatus');
    const score = document.getElementById('filterScore');
    const sort = document.getElementById('sortBy');
    const search = document.getElementById('searchInput');
    const playable = document.getElementById('filterPlayable');
    if (status) status.value = 'all';
    if (score) score.value = '0';
    if (sort) sort.value = DEFAULT_SORT_BY_TAB[activeTabName] || 'recommend';
    if (playable) playable.checked = false;
    _genreFilter = '';
    if (_marks.hideSeen) {
      _marks.hideSeen = false;
      saveMarks();
    }
    if (search) {
      search.value = '';
      const focused = document.activeElement;
      if (focusSearch || focused === document.getElementById('resetFilters') || focused === document.getElementById('emptyAction')) {
        search.focus({ preventScroll: true });
      }
    }
    syncUrlState();
    applyFilters();
  }

  function bindLoadMore() {
    const sentinel = document.getElementById('loadMore');
    if (!sentinel) return;
    document.getElementById('loadMoreButton')?.addEventListener('click', () => loadMoreShows({ focusNew: true }));

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

  function loadMoreShows({ focusNew = false } = {}) {
    if (_isLoadingMore || _visibleShowCount >= _filteredShows.length) return false;
    _isLoadingMore = true;
    try {
      const firstNewIndex = _visibleShowCount;
      const loadMoreFocused = document.activeElement === document.getElementById('loadMoreButton');
      _visibleShowCount = Math.min(_visibleShowCount + RENDER_BATCH_SIZE, _filteredShows.length);
      renderVisibleShows();
      updateResultSummary(_filteredShows.length, _visibleShowCount);
      if (focusNew || (loadMoreFocused && document.getElementById('loadMore')?.hidden)) {
        // 手动加载或自动末批隐藏了当前获焦按钮时，继续从首个新增结果阅读。
        const card = document.getElementById('showGrid')?.children?.[firstNewIndex];
        if (card) {
          card.tabIndex = -1;
          card.focus({ preventScroll: true });
          card.scrollIntoView?.({ block: 'nearest' });
        }
      }
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

  // 卡片内按钮共用一个委托监听：“想看/看过”标记与简介展开。
  // 简介默认按行截断；按钮展开/收起同一段文字，读屏用户也能通过 aria-expanded 得知状态。
  function bindCardActions() {
    const grid = document.getElementById('showGrid');
    grid?.addEventListener('click', event => {
      const markButton = event?.target?.closest?.('.card-mark');
      if (markButton) {
        toggleCardMark(markButton);
        return;
      }
      const button = event?.target?.closest?.('.card-desc-toggle');
      if (!button) return;
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expanded));
      button.textContent = expanded ? '收起简介' : '展开简介';
      document.getElementById(button.getAttribute('aria-controls'))?.classList.toggle('is-expanded', expanded);
    });
  }

  function applyFilters(animate = false, { preserveVisibleCount = false } = {}) {
    // 异步标签仍在加载时保留 loading 状态,避免筛选事件用旧数据覆盖新标签。
    if (_isTabLoading) return;
    // 筛选只改变结果，不应清掉加载错误和恢复操作。
    if (_tabLoadError?.tab === activeTabName) {
      updateResetVisibility();
      return;
    }
    // 首次推荐数据未到达时，筛选只记录选择，保留骨架或失败状态。
    if (!allData && !REMOTE_TAB_LABELS[activeTabName]) {
      if (_dataLoadFailed) showDataLoadError();
      updateResetVisibility();
      return;
    }
    const filters = readFilterState();
    const minScore = parseFloat(filters.score);
    const query = filters.query.toLowerCase();
    const isSchedule = activeTabName === 'tvmaze';
    // 排序：主排序键相同时可播放的卡片优先，其余保持原有相对顺序。
    const byKey = key => (a, b) => (key(b) - key(a)) || (isShowPlayable(b) - isShowPlayable(a));

    const filterAndSort = source => {
      let shows = [...source];
      // 状态筛选
      if (filters.status === 'ongoing') shows = shows.filter(isShowOngoing);
      else if (filters.status === 'complete') shows = shows.filter(isShowComplete);
      // 评分筛选
      if (minScore > 0) shows = shows.filter(s => getShowNumber(s, 'score') >= minScore);
      // 只看可播放（时间表标签中不生效）
      if (filters.playable) shows = shows.filter(isShowPlayable);
      if (filters.genre) shows = shows.filter(s => getShowGenres(s).includes(filters.genre));
      if (filters.hideSeen) shows = shows.filter(s => getShowMark(s) !== 'seen');
      // 搜索
      if (query) {
        shows = shows.filter(s => {
          const titleMatches = toText(s.title).toLowerCase().includes(query);
          if (titleMatches) return true;
          return [
            s.name,
            s.actor,
            s.contentType,
            s.network?.name ?? s.network,
            Array.isArray(s.titleAliases) ? s.titleAliases.join(' ') : s.titleAliases,
            s.genres,
          ].some(value => toSearchText(value).toLowerCase().includes(query));
        });
      }
      switch (filters.sort) {
        case 'recommend':
          shows.sort(byKey(show => getShowNumber(show, 'recommend')));
          break;
        case 'score':
          shows.sort(byKey(show => getShowNumber(show, 'score')));
          break;
        case 'newest':
          shows = isSchedule ? sortTVmazeShows(shows) : shows.sort(byKey(getNewestSortTime));
          break;
        case 'popular':
          shows.sort(byKey(show => getShowNumber(show, 'popular')));
          break;
      }
      // 看过的沉到各自分组末尾，保持其余顺序。
      return isSchedule ? shows : [...shows.filter(s => getShowMark(s) !== 'seen'), ...shows.filter(s => getShowMark(s) === 'seen')];
    };

    let shows = filterAndSort(currentShows);
    // 搜索默认覆盖全部韩剧和综艺：当前分类的结果在前，其他分类的命中接在后面并标出分类。
    let outside = [];
    if (query && !isSchedule && allData) {
      const inTab = new Set(currentShows);
      outside = filterAndSort(getAllRecommendationShows().filter(show => !inTab.has(show)));
    }
    _outsideShows = new Set(outside);
    _outsideResultCount = outside.length;
    if (outside.length) shows = [...shows, ...outside];

    renderShows(shows, animate, { preserveVisibleCount });
    updateStats(shows, animate);
  }

  // ── 渲染 ──────────────────────────────────────────
  function resetRenderedShows() {
    _renderedShowItems = [];
    _renderedContext = null;
    _renderedShowCount = 0;
  }

  function renderShows(shows, animate = false, { preserveVisibleCount = false } = {}) {
    _filteredShows = Array.isArray(shows) ? shows : [];
    _visibleShowCount = Math.min(preserveVisibleCount ? Math.max(INITIAL_RENDER_COUNT, _visibleShowCount) : INITIAL_RENDER_COUNT, _filteredShows.length);
    _recommendationMaximum = currentShows.reduce((maximum, show) => Math.max(maximum, getShowNumber(show, 'recommend')), 1);
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
      resetRenderedShows();
      updateLoadMore(0, 0);
      // 由筛选造成的空结果直接提供清除操作，避免用户回到顶部寻找按钮。
      if (hasActiveResultFilters()) setEmptyState('😢 暂无符合当前条件的推荐', '清除筛选', () => resetFilters({ focusSearch: true }));
      else if (activeTabName === 'mine') setEmptyState('还没有标记节目。在任意卡片上点“想看”或“看过”，它们会出现在这里（只保存在这台设备的浏览器里）。');
      else setEmptyState('😢 暂无符合当前条件的推荐');
      return;
    }

    clearEmptyState();
    const dataYear = getCurrentDataYear();
    const referenceTime = getSnapshotTime();
    const renderer = activeTabName === 'tvmaze' ? renderTVmazeCard : renderCard;
    const visibleShows = shows.slice(0, _visibleShowCount);
    // 数据快照不可变。相同渲染上下文和对象前缀可保留已解码海报、焦点与卡片节点。
    // 新快照、年份、标签或推荐度基准变化都必须重新生成；骨架/错误也会显式失效。
    const canRetain = _renderedContext?.data === allData &&
      _renderedContext.tab === activeTabName &&
      _renderedContext.year === dataYear &&
      _renderedContext.maximum === _recommendationMaximum &&
      _renderedShowCount > 0 &&
      _renderedShowCount <= visibleShows.length &&
      grid.children?.length === _renderedShowCount &&
      _renderedShowItems.every((show, index) => show === visibleShows[index]);
    if (canRetain && _renderedShowCount === visibleShows.length) {
      updateLoadMore(visibleShows.length, shows.length);
      return;
    }

    // 仅新卡片播放入场动画；结果不变时不重播，筛选/搜索/排序即时呈现。
    grid.classList.toggle('animate', animate);
    const canAppend = canRetain && !animate &&
      _renderedShowCount < visibleShows.length &&
      typeof grid.insertAdjacentHTML === 'function';
    if (canAppend) {
      grid.insertAdjacentHTML('beforeend', visibleShows.slice(_renderedShowCount).map((show, i) => renderer(show, _renderedShowCount + i, dataYear, referenceTime)).join(''));
    } else {
      grid.innerHTML = visibleShows.map((show, i) => renderer(show, i, dataYear, referenceTime)).join('');
    }
    _renderedShowItems = visibleShows;
    _renderedContext = { data: allData, tab: activeTabName, year: dataYear, maximum: _recommendationMaximum };
    _renderedShowCount = visibleShows.length;
    updateLoadMore(visibleShows.length, shows.length);
  }

  function updateLoadMore(visibleCount, totalCount) {
    const sentinel = document.getElementById('loadMore');
    if (!sentinel) return;
    const remaining = Math.max(0, totalCount - visibleCount);
    sentinel.hidden = remaining === 0;
    const status = document.getElementById('loadMoreStatus');
    const message = remaining ? `继续下滑自动加载（还有 ${remaining} 部）` : '已加载全部内容';
    const target = status || sentinel;
    if (target.textContent !== message) target.textContent = message;
  }

  function renderCard(show, index, dataYear = getCurrentDataYear(), referenceTime = getSnapshotTime()) {
    const title = escapeHtml(show.title);
    const titleId = `card-${index}-title`;
    const descId = `card-${index}-desc`;
    const playUrl = getPlayableUrl(show);
    const badges = [];
    const aiScore = normalizeAIScore(show.aiScore);
    const score = toFiniteNumber(show.score, NaN);
    const tmdbRating = toFiniteNumber(show.tmdbRating, NaN);
    if (playUrl) badges.push('<span class="badge badge-playable">可播放</span>');
    // 只突出高匹配度；文字本身说明含义，不依赖仅鼠标可见的 title。
    if (Number.isFinite(aiScore) && aiScore >= AI_BADGE_MIN_SCORE) {
      badges.push(`<span class="badge badge-ai"><span aria-hidden="true">🤖</span> AI 推荐 ${escapeHtml(String(aiScore))}<span class="sr-only">分（口味匹配度，满分100）</span></span>`);
    }
    if (Number.isFinite(score) && score > 0) badges.push(`<span class="badge badge-score" title="爱壹帆来源评分，满分10分"><span aria-hidden="true">⭐</span><span class="sr-only">爱壹帆评分</span> ${escapeHtml(String(show.score))}</span>`);
    else if (Number.isFinite(tmdbRating) && tmdbRating > 0) badges.push(`<span class="badge badge-score" title="TMDB 用户评分，满分10分">TMDB ${escapeHtml(String(tmdbRating))}</span>`);
    if (show.isClassic) badges.push('<span class="badge badge-classic">经典</span>');
    if (show.tmdbCoverPending === true) badges.push('<span class="badge badge-cover-pending">封面待升级</span>');
    const newBadge = getNewBadgeLabel(show, dataYear);
    if (newBadge) badges.push(`<span class="badge badge-new">${newBadge}</span>`);
    if (show.isComplete) badges.push('<span class="badge badge-complete">完结</span>');
    else if (show.isSerial) badges.push('<span class="badge badge-ongoing">连载</span>');

    const posterContent = renderPoster(show.coverImg, show.title, index, '🎬');

    const statusText = show.isComplete
      ? (show.totalEpisodes ? `已完结 · ${show.totalEpisodes}集` : '已完结')
      : show.mediaType === '综艺'
        ? (formatVarietyStatus(show.updateStatus || show.updateMsg) || '更新中')
        : show.currentEpisode
          ? `更新至第${show.currentEpisode}集${show.totalEpisodes ? ' / 共' + show.totalEpisodes + '集' : ''}`
          : show.updateStatus || '未知';

    const statusClass = isShowOngoing(show) ? 'ongoing' : '';
    const viewsText = getPlayCountText(show, referenceTime);

    const actors = toText(show.actor).split(',').filter(Boolean).slice(0, 3).join(' / ');

    const tags = [];
    if (_outsideShows.has(show)) tags.push(`<span class="meta-tag category">${show.mediaType === '综艺' ? '综艺' : '韩剧'}</span>`);
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
    const mark = getShowMark(show);

    const primaryAction = renderPrimaryAction(show, playUrl);
    const sourceLinks = renderSourceLinks(show, primaryAction?.url || '');

    const description = `${show.descriptionSource === 'ai' ? 'AI生成推荐语：' : ''}${toText(show.description)}`;
    const descriptionLength = Array.from(description).length;
    const descriptionToggle = descriptionLength > DESCRIPTION_TOGGLE_MIN_LENGTH
      ? `<button class="card-desc-toggle${descriptionLength > DESCRIPTION_WIDE_TOGGLE_MIN_LENGTH ? '' : ' narrow-only'}" type="button" aria-expanded="false" aria-controls="${descId}">展开简介</button>`
      : '';

    return `
      <article class="show-card${mark === 'seen' ? ' is-seen' : ''}" aria-labelledby="${titleId}" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster">
          ${posterContent}
          ${primaryAction ? `<a class="card-poster-link" href="${escapeHtml(primaryAction.url)}" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true"></a>` : ''}
          <div class="card-badges">${badges.join('')}</div>
        </div>
        <div class="card-body">
          <div class="recommend-bar" style="width:${recommendWidth}%" role="img" aria-label="相对推荐度 ${recommendWidth}%"></div>
          <h3 class="card-title" id="${titleId}">${title}</h3>
          ${badges.length ? `<div class="card-badges-inline">${badges.join('')}</div>` : ''}
          <div class="card-meta">${tags.join('')}</div>
          ${primaryAction ? `<div class="card-primary-action">${primaryAction.html}</div>` : ''}
          ${renderMarkButtons(show, mark)}
          ${actors ? `<div class="card-actors"><span aria-hidden="true">🎭</span> ${escapeHtml(actors)}</div>` : ''}
          <p class="card-desc" id="${descId}">${escapeHtml(description)}</p>
          ${descriptionToggle}
          ${show.aiReason ? `<p class="card-ai-reason"><span aria-hidden="true">🤖</span> AI推荐: ${escapeHtml(show.aiReason)}</p>` : ''}
          <div class="card-footer">
            <span class="card-status ${statusClass}">${escapeHtml(statusText)}</span>
            ${viewsText ? `<span class="card-views"><span aria-hidden="true">👁</span> ${viewsText}</span>` : ''}
          </div>
          ${sourceLinks}
        </div>
      </article>
    `;
  }

  // 新标记只保留一个：新近加入优先，其次才是按数据年份推断的“新剧/新综艺”。
  // 所在标签本身已表达该含义时不再重复。
  function getNewBadgeLabel(show, dataYear) {
    if (activeTabName === 'new') return '';
    if (show.isNew === true) return '新加入';
    if (YEAR_FILTERED_TABS.has(activeTabName)) return '';
    return toFiniteNumber(show.year) >= dataYear ? (show.mediaType === '综艺' ? '新综艺' : '新剧') : '';
  }

  function getPlayableUrl(show) {
    return safeExternalUrl(show?.yfspUrl || (show?.primaryUrlSource === 'yfsp' ? show?.primaryUrl : ''));
  }

  function isShowPlayable(show) {
    return !!getPlayableUrl(show);
  }

  // 外链在新窗口打开；读屏文字补充节目名，避免同页多个“TMDB”链接无法区分。
  function externalLinkSuffix(title) {
    return `<span class="sr-only">：${escapeHtml(title)}（新窗口）</span>`;
  }

  function renderPrimaryAction(show, playUrl = getPlayableUrl(show)) {
    const primaryUrl = playUrl || safeExternalUrl(show.primaryUrl) || safeExternalUrl(show.tmdbUrl) || safeExternalUrl(show.doubanUrl);
    if (!primaryUrl) return null;
    // 无播放源时降为次要样式，明确告知只能查看资料。
    const className = playUrl ? 'card-action primary' : 'card-action primary is-info';
    const label = playUrl ? '观看 / 详情' : '暂无播放源 · 查看资料';
    return {
      url: primaryUrl,
      html: `<a class="${className}" href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener noreferrer">${label}${externalLinkSuffix(show.title)}</a>`,
    };
  }

  // 资料来源收进一行小号文字链接，减少窄屏卡片高度。
  function renderSourceLinks(show, primaryUrl) {
    const links = [];
    for (const [url, label] of [[show.tmdbUrl, 'TMDB'], [show.doubanUrl, '豆瓣'], [show.wikipediaUrl, 'Wiki'], [show.imdbUrl, 'IMDb']]) {
      const safeUrl = safeExternalUrl(url);
      if (!safeUrl || safeUrl === primaryUrl) continue;
      links.push(`<a class="card-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}${externalLinkSuffix(show.title)}</a>`);
    }
    return links.length ? `<div class="card-links"><span class="card-links-label">资料</span>${links.join('')}</div>` : '';
  }

  // 综艺来源状态多为原始编码，如“20261107(第1期纯享)”“更新到20261106(抢鲜版)”“07”“周五”。
  // 只改写能确定含义的格式，其余原样保留。
  function formatVarietyStatus(value) {
    const text = toText(value).trim();
    let match = text.match(/^(?:更新到)?(\d{4})(\d{2})(\d{2})(?:[(（]([^()（）]+)[)）])?$/u);
    if (match) {
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return text;
      return `更新至${month}月${day}日${match[4] ? `（${match[4].trim()}）` : ''}`;
    }
    match = text.match(/^(?:更新到)?(\d{1,3})$/u);
    if (match && Number(match[1]) > 0) return `更新至第${Number(match[1])}期`;
    match = text.match(/^周([一二三四五六日天])$/u);
    if (match) return `每周${match[1]}更新`;
    return text;
  }

  // 从未被爱壹帆实际观测的播放量来自旧种子，不展示；最后观测超过 14 天的标为历史播放。
  function getPlayCountText(show, referenceTime = getSnapshotTime()) {
    const playCount = Math.max(0, toFiniteNumber(show.playCount));
    if (!playCount) return '';
    const observedAt = Math.max(getTimestamp(show.lastLiveAt), getTimestamp(show.scrapedAt));
    if (!observedAt) return '';
    const count = playCount >= 10000 ? `${(playCount / 10000).toFixed(1)}万` : String(playCount);
    return referenceTime - observedAt > PLAY_COUNT_STALE_AFTER_MS ? `历史播放 ${count}次` : `${count}次播放`;
  }

  function getTimestamp(value) {
    if (typeof value !== 'string' || !value) return 0;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
  }

  // 播放量新旧以快照生成时间为参照；离线缓存同样按其生成时刻判断。
  function getSnapshotTime() {
    return getTimestamp(allData?.generatedAt) || getTimestamp(allData?.lastUpdated) || Date.now();
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
    // 重试会立即隐藏操作区；只迁移其中的焦点，避免抢走用户正在操作的筛选控件。
    if (actionElement && (actionElement === document.activeElement || actionElement.contains?.(document.activeElement))) {
      document.getElementById('mainContent')?.focus({ preventScroll: true });
    }
    if (empty) empty.style.display = 'none';
    if (actionElement) {
      actionElement.hidden = true;
      actionElement.onclick = null;
    }
  }

  function updateResetVisibility() {
    const state = readFilterState();
    const defaultSort = DEFAULT_SORT_BY_TAB[activeTabName] || 'recommend';
    const button = document.getElementById('resetFilters');
    if (button) button.hidden = !hasActiveResultFilters(state) && state.sort === defaultSort;
    // 窄屏折叠的筛选面板在按钮上显示已启用项数（搜索框始终可见，不计入）。
    const toggle = document.getElementById('filterToggle');
    if (toggle) {
      const count = [state.status !== 'all', state.score !== '0', state.sort !== defaultSort, state.playable].filter(Boolean).length;
      const label = count ? `筛选与排序（${count}）` : '筛选与排序';
      if (toggle.textContent !== label) toggle.textContent = label;
    }
    updateQuickFilters(state);
  }

  function updateResultSummary(total, visibleTotal = total) {
    const summary = document.getElementById('resultSummary');
    if (!summary) return;
    if (!total) {
      summary.textContent = '没有符合当前筛选条件的内容';
      return;
    }
    const activeFilters = [];
    const { status, score, query, playable, genre, hideSeen } = readFilterState();
    if (status === 'ongoing') activeFilters.push('连载中');
    if (status === 'complete') activeFilters.push('已完结');
    if (score && score !== '0') activeFilters.push(`${score}分以上`);
    if (playable) activeFilters.push('可播放');
    if (genre) activeFilters.push(genre);
    if (hideSeen) activeFilters.push('隐藏看过');
    if (query) activeFilters.push(`搜索“${query}”`);
    if (query && _outsideResultCount) activeFilters.push(`含其他分类 ${_outsideResultCount} 个`);
    const suffix = activeFilters.length ? ` · ${activeFilters.join(' · ')}` : '';
    const noun = REMOTE_TAB_LABELS[activeTabName] ? '个节目' : '个推荐结果';
    const countText = visibleTotal < total ? `显示 ${visibleTotal} / ${total} ${noun}` : `显示 ${total} ${noun}`;
    summary.textContent = `${countText}${suffix}`;
  }

  function updateStats(shows, animate = false) {
    const total = shows.length;
    const ongoing = shows.filter(isShowOngoing).length;
    const complete = shows.filter(s => {
      const complete = isShowComplete(s);
      return complete;
    }).length;
    const highScore = shows.filter(s => {
      const score = getShowNumber(s, 'score');
      return score >= 8;
    }).length;

    const updateNumber = animate ? animateNum : setStatNumber;
    updateNumber('statTotal', total);
    updateNumber('statOngoing', ongoing);
    updateNumber('statComplete', complete);
    updateNumber('statHighScore', highScore);
    updateResultSummary(total, Math.min(_visibleShowCount, total));
    updateResetVisibility();
    updateStatShortcuts();
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
    updateStatShortcuts();
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

  function isShowOngoing(show) {
    if (isShowComplete(show)) return false;
    if (typeof show?.isSerial === 'boolean') return show.isSerial;
    return toText(show?.status).toLowerCase() === 'running';
  }

  function animateNum(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = parseInt(el.textContent) || 0;
    // 清理该元素上一次未完成的动画,避免多个 setInterval 叠加导致数字闪烁
    if (_numTimers.has(id)) {
      clearInterval(_numTimers.get(id));
      _numTimers.delete(id);
    }
    if (current === target) return;

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

  // ── 看过 / 想看 ──────────────────────────────────────
  function loadMarks() {
    const marks = { want: Object.create(null), seen: Object.create(null), hideSeen: false };
    try {
      if (typeof localStorage === 'undefined') return marks;
      const stored = JSON.parse(localStorage.getItem(MARKS_KEY) || 'null');
      if (stored?.kind !== 'iyf-marks') return marks;
      for (const kind of MARK_KINDS) {
        const entries = stored[kind];
        if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue;
        for (const [key, time] of Object.entries(entries).slice(0, MARKS_MAX_ENTRIES)) {
          if (key && key.length <= 220 && Number.isFinite(time)) marks[kind][key] = time;
        }
      }
      marks.hideSeen = stored.hideSeen === true;
    } catch {
      // 存储不可用或内容损坏时从空标记开始。
    }
    return marks;
  }

  function saveMarks() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(MARKS_KEY, JSON.stringify({ kind: 'iyf-marks', want: _marks.want, seen: _marks.seen, hideSeen: _marks.hideSeen }));
    } catch {
      // 隐私模式下标记只在本次访问有效。
    }
  }

  function getMarkKey(show) {
    const title = toText(show?.title).trim();
    return title ? `${title}|${toFiniteNumber(show?.year) || ''}` : '';
  }

  // 同一节目只有一个标记：'want'、'seen' 或空。
  function getShowMark(show) {
    const key = getMarkKey(show);
    if (!key) return '';
    return key in _marks.seen ? 'seen' : key in _marks.want ? 'want' : '';
  }

  function setMark(key, kind) {
    if (!key) return '';
    const next = key in _marks[kind] ? '' : kind;
    for (const other of MARK_KINDS) delete _marks[other][key];
    if (next) {
      // 超出上限时淘汰最早的标记。
      const keys = Object.keys(_marks[next]);
      if (keys.length >= MARKS_MAX_ENTRIES) {
        keys.sort((a, b) => _marks[next][a] - _marks[next][b]).slice(0, keys.length - MARKS_MAX_ENTRIES + 1)
          .forEach(oldKey => delete _marks[next][oldKey]);
      }
      _marks[next][key] = Date.now();
    }
    saveMarks();
    return next;
  }

  function renderMarkButtons(show, mark = getShowMark(show)) {
    const key = getMarkKey(show);
    if (!key) return '';
    const buttons = MARK_KINDS.map(kind =>
      `<button class="card-mark" type="button" data-mark="${kind}" aria-pressed="${mark === kind}">${MARK_LABELS[kind]}<span class="sr-only">：${escapeHtml(show.title)}</span></button>`);
    return `<div class="card-marks" data-mark-key="${escapeHtml(key)}">${buttons.join('')}</div>`;
  }

  // 就地更新这张卡片：不立即重排，避免卡片从手指下消失；下一次筛选、排序或切换标签时看过的才沉底。
  function toggleCardMark(button) {
    const group = button.closest?.('.card-marks');
    const kind = button.dataset?.mark;
    const key = group?.dataset?.markKey;
    if (!MARK_KINDS.includes(kind) || !key) return;
    const mark = setMark(key, kind);
    for (const other of group.querySelectorAll?.('.card-mark') || []) {
      other.setAttribute('aria-pressed', String(other.dataset?.mark === mark));
    }
    button.closest?.('.show-card')?.classList.toggle('is-seen', mark === 'seen');
    updateQuickFilters();
  }

  function getAllRecommendationShows() {
    return [...(allData?.koreanDramas || []), ...(allData?.chineseVariety || [])];
  }

  // ── 快捷筛选标签 ──────────────────────────────────────
  function getQuickGenres() {
    if (activeTabName === 'tvmaze' || !currentShows.length) return _genreFilter && activeTabName !== 'tvmaze' ? [_genreFilter] : [];
    const counts = new Map();
    for (const show of currentShows) {
      for (const genre of new Set(getShowGenres(show))) counts.set(genre, (counts.get(genre) || 0) + 1);
    }
    const genres = [...counts].filter(([, count]) => count >= QUICK_GENRE_MIN_COUNT && count <= currentShows.length * QUICK_GENRE_MAX_SHARE)
      .sort((a, b) => b[1] - a[1]).slice(0, QUICK_GENRE_LIMIT).map(([genre]) => genre);
    // 已选类型即使不在当前分类的常见类型里也要显示，才能取消。
    if (_genreFilter && !genres.includes(_genreFilter)) genres.unshift(_genreFilter);
    return genres;
  }

  function updateQuickFilters(state = readFilterState()) {
    const container = document.getElementById('quickFilters');
    if (!container) return;
    const isSchedule = activeTabName === 'tvmaze';
    const chip = (name, label, pressed, extra = '') =>
      `<button class="chip" type="button" data-chip="${name}"${extra} aria-pressed="${pressed}">${escapeHtml(label)}</button>`;
    const chips = [];
    if (!isSchedule) chips.push(chip('playable', '可播放', state.playable));
    chips.push(chip('ongoing', '连载中', state.status === 'ongoing'));
    if (!isSchedule) {
      chips.push(chip('score8', '8 分以上', state.score === '8'));
      if (state.hideSeen || Object.keys(_marks.seen).length) chips.push(chip('hideSeen', '隐藏看过', state.hideSeen));
      for (const genre of getQuickGenres()) chips.push(chip('genre', genre, state.genre === genre, ` data-genre="${escapeHtml(genre)}"`));
    }
    const html = chips.join('');
    if (container.innerHTML === html) return;
    // 重写标签会丢失焦点；按标签身份恢复，键盘用户可以连续切换。
    const focused = container.contains?.(document.activeElement) ? document.activeElement : null;
    const focusedChip = focused?.dataset?.chip;
    const focusedGenre = focused?.dataset?.genre;
    container.innerHTML = html;
    if (focusedChip) {
      [...(container.querySelectorAll?.('.chip') || [])]
        .find(button => button.dataset?.chip === focusedChip && button.dataset?.genre === focusedGenre)
        ?.focus({ preventScroll: true });
    }
  }

  function bindQuickFilters() {
    document.getElementById('quickFilters')?.addEventListener('click', event => {
      const button = event?.target?.closest?.('.chip');
      if (!button) return;
      const status = document.getElementById('filterStatus');
      const score = document.getElementById('filterScore');
      const playable = document.getElementById('filterPlayable');
      switch (button.dataset?.chip) {
        case 'playable':
          if (playable) playable.checked = !playable.checked;
          break;
        case 'ongoing':
          if (status) status.value = status.value === 'ongoing' ? 'all' : 'ongoing';
          break;
        case 'score8':
          if (score) score.value = score.value === '8' ? '0' : '8';
          break;
        case 'hideSeen':
          _marks.hideSeen = !_marks.hideSeen;
          saveMarks();
          break;
        case 'genre': {
          const genre = normalizeGenre(button.dataset.genre);
          _genreFilter = _genreFilter === genre ? '' : genre;
          break;
        }
        default:
          return;
      }
      syncUrlState();
      applyFilters();
    });
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
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;
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
      ? [show?.recommendScore, show?.rating?.average]
      : kind === 'score'
        // 爱壹帆未评分（0）的新剧回退到 TMDB 评分，筛选、排序和统计口径一致。
        ? [toFiniteNumber(show?.score) > 0 ? show.score : null, show?.tmdbRating, show?.rating?.average, show?.score]
        : [show?.playCount];
    for (const value of candidates) {
      const number = toFiniteNumber(value, NaN);
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  function normalizeAIScore(value) {
    if (value == null || value === '') return NaN;
    const score = toFiniteNumber(value, NaN);
    return Number.isFinite(score) && score >= 0 && score <= 100 ? score : NaN;
  }

  function getRecommendationWidth(show) {
    const score = Math.max(0, getShowNumber(show, 'recommend'));
    const maximum = Math.max(_recommendationMaximum, score);
    return Math.round(Math.max(0, Math.min(100, score / maximum * 100)));
  }

  function isShowDataset(value) {
    const isRecord = item => item !== null && typeof item === 'object' && !Array.isArray(item);
    const optionalNumber = item => item == null || (typeof item === 'number' && Number.isFinite(item));
    const optionalText = item => item == null || typeof item === 'string';
    if (!isRecord(value) || typeof value.lastUpdated !== 'string' || !Number.isFinite(Date.parse(value.lastUpdated)) ||
      !Array.isArray(value.koreanDramas) || !Array.isArray(value.chineseVariety) ||
      value.koreanDramas.length > 1000 || value.chineseVariety.length > 1000 ||
      ![value.generatedAt, value.sourceStatus].every(optionalText)) return false;
    if (value.stats != null && (!isRecord(value.stats) ||
      ![value.stats.koreanDramas, value.stats.chineseVariety].every(optionalNumber))) return false;
    const numericFields = ['year', 'score', 'tmdbRating', 'playCount', 'recommendScore', 'aiScore', 'currentEpisode', 'totalEpisodes'];
    const booleanFields = ['isComplete', 'isSerial', 'isClassic', 'isNew', 'tmdbCoverPending'];
    const textFields = [
      'mediaType', 'regional', 'lang', 'aiReason', 'contentType', 'actor', 'description', 'descriptionSource',
      'coverImg', 'publishTime', 'airDate', 'firstSeenAt', 'scrapedAt', 'lastLiveAt', 'updateMsg', 'updateStatus', 'primaryUrl',
      'primaryUrlSource', 'yfspUrl', 'tmdbUrl', 'doubanUrl', 'wikipediaUrl', 'imdbUrl',
    ];
    // 网络和本地缓存共用渲染契约；可选字段允许缺省/null，结构值不能进入隐式数值或字符串转换。
    return [...value.koreanDramas, ...value.chineseVariety].every(show =>
      isRecord(show) && typeof show.id === 'string' && !!show.id.trim() &&
      typeof show.title === 'string' && !!show.title.trim() && show.title.length <= 200 &&
      numericFields.every(field => optionalNumber(show[field])) &&
      booleanFields.every(field => show[field] == null || typeof show[field] === 'boolean') &&
      textFields.every(field => optionalText(show[field])) &&
      (show.titleAliases == null || (Array.isArray(show.titleAliases) && show.titleAliases.every(alias => typeof alias === 'string'))) &&
      (show.rating == null || (isRecord(show.rating) && optionalNumber(show.rating.average))));
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
    return toText(str).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
  }

  function safeExternalUrl(value, allowedHosts = null) {
    const url = typeof value === 'string' ? value.trim() : '';
    // 拒绝协议注入、属性逃逸、控制字符和含凭据 URL。
    if (!url || /["<>\u0000-\u001F\u007F]/u.test(url)) return '';
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return '';
      if (allowedHosts && !allowedHosts.has(parsed.hostname.toLowerCase())) return '';
      // 单引号是合法 URL 路径字符；规范编码后再由渲染层转义属性。
      return parsed.href.replace(/'/g, '%27');
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
        const path780 = parsed.pathname.replace(/\/t\/p\/(?:original|w\d+)\//u, '/t/p/w780/');
        const url185 = `${parsed.origin}${path185}${parsed.search}`;
        const url342 = `${parsed.origin}${path342}${parsed.search}`;
        const url500 = `${parsed.origin}${path500}${parsed.search}`;
        const url780 = `${parsed.origin}${path780}${parsed.search}`;
        // 使用宽度描述符后 src 不参与候选。宽屏网格为 minmax(220px, 1fr)、18px 间距、左右各 20px 留白、
        // 容器最宽 1240px：769–973px 三列，974–1211px 四列，更宽时五列（每列约 220–226px）。
        responsive = ` srcset="${escapeHtml(url185)} 185w, ${escapeHtml(url342)} 342w, ${escapeHtml(url500)} 500w, ${escapeHtml(url780)} 780w" sizes="(max-width: 480px) 112px, (max-width: 768px) calc((100vw - 42px) / 2), (max-width: 973px) calc((100vw - 76px) / 3), (max-width: 1211px) calc((100vw - 94px) / 4), 226px"`;
      }
    } catch {}

    return `<img src="${escapeHtml(source)}"${responsive} alt="" loading="${firstViewport ? 'eager' : 'lazy'}"${firstViewport ? ' fetchpriority="high"' : ''} decoding="async" data-fallback-icon="${fallbackIcon}">`;
  }

  function cancelPendingTabRequest() {
    _tabRequestVersion++;
    _isTabLoading = false;
    _tabLoadError = null;
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

    renderSkeletons(4, '正在加载时间表...');
    const summary = document.getElementById('resultSummary');
    if (summary) summary.textContent = '正在加载时间表…';
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
    _tabLoadError = { tab };
    const grid = document.getElementById('showGrid');
    resetRenderedShows();
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
    const debounced = function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn.apply(this, args);
      }, delay);
    };
    debounced.cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    return debounced;
  }

  // ── 外部数据源: TVmaze 韩剧时间表 ─────────────────────────
  let _tvmazeCache = null;
  let _tvmazeCachedAt = 0;
  let _tvmazeCachePartial = false;
  let _tvmazeCacheDate = '';

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

  function isTVmazeScheduleEntry(entry) {
    const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const isOptionalText = value => value == null || typeof value === 'string';
    const show = entry?.show;
    if (!isRecord(entry) || !isRecord(show) || !Number.isSafeInteger(show.id) || show.id <= 0 ||
      typeof show.name !== 'string' || !show.name.trim() || /[\uD800-\uDFFF]/u.test(show.name)) return false;
    if (![show.type, show.status, show.url, show.summary, entry.airtime].every(isOptionalText)) return false;
    if (show.genres != null && (!Array.isArray(show.genres) || show.genres.some(genre => typeof genre !== 'string'))) return false;
    if (show.rating != null && (!isRecord(show.rating) ||
      (show.rating.average != null && !Number.isFinite(show.rating.average)))) return false;
    for (const [metadata, fields] of [[show.network, ['name']], [show.image, ['medium', 'original']]]) {
      if (metadata != null && (!isRecord(metadata) || fields.some(field => !isOptionalText(metadata[field])))) return false;
    }
    return [entry.season, entry.number].every(value => value == null || (Number.isSafeInteger(value) && value >= 0));
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
      const requestTime = Date.now();
      const scheduleDate = getScheduleDateKey(requestTime);
      const cacheTTL = _tvmazeCachePartial ? REMOTE_PARTIAL_CACHE_TTL_MS : REMOTE_CACHE_TTL_MS;
      if (!shows || _tvmazeCacheDate !== scheduleDate || requestTime - _tvmazeCachedAt >= cacheTTL) {
        // 以韩国本地日期为准；今天失败时继续回溯，避免单日故障让整个时间表变空。
        const showMap = new Map();
        const dates = buildScheduleDateKeys(requestTime);
        let requestedDays = 0;
        let successfulDays = 0;
        let currentDaySucceeded = false;
        let hasInvalidEntries = false;
        const fetchSchedule = async d => {
          requestedDays++;
          const response = await fetch(`https://api.tvmaze.com/schedule?country=KR&date=${d}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`TVmaze HTTP ${response.status}`);
          const data = await response.json();
          if (!Array.isArray(data)) throw new Error('TVmaze returned invalid data');
          // 按行隔离错型数据；一条坏记录不能拖垮同日已确认的正常节目或写入共享缓存。
          const validEntries = data.filter(isTVmazeScheduleEntry);
          const dayComplete = validEntries.length === data.length;
          if (!dayComplete) hasInvalidEntries = true;
          successfulDays++;
          if (d === dates[0] && dayComplete) currentDaySucceeded = true;
          return { date: d, data: validEntries };
        };
        const addSchedule = ({ date, data }) => {
          for (const entry of data) {
            const show = entry?.show;
            if (!show?.id || !isTVmazeDrama(show) || showMap.has(show.id)) continue;
            // 仅保留经过类型检查且页面会使用的来源字段，避免额外字段参与通用筛选和排序。
            const { id, name, type, status, genres, rating, network, image, url, summary } = show;
            showMap.set(show.id, {
              id, name, type, status, genres, rating, network, image, url, summary,
              latestEpisode: { season: entry.season, number: entry.number, airtime: entry.airtime },
              airDate: date,
            });
          }
        };

        try {
          addSchedule(await fetchSchedule(dates[0]));
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
        }
        for (let start = 1; start < dates.length && showMap.size < 5 && !controller.signal.aborted; start += 2) {
          const batch = await Promise.allSettled(dates.slice(start, start + 2).map(fetchSchedule));
          batch.filter(result => result.status === 'fulfilled').forEach(result => addSchedule(result.value));
          const aborted = batch.find(result => result.status === 'rejected' && result.reason?.name === 'AbortError');
          if (aborted) {
            // 补齐超时仍保留已收到的节目，包括同批中较早完成的历史请求。
            if (!showMap.size) throw aborted.reason;
            break;
          }
        }
        // 今天未知且历史没有节目时，保留失败状态或旧缓存，不能当成已确认的空档。
        if (!successfulDays || (!currentDaySucceeded && !showMap.size)) throw new Error('TVmaze schedule unavailable');
        shows = sortTVmazeShows([...showMap.values()]);
        // 超时可保留部分结果；切换标签取消的请求仍不能回写页面或共享缓存。
        if (!isActiveTabRequest('tvmaze', requestVersion, controller)) return;
        _tvmazeCache = shows;
        _tvmazeCachedAt = Date.now();
        _tvmazeCacheDate = scheduleDate;
        _tvmazeCachePartial = controller.signal.aborted || successfulDays < requestedDays || hasInvalidEntries;
      }

      if (!completeRemoteTab('tvmaze', requestVersion, controller, shows)) return;
      const sourceLabel = _tvmazeCachePartial ? 'TVmaze 韩剧时间表（部分日期暂不可用，稍后重试）' : 'TVmaze 韩剧时间表';
      updateSourceInfo(sourceLabel, new Date(_tvmazeCachedAt).toISOString());

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
    const epInfo = ep
      ? [Number.isInteger(ep.season) ? `S${ep.season}` : '', Number.isInteger(ep.number) ? `E${ep.number}` : '特别篇'].join('')
      : '';
    const airtime = ep?.airtime || '';
    const airDate = formatScheduleDate(show.airDate);
    const network = show.network?.name || '';
    const genres = Array.isArray(show.genres) ? show.genres.slice(0, 3) : [];
    const rating = toFiniteNumber(show.rating?.average, NaN);
    const img = safeExternalUrl(show.image?.medium || show.image?.original || '', REMOTE_LINK_HOSTS.tvmazeImage);
    const showUrl = safeExternalUrl(show.url, REMOTE_LINK_HOSTS.tvmaze);
    // 按码点截断，避免把补充平面字符拆成孤立代理项。
    const summary = Array.from(decodeSummaryText(show.summary)).slice(0, 120).join('');
    const complete = isShowComplete(show);
    const statusText = complete ? '已完结' : show.status === 'Running' ? '连载中' : '待定/筹备';
    const posterContent = img
      ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" decoding="async" data-fallback-icon="📺">`
      : '<div class="placeholder">📺</div>';

    return `
      <article class="show-card source-tvmaze" aria-labelledby="card-${index}-title" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster">${posterContent}</div>
        <div class="card-body">
          <h3 class="card-title" id="card-${index}-title">${escapeHtml(show.name)}</h3>
          <div class="card-meta">
            ${network ? `<span class="meta-tag region">${escapeHtml(network)}</span>` : ''}
            ${genres.map(g => `<span class="meta-tag">${escapeHtml(g)}</span>`).join('')}
          </div>
          <div class="card-schedule">
            ${airDate ? `<span class="schedule-date">${escapeHtml(airDate)}</span>` : ''}
            ${epInfo ? `<span class="schedule-ep">${escapeHtml(epInfo)}</span>` : ''}
            ${airtime ? `<span class="schedule-time"><span aria-hidden="true">🕐</span> ${escapeHtml(airtime)}（韩国时间）</span>` : ''}
            ${rating > 0 ? `<span class="schedule-rating"><span aria-hidden="true">⭐</span><span class="sr-only">TVmaze 评分</span> ${rating.toFixed(1)}</span>` : ''}
          </div>
          <p class="card-desc">${escapeHtml(summary)}</p>
          <div class="card-footer">
            <span class="card-status ${isShowOngoing(show) ? 'ongoing' : ''}">${statusText}</span>
            <span class="card-source-label"><span aria-hidden="true">📡</span> TVmaze</span>
          </div>
          <div class="card-actions">
            ${showUrl ? `<a class="card-action source-tvmaze-link" href="${escapeHtml(showUrl)}" target="_blank" rel="noopener noreferrer">TVmaze 详情${externalLinkSuffix(show.name)}</a>` : ''}
            <a class="card-action source-tmdb" href="https://www.themoviedb.org/search?query=${encodeURIComponent(show.name)}" target="_blank" rel="noopener noreferrer">TMDB${externalLinkSuffix(show.name)}</a>
          </div>
        </div>
      </article>`;
  }

  function decodeSummaryText(value) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…', eacute: 'é' };
    // 先去标签、再解码实体，最后由卡片按文本上下文转义；编码的标签始终只是文字。
    let decoder;
    return toText(value).replace(/<[^>]+>/g, '').replace(/&([a-z][a-z\d]+|#\d+|#x[\da-f]+);/giu, (entity, name) => {
      if (name[0] !== '#') {
        if (Object.hasOwn(entities, name)) return entities[name];
        // 仅解析单个实体 token，输入不含标签，不会创建脚本、图片或请求。
        decoder ||= document.createElement('textarea');
        decoder.innerHTML = entity;
        return decoder.value || entity;
      }
      const hexadecimal = name[1].toLowerCase() === 'x';
      const code = parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    });
  }

})();
