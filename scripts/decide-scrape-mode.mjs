#!/usr/bin/env node

// 决定本次工作流运行是否抓取。抓取会消耗每日免费 AI 配额，因此以下情况只构建部署已提交数据：
// - push：代码合并不抓取；
// - 定时运行且已提交数据的 generatedAt 不足 8 小时：补偿计划与延迟的主计划可能紧挨着运行；
// - main 已经前进：排队的旧运行抓取后也会在提交步骤被丢弃（skip_stale），不如不抓。
// 读取 origin/main 只用检出时的无凭据远端（公开仓库），网络失败时按原逻辑继续抓取，绝不让任务失败。

import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const FRESH_DATA_MS = 8 * 60 * 60 * 1000;
const isCommitSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);

// readMainSha 返回 null 或抛错表示未能确认远端 main（网络失败等），此时按原逻辑抓取。
// 只有在其他条件都允许抓取时才读取远端，push 与新鲜数据的定时运行不发网络请求。
export async function decideScrapeMode({ eventName, showsText, now = Date.now(), headSha, readMainSha } = {}) {
  const notices = [];
  const logs = [];
  if (eventName === 'push') {
    return { scrape: false, reason: 'push', notices, logs };
  }
  if (eventName === 'schedule') {
    const age = generatedAgeMs(showsText, now);
    if (age !== null && age < FRESH_DATA_MS) {
      notices.push(`已提交数据 ${(age / 3_600_000).toFixed(1)} 小时前生成（不足 8 小时），本次定时运行不抓取，只构建部署已提交数据。`);
      return { scrape: false, reason: 'fresh', notices, logs };
    }
  }
  let mainSha = null;
  try { mainSha = await readMainSha?.(); } catch {}
  if (!isCommitSha(mainSha) || !isCommitSha(headSha)) {
    logs.push('无法确认 origin/main 的当前提交，按原逻辑继续抓取。');
    return { scrape: true, reason: 'main-unknown', notices, logs };
  }
  if (mainSha !== headSha) {
    notices.push(`main 已从 ${headSha} 前进到 ${mainSha}；本次运行不抓取（结果会在提交前被丢弃），较新提交的运行负责部署，下一次定时运行刷新数据。`);
    return { scrape: false, reason: 'main-advanced', notices, logs };
  }
  return { scrape: true, reason: 'scrape', notices, logs };
}

// 返回已提交数据生成至今的毫秒数；文件缺失、JSON 无效、时间无效或在未来时返回 null（按原逻辑抓取）。
export function generatedAgeMs(showsText, now) {
  let data;
  try { data = JSON.parse(showsText); } catch { return null; }
  const generated = typeof data?.generatedAt === 'string' ? Date.parse(data.generatedAt) : NaN;
  const age = now - generated;
  return Number.isFinite(age) && age >= 0 ? age : null;
}

const runGit = promisify(execFile);

// 最多尝试两次，禁止交互式凭据提示；失败返回 null，不抛错。
export async function readRemoteMainSha({ run = runGit, attempts = 2, backoffMs = 2_000,
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)) } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout } = await run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], {
        timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const sha = /^([a-f0-9]{40})\trefs\/heads\/main$/u.exec(String(stdout).trimEnd())?.[1];
      if (sha) return sha;
    } catch {}
    if (attempt < attempts) await sleep(backoffMs);
  }
  return null;
}

export async function runDecideScrapeMode({ root, env = process.env, now = Date.now(), readMainSha = () => readRemoteMainSha(),
  log = console.log } = {}) {
  let showsText = '';
  try { showsText = readFileSync(join(root, 'data', 'shows.json'), 'utf8'); } catch {}
  const result = await decideScrapeMode({ eventName: env.EVENT_NAME, showsText, now, headSha: env.GITHUB_SHA, readMainSha });
  for (const line of result.logs) log(line);
  for (const notice of result.notices) log(`::notice::${notice}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `scrape=${result.scrape}\n`, 'utf8');
  log(`Scrape this run: ${result.scrape}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDecideScrapeMode({ root: join(dirname(fileURLToPath(import.meta.url)), '..') }).catch(() => {
    // 决策本身不应阻断发布：意外异常时按原逻辑处理（push 不抓取，其他事件抓取）。
    const scrape = process.env.EVENT_NAME !== 'push';
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scrape=${scrape}\n`, 'utf8');
    console.log(`Scrape this run: ${scrape}`);
  });
}
