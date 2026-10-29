import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

function createApp(fetchImpl = async () => { throw new Error('unexpected fetch'); }, cachedData = null, cacheTimestamp = Date.now()) {
  const elements = new Map();
  const document = { activeElement: null };
  const view = {
    scrollY: 0, innerHeight: 600,
    addEventListener() {}, matchMedia: () => ({ matches: true }),
    scrollBy(x, y) { this.scrollY += y; },
  };
  function element(id = '', value = '') {
    const attributes = new Map();
    const classes = new Set();
    const listeners = new Map();
    let html = '';
    let hidden = false;
    let display = '';
    const node = {
      id, value, textContent: '0', style: {}, hidden: false, children: [], dataset: {}, tabIndex: -1,
      htmlWrites: 0, appendWrites: 0,
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
        toggle(name, force = !classes.has(name)) {
          if (force) classes.add(name);
          else classes.delete(name);
          return force;
        },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name); },
      addEventListener(name, callback) { listeners.set(name, callback); },
      dispatch(name, event = {}) {
        const result = listeners.get(name)?.(event);
        return name === 'click' && typeof node.onclick === 'function' ? node.onclick(event) : result;
      },
      focus() { document.activeElement = node; },
      scrollIntoView() { node.scrolled = true; },
      contains(target) { return node === target || node.children.some(child => child.contains(target)); },
      querySelectorAll(selector) { return selector === 'a[href]' ? node.children.filter(child => child.tagName === 'A') : []; },
      querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
      getBoundingClientRect: () => ({ top: 10000 }),
      insertAdjacentHTML(position, value) {
        assert.equal(position, 'beforeend');
        node.appendWrites++;
        html += value;
        node.children.push(...cards(value));
      },
    };
    const blurHiddenDescendant = () => {
      if (node.contains(document.activeElement)) document.activeElement = document.body;
    };
    Object.defineProperty(node, 'hidden', {
      get: () => hidden,
      set(value) {
        hidden = Boolean(value);
        if (hidden) blurHiddenDescendant();
      },
    });
    Object.defineProperty(node.style, 'display', {
      get: () => display,
      set(value) {
        display = value;
        if (display === 'none') blurHiddenDescendant();
      },
    });
    const cards = value => Array.from(value.matchAll(/<article\b[\s\S]*?<\/article>/gu), ([markup]) => {
      const card = element();
      card.children = Array.from(markup.matchAll(/<a\b[^>]*href="([^"]+)"/gu), ([, href]) => {
        const link = element();
        link.tagName = 'A';
        link.setAttribute('href', href.replace(/&amp;/gu, '&'));
        return link;
      });
      card.getBoundingClientRect = () => {
        const top = 700 + node.children.indexOf(card) * 100 - view.scrollY;
        return { top, bottom: top + 100 };
      };
      return card;
    });
    Object.defineProperty(node, 'innerHTML', {
      get: () => html,
      set(value) {
        node.htmlWrites++;
        if (node.contains(document.activeElement)) document.activeElement = document.body;
        html = value;
        node.children = cards(value);
      },
    });
    return node;
  }
  document.body = element('body');
  for (const id of [
    'showGrid', 'loading', 'empty', 'emptyMessage', 'emptyAction', 'loadMore', 'loadMoreButton',
    'loadMoreStatus', 'resetFilters', 'resultSummary', 'statTotal', 'statOngoing', 'statComplete',
    'statHighScore', 'updateInfo', 'yearTabLabel', 'varietyYearTabLabel', 'mainContent',
  ]) elements.set(id, element(id));
  for (const [id, value] of [['filterStatus', 'all'], ['filterScore', '0'], ['sortBy', 'recommend'], ['searchInput', '']]) {
    elements.set(id, element(id, value));
  }
  elements.get('empty').children = [elements.get('emptyMessage'), elements.get('emptyAction')];
  elements.get('loadMore').children = [elements.get('loadMoreStatus'), elements.get('loadMoreButton')];
  const tabs = ['korean', 'year', 'varietyYear', 'variety', 'new', 'classic', 'tvmaze'].map(name => {
    const node = element(`tab-${name}`);
    node.dataset.tab = name;
    return node;
  });
  Object.assign(document, {
    getElementById: id => elements.get(id) || tabs.find(tab => tab.id === id) || null,
    querySelectorAll: selector => selector === '.tab' ? tabs : [],
    addEventListener() {},
    createElement: () => element(),
  });
  const location = { href: 'https://example.test/#korean', search: '', hash: '#korean' };
  let savedData = cachedData;
  let savedAt = cacheTimestamp;
  const context = vm.createContext({
    console, document, location, URL, URLSearchParams, AbortController, Date, fetch: fetchImpl,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: view,
    history: { replaceState(state, unused, path) {
      const url = new URL(path, location.href);
      Object.assign(location, { href: url.href, search: url.search, hash: url.hash });
    } },
    localStorage: {
      getItem: () => savedData ? JSON.stringify({ version: 3, cachedAt: savedAt, data: savedData }) : null,
      setItem(key, value) { ({ data: savedData, cachedAt: savedAt } = JSON.parse(value)); },
    },
  });
  vm.runInContext(app.replace(/\}\)\(\);\s*$/u, `
    globalThis.helpers = {
      loadData, switchTab, applyFilters, bindTabs, bindFilters, bindContentNavigation, bindLoadMore, loadMoreShows, getDataFreshness,
      toFiniteNumber, safeExternalUrl, escapeHtml,
      setAllData: value => { allData = value; },
      setTVmazeCache: shows => {
        _tvmazeCache = shows; _tvmazeCachedAt = Date.now(); _tvmazeCacheDate = getScheduleDateKey();
      },
    };
  })();`), context, { timeout: 1000 });
  return { helpers: context.helpers, elements: Object.fromEntries(elements), document, view };
}

