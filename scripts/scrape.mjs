#!/usr/bin/env node
/**
 * 爱壹帆 韩剧 & 国内综艺 推荐数据抓取器
 * 每小时由 GitHub Actions 执行
 * - 从 api.yfsp.tv 抓取最新首页数据(电视剧/综艺/电影)
 * - 与内置精选推荐库合并(覆盖更多韩剧和经典内容)
 * - 推荐算法: 评分 + 类型偏好 + 人气 + 新鲜度, 过滤负面内容
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

function normalizeItem(it) {
  const ui = parseUpdateStatus(it.updateStatus || '');
  const url = it.mediaKey ? `https://www.yfsp.tv/play/${it.mediaKey}` : '';
  return {
    id: it.mediaKey || it.episodeKey || '',
    title: it.title || '',
    mediaType: it.mediaType || '',
    type: it.type || 0,
    regional: it.regional || '',
    lang: it.lang || '',
    score: parseFloat(it.score) || 0,
    playCount: it.playCount || 0,
    contentType: it.contentType || '',
    cidMapper: it.cidMapper || '',
    actor: it.actor || '',
    description: (it.description || it.introduce || '').slice(0, 300),
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
  '奇怪的律师禹英禑': ['非常律师禹英禑', 'Extraordinary Attorney Woo'],
  '非常律师禹英禑': ['奇怪的律师禹英禑', 'Extraordinary Attorney Woo'],
  '信号': ['Signal信号', '시그널'],
  '文森佐': ['黑道律师文森佐', 'Vincenzo'],
  '机智的监狱生活': ['机智牢房生活', 'Prison Playbook'],
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
  return minLen >= 4 && maxLen - minLen <= 2 && (na.includes(nb) || nb.includes(na));
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
  show.primaryUrl = show.tmdbUrl || show.doubanUrl || show.wikipediaUrl || show.imdbUrl || '';
  show.primaryUrlSource = show.tmdbUrl ? 'tmdb' : show.doubanUrl ? 'douban' : show.wikipediaUrl ? 'wikipedia' : show.imdbUrl ? 'imdb' : '';
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
  return {
    ...seedShow,
    id: liveMatch.id || seedShow.id,
    title: liveMatch.title || seedShow.title,
    coverImg: liveMatch.coverImg || seedShow.coverImg,
    updateStatus: liveMatch.updateStatus || seedShow.updateStatus || '',
    updateMsg: liveMatch.updateMsg || seedShow.updateMsg || '',
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
};

const KDramaNegative = [
  '血腥', '暴力', '虐杀', '心理变态', '黑暗', '恐怖', '丧尸',
  '地狱', '灵异', '猎奇', '自残', '自杀', '抑郁', '压抑',
];

const VarietyBoost = {
  '真人秀': 20, '搞笑': 25, '竞技': 15, '旅行': 20,
  '脱口秀': 15, '访谈': 10, '选秀': 10, '游戏': 20,
  '生活': 15, '美食': 15, '户外': 15,
};

const VarietyExclude = ['浪姐', '乘风', '姐姐们', '女儿们的恋爱'];

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
  if (s.score > 0) sc += s.score * 5;
  if (s.playCount > 100000) sc += 15; else if (s.playCount > 50000) sc += 10; else if (s.playCount > 10000) sc += 5;
  if (s.year >= CURRENT_YEAR) sc += 25; else if (s.year >= CURRENT_YEAR - 1) sc += 10;
  return Math.max(0, Math.round(sc));
}

// ════════════════════════════════════════════════════════════════
// 精选推荐库(韩剧 + 综艺) — 补充 API 无法直接获取的内容
// ════════════════════════════════════════════════════════════════

const SEED_KDRAMAS = [
  // ── 2025-2026 新剧 ──
  { id:'seed_kd_2026_01', title:'拜托了老板', year:2026, score:8.2, playCount:80000, contentType:'喜剧·爱情·职场', actor:'金永大,韩智贤', description:'菜鸟职员和傲娇老板的搞笑办公室罗曼史。轻松甜蜜,笑点密集,职场恋爱轻喜剧。', totalEpisodes:12, isComplete:false, currentEpisode:8, regional:'韩国', lang:'韩语', isSerial:true },
  { id:'seed_kd_2026_02', title:'善意的竞争', year:2026, score:8.0, playCount:60000, contentType:'剧情·喜剧·职场', actor:'金惠奫,李伊庚', description:'两个性格截然相反的女律师搭档办案,在竞争中建立友情。节奏轻快,笑中带泪。', totalEpisodes:16, isComplete:false, currentEpisode:10, regional:'韩国', lang:'韩语', isSerial:true },
  { id:'seed_kd_2025_01', title:'背着善宰跑', year:2025, score:9.0, playCount:500000, contentType:'喜剧·爱情·奇幻', actor:'边佑锡,金惠奫', description:'穿越时空的甜蜜奇幻爱情,顶级偶像和铁粉的浪漫故事。2025年现象级韩剧,轻松治愈必看。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_02', title:'妈妈朋友的儿子', year:2025, score:8.3, playCount:350000, contentType:'喜剧·爱情', actor:'丁海寅,庭沼珉', description:'青梅竹马长大后的甜蜜重逢恋爱。治愈系浪漫喜剧,满满的温暖和笑料。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_03', title:'凌晨两点的灰姑娘', year:2025, score:8.5, playCount:300000, contentType:'喜剧·爱情', actor:'申铉彬,文相敏', description:'财阀千金变身灰姑娘的搞笑浪漫故事。轻松下饭,甜度超标。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_04', title:'问问星星吧', year:2025, score:7.8, playCount:200000, contentType:'喜剧·爱情·科幻', actor:'李敏镐,孔晓振', description:'宇航员和妇产科医生在太空站的浪漫喜剧。韩剧史上首部太空题材,新颖有趣。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_05', title:'我的完美秘书', year:2025, score:8.1, playCount:250000, contentType:'喜剧·爱情·职场', actor:'韩志旼,李浚赫', description:'冷面女CEO和万能男秘书的反转职场恋爱。轻松搞笑,化学反应满分。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2025_06', title:'法官大人', year:2025, score:8.4, playCount:180000, contentType:'剧情·喜剧·法律', actor:'孙贤周,金明民', description:'严厉法官和菜鸟检察官的法庭喜剧。正义与搞笑并存,节奏明快。', totalEpisodes:16, isComplete:true, currentEpisode:16, regional:'韩国', lang:'韩语', isSerial:false },
  { id:'seed_kd_2026_03', title:'21世纪大君夫人', year:2026, score:8.6, playCount:2128085, contentType:'喜剧·爱情·奇幻', actor:'李知恩,边佑锡,鲁常泫,孔升延', description:'IU与边佑锡主演的奇幻爱情。古代大君夫人穿越到现代,笑料不断又浪漫满分。2026年度爆款。', totalEpisodes:16, isComplete:false, currentEpisode:8, regional:'韩国', lang:'韩语', isSerial:true },
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
  // ── 2025 新剧补充 ──
  { id:'seed_kd_2025_07', title:'那家伙是黑炎龙', year:2025, score:8.1, playCount:661136, contentType:'喜剧·爱情', actor:'文佳煐,崔显旭,林世美', description:'游戏女主播和黑炎龙的甜蜜恋爱。电竞题材轻喜剧,轻松有趣。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'韩国', lang:'韩语', isSerial:false },
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
  // ── 2026 热门综艺 ──
  { id:'seed_var_2026_01', title:'奔跑吧2026', year:2026, score:7.5, playCount:500000, contentType:'真人秀·竞技', actor:'李晨,郑恺,沙溢,白鹿,范丞丞,周深', description:'经典户外竞技真人秀,欢乐撕名牌大战。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周五' },
  { id:'seed_var_2026_02', title:'王牌对王牌2026', year:2026, score:7.8, playCount:450000, contentType:'真人秀·游戏', actor:'沈腾,贾玲,关晓彤,华晨宇', description:'经典室内游戏综艺,沈腾贾玲的爆笑组合。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周六' },
  { id:'seed_var_2026_03', title:'极限挑战2026', year:2026, score:7.2, playCount:350000, contentType:'真人秀·竞技', actor:'黄渤,黄磊,罗志祥,张艺兴', description:'男人帮的极限挑战,笑料不断。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_04', title:'哈哈哈哈哈第5季', year:2026, score:8.2, playCount:300000, contentType:'真人秀·旅行·搞笑', actor:'邓超,陈赫,鹿晗', description:'兄弟团的欢乐旅行,全程笑到停不下来。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_05', title:'密室大逃脱2026', year:2026, score:8.0, playCount:280000, contentType:'真人秀·竞技', actor:'杨幂,邓伦,黄明昊,大张伟', description:'明星密室逃脱,紧张刺激又搞笑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_06', title:'向往的生活2026', year:2026, score:8.3, playCount:400000, contentType:'真人秀·生活', actor:'何炅,黄磊,彭昱畅,张子枫', description:'田园慢生活综艺,温馨治愈,笑料不断。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  // ── 经典综艺 ──
  { id:'seed_var_c01', title:'奔跑吧兄弟', year:2014, score:7.8, playCount:800000, contentType:'真人秀·竞技', actor:'邓超,李晨,陈赫,郑恺,王宝强', description:'初代跑男团的经典撕名牌,爆笑回忆。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c02', title:'极限挑战第一季', year:2015, score:9.2, playCount:700000, contentType:'真人秀·竞技', actor:'黄渤,孙红雷,黄磊,罗志祥,王迅,张艺兴', description:'男人帮初代经典,神一般的综艺。', totalEpisodes:12, isComplete:true, currentEpisode:12, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c03', title:'明星大侦探', year:2016, score:9.0, playCount:600000, contentType:'真人秀·推理', actor:'何炅,撒贝宁,吴映洁,白敬亭', description:'明星推理探案综艺,烧脑又搞笑。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
  { id:'seed_var_c04', title:'脱口秀大会', year:2017, score:8.5, playCount:500000, contentType:'脱口秀·搞笑', actor:'李诞,王建国,呼兰,杨笠', description:'脱口秀选手的爆笑舞台,笑到肚子疼。', totalEpisodes:0, isComplete:true, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:false, isClassic:true },
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
    let show = { ...s, mediaType:'电视剧', type:4, coverImg:'', updateMsg:'', scrapedAt:'', isLive:false, isClassic:s.isClassic||false };
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
    let show = { ...s, mediaType:'综艺', type:5, coverImg:'', scrapedAt:'', isLive:false, isClassic:s.isClassic||false };
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

  // ── 6. 优先补齐 TMDB 高清封面/具体页,再验证爱壹帆具体页 ──
  const allShowsList = [...kdramaMap.values(), ...varietyMap.values(), ...otherDramas];
  await enrichCoversFromTMDB(allShowsList);
  await enrichMissingYfspLinks(allShowsList);
  for (const show of allShowsList) attachLinkFields(show, show.yfspUrl, show.doubanUrl);
  await enrichDoubanLinks(allShowsList);
  for (const show of allShowsList) attachLinkFields(show, show.yfspUrl, show.doubanUrl);

  // ── 7. 排序 ──
  const dropped = allShowsList.filter(s => !isRenderableShow(s));
  if (dropped.length) console.log(`  丢弃 ${dropped.length} 个缺少有效图片或具体链接的节目: ${dropped.map(s => s.title).join(', ')}`);

  const koreanDramas = [...kdramaMap.values()].filter(isRenderableShow).sort((a, b) => b.recommendScore - a.recommendScore);
  const chineseVariety = [...varietyMap.values()].filter(isRenderableShow).sort((a, b) => b.recommendScore - a.recommendScore);
  const renderableOtherDramas = otherDramas.filter(isRenderableShow);

  // ── 8. 输出 ──
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
// 新韩剧监控扫描 (自动发现 + 持久化 + 质量筛选)
// ════════════════════════════════════════════════════════════════

const DISCOVERY_KEYWORDS = ['韩剧', '韩剧推荐', '最新韩剧', '韩剧2026', '韩剧2025'];
const DISCOVERY_MIN_SCORE = 6.0;
const DISCOVERY_MIN_PLAYS = 50000;

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
          if (sc < DISCOVERY_MIN_SCORE && plays < DISCOVERY_MIN_PLAYS) continue;
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

  // 4. 筛选满足质量门槛的节目,自动收录
  const promoted = [];
  const logged = [];
  for (const s of sorted) {
    const pass = s.score >= DISCOVERY_MIN_SCORE || s.playCount >= DISCOVERY_MIN_PLAYS;
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
    console.log(`  发现 ${logged.length} 部未收录韩剧,自动收录 ${promoted.length} 部:`);
    for (const s of logged.slice(0, 30)) {
      const sc = s.score ? `评分${s.score}` : '';
      const plays = s.playCount > 10000 ? `${(s.playCount/10000).toFixed(0)}万播放` : s.playCount > 0 ? `${s.playCount}播放` : '';
      const meta = [sc, plays, s.year ? `${s.year}年` : ''].filter(Boolean).join(' · ');
      const tag = promoted.some(p => p.title === s.title) ? ' ✓自动收录' : '';
      console.log(`    ▸ ${s.title} [${meta}]${s.actor ? ` 演员:${s.actor}` : ''}${tag}`);
    }
  }

  return promoted;
}

// ════════════════════════════════════════════════════════════════
// TMDB 封面抓取
// ════════════════════════════════════════════════════════════════

const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIyNGM0MmEzMGUwNWFiMWZjYzMyN2JhZjlkMDZhOTcyYyIsIm5iZiI6MTc3Njk0NTcxNS43NTIsInN1YiI6IjY5ZWEwYTMzMTA4MTAyMGE4MjMzNDJhNyIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.wqiFXZTy6XeHmb_-_LuXk3VkUcP4bjJH3KPuxAqOxlU';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w780';
const TMDB_WEB_BASE = 'https://www.themoviedb.org';
const DOUBAN_MOVIE_BASE = 'https://movie.douban.com/subject';
const IMAGE_CACHE_FILE = join(DATA_DIR, 'image_cache.json');
const COVER_CACHE_VERSION = 7;

function loadImageCache() {
  if (existsSync(IMAGE_CACHE_FILE)) {
    try { return JSON.parse(readFileSync(IMAGE_CACHE_FILE, 'utf-8')); } catch {}
  }
  return {};
}

function saveImageCache(cache) {
  writeFileSync(IMAGE_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
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
  // 综艺 - 直接用中文搜索
  '极限挑战第一季': '极限挑战',
  '王牌对王牌2026': '王牌对王牌',
  '极限挑战2026': '极限挑战',
  '哈哈哈哈哈第5季': '哈哈哈哈哈',
  '密室大逃脱2026': '密室大逃脱',
  '向往的生活2026': '向往的生活',
  '明星大侦探': '明星大侦探',
  '脱口秀大会': '脱口秀大会',
  '奔跑吧兄弟': '奔跑吧',
  '奔跑吧2026': '奔跑吧',
};

async function fetchTMDBJSON(path) {
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

async function searchTMDBImage(show) {
  const isKorean = show.regional === '韩国';
  const mediaKind = show.mediaType === '电影' ? 'movie' : 'tv';
  const enTitle = TITLE_EN_MAP[show.title];
  const queries = [...new Set([...titleCandidates(show.title), enTitle].filter(Boolean))];
  const shouldRetryWithoutYear = show.year && !/20\d{2}|第[一二三四五六七八九十\d]+季/u.test(show.title);

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
    const cached = cache[show.id];
    if (cached && cached !== 'NOT_FOUND') {
      if (typeof cached === 'object' && cached.version === COVER_CACHE_VERSION && cached.url && cached.title === show.title) {
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
  }

  // 2. 所有无有效 v3 TMDB 缓存的节目都重新查,包括已有爱壹帆小图的节目。
  const toFetch = shows.filter(s => {
    const cached = cache[s.id];
    return !(typeof cached === 'object' && cached?.version === COVER_CACHE_VERSION && cached.title === s.title);
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
      console.log(`    ✗ ${show.title}`);
    }
    await sleep(300);
  }

  saveImageCache(cache);
  console.log(`  新增/刷新 ${fetched} 个 TMDB 高清封面`);
}

main().catch(e => { console.error('[SCRAPER] Fatal:', e); process.exit(1); });
