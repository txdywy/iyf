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

const API_BASE = 'https://api.yfsp.tv';
const API_PATH = '/api/list/index';
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

async function fetchPage(page) {
  const url = `${API_BASE}${API_PATH}?cinema=0&page=${page}&cid=0&size=10&isn=0&isfree=-1`;
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
    url: `https://www.yfsp.tv/play/${it.mediaKey || ''}`,
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
      const data = await fetchPage(page);
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
      kdramaMap.set(s.id, s);
    }
  }
  for (const s of SEED_KDRAMAS) {
    if (!kdramaMap.has(s.id)) {
      const show = { ...s, mediaType:'电视剧', type:4, coverImg:'', updateMsg:'', scrapedAt:'', isLive:false, isClassic:s.isClassic||false };
      show.recommendScore = scoreKDrama(show);
      show.category = 'korean_drama';
      show.url = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(s.title)}&cat=1002`;
      kdramaMap.set(s.id, show);
    }
  }

  // ── 3. 构建综艺列表 ──
  const varietyMap = new Map();
  for (const s of liveShows.values()) {
    if (s.regional === '大陆' && s.mediaType === '综艺') {
      const vsc = scoreVariety(s);
      if (vsc >= 0) {
        s.recommendScore = vsc;
        s.category = 'chinese_variety';
        varietyMap.set(s.id, s);
      }
    }
    // 韩国综艺也算
    if (s.regional === '韩国' && s.mediaType === '综艺') {
      s.recommendScore = scoreVariety(s);
      s.category = 'chinese_variety';
      varietyMap.set(s.id, s);
    }
  }
  for (const s of SEED_VARIETY) {
    if (!varietyMap.has(s.id)) {
      const show = { ...s, mediaType:'综艺', type:5, coverImg:'', scrapedAt:'', isLive:false, isClassic:s.isClassic||false };
      show.recommendScore = scoreVariety(show);
      show.category = 'chinese_variety';
      show.url = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(s.title)}&cat=1002`;
      varietyMap.set(s.id, show);
    }
  }

  // ── 4. 其他电视剧 ──
  const otherDramas = [];
  for (const s of liveShows.values()) {
    if (s.mediaType === '电视剧' && s.regional !== '韩国' && !['恐怖'].includes(s.contentType)) {
      s.recommendScore = 0;
      s.category = 'other_drama';
      otherDramas.push(s);
    }
  }

  // ── 5. 从豆瓣抓取缺失的封面图 ──
  const allShowsList = [...kdramaMap.values(), ...varietyMap.values(), ...otherDramas];
  await fetchMissingCovers(allShowsList);

  // ── 6. 排序 ──
  const koreanDramas = [...kdramaMap.values()].sort((a, b) => b.recommendScore - a.recommendScore);
  const chineseVariety = [...varietyMap.values()].sort((a, b) => b.recommendScore - a.recommendScore);

  // ── 7. 输出 ──
  const output = {
    lastUpdated: new Date().toISOString(),
    stats: {
      koreanDramas: koreanDramas.length,
      chineseVariety: chineseVariety.length,
      otherDramas: otherDramas.length,
      totalScraped: liveShows.size,
    },
    koreanDramas,
    chineseVariety,
    otherDramas,
  };

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SHOWS_FILE, JSON.stringify(output, null, 2), 'utf-8');
  saveHistory(output);

  console.log(`[SCRAPER] 完成! 韩剧: ${koreanDramas.length}, 综艺: ${chineseVariety.length}, 其他: ${otherDramas.length}`);
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

// ════════════════════════════════════════════════════════════════
// TMDB 封面抓取
// ════════════════════════════════════════════════════════════════

const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIyNGM0MmEzMGUwNWFiMWZjYzMyN2JhZjlkMDZhOTcyYyIsIm5iZiI6MTc3Njk0NTcxNS43NTIsInN1YiI6IjY5ZWEwYTMzMTA4MTAyMGE4MjMzNDJhNyIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.wqiFXZTy6XeHmb_-_LuXk3VkUcP4bjJH3KPuxAqOxlU';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';
const IMAGE_CACHE_FILE = join(DATA_DIR, 'image_cache.json');

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
  '法官大人': 'Your Honor',
  '拜托了老板': '致我的解离',
  '善意的竞争': '善意的竞争',
  '奇怪的律师禹英禑': 'Extraordinary Attorney Woo',
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

async function searchTMDBImage(title, isKorean) {
  // 优先用英文名搜索(命中率更高)
  const enTitle = TITLE_EN_MAP[title];
  const queries = enTitle ? [enTitle] : [title];

  // 对韩剧额外尝试英文搜索
  if (!enTitle && isKorean) {
    queries.push(title.replace(/\d{4}$/, '').trim());
  }

  for (const query of queries) {
    const endpoint = isKorean ? 'search/tv' : 'search/tv';
    const url = `https://api.themoviedb.org/3/${endpoint}?query=${encodeURIComponent(query)}&language=zh-CN&page=1`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${TMDB_TOKEN}`,
          'Accept': 'application/json',
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!resp.ok) continue;
      const data = await resp.json();
      // 验证第一个结果是否真正匹配(比较中文名/原始名)
      for (const r of (data.results || [])) {
        if (!r.poster_path) continue;
        const names = [r.name, r.original_name].filter(Boolean);
        const titleClean = title.replace(/\d{4}$/, '').replace(/第.季$/, '').trim();
        const isMatch = names.some(n =>
          n.includes(titleClean) || titleClean.includes(n) ||
          n.replace(/\s/g, '') === titleClean.replace(/\s/g, '')
        );
        if (isMatch) return `${TMDB_IMG_BASE}${r.poster_path}`;
      }
      // 如果没有精确匹配,用第一个有海报的结果(降级)
      if (data.results?.length > 0 && data.results[0].poster_path) {
        return `${TMDB_IMG_BASE}${data.results[0].poster_path}`;
      }
    } catch (e) {
      console.warn(`  [WARN] TMDB search failed for "${query}": ${e.message}`);
    }
    await sleep(250);
  }
  return null;
}

async function fetchMissingCovers(shows) {
  const cache = loadImageCache();
  let fetched = 0;

  // 1. 先从缓存回填图片
  for (const show of shows) {
    if (!show.coverImg && cache[show.id] && cache[show.id] !== 'NOT_FOUND') {
      show.coverImg = cache[show.id];
    }
  }

  // 2. 找出仍缺图片的节目
  const toFetch = shows.filter(s => !s.coverImg && (!cache[s.id] || cache[s.id] === 'NOT_FOUND'));

  if (toFetch.length === 0) {
    console.log('  所有节目已有封面图(缓存)');
    return;
  }

  console.log(`  从 TMDB 抓取 ${toFetch.length} 个节目的封面图...`);

  for (const show of toFetch) {
    const isK = show.regional === '韩国';
    const imgUrl = await searchTMDBImage(show.title, isK);
    if (imgUrl) {
      cache[show.id] = imgUrl;
      show.coverImg = imgUrl;
      fetched++;
      console.log(`    ✓ ${show.title}`);
    } else {
      cache[show.id] = 'NOT_FOUND';
      console.log(`    ✗ ${show.title}`);
    }
    await sleep(300);
  }

  saveImageCache(cache);
  console.log(`  新增 ${fetched} 个封面图`);
}

main().catch(e => { console.error('[SCRAPER] Fatal:', e); process.exit(1); });