function snapshot(count = 1) {
  return {
    lastUpdated: new Date().toISOString(),
    koreanDramas: Array.from({ length: count }, (_, index) => ({ id: `show-${index}`, title: `剧目${index}` })),
    chineseVariety: [{ id: 'variety', title: '综艺' }],
  };
}

test('unchanged filter results retain card nodes, poster state and focused links', () => {
  const { helpers, elements, document } = createApp();
  const data = snapshot(30);
  data.koreanDramas.forEach(show => { show.tmdbUrl = 'https://www.themoviedb.org/tv/1'; });
  helpers.setAllData(data);
  helpers.switchTab('korean', { animate: false });
  const first = elements.showGrid.children[0];
  const focused = first.children[0];
  focused.focus();
  first.posterState = 'decoded or fallback';
  const writes = elements.showGrid.htmlWrites;
  helpers.applyFilters();
  assert.equal(elements.showGrid.htmlWrites, writes, 'an identical result must not replace the grid');
  assert.equal(elements.showGrid.children[0], first);
  assert.equal(first.posterState, 'decoded or fallback');
  assert.equal(document.activeElement, focused);
});

test('a no-op filter between progressive batches still appends and retains earlier cards', () => {
  const { helpers, elements } = createApp();
  helpers.setAllData(snapshot(70));
  helpers.switchTab('korean', { animate: false });
  const first = elements.showGrid.children[0];
  helpers.applyFilters();
  assert.equal(helpers.loadMoreShows(), true);
  assert.equal(elements.showGrid.children.length, 48);
  assert.equal(elements.showGrid.children[0], first);
  assert.equal(elements.showGrid.appendWrites, 1);
});

test('changed snapshots and changed recommendation scales invalidate retained card markup', () => {
  const { helpers, elements } = createApp();
  const data = snapshot(2);
  Object.assign(data.koreanDramas[0], { score: 9, recommendScore: 50 });
  Object.assign(data.koreanDramas[1], { score: 9, recommendScore: 40 });
  elements.filterScore.value = '9';
  helpers.setAllData(data);
  helpers.switchTab('korean', { animate: false });
  const original = elements.showGrid.children[0];
  assert.match(elements.showGrid.innerHTML, /相对推荐度 100%/u);
  // 对象相同但新快照的分类最大值变了，不能复用旧的相对推荐度。
  data.koreanDramas.push({ id: 'outside', title: '筛选外', score: 1, recommendScore: 100 });
  helpers.switchTab('korean', { animate: false });
  assert.notEqual(elements.showGrid.children[0], original);
  assert.match(elements.showGrid.innerHTML, /相对推荐度 50%/u);
  const next = elements.showGrid.children[0];
  helpers.setAllData({ ...data, koreanDramas: data.koreanDramas.map(show => ({ ...show, title: `${show.title} 已更新` })) });
  helpers.switchTab('korean', { animate: false });
  assert.notEqual(elements.showGrid.children[0], next);
  assert.match(elements.showGrid.innerHTML, /已更新/u);
});

test('an equal background response retains snapshot identity for the next local filter', async () => {
  const data = snapshot(30);
  const { helpers, elements } = createApp(async () => ({ ok: true, json: async () => structuredClone(data) }), data);
  await helpers.loadData();
  const first = elements.showGrid.children[0];
  const writes = elements.showGrid.htmlWrites;
  helpers.applyFilters();
  assert.equal(elements.showGrid.children[0], first);
  assert.equal(elements.showGrid.htmlWrites, writes);
});

test('cached remote cards replace skeletons even when the card count is identical', async () => {
  const { helpers, elements } = createApp();
  helpers.setAllData(snapshot());
  helpers.setTVmazeCache(Array.from({ length: 4 }, (_, index) => ({ id: index + 1, name: `时间表${index}`, status: 'Running' })));
  await helpers.switchTab('tvmaze');
  await helpers.switchTab('tvmaze');
  assert.equal(elements.showGrid.children.length, 4);
  assert.doesNotMatch(elements.showGrid.innerHTML, /skeleton-card/u);
  assert.match(elements.showGrid.innerHTML, /时间表0/u);
});

for (const cached of [false, true]) {
  test(`initial ${cached ? 'cached' : 'network'} recommendations appear without entrance animation or counting delay`, async () => {
    const data = snapshot(30);
    const { helpers, elements, view } = createApp(async () => ({ ok: true, json: async () => structuredClone(data) }), cached ? data : null);
    view.matchMedia = () => ({ matches: false });
    await helpers.loadData();
    assert.equal(elements.showGrid.classList.contains('animate'), false);
    assert.equal(Number(elements.statTotal.textContent), 30);
    assert.equal(elements.showGrid.children.length, 24);
  });
}

test('current-year filtering scans dataset years linearly rather than once per show', () => {
  const { helpers, elements } = createApp();
  const year = new Date().getFullYear();
  const data = snapshot(1000);
  data.chineseVariety = snapshot(1000).koreanDramas.map(show => ({ ...show, id: `variety-${show.id}` }));
  let reads = 0;
  const rows = [...data.koreanDramas, ...data.chineseVariety];
  rows.forEach((show, index) => Object.defineProperty(show, 'year', { get() { reads++; return index === rows.length - 1 ? year : year - 1; } }));
  helpers.setAllData(data);
  helpers.switchTab('year', { animate: false });
  assert.equal(elements.showGrid.children.length, 0);
  assert.ok(reads <= 6000, `year selection should be linear, got ${reads} reads for ${rows.length} shows`);
});

