#!/usr/bin/env node
/**
 * 爱壹帆 韩剧 & 国内综艺 推荐数据抓取器
 * 每天 00:00/12:00 UTC 由 GitHub Actions 执行
 *
 * 数据采集:
 *   - 从 api.yfsp.tv 抓取首页数据 (isn=0 + isn=1, 共 30 页)
 *   - 用关键词搜索 YFSP 发现更多新韩剧 (韩剧/最新韩剧/韩剧2026 等)
 *   - 与内置精选推荐库合并 (54 部韩剧 + 16 部综艺, 覆盖经典和 2024-2026 新剧)
 *
 * 数据富化:
 *   - TMDB 高清封面 (w780) + Wikidata 豆瓣/Wikipedia/IMDb 链接
 *   - 爱壹帆具体页验证与搜索补全
 *   - 豆瓣条目搜索补全
 *   - image_cache.json 缓存 TMDB 结果, 避免重复请求
 *   - seedId ↔ liveId 缓存同步 (种子匹配直播节目后 ID 变化时自动同步)
 *
 * 推荐算法:
 *   - 评分 + 类型偏好 + 人气 + 新鲜度 + 经典加分
 *   - 负面内容过滤 (血腥/暴力/恐怖关键词)
 *   - 综艺黑名单 (浪姐/乘风等)
 *   - AI 智能评分增强 (GitHub Models, 可选, 用 GITHUB_TOKEN 或 MODELS_TOKEN)
 *
 * 新剧监控:
 *   - 扫描 API + 关键词搜索发现未收录韩剧
 *   - 2026 新剧放宽收录门槛 (评分≥4 或播放≥1 万)
 *   - AI 智能筛选新剧质量
 *   - 发现记录持久化到 discovery.json (保留 60 天)
 *   - 满足条件的新剧自动收录并走完整富化管线
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SHOWS_FILE = join(DATA_DIR, 'shows.json');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const DISCOVERY_FILE = join(DATA_DIR, 'discovery.json');

const API_BASE = 'https://api.yfsp.tv';
const API_PATH = '/api/list/index';
const YFSP_RANK_BASE = 'https://rankv21.yfsp.tv';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.yfsp.tv/',
  'Accept': 'application/json, text/plain, */*',
};

const CURRENT_YEAR = new Date().getFullYear();

// ════════════════════════════════════════════════════════════════
// API 抓取
// ════════════════════════════════════════════════════════════════

async function fetchJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchPage(page, isn = 0) {
  const url = `${API_BASE}${API_PATH}?cinema=0&page=${page}&cid=0&size=10&isn=${isn}&isfree=-1`;
  try {
    const d = await fetchJSON(url);
    if (d?.data?.list) return d;
  } catch (e) {
    console.warn(`  [WARN] page ${page}: ${e.message}`);
  }
  return null;
}

function extractShows(raw) {
  const out = [];
  for (const sec of raw.data.list) {
    if (!['电视剧', '综艺', '电影'].includes(sec.name)) continue;
    for (const it of sec.list || []) out.push(normalizeItem(it));
  }
  return out;
}

function cleanShowTitle(title = '') {
  // 去掉标题末尾的年份后缀（如"奔跑吧2026"→"奔跑吧"）
  // 保留季数后缀（如"王牌对王牌第九季"不变）
  return title.replace(/\s*20\d{2}\s*$/u, '').trim();
}

function normalizeItem(it) {
  const ui = parseUpdateStatus(it.updateStatus || '');
  const url = it.mediaKey ? `https://www.yfsp.tv/play/${it.mediaKey}` : '';
  const rawTitle = it.title || '';
  const title = it.mediaType === '综艺' ? cleanShowTitle(rawTitle) : rawTitle;
  return {
    id: it.mediaKey || it.episodeKey || '',
    title,
    mediaType: it.mediaType || '',
    type: it.type || 0,
    regional: it.regional || '',
    lang: it.lang || '',
    score: parseFloat(it.score) || 0,
    playCount: it.playCount || 0,
    contentType: it.contentType || '',
    cidMapper: it.cidMapper || '',
    actor: it.actor || '',
    description: it.description || it.introduce || '',
    coverImg: it.coverImgUrl || '',
    updateStatus: it.updateStatus || '',
    updateMsg: it.updateMsg || '',
    isSerial: it.isSerial ?? false,
    ...ui,
    publishTime: it.publishTime || '',
    year: extractYear(it.publishTime || it.date || ''),
    url,
    primaryUrl: url,
    primaryUrlSource: url ? 'yfsp' : '',
    yfspUrl: url,
    doubanUrl: '',
    scrapedAt: new Date().toISOString(),
    isLive: true,
  };
}

function parseUpdateStatus(s) {
  const total = s.match(/(\d+)集全/);
  const done = !!total || s.includes('全集');
  // 综艺格式: "更新到20260503(第10期下)" → 提取括号内集数
  const varietyEp = s.match(/第(\d+)期/);
  // 电视剧格式: "更新到06" → 06
  const dramaEp = s.match(/更新到(\d+)$/);
  let current = 0;
  if (varietyEp) current = +varietyEp[1];
  else if (dramaEp) current = +dramaEp[1];
  return {
    totalEpisodes: total ? +total[1] : 0,
    currentEpisode: current,
    isComplete: done,
  };
}

function extractYear(d) {
  const m = d?.match(/(\d{4})/);
  return m ? +m[1] : 0;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeTitle(title = '') {
  return title
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '')
    .replace(/第[一二三四五六七八九十\d]+季$/u, '')
    .replace(/20\d{2}$/u, '')
    .replace(/吧$/u, '')
    .trim();
}

const TITLE_ALIAS_MAP = {
  '背着善宰跑': ['背着善在跑吧', '背着善宰跑吧', 'Lovely Runner'],
  '金秘书为何那样': ['金秘书为什么那样', '金秘书为何这样'],
  '酒鬼都市男女': ['酒鬼都市女人们', '酒鬼都市女人们第1季', 'Work Later Drink Now'],
  '奇怪的律师禹英禑': ['非常律师禹英', 'Extraordinary Attorney Woo'],
  '非常律师禹英禑': ['奇怪的律师禹英', 'Extraordinary Attorney Woo'],
  '信号': ['Signal信号', '시그널'],
  '文森佐': ['黑道律师文森佐', 'Vincenzo'],
  '机智的监狱生活': ['机智牢房生活', 'Prison Playbook'],
  '奔跑吧兄弟': ['Running Man China', 'Running Man'],
  '金星脱口秀': ['金星秀', 'The Jin Xing Show'],
  '综艺大热门': ['綜藝大熱門', 'Hot Door Night'],
  '披荆斩棘的哥哥': ['披荆斩棘', 'Call Me by Fire'],
  'BTS综艺年代记': ['BTS Variety Chronicle', 'Run BTS!'],
};

function titleCandidates(title = '') {
  return [title, ...(TITLE_ALIAS_MAP[title] || [])].filter(Boolean);
}

