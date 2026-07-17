/**
 * 韩剧 & 综艺推荐网站 - 前端应用
 */

(function () {
  'use strict';

  const DATA_URL = 'data/shows.json';
  let allData = null;
  let currentShows = [];
  let activeTabName = 'korean';


  // ── 初始化 ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindTabs();
    bindFilters();
    await loadData();
  }

  async function loadData() {
    try {
      const cacheBuster = Math.floor(Date.now() / 7200000);
      const resp = await fetch(DATA_URL + '?t=' + cacheBuster);
      if (!resp.ok) throw new Error('Data not found');
      allData = await resp.json();
      updateInfo();
      // 从 URL hash 恢复上次选择的标签,默认韩剧推荐
      const hashTab = location.hash.slice(1);
      const validTabs = ['korean', 'year2026', 'variety2026', 'variety', 'new', 'classic'];
      switchTab(validTabs.includes(hashTab) ? hashTab : 'korean');
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
    const timeStr = time.toLocaleString('zh-CN', { hour12: false });
    const kr = allData.stats?.koreanDramas ?? (allData.koreanDramas || []).length;
    const vr = allData.stats?.chineseVariety ?? (allData.chineseVariety || []).length;
    el.textContent = `最后更新: ${timeStr} · 共 ${kr} 部韩剧 · ${vr} 档综艺`;
  }

  // ── 标签切换 ──────────────────────────────────────────
  function bindTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    activeTabName = tab;
    history.replaceState(null, '', '#' + tab);
    document.querySelectorAll('.tab').forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (!allData) return;

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
        fetchAndRenderTVmaze();
        return;
      case 'trakt':
        fetchAndRenderTrakt();
        return;
      case 'mdl':
        fetchAndRenderMDL();
        return;
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

  function applyFilters(animate = false) {
    let shows = [...currentShows];

    // 状态筛选
    const status = document.getElementById('filterStatus').value;
    if (status === 'ongoing') {
      shows = shows.filter(s => {
        const complete = s.isComplete ?? (s.status === 'Ended' || s.status === 'ended');
        return !complete;
      });
    } else if (status === 'complete') {
      shows = shows.filter(s => {
        const complete = s.isComplete ?? (s.status === 'Ended' || s.status === 'ended');
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
        (s.title || '').toLowerCase().includes(query) ||
        (s.name || '').toLowerCase().includes(query) ||
        (s.actor || '').toLowerCase().includes(query) ||
        (s.contentType || (s.genres || []).join('/') || '').toLowerCase().includes(query)
      );
    }

    // 排序
    const sort = document.getElementById('sortBy').value;
    switch (sort) {
      case 'recommend':
        shows.sort((a, b) => (b.recommendScore || b.mdlRating || b.rating?.average || 0) - (a.recommendScore || a.mdlRating || a.rating?.average || 0));
        break;
      case 'score':
        shows.sort((a, b) => (b.score || b.rating?.average || b.mdlRating || 0) - (a.score || a.rating?.average || a.mdlRating || 0));
        break;
      case 'newest':
        shows.sort((a, b) => getValidTime(b.publishTime || b.airDate || b.year) - getValidTime(a.publishTime || a.airDate || a.year));
        break;
      case 'popular':
        shows.sort((a, b) => (b.playCount || b.watchers || 0) - (a.playCount || a.watchers || 0));
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
    if (show.year >= getCurrentDataYear()) badges.push('<span class="badge badge-new">新剧</span>');
    if (show.isComplete) badges.push('<span class="badge badge-complete">完结</span>');
    else if (show.isSerial) badges.push('<span class="badge badge-ongoing">连载</span>');

    const newBadge = show.isNew ? '<div class="card-new-badge">NEW</div>' : '';

    const coverImg = safeExternalUrl(show.coverImg);
    const posterContent = coverImg
      ? `<img src="${escapeHtml(coverImg)}" alt="${escapeHtml(show.title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=placeholder>🎬</div>'">`
      : '<div class="placeholder">🎬</div>';

    const statusText = show.isComplete
      ? (show.totalEpisodes ? `已完结 · ${show.totalEpisodes}集` : '已完结')
      : show.mediaType === '综艺'
        ? (show.updateStatus || '更新中')
        : show.currentEpisode
          ? `更新至第${show.currentEpisode}集${show.totalEpisodes ? ' / 共' + show.totalEpisodes + '集' : ''}`
          : show.updateStatus || '未知';

    const statusClass = show.isComplete ? '' : 'ongoing';

    const viewsText = show.playCount > 10000
      ? (show.playCount / 10000).toFixed(1) + '万次播放'
      : show.playCount > 0
        ? show.playCount + '次播放'
        : '';

    const actors = show.actor ? show.actor.split(',').slice(0, 3).join(' / ') : '';

    const tags = [];
    if (show.regional) tags.push(`<span class="meta-tag region">${escapeHtml(show.regional)}</span>`);
    if (show.contentType) {
      show.contentType.split(/[·/]/).slice(0, 3).forEach(g => {
        tags.push(`<span class="meta-tag">${escapeHtml(g.trim())}</span>`);
      });
    }
    if (show.lang && show.lang !== '国语' && show.lang !== '韩语') {
      tags.push(`<span class="meta-tag">${escapeHtml(show.lang)}</span>`);
    }

    const recommendWidth = Math.min(100, (show.recommendScore || 0) / 1.5);

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
      const complete = s.isComplete ?? (s.status === 'Ended' || s.status === 'ended');
      return !complete;
    }).length;
    const complete = shows.filter(s => {
      const complete = s.isComplete ?? (s.status === 'Ended' || s.status === 'ended');
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
    // 从实际数据中的最大年份推导,而非更新时间戳(避免跨年时"新剧"tab 为空)
    const allShows = [...(allData?.koreanDramas || []), ...(allData?.chineseVariety || [])];
    _cachedMaxYear = allShows.reduce((max, s) => Math.max(max, s.year || 0), 0);
    return _cachedMaxYear || new Date().getFullYear();
  }

  function getValidTime(value) {
    const time = new Date(value || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  // 文本与属性上下文均安全：textContent→innerHTML 不会转义引号,
  // 而本文件所有输出都插入到双引号属性内(src/href/alt),故需显式转义引号。
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
  }

  function safeExternalUrl(value) {
    const url = String(value || '').trim();
    // reject protocol-injection and attribute-breakout characters
    if (!/^https?:\/\//i.test(url) || /["'<>]/.test(url)) return '';
    return url;
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ── 外部数据源: TVmaze 韩剧时间表 ─────────────────────────
  async function fetchAndRenderTVmaze() {
    const grid = document.getElementById('showGrid');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty');
    loading.style.display = 'block';
    empty.style.display = 'none';
    grid.innerHTML = '';

    try {
      // 回溯最多 7 天找到有数据的日期(TVMaze 可能对某些日期无数据)
      const showMap = new Map();
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        const data = await fetch(`https://api.tvmaze.com/schedule?country=KR&date=${d}`).then(r => r.json());
        for (const entry of data) {
          const show = entry.show;
          if (!show?.id || showMap.has(show.id)) continue;
          showMap.set(show.id, { ...show, latestEpisode: entry, airDate: d });
        }
        if (showMap.size >= 5) break;
      }

      // 按评分降序
      const shows = [...showMap.values()].sort((a, b) => (b.rating?.average || 0) - (a.rating?.average || 0));
      currentShows = shows;
      applyFilters(true);

      if (!shows.length) {
        empty.style.display = 'block';
        empty.innerHTML = '<p>📡 今日暂无韩国电视剧播出</p>';
      }
    } catch (e) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      empty.innerHTML = '<p>😢 TVmaze 数据加载失败,请稍后刷新</p>';
    }
  }

  function renderTVmazeCard(show, index) {
    const ep = show.latestEpisode;
    const epInfo = ep ? `S${ep.season}E${ep.number}` : '';
    const airtime = ep?.airtime || '';
    const network = show.network?.name || '';
    const genres = (show.genres || []).slice(0, 3);
    const rating = show.rating?.average;
    const img = show.image?.medium || show.image?.original || '';
    const summary = (show.summary || '').replace(/<[^>]+>/g, '').slice(0, 120);
    const posterContent = img
      ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(show.name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=placeholder>📺</div>'">`
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
            ${rating ? `<span class="schedule-rating">⭐ ${rating.toFixed(1)}</span>` : ''}
          </div>
          <p class="card-desc">${escapeHtml(summary)}</p>
          <div class="card-footer">
            <span class="card-status ${show.status === 'Running' ? 'ongoing' : ''}">${show.status === 'Running' ? '连载中' : '已完结'}</span>
            <span class="card-source-label">📡 TVmaze</span>
          </div>
          <div class="card-actions">
            <a class="card-action source-tvmaze-link" href="${escapeHtml(show.url || '#')}" target="_blank" rel="noopener noreferrer">TVmaze 详情</a>
            <a class="card-action source-tmdb" href="https://www.themoviedb.org/search?query=${encodeURIComponent(show.name)}" target="_blank" rel="noopener noreferrer">TMDB</a>
          </div>
        </div>
      </article>`;
  }

  // ── 外部数据源: Trakt.tv 全球热度 ─────────────────────────
  let _traktShows = null;
  async function fetchAndRenderTrakt() {
    const grid = document.getElementById('showGrid');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty');
    loading.style.display = 'block';
    empty.style.display = 'none';
    grid.innerHTML = '';

    try {
      if (!_traktShows) {
        const resp = await fetch('data/trakt_shows.json');
        if (!resp.ok) throw new Error('Trakt data not found');
        const traktData = await resp.json();
        _traktShows = traktData.shows || [];
      }

      currentShows = _traktShows;
      applyFilters(true);

      if (!_traktShows.length) {
        empty.style.display = 'block';
        empty.innerHTML = '<p>🔥 暂无 Trakt.tv 热度数据</p>';
      }
    } catch (e) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      empty.innerHTML = '<p>😢 Trakt.tv 数据加载失败</p>';
    }
  }

  function renderTraktCard(show, index) {
    const overview = (show.overview || '').slice(0, 150);
    const genres = (show.genres || []).slice(0, 3);
    const year = show.year || '';
    const traktUrl = show.traktUrl || '';
    const tmdbId = show.tmdbId || 0;

    return `
      <article class="show-card source-trakt" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster"><div class="placeholder">🔥</div></div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(show.title)}${year ? ` (${year})` : ''}</h3>
          ${show.titleCn ? `<div class="card-title-en">${escapeHtml(show.titleCn)}</div>` : ''}
          <div class="card-meta">
            ${genres.map(g => `<span class="meta-tag">${escapeHtml(g)}</span>`).join('')}
          </div>
          ${show.watchers ? `<div class="card-trakt-hot">🔥 ${show.watchers.toLocaleString()} 人在追</div>` : ''}
          <p class="card-desc">${escapeHtml(overview)}</p>
          <div class="card-footer">
            <span class="card-status ${show.status === 'ended' ? '' : 'ongoing'}">${show.status === 'ended' ? '已完结' : '连载中'}</span>
            <span class="card-source-label">🔥 Trakt.tv</span>
          </div>
          <div class="card-actions">
            ${traktUrl ? `<a class="card-action source-trakt-link" href="${escapeHtml(traktUrl)}" target="_blank" rel="noopener noreferrer">Trakt 详情</a>` : ''}
            ${tmdbId ? `<a class="card-action source-tmdb" href="https://www.themoviedb.org/tv/${tmdbId}" target="_blank" rel="noopener noreferrer">TMDB</a>` : ''}
          </div>
        </div>
      </article>`;
  }

  // ── 外部数据源: MyDramaList 社区精选 ─────────────────────────
  async function fetchAndRenderMDL() {
    const grid = document.getElementById('showGrid');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty');
    loading.style.display = 'block';
    empty.style.display = 'none';
    grid.innerHTML = '';

    try {
      const resp = await fetch('data/mdl_shows.json');
      if (!resp.ok) throw new Error('MDL data not found');
      const mdlData = await resp.json();
      const shows = mdlData.shows || [];

      // 按 MDL 评分降序
      shows.sort((a, b) => (b.mdlRating || 0) - (a.mdlRating || 0));
      currentShows = shows;
      applyFilters(true);

      if (!shows.length) {
        empty.style.display = 'block';
        empty.innerHTML = '<p>🎯 暂无 MDL 社区精选数据</p>';
      }
    } catch (e) {
      loading.style.display = 'none';
      empty.style.display = 'block';
      empty.innerHTML = '<p>😢 MDL 社区精选数据加载失败</p>';
    }
  }

  function renderMDLCard(show, index) {
    const genres = (show.genres || []).slice(0, 3);
    const tags = (show.tags || []).slice(0, 3);
    const year = show.year || '';
    const rating = show.mdlRating || 0;
    const watchers = show.watchers || 0;
    const description = show.description || '';

    return `
      <article class="show-card source-mdl" style="animation-delay:${Math.min(index * 0.05, 0.5)}s">
        <div class="card-poster"><div class="placeholder">🎯</div></div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(show.title)}${year ? ` (${year})` : ''}</h3>
          ${show.titleEn ? `<div class="card-title-en">${escapeHtml(show.titleEn)}</div>` : ''}
          <div class="card-meta">
            ${show.network ? `<span class="meta-tag region">${escapeHtml(show.network)}</span>` : ''}
            ${genres.map(g => `<span class="meta-tag">${escapeHtml(g)}</span>`).join('')}
          </div>
          ${tags.length ? `<div class="card-tags">${tags.map(t => `<span class="mdl-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          <div class="card-mdl-stats">
            <span class="mdl-rating">⭐ ${rating.toFixed(1)}/10</span>
            ${watchers ? `<span class="mdl-watchers">👁 ${watchers >= 1000 ? (watchers / 1000).toFixed(1) + 'k' : watchers} watchers</span>` : ''}
          </div>
          <p class="card-desc">${escapeHtml(description)}</p>
          <div class="card-footer">
            <span class="card-status">${show.episodes ? show.episodes + '集完结' : '已完结'}</span>
            <span class="card-source-label">🎯 MyDramaList</span>
          </div>
          <div class="card-actions">
            ${show.mdlUrl ? `<a class="card-action source-mdl-link" href="${escapeHtml(show.mdlUrl)}" target="_blank" rel="noopener noreferrer">MDL 详情</a>` : ''}
            <a class="card-action source-tmdb" href="https://www.themoviedb.org/search?query=${encodeURIComponent(show.titleEn || show.title)}" target="_blank" rel="noopener noreferrer">TMDB</a>
          </div>
        </div>
      </article>`;
  }

})();