test('rendering one card batch computes the dataset year once for the batch', () => {
  const { helpers, elements } = createApp();
  const year = new Date().getFullYear();
  const data = snapshot(1000);
  data.chineseVariety = snapshot(1000).koreanDramas.map(show => ({ ...show, id: `variety-${show.id}` }));
  let reads = 0;
  const rows = [...data.koreanDramas, ...data.chineseVariety];
  rows.forEach((show, index) => Object.defineProperty(show, 'year', { get() { reads++; return index === rows.length - 1 ? year : year - 1; } }));
  helpers.setAllData(data);
  helpers.switchTab('korean', { animate: false });
  assert.equal(elements.showGrid.children.length, 24);
  assert.ok(reads <= 6000, `one batch must not rescan all years for every card, got ${reads} reads`);
});

function scrollableTabGeometry({ document, view }) {
  const tabs = document.querySelectorAll('.tab');
  let scrollLeft = 0;
  const container = { getBoundingClientRect: () => ({ left: 10, right: 330 }) };
  Object.defineProperty(container, 'scrollLeft', {
    get: () => scrollLeft,
    set(value) { scrollLeft = Math.max(0, Math.min(604, value)); },
  });
  view.getComputedStyle = () => ({ paddingLeft: '20px', paddingRight: '44px' });
  tabs.forEach((tab, index) => {
    tab.parentElement = container;
    tab.getBoundingClientRect = () => {
      const left = 30 + index * 110 - scrollLeft;
      return { left, right: left + (index === tabs.length - 1 ? 200 : 96) };
    };
    tab.scrollIntoView = () => { view.scrollY -= 429.5; };
    tab.focus = options => {
      document.activeElement = tab;
      if (!options?.preventScroll) view.scrollY -= 100;
    };
  });
  return { tabs, container, visibleLeft: 30, visibleRight: 286 };
}

test('repeated activation of the focused sticky tab preserves the page reading position', () => {
  const app = createApp();
  const { helpers, elements, document, view } = app;
  const { tabs } = scrollableTabGeometry(app);
  const data = snapshot(30);
  data.chineseVariety = data.koreanDramas.map(show => ({ ...show, id: `variety-${show.id}` }));
  helpers.setAllData(data);
  helpers.switchTab('variety', { animate: false, scrollToTab: false });
  helpers.bindTabs();
  tabs[3].focus({ preventScroll: true });
  view.scrollY = 3182;
  tabs[3].dispatch('click');
  tabs[3].dispatch('click');
  assert.equal(document.activeElement, tabs[3]);
  assert.equal(elements.showGrid.children.length, 24);
  assert.equal(view.scrollY, 3182, 'activating a sticky tab must not scroll the root document');
});

test('activating an already visible tab leaves horizontal and vertical scroll unchanged', () => {
  const app = createApp();
  const { helpers, view } = app;
  const { tabs, container } = scrollableTabGeometry(app);
  helpers.setAllData(snapshot());
  helpers.bindTabs();
  tabs[1].focus({ preventScroll: true });
  view.scrollY = 2200;
  tabs[1].dispatch('click');
  assert.equal(container.scrollLeft, 0);
  assert.equal(view.scrollY, 2200);
});

test('switching to another category starts at the results while repeated activation keeps the reading position', () => {
  const app = createApp();
  const { helpers, elements } = app;
  const { tabs } = scrollableTabGeometry(app);
  helpers.setAllData(snapshot());
  helpers.bindTabs();
  elements.mainContent.getBoundingClientRect = () => ({ top: -1800 });
  elements.mainContent.scrolled = false;
  tabs[0].dispatch('click');
  assert.equal(elements.mainContent.scrolled, false, 'activating the current tab must not move the page');
  tabs[3].dispatch('click');
  assert.equal(elements.mainContent.scrolled, true, 'a new category must not open in the middle of its result list');
  elements.mainContent.scrolled = false;
  elements.mainContent.getBoundingClientRect = () => ({ top: 400 });
  tabs[4].dispatch('click');
  assert.equal(elements.mainContent.scrolled, false, 'results already below the sticky tabs need no jump');
});

test('tab keyboard navigation reveals both overflow edges without moving the page', () => {
  const app = createApp();
  const { helpers, document, view } = app;
  const { tabs, container, visibleLeft, visibleRight } = scrollableTabGeometry(app);
  helpers.setAllData(snapshot());
  helpers.setTVmazeCache([{ id: 1, name: '已缓存的时间表' }]);
  helpers.bindTabs();
  tabs[0].focus({ preventScroll: true });
  view.scrollY = 2400;
  for (const [key, expectedIndex] of [['End', 6], ['Home', 0], ['ArrowLeft', 6], ['ArrowRight', 0]]) {
    let prevented = false;
    document.activeElement.dispatch('keydown', { key, preventDefault() { prevented = true; } });
    assert.ok(prevented);
    assert.equal(document.activeElement, tabs[expectedIndex]);
    assert.equal(tabs[expectedIndex].getAttribute('aria-selected'), 'true');
    const bounds = tabs[expectedIndex].getBoundingClientRect();
    assert.ok(bounds.left >= visibleLeft && bounds.right <= visibleRight, `${key} must reveal the whole focused tab inside the padded viewport`);
    assert.equal(view.scrollY, 2400, `${key} must preserve the root scroll position`);
    assert.equal(container.scrollLeft, expectedIndex === 0 ? 0 : 604);
  }
});