function editDistance(a, b) {
  const aa = [...a];
  const bb = [...b];
  const dp = Array.from({ length: aa.length + 1 }, () => Array(bb.length + 1).fill(0));
  for (let i = 0; i <= aa.length; i++) dp[i][0] = i;
  for (let j = 0; j <= bb.length; j++) dp[0][j] = j;
  for (let i = 1; i <= aa.length; i++) {
    for (let j = 1; j <= bb.length; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[aa.length][bb.length];
}

function titleMatches(a, b) {
  if (normalizedTitleMatches(a, b)) return true;
  return titleCandidates(a).some(ta => titleCandidates(b).some(tb => normalizedTitleMatches(ta, tb)));
}

function normalizedTitleMatches(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const minLen = Math.min(na.length, nb.length);
  const maxLen = Math.max(na.length, nb.length);
  if (minLen >= 5 && maxLen - minLen <= 1 && editDistance(na, nb) <= 1) return true;
  // 综艺名通常较短，放宽匹配限制
  if (na.includes(nb) || nb.includes(na)) {
    if (minLen >= 3) return true;
    if (minLen >= 2 && maxLen <= 4) return true;
  }
  return false;
}

const DOUBAN_SUBJECT_URLS = {
  '孤单又灿烂的神-鬼怪': 'https://movie.douban.com/subject/26761935/',
  '酒鬼都市男女': 'https://movie.douban.com/subject/35460374/',
  '机智的监狱生活': 'https://movie.douban.com/subject/27081753/',
  '闪亮的西瓜': 'https://movie.douban.com/subject/36117731/',
  '海岸村恰恰恰': 'https://movie.douban.com/subject/35296153/',
  '机智的医生生活': 'https://movie.douban.com/subject/33464863/',
  '大力女都奉顺': 'https://movie.douban.com/subject/26776093/',
  '欢迎来到王之国': 'https://movie.douban.com/subject/35876191/',
  '举重妖精金福珠': 'https://movie.douban.com/subject/26882230/',
  '非常律师禹英禑': 'https://movie.douban.com/subject/35524446/',
  '奇怪的律师禹英禑': 'https://movie.douban.com/subject/35524446/',
  '死期将至': 'https://movie.douban.com/subject/35991840/',
  '金秘书为何那样': 'https://movie.douban.com/subject/30181455/',
  '社内相亲': 'https://movie.douban.com/subject/35400242/',
  '文森佐': 'https://movie.douban.com/subject/35131278/',
  '我的ID是江南美人': 'https://movie.douban.com/subject/30232208/',
  '触及真心': 'https://movie.douban.com/subject/30304086/',
  '秘密森林': 'https://movie.douban.com/subject/26934346/',
  '未生': 'https://movie.douban.com/subject/25870057/',
  '极限挑战第一季': 'https://movie.douban.com/subject/26387728/',
  '奔跑吧兄弟': 'https://movie.douban.com/subject/25899362/',
  '脱口秀大会': 'https://movie.douban.com/subject/27099227/',
};

function buildDoubanSubjectUrl(title) {
  return DOUBAN_SUBJECT_URLS[title] || '';
}

function attachLinkFields(show, yfspUrl = '', doubanUrl = '') {
  show.yfspUrl = yfspUrl || show.yfspUrl || '';
  show.doubanUrl = doubanUrl || show.doubanUrl || buildDoubanSubjectUrl(show.title);
  show.primaryUrl = show.tmdbUrl || show.doubanUrl || show.wikipediaUrl || show.imdbUrl || show.yfspUrl || '';
  show.primaryUrlSource = show.tmdbUrl ? 'tmdb' : show.doubanUrl ? 'douban' : show.wikipediaUrl ? 'wikipedia' : show.imdbUrl ? 'imdb' : show.yfspUrl ? 'yfsp' : '';
  show.url = show.primaryUrl;
  return show;
}

function findLiveTitleMatch(seed, liveShows, mediaType, regionMatcher) {
  const candidates = [...liveShows.values()].filter(s =>
    s.mediaType === mediaType &&
    (!regionMatcher || regionMatcher(s)) &&
    titleMatches(seed.title, s.title)
  );
  return candidates.sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
}

function applyLiveFields(seedShow, liveMatch) {
  if (!liveMatch) return seedShow;
  const liveStatus = parseUpdateStatus(liveMatch.updateStatus || '');
  return {
    ...seedShow,
    id: liveMatch.id || seedShow.id,
    title: cleanShowTitle(liveMatch.title || seedShow.title),
    coverImg: liveMatch.coverImg || seedShow.coverImg,
    updateStatus: liveMatch.updateStatus || seedShow.updateStatus || '',
    updateMsg: liveMatch.updateMsg || seedShow.updateMsg || '',
    ...liveStatus,
    publishTime: liveMatch.publishTime || seedShow.publishTime || '',
    scrapedAt: liveMatch.scrapedAt || seedShow.scrapedAt || '',
    isLive: true,
    yfspUrl: liveMatch.yfspUrl || liveMatch.url || '',
  };
}

function scoreYfspCandidate(show, result) {
  if (!titleMatches(show.title, result.title)) return -1;
  const showYearInTitle = show.title.match(/20\d{2}/)?.[0];
  if (showYearInTitle && !result.title.includes(showYearInTitle)) return -1;
  let score = 0;
  if (result.atypeName === show.mediaType) score += 40;
  if (show.regional && result.regional === show.regional) score += 20;
  if (show.year && result.postTime?.includes(String(show.year))) score += 8;
  if (!/第[一二三四五六七八九十\d]+季/u.test(show.title) && /第[一二三四五六七八九十\d]+季/u.test(result.title)) score -= 15;
  if (result.isIndex) score += 5;
  score += Math.min(10, Math.floor((result.hot || 0) / 300000));
  return score;
}

async function searchYfspTitle(show) {
  for (const query of titleCandidates(show.title)) {
    const url = `${YFSP_RANK_BASE}/v3/list/briefsearch?cinema=0&tags=${encodeURIComponent(query)}&star=&director=&page=1&size=12&orderby=0&desc=0`;
    try {
      const data = await fetchJSON(url);
      const results = data?.data?.info?.[0]?.result || [];
      const match = results
        .map(r => ({ result: r, score: scoreYfspCandidate(show, r) }))
        .filter(x => x.score >= 0)
        .sort((a, b) => b.score - a.score)[0]?.result;
      if (match?.contxt) {
        return {
          title: match.title || show.title,
          url: `https://www.yfsp.tv/play/${match.contxt}`,
          coverImg: match.imgPath || '',
          score: parseFloat(match.score) || 0,
          playCount: match.hot || 0,
          actor: match.starring || '',
          regional: match.regional || '',
          lang: match.lang || '',
          publishTime: match.postTime || '',
          updateStatus: match.lastName || '',
        };
      }
    } catch (e) {
      console.warn(`  [WARN] yfsp search failed for "${query}": ${e.message}`);
    }
    await sleep(150);
  }
  return null;
}

async function verifyYfspUrl(show, url) {
  if (!url) return false;
  try {
    const html = await fetchText(url);
    const title = html.match(/<meta\s+(?:name|property)=["'](?:title|og:title)["']\s+content=["']([^"']+)/i)?.[1]
      || html.match(/<title>([^<]+)/i)?.[1]
      || '';
    if (!title || title.includes('爱壹帆国际版-海量')) return false;
    const cleanTitle = title
      .replace(/-免费在线观看.*$/u, '')
      .replace(/-爱壹帆国际版.*$/u, '')
      .trim();
    return titleMatches(show.title, cleanTitle);
  } catch (e) {
    console.warn(`  [WARN] yfsp verify failed for "${show.title}": ${e.message}`);
    return false;
  }
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

// ════════════════════════════════════════════════════════════════
// 推荐算法
// ════════════════════════════════════════════════════════════════

const KDramaGenreBoost = {
  '喜剧': 30, '搞笑': 30, '浪漫': 25, '爱情': 20, '轻松': 25,
  '奇幻': 15, '都市': 15, '家庭': 15, '青春': 15, '职场': 10,
  '治愈': 20, '温馨': 20, '甜宠': 25,
  '悬疑': 5, '犯罪': 0, '惊悚': -10, '恐怖': -30,
  '剧情': 10, '古装': 5, '动作': 0,
  // 观众偏好加权(基于66部已看韩剧)
  '律师': 15, '法律': 15, '法官': 15, '检察官': 10,
  '身份': 15, '伪装': 15, '冒充': 15, '替身': 15,
  '漫改': 10, '改编': 10,
  '办公室': 10, '职场剧': 10,
};

const KDramaNegative = [
  '血腥', '暴力', '虐杀', '心理变态', '黑暗', '恐怖', '丧尸',
  '地狱', '灵异', '猎奇', '自残', '自杀', '抑郁', '压抑',
];

const VarietyBoost = {
  // 核心轻松搞笑加权
  '真人秀': 20, '搞笑': 35, '喜剧': 35, '幽默': 30, '欢乐': 25, '爆笑': 25,
  '竞技': 15, '旅行': 20, '游戏': 25, '户外': 18,
  '脱口秀': 20, '访谈': 10, '选秀': 10,
  '生活': 15, '美食': 15, '慢生活': 15, '治愈': 15, '温馨': 15,
  '推理': 12, '探案': 12, '剧本杀': 12,
  '音乐': 8, '竞演': 8, '舞台': 8,
  '相声': 20, '小品': 20, 'sketch': 20,
  // 明星加成（轻量）
  '沈腾': 5, '贾玲': 5, '邓超': 5, '陈赫': 5, '大张伟': 5, '杨迪': 5,
  '何炅': 5, '撒贝宁': 5, '李诞': 3,
};

const VarietyExclude = ['浪姐', '乘风', '姐姐们', '女儿们的恋爱', '怦然再心动', '我们离婚了'];

// 轻松搞笑综艺偏好关键词（用于收录判断）
const VarietyFunnyKeywords = ['搞笑', '喜剧', '幽默', '欢乐', '爆笑', '脱口秀', '相声', '小品', '游戏', '旅行', '生活'];
const VarietyHighWeightHosts = ['沈腾', '贾玲', '邓超', '陈赫', '鹿晗', '大张伟', '杨迪', '何炅', '撒贝宁', '李诞', '岳云鹏', '黄子韬', '孙红雷'];

function scoreKDrama(s) {
  let sc = 0;
  const t = `${s.cidMapper} ${s.contentType} ${s.description} ${s.title}`.toLowerCase();
  for (const [g, b] of Object.entries(KDramaGenreBoost)) if (t.includes(g)) sc += b;
  for (const kw of KDramaNegative) if (t.includes(kw)) sc -= 40;
  if (s.score > 0) sc += s.score * 5;
  if (s.playCount > 100000) sc += 15; else if (s.playCount > 50000) sc += 10; else if (s.playCount > 10000) sc += 5;
  if (s.year >= CURRENT_YEAR) sc += 25; else if (s.year >= CURRENT_YEAR - 1) sc += 15; else if (s.year >= CURRENT_YEAR - 2) sc += 8;
  if (s.score >= 8.5 && s.year >= 2015) sc += 25;
  if (s.isComplete) sc += 10;
  return Math.max(0, Math.round(sc));
}

function scoreVariety(s) {
  let sc = 0;
  const t = `${s.cidMapper} ${s.contentType} ${s.description} ${s.title}`.toLowerCase();
  for (const [g, b] of Object.entries(VarietyBoost)) if (t.includes(g)) sc += b;
  for (const kw of VarietyExclude) if (s.title.includes(kw)) return -1;

  // 评分加成
  if (s.score > 0) sc += s.score * 5;

  // 播放量加成
  if (s.playCount > 500000) sc += 20;
  else if (s.playCount > 100000) sc += 15;
  else if (s.playCount > 50000) sc += 10;
  else if (s.playCount > 10000) sc += 5;

  // 年份新鲜度加成（综艺更强调新）
  if (s.year >= CURRENT_YEAR) sc += 30;
  else if (s.year >= CURRENT_YEAR - 1) sc += 15;
  else if (s.year >= CURRENT_YEAR - 2) sc += 5;

  // 经典加成
  if (s.isClassic) sc += 15;

  // 连载中加成（正在更新的综艺更有追看价值）
  if (s.isSerial && !s.isComplete) sc += 10;

  // 轻松搞笑类型额外加权
  const funnyScore = VarietyFunnyKeywords.filter(kw => t.includes(kw)).length;
  sc += funnyScore * 5;

  // 明星卡司加权
  const hostBoost = VarietyHighWeightHosts.filter(h => (s.actor || '').includes(h)).length;
  sc += hostBoost * 3;

  return Math.max(0, Math.round(sc));
}

// ════════════════════════════════════════════════════════════════
// GitHub Models AI 评分增强
// ════════════════════════════════════════════════════════════════

const GITHUB_MODELS_API = 'https://models.github.ai/inference/chat/completions';
const GITHUB_MODEL = 'openai/gpt-4.1-mini';
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
// 多个免费模型,按能力排序;每次随机顺序轮询,分散限流
const OPENROUTER_MODELS = [
  'google/gemma-4-31b-it:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'google/gemma-4-26b-a4b-it:free',
  'z-ai/glm-4.5-air:free',
  'minimax/minimax-m2.5:free',
];
const AI_BATCH_SIZE = 25;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function callModelsAPI(messages, { temperature = 0.3, timeout = 60000 } = {}) {
  // 1. 优先用 GitHub Models
  const ghToken = process.env.GITHUB_TOKEN || process.env.MODELS_TOKEN;
  if (ghToken) {
    const result = await _callEndpoint(GITHUB_MODELS_API, GITHUB_MODEL, ghToken, messages, temperature, timeout);
    if (result !== null) return result;
    console.log('  [AI] GitHub Models 不可用,切换 OpenRouter...');
  }

  // 2. 备用: OpenRouter 免费模型(账号级限流,一次 429 → 等待后只试一个模型)
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    const models = shuffle(OPENROUTER_MODELS);
    // 直接试第一个
    let result = await _callEndpoint(OPENROUTER_API, models[0], orKey, messages, temperature, timeout);
    if (result !== null) {
      console.log(`  [AI] 使用 OpenRouter: ${models[0]}`);
      return result;
    }
    // 如果 429(账号级), 等 60s 后只再试一个模型(避免逐个尝试浪费时间)
    console.log('  [AI] OpenRouter 限流,等 60s 后重试...');
    await sleep(60000);
    result = await _callEndpoint(OPENROUTER_API, models[1] || models[0], orKey, messages, temperature, timeout);
    if (result !== null) {
      console.log(`  [AI] 使用 OpenRouter: ${models[1] || models[0]}`);
      return result;
    }
  }

  return null;
}

async function _callEndpoint(url, model, token, messages, temperature, timeout, retries = 1) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (url.includes('models.github.ai')) headers['X-GitHub-Api-Version'] = '2026-03-10';
  const body = JSON.stringify({ model, messages, temperature });

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
      if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10);
        const waitSec = retryAfter > 0 ? Math.min(retryAfter, 120) : 30;
        if (attempt < retries) {
          console.log(`  [AI] ${model}: 429 限流,等 ${waitSec}s 后重试...`);
          await sleep(waitSec * 1000);
          continue;
        }
        return null;
      }
      if (!r.ok) { return null; }
      const data = await r.json();
      return data.choices?.[0]?.message?.content || null;
    } catch { return null; }
    finally { clearTimeout(t); }
  }
  return null;
}

const AI_SCORE_SYSTEM = `你是"剧荒救星"推荐助手。根据观众的实际观影偏好评估每部剧的推荐度。

观众画像(基于66部已看韩剧分析):
- 偏好类型: 爱情/浪漫喜剧(36%), 法律/犯罪+喜剧(32%), 悬疑推理(24%), 奇幻(11%)
- 偏好平台: tvN(26%), MBC(18%), SBS(12%), JTBC(9%)
- 偏好主题: 身份互换/伪装关系/律师题材/漫改/治愈温馨
- 偏好标签: romance, romcom, lawyer, hidden identity, pretend relationship, healing, webtoon adaptation
- 零容忍: 恐怖/丧尸/血腥/极端暴力(66部中0部)
- 轻度偏好: 悲剧/过于沉重的剧情(仅偶尔看)

高分剧参考: 请回答1988(9.7), 善意的竞争(8.8), 机智的医生生活(9.5), 酒鬼都市女人们(8.8), 妈妈朋友的儿子(8.3), 那家伙是黑炎龙(8.1)

评分标准(0-100):
- 90-100: 完全匹配观众口味的必看佳作(如: 浪漫喜剧+律师+身份互换+tvN)
- 70-89: 高度匹配(如: 甜蜜爱情/轻松犯罪/治愈系/漫改)
- 50-69: 部分匹配(如: 纯悬疑无喜剧元素/纯剧情无爱情线)
- 30-49: 弱匹配(如: 纯动作/纯历史/纯家庭剧)
- 0-29: 不匹配(如: 恐怖/血腥/过于沉重悲剧)

核心加分: romcom(+20) 律师/法律(+15) 身份互换(+15) 治愈温馨(+15) tvN/ENA(+10) 漫改(+10) 高口碑(+10)
核心减分: 恐怖血腥(-50) 过于沉重(-20) 纯悲剧(-20) 节奏拖沓(-15)

观众已看剧(用于相似度匹配): 365逆转命运的1年,爱过之后来临的,爱情发芽中,爱情怎么翻译,爱在独木桥,绑架之日,春夜,都市男女爱情法,恶缘,恶之花,恩爱的盗贼大人,法官李汉英,高斯电子公司,公益律师,好搭档,好或坏的东载,机智住院医生生活,家族计划,监察,健将联盟,江南重案组,今天也很可爱的狗,金部长的梦想人生,金汤匙,酒鬼都市女人们,绝命辩护,来自地狱的法官,劳务师卢武镇,联结,鬣狗式生存,灵指,妈妈朋友的儿子,梦想成为律师的律师们,模范出租车,魔女的法庭,那个男人的记忆法,那家伙是黑炎龙,权欲之巅,瑞草洞,莎拉的真伪人生,善良的女人夫世弥,善意的竞争,社长的菜单,申社长计划,首尔破笑组,台风商社,特工家族,未知的首尔,我的解放日记,我的完美秘书,卧底洪小姐,现在拨打的电话,行骗天下KR,夜晚开的花,因为不想吃亏,有益的欺诈,又是吴海英,宇宙MarryMe,再次我的人生,在你灿烂的季节,照明商店,争锋相辩,政坛旋风,只是相爱的关系,走到月亮为止,协商的技术

返回 JSON 数组: [{"id":"剧ID","s":推荐分,"r":"一句话理由"}]`;

const AI_DISCOVERY_SYSTEM = `你是"剧荒救星"新剧筛选助手。根据观众偏好判断新发现的韩剧是否值得收录。

观众偏好(66部已看韩剧):
- 最爱: 爱情/浪漫喜剧/律师题材/身份互换/治愈系/漫改
- 喜欢: 轻松犯罪(犯罪+喜剧)/悬疑推理/奇幻/办公室喜剧
- 接受: 纯剧情/历史古装(偶尔)
- 不喜欢: 恐怖/丧尸/血腥/过于沉重悲剧
- 偏好平台: tvN > MBC > SBS > JTBC > ENA > Netflix

收录标准:
- 必须是电视剧(非电影/综艺)
- romcom/律师/身份互换/治愈 → 推荐度自动 >= 50
- 纯犯罪/纯悬疑无喜剧 → 需口碑好才收录
- 恐怖血腥/沉重悲剧 → 不收录(ok=false)
- 推荐度 >= 40 才值得收录

返回 JSON 数组: [{"id":"剧ID","ok":true/false,"s":推荐度(0-100),"r":"理由"}]`;

