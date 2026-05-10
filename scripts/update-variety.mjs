#!/usr/bin/env node
/**
 * 手动将扩展的综艺种子注入 shows.json
 * 保留现有 live 数据,追加新种子,重新计算推荐分
 */

import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SHOWS_FILE = join(DATA_DIR, 'shows.json');

const CURRENT_YEAR = new Date().getFullYear();

const VarietyBoost = {
  '真人秀': 20, '搞笑': 35, '喜剧': 35, '幽默': 30, '欢乐': 25, '爆笑': 25,
  '竞技': 15, '旅行': 20, '游戏': 25, '户外': 18,
  '脱口秀': 20, '访谈': 10, '选秀': 10,
  '生活': 15, '美食': 15, '慢生活': 15, '治愈': 15, '温馨': 15,
  '推理': 12, '探案': 12, '剧本杀': 12,
  '音乐': 8, '竞演': 8, '舞台': 8,
  '相声': 20, '小品': 20, 'sketch': 20,
  '沈腾': 5, '贾玲': 5, '邓超': 5, '陈赫': 5, '大张伟': 5, '杨迪': 5,
  '何炅': 5, '撒贝宁': 5, '李诞': 3,
};

const VarietyExclude = ['浪姐', '乘风', '姐姐们', '女儿们的恋爱', '怦然再心动', '我们离婚了'];
const VarietyFunnyKeywords = ['搞笑', '喜剧', '幽默', '欢乐', '爆笑', '脱口秀', '相声', '小品', '游戏', '旅行', '生活'];
const VarietyHighWeightHosts = ['沈腾', '贾玲', '邓超', '陈赫', '鹿晗', '大张伟', '杨迪', '何炅', '撒贝宁', '李诞', '岳云鹏', '黄子韬', '孙红雷'];

function scoreVariety(s) {
  let sc = 0;
  const t = `${s.cidMapper || ''} ${s.contentType || ''} ${s.description || ''} ${s.title || ''}`.toLowerCase();
  for (const [g, b] of Object.entries(VarietyBoost)) if (t.includes(g)) sc += b;
  for (const kw of VarietyExclude) if ((s.title || '').includes(kw)) return -1;
  if (s.score > 0) sc += s.score * 5;
  if (s.playCount > 500000) sc += 20;
  else if (s.playCount > 100000) sc += 15;
  else if (s.playCount > 50000) sc += 10;
  else if (s.playCount > 10000) sc += 5;
  if (s.year >= CURRENT_YEAR) sc += 30;
  else if (s.year >= CURRENT_YEAR - 1) sc += 15;
  else if (s.year >= CURRENT_YEAR - 2) sc += 5;
  if (s.isClassic) sc += 15;
  if (s.isSerial && !s.isComplete) sc += 10;
  const funnyScore = VarietyFunnyKeywords.filter(kw => t.includes(kw)).length;
  sc += funnyScore * 5;
  const hostBoost = VarietyHighWeightHosts.filter(h => (s.actor || '').includes(h)).length;
  sc += hostBoost * 3;
  return Math.max(0, Math.round(sc));
}

function normalizeTitle(title = '') {
  return title
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '')
    .replace(/第[一二三四五六七八九十\d]+季$/u, '')
    .replace(/20\d{2}$/u, '')
    .replace(/吧$/u, '')
    .trim();
}