test('content navigation tracks the measured sticky tab height through ResizeObserver', () => {
  const { helpers, document, view } = createApp();
  let tabHeight = 69.2;
  const tabs = { getBoundingClientRect: () => ({ height: tabHeight }) };
  const rootProperties = new Map();
  let onResize;
  let observedElement;
  document.querySelector = selector => selector === '.tabs' ? tabs : null;
  document.documentElement = { style: { setProperty: (name, value) => rootProperties.set(name, value) } };
  view.ResizeObserver = class {
    constructor(callback) { onResize = callback; }
    observe(element) { observedElement = element; }
  };
  helpers.bindContentNavigation();
  assert.equal(rootProperties.get('--tabs-scroll-offset'), '70px');
  assert.equal(observedElement, tabs);
  tabHeight = 91.4;
  onResize([]);
  assert.equal(rootProperties.get('--tabs-scroll-offset'), '92px', 'resizing or wrapping tabs must update the scroll clearance');
});

test('content navigation updates sticky tab clearance on window resize without ResizeObserver', () => {
  const { helpers, document, view } = createApp();
  let tabHeight = 65.1;
  const tabs = { getBoundingClientRect: () => ({ height: tabHeight }) };
  const rootProperties = new Map();
  const listeners = new Map();
  document.querySelector = selector => selector === '.tabs' ? tabs : null;
  document.documentElement = { style: { setProperty: (name, value) => rootProperties.set(name, value) } };
  view.addEventListener = (name, callback) => listeners.set(name, callback);
  helpers.bindContentNavigation();
  assert.equal(rootProperties.get('--tabs-scroll-offset'), '66px');
  tabHeight = 100.9;
  listeners.get('resize')();
  assert.equal(rootProperties.get('--tabs-scroll-offset'), '101px');
});

test('clearing filters keeps keyboard focus in the search input after the reset button disappears', () => {
  const { helpers, elements, document, view } = createApp();
  helpers.setAllData(snapshot(30));
  helpers.bindFilters();
  helpers.switchTab('korean', { animate: false });
  elements.filterScore.value = '8';
  elements.filterScore.dispatch('change');
  assert.equal(elements.resetFilters.hidden, false);
  elements.resetFilters.focus();
  view.scrollY = 350;
  elements.resetFilters.dispatch('click');
  assert.equal(elements.filterScore.value, '0');
  assert.equal(elements.resetFilters.hidden, true);
  assert.equal(elements.showGrid.children.length, 24);
  assert.equal(document.activeElement, elements.searchInput);
  assert.equal(view.scrollY, 350, 'clearing filters should not jump away from the controls');
});

test('retrying recommendations moves focus from the disappearing retry button into the main content', async () => {
  let attempt = 0;
  let resolveRetry;
  const { helpers, elements, document, view } = createApp(() => {
    if (++attempt === 1) return Promise.reject(new Error('offline'));
    return new Promise(resolve => { resolveRetry = resolve; });
  });
  await helpers.loadData();
  elements.emptyAction.focus();
  view.scrollY = 450;
  const pending = elements.emptyAction.dispatch('click');
  const pendingFocus = document.activeElement;
  const pendingDisplay = elements.empty.style.display;
  const pendingBusy = elements.showGrid.getAttribute('aria-busy');
  resolveRetry({ ok: true, json: async () => snapshot() });
  await pending;
  assert.equal(pendingDisplay, 'none');
  assert.equal(pendingBusy, 'true');
  assert.equal(pendingFocus, elements.mainContent);
  assert.equal(document.activeElement, elements.mainContent);
  assert.equal(view.scrollY, 450, 'retrying should preserve the current reading position');
});

for (const source of ['recommendations', 'schedule']) {
  for (const focusRetry of [false, true]) {
    if (source === 'recommendations' && focusRetry) continue;
    test(`retrying ${source} ${focusRetry ? 'retains reachable keyboard focus' : 'preserves focus in another control'}`, async () => {
      let retrying = false;
      let resolveRetry;
      const { helpers, elements, document } = createApp(() => {
        if (!retrying) return Promise.reject(new Error('offline'));
        return new Promise(resolve => { resolveRetry = resolve; });
      });
      if (source === 'schedule') await helpers.switchTab('tvmaze');
      else await helpers.loadData();
      assert.equal(elements.emptyAction.hidden, false);
      retrying = true;
      const expectedFocus = focusRetry ? elements.mainContent : elements.searchInput;
      (focusRetry ? elements.emptyAction : elements.searchInput).focus();
      const pending = elements.emptyAction.dispatch('click');
      const pendingFocus = document.activeElement;
      const retryHidden = elements.emptyAction.hidden;
      resolveRetry({
        ok: true,
        json: async () => source === 'schedule'
          ? Array.from({ length: 5 }, (_, index) => tvmazeRow(index + 1, `恢复的时间表${index}`))
          : snapshot(),
      });
      await pending;
      assert.equal(retryHidden, true);
      assert.equal(pendingFocus, expectedFocus);
      assert.equal(document.activeElement, expectedFocus);
      assert.notEqual(elements.empty.style.display, 'block');
      assert.match(elements.showGrid.innerHTML, source === 'schedule' ? /恢复的时间表/u : /剧目0/u);
    });
  }
}

test('cached-data loading and failure notices survive tab switches without replacing the schedule', async () => {
  let rejectRequest;
  const { helpers, elements } = createApp(() => new Promise((resolve, reject) => { rejectRequest = reject; }), snapshot());
  const pending = helpers.loadData();
  helpers.switchTab('variety', { animate: false });
  assert.match(elements.updateInfo.textContent, /正在后台更新/u);
  helpers.setTVmazeCache([{ id: 1, name: '独立时间表' }]);
  await helpers.switchTab('tvmaze');
  const sourceInfo = elements.updateInfo.textContent;
  rejectRequest(new Error('offline'));
  await pending;
  assert.equal(elements.updateInfo.textContent, sourceInfo);
  assert.match(elements.showGrid.innerHTML, /独立时间表/u);
  helpers.switchTab('korean', { animate: false });
  assert.match(elements.updateInfo.textContent, /网络更新失败，展示本地缓存/u);
  helpers.switchTab('variety', { animate: false });
  assert.match(elements.updateInfo.textContent, /网络更新失败，展示本地缓存/u);
});

