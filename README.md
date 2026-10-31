# Siteperch · 私人站点观测台

在一个地方查看网站访问、搜索表现和行为事件。原生静态前端配合同源只读 API，支持 GA4、Google Search Console、Cloudflare Web Analytics、Vercel Web Analytics 和 Bing Webmaster。

本仓库独立运行、测试和部署。被统计的网站只负责埋点；Siteperch 不依赖网站或游戏的源码、构建产物、存档、数据库及运行服务。

## 已有能力

- 访问总览、趋势、来源、页面、地区、设备、行为事件及搜索明细；各平台可用字段分别展示。
- 近 7 天、28 天和手动刷新；示例布局通过 `?demo=1` 打开，并始终显示示例标记。
- 五个提供方独立取数；未配置、空报表、真实零值、错误和旧快照分别显示。
- 保留各平台的时区、去重、抽样及处理延迟说明，不合并不同平台的访客数。
- 保留原有 GA4 游戏事件与 60/300/600 秒里程碑展示；事件次数不代表独立玩家、留存或转化漏斗。

## 本地运行

要求 Node.js 22 或更新版本，无第三方 npm 依赖，无安装步骤。

```sh
cp .env.example .env.local
node scripts/create-access.mjs
# 将 .local/owner-access.json 中的 passwordSha256、sessionSecret
# 分别填入 .env.local 的 DASHBOARD_PASSWORD_SHA256、DASHBOARD_SESSION_SECRET。
npm run dev
npm test
npm run check
```

默认地址为 `http://127.0.0.1:4397`，使用 `OBSERVATORY_PORT` 选择空闲端口。访问口令只在本机生成，文件权限为 0600。`.env.local`、`.local/`、`.vercel/`、`.wrangler/` 均被 Git 忽略。真实凭据、统计导出和私人验收证据不得提交。

## 配置

从 `.env.example` 配置自己的站点。代码没有默认的真实站点、账户、媒体资源或项目 ID。

| 配置 | 用途 |
| --- | --- |
| `APP_ORIGIN` | 看板的实际 HTTPS 来源，不含路径 |
| `SITE_DOMAIN` | 被统计网站的显示域名 |
| `DASHBOARD_PASSWORD_SHA256` | 所有者口令的 SHA-256 摘要 |
| `DASHBOARD_SESSION_SECRET` | 至少 32 字符的随机会话签名密钥 |
| `GA4_PROPERTY_ID`、`SEARCH_CONSOLE_SITE` | Google 媒体资源和 Search Console 站点资源 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 专用 Google 服务账号 JSON；GA4 Viewer、Search Console 受限读取权限 |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN` | 可替代服务账号的已有离线 OAuth 授权 |
| `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_SITE_TAG`、`CLOUDFLARE_ANALYTICS_TOKEN` | Web Analytics 站点及账户分析只读授权 |
| `VERCEL_ANALYTICS_PROJECT_ID`、`VERCEL_ANALYTICS_TEAM_ID`、`VERCEL_ANALYTICS_TOKEN` | 被统计的 Vercel 项目及专用授权 |
| `BING_SITE`、`BING_WEBMASTER_API_KEY` | 已验证的网站和 Bing Webmaster 授权 |

启用 Google Analytics Data API 和 Search Console API。Google OAuth 仅请求 `analytics.readonly` 和 `webmasters.readonly`；服务账号不需要 Cloud 项目管理角色。Cloudflare 使用限定账户的 Account Analytics Read Token。Vercel 尽可能限制到被统计项目。Bing API Key 可能覆盖整个用户账户；当前后端只对配置站点调用固定 GET 报表方法，尚未实现 Bing OAuth。

令牌的平台权限可能比本程序执行的读取操作更宽。提供方密钥、口令摘要和会话密钥应存为托管平台 Secret；站点和项目 ID 可存为 Config。后端只读取管理员配置的站点，不接受浏览器传来的目标 URL 或项目 ID。

## 托管

**Vercel**：将此仓库连接到独立的 Vercel 项目，Root Directory 留空，Framework 选择 Other，Output Directory 为 `public`，Install Command 留空。`vercel.json` 已配置测试和语法检查、东京单个 Node.js Function 及 `/api/*` 路由。仅 `main` 自动部署，PR 分支预览保持关闭。每次修改生产环境配置后重新部署。

**Cloudflare Workers + Static Assets**：`wrangler.jsonc` 使用同一 `server/worker.js` 后端，只有 `/api/*` 优先执行 Worker，静态资源直接交付。将配置和 Secrets 放到对应 Worker 后发布；仓库包含适配配置，不代表你的 Cloudflare 部署已经启用。CF Pages 前端若使用此方案，需要将同源 API 路由到该 Worker。

浏览器只请求本站，提供方 API 由托管后端访问。前端没有外部脚本、字体或图表 CDN。托管域名本身仍须可达，后端代理无法补回网站采集阶段漏掉的数据。

## 私有访问与额度

应用使用签名 `HttpOnly; Secure; SameSite=Strict` 会话，有效 8 小时；POST 校验同源 Origin，修改口令摘要或签名密钥使旧会话失效。口令不存入浏览器 localStorage，私有 API 返回 `private, no-store`，不开放跨域。登录接口在实例内做尽力限流：同一来源连续失败 5 次起触发指数退避（429 与 `Retry-After`，最长 15 分钟），跨来源失败总量另有全局上限；计数只存在于热实例，冷启动和多实例不共享，不能替代 CDN 层面的防护。

现有私人部署另有 Vercel 项目级 CDN Basic 认证，在进入 Function 前拒绝不匹配的请求。这个规则保存在平台私有 Routing Rules 中，源码不包含凭据；新建 Vercel 项目时需要单独配置。复用旧项目迁移仓库时保留并复核该规则。页面“退出”只清除应用会话，浏览器可能继续缓存 Basic 凭据。

CDN Basic 可以拦截未认证请求进入应用 Function，但 CDN 请求仍计入额度，认证通过的请求仍消耗正常资源。它不等于限流。

每次打开或手动刷新发送一个 summary 请求，后端并行取数，单次总预算 30 秒；无自动重试或高频轮询。实例内缓存最多 5 分钟并合并并发请求；冷启动和多实例不共享缓存，缓存减少上游请求而不免除 Function 调用。暂存旧快照最长一小时，并保留旧时间与失败状态。没有数据库、定时采集、付费存储或自动升级。

## 数据口径与验证

GA4 是访问和事件来源，实时指标为近 30 分钟活跃用户。期间去重用户不由每日去重用户累加。Google 搜索仅请求已定稿的网页搜索数据，并预留处理延迟；Bing 统计单独展示。Cloudflare RUM 可能抽样，页面显示观察到的采样间隔及覆盖限制。Vercel 只取 production 分组的期间访客数。

`npm test` 覆盖固定报表响应、WebCrypto JWT、登录与会话隔离、同源限制、错误脱敏、时区、期间去重、采样边界、局部失败和缓存。迁移或部署后还需要实际验证认证、7/28 天报表与五个提供方；本地测试不代表提供方授权或生产连接已经成功。