const SEED_VARIETY = [
  { id:'seed_var_2026_01', title:'奔跑吧2026', year:2026, score:7.5, playCount:500000, contentType:'真人秀·竞技·搞笑', actor:'李晨,郑恺,沙溢,白鹿,范丞丞,周深', description:'经典户外竞技真人秀,欢乐撕名牌大战,2026全新季爆笑回归。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周五' },
  { id:'seed_var_2026_01b', title:'奔跑吧第十季', year:2026, score:7.5, playCount:500000, contentType:'真人秀·竞技·搞笑', actor:'李晨,郑恺,沙溢,白鹿,范丞丞,周深', description:'奔跑吧第十季,经典游戏升级,笑料加量。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周五' },
  { id:'seed_var_2026_02', title:'王牌对王牌2026', year:2026, score:7.8, playCount:450000, contentType:'真人秀·游戏·搞笑', actor:'沈腾,贾玲,关晓彤,华晨宇,宋亚轩', description:'经典室内游戏综艺,沈腾贾玲的爆笑组合,2026年笑闹继续。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周六' },
  { id:'seed_var_2026_02b', title:'王牌对王牌第九季', year:2026, score:7.8, playCount:450000, contentType:'真人秀·游戏·搞笑', actor:'沈腾,贾玲,关晓彤,华晨宇', description:'王牌家族集结,经典游戏新玩法,全程高能爆笑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周六' },
  { id:'seed_var_2026_03', title:'极限挑战2026', year:2026, score:7.2, playCount:350000, contentType:'真人秀·竞技·搞笑', actor:'黄渤,黄磊,罗志祥,张艺兴', description:'男人帮的极限挑战,笑料不断,2026新征程开启。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_07', title:'你好星期六2026', year:2026, score:7.6, playCount:380000, contentType:'真人秀·游戏·搞笑', actor:'何炅,檀健次,王鹤棣,秦霄贤,李雪琴', description:'快乐大本营精神续作,何炅带队,每期嘉宾互动游戏,轻松搞笑不断档。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true, updateMsg:'周六' },
  { id:'seed_var_2026_08', title:'萌探探探案2026', year:2026, score:7.4, playCount:320000, contentType:'真人秀·推理·搞笑', actor:'孙红雷,沙溢,黄子韬,杨迪,宋亚轩', description:'萌探家族欢乐探案,沉浸式剧本杀+搞笑互动,笑到停不下来。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_09', title:'青春环游记2026', year:2026, score:7.3, playCount:290000, contentType:'真人秀·旅行·搞笑', actor:'贾玲,杨洋,范丞丞,杨迪,郎朗', description:'青春旅行团边走边玩,游戏环节爆笑连连,治愈又欢乐。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_04', title:'哈哈哈哈哈第5季', year:2026, score:8.2, playCount:300000, contentType:'真人秀·旅行·搞笑', actor:'邓超,陈赫,鹿晗,范志毅,王勉', description:'五哈兄弟团欢乐旅行,全程笑到停不下来。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_04b', title:'哈哈哈哈哈第6季', year:2026, score:8.1, playCount:350000, contentType:'真人秀·旅行·搞笑', actor:'邓超,陈赫,鹿晗,范志毅,王勉', description:'五哈兄弟继续出发,公路喜剧+真实旅行,笑点密集。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_10', title:'现在就出发2026', year:2026, score:7.7, playCount:340000, contentType:'真人秀·旅行·搞笑', actor:'沈腾,贾冰,范丞丞,白敬亭,金晨', description:'明星嘉宾出发去野外,露营+游戏+美食,轻松解压的旅行综艺。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_10b', title:'现在就出发第二季', year:2026, score:7.7, playCount:340000, contentType:'真人秀·旅行·搞笑', actor:'沈腾,贾冰,范丞丞,白敬亭', description:'现在就出发第二季,明星野外露营欢乐多,轻松治愈。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_11', title:'五十公里桃花坞2026', year:2026, score:7.5, playCount:260000, contentType:'真人秀·生活·搞笑', actor:'宋丹丹,汪苏泷,李雪琴,王鹤棣,孟子义', description:'明星群居社交实验,尴尬与欢乐齐飞,真实又好笑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_12', title:'种地吧2026', year:2026, score:8.5, playCount:420000, contentType:'真人秀·生活·搞笑', actor:'十个勤天,蒋敦豪,鹭卓,李耕耘', description:'十个年轻人真实种地,从播种到收获,热血又搞笑,治愈力满分。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_13', title:'快乐的大人', year:2026, score:7.8, playCount:220000, contentType:'真人秀·生活·搞笑', actor:'沈月,王敬轩,吴宇恒,周彦辰', description:'沈月和她的朋友们的真实日常,友情治愈,笑料自然不做作。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_14', title:'闪亮的日子', year:2026, score:7.6, playCount:180000, contentType:'真人秀·生活·搞笑', actor:'陆虎,张远,王栎鑫,陈楚生,苏醒', description:'再就业男团日常记录,真实友情+搞笑互动,轻松下饭。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_15', title:'快乐再出发2026', year:2026, score:8.3, playCount:310000, contentType:'真人秀·旅行·搞笑', actor:'陈楚生,苏醒,王栎鑫,张远,王铮亮,陆虎', description:'再就业男团的音乐旅行,熟人局的化学反应,笑中带泪的宝藏综艺。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_16', title:'你好生活2026', year:2026, score:7.4, playCount:200000, contentType:'真人秀·生活·搞笑', actor:'撒贝宁,尼格买提,康辉,李梓萌', description:'央视主持人团建综艺,慢生活+真诚对话,温馨又有趣。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_17', title:'地球超新鲜', year:2026, score:7.3, playCount:250000, contentType:'真人秀·旅行·搞笑', actor:'待定', description:'全新户外探索综艺,明星嘉宾走访各地,体验风土人情,轻松搞笑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_18', title:'向往的生活2026', year:2026, score:8.3, playCount:400000, contentType:'真人秀·生活·搞笑', actor:'何炅,黄磊,彭昱畅,张子枫', description:'田园慢生活综艺,温馨治愈,笑料不断。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_19', title:'喜剧大会2026', year:2026, score:7.5, playCount:210000, contentType:'喜剧·竞演·搞笑', actor:'郭麒麟,李诞,谢娜,大张伟', description:'喜剧人竞演舞台,sketch小品+即兴喜剧,笑声不断。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_20', title:'脱口秀和TA的朋友们2026', year:2026, score:7.6, playCount:230000, contentType:'脱口秀·搞笑', actor:'李诞,徐志胜,何广智,鸟鸟,童漠男', description:'脱口秀好友局,新老选手同台竞技,爆梗频出。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_21', title:'喜人奇妙夜2026', year:2026, score:7.8, playCount:190000, contentType:'喜剧·竞演·搞笑', actor:'马东,黄渤,徐峥,于和伟', description:'一年一度喜剧大赛团队新作, Sketch喜剧竞演,创意与笑点齐飞。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_22', title:'德云斗笑社2026', year:2026, score:7.4, playCount:280000, contentType:'喜剧·相声·搞笑', actor:'郭德纲,于谦,岳云鹏,烧饼,孟鹤堂', description:'德云社团综,相声竞演+游戏互动,德云男孩的快乐源泉。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_23', title:'吐槽大会2026', year:2026, score:7.2, playCount:170000, contentType:'脱口秀·搞笑', actor:'李诞,张绍刚,池子', description:'明星互怼的脱口秀盛宴,犀利吐槽+幽默回应,解压神器。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_24', title:'披荆斩棘的哥哥2026', year:2026, score:7.5, playCount:360000, contentType:'真人秀·音乐·竞演', actor:'陈小春,张智霖,李承铉,张云龙', description:'哥哥们的舞台竞演,兄弟情义+热血舞台,笑泪交织。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_25', title:'声生不息2026', year:2026, score:7.6, playCount:330000, contentType:'真人秀·音乐', actor:'何炅,王祖蓝,林子祥,叶倩文', description:'港乐/宝岛音乐盛典,金曲重现,情怀与感动并存。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_26', title:'我们的歌2026', year:2026, score:7.3, playCount:240000, contentType:'真人秀·音乐', actor:'林海,庾澄庆,那英,周深', description:'新老歌手搭档竞演,经典新唱,音乐碰撞出火花。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_05', title:'密室大逃脱2026', year:2026, score:8.0, playCount:280000, contentType:'真人秀·推理·搞笑', actor:'杨幂,大张伟,黄明昊,张国伟,许凯', description:'明星密室逃脱,紧张刺激又搞笑,2026新主题更烧脑。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
  { id:'seed_var_2026_27', title:'大侦探2026', year:2026, score:8.5, playCount:350000, contentType:'真人秀·推理·搞笑', actor:'何炅,张若昀,王鸥,魏晨,杨蓉', description:'明星推理探案,剧本杀沉浸体验,逻辑与笑料并存。', totalEpisodes:0, isComplete:false, currentEpisode:0, regional:'大陆', lang:'国语', isSerial:true },
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

function buildSeedShow(s) {
  return {
    ...s,
    id: s.id,
    mediaType: '综艺',
    type: 5,
    coverImg: s.coverImg || '',
    updateMsg: s.updateMsg || '',
    scrapedAt: '',
    isLive: false,
    isClassic: s.isClassic || false,
    seedId: s.id,
    category: 'chinese_variety',
    yfspUrl: s.yfspUrl || '',
    doubanUrl: s.doubanUrl || '',
    primaryUrl: s.primaryUrl || '',
    primaryUrlSource: s.primaryUrlSource || '',
    url: s.url || '',
    tmdbUrl: s.tmdbUrl || '',
    wikipediaUrl: s.wikipediaUrl || '',
    imdbUrl: s.imdbUrl || '',
    wikidataId: s.wikidataId || '',
    linkMatchedTitle: s.linkMatchedTitle || '',
    publishTime: s.publishTime || `${s.year}-01-01T00:00:00`,
    updateStatus: s.updateStatus || '',
  };
}

// ── 主逻辑 ──
const data = JSON.parse(readFileSync(SHOWS_FILE, 'utf-8'));

// 收集现有综艺（保留 live 数据）
const existing = data.chineseVariety || [];
const existingMap = new Map();
for (const s of existing) {
  const key = normalizeTitle(s.title);
  existingMap.set(key, s);
}

// 合并种子数据
const mergedMap = new Map(existingMap);
for (const s of SEED_VARIETY) {
  const key = normalizeTitle(s.title);
  if (!mergedMap.has(key)) {
    mergedMap.set(key, buildSeedShow(s));
  }
}

// 重新计算推荐分
let variety = [...mergedMap.values()];
for (const s of variety) {
  s.recommendScore = scoreVariety(s);
}

// 过滤掉被 Exclude 的
variety = variety.filter(s => s.recommendScore >= 0);

// 排序：推荐分降序
variety.sort((a, b) => b.recommendScore - a.recommendScore);

// 更新数据
data.chineseVariety = variety;
data.stats.chineseVariety = variety.length;

// 更新时间戳
data.lastUpdated = new Date().toISOString();

writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2), 'utf-8');

console.log(`[UPDATE] 综艺数据已更新:`);
console.log(`  现有 live 综艺: ${existing.length} 个`);
console.log(`  新增种子综艺: ${SEED_VARIETY.length} 个`);
console.log(`  合并后总数: ${variety.length} 个`);
console.log(`  TOP 10 综艺:`);
for (const s of variety.slice(0, 10)) {
  console.log(`    ▸ ${s.title} · 推荐分:${s.recommendScore} · ${s.year}年 · ${s.isLive ? 'live' : 'seed'}`);
}