test('a successful refresh clears the cached-data notice and a superseded failure cannot restore it', async () => {
  const requests = [];
  const { helpers, elements } = createApp(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), snapshot());
  const oldRequest = helpers.loadData();
  const currentRequest = helpers.loadData();
  requests[1].resolve({ ok: true, json: async () => snapshot() });
  await currentRequest;
  assert.doesNotMatch(elements.updateInfo.textContent, /正在后台更新|网络更新失败/u);
  requests[0].reject(new Error('older request failed'));
  await oldRequest;
  assert.doesNotMatch(elements.updateInfo.textContent, /正在后台更新|网络更新失败/u);
  helpers.switchTab('variety', { animate: false });
  assert.doesNotMatch(elements.updateInfo.textContent, /正在后台更新|网络更新失败/u);
});

test('a superseded success cannot replace the newer recommendation snapshot', async () => {
  const requests = [];
  const { helpers, elements } = createApp(() => new Promise(resolve => requests.push(resolve)), snapshot());
  const oldRequest = helpers.loadData();
  const currentRequest = helpers.loadData();
  const current = snapshot();
  current.koreanDramas[0].title = '最新请求的推荐';
  requests[1]({ ok: true, json: async () => current });
  await currentRequest;
  const old = snapshot();
  old.koreanDramas[0].title = '已过期旧请求的推荐';
  requests[0]({ ok: true, json: async () => old });
  await oldRequest;
  assert.match(elements.showGrid.innerHTML, /最新请求的推荐/u);
  assert.doesNotMatch(elements.showGrid.innerHTML, /已过期旧请求/u);
});

for (const failure of ['json-syntax', 'dataset-shape']) {
  test(`${failure} failures retain readable cache and keep the failure notice on other tabs`, async () => {
    const { helpers, elements } = createApp(async () => ({
      ok: true,
      json: async () => {
        if (failure === 'json-syntax') throw new SyntaxError('invalid JSON');
        return { error: 'unavailable' };
      },
    }), snapshot());
    await helpers.loadData();
    assert.match(elements.showGrid.innerHTML, /剧目0/u);
    assert.match(elements.updateInfo.textContent, /网络更新失败，展示本地缓存/u);
    helpers.switchTab('variety', { animate: false });
    assert.match(elements.showGrid.innerHTML, /综艺/u);
    assert.match(elements.updateInfo.textContent, /网络更新失败，展示本地缓存/u);
    assert.notEqual(elements.empty.style.display, 'block');
  });
}

test('an expired cache cannot hide the initial-load failure or its recovery action', async () => {
  const { helpers, elements } = createApp(async () => { throw new Error('offline'); }, snapshot(), Date.now() - 15 * 24 * 60 * 60 * 1000);
  await helpers.loadData();
  helpers.switchTab('variety', { animate: false });
  assert.equal(elements.showGrid.innerHTML, '');
  assert.match(elements.emptyMessage.textContent, /推荐数据加载失败/u);
  assert.equal(elements.emptyAction.hidden, false);
  assert.equal(typeof elements.emptyAction.onclick, 'function');
  assert.doesNotMatch(elements.updateInfo.textContent, /展示本地缓存/u);
});

for (const outcome of ['success', 'failure']) {
  test(`retrying the initial load clears the old error while changing tabs (${outcome})`, async () => {
    let attempt = 0;
    let settle;
    const { helpers, elements } = createApp(() => {
      if (++attempt === 1) return Promise.reject(new Error('first load failed'));
      return new Promise((resolve, reject) => { settle = outcome === 'success' ? resolve : reject; });
    });
    await helpers.loadData();
    assert.match(elements.emptyMessage.textContent, /加载失败/u);
    assert.equal(elements.emptyAction.textContent, '重试');
    elements.filterStatus.value = 'ongoing';
    const pending = elements.emptyAction.onclick();
    const assertLoading = () => {
      assert.match(elements.showGrid.innerHTML, /skeleton-card/u);
      assert.equal(elements.showGrid.getAttribute('aria-busy'), 'true');
      assert.notEqual(elements.empty.style.display, 'block');
      assert.equal(elements.emptyAction.hidden, true);
      assert.match(elements.updateInfo.textContent, /正在加载推荐数据/u);
      assert.match(elements.resultSummary.textContent, /正在加载推荐数据/u);
    };
    assertLoading();
    helpers.switchTab('variety', { animate: false });
    assertLoading();
    const refreshed = snapshot();
    refreshed.chineseVariety[0] = { id: 'retried', title: '重试成功的连载综艺', isSerial: true };
    if (outcome === 'success') settle({ ok: true, json: async () => refreshed });
    else settle(new Error('retry failed'));
    await pending;
    assert.equal(elements.showGrid.getAttribute('aria-busy'), 'false');
    assert.equal(elements.filterStatus.value, 'ongoing');
    if (outcome === 'success') {
      assert.match(elements.showGrid.innerHTML, /重试成功的连载综艺/u);
      assert.notEqual(elements.empty.style.display, 'block');
      assert.doesNotMatch(elements.updateInfo.textContent, /加载失败|正在加载/u);
    } else {
      assert.match(elements.emptyMessage.textContent, /加载失败/u);
      assert.equal(elements.emptyAction.hidden, false);
      assert.equal(typeof elements.emptyAction.onclick, 'function');
    }
  });
}

