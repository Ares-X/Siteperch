# Siteperch · 私人站点观测台

在一个地方查看网站访问、搜索表现和行为事件。原生静态前端配合同源只读 API，支持 GA4、Google Search Console、Cloudflare Web Analytics、Vercel Web Analytics 和 Bing Webmaster。

本仓库独立运行、测试和部署。被统计的网站只负责埋点；Siteperch 不依赖网站或游戏的源码、构建产物、存档、数据库及运行服务。

## 已有能力

- 访问总览、趋势、来源、页面、地区、设备、行为事件及搜索明细；各平台可用字段分别展示。
- 近 7 天、28 天和手动刷新；示例布局通过 `?demo=1` 打开，并始终显示示例标记。
- 五个提供方独立取数；未配置、空报表、真实零值、错误和旧快照分别显示。
- 保留各平台的时区、去重、抽样及处理延迟说明，不合并不同平台的访客数。
- GA4 事件默认按原始名称展示，可配置标签、分组、排序及隐藏；LonelySky 游戏事件与 60/300/600 秒里程碑为可选预设。事件次数不代表独立用户、留存或转化漏斗。
- 总览可选择 GA4、Cloudflare 或 Vercel 为主数据源，指标、趋势和页面卡片使用对应平台的名称与口径。

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
| `DASHBOARD_PRIMARY_SOURCE` | 总览默认数据源：`auto`（默认）、`ga4`、`cloudflare` 或 `vercel` |
| `DASHBOARD_EVENT_PRESET` | `generic`（默认）或 `lonelysky`；后者启用游戏标签及专用里程碑查询 |
| `DASHBOARD_EVENT_DEFINITIONS_JSON` | 事件名称到展示配置的 JSON 对象，默认 `{}` |
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

### 总览与事件展示

`DASHBOARD_PRIMARY_SOURCE=auto` 按 GA4、Cloudflare、Vercel 的顺序选择首个已配置的数据源。临时读取失败会保留该来源及错误状态；界面的来源选择器可切换指标、趋势和页面卡片。Cloudflare 仍显示“访问次数”，Vercel 显示“独立访客”，各平台数值分别读取。

默认事件页面展示 GA4 返回的事件（当前查询最多返回 100 个事件名称）。可在托管平台设置以下 JSON；本地 `.env.local` 使用单引号包住整个 JSON：

```dotenv
DASHBOARD_EVENT_DEFINITIONS_JSON='{"download":{"label":"下载","group":"互动","order":1},"sign_up":{"label":"注册","group":"转化","order":2},"page_view":{"hidden":true}}'
```

`label`、`group` 是展示文本，`order` 是数字并按升序排列，`hidden` 是布尔值。未定义的事件继续显示原始名称。定义只改变展示，不创建网站埋点，也不会补回上游未返回的事件。配置格式错误会显示提示并使用有效配置或默认名称，提示不回显原始配置内容。展示配置会随已认证报表发送到浏览器，勿在这些字段中填写凭据。

**已有 LonelySky 部署迁移：**如需保留游戏事件中文标签和里程碑，请设置 `DASHBOARD_EVENT_PRESET=lonelysky` 后重新部署。它会启用 `play_milestone` 的 `customEvent:threshold_seconds` 查询；对应网站仍须自行发送事件，并在 GA4 注册该自定义维度。自定义事件定义可覆盖预设标签、排序和可见性。默认 `generic` 不查询游戏专用维度。

## 托管

**Vercel**：将此仓库连接到独立的 Vercel 项目，Root Directory 留空，Framework 选择 Other，Output Directory 为 `public`，Install Command 留空。`vercel.json` 已配置测试和语法检查、东京单个 Node.js Function 及 `/api/*` 路由。仅 `main` 自动部署，PR 分支预览保持关闭。每次修改生产环境配置后重新部署。

**Cloudflare Workers + Static Assets**：`wrangler.jsonc` 使用同一 `server/worker.js` 后端，只有 `/api/*` 优先执行 Worker，静态资源直接交付。将配置和 Secrets 放到对应 Worker 后发布；仓库包含适配配置，不代表你的 Cloudflare 部署已经启用。CF Pages 前端若使用此方案，需要将同源 API 路由到该 Worker。

`public/_headers` 为 Workers 静态资产设置与 Vercel 对齐的 CSP、`nosniff`、Referrer Policy 等响应头。API 的私有响应头仍由后端设置，静态资产不因此增加 Worker 执行。

浏览器只请求本站，提供方 API 由托管后端访问。前端没有外部脚本、字体或图表 CDN。托管域名本身仍须可达，后端代理无法补回网站采集阶段漏掉的数据。

## 私有访问与额度

应用使用签名 `HttpOnly; Secure; SameSite=Strict` 会话，有效 8 小时；POST 校验同源 Origin，修改口令摘要或签名密钥使旧会话失效。口令不存入浏览器 localStorage，私有 API 返回 `private, no-store`，不开放跨域。

现有私人部署另有 Vercel 项目级 CDN Basic 认证，在进入 Function 前拒绝不匹配的请求。这个规则保存在平台私有 Routing Rules 中，源码不包含凭据；新建 Vercel 项目时需要单独配置。复用旧项目迁移仓库时保留并复核该规则。页面“退出”只清除应用会话，浏览器可能继续缓存 Basic 凭据。

CDN Basic 可以拦截未认证请求进入应用 Function，但 CDN 请求仍计入额度，认证通过的请求仍消耗正常资源。它不等于限流。

每次打开或手动刷新发送一个 summary 请求，后端并行取数，单次总预算 30 秒；无自动重试或高频轮询。正常结果使用 5 分钟实例内缓存并合并并发请求；整源失败或网络、限流、上游服务错误等暂时性子报表失败使用 30 秒缓存，只有下一次打开或手动刷新才重试。未支持的能力、覆盖限制等稳定子报表状态保持正常缓存。冷启动和多实例不共享缓存，缓存减少上游请求而不免除 Function 调用。暂存旧快照最长一小时，并保留旧时间与失败状态。没有数据库、定时采集、付费存储或自动升级。

## 数据口径与验证

GA4 是访问和事件来源，实时指标为近 30 分钟活跃用户，其读取状态独立于历史汇总；历史报表为空时仍可显示有效的实时人数或真实的 0。期间去重用户不由每日去重用户累加。GA4 的采样、阈值、其他行合并和空结果原因按各份报告分别提示；“适用阈值”不等于已经有数据被隐藏。Google 搜索仅请求已定稿的网页搜索数据，并预留处理延迟；Bing 统计单独展示。Cloudflare RUM 可能抽样，页面显示观察到的采样间隔及覆盖限制。Vercel 只取 production 分组的期间访客数。

`npm test` 覆盖固定报表响应、WebCrypto JWT、登录与会话隔离、同源限制、错误脱敏、时区、期间去重、采样边界、局部失败和缓存。迁移或部署后还需要实际验证认证、7/28 天报表与五个提供方；本地测试不代表提供方授权或生产连接已经成功。

GitHub Actions 在 PR 和 `main` 提交上运行 Node.js 22、24 的测试与语法检查，仅需仓库读取权限，不读取生产 Secrets、不部署预览。前端回归测试使用实际 `app.js` 与模拟 DOM、报表响应；实际浏览器渲染及托管端取数需另外验收。
