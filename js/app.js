/**
 * 韩剧 & 综艺推荐网站 - 前端应用
 */

(function () {
  'use strict';

  const DATA_URL = 'data/shows.json';
  let allData = null;
  let currentShows = [];

  // ── 初始化 ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindTabs();
    bindFilters();
    await loadData();
  }

  async function loadData() {
    try {
      const resp = await fetch(DATA_URL + '?t=' + Date.now());
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
    if (status === 'ongoing') shows = shows.filter(s => !s.isComplete);
    else if (status === 'complete') shows = shows.filter(s => s.isComplete);

    // 评分筛选
    const minScore = parseFloat(document.getElementById('filterScore').value);
    if (minScore > 0) shows = shows.filter(s => s.score >= minScore);

    // 搜索
    const query = document.getElementById('searchInput').value.trim().toLowerCase();
    if (query) {
      shows = shows.filter(s =>
        (s.title || '').toLowerCase().includes(query) ||
        (s.actor || '').toLowerCase().includes(query) ||
        (s.contentType || '').toLowerCase().includes(query)
      );
    }

    // 排序
    const sort = document.getElementById('sortBy').value;
    switch (sort) {
      case 'recommend':
        shows.sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0));
        break;
      case 'score':
        shows.sort((a, b) => (b.score || 0) - (a.score || 0));
        break;
      case 'newest':
        shows.sort((a, b) => getValidTime(b.publishTime) - getValidTime(a.publishTime));
        break;
      case 'popular':
        shows.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
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
    grid.innerHTML = shows.map((show, i) => renderCard(show, i)).join('');
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
    const ongoing = shows.filter(s => !s.isComplete).length;
    const complete = shows.filter(s => s.isComplete).length;
    const highScore = shows.filter(s => s.score >= 8).length;

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

})();
