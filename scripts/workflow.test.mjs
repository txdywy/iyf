import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 工作流文本断言：只锁定发布约定的关键不变量，不依赖已提交数据的内容。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path), 'utf8');
const deploy = read('.github/workflows/scrape-and-deploy.yml');
const validate = read('.github/workflows/validate.yml');

function jobBlock(workflow, name) {
  const match = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [\\w-]+:\\n|$)`, 'u').exec(workflow);
  assert.ok(match, `missing job ${name}`);
  return match[1];
}

test('scheduled scrapes keep the primary times and add a later compensation pair', () => {
  assert.match(deploy, /- cron: '23 0,12 \* \* \*'/u);
  assert.match(deploy, /- cron: '47 4,16 \* \* \*'/u);
  // 补偿计划依赖 8 小时新鲜度跳过，避免同一天重复消耗 AI 配额；规则在 decide-scrape-mode 中单测。
  assert.match(deploy, /- name: Decide scrape mode\n\s+id: mode\n\s+env:\n\s+EVENT_NAME: \$\{\{ github\.event_name \}\}\n(?:\s+#[^\n]*\n)*\s+run: node scripts\/decide-scrape-mode\.mjs\n/u);
  const scrapeJob = jobBlock(deploy, 'scrape');
  assert.ok(scrapeJob.indexOf('- name: Decide scrape mode') < scrapeJob.indexOf('- name: Run Scraper'));
  assert.match(scrapeJob, /- name: Run Scraper\n\s+if: steps\.mode\.outputs\.scrape == 'true'/u);
  assert.doesNotMatch(deploy, /^\s+SCRAPE: /mu, 'scrape mode must come from the decision step output, not a job-level event expression');
});

test('the shared concurrency group and SHA-pinned actions are preserved', () => {
  assert.match(deploy, /concurrency:\n\s+group: "pages"\n\s+cancel-in-progress: false/u);
  for (const workflow of [deploy, validate]) {
    for (const [, reference] of workflow.matchAll(/uses: ([^\s#]+)/gu)) {
      assert.match(reference, /@[a-f0-9]{40}$/u, `${reference} must be pinned to a commit SHA`);
    }
  }
});

test('the health job runs after publishing on scheduled and manual runs and evaluates AI only for this run\'s scrape', () => {
  const health = jobBlock(deploy, 'health');
  assert.match(health, /needs: \[scrape, deploy, deploy-cloudflare\]/u);
  assert.match(health, /always\(\) && !cancelled\(\) && github\.ref == 'refs\/heads\/main' && github\.event_name != 'push'/u);
  const condition = /\n    if: ([^\n]*)/u.exec(health)?.[1] || '';
  assert.match(condition, /always\(\)/u);
  assert.doesNotMatch(condition, /needs\.scrape\.outputs\.scrape/u, 'skip-scrape runs still check snapshot staleness');
  // AI 停止只属于写出快照的那次抓取；跳过抓取或未发布的运行不能把它重复报告为新失败。
  assert.match(health, /IYF_SCRAPED_THIS_RUN: \$\{\{ needs\.scrape\.outputs\.scrape == 'true' && needs\.scrape\.outputs\.sha != '' && 'true' \|\| 'false' \}\}/u);
  assert.match(health, /ref: \$\{\{ needs\.scrape\.outputs\.sha \|\| 'main' \}\}/u);
  assert.match(health, /persist-credentials: false/u);
  assert.match(health, /permissions:\n\s+contents: read\n/u);
  assert.match(health, /node scripts\/check-health\.mjs/u);
  assert.doesNotMatch(health, /secrets\./u, 'the health check needs no credentials');
});

test('missing secrets only warn and their values are never echoed', () => {
  const step = /- name: Check secrets\n([\s\S]*?)\n\n/u.exec(deploy)?.[1] || '';
  for (const name of ['TMDB_TOKEN', 'OPENROUTER_API_KEY', 'CLOUDFLARE_DEPLOY_HOOK']) {
    assert.match(step, new RegExp(`if \\[ -z "\\$${name}" \\]; then\\n\\s+echo "::warning::${name}`, 'u'));
    assert.doesNotMatch(step, new RegExp(`echo[^\\n]*\\$${name}`, 'u'), `${name} must not be echoed`);
  }
  assert.doesNotMatch(step, /::error::|exit 1/u);
});

test('the token-holding commit step retries fetches and disables repository hooks and fsmonitor', () => {
  const step = /- name: Commit updated data\n([\s\S]*?)\n\n      - name: /u.exec(deploy)?.[1] || '';
  assert.match(step, /PUSH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(step, /git_local\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false "\$@"; \}/u);
  assert.match(step, /git_auth\(\) \{ git_local -c "http\.https:\/\/github\.com\/\.extraheader=/u);
  // 写令牌在环境中时，每条 git 命令都必须经过 git_local（或基于它的 git_auth）。
  const bareGit = step.split('\n').filter(line => /(?:^|[\s(;`$])git\s/u.test(line) && !/git_local\(\) \{ git -c/u.test(line) && !/^\s*#/u.test(line));
  assert.deepEqual(bareGit, [], 'no git invocation may bypass the hook/fsmonitor guard');
  assert.match(step, /git_local commit -m/u);
  assert.match(deploy, /fetch_main\(\) \{\n\s+# [^\n]*\n\s+for attempt in 1 2 3; do\n\s+if git_auth fetch --no-tags origin main; then/u);
  assert.doesNotMatch(deploy.replace(/fetch_main\(\) \{[\s\S]*?\n {10}\}/u, ''), /git_auth fetch/u, 'every fetch must use the retry helper');
  assert.doesNotMatch(deploy, /git add -f/u, 'history.json is tracked and no longer ignored');
  assert.doesNotMatch(read('.gitignore'), /^data\/history\.json$/mu);
});

test('a failed data push stops before publishing and is never swallowed', () => {
  const step = /- name: Commit updated data\n([\s\S]*?)\n\n      - name: /u.exec(deploy)?.[1] || '';
  assert.match(step, /pushed=false\n\s+local_sha="\$\(git_local rev-parse HEAD\)"\n\s+for i in 1 2 3; do\n\s+if git_auth push origin HEAD:main; then\n\s+pushed=true/u);
  assert.match(step, /if \[ "\$pushed" != "true" \]; then\n\s+echo "::error::[^"\n]*"\n\s+exit 1\n\s+fi/u);
  assert.ok(step.indexOf('exit 1') < step.indexOf('echo "publish=true"'), 'the failure exit precedes the publish output');
});

test('the Cloudflare job timeout covers the verifier deadline with margin', () => {
  const minutes = Number(/timeout-minutes: (\d+)/u.exec(jobBlock(deploy, 'deploy-cloudflare'))?.[1]);
  assert.ok(minutes >= 15, `deploy-cloudflare timeout ${minutes} must exceed the ~11.7 minute worst case`);
});

test('workflows use the dot reporter and validate every script syntax', () => {
  assert.match(deploy, /run: node --test --test-reporter=dot/u);
  assert.match(validate, /run: node --test --test-reporter=dot/u);
  assert.match(validate, /for file in js\/app\.js scripts\/\*\.mjs; do\n\s+node --check "\$file"/u);
  assert.match(validate, /fetch-depth: 0\n\s+filter: blob:none/u);
});

test('Dependabot groups action updates and waits for a cooldown', () => {
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /cooldown:\n\s+default-days: 7/u);
  assert.match(dependabot, /groups:\n\s+github-actions:\n\s+patterns:\n\s+- '\*'/u);
});
