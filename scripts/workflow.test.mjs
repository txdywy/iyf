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
  // 补偿计划依赖 8 小时新鲜度跳过，避免同一天重复消耗 AI 配额。
  assert.match(deploy, /if \[ "\$EVENT_NAME" = "schedule" \]; then/u);
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

test('the health job runs only after publishing, only for scrape runs, and reads committed data', () => {
  const health = jobBlock(deploy, 'health');
  assert.match(health, /needs: \[scrape, deploy, deploy-cloudflare\]/u);
  assert.match(health, /always\(\) && github\.ref == 'refs\/heads\/main' && github\.event_name != 'push'/u);
  assert.match(health, /needs\.scrape\.outputs\.scrape == 'true'/u);
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

test('the token-holding commit step retries fetches and disables repository hooks', () => {
  assert.match(deploy, /git_auth\(\) \{ git -c core\.hooksPath=\/dev\/null -c "http\.https:\/\/github\.com\/\.extraheader=/u);
  assert.match(deploy, /fetch_main\(\) \{\n\s+# [^\n]*\n\s+for attempt in 1 2 3; do\n\s+if git_auth fetch --no-tags origin main; then/u);
  assert.doesNotMatch(deploy.replace(/fetch_main\(\) \{[\s\S]*?\n {10}\}/u, ''), /git_auth fetch/u, 'every fetch must use the retry helper');
  assert.match(deploy, /git -c core\.hooksPath=\/dev\/null commit -m/u);
  assert.doesNotMatch(deploy, /git add -f/u, 'history.json is tracked and no longer ignored');
  assert.doesNotMatch(read('.gitignore'), /^data\/history\.json$/mu);
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