test('an initial-load retry can fail without replacing the schedule opened while it is pending', async () => {
  let attempt = 0;
  let rejectRetry;
  const { helpers, elements } = createApp(() => {
    if (++attempt === 1) return Promise.reject(new Error('offline'));
    return new Promise((resolve, reject) => { rejectRetry = reject; });
  });
  await helpers.loadData();
  const pending = elements.emptyAction.onclick();
  helpers.setTVmazeCache([{ id: 1, name: '重试期间打开的时间表' }]);
  await helpers.switchTab('tvmaze');
  const sourceInfo = elements.updateInfo.textContent;
  rejectRetry(new Error('still offline'));
  await pending;
  assert.equal(elements.updateInfo.textContent, sourceInfo);
  assert.match(elements.showGrid.innerHTML, /重试期间打开的时间表/u);
  helpers.switchTab('korean', { animate: false });
  assert.match(elements.emptyMessage.textContent, /推荐数据加载失败/u);
  assert.equal(elements.emptyAction.hidden, false);
});

test('a successful background refresh preserves the active schedule and clears the notice before returning', async () => {
  let resolveRequest;
  const { helpers, elements } = createApp(() => new Promise(resolve => { resolveRequest = resolve; }), snapshot());
  const pending = helpers.loadData();
  helpers.setTVmazeCache([{ id: 1, name: '仍在阅读的时间表' }]);
  await helpers.switchTab('tvmaze');
  const sourceInfo = elements.updateInfo.textContent;
  const updated = snapshot();
  updated.koreanDramas[0].title = '后台更新的新推荐';
  resolveRequest({ ok: true, json: async () => updated });
  await pending;
  assert.equal(elements.updateInfo.textContent, sourceInfo);
  assert.match(elements.showGrid.innerHTML, /仍在阅读的时间表/u);
  helpers.switchTab('korean', { animate: false });
  assert.match(elements.showGrid.innerHTML, /后台更新的新推荐/u);
  assert.doesNotMatch(elements.updateInfo.textContent, /正在后台更新|网络更新失败/u);
});

for (const focusCard of [true, false]) {
  test(`a changed background refresh keeps the reading anchor when a programme moves beyond the rendered batch (card focus: ${focusCard})`, async () => {
    const cached = snapshot(60);
    for (const show of cached.koreanDramas) show.primaryUrl = `https://www.themoviedb.org/tv/${show.id}`;
    let resolveRequest;
    const { helpers, elements, document, view } = createApp(() => new Promise(resolve => { resolveRequest = resolve; }), cached);
    const pending = helpers.loadData();
    view.scrollY = 1700;
    const oldCard = elements.showGrid.children[10];
    const oldLink = oldCard.querySelector('a[href]');
    if (focusCard) oldLink.focus();
    else elements.searchInput.focus();
    const anchorTop = oldCard.getBoundingClientRect().top;
    const updated = structuredClone(cached);
    updated.koreanDramas = [...updated.koreanDramas.slice(40), ...updated.koreanDramas.slice(0, 40)];
    resolveRequest({ ok: true, json: async () => updated });
    await pending;
    const movedCard = elements.showGrid.children[30];
    assert.equal(movedCard.getBoundingClientRect().top, anchorTop, 'the same programme should remain at its previous viewport offset');
    assert.equal(document.activeElement, focusCard ? movedCard.querySelector('a[href]') : elements.searchInput);
    assert.equal(elements.showGrid.contains(oldLink), false, 'the assertion must exercise replacement rather than an unchanged cache');
    assert.equal(elements.showGrid.children.length, 31, 'a retained programme beyond the old batch must be made visible');
    assert.match(elements.resultSummary.textContent, /31 \/ 60/u);
    assert.equal(elements.loadMore.hidden, false);
  });
}

for (const change of ['link-replaced', 'programme-removed', 'all-results-removed']) {
  test(`background refresh uses a reachable focus fallback when ${change}`, async () => {
    const cached = snapshot(20);
    for (const show of cached.koreanDramas) show.primaryUrl = `https://www.themoviedb.org/tv/${show.id}`;
    let resolveRequest;
    const { helpers, elements, document, view } = createApp(() => new Promise(resolve => { resolveRequest = resolve; }), cached);
    const pending = helpers.loadData();
    view.scrollY = 1700;
    elements.showGrid.children[10].querySelector('a[href]').focus();
    const updated = structuredClone(cached);
    if (change === 'link-replaced') updated.koreanDramas[10].primaryUrl = 'https://www.themoviedb.org/tv/replacement';
    else if (change === 'programme-removed') updated.koreanDramas.splice(10, 1);
    else updated.koreanDramas = [];
    resolveRequest({ ok: true, json: async () => updated });
    await pending;
    const target = change === 'all-results-removed' ? elements.mainContent : elements.showGrid.children[10];
    assert.equal(document.activeElement, target);
    assert.equal(target.tabIndex, -1);
    if (change !== 'all-results-removed') assert.equal(target.getBoundingClientRect().top, 0);
    else assert.match(elements.resultSummary.textContent, /没有符合/u);
  });
}

