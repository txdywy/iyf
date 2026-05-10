/**
 * 韩剧 & 综艺推荐网站 - 前端应用
 */

(function () {
  'use strict';

  const DATA_URL = 'data/shows.json';
  let allData = null;
  let currentTab = 'korean';
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
      switchTab('korean');
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
    el.textContent = `最后更新: ${timeStr} · 共 ${allData.stats.koreanDramas} 部韩剧 · ${allData.stats.chineseVariety} 档综艺`;
  }

  // ── 标签切换 ──────────────────────────────────────────
  function bindTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

    if (!allData) return;

    let shows = [];
    switch (tab) {
      case 'korean':
        shows = allData.koreanDramas || [];
        break;
      case 'year2026':
        shows = (allData.koreanDramas || []).filter(s => s.year === 2026);
        break;
      case 'variety2026':
        // 2026年新综艺：当年新综艺 + 经典搞笑综艺
        shows = (allData.chineseVariety || []).filter(s =>
          s.year >= new Date().getFullYear() || s.isClassic
        );
        break;
      case 'variety':
        shows = allData.chineseVariety || [];
        break;
      case 'new':
        shows = [...(allData.koreanDramas || []), ...(allData.chineseVariety || [])]
          .filter(s => s.year >= new Date().getFullYear())
          .sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime));
        break;
      case 'classic':
        shows = (allData.koreanDramas || []).filter(s => s.isClassic || s.score >= 8.5);
        break;
    }

    currentShows = shows;
    applyFilters();
  }

  // ── 筛选 ──────────────────────────────────────────
  function bindFilters() {
    document.getElementById('filterStatus').addEventListener('change', applyFilters);
    document.getElementById('filterScore').addEventListener('change', applyFilters);
    document.getElementById('sortBy').addEventListener('change', applyFilters);
    document.getElementById('searchInput').addEventListener('input', debounce(applyFilters, 300));
  }

  function applyFilters() {
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
        s.title.toLowerCase().includes(query) ||
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
        shows.sort((a, b) => new Date(b.publishTime || 0) - new Date(a.publishTime || 0));
        break;
      case 'popular':
        shows.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
        break;
    }

    renderShows(shows);
    updateStats(shows);
  }

  // ── 渲染 ──────────────────────────────────────────
  function renderShows(shows) {
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
    grid.innerHTML = shows.map((show, i) => renderCard(show, i)).join('');
  }

  function renderCard(show, index) {
    const badges = [];
    if (show.aiScore) badges.push(`<span class="badge badge-ai">🤖 ${show.aiScore}/100</span>`);
    if (show.score >= 8) badges.push(`<span class="badge badge-score">⭐ ${show.score}</span>`);
    if (show.isClassic) badges.push('<span class="badge badge-classic">经典</span>');
    if (show.isAutoDiscovered) badges.push('<span class="badge badge-discovered">新发现</span>');
    if (show.year >= new Date().getFullYear()) badges.push('<span class="badge badge-new">新剧</span>');
    if (show.isComplete) badges.push('<span class="badge badge-complete">完结</span>');
    else if (show.isSerial) badges.push('<span class="badge badge-ongoing">连载</span>');

    const newBadge = show.isNew ? '<div class="card-new-badge">NEW</div>' : '';

    const posterContent = show.coverImg
      ? `<img src="${escapeHtml(show.coverImg)}" alt="${escapeHtml(show.title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=placeholder>🎬</div>'">`
      : '<div class="placeholder">🎬</div>';

    const statusText = show.isComplete
      ? `已完结 · ${show.totalEpisodes || '?'}集`
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
          ${show.score > 0 ? `<div class="card-score-float">⭐ ${show.score}</div>` : ''}
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
    if (show.tmdbUrl) {
      actions.push(`<a class="card-action source-tmdb" href="${escapeHtml(show.tmdbUrl)}" target="_blank" rel="noopener">TMDB资料</a>`);
    }
    if (show.doubanUrl) {
      actions.push(`<a class="card-action source-douban" href="${escapeHtml(show.doubanUrl)}" target="_blank" rel="noopener">豆瓣资料</a>`);
    }
    if (show.wikipediaUrl) {
      actions.push(`<a class="card-action source-wikipedia" href="${escapeHtml(show.wikipediaUrl)}" target="_blank" rel="noopener">Wikipedia</a>`);
    }
    if (show.imdbUrl) {
      actions.push(`<a class="card-action source-imdb" href="${escapeHtml(show.imdbUrl)}" target="_blank" rel="noopener">IMDb资料</a>`);
    }
    if (!actions.length) {
      actions.push('<span class="card-action disabled">待匹配链接</span>');
    }
    return actions.join('');
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

  function animateNum(id, target) {
    const el = document.getElementById(id);
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;

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
      }
    }, 30);
  }

  // ── 工具函数 ──────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

})();
