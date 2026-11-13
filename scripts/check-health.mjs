#!/usr/bin/env node

// 发布后的数据健康检查：只读取已提交快照，不影响发布本身。
// 严重问题（来源长期降级、AI 凭据/额度被拒）以 ::error:: 报告并以 1 退出，让定时运行显示为失败；
// 次要降级（搜索兜底、AI 配额或预算提前停止）只发出 ::warning::。

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR_MS = 60 * 60 * 1000;
export const STALE_SOURCE_MS = 48 * HOUR_MS;
const PRIMARY_SOURCE_KINDS = new Set(['homepage', 'catalog']);
const FATAL_AI_STOP_REASONS = new Set(['auth', 'credit']);
const WARNING_AI_STOP_REASONS = new Set(['quota', 'failures', 'budget']);

const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
const parseTime = value => (typeof value === 'string' ? Date.parse(value) : NaN);

export function formatAge(ms) {
  if (!Number.isFinite(ms)) return '未知';
  const sign = ms < 0 ? '-' : '';
  const hours = Math.abs(ms) / HOUR_MS;
  if (hours < 1) return `${sign}${Math.round(Math.abs(ms) / 60000)} 分钟`;
  if (hours < 48) return `${sign}${hours.toFixed(1)} 小时`;
  return `${sign}${(hours / 24).toFixed(1)} 天`;
}

// 纯函数：根据快照与当前时间给出错误、警告与摘要字段。
export function evaluateHealth(data, { now = Date.now() } = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(data)) {
    return { errors: ['data/shows.json 根节点不是对象，无法检查健康状态'], warnings, facts: {} };
  }
  const sourceStatus = typeof data.sourceStatus === 'string' ? data.sourceStatus : '';
  const sourceKind = typeof data.sourceKind === 'string' ? data.sourceKind : '';
  const lastUpdatedAge = now - parseTime(data.lastUpdated);
  const generatedAge = now - parseTime(data.generatedAt);
  const ai = isObject(data.aiRunStatus) ? data.aiRunStatus : null;
  const stopReason = typeof ai?.stopReason === 'string' ? ai.stopReason : '';

  if (!Number.isFinite(lastUpdatedAge)) {
    errors.push(`来源状态为 ${sourceStatus || '未知'}，且 lastUpdated 无效`);
  } else if (lastUpdatedAge > STALE_SOURCE_MS) {
    errors.push(`来源状态为 ${sourceStatus || '未知'}，推荐快照已 ${formatAge(lastUpdatedAge)} 未更新（超过 48 小时）`);
  } else if (sourceStatus !== 'healthy') {
    warnings.push(`来源状态为 ${sourceStatus || '未知'}，沿用 ${formatAge(lastUpdatedAge)} 前的推荐快照`);
  }
  if (!PRIMARY_SOURCE_KINDS.has(sourceKind)) {
    warnings.push(sourceKind === 'search'
      ? '本次来源类型为 search：首页/目录覆盖不足，使用搜索兜底刷新'
      : `来源类型 ${sourceKind || '缺失'} 不是 homepage/catalog`);
  }
  if (FATAL_AI_STOP_REASONS.has(stopReason)) {
    errors.push(`AI 评分因 ${stopReason === 'auth' ? '鉴权失败' : '余额/额度不足'} (${stopReason}) 停止，请检查 OPENROUTER_API_KEY`);
  } else if (WARNING_AI_STOP_REASONS.has(stopReason)) {
    warnings.push(`AI 评分提前停止 (${stopReason})，本次已评分 ${Number.isInteger(ai.scored) ? ai.scored : '未知'} 部`);
  } else if (stopReason) {
    warnings.push(`AI 评分停止原因未知 (${stopReason.slice(0, 40)})`);
  }

  return {
    errors,
    warnings,
    facts: { sourceStatus, sourceKind, lastUpdatedAge, generatedAge, ai, stopReason },
  };
}

const cell = value => String(value ?? '—').replace(/[|\r\n]/gu, ' ').slice(0, 120) || '—';
const count = value => (Number.isFinite(value) ? String(value) : '—');

export function renderSummary(data, result) {
  const source = isObject(data) ? data : {};
  const stats = isObject(source.stats) ? source.stats : {};
  const { facts } = result;
  const ai = facts.ai;
  const status = result.errors.length ? '异常' : result.warnings.length ? '降级' : '正常';
  const rows = [
    ['总体', status],
    ['sourceStatus', facts.sourceStatus || '—'],
    ['sourceKind', facts.sourceKind || '—'],
    ['首页（成功 / 有效）', `${count(source.sourcePagesSucceeded)} / ${count(source.sourcePagesMeaningful)}`],
    ['目录（成功页数）', count(source.sourceCatalogPages)],
    ['搜索兜底（命中 / 目标）', `${count(source.sourceSearchMatched)} / ${count(source.sourceSearchTargets)}`],
    ['韩剧 / 综艺 / 其他', `${count(stats.koreanDramas)} / ${count(stats.chineseVariety)} / ${count(stats.otherDramas)}`],
    ['本轮抓取条目', count(stats.totalScraped)],
    ['AI 状态', ai ? `停止原因 ${facts.stopReason || '无'}，请求 ${count(ai.requested)}，评分 ${count(ai.scored)}` : '未记录'],
    ['lastUpdated', `${cell(source.lastUpdated)}（${formatAge(facts.lastUpdatedAge)}前）`],
    ['generatedAt', `${cell(source.generatedAt)}（${formatAge(facts.generatedAge)}前）`],
  ];
  const lines = ['## 数据健康检查', '', '| 项目 | 值 |', '| --- | --- |', ...rows.map(([key, value]) => `| ${cell(key)} | ${cell(value)} |`)];
  for (const [title, items] of [['错误', result.errors], ['警告', result.warnings]]) {
    if (!items.length) continue;
    lines.push('', `### ${title}`, '', ...items.map(item => `- ${item}`));
  }
  return `${lines.join('\n')}\n`;
}

export function runHealthCheck({ path, now = Date.now(), env = process.env, log = console.log, error = console.error } = {}) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    data = null;
    error(`::error::无法读取 data/shows.json (${cause?.name || 'Error'})`);
    return 1;
  }
  const result = evaluateHealth(data, { now });
  for (const warning of result.warnings) log(`::warning::${warning}`);
  for (const message of result.errors) error(`::error::${message}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(data, result), 'utf8');
  else log(renderSummary(data, result));
  return result.errors.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = runHealthCheck({ path: process.argv[2] ? resolve(process.argv[2]) : join(root, 'data', 'shows.json') });
}