test('a visible focused programme stays in view when its neighbours reorder differently', async () => {
  const cached = snapshot(60);
  for (const show of cached.koreanDramas) show.primaryUrl = `https://www.themoviedb.org/tv/${show.id}`;
  let resolveRequest;
  const { helpers, elements, document, view } = createApp(() => new Promise(resolve => { resolveRequest = resolve; }), cached);
  const pending = helpers.loadData();
  view.scrollY = 1700;
  const oldCard = elements.showGrid.children[12];
  oldCard.querySelector('a[href]').focus();
  const previousTop = oldCard.getBoundingClientRect().top;
  const updated = structuredClone(cached);
  const [moved] = updated.koreanDramas.splice(12, 1);
  updated.koreanDramas.splice(50, 0, moved);
  resolveRequest({ ok: true, json: async () => updated });
  await pending;
  const movedCard = elements.showGrid.children[50];
  assert.equal(document.activeElement, movedCard.querySelector('a[href]'));
  assert.equal(movedCard.getBoundingClientRect().top, previousTop);
  assert.match(elements.resultSummary.textContent, /51 \/ 60/u);
});

for (const remaining of [5, 0]) {
  test(`background refresh keeps a reachable focus target when the focused load-more button disappears (${remaining} results)`, async () => {
    const cached = snapshot(60);
    let resolveRequest;
    const { helpers, elements, document } = createApp(() => new Promise(resolve => { resolveRequest = resolve; }), cached);
    const pending = helpers.loadData();
    elements.loadMoreButton.focus();
    const updated = structuredClone(cached);
    updated.koreanDramas.length = remaining;
    resolveRequest({ ok: true, json: async () => updated });
    await pending;
    assert.equal(elements.loadMore.hidden, true);
    const target = remaining ? elements.showGrid.children[remaining - 1] : elements.mainContent;
    assert.equal(document.activeElement, target);
    assert.equal(target.tabIndex, -1);
  });
}

test('an explicit tab change leaves keyboard focus on the chosen tab', () => {
  const { helpers, document } = createApp();
  helpers.setAllData(snapshot(20));
  helpers.switchTab('korean', { animate: false });
  const nextTab = document.getElementById('tab-variety');
  nextTab.focus();
  helpers.switchTab('variety', { animate: false });
  assert.equal(document.activeElement, nextTab);
});

test('freshness labels use the local calendar day across midnight', () => {
  const { helpers } = createApp();
  const now = new Date(2026, 9, 13, 0, 10).getTime();
  assert.equal(helpers.getDataFreshness(new Date(2026, 9, 12, 20).toISOString(), now).label, '昨天更新');
  assert.equal(helpers.getDataFreshness(new Date(2026, 9, 11, 23, 50).toISOString(), now).label, '约1天前更新');
  assert.equal(helpers.getDataFreshness(new Date(2026, 9, 12, 23, 50).toISOString(), now).label, '刚刚更新');
});

for (const count of [30, 60]) {
  test(`manual loading keeps keyboard navigation on the first newly added card (${count} results)`, () => {
    const { helpers, elements, document } = createApp();
    helpers.setAllData(snapshot(count));
    helpers.switchTab('korean', { animate: false });
    helpers.bindLoadMore();
    elements.loadMoreButton.focus();
    elements.loadMoreButton.dispatch('click');
    assert.equal(document.activeElement, elements.showGrid.children[24]);
    assert.equal(document.activeElement.tabIndex, -1, 'programmatic focus must not add another regular tab stop');
    assert.ok(document.activeElement.scrolled, 'the focused result should be brought into view');
    assert.equal(elements.loadMore.hidden, count <= 48);
  });
}

test('automatic loading preserves the existing keyboard focus', () => {
  const { helpers, elements, document } = createApp();
  helpers.setAllData(snapshot(60));
  helpers.switchTab('korean', { animate: false });
  const focused = elements.showGrid.children[2];
  focused.focus();
  helpers.loadMoreShows();
  assert.equal(document.activeElement, focused);
  assert.equal(elements.showGrid.children.length, 48);
});

test('the final observer-triggered batch keeps a focused pagination button reachable through the first new result', () => {
  const { helpers, elements, document, view } = createApp();
  let onIntersection;
  view.IntersectionObserver = class {
    constructor(callback) { onIntersection = callback; }
    observe() {}
  };
  helpers.setAllData(snapshot(30));
  helpers.switchTab('korean', { animate: false });
  helpers.bindLoadMore();
  elements.loadMoreButton.focus();
  onIntersection([{ isIntersecting: true }]);
  assert.equal(elements.showGrid.children.length, 30);
  assert.equal(elements.loadMore.hidden, true);
  assert.equal(document.activeElement, elements.showGrid.children[24]);
  assert.equal(document.activeElement.tabIndex, -1);
  assert.ok(document.activeElement.scrolled);
});

for (const [count, focusedElement] of [[60, 'loadMoreButton'], [30, 'searchInput']]) {
  test(`observer loading preserves ${focusedElement} focus with ${count} results`, () => {
    const { helpers, elements, document, view } = createApp();
    let onIntersection;
    view.IntersectionObserver = class {
      constructor(callback) { onIntersection = callback; }
      observe() {}
    };
    helpers.setAllData(snapshot(count));
    helpers.switchTab('korean', { animate: false });
    helpers.bindLoadMore();
    elements[focusedElement].focus();
    onIntersection([{ isIntersecting: true }]);
    assert.equal(elements.showGrid.children.length, Math.min(count, 48));
    assert.equal(elements.loadMore.hidden, count <= 48);
    assert.equal(document.activeElement, elements[focusedElement]);
  });
}