async function aiScoreShows(shows) {
  if (!process.env.GITHUB_TOKEN && !process.env.MODELS_TOKEN) {
    console.log('  [AI] 未找到 token,跳过 AI 评分');
    return new Map();
  }

  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // 包含: 无 aiScoredAt 的、7天前的、或有 aiScoredAt 但无 aiScore 的(上次 API 漏返回的)
  const toScore = shows.filter(s =>
    !s.aiScoredAt || !s.aiScore || new Date(s.aiScoredAt).getTime() < oneWeekAgo
  );
  if (!toScore.length) {
    console.log('  [AI] 所有剧集已有 AI 评分,跳过');
    return new Map();
  }

  console.log(`  [AI] 评分 ${toScore.length} 部剧 (${shows.length - toScore.length} 部已有缓存)...`);
  const results = new Map();

  for (let i = 0; i < toScore.length; i += AI_BATCH_SIZE) {
    const batch = toScore.slice(i, i + AI_BATCH_SIZE);
    const items = batch.map(s => ({
      id: s.id,
      title: s.title,
      year: s.year,
      genre: s.contentType || '',
      desc: (s.description || '').slice(0, 150),
      score: s.score,
      plays: s.playCount,
      actor: (s.actor || '').slice(0, 40),
    }));

    const prompt = `评估以下 ${batch.length} 部剧的推荐度:\n${JSON.stringify(items)}`;
    const resp = await callModelsAPI([
      { role: 'system', content: AI_SCORE_SYSTEM },
      { role: 'user', content: prompt },
    ]);

    if (resp) {
      try {
        const arr = JSON.parse(resp.match(/\[[\s\S]*\]/)?.[0] || '[]');
        for (const item of arr) {
          if (item.id && typeof item.s === 'number') {
            results.set(item.id, { score: Math.max(0, Math.min(100, item.s)), reason: item.r || '' });
          }
        }
      } catch (e) {
        console.warn(`  [AI] 解析评分失败: ${e.message}`);
      }
    }
    if (i + AI_BATCH_SIZE < toScore.length) await sleep(1000);
  }

  // 不重试 — 漏掉的剧靠 7 天缓存+下次定时任务自然补上,节省 API 调用
  const missed = toScore.filter(s => !results.has(s.id));
  if (missed.length > 0) console.log(`  [AI] ${missed.length} 部未返回评分,下次运行自动补上`);
  console.log(`  [AI] 获取到 ${results.size} 条评分结果`);
  return results;
}

async function aiEvaluateDiscovery(discovered) {
  if ((!process.env.GITHUB_TOKEN && !process.env.MODELS_TOKEN) || !discovered.length) return discovered;

  console.log(`  [AI] 筛选 ${discovered.length} 部新发现韩剧...`);
  const results = new Map();

  for (let i = 0; i < discovered.length; i += AI_BATCH_SIZE) {
    const batch = discovered.slice(i, i + AI_BATCH_SIZE);
    const items = batch.map(s => ({
      id: s.id, title: s.title, year: s.year,
      genre: s.contentType || '', score: s.score,
      plays: s.playCount, actor: (s.actor || '').slice(0, 40),
    }));

    const prompt = `筛选以下 ${batch.length} 部新发现韩剧:\n${JSON.stringify(items)}`;
    const resp = await callModelsAPI([
      { role: 'system', content: AI_DISCOVERY_SYSTEM },
      { role: 'user', content: prompt },
    ]);

    if (resp) {
      try {
        const arr = JSON.parse(resp.match(/\[[\s\S]*\]/)?.[0] || '[]');
        for (const item of arr) {
          if (item.id) results.set(item.id, { ok: !!item.ok, score: item.s || 0, reason: item.r || '' });
        }
      } catch (e) {
        console.warn(`  [AI] 解析筛选结果失败: ${e.message}`);
      }
    }
    if (i + AI_BATCH_SIZE < discovered.length) await sleep(1000);
  }

  for (const s of discovered) {
    const ai = results.get(s.id);
    if (ai) {
      s.aiDiscoveryOk = ai.ok;
      s.aiDiscoveryScore = ai.score;
      s.aiDiscoveryReason = ai.reason;
    }
  }

  const accepted = discovered.filter(s => s.aiDiscoveryOk !== false);
  console.log(`  [AI] 筛选结果: ${accepted.length}/${discovered.length} 部通过`);
  return accepted;
}

async function aiEnhanceDescriptions(shows) {
  if (!process.env.GITHUB_TOKEN && !process.env.MODELS_TOKEN) return 0;

  const targets = shows.filter(s => !s.description || s.description.length < 20);
  if (!targets.length) return 0;

  console.log(`  [AI] 增强 ${targets.length} 个短描述...`);
  let enhanced = 0;

  for (let i = 0; i < targets.length; i += AI_BATCH_SIZE) {
    const batch = targets.slice(i, i + AI_BATCH_SIZE);
    const items = batch.map(s => ({
      id: s.id, title: s.title, year: s.year,
      genre: s.contentType || '', actor: (s.actor || '').slice(0, 40),
    }));

    const prompt = `为以下剧生成简洁吸引人的中文推荐语(50-80字),突出看点和适合人群:\n${JSON.stringify(items)}`;
    const resp = await callModelsAPI([
      { role: 'system', content: '你是剧集推荐文案专家。为每部剧写一句简洁吸引人的中文推荐语。返回JSON数组:[{"id":"剧ID","d":"推荐语"}]' },
      { role: 'user', content: prompt },
    ]);

    if (resp) {
      try {
        const arr = JSON.parse(resp.match(/\[[\s\S]*\]/)?.[0] || '[]');
        const map = new Map(arr.filter(x => x.id && x.d).map(x => [x.id, x.d]));
        for (const s of batch) {
          const desc = map.get(s.id);
          if (desc && (!s.description || s.description.length < 20)) {
            s.description = desc;
            s.descriptionSource = 'ai';
            enhanced++;
          }
        }
      } catch {}
    }
    if (i + AI_BATCH_SIZE < targets.length) await sleep(1000);
  }

  console.log(`  [AI] 增强了 ${enhanced} 个描述`);
  return enhanced;
}

// ════════════════════════════════════════════════════════════════
// 精选推荐库(韩剧 + 综艺) — 补充 API 无法直接获取的内容
// ════════════════════════════════════════════════════════════════

