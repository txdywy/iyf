# 剧荒救星

韩剧和轻松搞笑综艺推荐站，使用原生 JavaScript 和静态文件，无第三方运行依赖。

线上地址：[iyf.hackx64.eu.org](https://iyf.hackx64.eu.org/)。

## 本地开发和验证

需要 Node.js 22（见 `.node-version`）。

```sh
node --test
node scripts/build-site.mjs
python3 -m http.server 8765 --directory site --bind 127.0.0.1
```

打开 `http://127.0.0.1:8765/`。必须使用 HTTP，直接打开 `index.html` 无法请求推荐 JSON。

构建命令先校验数据，再生成 `site/`。输出仅含首页、404 页面、CSS、JS、公开推荐数据、Cloudflare 响应头和 robots 文件；不会发布抓取缓存、历史记录或脚本。复用输出目录时，发现未知文件、符号链接或硬链接会中止构建；输出路径也不能通过父目录别名覆盖源码。

## 数据更新

GitHub Actions 每天在北京时间 08:00、20:00 运行抓取、回归测试、校验和提交。定时任务可能因平台调度延迟；页面展示实际数据更新时间。数据源故障时沿用上一快照，保留已有评分、播放量、集数、简介来源和真实更新时间。同一天多次发现的新节目累积记录，后续空结果不会抹掉已发现的节目。

```sh
# 从来源重新抓取，可选密钥仅通过环境变量或 GitHub Actions secrets 配置
node scripts/scrape.mjs

# 无网络重算现有推荐分，保留原始数据更新时间
node scripts/scrape.mjs --recalculate-existing
```

`TMDB_TOKEN` 用于高清封面，`OPENROUTER_API_KEY` 用于可选 AI 评分；可用 `OPENROUTER_MODEL` 指定模型。缺少可选密钥时保留规则推荐与有效缓存。AI 输入明确标记十分制来源评分，未评分为 `null`；输出使用百分制推荐分，并校验分数与推荐档位一致。旧版量纲不明确的缓存会失效，真实低分不会被自动放大。AI 生成文案仅补充缺失文案，保留可靠的短简介，不参与规则评分或节目收录判断。

## 发布

GitHub Actions 在抓取、校验和提交成功后构建 `site/`，再通过独立任务发布 GitHub Pages 和 Cloudflare Pages。两者使用相同的 `scripts/build-site.mjs`，Cloudflare 的线上文件必须与该次已校验产物一致才算发布成功。

Cloudflare 项目地址：[iyf-5l7.pages.dev](https://iyf-5l7.pages.dev/)。

站点按自定义域名的根路径部署，404 页面也按根路径定位首页和样式。

| 设置 | 值 |
| --- | --- |
| 项目名称 | `iyf` |
| 仓库 | `txdywy/iyf` |
| 生产分支 | `main` |
| 构建命令 | `node --test && node scripts/build-site.mjs` |
| 输出目录 | `site` |
| Node.js | `22` |
| 自动 Git 构建 | 关闭，由 Actions 部署钩子触发 |

Cloudflare 保留 Git 来源以从 `main` 构建，关闭自动生产与预览构建，避免与 Actions 重复发布。在 Pages 项目中创建指向 `main` 的部署钩子，将其完整 URL 保存为当前仓库的 Actions Secret `CLOUDFLARE_DEPLOY_HOOK`；当前项目已配置。钩子 URL 属于凭据，不应写进仓库或日志。

Cloudflare 发布任务下载本次工作流的已校验产物，触发部署后以 10 分钟为轮询期限，同时核对正式域名与 Pages 域名的首页、CSS、JS、公开数据、robots 和真实 404 的内容摘要，以及缓存和安全响应头。任一域名不可访问、触发失败或线上仍是旧文件时任务失败；GitHub Pages 独立发布，继续作为备用。代码提交、定时抓取和手动运行均经过这条链路，数据机器人提交不会再递归触发抓取。

正式域名 `iyf.hackx64.eu.org` 的 CNAME 指向 `iyf-5l7.pages.dev`。HTML 和 JSON 使用重新验证缓存，CSS/JS URL 带内容摘要；Cloudflare 通过 `_headers` 额外设置安全响应头。详情见 [Cloudflare Pages 部署钩子文档](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)。
