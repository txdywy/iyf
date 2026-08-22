/**
 * 韩剧 & 综艺推荐网站 - 前端应用
 */

(function () {
  'use strict';

  const DATA_URL = 'data/shows.json';
  const VALID_TABS = new Set(['korean', 'year2026', 'variety2026', 'variety', 'new', 'classic', 'tvmaze', 'trakt', 'mdl']);
  const REMOTE_CACHE_TTL_MS = 15 * 60 * 1000;
  const REMOTE_REQUEST_TIMEOUT_MS = 12000;
  const SOURCE_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
  const DEFAULT_SORT_BY_TAB = { new: 'newest' };
  const REMOTE_TAB_LABELS = { tvmaze: 'TVmaze 韩剧时间表', trakt: 'Trakt.tv 热度', mdl: 'MyDramaList 社区' };
  const REMOTE_LINK_HOSTS = Object.freeze({
    tvmaze: new Set(['www.tvmaze.com']),
    tvmazeImage: new Set(['static.tvmaze.com']),
    trakt: new Set(['trakt.tv', 'www.trakt.tv']),
    mdl: new Set(['mydramalist.com', 'www.mydramalist.com']),
  });
  let allData = null;
  let currentShows = [];
  let activeTabName = 'korean';
  const _tabSortPreferences = new Map();
  let _tabRequestVersion = 0;
  let _tabAbortController = null;
  let _isTabLoading = false;
  const _tabRequestTimeouts = new WeakMap();


  // ── 初始化 ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindTabs();
    bindFilters();
    bindPosterFallbacks();
    await loadData();
  }

  async function loadData() {
    try {
      // 保持稳定 URL，让浏览器用 ETag/Last-Modified 做条件请求。
      const resp = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('Data not found');
      const data = await resp.json();
      if (!isShowDataset(data)) throw new Error('Invalid show data');
      allData = data;
      updateInfo();
      // 从 URL hash 恢复上次选择的标签,默认韩剧推荐
      const hashTab = location.hash.slice(1);
      switchTab(VALID_TABS.has(hashTab) ? hashTab : 'korean');
    } catch (e) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('empty').style.display = 'block';
      document.getElementById('empty').innerHTML =
        '<p>😢 暂无推荐数据</p><p style="font-size:0.85rem;margin-top:8px;color:#8888a0">数据正在抓取中,请稍后刷新...</p>';
    }
  }

  function updateInfo() {
    if (!allData) return;
    const el = document.getElementById('updateInfo');
    const time = new Date(allData.lastUpdated);
    const timeStr = Number.isNaN(time.getTime()) ? '未知' : time.toLocaleString('zh-CN', { hour12: false });
    const kr = allData.stats?.koreanDramas ?? (allData.koreanDramas || []).length;
    const vr = allData.stats?.chineseVariety ?? (allData.chineseVariety || []).length;
    const sourceNotice = allData.sourceStatus === 'degraded' ? ' · 数据源暂不可用，展示上一快照' : '';
    el.textContent = `最后更新: ${timeStr} · 共 ${kr} 部韩剧 · ${vr} 档综艺${sourceNotice}`;
  }

  // ── 标签切换 ──────────────────────────────────────────
  function bindTabs() {
    const tabs = [...document.querySelectorAll('.tab')];
    tabs.forEach((btn, index) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
      btn.addEventListener('keydown', event => {
        let nextIndex = null;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex == null) return;
        event.preventDefault();
        tabs[nextIndex].focus();
        switchTab(tabs[nextIndex].dataset.tab);
      });
    });
  }

  function switchTab(tab) {
    if (!VALID_TABS.has(tab)) tab = 'korean';
    const requestVersion = cancelPendingTabRequest();
    const sortSelect = document.getElementById('sortBy');
    if (sortSelect?.value) _tabSortPreferences.set(activeTabName, sortSelect.value);
    activeTabName = tab;
    if (sortSelect) sortSelect.value = _tabSortPreferences.get(tab) || DEFAULT_SORT_BY_TAB[tab] || 'recommend';
    history.replaceState(null, '', '#' + tab);
    document.querySelectorAll('.tab').forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.tabIndex = active ? 0 : -1;
    });
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
      case 'year2026':
        shows = (allData.koreanDramas || []).filter(s => s.year === getCurrentDataYear());
        break;
      case 'variety2026':
        // 当年新综艺：当年新综艺 + 经典搞笑综艺
        shows = (allData.chineseVariety || []).filter(s =>
          s.year >= getCurrentDataYear() || s.isClassic
        );
        break;
      case 'variety':
        shows = allData.chineseVariety || [];
        break;
      case 'new':
        shows = [...(allData.koreanDramas || []), ...(allData.chineseVariety || [])]
          .filter(s => s.year >= getCurrentDataYear())
          .sort((a, b) => getValidTime(b.publishTime) - getValidTime(a.publishTime));
        break;
      case 'classic':
        shows = [
          ...(allData.koreanDramas || []),
          ...(allData.chineseVariety || [])
        ].filter(s => s.isClassic || s.score >= 8.5);
        break;
      case 'tvmaze':
        return fetchAndRenderTVmaze(requestVersion);
      case 'trakt':
        return fetchAndRenderTrakt(requestVersion);
      case 'mdl':
        return fetchAndRenderMDL(requestVersion);
    }

    currentShows = shows;
    applyFilters(true);
  }

  // ── 筛选 ──────────────────────────────────────────
  function bindFilters() {
    // 包一层箭头函数,避免事件对象被当作 animate 实参传入(否则筛选也会触发入场动画)。
    document.getElementById('filterStatus').addEventListener('change', () => applyFilters());
    document.getElementById('filterScore').addEventListener('change', () => applyFilters());
    document.getElementById('sortBy').addEventListener('change', () => applyFilters());
    document.getElementById('searchInput').addEventListener('input', debounce(() => applyFilters(), 300));
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
      shows = shows.filter(s =>
        toText(s.title).toLowerCase().includes(query) ||
        toText(Array.isArray(s.titleAliases) ? s.titleAliases.join(' ') : s.titleAliases).toLowerCase().includes(query) ||
        toText(s.name).toLowerCase().includes(query) ||
        toText(s.actor).toLowerCase().includes(query) ||
        toText(s.contentType || (Array.isArray(s.genres) ? s.genres.join('/') : '')).toLowerCase().includes(query)
      );
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
        shows.sort((a, b) => getValidTime(b.publishTime || b.airDate || b.year) - getValidTime(a.publishTime || a.airDate || a.year));
        break;
      case 'popular':
        shows.sort((a, b) => getShowNumber(b, 'popular') - getShowNumber(a, 'popular'));
        break;
    }

    renderShows(shows, animate);
    updateStats(shows);
  }

  // ── 渲染 ──────────────────────────────────────────
  function renderShows(shows, animate = false) {
    const grid = document.getElementById('showGrid');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty');

    loading.style.display = 'none';
    grid.setAttribute('aria-busy', 'false');

    if (!shows.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    // 仅在切换标签/首次加载时播放入场动画;筛选/搜索/排序时即时呈现,避免每次按键重放动画造成的抖动。
    grid.classList.toggle('animate', animate);

    let renderer = renderCard;
    if (activeTabName === 'tvmaze') renderer = renderTVmazeCard;
    else if (activeTabName === 'trakt') renderer = renderTraktCard;
    else if (activeTabName === 'mdl') renderer = renderMDLCard;

    grid.innerHTML = shows.map((show, i) => renderer(show, i)).join('');
  }

  function renderCard(show, index) {
    const badges = [];
    if (Number.isFinite(show.aiScore)) badges.push(`<span class="badge badge-ai">🤖 ${escapeHtml(String(show.aiScore))}/100</span>`);
    if (show.score >= 8) badges.push(`<span class="badge badge-score">⭐ ${escapeHtml(String(show.score))}</span>`);
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
        ? (show.updateStatus || '更新中')
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

    const recommendWidth = Math.max(0, Math.min(100, toFiniteNumber(show.recommendScore) / 1.5));

    const actions = renderCardActions(show);

    return `
      <article class="show-card" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster">
          ${posterContent}
          ${newBadge}
          <div class="card-badges">${badges.join('')}</div>
          ${show.score > 0 ? `<div class="card-score-float">⭐ ${escapeHtml(String(show.score))}</div>` : ''}
        </div>
        <div class="card-body">
          <div class="recommend-bar" style="width:${recommendWidth}%"></div>
          <h3 class="card-title">${escapeHtml(show.title)}</h3>
          <div class="card-meta">${tags.join('')}</div>
          ${actors ? `<div class="card-actors">🎭 ${escapeHtml(actors)}</div>` : ''}
          <p class="card-desc">${escapeHtml(show.description || '')}</p>
          ${show.aiReason ? `<p class="card-ai-reason">🤖 AI推荐: ${escapeHtml(show.aiReason)}</p>` : ''}
          <div class="card-footer">
            <span class="card-status ${statusClass}">${escapeHtml(statusText)}</span>
            ${viewsText ? `<span class="card-views">👁 ${viewsText}</span>` : ''}
          </div>
          <div class="card-actions">
            ${actions}
          </div>
        </div>
      </article>
    `;
  }

  function renderCardActions(show) {
    const actions = [];
    addExternalAction(actions, show.tmdbUrl, 'source-tmdb', 'TMDB资料');
    addExternalAction(actions, show.doubanUrl, 'source-douban', '豆瓣资料');
    addExternalAction(actions, show.wikipediaUrl, 'source-wikipedia', 'Wikipedia');
    addExternalAction(actions, show.imdbUrl, 'source-imdb', 'IMDb资料');

    const yfspUrl = show.yfspUrl || (show.primaryUrlSource === 'yfsp' ? show.primaryUrl : '');
    addExternalAction(actions, yfspUrl, 'source-yfsp', '观看/详情');

    // 有资料链接但缺少观看链接时,显示灰色提示
    if (!yfspUrl && actions.length > 0) {
      actions.push('<span class="card-action disabled">暂无观看链接</span>');
    }

    if (!actions.length && show.primaryUrl) {
      addExternalAction(actions, show.primaryUrl, 'source-yfsp', '资料链接');
    }
    if (!actions.length) {
      actions.push('<span class="card-action disabled">待匹配链接</span>');
    }
    return actions.join('');
  }

  function addExternalAction(actions, url, sourceClass, label) {
    const safeUrl = safeExternalUrl(url);
    if (!safeUrl) return;
    actions.push(`<a class="card-action ${sourceClass}" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  }

  function updateStats(shows) {
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

    animateNum('statTotal', total);
    animateNum('statOngoing', ongoing);
    animateNum('statComplete', complete);
    animateNum('statHighScore', highScore);
  }

  const _numTimers = new Map();

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
  let _cachedMaxYear = 0;
  function getCurrentDataYear() {
    if (_cachedMaxYear) return _cachedMaxYear;
    const clientYear = new Date().getFullYear();
    const updatedYear = new Date(allData?.lastUpdated || 0).getFullYear();
    const preferredYear = updatedYear >= 1900 && updatedYear <= clientYear ? updatedYear : clientYear;
    const allShows = [...(allData?.koreanDramas || []), ...(allData?.chineseVariety || [])];
    if (allShows.some(show => toFiniteNumber(show?.year) === preferredYear)) {
      _cachedMaxYear = preferredYear;
      return _cachedMaxYear;
    }
    // 数据跨年暂未更新时回退到不晚于客户端年份的最新可用年份；待播预告不能劫持整页。
    _cachedMaxYear = allShows.reduce((max, s) => {
      const year = toFiniteNumber(s?.year);
      return year >= 1900 && year <= clientYear ? Math.max(max, year) : max;
    }, 0);
    return _cachedMaxYear || clientYear;
  }

  function getValidTime(value) {
    const year = toFiniteNumber(value, NaN);
    if (Number.isInteger(year) && year >= 1900 && year <= 2200) return Date.UTC(year, 0, 1);
    const time = new Date(value || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function toText(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }

  function toPositiveInteger(value) {
    const number = toFiniteNumber(value, NaN);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
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

  function isShowDataset(value) {
    return !!value && typeof value === 'object' &&
      Array.isArray(value.koreanDramas) &&
      Array.isArray(value.chineseVariety) &&
      [...value.koreanDramas, ...value.chineseVariety].every(show => show && typeof show === 'object' && !Array.isArray(show));
  }

  function formatSourceUpdateInfo(label, value) {
    if (!value) return `${label} · 快照时间未知`;
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return `${label} · 快照时间未知`;
    const stale = Date.now() - time.getTime() > SOURCE_STALE_AFTER_MS;
    return `${label}快照: ${time.toLocaleDateString('zh-CN')}${stale ? ' · 数据较旧' : ''}`;
  }

  function isFreshSourceSnapshot(value) {
    const updated = Date.parse(value || '');
    if (!Number.isFinite(updated)) return false;
    const age = Date.now() - updated;
    return age >= 0 && age <= SOURCE_STALE_AFTER_MS;
  }

  function updateSourceInfo(label, value) {
    const element = document.getElementById('updateInfo');
    if (element) element.textContent = formatSourceUpdateInfo(label, value);
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

    const firstViewport = index < 4;
    let responsive = '';
    try {
      const parsed = new URL(source);
      if (parsed.hostname === 'image.tmdb.org' && /\/t\/p\/(?:original|w\d+)\//u.test(parsed.pathname)) {
        const path342 = parsed.pathname.replace(/\/t\/p\/(?:original|w\d+)\//u, '/t/p/w342/');
        const path500 = parsed.pathname.replace(/\/t\/p\/(?:original|w\d+)\//u, '/t/p/w500/');
        const url342 = `${parsed.origin}${path342}${parsed.search}`;
        const url500 = `${parsed.origin}${path500}${parsed.search}`;
        responsive = ` srcset="${escapeHtml(url342)} 342w, ${escapeHtml(url500)} 500w" sizes="(max-width: 480px) 50vw, (max-width: 768px) 33vw, 280px"`;
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

    const grid = document.getElementById('showGrid');
    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'true');
    document.getElementById('loading').style.display = 'block';
    document.getElementById('empty').style.display = 'none';
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

  function renderExpiredRemoteSnapshot(tab, requestVersion, controller, label) {
    if (!completeRemoteTab(tab, requestVersion, controller, [])) return false;
    const info = document.getElementById('updateInfo');
    if (info) info.textContent = `${label} · 快照已过期，暂不展示`;
    const empty = document.getElementById('empty');
    empty.style.display = 'block';
    empty.innerHTML = `<p>⏳ ${escapeHtml(label)}快照已超过14天，暂不展示，等待下一次更新。</p>`;
    return true;
  }

  function showRemoteTabError(tab, requestVersion, controller, message) {
    if (!isActiveTabRequest(tab, requestVersion, controller)) return;
    _isTabLoading = false;
    const grid = document.getElementById('showGrid');
    grid.setAttribute('aria-busy', 'false');
    document.getElementById('loading').style.display = 'none';
    const empty = document.getElementById('empty');
    empty.style.display = 'block';
    empty.innerHTML = `<p>${escapeHtml(message)}</p>`;
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
  async function fetchAndRenderTVmaze(requestVersion) {
    const controller = startRemoteTabRequest(requestVersion);
    if (!controller) return;

    try {
      let shows = _tvmazeCache;
      if (!shows || Date.now() - _tvmazeCachedAt >= REMOTE_CACHE_TTL_MS) {
        // 回溯最多 7 天找到有数据的日期(TVMaze 可能对某些日期无数据)
        const showMap = new Map();
        for (let i = 0; i < 7; i++) {
          const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
          const response = await fetch(`https://api.tvmaze.com/schedule?country=KR&date=${d}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`TVmaze HTTP ${response.status}`);
          const data = await response.json();
          if (!Array.isArray(data)) throw new Error('TVmaze returned invalid data');
          for (const entry of data) {
            const show = entry?.show;
            if (!show?.id || showMap.has(show.id)) continue;
            showMap.set(show.id, { ...show, latestEpisode: entry, airDate: d });
          }
          if (showMap.size >= 5) break;
        }
        shows = [...showMap.values()].sort((a, b) => toFiniteNumber(b.rating?.average) - toFiniteNumber(a.rating?.average));
        _tvmazeCache = shows;
        _tvmazeCachedAt = Date.now();
      }

      if (!completeRemoteTab('tvmaze', requestVersion, controller, shows)) return;
      updateSourceInfo('TVmaze 韩剧时间表', new Date(_tvmazeCachedAt).toISOString());

      if (!shows.length) {
        const empty = document.getElementById('empty');
        empty.style.display = 'block';
        empty.innerHTML = '<p>📡 今日暂无韩国电视剧播出</p>';
      }
    } catch (e) {
      const message = e?.name === 'AbortError'
        ? '⌛ TVmaze 请求超时,请稍后重试'
        : '😢 TVmaze 数据加载失败,请稍后刷新';
      showRemoteTabError('tvmaze', requestVersion, controller, message);
    } finally {
      finishRemoteTabRequest(controller);
    }
  }

  function renderTVmazeCard(show, index) {
    const ep = show.latestEpisode;
    const epInfo = ep ? `S${ep.season}E${ep.number}` : '';
    const airtime = ep?.airtime || '';
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

  // ── 外部数据源: Trakt.tv 全球热度 ─────────────────────────
  let _traktCache = null;
  let _traktCachedAt = 0;
  async function fetchAndRenderTrakt(requestVersion) {
    const controller = startRemoteTabRequest(requestVersion);
    if (!controller) return;

    try {
      if (!_traktCache || Date.now() - _traktCachedAt >= REMOTE_CACHE_TTL_MS) {
        const resp = await fetch('data/trakt_shows.json', { signal: controller.signal });
        if (!resp.ok) throw new Error('Trakt data not found');
        const traktData = await resp.json();
        if (!traktData || !Array.isArray(traktData.shows)) throw new Error('Invalid Trakt data');
        const fresh = isFreshSourceSnapshot(traktData.lastUpdated);
        _traktCache = {
          shows: fresh
            ? traktData.shows.filter(show => show && typeof show === 'object' && !Array.isArray(show))
            : [],
          lastUpdated: traktData.lastUpdated,
          unavailable: !fresh,
        };
        _traktCachedAt = Date.now();
      }

      if (_traktCache.unavailable) {
        renderExpiredRemoteSnapshot('trakt', requestVersion, controller, 'Trakt.tv 热度');
        return;
      }
      if (!completeRemoteTab('trakt', requestVersion, controller, _traktCache.shows)) return;
      updateSourceInfo('Trakt.tv 热度', _traktCache.lastUpdated);

      if (!_traktCache.shows.length) {
        const empty = document.getElementById('empty');
        empty.style.display = 'block';
        empty.innerHTML = '<p>🔥 暂无 Trakt.tv 热度数据</p>';
      }
    } catch (e) {
      const message = e?.name === 'AbortError'
        ? '⌛ Trakt.tv 请求超时,请稍后重试'
        : '😢 Trakt.tv 数据加载失败';
      showRemoteTabError('trakt', requestVersion, controller, message);
    } finally {
      finishRemoteTabRequest(controller);
    }
  }

  function renderTraktCard(show, index) {
    const overview = toText(show.overview).slice(0, 150);
    const genres = Array.isArray(show.genres) ? show.genres.slice(0, 3) : [];
    const rawYear = toPositiveInteger(show.year);
    const year = rawYear >= 1900 && rawYear <= 2200 ? rawYear : 0;
    const traktUrl = safeExternalUrl(show.traktUrl, REMOTE_LINK_HOSTS.trakt);
    const tmdbId = toPositiveInteger(show.tmdbId);
    const watchers = Math.max(0, toFiniteNumber(show.watchers));

    return `
      <article class="show-card source-trakt" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster"><div class="placeholder">🔥</div></div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(show.title)}${year ? ` (${escapeHtml(String(year))})` : ''}</h3>
          ${show.titleCn ? `<div class="card-title-en">${escapeHtml(show.titleCn)}</div>` : ''}
          <div class="card-meta">
            ${genres.map(g => `<span class="meta-tag">${escapeHtml(g)}</span>`).join('')}
          </div>
          ${watchers ? `<div class="card-trakt-hot">🔥 ${escapeHtml(Math.round(watchers).toLocaleString('zh-CN'))} 人在追</div>` : ''}
          <p class="card-desc">${escapeHtml(overview)}</p>
          <div class="card-footer">
            <span class="card-status ${show.status === 'ended' ? '' : 'ongoing'}">${show.status === 'ended' ? '已完结' : '连载中'}</span>
            <span class="card-source-label">🔥 Trakt.tv</span>
          </div>
          <div class="card-actions">
            ${traktUrl ? `<a class="card-action source-trakt-link" href="${escapeHtml(traktUrl)}" target="_blank" rel="noopener noreferrer">Trakt 详情</a>` : ''}
            ${tmdbId ? `<a class="card-action source-tmdb" href="https://www.themoviedb.org/tv/${encodeURIComponent(tmdbId)}" target="_blank" rel="noopener noreferrer">TMDB</a>` : ''}
          </div>
        </div>
      </article>`;
  }

  // ── 外部数据源: MyDramaList 社区精选 ─────────────────────────
  let _mdlCache = null;
  let _mdlCachedAt = 0;
  async function fetchAndRenderMDL(requestVersion) {
    const controller = startRemoteTabRequest(requestVersion);
    if (!controller) return;

    try {
      if (!_mdlCache || Date.now() - _mdlCachedAt >= REMOTE_CACHE_TTL_MS) {
        const resp = await fetch('data/mdl_shows.json', { signal: controller.signal });
        if (!resp.ok) throw new Error('MDL data not found');
        const mdlData = await resp.json();
        if (!mdlData || !Array.isArray(mdlData.shows)) throw new Error('Invalid MDL data');
        const fresh = isFreshSourceSnapshot(mdlData.lastUpdated);
        const shows = fresh
          ? mdlData.shows
            .filter(show => show && typeof show === 'object' && !Array.isArray(show))
            .map(show => ({ ...show, isComplete: true, status: 'ended' }))
            .sort((a, b) => toFiniteNumber(b.mdlRating) - toFiniteNumber(a.mdlRating))
          : [];
        _mdlCache = { shows, lastUpdated: mdlData.lastUpdated, unavailable: !fresh };
        _mdlCachedAt = Date.now();
      }

      if (_mdlCache.unavailable) {
        renderExpiredRemoteSnapshot('mdl', requestVersion, controller, 'MyDramaList 社区');
        return;
      }
      if (!completeRemoteTab('mdl', requestVersion, controller, _mdlCache.shows)) return;
      updateSourceInfo('MyDramaList 社区', _mdlCache.lastUpdated);

      if (!_mdlCache.shows.length) {
        const empty = document.getElementById('empty');
        empty.style.display = 'block';
        empty.innerHTML = '<p>🎯 暂无 MDL 社区精选数据</p>';
      }
    } catch (e) {
      const message = e?.name === 'AbortError'
        ? '⌛ MDL 请求超时,请稍后重试'
        : '😢 MDL 社区精选数据加载失败';
      showRemoteTabError('mdl', requestVersion, controller, message);
    } finally {
      finishRemoteTabRequest(controller);
    }
  }

  function renderMDLCard(show, index) {
    const genres = Array.isArray(show.genres) ? show.genres.slice(0, 3) : [];
    const tags = Array.isArray(show.tags) ? show.tags.slice(0, 3) : [];
    const rawYear = toPositiveInteger(show.year);
    const year = rawYear >= 1900 && rawYear <= 2200 ? rawYear : 0;
    const rating = Math.max(0, Math.min(10, toFiniteNumber(show.mdlRating)));
    const watchers = Math.max(0, toFiniteNumber(show.watchers));
    const episodes = toPositiveInteger(show.episodes);
    const description = toText(show.description).slice(0, 500);
    const mdlUrl = safeExternalUrl(show.mdlUrl, REMOTE_LINK_HOSTS.mdl);

    return `
      <article class="show-card source-mdl" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster"><div class="placeholder">🎯</div></div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(show.title)}${year ? ` (${escapeHtml(String(year))})` : ''}</h3>
          ${show.titleEn ? `<div class="card-title-en">${escapeHtml(show.titleEn)}</div>` : ''}
          <div class="card-meta">
            ${show.network ? `<span class="meta-tag region">${escapeHtml(show.network)}</span>` : ''}
            ${genres.map(g => `<span class="meta-tag">${escapeHtml(g)}</span>`).join('')}
          </div>
          ${tags.length ? `<div class="card-tags">${tags.map(t => `<span class="mdl-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          <div class="card-mdl-stats">
            <span class="mdl-rating">⭐ ${rating.toFixed(1)}/10</span>
            ${watchers ? `<span class="mdl-watchers">👁 ${escapeHtml(watchers >= 1000 ? (watchers / 1000).toFixed(1) + 'k' : String(Math.round(watchers)))} watchers</span>` : ''}
          </div>
          <p class="card-desc">${escapeHtml(description)}</p>
          <div class="card-footer">
            <span class="card-status">${episodes ? escapeHtml(String(episodes)) + '集完结' : '已完结'}</span>
            <span class="card-source-label">🎯 MyDramaList</span>
          </div>
          <div class="card-actions">
            ${mdlUrl ? `<a class="card-action source-mdl-link" href="${escapeHtml(mdlUrl)}" target="_blank" rel="noopener noreferrer">MDL 详情</a>` : ''}
            <a class="card-action source-tmdb" href="https://www.themoviedb.org/search?query=${encodeURIComponent(show.titleEn || show.title)}" target="_blank" rel="noopener noreferrer">TMDB</a>
          </div>
        </div>
      </article>`;
  }

})();