const malformedTVmazeFields = {
  rating: row => { row.show.rating.average = { toString: 'broken' }; },
  url: row => { row.show.url = { toString: 'broken' }; },
  name: row => { row.show.name = { toString: 'broken' }; },
  network: row => { row.show.network.name = { toString: 'broken' }; },
  genres: row => { row.show.genres = [{ toString: 'broken' }]; },
  image: row => { row.show.image.medium = { toString: 'broken' }; },
  summary: row => { row.show.summary = { toString: 'broken' }; },
  airtime: row => { row.airtime = { toString: 'broken' }; },
  id: row => { row.show.id = { toString: 'broken' }; },
  season: row => { row.season = { toString: 'broken' }; },
  episodeNumber: row => { row.number = { toString: 'broken' }; },
  unicodeName: row => { row.show.name = 'broken\ud800'; },
};

function tvmazeRow(id, name) {
  return {
    season: 1, number: 2, airtime: '21:00',
    show: {
      id, name, type: 'Scripted', status: 'Running', genres: ['Drama'],
      rating: { average: 8 }, network: { name: 'KBS' },
      image: { medium: 'https://static.tvmaze.com/poster.jpg' },
      url: `https://www.tvmaze.com/shows/${id}/example`, summary: '<p>正常简介</p>',
    },
  };
}

for (const [field, damage] of Object.entries(malformedTVmazeFields)) {
  test(`a malformed TVmaze ${field} row cannot erase valid programmes or poison the cache`, async () => {
    const valid = tvmazeRow(1, '正常电视剧🎬');
    const malformed = tvmazeRow(2, '应隔离的坏行');
    damage(malformed);
    const nullable = {
      season: null, number: null, airtime: null,
      show: { id: 3, name: '允许空值的电视剧', type: 'Scripted', status: null, genres: null, rating: null, network: null, image: null, url: null, summary: null },
    };
    let calls = 0;
    const { helpers, elements } = createApp(async () => ({
      ok: true, json: async () => ++calls === 1 ? JSON.parse(JSON.stringify([valid, malformed, nullable])) : [],
    }));
    await helpers.switchTab('tvmaze');
    assert.match(elements.showGrid.innerHTML, /正常电视剧🎬/u);
    assert.match(elements.showGrid.innerHTML, /允许空值的电视剧/u);
    assert.doesNotMatch(elements.showGrid.innerHTML, /应隔离的坏行|broken/u);
    assert.equal(elements.showGrid.children.length, 2);
    assert.match(elements.updateInfo.textContent, /部分日期暂不可用/u);
    assert.notEqual(elements.empty.style.display, 'block');
    const firstCalls = calls;
    await helpers.switchTab('tvmaze');
    assert.equal(calls, firstCalls, 'the briefly cached safe subset should remain readable');
    assert.equal(elements.showGrid.children.length, 2);
  });
}

test('a malformed current-day schedule without valid programmes remains unknown and retryable', async () => {
  let calls = 0;
  const { helpers, elements } = createApp(async () => ({
    ok: true, json: async () => ++calls % 7 === 1 ? [{ show: { id: 1, name: { toString: 'broken' }, type: 'Scripted' } }] : [],
  }));
  await helpers.switchTab('tvmaze');
  assert.match(elements.emptyMessage.textContent, /TVmaze 数据加载失败/u);
  assert.equal(elements.emptyAction.hidden, false);
  await elements.emptyAction.onclick();
  assert.equal(calls, 14, 'unusable rows must not create a confirmed empty-day cache');
  assert.match(elements.emptyMessage.textContent, /TVmaze 数据加载失败/u);
});

test('nullable TVmaze metadata fields remain renderable without invented ratings or episode numbers', async () => {
  const row = tvmazeRow(1, '元数据空值节目');
  Object.assign(row, { season: null, number: null, airtime: null });
  Object.assign(row.show, { rating: { average: null }, network: { name: null }, image: { medium: null, original: null }, url: null, summary: null });
  let calls = 0;
  const { helpers, elements } = createApp(async () => ({ ok: true, json: async () => ++calls === 1 ? [row] : [] }));
  await helpers.switchTab('tvmaze');
  assert.match(elements.showGrid.innerHTML, /元数据空值节目/u);
  assert.match(elements.showGrid.innerHTML, /特别篇/u);
  assert.doesNotMatch(elements.showGrid.innerHTML, /schedule-rating|Enull|Eundefined/u);
  assert.doesNotMatch(elements.updateInfo.textContent, /部分日期暂不可用/u);
});

test('unknown remote fields cannot enter recommendation filters or statistics', async () => {
  const row = tvmazeRow(1, '正常节目');
  Object.assign(row.show, { score: { toString: 'broken' }, recommendScore: { toString: 'broken' }, titleAliases: [{ toString: 'broken' }] });
  let calls = 0;
  const { helpers, elements } = createApp(async () => ({ ok: true, json: async () => ++calls === 1 ? [row] : [] }));
  elements.filterScore.value = '8';
  elements.searchInput.value = '正常';
  await helpers.switchTab('tvmaze');
  assert.match(elements.showGrid.innerHTML, /正常节目/u);
  assert.equal(elements.statHighScore.textContent, 1);
  assert.notEqual(elements.empty.style.display, 'block');
});

test('scalar helpers reject structured JSON values without invoking coercion methods', () => {
  const { helpers } = createApp();
  for (const value of [{ toString: 'broken' }, [], { valueOf: 'broken', toString: 'broken' }]) {
    assert.ok(Number.isNaN(helpers.toFiniteNumber(value, NaN)));
    assert.equal(helpers.safeExternalUrl(value), '');
    assert.equal(helpers.escapeHtml(value), '');
  }
  assert.equal(helpers.toFiniteNumber('8.5'), 8.5);
  assert.equal(helpers.safeExternalUrl(' https://www.tvmaze.com/shows/1/normal '), 'https://www.tvmaze.com/shows/1/normal');
  assert.equal(helpers.escapeHtml('<正常>'), '&lt;正常&gt;');
});