const SEED_KDRAMAS = [
  // ── 2026 新剧 ──
  { id:'seed_kd_2026_01', title:'爱情怎么翻译', year:2026, score:9.5, playCount:2550623, contentType:'爱情', actor:'金宣虎,高允贞,福士苍汰,李伊潭,崔佑成', description:'跨语言爱情故事,金宣虎与高允贞主演。2026年度口碑最高韩剧。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_02', title:'21世纪大君夫人', year:2026, score:8.6, playCount:2130916, contentType:'喜剧·爱情·奇幻', actor:'李知恩,边佑锡,鲁常泫,孔升延', description:'IU与边佑锡主演的奇幻爱情。古代大君夫人穿越到现代,笑料不断又浪漫满分。2026年度爆款。', totalEpisodes:16, isComplete:false, currentEpisode:8, regional:'韩国', lang:'韩语', isSerial:true },
  { id:'seed_kd_2026_03', title:'订阅男友', year:2026, score:8.8, playCount:519747, contentType:'喜剧·爱情', actor:'金智秀,徐仁国,孔敏晶', description:'BLACKPINK金智秀主演的浪漫喜剧。10集完结,轻松甜蜜。', totalEpisodes:10, isComplete:true, currentEpisode:10, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_04', title:'理事长和我的秘密关系', year:2026, score:8.4, playCount:857533, contentType:'爱情', actor:'崔振赫,吴涟序,洪宗玄,金多顺', description:'霸道理事长的办公室秘密恋情。12集完结,轻松甜蜜。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_05', title:'在你的灿烂季节', year:2026, score:8.4, playCount:814231, contentType:'剧情·治愈', actor:'李圣经,蔡钟协,李美淑', description:'李圣经主演的治愈系剧情剧。12集完结,温暖感人。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_06', title:'努力克服自卑的我们', year:2026, score:8.5, playCount:124774, contentType:'剧情·喜剧', actor:'具教焕,高允贞,吴正世,姜末琴', description:'具教焕与高允贞主演的成长喜剧。正在连载,口碑出色。', totalEpisodes:12, isComplete:false, currentEpisode:6, regional:'韩国', lang:'韩语', isSerial:true },
  { id:'seed_kd_2026_07', title:'死亡之花', year:2026, score:8.6, playCount:258558, contentType:'剧情·悬疑', actor:'厉云,成东日,琴赛璐', description:'厉云与成东日主演的悬疑剧情。8集完结,口碑出色。', totalEpisodes:8, isComplete:true, currentEpisode:8, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_08', title:'春日狂热', year:2026, score:7.9, playCount:680669, contentType:'爱情', actor:'安普贤,李主傧,车叙元', description:'安普贤主演的浪漫爱情剧。12集完结,轻松甜蜜。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_09', title:'给你宇宙', year:2026, score:7.6, playCount:813744, contentType:'剧情·青春', actor:'裴仁赫,卢正义,朴栖含', description:'裴仁赫与卢正义主演的青春剧情。12集完结,热度高。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_10', title:'权欲之巅', year:2026, score:7.9, playCount:563881, contentType:'剧情·政治', actor:'朱智勋,河智苑,林珍娜,吴正世', description:'朱智勋与河智苑主演的政治权谋剧。10集完结,演技派云集。', totalEpisodes:10, isComplete:true, currentEpisode:10, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_11', title:'秒杀爱情', year:2026, score:7.6, playCount:90543, contentType:'喜剧·爱情', actor:'安孝燮,蔡元彬,金汎,高斗心', description:'安孝燮与蔡元彬主演的浪漫喜剧。正在连载,轻松有趣。', totalEpisodes:16, isComplete:false, currentEpisode:4, regional:'韩国', lang:'韩语', isSerial:true },
  { id:'seed_kd_2026_12', title:'赌金', year:2026, score:7.2, playCount:71886, contentType:'剧情', actor:'朴宝英,金圣喆,李光洙,金熙元', description:'朴宝英与李光洙主演的剧情剧。正在连载,阵容豪华。', totalEpisodes:16, isComplete:false, currentEpisode:2, regional:'韩国', lang:'韩语', isSerial:true },
  { id:'seed_kd_2026_13', title:'魔女之吻', year:2026, score:6.7, playCount:356464, contentType:'爱情·奇幻', actor:'朴敏英,魏嘏隽,金正贤', description:'朴敏英与魏嘏隽主演的奇幻爱情。12集完结。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_14', title:'今天开始是人类', year:2026, score:7.2, playCount:335117, contentType:'爱情·奇幻', actor:'金惠奫,朴所罗门,张东柱', description:'金惠奫与朴所罗门主演的奇幻爱情。12集完结。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  // ── 2025 热播韩剧 ──
  { id:'seed_kd_2025_01', title:'背着善宰跑', year:2025, score:9.0, playCount:500000, contentType:'喜剧·爱情·奇幻', actor:'边佑锡,金惠奫', description:'穿越时空的甜蜜奇幻爱情,顶级偶像和铁粉的浪漫故事。2025年现象级韩剧,轻松治愈必看。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_02', title:'妈妈朋友的儿子', year:2025, score:8.3, playCount:350000, contentType:'喜剧·爱情', actor:'丁海寅,庭沼珉', description:'青梅竹马长大后的甜蜜重逢恋爱。治愈系浪漫喜剧,满满的温暖和笑料。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_03', title:'凌晨两点的灰姑娘', year:2025, score:8.5, playCount:300000, contentType:'喜剧·爱情', actor:'申铉彬,文相敏', description:'财阀千金变身灰姑娘的搞笑浪漫故事。轻松下饭,甜度超标。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_04', title:'问问星星吧', year:2025, score:7.8, playCount:200000, contentType:'喜剧·爱情·科幻', actor:'李敏镐,孔晓振', description:'宇航员和妇产科医生在太空站的浪漫喜剧。韩剧史上首部太空题材,新颖有趣。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_05', title:'我的完美秘书', year:2025, score:8.1, playCount:250000, contentType:'喜剧·爱情·职场', actor:'韩志旼,李浚赫', description:'冷面女CEO和万能男秘书的反转职场恋爱。轻松搞笑,化学反应满分。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_06', title:'法官大人', year:2025, score:8.4, playCount:180000, contentType:'剧情·喜剧·法律', actor:'孙贤周,金明民', description:'严厉法官和菜鸟检察官的法庭喜剧。正义与搞笑并存,节奏明快。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_07', title:'善意的竞争', year:2025, score:8.8, playCount:2033366, contentType:'剧情·喜剧·职场', actor:'李惠利,郑秀斌,姜惠元,吴友利,崔荣宰', description:'性格截然相反的女律师搭档办案,在竞争中建立友情。2025年高收视职场剧。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_08', title:'那家伙是黑炎龙', year:2025, score:8.1, playCount:661136, contentType:'喜剧·爱情', actor:'文佳煐,崔显旭,林世美', description:'游戏女主播和黑炎龙的甜蜜恋爱。电竞题材轻喜剧,轻松有趣。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  // ── 2024 热播韩剧 ──
  { id:'seed_kd_2024_01', title:'泪之女王', year:2024, score:8.7, playCount:4207174, contentType:'喜剧·爱情', actor:'金秀贤,金智媛,朴成焄,郭东延', description:'金秀贤与金智媛主演的财阀爱情剧。2024年收视冠军,轻松甜蜜又有泪点。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2024_02', title:'照明商店', year:2024, score:8.9, playCount:946907, contentType:'奇幻·悬疑·剧情', actor:'朱智勋,朴宝英,严太九,金雪炫,李姃垠', description:'连接生死的神秘照明商店。奇幻悬疑剧,氛围感满分,每个故事都触动人心。', totalEpisodes:8, isComplete:true, currentEpisode:8, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2024_03', title:'低谷医生', year:2024, score:8.3, playCount:829404, contentType:'喜剧·爱情·医疗', actor:'朴信惠,朴炯植,尹博', description:'两位失意医生相遇后互相治愈的温暖喜剧。朴信惠和朴炯植的化学反应满分。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2024_04', title:'正年', year:2024, score:8.6, playCount:329008, contentType:'剧情·喜剧·音乐', actor:'金泰梨,辛睿恩,文素利,罗美兰', description:'天才少女国乐人的成长故事。金泰梨演技炸裂,笑中带泪的女性励志剧。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2024_05', title:'贞淑的推销', year:2024, score:8.3, playCount:527698, contentType:'喜剧·剧情', actor:'金素妍,金善映,李世熙', description:'1990年代保险推销员的创业喜剧。金素妍主演,轻松有趣又充满正能量。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2024_06', title:'好或坏的东载', year:2024, score:8.9, playCount:204186, contentType:'悬疑·犯罪·剧情', actor:'李浚赫,朴成雄', description:'秘密森林衍生剧。检察官东载游走灰色地带的故事。演技派对决,节奏紧凑。', totalEpisodes:10, isComplete:true, currentEpisode:10, regional:'韩国', lang:'韩语', isSerial:false },
  // ── 2022-2023 高口碑韩剧 ──
  { id:'seed_kd_2023_01', title:'黑暗荣耀第2季', year:2023, score:9.5, playCount:2641606, contentType:'剧情·悬疑', actor:'宋慧乔,李到晛,林智妍,廉惠兰,朴成焄', description:'黑暗荣耀完结篇。复仇大结局震撼全球,Netflix年度现象级韩剧。', totalEpisodes:8, isComplete:true, currentEpisode:8, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2023_02', title:'超异能族', year:2023, score:9.3, playCount:2552693, contentType:'剧情·奇幻·动作', actor:'柳承龙,韩孝周,赵寅成,车太贤,高允贞', description:'超能力家族的热血故事。Disney+口碑大爆,融合亲情与动作,笑泪交织。', totalEpisodes:20, isComplete:true, currentEpisode:20, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2022_01', title:'黑暗荣耀', year:2022, score:9.2, playCount:2776014, contentType:'剧情·悬疑', actor:'宋慧乔,李到晛,林智妍,廉惠兰,朴成焄', description:'校园暴力受害者精心布局复仇的故事。宋慧乔颠覆性演出,Netflix全球爆红。', totalEpisodes:8, isComplete:true, currentEpisode:8, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2022_02', title:'财阀家的小儿子', year:2022, score:7.9, playCount:3300465, contentType:'剧情·奇幻·职场', actor:'宋仲基,李星民,申贤彬', description:'重生为财阀家小儿子的逆袭人生。宋仲基主演,2022年末收视爆棚。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2022_03', title:'王后伞下', year:2022, score:8.7, playCount:551312, contentType:'剧情·喜剧·古装', actor:'金惠秀,金海淑,文相敏', description:'王后为保护儿子们在宫廷中斗智斗勇。金惠秀气场全开,古装版虎妈喜剧。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  // ── 经典轻松韩剧 ──
  { id:'seed_kd_c01', title:'请回答1988', year:2015, score:9.7, playCount:999999, contentType:'剧情·喜剧·家庭', actor:'李惠利,柳俊烈,朴宝剑', description:'双门洞五家人的温暖日常。韩剧天花板,笑泪交织,百看不厌。', totalEpisodes:20, isComplete:true, currentEpisode:20, regional:'韩国', lang:'韩语', isSerial:false, isClassic:true },
  { id:'seed_kd_c02', title:'机智的医生生活', year:2020, score:9.5, playCount:800000, contentType:'剧情·喜剧·生活', actor:'曹政奭,柳演锡,郑敬淏,金大明,田美都', description:'五位医生好友的温馨日常。治愈系天花板,笑中带泪。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false, isClassic:true },
  { id:'seed_kd_c03', title:'机智的监狱生活', year:2017, score:9.4, playCount:700000, contentType:'剧情·喜剧', actor:'朴海秀,郑京浩,丁海寅', description:'明星棒球手入狱后的搞笑温馨故事。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false, isClassic:true },
  { id:'seed_kd_c04', title:'孤单又灿烂的神-鬼怪', year:2016, score:9.0, playCount:900000, contentType:'剧情·喜剧·奇幻·爱情', actor:'孔刘,金高银,李栋旭', description:'鬼怪和新娘的奇幻浪漫。笑料百出又催泪的经典。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false, isClassic:true },
  { id:'seed_kd_c05', title:'大力女都奉顺', year:2017, score:8.6, playCount:600000, contentType:'喜剧·爱情·动作', actor:'朴宝英,朴炯植', description:'拥有怪力的女主和CEO的甜蜜搞笑恋爱。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false, isClassic:true },
  { id:'seed_kd_c06', title:'举重妖精金福珠', year:2016, score:8.6, playCount:550000, contentType:'喜剧·爱情·青春', actor:'李圣经,南柱赫', description:'举重少女和游泳少年的清新校园恋爱。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false, isClassic:true },
  { id:'seed_kd_c07', title:'文森佐', year:2021, score:8.6, playCount:750000, contentType:'剧情·喜剧·犯罪', actor:'宋仲基,全汝彬', description:'黑手党顾问用非常手段对抗恶势力。黑色幽默爽剧。', totalEpisodes:20, isComplete:true, currentEpisode:20, regional:'韩国', lang:'韩语', isSerial:false, isClassic:true },
  { id:'seed_kd_c08', title:'未生', year:2014, score:9.3, playCount:500000, contentType:'剧情·职场', actor:'任时完,姜素拉,李圣旻', description:'围棋少年的职场成长故事。真实深刻,引发共鸣。', totalEpisodes:20, isComplete:true, currentEpisode:20, regional:'韩国', lang:'韩语', isSerial:false, isClassic:true },
  { id:'seed_kd_c09', title:'我的ID是江南美人', year:2018, score:8.0, playCount:400000, contentType:'剧情·爱情·青春', actor:'林秀香,车银优', description:'整容后进入大学的女孩面对偏见与真爱。青春治愈。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c10', title:'金秘书为何那样', year:2018, score:8.4, playCount:650000, contentType:'喜剧·爱情', actor:'朴叙俊,朴敏英', description:'自恋副会长和完美秘书的搞笑办公室恋爱。甜到上头。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c11', title:'触及真心', year:2019, score:8.1, playCount:450000, contentType:'喜剧·爱情', actor:'李栋旭,刘仁娜', description:'过气女星到律师事务所当秘书的甜蜜恋爱。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c12', title:'社内相亲', year:2022, score:8.3, playCount:700000, contentType:'喜剧·爱情', actor:'安孝燮,金世正', description:'替朋友相亲却遇到公司老板的搞笑误会恋爱。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c13', title:'酒鬼都市男女', year:2022, score:8.8, playCount:350000, contentType:'喜剧·生活', actor:'李善彬,韩善伙,郑恩地', description:'三个酒鬼好友的生活日常。轻松搞笑,姐妹情深。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c14', title:'海岸村恰恰恰', year:2021, score:8.7, playCount:600000, contentType:'喜剧·爱情·生活', actor:'申敏儿,金宣虎', description:'都市女医生和海边万能男的治愈恋爱。温暖满分。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c15', title:'非常律师禹英禑', year:2022, score:8.6, playCount:800000, contentType:'剧情·喜剧', actor:'朴恩斌,姜泰伍,姜其永', description:'自闭症天才律师的成长故事。温暖治愈,充满感动。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c16', title:'闪亮的西瓜', year:2023, score:8.8, playCount:400000, contentType:'喜剧·奇幻·青春', actor:'厉云,崔显旭,薛仁雅', description:'穿越回1995年的青春音乐奇幻剧。热血搞笑又感人。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c17', title:'欢迎来到王之国', year:2023, score:8.0, playCount:500000, contentType:'喜剧·爱情', actor:'李俊昊,林允儿', description:'财阀继承人和酒店员工的甜宠恋爱。轻松甜蜜。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_c18', title:'死期将至', year:2023, score:8.5, playCount:350000, contentType:'剧情·奇幻·喜剧', actor:'徐仁国,朴素丹', description:'死亡后不断重生的奇幻黑色幽默。创意满分。', totalEpisodes:8, isComplete:true, currentEpisode:8, regional:'韩国', lang:'韩语', isSerial:false },
  // ── 悬疑探案(适度推荐,非血腥) ──
  { id:'seed_kd_s01', title:'信号', year:2016, score:9.2, playCount:600000, contentType:'悬疑·犯罪·剧情', actor:'李帝勋,赵震雄,金惠秀', description:'通过无线电连接过去和现在的刑警破案故事。悬疑烧脑,经典中的经典。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_s02', title:'秘密森林', year:2017, score:9.1, playCount:400000, contentType:'悬疑·犯罪·剧情', actor:'曹承佑,裴斗娜', description:'失去情感的检察官和正义女警联手破案。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_s03', title:'奇怪的律师禹英禑', year:2022, score:8.6, playCount:800000, contentType:'剧情·喜剧·法律', actor:'朴恩斌,姜泰伍', description:'自闭症天才律师的法庭故事。温暖有趣,不沉重。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
];

const SEED_VARIETY = [
  // ════════════════════════════════════════════════════════════════
  // 2026 热门轻松搞笑综艺（重点扩充）
  // ════════════════════════════════════════════════════════════════
  // ── 户外竞技/游戏搞笑 ──
  { id:'seed_var_2026_01', title:'奔跑吧', year:2026, score:7.5, playCount:500000, contentType:'真人秀·竞技·搞笑', actor:'李晨,郑恺,沙溢,白鹿,范丞丞,周深', description:'经典户外竞技真人秀,欢乐撕名牌大战,2026全新季爆笑回归。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周五' },
  { id:'seed_var_2026_01b', title:'奔跑吧第十季', year:2026, score:7.5, playCount:500000, contentType:'真人秀·竞技·搞笑', actor:'李晨,郑恺,沙溢,白鹿,范丞丞,周深', description:'奔跑吧第十季,经典游戏升级,笑料加量。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周五' },
  { id:'seed_var_2026_02', title:'王牌对王牌', year:2026, score:7.8, playCount:450000, contentType:'真人秀·游戏·搞笑', actor:'沈腾,贾玲,关晓彤,华晨宇,宋亚轩', description:'经典室内游戏综艺,沈腾贾玲的爆笑组合,2026年笑闹继续。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周六' },
  { id:'seed_var_2026_02b', title:'王牌对王牌第九季', year:2026, score:7.8, playCount:450000, contentType:'真人秀·游戏·搞笑', actor:'沈腾,贾玲,关晓彤,华晨宇', description:'王牌家族集结,经典游戏新玩法,全程高能爆笑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周六' },
  { id:'seed_var_2026_03', title:'极限挑战', year:2026, score:7.2, playCount:350000, contentType:'真人秀·竞技·搞笑', actor:'黄渤,黄磊,罗志祥,张艺兴', description:'男人帮的极限挑战,笑料不断,2026新征程开启。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_07', title:'你好星期六', year:2026, score:7.6, playCount:380000, contentType:'真人秀·游戏·搞笑', actor:'何炅,檀健次,王鹤棣,秦霄贤,李雪琴', description:'快乐大本营精神续作,何炅带队,每期嘉宾互动游戏,轻松搞笑不断档。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周六' },
  { id:'seed_var_2026_08', title:'萌探探探案', year:2026, score:7.4, playCount:320000, contentType:'真人秀·推理·搞笑', actor:'孙红雷,沙溢,黄子韬,杨迪,宋亚轩', description:'萌探家族欢乐探案,沉浸式剧本杀+搞笑互动,笑到停不下来。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_09', title:'青春环游记', year:2026, score:7.3, playCount:290000, contentType:'真人秀·旅行·搞笑', actor:'贾玲,杨洋,范丞丞,杨迪,郎朗', description:'青春旅行团边走边玩,游戏环节爆笑连连,治愈又欢乐。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },

  // ── 旅行/生活搞笑 ──
  { id:'seed_var_2026_04', title:'哈哈哈哈哈第5季', year:2026, score:8.2, playCount:300000, contentType:'真人秀·旅行·搞笑', actor:'邓超,陈赫,鹿晗,范志毅,王勉', description:'五哈兄弟团欢乐旅行,全程笑到停不下来。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_04b', title:'哈哈哈哈哈第6季', year:2026, score:8.1, playCount:350000, contentType:'真人秀·旅行·搞笑', actor:'邓超,陈赫,鹿晗,范志毅,王勉', description:'五哈兄弟继续出发,公路喜剧+真实旅行,笑点密集。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_10', title:'现在就出发', year:2026, score:7.7, playCount:340000, contentType:'真人秀·旅行·搞笑', actor:'沈腾,贾冰,范丞丞,白敬亭,金晨', description:'明星嘉宾出发去野外,露营+游戏+美食,轻松解压的旅行综艺。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_10b', title:'现在就出发第二季', year:2026, score:7.7, playCount:340000, contentType:'真人秀·旅行·搞笑', actor:'沈腾,贾冰,范丞丞,白敬亭', description:'现在就出发第二季,明星野外露营欢乐多,轻松治愈。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_11', title:'五十公里桃花坞', year:2026, score:7.5, playCount:260000, contentType:'真人秀·生活·搞笑', actor:'宋丹丹,汪苏泷,李雪琴,王鹤棣,孟子义', description:'明星群居社交实验,尴尬与欢乐齐飞,真实又好笑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_12', title:'种地吧', year:2026, score:8.5, playCount:420000, contentType:'真人秀·生活·搞笑', actor:'十个勤天,蒋敦豪,鹭卓,李耕耘', description:'十个年轻人真实种地,从播种到收获,热血又搞笑,治愈力满分。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_13', title:'快乐的大人', year:2026, score:7.8, playCount:220000, contentType:'真人秀·生活·搞笑', actor:'沈月,王敬轩,吴宇恒,周彦辰', description:'沈月和她的朋友们的真实日常,友情治愈,笑料自然不做作。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_14', title:'闪亮的日子', year:2026, score:7.6, playCount:180000, contentType:'真人秀·生活·搞笑', actor:'陆虎,张远,王栎鑫,陈楚生,苏醒', description:'再就业男团日常记录,真实友情+搞笑互动,轻松下饭。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_15', title:'快乐再出发', year:2026, score:8.3, playCount:310000, contentType:'真人秀·旅行·搞笑', actor:'陈楚生,苏醒,王栎鑫,张远,王铮亮,陆虎', description:'再就业男团的音乐旅行,熟人局的化学反应,笑中带泪的宝藏综艺。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_16', title:'你好生活', year:2026, score:7.4, playCount:200000, contentType:'真人秀·生活·搞笑', actor:'撒贝宁,尼格买提,康辉,李梓萌', description:'央视主持人团建综艺,慢生活+真诚对话,温馨又有趣。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_17', title:'地球超新鲜', year:2026, score:7.3, playCount:250000, contentType:'真人秀·旅行·搞笑', actor:'待定', description:'全新户外探索综艺,明星嘉宾走访各地,体验风土人情,轻松搞笑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_18', title:'向往的生活', year:2026, score:8.3, playCount:400000, contentType:'真人秀·生活·搞笑', actor:'何炅,黄磊,彭昱畅,张子枫', description:'田园慢生活综艺,温馨治愈,笑料不断。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },

  // ── 喜剧/脱口秀 ──
  { id:'seed_var_2026_19', title:'喜剧大会', year:2026, score:7.5, playCount:210000, contentType:'喜剧·竞演·搞笑', actor:'郭麒麟,李诞,谢娜,大张伟', description:'喜剧人竞演舞台,sketch小品+即兴喜剧,笑声不断。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_20', title:'脱口秀和TA的朋友们', year:2026, score:7.6, playCount:230000, contentType:'脱口秀·搞笑', actor:'李诞,徐志胜,何广智,鸟鸟,童漠男', description:'脱口秀好友局,新老选手同台竞技,爆梗频出。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_21', title:'喜人奇妙夜', year:2026, score:7.8, playCount:190000, contentType:'喜剧·竞演·搞笑', actor:'马东,黄渤,徐峥,于和伟', description:'一年一度喜剧大赛团队新作, Sketch喜剧竞演,创意与笑点齐飞。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_22', title:'德云斗笑社', year:2026, score:7.4, playCount:280000, contentType:'喜剧·相声·搞笑', actor:'郭德纲,于谦,岳云鹏,烧饼,孟鹤堂', description:'德云社团综,相声竞演+游戏互动,德云男孩的快乐源泉。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_23', title:'吐槽大会', year:2026, score:7.2, playCount:170000, contentType:'脱口秀·搞笑', actor:'李诞,张绍刚,池子', description:'明星互怼的脱口秀盛宴,犀利吐槽+幽默回应,解压神器。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },

  // ── 音乐/舞台搞笑 ──
  { id:'seed_var_2026_24', title:'披荆斩棘的哥哥', year:2026, score:7.5, playCount:360000, contentType:'真人秀·音乐·竞演', actor:'陈小春,张智霖,李承铉,张云龙', description:'哥哥们的舞台竞演,兄弟情义+热血舞台,笑泪交织。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_25', title:'声生不息', year:2026, score:7.6, playCount:330000, contentType:'真人秀·音乐', actor:'何炅,王祖蓝,林子祥,叶倩文', description:'港乐/宝岛音乐盛典,金曲重现,情怀与感动并存。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_26', title:'我们的歌', year:2026, score:7.3, playCount:240000, contentType:'真人秀·音乐', actor:'林海,庾澄庆,那英,周深', description:'新老歌手搭档竞演,经典新唱,音乐碰撞出火花。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },

  // ── 密室/推理搞笑 ──
  { id:'seed_var_2026_05', title:'密室大逃脱', year:2026, score:8.0, playCount:280000, contentType:'真人秀·推理·搞笑', actor:'杨幂,大张伟,黄明昊,张国伟,许凯', description:'明星密室逃脱,紧张刺激又搞笑,2026新主题更烧脑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_27', title:'大侦探', year:2026, score:8.5, playCount:350000, contentType:'真人秀·推理·搞笑', actor:'何炅,张若昀,王鸥,魏晨,杨蓉', description:'明星推理探案,剧本杀沉浸体验,逻辑与笑料并存。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },

  // ════════════════════════════════════════════════════════════════
  // 经典必看搞笑综艺
  // ════════════════════════════════════════════════════════════════
  { id:'seed_var_c01', title:'奔跑吧兄弟', year:2014, score:7.8, playCount:800000, contentType:'真人秀·竞技·搞笑', actor:'邓超,李晨,陈赫,郑恺,王宝强,Angelababy', description:'初代跑男团的经典撕名牌,爆笑回忆,国产综艺里程碑。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c02', title:'极限挑战第一季', year:2015, score:9.2, playCount:700000, contentType:'真人秀·竞技·搞笑', actor:'黄渤,孙红雷,黄磊,罗志祥,王迅,张艺兴', description:'男人帮初代经典,神一般的综艺,智商与笑点的巅峰对决。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c03', title:'明星大侦探', year:2016, score:9.0, playCount:600000, contentType:'真人秀·推理·搞笑', actor:'何炅,撒贝宁,吴映洁,白敬亭,王鸥', description:'明星推理探案综艺,烧脑又搞笑,综N代口碑标杆。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c04', title:'脱口秀大会', year:2017, score:8.5, playCount:500000, contentType:'脱口秀·搞笑', actor:'李诞,王建国,呼兰,杨笠,庞博', description:'脱口秀选手的爆笑舞台,年度热梗制造机,笑到肚子疼。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c05', title:'欢乐喜剧人', year:2015, score:8.0, playCount:450000, contentType:'喜剧·竞演·搞笑', actor:'郭德纲,沈腾,宋小宝,贾玲,岳云鹏', description:'喜剧人巅峰对决,小品相声轮番上阵,欢乐不停歇。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c06', title:'吐槽大会', year:2016, score:7.8, playCount:400000, contentType:'脱口秀·搞笑', actor:'李诞,张绍刚,池子,王建国', description:'明星嘉宾互相吐槽,犀利幽默,解压爆笑综艺鼻祖。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c07', title:'奇葩说', year:2014, score:8.2, playCount:380000, contentType:'脱口秀·辩论·搞笑', actor:'马东,蔡康永,高晓松,马薇薇,肖骁', description:'观点碰撞的辩论综艺,金句频出,好笑又有深度。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c08', title:'快乐大本营', year:1997, score:8.0, playCount:900000, contentType:'真人秀·游戏·搞笑', actor:'何炅,谢娜,李维嘉,杜海涛,吴昕', description:'国民级综艺,游戏互动+明星嘉宾,几代人的快乐记忆。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c09', title:'一年一度喜剧大赛', year:2021, score:8.6, playCount:350000, contentType:'喜剧·竞演·搞笑', actor:'马东,李诞,黄渤,徐峥,于和伟', description:' Sketch喜剧竞演天花板,土豆吕严蒋龙张弛等新人辈出,创意无限。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
];

// ════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log(`[SCRAPER] 开始抓取 ${new Date().toISOString()}`);

  // ── 1. 从 API 抓取首页数据 (多页 × 多参数组合) ──
  const liveShows = new Map();
  const pages = Array.from({ length: 15 }, (_, i) => i + 1);
  const isnValues = [0, 1];

  for (const isn of isnValues) {
    for (const page of pages) {
      console.log(`  抓取 isn=${isn} page=${page}...`);
      const data = await fetchPage(page, isn);
      if (data) {
        for (const s of extractShows(data)) {
          const key = s.id;
          if (!liveShows.has(key)) liveShows.set(key, s);
        }
      }
      await sleep(600);
    }
  }

  console.log(`  抓取到 ${liveShows.size} 个独立节目 (API)`);

  // ── 2. 构建韩剧列表 (合并 API + 种子) ──
  const kdramaMap = new Map();
  for (const s of liveShows.values()) {
    if (s.regional === '韩国' && s.mediaType === '电视剧') {
      s.recommendScore = scoreKDrama(s);
      s.category = 'korean_drama';
      attachLinkFields(s, s.yfspUrl || s.url);
      kdramaMap.set(s.id, s);
    }
  }
  for (const s of SEED_KDRAMAS) {
    const liveMatch = findLiveTitleMatch(s, liveShows, '电视剧', show => show.regional === '韩国');
    const existingKey = liveMatch?.id || s.id;
    if (kdramaMap.has(existingKey)) continue;
    let show = { ...s, mediaType:'电视剧', type:4, coverImg:'', updateMsg:'', scrapedAt:'', isLive:false, isClassic:s.isClassic||false, seedId: s.id };
    show = applyLiveFields(show, liveMatch);
    show.recommendScore = scoreKDrama(show);
    show.category = 'korean_drama';
    attachLinkFields(show, show.yfspUrl, buildDoubanSubjectUrl(show.title));
    kdramaMap.set(existingKey, show);
  }

  // ── 3. 构建综艺列表 ──
  const varietyMap = new Map();
  for (const s of liveShows.values()) {
    if (s.regional === '大陆' && s.mediaType === '综艺') {
      const vsc = scoreVariety(s);
      if (vsc >= 0) {
        s.recommendScore = vsc;
        s.category = 'chinese_variety';
        attachLinkFields(s, s.yfspUrl || s.url);
        varietyMap.set(s.id, s);
      }
    }
    // 韩国综艺也算
    if (s.regional === '韩国' && s.mediaType === '综艺') {
      s.recommendScore = scoreVariety(s);
      s.category = 'chinese_variety';
      attachLinkFields(s, s.yfspUrl || s.url);
      varietyMap.set(s.id, s);
    }
  }
  for (const s of SEED_VARIETY) {
    const liveMatch = findLiveTitleMatch(s, liveShows, '综艺', show => ['大陆', '韩国'].includes(show.regional));
    const existingKey = liveMatch?.id || s.id;
    if (varietyMap.has(existingKey)) continue;
    let show = { ...s, mediaType:'综艺', type:5, coverImg:'', scrapedAt:'', isLive:false, isClassic:s.isClassic||false, seedId: s.id };
    show = applyLiveFields(show, liveMatch);
    show.recommendScore = scoreVariety(show);
    show.category = 'chinese_variety';
    attachLinkFields(show, show.yfspUrl, buildDoubanSubjectUrl(show.title));
    varietyMap.set(existingKey, show);
  }

  // ── 4. 其他电视剧 ──
  const otherDramas = [];
  for (const s of liveShows.values()) {
    if (s.mediaType === '电视剧' && s.regional !== '韩国' && !['恐怖'].includes(s.contentType)) {
      s.recommendScore = 0;
      s.category = 'other_drama';
      attachLinkFields(s, s.yfspUrl || s.url);
      otherDramas.push(s);
    }
  }

  // ── 5. 新韩剧监控扫描 (发现并自动收录高质量新剧) ──
  const discoveredShows = await discoverNewKDramas(liveShows, kdramaMap);
  for (const s of discoveredShows) {
    kdramaMap.set(s.id, s);
  }

  // ── 5.2. 新综艺监控扫描 (发现并自动收录轻松搞笑综艺) ──
  const discoveredVariety = await discoverNewVariety(liveShows, varietyMap);
  for (const s of discoveredVariety) {
    varietyMap.set(s.id, s);
  }

  // ── 5.5. AI 智能评分增强 ──
  // 先加载上次的 AI 评分并注入到 show 对象(让缓存过滤器识别,避免重复调用 API)
  // 同时加载 firstSeenAt 用于新内容标记(30天有效期)
  const prevFirstSeenMap = new Map();
  const prevTitleFirstSeenMap = new Map();
  if (existsSync(SHOWS_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(SHOWS_FILE, 'utf-8'));
      const prevMap = new Map();
      for (const s of [...(prev.koreanDramas || []), ...(prev.chineseVariety || []), ...(prev.otherDramas || [])]) {
        if (s.aiScore && s.aiScoredAt) prevMap.set(s.id, s);
        if (s.firstSeenAt) {
          prevFirstSeenMap.set(s.id, s.firstSeenAt);
          prevTitleFirstSeenMap.set(normalizeTitle(s.title), s.firstSeenAt);
        }
      }
      let restored = 0;
      for (const [id, show] of [...kdramaMap, ...varietyMap]) {
        if (!show.aiScore && prevMap.has(id)) {
          const p = prevMap.get(id);
          show.aiScore = p.aiScore;
          show.aiReason = p.aiReason;
          show.aiScoredAt = p.aiScoredAt;
          restored++;
        }
      }
      if (restored) console.log(`  [AI] 从上次结果恢复 ${restored} 部评分`);
    } catch {}
  }

  const allForAI = [...kdramaMap.values(), ...varietyMap.values()];
  const aiScores = await aiScoreShows(allForAI);
  for (const show of allForAI) {
    const ai = aiScores.get(show.id);
    if (ai) {
      show.aiScore = ai.score;
      show.aiReason = ai.reason;
      show.aiScoredAt = new Date().toISOString();
    }
    // 混合评分: 规则分为主体, AI 分作为 ±25 的调整
    if (show.aiScore != null) {
      // 综艺使用更温和的 AI 调整(±12.5),避免韩剧向 AI 误伤国产综艺
      const aiWeight = show.category === 'chinese_variety' ? 0.25 : 0.5;
      show.recommendScore = Math.max(0, Math.round(show.recommendScore + (show.aiScore - 50) * aiWeight));
    }
  }
  if (aiScores.size > 0) console.log(`  [AI] 已为 ${aiScores.size} 部节目调整推荐分`);

  // ── 6. 同步种子缓存 → 直播 ID (种子匹配直播节目后 ID 变了,缓存条目还在旧 ID 下) ──
  const imgCache = loadImageCache();
  for (const s of SEED_KDRAMAS) {
    const liveMatch = findLiveTitleMatch(s, liveShows, '电视剧', show => show.regional === '韩国');
    if (liveMatch && liveMatch.id !== s.id) {
      if (imgCache[s.id] && !imgCache[liveMatch.id]) imgCache[liveMatch.id] = imgCache[s.id];
      if (imgCache[liveMatch.id] && !imgCache[s.id]) imgCache[s.id] = imgCache[liveMatch.id];
    }
  }
  for (const s of SEED_VARIETY) {
    const liveMatch = findLiveTitleMatch(s, liveShows, '综艺', show => ['大陆', '韩国'].includes(show.regional));
    if (liveMatch && liveMatch.id !== s.id) {
      if (imgCache[s.id] && !imgCache[liveMatch.id]) imgCache[liveMatch.id] = imgCache[s.id];
      if (imgCache[liveMatch.id] && !imgCache[s.id]) imgCache[s.id] = imgCache[liveMatch.id];
    }
  }
  saveImageCache(imgCache);

  // ── 7. 优先补齐 TMDB 高清封面/具体页,再验证爱壹帆具体页 ──
  const allShowsList = [...kdramaMap.values(), ...varietyMap.values(), ...otherDramas];
  await enrichCoversFromTMDB(allShowsList);
  await enrichMissingYfspLinks(allShowsList);
  for (const show of allShowsList) attachLinkFields(show, show.yfspUrl, show.doubanUrl);
  await enrichDoubanLinks(allShowsList);
  for (const show of allShowsList) attachLinkFields(show, show.yfspUrl, show.doubanUrl);
  await enrichDescriptions(allShowsList);
  await aiEnhanceDescriptions(allShowsList);

  // ── 8. 排序 ──
  const dropped = allShowsList.filter(s => !isRenderableShow(s));
  if (dropped.length) console.log(`  丢弃 ${dropped.length} 个缺少有效图片或具体链接的节目: ${dropped.map(s => s.title).join(', ')}`);

  const koreanDramas = [...kdramaMap.values()].filter(isRenderableShow).sort((a, b) => b.recommendScore - a.recommendScore);
  const chineseVariety = [...varietyMap.values()].filter(isRenderableShow).sort((a, b) => b.recommendScore - a.recommendScore);
  const renderableOtherDramas = otherDramas.filter(isRenderableShow);

  // ── 8.5. 新内容标记(30天有效期) ──
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  for (const show of allShowsList) {
    if (show.seedId) {
      delete show.firstSeenAt;
      show.isNew = false;
      continue;
    }
    const prevId = prevFirstSeenMap.get(show.id);
    const prevTitle = prevTitleFirstSeenMap.get(normalizeTitle(show.title));
    show.firstSeenAt = prevId || prevTitle || new Date().toISOString();
    show.isNew = (nowMs - new Date(show.firstSeenAt).getTime()) < ONE_MONTH_MS;
  }

  // ── 9. 输出 ──
  const output = {
    lastUpdated: new Date().toISOString(),
    stats: {
      koreanDramas: koreanDramas.length,
      chineseVariety: chineseVariety.length,
      otherDramas: renderableOtherDramas.length,
      totalScraped: liveShows.size,
    },
    koreanDramas,
    chineseVariety,
    otherDramas: renderableOtherDramas,
  };

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SHOWS_FILE, JSON.stringify(output, null, 2), 'utf-8');
  saveHistory(output);

  console.log(`[SCRAPER] 完成! 韩剧: ${koreanDramas.length}, 综艺: ${chineseVariety.length}, 其他: ${renderableOtherDramas.length}`);
}

function isRenderableShow(show) {
  // 种子数据直接保留(封面和链接可在前端兜底)
  if (show.seedId) return true;
  return !!show.coverImg && !!show.primaryUrl;
}

function saveHistory(output) {
  let h = {};
  if (existsSync(HISTORY_FILE)) try { h = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8')); } catch {}
  const today = new Date().toISOString().split('T')[0];
  h[today] = {
    timestamp: new Date().toISOString(),
    koreanDramasCount: output.stats.koreanDramas,
    chineseVarietyCount: output.stats.chineseVariety,
    topKoreanDramas: output.koreanDramas.slice(0, 5).map(s => s.title),
    topVariety: output.chineseVariety.slice(0, 5).map(s => s.title),
  };
  const keys = Object.keys(h).sort();
  while (keys.length > 30) delete h[keys.shift()];
  writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf-8');
}

async function enrichMissingYfspLinks(shows) {
  const existing = shows.filter(s => s.yfspUrl && s.title);
  if (existing.length) {
    console.log(`  验证 ${existing.length} 个爱壹帆具体页...`);
    let invalid = 0;
    for (const show of existing) {
      const ok = await verifyYfspUrl(show, show.yfspUrl);
      if (!ok) {
        show.yfspUrl = '';
        invalid++;
        attachLinkFields(show, '', show.doubanUrl);
        console.log(`    ✗ ${show.title}`);
      }
      await sleep(120);
    }
    console.log(`  移除 ${invalid} 个无效爱壹帆链接`);
  }

  const targets = shows.filter(s => !s.yfspUrl && s.title);
  if (!targets.length) return;

  console.log(`  为 ${targets.length} 个种子节目查询爱壹帆具体页...`);
  let matched = 0;
  for (const show of targets) {
    const found = await searchYfspTitle(show);
    const verified = found?.url ? await verifyYfspUrl(show, found.url) : false;
    if (verified) {
      show.yfspUrl = found.url;
      attachLinkFields(show, found.url, show.doubanUrl);
      show.linkMatchedTitle = found.title;
      if (!show.coverImg && found.coverImg) {
        show.coverImg = found.coverImg;
        show.coverSource = 'yfsp';
      }
      if (!show.publishTime && found.publishTime) show.publishTime = found.publishTime;
      if (!show.updateStatus && found.updateStatus) show.updateStatus = found.updateStatus;
      if (!show.actor && found.actor) show.actor = found.actor;
      if (!show.regional && found.regional) show.regional = found.regional;
      if (!show.lang && found.lang) show.lang = found.lang;
      if (!show.score && found.score) show.score = found.score;
      if (!show.playCount && found.playCount) show.playCount = found.playCount;
      matched++;
      console.log(`    ✓ ${show.title} → ${found.title}`);
    } else {
      attachLinkFields(show, '', show.doubanUrl || buildDoubanSubjectUrl(show.title));
      console.log(`    ✗ ${show.title}`);
    }
    await sleep(250);
  }
  console.log(`  匹配到 ${matched} 个爱壹帆具体页`);
}

async function searchDoubanSubject(show) {
  for (const query of titleCandidates(show.title)) {
    try {
      const results = await fetchDoubanSuggest(query);
      if (!Array.isArray(results)) continue;
      for (const item of results.slice(0, 8)) {
        const names = [item.title, item.sub_title].filter(Boolean);
        if (!names.some(name => titleMatches(show.title, name))) continue;
        return {
          doubanUrl: `${DOUBAN_MOVIE_BASE}/${item.id}/`,
          doubanId: item.id,
          doubanTitle: item.title || '',
          doubanYear: item.year || '',
        };
      }
    } catch (e) {
      console.warn(`  [WARN] douban search failed for "${query}": ${e.message}`);
    }
    await sleep(900);
  }
  return null;
}

async function fetchDoubanSuggest(query) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': 'https://movie.douban.com/',
        'Accept': 'application/json, text/plain, */*',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally { clearTimeout(t); }
}

async function enrichDoubanLinks(shows) {
  const targets = shows.filter(s => !s.doubanUrl && s.title);
  if (!targets.length) return;

  console.log(`  为 ${targets.length} 个节目补充豆瓣具体页...`);
  const cache = loadImageCache();
  let matched = 0;
  for (const show of targets) {
    const found = await searchDoubanSubject(show);
    if (found?.doubanUrl) {
      show.doubanUrl = found.doubanUrl;
      show.doubanId = found.doubanId;
      show.doubanMatchedTitle = found.doubanTitle;
      if (cache[show.id] && typeof cache[show.id] === 'object') {
        cache[show.id].doubanUrl = found.doubanUrl;
        cache[show.id].doubanId = found.doubanId;
        cache[show.id].doubanMatchedTitle = found.doubanTitle;
      }
      matched++;
      console.log(`    ✓ ${show.title} → ${found.doubanTitle}`);
    } else {
      console.log(`    ✗ ${show.title}`);
    }
    await sleep(1000);
  }
  saveImageCache(cache);
  console.log(`  补充 ${matched} 个豆瓣具体页`);
}

// ════════════════════════════════════════════════════════════════
// TMDB & Wikipedia 剧情介绍补全
// ════════════════════════════════════════════════════════════════

async function enrichDescriptions(shows) {
  const cache = loadImageCache();
  const targets = shows.filter(s => {
    if (s.description && s.description.length > 80) return false;
    const c = cache[s.id] || (s.seedId && s.seedId !== s.id ? cache[s.seedId] : null);
    return c?.tmdbId;
  });

  if (!targets.length) {
    console.log('  所有节目已有详细剧情介绍');
    return;
  }

  console.log(`  为 ${targets.length} 个节目补充 TMDB 剧情介绍...`);
  let enriched = 0;

  for (const show of targets) {
    const c = cache[show.id] || (show.seedId && show.seedId !== show.id ? cache[show.seedId] : null);
    const tmdbId = c?.tmdbId;
    const mediaKind = show.mediaType === '电影' ? 'movie' : 'tv';
    if (!tmdbId) continue;

    try {
      const data = await fetchTMDBJSON(`${mediaKind}/${tmdbId}?language=zh-CN`);
      if (data?.overview && data.overview.length > (show.description || '').length) {
        show.description = data.overview;
        enriched++;
        console.log(`    ✓ ${show.title} (${data.overview.length}字)`);
      }
    } catch (e) {
      console.warn(`  [WARN] description fetch failed for "${show.title}": ${e.message}`);
    }
    await sleep(250);
  }

  // 补充 Wikipedia 描述 (优先中文,其次英文)
  const wikiTargets = shows.filter(s => s.wikipediaUrl && (!s.description || s.description.length < 80));
  for (const show of wikiTargets) {
    try {
      const title = decodeURIComponent(show.wikipediaUrl.split('/wiki/')[1] || '');
      if (!title) continue;
      const lang = show.wikipediaUrl.includes('zh.wikipedia') ? 'zh' : show.wikipediaUrl.includes('ko.wikipedia') ? 'ko' : 'en';
      const apiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const resp = await fetch(apiUrl, { headers: { 'Accept': 'application/json', 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const data = await resp.json();
        if (data.extract && data.extract.length > (show.description || '').length) {
          show.description = data.extract;
          enriched++;
          console.log(`    ✓ ${show.title} (Wikipedia ${data.extract.length}字)`);
        }
      }
    } catch {}
    await sleep(300);
  }

  console.log(`  补充 ${enriched} 个剧情介绍`);
}

// ════════════════════════════════════════════════════════════════
// 新韩剧监控扫描 (自动发现 + 持久化 + 质量筛选)
// ════════════════════════════════════════════════════════════════

const DISCOVERY_KEYWORDS = ['韩剧', '韩剧推荐', '最新韩剧', '韩剧2026', '韩剧2025'];
const DISCOVERY_MIN_SCORE = 6.0;
const DISCOVERY_MIN_PLAYS = 50000;
const DISCOVERY_2026_MIN_SCORE = 4.0;
const DISCOVERY_2026_MIN_PLAYS = 10000;

async function discoverNewKDramas(liveShows, kdramaMap) {
  console.log('\n  ── 新韩剧监控扫描 ──');
  const knownTitles = new Set([...kdramaMap.values()].map(s => normalizeTitle(s.title)));
  const discovered = new Map();

  // 1. 扫描 API 已抓取的数据中未收录的韩国电视剧
  for (const s of liveShows.values()) {
    if (s.regional === '韩国' && s.mediaType === '电视剧' && !kdramaMap.has(s.id)) {
      const norm = normalizeTitle(s.title);
      if (!knownTitles.has(norm) && s.title && s.score > 0) {
        discovered.set(s.title, { ...s, source: 'api_index' });
      }
    }
  }

  // 2. 用关键词搜索 YFSP 发现更多新韩剧
  for (const kw of DISCOVERY_KEYWORDS) {
    const url = `${YFSP_RANK_BASE}/v3/list/briefsearch?cinema=0&tags=${encodeURIComponent(kw)}&star=&director=&page=1&size=20&orderby=0&desc=0`;
    try {
      const data = await fetchJSON(url);
      const results = data?.data?.info?.[0]?.result || [];
      for (const r of results) {
        if (r.regional !== '韩国' || r.atypeName !== '电视剧') continue;
        const norm = normalizeTitle(r.title || '');
        if (!knownTitles.has(norm) && r.title && !discovered.has(r.title)) {
          const sc = parseFloat(r.score) || 0;
          const plays = r.hot || 0;
          const yr = extractYear(r.postTime || '');
          const minSc = yr >= 2026 ? DISCOVERY_2026_MIN_SCORE : DISCOVERY_MIN_SCORE;
          const minPlays = yr >= 2026 ? DISCOVERY_2026_MIN_PLAYS : DISCOVERY_MIN_PLAYS;
          if (sc < minSc && plays < minPlays) continue;
          discovered.set(r.title, {
            id: r.contxt || `disc_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
            title: r.title, mediaType: '电视剧', type: 4,
            score: sc, playCount: plays,
            year: extractYear(r.postTime || ''),
            actor: r.starring || '', regional: '韩国', lang: '韩语',
            contentType: r.tag || '', cidMapper: '', description: '',
            coverImg: r.imgPath || '', updateStatus: r.lastName || '',
            updateMsg: '', isSerial: false, isComplete: false,
            publishTime: r.postTime || '',
            yfspUrl: r.contxt ? `https://www.yfsp.tv/play/${r.contxt}` : '',
            scrapedAt: new Date().toISOString(), isLive: true,
            source: 'search', isAutoDiscovered: true,
          });
        }
      }
    } catch (e) {
      console.warn(`  [WARN] discovery search failed for "${kw}": ${e.message}`);
    }
    await sleep(600);
  }

  const sorted = [...discovered.values()].sort((a, b) => b.playCount - a.playCount);

  // 3. 持久化发现记录到 discovery.json
  const today = new Date().toISOString().split('T')[0];
  let history = {};
  if (existsSync(DISCOVERY_FILE)) {
    try { history = JSON.parse(readFileSync(DISCOVERY_FILE, 'utf-8')); } catch {}
  }
  history[today] = {
    timestamp: new Date().toISOString(),
    totalFound: sorted.length,
    shows: sorted.map(s => ({
      title: s.title, score: s.score, playCount: s.playCount,
      year: s.year, actor: s.actor, source: s.source,
      updateStatus: s.updateStatus, contentType: s.contentType,
    })),
  };
  const keys = Object.keys(history).sort();
  while (keys.length > 60) delete history[keys.shift()];
  writeFileSync(DISCOVERY_FILE, JSON.stringify(history, null, 2), 'utf-8');

  // 3.5. AI 智能筛选新发现韩剧
  const aiFiltered = await aiEvaluateDiscovery(sorted);

  // 4. 筛选满足质量门槛的节目,自动收录
  const promoted = [];
  const logged = [];
  for (const s of aiFiltered) {
    const minSc2 = s.year >= 2026 ? DISCOVERY_2026_MIN_SCORE : DISCOVERY_MIN_SCORE;
    const minPl2 = s.year >= 2026 ? DISCOVERY_2026_MIN_PLAYS : DISCOVERY_MIN_PLAYS;
    const pass = s.score >= minSc2 || s.playCount >= minPl2;
    if (pass) {
      s.recommendScore = scoreKDrama(s);
      s.category = 'korean_drama';
      attachLinkFields(s, s.yfspUrl || s.url);
      promoted.push(s);
    }
    logged.push(s);
  }

  if (logged.length === 0) {
    console.log('  未发现新韩剧');
  } else {
    const aiRejected = sorted.length - aiFiltered.length;
    console.log(`  发现 ${sorted.length} 部未收录韩剧${aiRejected > 0 ? `(AI过滤${aiRejected}部)` : ''},自动收录 ${promoted.length} 部:`);
    for (const s of logged.slice(0, 30)) {
      const sc = s.score ? `评分${s.score}` : '';
      const plays = s.playCount > 10000 ? `${(s.playCount/10000).toFixed(0)}万播放` : s.playCount > 0 ? `${s.playCount}播放` : '';
      const meta = [sc, plays, s.year ? `${s.year}年` : ''].filter(Boolean).join(' · ');
      const tag = promoted.some(p => p.title === s.title) ? ' ✓自动收录' : '';
      const aiTag = s.aiDiscoveryReason ? ` [AI: ${s.aiDiscoveryReason}]` : '';
      console.log(`    ▸ ${s.title} [${meta}]${s.actor ? ` 演员:${s.actor}` : ''}${tag}${aiTag}`);
    }
  }

  return promoted;
}

// ════════════════════════════════════════════════════════════════
// 新综艺监控扫描 (自动发现大陆/韩国搞笑综艺)
// ════════════════════════════════════════════════════════════════

const VARIETY_DISCOVERY_KEYWORDS = ['综艺', '搞笑综艺', '真人秀', '2026综艺', '脱口秀', '喜剧'];
const VARIETY_DISCOVERY_MIN_SCORE = 5.0;
const VARIETY_DISCOVERY_MIN_PLAYS = 30000;
const VARIETY_DISCOVERY_2026_MIN_SCORE = 3.0;
const VARIETY_DISCOVERY_2026_MIN_PLAYS = 5000;

async function discoverNewVariety(liveShows, varietyMap) {
  console.log('\n  ── 新综艺监控扫描 ──');
  const knownTitles = new Set([...varietyMap.values()].map(s => normalizeTitle(s.title)));
  const discovered = new Map();

  // 1. 扫描 API 已抓取的数据中未收录的大陆/韩国综艺
  for (const s of liveShows.values()) {
    if (s.mediaType === '综艺' && ['大陆', '韩国', '台湾', '香港'].includes(s.regional) && !varietyMap.has(s.id)) {
      const norm = normalizeTitle(s.title);
      // 排除黑名单
      if (VarietyExclude.some(kw => s.title.includes(kw))) continue;
      if (!knownTitles.has(norm) && s.title) {
        discovered.set(s.title, { ...s, source: 'api_index' });
      }
    }
  }

  // 2. 用关键词搜索 YFSP 发现更多新综艺
  for (const kw of VARIETY_DISCOVERY_KEYWORDS) {
    const url = `${YFSP_RANK_BASE}/v3/list/briefsearch?cinema=0&tags=${encodeURIComponent(kw)}&star=&director=&page=1&size=20&orderby=0&desc=0`;
    try {
      const data = await fetchJSON(url);
      const results = data?.data?.info?.[0]?.result || [];
      for (const r of results) {
        if (r.atypeName !== '综艺') continue;
        if (!['大陆', '韩国', '台湾', '香港'].includes(r.regional)) continue;
        if (VarietyExclude.some(kw => (r.title || '').includes(kw))) continue;
        const norm = normalizeTitle(r.title || '');
        const cleanTitle = cleanShowTitle(r.title || '');
        if (!knownTitles.has(norm) && cleanTitle && !discovered.has(cleanTitle)) {
          const sc = parseFloat(r.score) || 0;
          const plays = r.hot || 0;
          const yr = extractYear(r.postTime || '');
          const minSc = yr >= CURRENT_YEAR ? VARIETY_DISCOVERY_2026_MIN_SCORE : VARIETY_DISCOVERY_MIN_SCORE;
          const minPlays = yr >= CURRENT_YEAR ? VARIETY_DISCOVERY_2026_MIN_PLAYS : VARIETY_DISCOVERY_MIN_PLAYS;
          if (sc < minSc && plays < minPlays) continue;
          discovered.set(cleanTitle, {
            id: r.contxt || `disc_var_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
            title: cleanTitle, mediaType: '综艺', type: 5,
            score: sc, playCount: plays,
            year: extractYear(r.postTime || ''),
            actor: r.starring || '', regional: r.regional || '大陆', lang: r.lang || '国语',
            contentType: r.tag || '', cidMapper: '', description: '',
            coverImg: r.imgPath || '', updateStatus: r.lastName || '',
            updateMsg: '', isSerial: true, isComplete: false,
            publishTime: r.postTime || '',
            yfspUrl: r.contxt ? `https://www.yfsp.tv/play/${r.contxt}` : '',
            scrapedAt: new Date().toISOString(), isLive: true,
            source: 'search', isAutoDiscovered: true,
          });
        }
      }
    } catch (e) {
      console.warn(`  [WARN] variety discovery search failed for "${kw}": ${e.message}`);
    }
    await sleep(600);
  }

  const sorted = [...discovered.values()].sort((a, b) => b.playCount - a.playCount);

  // 3. 筛选满足质量门槛的综艺,自动收录
  const promoted = [];
  const logged = [];
  for (const s of sorted) {
    const minSc2 = s.year >= CURRENT_YEAR ? VARIETY_DISCOVERY_2026_MIN_SCORE : VARIETY_DISCOVERY_MIN_SCORE;
    const minPl2 = s.year >= CURRENT_YEAR ? VARIETY_DISCOVERY_2026_MIN_PLAYS : VARIETY_DISCOVERY_MIN_PLAYS;
    // 轻松搞笑综艺放宽门槛
    const t = `${s.contentType} ${s.title}`.toLowerCase();
    const isFunny = VarietyFunnyKeywords.some(kw => t.includes(kw));
    const hasFunnyHost = VarietyHighWeightHosts.some(h => (s.actor || '').includes(h));
    const pass = s.score >= minSc2 || s.playCount >= minPl2 || (isFunny && s.playCount >= 5000) || hasFunnyHost;
    if (pass) {
      s.recommendScore = scoreVariety(s);
      s.category = 'chinese_variety';
      attachLinkFields(s, s.yfspUrl || s.url);
      promoted.push(s);
    }
    logged.push(s);
  }

  if (logged.length === 0) {
    console.log('  未发现新综艺');
  } else {
    console.log(`  发现 ${sorted.length} 部未收录综艺,自动收录 ${promoted.length} 部:`);
    for (const s of logged.slice(0, 30)) {
      const sc = s.score ? `评分${s.score}` : '';
      const plays = s.playCount > 10000 ? `${(s.playCount/10000).toFixed(0)}万播放` : s.playCount > 0 ? `${s.playCount}播放` : '';
      const meta = [sc, plays, s.year ? `${s.year}年` : '', s.regional].filter(Boolean).join(' · ');
      const tag = promoted.some(p => p.title === s.title) ? ' ✓自动收录' : '';
      console.log(`    ▸ ${s.title} [${meta}]${s.actor ? ` 演员:${s.actor}` : ''}${tag}`);
    }
  }

  return promoted;
}

// ════════════════════════════════════════════════════════════════
// TMDB 封面抓取
// ════════════════════════════════════════════════════════════════

const TMDB_TOKEN = process.env.TMDB_TOKEN || '';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w780';
const TMDB_WEB_BASE = 'https://www.themoviedb.org';
const DOUBAN_MOVIE_BASE = 'https://movie.douban.com/subject';
const IMAGE_CACHE_FILE = join(DATA_DIR, 'image_cache.json');
const COVER_CACHE_VERSION = 13;

function loadImageCache() {
  if (existsSync(IMAGE_CACHE_FILE)) {
    try { return JSON.parse(readFileSync(IMAGE_CACHE_FILE, 'utf-8')); } catch {}
  }
  return {};
}

function saveImageCache(cache) {
  writeFileSync(IMAGE_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

function isTMDBImageUrl(url = '') {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'image.tmdb.org' &&
      parsed.pathname.startsWith('/t/p/');
  } catch {
    return false;
  }
}

function isReusableTMDBCoverCache(cached, show) {
  return cached &&
    typeof cached === 'object' &&
    cached.version === COVER_CACHE_VERSION &&
    cached.source === 'tmdb' &&
    cached.url &&
    cached.title === show.title &&
    isTMDBImageUrl(cached.url);
}

// 韩剧/综艺标题 → TMDB 搜索用英文名映射(提高命中率)
const TITLE_EN_MAP = {
  // 韩剧 - 使用TMDB能精确匹配的搜索词
  '请回答1988': 'Reply 1988',
  '机智的医生生活': 'Hospital Playlist',
  '机智的监狱生活': 'Prison Playbook',
  '孤单又灿烂的神-鬼怪': 'Guardian The Lonely and Great God',
  '大力女都奉顺': 'Strong Woman Do Bong Soon',
  '举重妖精金福珠': 'Weightlifting Fairy Kim Bok-joo',
  '文森佐': 'Vincenzo',
  '未生': '미생',
  '我的ID是江南美人': '내 아이디는 강남미인',
  '金秘书为何那样': 'Whats Wrong with Secretary Kim',
  '触及真心': 'Touch Your Heart',
  '社内相亲': 'Business Proposal',
  '酒鬼都市男女': 'Work Later Drink Now',
  '海岸村恰恰恰': 'Hometown Cha-Cha-Cha',
  '非常律师禹英禑': 'Extraordinary Attorney Woo',
  '闪亮的西瓜': 'Twinkling Watermelon',
  '欢迎来到王之国': '킹더랜드',
  '死期将至': '死期将至',
  '信号': '시그널',
  '秘密森林': '비밀의 숲',
  '背着善宰跑': 'Lovely Runner',
  '妈妈朋友的儿子': '엄마친구아들',
  '凌晨两点的灰姑娘': 'Cinderella at 2AM',
  '问问星星吧': 'When the Stars Gossip',
  '我的完美秘书': '나의 완벽한 비서',
  '法官大人': '유어 아너',
  '善意的竞争': 'Friendly Rivalry',
  '奇怪的律师禹英禑': 'Extraordinary Attorney Woo',
  // 2022-2024 高口碑韩剧
  '泪之女王': 'Queen of Tears',
  '黑暗荣耀': 'The Glory',
  '黑暗荣耀第2季': 'The Glory',
  '超异能族': 'Moving',
  '21世纪大君夫人': 'The Embracing Empress',
  '照明商店': 'Light Shop',
  '财阀家的小儿子': 'Reborn Rich',
  '低谷医生': 'Doctor Slump',
  '王后伞下': 'Under the Queen\'s Umbrella',
  '正年': 'Jeong Nyeon',
  '贞淑的推销': 'A Virtuous Business',
  '好或坏的东载': 'Dongjae the Good or the Bad',
  '那家伙是黑炎龙': 'Black Flame Dragon',
  // 2026 韩剧
  '爱情怎么翻译': 'The Art of Love',
  '订阅男友': 'Boyfriend on Demand',
  '理事长和我的秘密关系': 'Positively Yours',
  '在你的灿烂季节': 'In Your Brilliant Season',
  '努力克服自卑的我们': 'Our Inferiority Complex',
  '死亡之花': 'Flower of Death',
  '春日狂热': 'Spring Fever',
  '给你宇宙': 'Give You the Universe',
  '权欲之巅': 'Beyond Power',
  '秒杀爱情': 'Love at First Sight',
  '赌金': 'The Bet',
  '魔女之吻': 'Witch Kiss',
  '今天开始是人类': 'Starting Today I Am Human',
  // 综艺 - 直接用中文搜索
  '极限挑战第一季': '极限挑战',
  '王牌对王牌': 'Ace vs Ace',
  '极限挑战': 'Go Fighting!',
  '哈哈哈哈哈': '哈哈哈哈哈',
  '密室大逃脱': 'Great Escape',
  '向往的生活': 'Back to Field',
  '明星大侦探': 'Who\'s the Murderer',
  '脱口秀大会': 'Rock & Roast',
  '奔跑吧兄弟': 'Keep Running',
  '奔跑吧': 'Keep Running',
  '披荆斩棘的哥哥': 'Call Me by Fire',
  '青春环游记': '青春环游记',
  '萌探探探案': 'The Detectives\' Adventures',
  '种地吧': 'Become a Farmer',
  '德云斗笑社': '德云斗笑社',
  '欢乐喜剧人': '欢乐喜剧人',
  '一年一度喜剧大赛': 'Super Sketch Show',
  '五十公里桃花坞': '50km桃花坞',
  '你好星期六': 'Hello, Saturday',
  '快乐大本营': 'Happy Camp',
  '快乐的大人': '快乐的大人',
  '快乐再出发': 'Go for Happiness',
  '闪亮的日子': '闪亮的日子',
  '我们的歌': 'Singing with Legends',
  '声生不息': 'Infinity and Beyond',
  '大侦探': 'Who\'s the Murderer',
  '你好生活': 'Hello Life',
  '现在就出发': '现在就出发',
  '脱口秀和TA的朋友们': '脱口秀和TA的朋友们',
  '喜人奇妙夜': 'Super Sketch Show',
  '综艺大热门': '綜藝大熱門',
  '金星脱口秀': '金星秀',
  'BTS综艺年代记': 'BTS Variety Chronicle',
  '喜剧者联盟': '喜剧者联盟',
};

async function fetchTMDBJSON(path) {
  if (!TMDB_TOKEN) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(`https://api.themoviedb.org/3/${path}`, {
      headers: {
        'Authorization': `Bearer ${TMDB_TOKEN}`,
        'Accept': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } finally { clearTimeout(t); }
}

async function fetchWikidataLinks(wikidataId) {
  if (!wikidataId) return {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`, {
      headers: { 'Accept': 'application/json', 'User-Agent': HEADERS['User-Agent'] },
      signal: ctrl.signal,
    });
    if (!resp.ok) return {};
    const entity = (await resp.json())?.entities?.[wikidataId];
    const sitelinks = entity?.sitelinks || {};
    const doubanId = entity?.claims?.P4529?.[0]?.mainsnak?.datavalue?.value;
    const imdbId = entity?.claims?.P345?.[0]?.mainsnak?.datavalue?.value;
    return {
      doubanUrl: doubanId ? `${DOUBAN_MOVIE_BASE}/${doubanId}/` : '',
      wikipediaUrl: sitelinks.zhwiki?.url || sitelinks.enwiki?.url || sitelinks.kowiki?.url || '',
      imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : '',
    };
  } catch (e) {
    console.warn(`  [WARN] Wikidata lookup failed for "${wikidataId}": ${e.message}`);
    return {};
  } finally { clearTimeout(t); }
}

function simplifyTitleForSearch(title = '') {
  return title
    .replace(/\s*20\d{2}\s*$/u, '')
    .replace(/\s*第[一二三四五六七八九十\d]+季\s*$/u, '')
    .trim();
}

async function searchTMDBImage(show) {
  const isKorean = show.regional === '韩国';
  const mediaKind = show.mediaType === '电影' ? 'movie' : 'tv';
  const enTitle = TITLE_EN_MAP[show.title];
  const simplified = simplifyTitleForSearch(show.title);
  const queries = [...new Set([...titleCandidates(show.title), enTitle, simplified].filter(Boolean))];
  // TV/综艺的 TMDB 原始条目通常不带年份后缀，所以始终重试不带年份的搜索
  const shouldRetryWithoutYear = show.year && (mediaKind === 'tv' || !/20\d{2}|第[一二三四五六七八九十\d]+季/u.test(show.title));

  for (const query of queries) {
    const yearParams = [
      show.year ? (mediaKind === 'movie' ? `&year=${show.year}` : `&first_air_date_year=${show.year}`) : '',
      shouldRetryWithoutYear ? '' : null,
    ].filter(v => v !== null);
    for (const yearParam of yearParams) {
      try {
        const data = await fetchTMDBJSON(`search/${mediaKind}?query=${encodeURIComponent(query)}&language=zh-CN&page=1${yearParam}`);
        if (!data) continue;
        // 只接受能被标题或人工映射词验证的结果,避免把第一条无关结果写入缓存。
        for (const r of (data.results || [])) {
          if (!r.poster_path) continue;
          if (isKorean && r.origin_country?.length && !r.origin_country.includes('KR')) continue;
          const names = [r.title, r.original_title, r.name, r.original_name].filter(Boolean);
          const expected = [...titleCandidates(show.title), enTitle, query].filter(Boolean);
          const isMatch = names.some(name =>
            expected.some(value => titleMatches(name, value))
          );
          if (isMatch) {
            const external = await fetchTMDBJSON(`${mediaKind}/${r.id}/external_ids`);
            const wikidata = await fetchWikidataLinks(external?.wikidata_id);
            return {
              url: `${TMDB_IMG_BASE}${r.poster_path}`,
              tmdbUrl: `${TMDB_WEB_BASE}/${mediaKind}/${r.id}`,
              doubanUrl: wikidata.doubanUrl || '',
              wikipediaUrl: wikidata.wikipediaUrl || '',
              imdbUrl: external?.imdb_id ? `https://www.imdb.com/title/${external.imdb_id}/` : wikidata.imdbUrl || '',
              wikidataId: external?.wikidata_id || '',
              matchedTitle: r.name || r.original_name || '',
              tmdbId: r.id,
              mediaKind,
              query,
            };
          }
        }
      } catch (e) {
        console.warn(`  [WARN] TMDB search failed for "${query}": ${e.message}`);
      }
      await sleep(250);
    }
  }
  return null;
}

async function enrichCoversFromTMDB(shows) {
  const cache = loadImageCache();
  let fetched = 0;

  // 1. TMDB 缓存优先。爱壹帆原图只作为 TMDB 失败时的兜底。
  for (const show of shows) {
    if (show.coverImg) show.yfspCoverImg = show.coverImg;
    const cached = cache[show.id] || (show.seedId && show.seedId !== show.id ? cache[show.seedId] : null);
    if (isReusableTMDBCoverCache(cached, show)) {
      show.coverImg = cached.url;
      show.coverSource = 'tmdb';
      show.tmdbUrl = cached.tmdbUrl || '';
      show.doubanUrl = cached.doubanUrl || show.doubanUrl || '';
      show.wikipediaUrl = cached.wikipediaUrl || '';
      show.imdbUrl = cached.imdbUrl || '';
      show.wikidataId = cached.wikidataId || '';
    } else if (typeof cached === 'object' && cached.version === COVER_CACHE_VERSION && cached.notFound && show.yfspCoverImg) {
      show.coverImg = show.yfspCoverImg;
      show.coverSource = 'yfsp';
    }
  }

  // 2. 没有可靠 TMDB 高清图缓存的节目都重新查。YFSP 兜底图不能阻止后续刷新。
  const toFetch = shows.filter(s => {
    const cached = cache[s.id] || (s.seedId && s.seedId !== s.id ? cache[s.seedId] : null);
    return !isReusableTMDBCoverCache(cached, s);
  });

  if (toFetch.length === 0) {
    console.log('  所有节目已有 TMDB 封面缓存');
    return;
  }

  console.log(`  从 TMDB 优先抓取 ${toFetch.length} 个节目的高清封面...`);

  for (const show of toFetch) {
    const img = await searchTMDBImage(show);
    if (img?.url) {
      cache[show.id] = {
        title: show.title,
        url: img.url,
        source: 'tmdb',
        version: COVER_CACHE_VERSION,
        query: img.query,
        matchedTitle: img.matchedTitle,
        tmdbId: img.tmdbId,
        tmdbUrl: img.tmdbUrl,
        doubanUrl: img.doubanUrl,
        wikipediaUrl: img.wikipediaUrl,
        imdbUrl: img.imdbUrl,
        wikidataId: img.wikidataId,
        cachedAt: new Date().toISOString(),
      };
      show.coverImg = img.url;
      show.coverSource = 'tmdb';
      show.tmdbUrl = img.tmdbUrl;
      show.doubanUrl = img.doubanUrl || show.doubanUrl || '';
      show.wikipediaUrl = img.wikipediaUrl || '';
      show.imdbUrl = img.imdbUrl;
      show.wikidataId = img.wikidataId || '';
      fetched++;
      console.log(`    ✓ ${show.title} → ${img.matchedTitle}`);
    } else {
      // 搜索失败时只保留现有兜底图；非 TMDB 缓存仍会在后续运行继续尝试刷新。
      const existing = cache[show.id];
      if (existing && typeof existing === 'object' && existing.url) {
        existing.version = COVER_CACHE_VERSION;
        existing.cachedAt = new Date().toISOString();
        if (show.yfspCoverImg) {
          show.coverImg = show.yfspCoverImg;
          show.coverSource = 'yfsp';
        }
      } else {
        cache[show.id] = {
          title: show.title,
          source: 'tmdb',
          version: COVER_CACHE_VERSION,
          notFound: true,
          cachedAt: new Date().toISOString(),
        };
        if (show.yfspCoverImg) {
          show.coverImg = show.yfspCoverImg;
          show.coverSource = 'yfsp';
        }
      }
      console.log(`    ✗ ${show.title}`);
    }
    await sleep(300);
  }

  // 同步 seedId ↔ show.id 缓存 (种子匹配到直播节目后 ID 会变)
  for (const show of shows) {
    if (show.seedId && show.seedId !== show.id) {
      if (cache[show.id] && !cache[show.seedId]) cache[show.seedId] = cache[show.id];
      if (cache[show.seedId] && !cache[show.id]) cache[show.id] = cache[show.seedId];
    }
  }

  saveImageCache(cache);
  console.log(`  新增/刷新 ${fetched} 个 TMDB 高清封面`);
}

main().catch(e => { console.error('[SCRAPER] Fatal:', e); process.exit(1); });
