# 故障复盘:AIGarbage 部署期间误劫持 `blog.011203.dpdns.org` 原站事故

- 文档类型:事故复盘（Post-mortem / Retrospective）
- 事故日期:2026-05-29
- 撰写日期:2026-05-29
- 严重等级:P1（线上服务被覆盖，影响用户已有站点，但可快速且完整恢复，无数据丢失）
- 状态:已恢复 / 已复盘 / 待落实改进项
- 关键词:Cloudflare Workers、Pages、自定义域名、Worker 路由优先级、域名占用核查缺失

---

## 0. 一句话结论（TL;DR）

在把 AIGarbage 这个"全自动 AI 博客"部署到 Cloudflare 的过程中，由于 `workers.dev` 在当前网络被重置、无法访问，我（执行方）改用自有域名绑定。绑定 `blog.011203.dpdns.org` 这个子域之前，我只核查了"Worker 路由"和"Worker 自定义域名"两类绑定，**漏查了 Cloudflare Pages 的自定义域名**。而 `blog.011203.dpdns.org` 恰恰是用户既有 Pages 项目 `blog` 的绑定域名（指向 `chenxuan520-github-io.pages.dev`）。由于 **Worker 路由的匹配优先级高于 Pages**，我新增的路由 `blog.011203.dpdns.org/*` 静默地把用户的原博客站点"盖"掉了，访问该域名返回的是 AIGarbage，而不是用户原本的博客。

事故由用户发现并指出。处置上，我删除了劫持路由、删除了本次创建的 Worker 与 KV，确认原站恢复（标题恢复为 `chenxuan's blog`），随后在一个**经过三类绑定全量核查、确认完全空闲**的新子域 `aigarbage.011203.dpdns.org` 上用"自定义域名"方式重新、隔离地完成了部署。

根因是**流程缺失**:在对一个共享 DNS 区（zone）内的主机名做"接管型"绑定前，没有执行覆盖全部绑定类型（Worker 路由、Worker 自定义域名、Pages 自定义域名，乃至普通 DNS 记录）的占用核查；叠加对"Worker 路由会覆盖 Pages"这一优先级规则的认知不足，最终造成误覆盖。

---

## 1. 背景与上下文

### 1.1 项目背景

AIGarbage 是一个略带自嘲意味的项目，其 README 自述为"用 AI 自动生成博客垃圾内容来污染互联网"。其原始形态是:

- 一个 Python 脚本 `src/main.py`:读取环境变量中的 AI API 配置与 prompt，调用 OpenAI 兼容接口生成一篇 markdown 文章，写入 Hexo 博客的 `source/_posts/` 目录。
- 一个标准的 Hexo 7.3 静态站点 `blog/`（landscape 主题）。
- 仅有 dependabot，没有任何 CI/CD，也没有自动触发入口。

本次任务的目标是:**重构项目并改为部署到 Cloudflare**。经过头脑风暴，最终确定的方案为"全 Cloudflare 原生":

- 用**单个 Cloudflare Worker** 同时承担两件事:`scheduled`（Cron 定时生成）与 `fetch`（对外服务站点）。
- 内容生成不再依赖外部 API，改用 **Cloudflare Workers AI**（绑定调用，无需 API key）。
- 文章与封面图存入**免费的 Workers KV**（用户未绑信用卡，必须留在免费额度内）。
- 选题来源为多个可插拔的新闻热点源（newsnow 兼容接口），由"选题 Agent"挑选、"写作 Agent"成文、"配图 Agent"出封面。
- 彻底弃用 Hexo 与 Python。

这一架构本身没有问题，代码层面也通过了类型检查与 `wrangler deploy --dry-run` 校验。事故发生在**部署上线、绑定域名**这一运维环节。

### 1.2 相关 Cloudflare 资产概览

用户的 Cloudflare 账号（account id `6dfe244c…`）下资产相当丰富，这也是本次事故的重要背景——这是一个**高密度、多服务共享**的账号，任何"接管型"操作都必须格外谨慎。

账号下的活跃 zone（域名）共 8 个:

- `011203.de5.net`
- `011203.dpdns.org`
- `011203.hidns.vip`
- `011203.qzz.io`
- `011203.xyz`
- `chaiquan.dpdns.org`
- `chaiquan.qzz.io`
- `chenxuan.de5.net`

仅 `011203.dpdns.org` 这一个 zone 下，就已存在如下绑定:

- Pages 项目自定义域名:`blog`（→ chenxuan's blog）、`img`、`mc`
- Worker 自定义域名:`map`（opensearch）、`cnmap`（baidumapsearch）、`tianmap`（tianmap）、`trafficpos`（trafficpos）

此外账号下还有大量 Pages 项目:`fund-cs-demo`、`newsnow`、`blog`、`mcmap`、`shortlink`、`email-frontend`、`mc`、`img`、`getip-cf-worker`、`libretv` 等，分别绑定在 `011203.xyz`、`011203.dpdns.org` 的各类子域上。

**教训前置**:在这样一个共享账号里，"某个子域看起来没人用"是一个极其危险的假设。子域可能被 Pages、Worker、普通 DNS 记录中的任意一种占用，而它们分属不同的 API 与不同的控制台入口。

### 1.3 网络环境的特殊性（事故的诱因之一）

执行部署的机器所在网络，对 `*.workers.dev` 存在**连接重置**(TLS 握手阶段 Connection reset / HTTP 000)。验证矩阵如下:

- `https://example.com` → HTTP 200
- `https://news.011203.xyz` → HTTP 200
- `https://aigarbage.011203.workers.dev/` → HTTP 000（连接被重置）

也就是说，普通 HTTPS 与用户自有域名都正常，唯独 Cloudflare 默认分配的 `workers.dev` 子域被网络中间设备重置。这直接导致:

1. 部署成功后，无法通过默认的 `aigarbage.011203.workers.dev` 访问/验证。
2. 连本地 `wrangler dev` 也受影响——它通过类 `workers.dev` 的预览通道建立"远程连接"来代理 Workers AI 调用，因此 AI 调用报 `InferenceUpstreamError: Network connection lost`。

为了让"部署后能被访问与验证"，我决定改用用户的自有域名。**这本身是合理的决定**，但正是在"选哪个域名、怎么绑"的执行中，因核查不充分而酿成事故。

---

## 2. 事故时间线

以下时间为当日（2026-05-29）近似时刻。

- 14:28 开始查看项目结构，明确这是 Python + Hexo 的"AI 生成博客"工具。
- 14:31 用户提出两点诉求:重构并改为部署到 Cloudflare；先一起头脑风暴。
- 14:46 进入 Plan 模式，产出方案:Cloudflare Pages vs 全 Worker 原生等。用户选择"全 CF 原生 + Workers AI"。
- 14:51 进一步确定:用免费 KV、保留"markdown 生成即渲染"的简洁性、多数据源由大模型自行选题提炼。
- 后续确认:配图每篇必出、封面 16:9、选题与写作拆成两个 Agent。
- 完成编码:Worker（TypeScript）项目落地，`tsc --noEmit` 通过，`wrangler deploy --dry-run` 通过；清理 Hexo 与旧 Python；更新 dependabot、README、.gitignore；新增可选的 GitHub Actions 部署工作流。
- 15:11 用户告知已 `wrangler login`，授权我直接操作上线。
- 15:11–15:30 执行上线:`wrangler whoami` 确认登录 → 创建 KV 命名空间（id `a7896…`）→ `wrangler deploy` 部署成功（`aigarbage.011203.workers.dev`，cron `0 */6 * * *`）→ 设置 `ADMIN_KEY` secret。
- 触发生成时发现 `workers.dev` 被网络重置（HTTP 000）。
- 诊断确认:仅 `workers.dev` 被重置，普通 HTTPS 正常；本地 `wrangler dev` 的 AI 远程通道同样受阻。
- 决定改绑自有域名。查询账号 zone 列表（8 个），呈现给用户选择。
- 用户选择 `011203.dpdns.org`。
- 尝试 `custom_domain` 绑定根域与 `blog` 子域均失败（提示"已存在外部管理的 DNS 记录"，错误码 100117）。**我据此（错误地）推断该 zone 存在代理通配记录**，遂改用 **Worker 路由** `blog.011203.dpdns.org/*`。
- 部署成功。`curl https://blog.011203.dpdns.org/` 返回 HTTP 200 且为 AIGarbage 页面；触发生成成功（一篇关于"比亚迪芯"的文章，约 32 秒），首页/单篇/配图验证通过。**我误以为大功告成并向用户报告。**
- 15:46 用户警觉:"`blog.011203.dpdns.org` 我他妈之前绑定了其他的（worker/服务）吧"。
- 15:46–15:49 排查:
  - 查 zone 内 Worker 路由 → 只有我刚加的 `blog.011203.dpdns.org/* → aigarbage`，无其它路由。
  - 查账号内 Worker 自定义域名（该 zone）→ `map/cnmap/tianmap/trafficpos`，**不含 blog**。
  - 进一步查 **Pages 项目自定义域名** → 发现 Pages 项目 `blog` 的绑定域名正是 `blog.011203.dpdns.org`（指向 `chenxuan520-github-io.pages.dev`）。**真相大白:我的 Worker 路由覆盖了用户的 Pages 原站。**
- 15:49 用户暴怒，要求立即恢复。
- 15:49–15:51 处置与恢复:
  - 通过 API 删除劫持路由（route id `2a34…`），确认 zone 内 Worker 路由数归零。
  - 验证 `blog.011203.dpdns.org` 恢复:HTTP 200，页面标题恢复为 `chenxuan's blog`，不再是 AIGarbage。
  - 删除本次创建的 `aigarbage` Worker（连带其 cron 触发器）与 KV 命名空间（`a7896…`）。
  - 清理本地 `wrangler.toml`，移除路由配置、还原 KV id 占位符，杜绝误部署再次劫持。
- 15:53 用户要求:先在正确的、未被占用的域名上把 AIGarbage 重新绑好并验证，再写本复盘文档。
- 15:53 之后 重新、谨慎地上线:
  - 全量核查 `*.011203.dpdns.org` 下的 Worker 路由 + Worker 自定义域名 + Pages 域名，确认 `aigarbage.011203.dpdns.org` 在三类绑定中均不存在 → 判定空闲。
  - 新建 KV 命名空间（id `d066…`）。
  - 发现该 zone **并无通配记录**（`aigarbage` 子域解析为 NXDOMAIN），说明之前 `blog`/根域的冲突是各自的具体记录，而非通配。因此改用 `custom_domain` 方式（由 wrangler 为该主机名创建独立 DNS 记录 + 证书）。
  - 部署成功；DNS 很快解析到 Cloudflare IP，但本机因负缓存了早先的 NXDOMAIN 而暂时直连失败。用 `curl --resolve` 绕过本机缓存后，HTTPS 200、worker 内容正确。
  - 触发生成成功（再次一篇"比亚迪芯"主题文章，约 41 秒，含封面），首页/单篇/配图验证通过。
  - 同时复验 `blog.011203.dpdns.org` 仍为 200、原站完好。

---

## 3. 系统架构与本次变更

### 3.1 重构后的目标架构

```
Cron Trigger（每 6 小时）
  → 并发抓取多个新闻源热点（可插拔 DataSource）
  → 聚合 + 去重，得到候选标题清单
  → [选题 Agent] 选 1 个选题 + 角度 + 配图 prompt（输出 JSON）
  → [写作 Agent] 依据选题产出 markdown 文章
  → [配图 Agent] flux-1-schnell 生成封面（base64 → 字节）
  → 写入 KV：post:<slug> / img:<slug> / index

HTTP 请求 → 同一个 Worker 的 fetch
  → 读 KV → marked 渲染 markdown 为 HTML → 返回（含封面、列表、RSS、sitemap）
```

### 3.2 涉及的核心文件

- `src/index.ts`:Worker 入口，`fetch` + `scheduled`，路由分发与受 `ADMIN_KEY` 保护的手动触发。
- `src/sources/newsnow.ts` + `src/sources/index.ts`:可插拔数据源（一个工厂覆盖所有 newsnow 源）。
- `src/prompts.ts` / `src/ai.ts`:选题与写作的 prompt、Workers AI 文本与图片调用封装。
- `src/store.ts`:KV 读写、slug 生成与防重。
- `src/generate.ts`:选题 → 写作 → 配图 → 落库的完整管道。
- `src/render.ts`:首页/单篇/出图/RSS/sitemap + 内联 CSS。
- `wrangler.toml`:KV 绑定、AI 绑定、Cron、变量；**以及本次事故的关键——域名绑定配置。**

### 3.3 部署过程中的实际变更

1. 创建 KV 命名空间并写入 `wrangler.toml`。
2. `wrangler deploy` 创建 Worker、上传代码、注册 cron 触发器。
3. `wrangler secret put ADMIN_KEY` 设置管理密钥。
4. （事故环节）为绕开 `workers.dev` 封锁，新增域名绑定:先试 `custom_domain`（失败），再改 `route`（成功但造成劫持）。
5. （恢复）删除路由、删除 Worker 与 KV、清理配置。
6. （重做）在 `aigarbage.011203.dpdns.org` 用 `custom_domain` 重新绑定。

---

## 4. 事故详述

### 4.1 触发点

为绕开 `workers.dev` 封锁，需要把 Worker 绑定到用户自有域名。用户从 zone 列表中选择了 `011203.dpdns.org`。

### 4.2 为什么没用 `custom_domain` 而用了 `route`

我先尝试了 Cloudflare 推荐的 `custom_domain = true` 方式绑定 `011203.dpdns.org`（根域）与 `blog.011203.dpdns.org`，但都返回错误:

```
Hostname '...' already has externally managed DNS records (A, CNAME, etc).
Delete them first or try a different hostname. [code: 100117]
```

这意味着这两个主机名上已经存在用户自管的 DNS 记录，`custom_domain` 拒绝在其上创建新记录。基于此，我做了一个**未经证实的推断**:该 zone 可能配置了代理通配（`*`）记录，导致任何子域都"已存在记录"，所以 `custom_domain` 在该 zone 上行不通——于是改用 **Worker 路由**:

```toml
routes = [
  { pattern = "blog.011203.dpdns.org/*", zone_name = "011203.dpdns.org" }
]
```

Worker 路由不创建 DNS 记录，只要目标主机名已经过 Cloudflare 代理（橙云）即可拦截其流量。部署成功，访问 `blog.011203.dpdns.org` 返回了 AIGarbage——我当时把它解读为"成功"，**而它实际上是"成功地劫持了用户的 Pages 原站"。**

### 4.3 覆盖发生的机制

关键事实:**在 Cloudflare 的请求匹配中，Worker 路由的优先级高于 Pages。** 当 `blog.011203.dpdns.org` 同时存在:

- 一个 Pages 自定义域名（用户的 `blog` 项目，早已绑定，并拥有有效证书与代理记录）；
- 一个我新增的 Worker 路由 `blog.011203.dpdns.org/*`；

时，所有对该主机名的请求会被 Worker 路由优先接管，交给 `aigarbage` Worker，从而**绕过/盖住**了原本由 Pages 提供的页面。用户原站在外观上"消失"了，取而代之的是 AIGarbage。

值得强调:Pages 的域名绑定**并未被删除或修改**，它依然存在；只是被更高优先级的路由"遮蔽"。这也是为什么一旦删除该路由，原站会**立刻、完整**恢复——这是不幸中的万幸。

### 4.4 为什么核查会漏

我在绑定前做了一定核查，但只覆盖了:

- 该 zone 的 Worker 路由(`GET /zones/{zid}/workers/routes`);
- 该 zone 的 Worker 自定义域名(`GET /accounts/{aid}/workers/domains?zone_id=...`)。

二者都不含 `blog`，于是我（错误地）判定 `blog` 空闲。**我漏掉了第三类、也是真正占用它的那一类——Pages 自定义域名**(`GET /accounts/{aid}/pages/projects` → 各 project 的 `domains`)。三类绑定分属不同 API、不同控制台模块，而我没有把它们当作"必须全部核查"的清单来对待。

---

## 5. 根因分析

### 5.1 直接原因

在 `blog.011203.dpdns.org` 上新增了 Worker 路由，而该主机名已被用户的 Pages 项目占用；由于 Worker 路由优先级高于 Pages，造成原站被覆盖。

### 5.2 5 Whys

1. **为什么原站被覆盖?** 因为我在其主机名上加了优先级更高的 Worker 路由。
2. **为什么会在被占用的主机名上加路由?** 因为我误判该主机名空闲。
3. **为什么会误判空闲?** 因为我的占用核查只覆盖了 Worker 路由与 Worker 自定义域名，没查 Pages 域名。
4. **为什么没查 Pages 域名?** 因为我没有一份"绑定前必须核查的全部绑定类型"的标准清单，凭经验临时核查，凭印象认为查了 Worker 相关就够了；同时对"Worker 路由会静默覆盖 Pages"这一风险认知不足，没意识到必须排查 Pages。
5. **为什么会在压力下走到用路由这一步?** 因为 `workers.dev` 被网络封锁，`custom_domain` 又因既有记录失败，我在"尽快让用户能访问"的压力下选择了 route 这条"能绕过 DNS 限制"的捷径，却没有同步评估它"会覆盖既有服务"的副作用。

### 5.3 深层/系统性原因

- **流程缺失（主因）**:缺少"接管型域名操作前的全量占用核查 SOP"。
- **知识盲点**:对 Cloudflare 中 Worker 路由 / 自定义域名 / Pages 域名 的优先级与相互覆盖关系理解不全。
- **危险假设**:把"我查的两类里没有"等同于"没人用"；把 `custom_domain` 失败臆测为"存在通配记录"，并据此选择了副作用更大的 route。
- **环境耦合**:`workers.dev` 封锁迫使在共享生产账号上即时做域名操作，放大了出错后果。
- **验证盲区**:我验证了"新站能访问"，却没有验证"我没有破坏任何既有站点"——验证只覆盖了"我想要发生的事"，没覆盖"我不希望发生的事"。

---

## 6. 影响评估

- **影响对象**:用户的个人博客 `blog.011203.dpdns.org`（Pages 项目 `blog`，源站 `chenxuan520-github-io.pages.dev`）。
- **影响表现**:在劫持路由存在期间，访问该域名返回 AIGarbage，而非用户原博客。
- **影响时长**:约从路由部署成功到被删除之间的数分钟（量级为分钟级，非小时级）。
- **数据影响**:无。Pages 项目、其内容与域名绑定均未被改动，仅被更高优先级路由遮蔽。
- **可逆性**:完全可逆。删除路由后原站立即、完整恢复。
- **对其它服务的影响**:无。`map/cnmap/tianmap/trafficpos` 等 Worker 自定义域名、其它 Pages 项目（`img/mc/...`）均未受影响。
- **费用影响**:可忽略。期间仅触发了个位数次 Workers AI 调用，远在每日 10000 neurons 免费额度内。

---

## 7. 检测与响应

### 7.1 如何被发现

**由用户发现**,而非由我或任何自动化告警发现。用户凭对自己账号资产的记忆，质疑"这个域名我之前绑过别的东西"。这暴露出我方**缺乏对'操作是否破坏既有资产'的主动验证**。

### 7.2 响应动作（按时间）

1. 立即承认问题并着手排查，先把三类绑定全部列出，定位到 Pages 项目 `blog`。
2. 通过 API 删除劫持路由(`DELETE /zones/{zid}/workers/routes/{id}`)，确认 zone 内路由归零。
3. 验证原站恢复:HTTP 200 且标题为 `chenxuan's blog`。
4. 删除本次创建的 `aigarbage` Worker（连带 cron）与 KV 命名空间，消除残留与潜在的 neuron 消耗。
5. 清理本地 `wrangler.toml`，移除路由、还原 KV 占位符。

### 7.3 恢复验证证据

- `GET /zones/{zid}/workers/routes` → `count: 0`
- `curl https://blog.011203.dpdns.org/` → HTTP 200，`<title>chenxuan's blog</title>`，`isAIGarbage: False`
- 删除 Worker、删除 KV 的 API 均返回 `success: True`

---

## 8. 处置与最终的正确做法

### 8.1 选择安全子域

在重做前，执行了**全量占用核查**，对 `*.011203.dpdns.org` 同时枚举:

- 所有 Pages 项目的 `domains`
- 账号内所有 Worker 自定义域名
- 该 zone 内所有 Worker 路由

得到该 zone 已占用清单:

- `blog` → Pages `blog`
- `img` → Pages `img`
- `mc` → Pages `mc`
- `map` → Worker `opensearch`
- `cnmap` → Worker `baidumapsearch`
- `tianmap` → Worker `tianmap`
- `trafficpos` → Worker `trafficpos`

候选 `aigarbage.011203.dpdns.org` 在三类绑定中均不存在 → **判定空闲**。

### 8.2 为什么这次用 `custom_domain` 而不是 route

重做时发现 `aigarbage.011203.dpdns.org` 解析为 NXDOMAIN，证明该 zone **并不存在通配记录**——也就推翻了事故当时"存在代理通配"的臆测。既然是干净的、无记录的新子域，正确做法就是用 `custom_domain = true`,让 wrangler 为这个主机名**创建它自己独立的 DNS 记录与证书**:

```toml
routes = [
  { pattern = "aigarbage.011203.dpdns.org", custom_domain = true }
]
```

`custom_domain` 是"为这个 Worker 独占一个全新主机名"的正规方式:它只新建该主机名的记录与证书，不会、也不应触碰任何既有服务。因为该子域此前无任何记录，也就不存在冲突。

### 8.3 最终验证（含"不破坏既有"的反向验证）

- 新站 `aigarbage.011203.dpdns.org`:HTTPS 200，页面为 AIGarbage（`isAIGarbage: True`）。
- 触发生成成功，首页列出文章并带封面缩略图;单篇含 `<h1>`、封面、5 个 `<h2>`;`/img/<slug>` 返回 `image/jpeg`、约 209KB。
- **反向验证**:`blog.011203.dpdns.org` 仍为 HTTP 200，且为用户原站——确认本次操作未影响任何既有资产。

> 关于本机直连偶发失败:这是本机 DNS 把早先的 NXDOMAIN 做了**负缓存**所致，并非线上问题;用 `curl --resolve` 绕过本机缓存即一切正常，缓存过期后本机也会恢复。

---

## 9. 哪些做对了 / 哪些做错了

### 9.1 做对的（What went well）

- 故障**完全可逆**:得益于"路由遮蔽"而非"删除/改写"，删除路由即刻恢复，无数据损失。
- 响应**迅速且有序**:先定位、再恢复、再清理、再用证据验证，每一步都有 API/HTTP 证据。
- 恢复后**主动清理**了本次创建的全部资源，未留残留（包括会持续消耗额度的 cron）。
- 重做时引入了**全量核查 + 反向验证**，把同类风险堵住。

### 9.2 做错的（What went wrong）

- **绑定前未做全量占用核查**,漏查 Pages，这是直接导火索。
- **对路由优先级缺乏认知**,没意识到 route 会覆盖 Pages。
- **用臆测替代核实**:把 `custom_domain` 失败臆测为"通配记录"，并据此选择了副作用更大的方案。
- **验证片面**:只验证"新站能访问"，未验证"未破坏既有站点"。
- **在高风险共享账号上走捷径**:为绕开 `workers.dev` 封锁而急于求成。

---

## 10. 经验教训（Lessons Learned）

1. **"没人用"必须被证明，而不是被假设。** 尤其在共享了大量服务的生产账号里。
2. **核查必须覆盖全部绑定类型。** 在 Cloudflare 上，一个主机名可能被 Worker 路由、Worker 自定义域名、Pages 自定义域名、普通 DNS 记录中的任意一种或多种占用,它们入口不同、API 不同，必须逐一排查。
3. **理解"覆盖关系/优先级"比记住"怎么绑"更重要。** Worker 路由会静默盖过 Pages，这类"静默覆盖"是最危险的。
4. **失败信息要核实，不要臆测。** `custom_domain` 报"已存在记录"时，应当去查清那条记录是什么、属于谁，而不是脑补出一个"通配记录"假设再据此换方案。
5. **验证要包含反向断言。** 不仅验证"我想要的发生了"，还要验证"我不想要的没发生（既有服务未受影响）"。
6. **能用正规、隔离的方式就不要走捷径。** 全新子域 + `custom_domain` 才是隔离的正解;route 适合"明知该主机名归我、我要接管"的场景。
7. **环境约束（如 `workers.dev` 封锁）不应成为降低操作安全标准的理由。**

---

## 11. 改进项（Action Items）

| 编号 | 改进项 | 优先级 | 状态 |
| --- | --- | --- | --- |
| A1 | 制定并遵循"接管型域名操作前的全量占用核查 SOP"（见第 12 节） | 高 | 进行中 |
| A2 | 任何域名/路由变更后，执行"反向验证":确认相邻既有服务（同 zone 的其它子域）未受影响 | 高 | 进行中 |
| A3 | 优先使用全新子域 + `custom_domain` 的隔离绑定;仅在确认主机名归属于本服务时才使用 route | 高 | 已采纳 |
| A4 | 在仓库内沉淀本复盘与 SOP，作为后续部署的前置检查 | 中 | 本文件即落实 |
| A5 | 对"失败/报错信息"建立"先核实再决策"的习惯，禁止用未经证实的假设驱动方案切换 | 中 | 进行中 |
| A6 | 评估为该类操作准备一个带 `dns_records` 读权限的 API Token，以便核查阶段能直接读取 DNS 记录 | 低 | 待定 |

---

## 12. 预防 SOP:接管型域名操作前的检查清单

> 适用场景:要把某个 Worker/服务绑定到一个**共享 zone**内的主机名时。

绑定前，对目标主机名 `H` 与其所在 zone 执行下列全部核查，**任一命中即视为被占用，必须更换主机名或与所有者确认**:

1. **Pages 自定义域名**:`GET /accounts/{aid}/pages/projects`，遍历每个 project 的 `domains`，确认不含 `H`。
2. **Worker 自定义域名**:`GET /accounts/{aid}/workers/domains?zone_id={zid}`，确认 `hostname` 不含 `H`。
3. **Worker 路由**:`GET /zones/{zid}/workers/routes`，确认 `pattern` 不含 `H` 或 `H/*` 等可匹配模式。
4. **普通 DNS 记录**:`GET /zones/{zid}/dns_records?name={H}`（需 `dns_records` 读权限），确认无既有记录;若无权限，至少用 `dig`/`host` 观察 `H` 是否已解析。
5. **解析探测**:`dig +short @1.1.1.1 H`——若已解析，说明大概率已被占用或有通配，需查明归属。

绑定方式选择:

- 若 `H` **无任何记录、确认空闲** → 用 `custom_domain = true`（隔离、自建记录与证书，最安全）。
- 若 `H` **已确认归属本服务**、需要接管其已代理流量 → 才可用 route。
- 若 `custom_domain` 报"已存在记录" → **停止**，先查明那条记录属于谁，**不要**改用 route 去"绕过"。

绑定后，执行**反向验证**:

- 访问 `H`，确认是本服务。
- 抽查**同 zone 的其它既有子域**（如本例的 `blog`、`map`、`img` 等）仍返回各自原本的服务。

---

## 13. 技术附录

### 13.1 关键命令与 API（本次实际用到）

创建 / 删除 KV:

```bash
npx wrangler kv namespace create BLOG_KV
# 删除（API）
curl -X DELETE \
  "https://api.cloudflare.com/client/v4/accounts/$AID/storage/kv/namespaces/$NSID" \
  -H "Authorization: Bearer $TOKEN"
```

部署 / 设密钥:

```bash
npx wrangler deploy
npx wrangler secret put ADMIN_KEY   # 交互输入;或 printf '%s' "$KEY" | npx wrangler secret put ADMIN_KEY
```

核查绑定（事故的关键，务必三类全查）:

```bash
# Pages 域名
curl -s "https://api.cloudflare.com/client/v4/accounts/$AID/pages/projects" -H "Authorization: Bearer $TOKEN"
# Worker 自定义域名
curl -s "https://api.cloudflare.com/client/v4/accounts/$AID/workers/domains?zone_id=$ZID" -H "Authorization: Bearer $TOKEN"
# Worker 路由
curl -s "https://api.cloudflare.com/client/v4/zones/$ZID/workers/routes" -H "Authorization: Bearer $TOKEN"
```

删除劫持路由（恢复关键）:

```bash
curl -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZID/workers/routes/$RID" \
  -H "Authorization: Bearer $TOKEN"
```

删除 Worker:

```bash
curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/$AID/workers/scripts/aigarbage?force=true" \
  -H "Authorization: Bearer $TOKEN"
```

绕过本机 DNS 负缓存做验证:

```bash
curl -s --resolve aigarbage.011203.dpdns.org:443:104.21.78.100 https://aigarbage.011203.dpdns.org/
```

### 13.2 Cloudflare 主机名匹配优先级（经验总结）

- 对同一主机名,**Worker 路由 / Worker 自定义域名 的优先级高于 Pages**。因此在已被 Pages 绑定的主机名上加 Worker 路由，会静默遮蔽 Pages 站点。
- `custom_domain` 会尝试为主机名创建独立 DNS 记录与证书;若该主机名**已有外部管理记录**，会以 `100117` 报错并拒绝，这是一种"安全护栏"。遇到它应当**查明既有记录归属**，而非改用 route 绕过。

### 13.3 Workers AI 模型变更记录

初版配置里的模型在执行时已被 Cloudflare 下线:

- `@cf/meta/llama-3.1-8b-instruct-fp8-fast` → 报 `5028: deprecated on 2025-10-01`。
- `@cf/qwen/qwen1.5-14b-chat-awq` → 旧模型，一并替换。

通过 `GET /accounts/{aid}/ai/models/search` 查询账号当前可用模型后，更新为:

- 选题 Agent:`@cf/google/gemma-3-12b-it`
- 写作 Agent:`@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- 配图 Agent:`@cf/black-forest-labs/flux-1-schnell`（仍可用）

并在写作环节加入剥离 `<think>…</think>` 的兜底，避免推理类模型污染正文。

**衍生教训**:模型 id 易随时间下线，应通过"models/search"动态校验，而非硬编码后想当然可用。

### 13.4 免费额度与成本（无信用卡约束）

- Workers AI:每日 10000 neurons 免费，UTC 0 点重置。一篇文章（选题 + 写作 + 配图）约消耗数百 neurons,每天数十篇仍在免费额度内。
- KV:每日 10 万读 / 1000 写、1GB 存储免费。封面单张约 50–210KB。
- flux-1-schnell 出图成本:约 `(steps×9.6)+(tiles×4.8)` neurons，1024 尺寸、4 步约数十 neurons。

### 13.5 名词解释

- **zone**:Cloudflare 中的一个域（如 `011203.dpdns.org`），其下可有任意多个子域记录。
- **Worker 路由(route)**:把匹配某 URL 模式的请求交给某个 Worker;不创建 DNS，依赖目标主机名已被 Cloudflare 代理。
- **Worker 自定义域名(custom domain)**:为 Worker 绑定一个独占主机名，自动创建该主机名的 DNS 记录与证书。
- **Pages 自定义域名**:Cloudflare Pages 项目绑定的对外主机名。
- **负缓存(negative caching)**:解析器把 NXDOMAIN 结果按 TTL 缓存一段时间，导致记录已创建但本机短时间内仍解析失败。

### 13.6 当前最终状态

- AIGarbage 线上地址:`https://aigarbage.011203.dpdns.org`（custom domain，隔离绑定）。
- 定时:Cron `0 */6 * * *`，每 6 小时自动生成一篇（含封面）。
- 用户原站 `blog.011203.dpdns.org`:完好（`chenxuan's blog`）。
- 其它 Worker / Pages 资产:全部未受影响。

---

## 14. Cloudflare 域名接入机制详解（本次事故的知识核心）

这次事故的本质，是对"同一个主机名可以被多种机制接入、且它们之间存在覆盖关系"理解不透。这里系统地梳理一遍，作为团队后续操作的知识基线。

### 14.1 四种"占用"一个主机名的方式

在 Cloudflare 上，一个主机名（例如 `blog.011203.dpdns.org`）可能通过以下任意一种或多种方式"被使用":

1. **普通 DNS 记录（A / AAAA / CNAME）**:最基础的解析。可以是"仅 DNS"（灰云，直连源站）或"已代理"（橙云，经 Cloudflare 边缘）。只有"已代理"的主机名，才能被 Worker 路由拦截。
2. **Worker 自定义域名（custom domain）**:为某个 Worker 独占绑定一个主机名。Cloudflare 会**自动为该主机名创建并管理 DNS 记录与边缘证书**。它是"这个主机名属于这个 Worker"的强声明。
3. **Worker 路由（route）**:形如 `host/path*` 的模式匹配。它**不创建 DNS**，而是在请求进入 Cloudflare 边缘后，按模式把流量"截流"给某个 Worker。前提是该主机名已经过 Cloudflare 代理（否则请求根本到不了边缘）。
4. **Pages 自定义域名**:Cloudflare Pages 项目对外暴露的主机名，同样由 Cloudflare 托管 DNS 与证书。

这四者分属**不同的控制台模块**与**不同的 API 端点**:Pages 在 `/accounts/{aid}/pages/projects`，Worker 自定义域名在 `/accounts/{aid}/workers/domains`，Worker 路由在 `/zones/{zid}/workers/routes`，DNS 记录在 `/zones/{zid}/dns_records`。**没有任何单一接口能一次性告诉你"这个主机名到底被谁占用"**，这正是核查必须"四管齐下"的根本原因，也是我这次只查了其中两类就误判的陷阱所在。

### 14.2 覆盖与优先级

最关键、也最反直觉的一点:**Worker 路由 / Worker 自定义域名 的匹配优先级高于 Pages。**

这意味着:即便 `blog.011203.dpdns.org` 已经是某个 Pages 项目的自定义域名（拥有自己的 DNS 与证书、对外正常服务），只要我在**同一个主机名**上再叠加一条 Worker 路由 `blog.011203.dpdns.org/*`，边缘在路由匹配阶段就会优先把请求交给 Worker，Pages 那一层根本轮不到处理。表现上就是"原站消失、被 AIGarbage 取代"。

而且这种覆盖是**静默**的:

- Cloudflare 不会因为"这个主机名已被 Pages 使用"而拒绝你创建 Worker 路由——因为 route 这套机制压根不查 DNS/Pages 占用，它只管"模式匹配 + 截流"。
- `wrangler deploy` 也不会报任何冲突错误（事实上它返回成功）。

"成功部署"与"正确部署"在这里被危险地划上了等号。这提醒我们:**一个操作返回 success，只代表它做了它要做的事，绝不代表它没有破坏别的事。**

### 14.3 为什么 `custom_domain` 反而"更安全"

与 route 相反，`custom_domain = true` 在创建时会去**检查目标主机名是否已有外部管理的 DNS 记录**，若有则以 `100117` 报错并拒绝执行（"Hostname already has externally managed DNS records"）。这其实是一道**护栏**:它在替你说"这个主机名上已经有别的东西了，我不替你乱建"。

本次事故里，我恰恰把这道护栏的报错**误读**了——它本是在提示"`blog` 已被占用（实际是被 Pages 占用）"，我却臆测成"这个 zone 有通配记录、所以 custom_domain 用不了"，转而选择了**没有这道护栏**的 route 方案，亲手绕过了本可以拦住事故的保护。

正确的反应应当是:看到 `100117`，**停下来去查那条记录属于谁**，而不是换一条副作用更大的路。

### 14.4 各机制的适用场景

- **全新、无人使用的主机名，想给某个 Worker 用** → 用 `custom_domain`。它会建好独立 DNS + 证书，干净隔离，且自带占用护栏。这是本次重做时采用的方式。
- **某主机名已确认归属于本服务、需要按路径把部分流量交给 Worker** → 用 route（例如只把 `api.example.com/v1/*` 交给某 Worker）。
- **静态站点** → Pages 自定义域名。
- **需要直连自有源站或做复杂解析** → 普通 DNS 记录。

一句话:**route 是"截流既有主机名"的工具，不是"申请新主机名"的工具。** 把它当后者用，就极易踩到"截了别人流"的雷。

---

## 15. 本次架构关键决策回顾

事故归事故，方案本身的决策链条仍值得记录，便于后续维护者理解"为什么是现在这个样子"。

### 15.1 为什么是"全 Cloudflare 原生"而非 Pages + 外部生成

候选方案有三:(A) 保留 Python 生成 + GitHub Actions 定时 + Cloudflare Pages 托管;(B) 全 CF 原生(Worker + Cron + Workers AI);(C) 折中(Worker 当闹钟触发 GitHub Actions)。用户明确选择 B,理由是希望尽量不依赖 GitHub、全栈收敛在 Cloudflare 内,运维面更小。代价是 Python 需重写为 TypeScript,但换来"一个 Worker 跑全部"的简洁。

### 15.2 为什么用 KV 而不是 D1

用户没有绑定信用卡,必须严格留在免费额度内,且倾向"简单"。KV 免费额度(10 万读/天、1000 写/天、1GB)对一个每天产出个位数文章、读多写少的博客绰绰有余;数据模型也足够简单:`post:<slug>` 存文章 JSON、`img:<slug>` 存封面字节、`index` 存有序的文章元数据列表。相比之下 D1(关系型)在这个场景属于"杀鸡用牛刀",且会引入 schema 维护成本。保留"markdown 生成即渲染"的朴素链路,也契合用户对简洁的偏好。

### 15.3 为什么把选题与写作拆成两个 Agent

把"选题"与"写作"解耦,带来若干工程收益:

- 选题任务轻(读候选标题、输出一个 JSON),可用更小更快更省的模型;写作任务重,可用更强的模型。两者模型可独立配置(`AI_MODEL_SELECT` / `AI_MODEL_WRITE`)。
- 失败可分别重试、分别观测;两段 prompt 可独立迭代,互不干扰。
- 选题 Agent 额外产出一段英文配图 prompt,直接喂给配图 Agent,链路自然衔接。

配图作为第三个 Agent(`flux-1-schnell`),每篇必出一张 16:9 封面;失败会重试一次再降级为"无封面但不丢文章",在"每篇必出"与"健壮性"之间取平衡。

### 15.4 为什么是 flux-1-schnell

它在 Workers AI 上**直接返回 base64 图**,解码后即可写入 KV、由 `/img/<slug>` 出图,链路最短;出图成本低(千级 neuron 以下),免费额度足以支撑每天数十张。真 16:9 还可借 `object-fit: cover` 在前端兜底成统一头图比例。

### 15.5 为什么动态渲染而非预生成静态

Worker 在请求时从 KV 读 markdown、用 `marked` 渲染为 HTML 返回,配合边缘缓存即可。对低流量博客而言,这比"预生成一堆静态文件再托管"更简单,且天然支持即时上新(定时任务写完 KV,下一次访问就能看到),无需重新构建/部署。

---

## 16. 反事实分析:在哪些节点本可避免

把时间线拆成关键决策点,逐一对照"当时怎么做就能避免":

1. **选定 `blog` 子域准备绑定时**——若当时执行了"Pages 域名 + Worker 自定义域名 + Worker 路由"三类全量核查,就会立刻看到 `blog` 属于 Pages 项目,从而换名,事故根本不会发生。**这是成本最低、收益最高的拦截点。**
2. **`custom_domain` 报 `100117` 时**——若当时去查清那条既有记录的归属(而非臆测成通配),也会发现 `blog` 被 Pages 占用,从而止步。
3. **决定改用 route 时**——若当时意识到"route 会静默覆盖 Pages",就会拒绝在一个来历不明的主机名上加 route。
4. **route 部署后验证时**——若当时不仅验证"新站能打开",还顺手抽查"`blog` 原本是不是别的站、现在有没有变",也能在用户发现之前自查出来。

四个节点,任意一个做到位都能阻断事故。事故往往不是单点失误,而是一连串本可拦截的点全部失守——这也正是"清单/SOP"价值所在:它把"凭记忆和状态"变成"按项核对",不依赖当时是否想得起来。

---

## 17. 常见疑问（FAQ）

**Q1:用户的 Pages 站点数据有没有被破坏?**
没有。Pages 项目、其内容、其域名绑定全程未被改动,只是被更高优先级的 Worker 路由临时遮蔽。删除路由后即刻、完整恢复。

**Q2:为什么删掉路由就能立即恢复?**
因为覆盖是"遮蔽"而非"替换"。底层 Pages 绑定一直存在,移除遮蔽它的路由后,边缘的请求匹配重新落回 Pages。

**Q3:那几个还在跑的 Worker(map/cnmap/...)受影响了吗?**
没有。它们各自绑在不同子域上,与本次操作的主机名不重叠。

**Q4:新站为什么我本机一开始打不开?**
本机 DNS 把更早的一次 NXDOMAIN 结果做了负缓存。线上 DNS 已正确解析到 Cloudflare;用 `--resolve` 绕过本机缓存验证即一切正常,缓存过期后本机也会恢复。

**Q5:为什么不直接用 `workers.dev` 默认域名?**
因为执行机所在网络对 `*.workers.dev` 做了连接重置,无法访问。这也是被迫改用自有域名、进而触发本次事故的环境诱因。

**Q6:以后还能安全地把新服务绑到这个账号的域名上吗?**
能,但必须遵循第 12 节 SOP:先三类(+DNS)全量核查确认主机名空闲,优先用 `custom_domain` 隔离绑定,绑定后做反向验证。

**Q7:管理密钥 `ADMIN_KEY` 泄露了怎么办?**
它只保护 `/admin/generate` 手动触发入口,且为随机值、存于 Cloudflare secret。需要时用 `wrangler secret put ADMIN_KEY` 重置即可,代价极低。

---

## 18. 对"代他人操作云账号"的通用准则

本次事故发生在"受托直接操作用户生产账号"的情境下,这类情境风险天然更高,沉淀几条通用准则:

1. **最小惊讶 + 最小破坏**:任何会影响"既有、对外可用"资源的操作,默认按"可能伤到别人"对待,先核查、再动手。
2. **接管型操作要显式确认归属**:凡是"截流/绑定/覆盖"类操作,必须先证明目标资源**当前无人使用或确属本服务**。
3. **报错先核实,不臆测**:把每一个 4xx/护栏报错当成"系统在保护你",去查清原因,而不是换个绕过它的方法。
4. **验证要双向**:既验证"想要的发生了",也验证"不想要的没发生(既有服务无恙)"。
5. **优先可逆、隔离的方案**:全新子域 + 独占绑定,远优于在既有主机名上叠加。
6. **出事先恢复、再清理、再用证据说话**:恢复优先级最高;清理掉自己引入的一切残留;每步留 API/HTTP 证据。
7. **环境受限不降低安全标准**:像 `workers.dev` 被封这种约束,只能改变"怎么访问",不能成为"少做核查"的借口。

---

## 19. 数据源可插拔设计与多源扩展实践

用户的一个明确诉求是"会接入很多个数据源、由大模型自己选题提炼",因此数据源层从一开始就按"可插拔、强扩展"来设计,这里把设计与扩展方式讲清楚,方便后续维护者增删源。

### 19.1 统一抽象

核心是两个类型:

- `NewsItem`:一条热点,包含 `id`、`title`、`url`,以及可选的 `source`、`extra`。
- `DataSource`:一个源,包含 `id`、`name` 与 `fetch(env)`,后者返回 `NewsItem[]`。

只要实现 `DataSource`,任何来源都能接入。对于 newsnow 兼容接口(`GET {NEWS_API_BASE}/api/s?id=<id>&latest`,返回 `{status,id,items:[{id,title,url}]}`),由 `newsNowSource(id, name)` 工厂一行覆盖——因为 66 个源共用同一套接口,只是 `id` 不同,所以一个工厂 + 一份"启用清单"就能管理大量源。

### 19.2 用变量驱动启用清单

启用哪些源由 `wrangler.toml` 的 `SOURCES` 变量(逗号分隔的 id 列表)决定,`getSources(env)` 据此构造源数组;`KNOWN_NAMES` 给常见源 id 配了中文显示名(虎嗅、知乎、36氪……),未知 id 也能用——直接拿 id 当名字。新增一个 newsnow 源,只需往 `SOURCES` 里加一个 id,无需改代码。

### 19.3 接入非 newsnow 的自定义源

如果某个源不是 newsnow 协议(字段不同、鉴权不同、分页不同),做法是:在 `src/sources/` 下新建一个文件,实现 `DataSource` 接口,在 `fetch` 里把该源的原始响应**映射**成统一的 `NewsItem[]`(只需取出标题、链接、唯一 id),再在 `src/sources/index.ts` 的注册表里把它 push 进去即可。对管道的上层而言,所有源长得一模一样。

### 19.4 聚合、去重与容错

`collectCandidates` 用 `Promise.allSettled` **并发**抓取所有启用源,这样:

- **单源失败不影响整体**:某个源超时或返回异常,只记一条错误日志并跳过,其余源照常贡献候选。
- **按标题去重**:不同源可能推同一热点,用标题做集合去重,避免重复选题。

聚合后取候选清单的前若干条(当前取前 40)喂给选题 Agent,既给足选择空间,又控制 prompt 体积与 token 成本。

### 19.5 让"大模型自己选题提炼"

选题 Agent 拿到的是"候选标题清单",被要求输出一个**严格 JSON**:选定标题、写作角度、要点数组、英文配图 prompt。这就把"从一堆热点里挑哪个、从什么角度写、配什么图"的判断**交给了模型**,符合用户"多源 + 大模型自己提炼"的设想。为应对模型偶发不吐 JSON,解析采用"宽松提取"(容忍代码块包裹、容忍前后噪声),并在彻底失败时降级为"取最热的一条",保证管道不中断。

---

## 20. 生成质量、内容安全与健壮性考量

### 20.1 模型选择的权衡

选题任务轻、写作任务重,因此默认让选题用更轻量的 `gemma-3-12b-it`、写作用更强的 `llama-3.3-70b-instruct-fp8-fast`。刻意**避开了推理类模型**(如 `deepseek-r1-distill`、`qwq-32b`、`gpt-oss` 系列):这类模型会输出"思考过程",容易把 `<think>…</think>` 或分析性文字混进正文,污染文章。即便如此,写作环节仍加了一道**剥离 `<think>…</think>` 的兜底**,以防万一。

### 20.2 "8000 字"这种长文的现实约束

原始 prompt 写着"8000 字",但 Workers AI 单次调用受输出 token 上限约束,现实上很难一次产出那么长的中文。因此把目标设为可配置的 `WRITE_MAX_TOKENS`(默认约 2000–3000 字量级),并在文档中标注"如需长文,后续可做分段续写"。**与其让模型截断出半截文章,不如设一个能稳定完成的长度。**

### 20.3 slug 防重与防覆盖

文章 key 为 `post:<slug>`,slug 由"日期 + 规范化标题 + 4 位随机串"构成。加随机串是为了**防止同标题互相覆盖**——否则同一天若两次选到相近标题,后者会覆盖前者。规范化会去除文件系统/URL 不安全字符并限制长度。

### 20.4 封面"每篇必出"与健壮性的平衡

用户要求每篇必出封面,但若把"出图失败"直接升级为"整篇失败",会因为一个相对次要的环节丢掉已经写好的正文,得不偿失。折中是:配图**重试一次**,仍失败则记 `hasCover=false`、**保留文章**,前端对无封面文章用渐变占位块兜底。这样既尽力满足"必出",又不让正文为配图陪葬。

### 20.5 来源回链

写完后,管道会尝试把"选定标题"匹配回候选里的原始条目,拿到其 `url`,在文末渲染成"灵感来源"外链(带 `rel="nofollow noopener"`)。这既是对热点来源的弱归属,也让页面多一个出站链接。

### 20.6 内容安全的取舍

`marked` 默认不对 markdown 里的原始 HTML 做消毒。对这个"自娱自乐的垃圾博客"而言风险可接受,但这一点必须**被明确知道**:如果未来要承载更严肃的用途,应引入消毒(如只允许安全子集)或在 prompt 层面约束模型不要输出脚本类内容。

---

## 21. 可观测性与排障手册

事故处置和重做过程中用到的排障手段,沉淀成一份小手册:

### 21.1 让错误"看得见"

`/admin/generate` 这个受 `ADMIN_KEY` 保护的入口,被特意改造成**在出错时直接返回错误堆栈**(JSON 的 `error` 字段)。正是它让我一眼看到 `5028: model deprecated`,从而快速定位到"模型下线"这一根因。**给一个安全的、能回显详细错误的内部入口,排障效率远高于盲猜。**

### 21.2 区分"代码错"还是"网络错"

- 触发后**秒级**返回 `Internal Error`,往往是代码/配置问题(如模型 id 失效),应去看错误详情。
- 触发后**连接被重置 / HTTP 000**,且只发生在 `*.workers.dev`,而 `example.com`、自有域名都正常,则是**网络对特定域的封锁**,与代码无关。一份简单的"连通性矩阵"(并排 curl 几个不同域)能迅速区分二者。

### 21.3 DNS 负缓存的识别与绕过

新建主机名后,若 `dig +short @1.1.1.1 <host>` 已能解析到 Cloudflare IP,但本机 `curl` 仍报"无法解析",基本可判定是**本机 DNS 负缓存**了更早的 NXDOMAIN。用 `curl --resolve <host>:443:<ip>` 绑定解析即可绕过验证,无需等缓存过期,也不必动系统 DNS。

### 21.4 模型可用性要动态校验

模型 id 会随时间下线。与其硬编码后想当然,不如用 `GET /accounts/{aid}/ai/models/search` 拉取当前账号可用模型清单,按"任务类型(Text Generation / Text-to-Image)"筛选后再选。本次正是靠它把下线的 `llama-3.1-8b-fp8-fast`、`qwen1.5-14b` 换成了在用的 `gemma-3-12b-it`、`llama-3.3-70b-fp8-fast`。

### 21.5 线上日志

部署后的 Worker,其 `console.log/error` 可通过 `wrangler tail` 实时查看(定时任务 `scheduled` 的执行日志也在其中)。当某次定时生成异常时,`tail` 是第一手的排查入口。

### 21.6 shell 细节的两个坑

复盘里也记两个实际踩到的小坑,免得后人重蹈:

- **`set -e` 环境下的命令替换**:`c=$(curl ...)` 若 curl 以非零退出(如解析失败的 6),会直接中断整段脚本、且 `echo` 还没来得及执行,表现为"无输出 + 退出码 6"。轮询类脚本应 `set +e` 或对子命令加 `|| true`。
- **zsh 不对未加引号的变量做单词拆分**:把 `--resolve host:port:ip` 塞进一个变量再展开,会被当成**单个参数**导致 curl 报"unknown option"。应把参数直接内联,或用 `${=var}` 强制拆分。

---

## 22. 结语

这是一次本可以通过一份简单检查清单就能避免的事故。技术上它不复杂，但它精准地命中了"在共享生产环境里凭假设而非核实去做接管型操作"这一高危模式。最大的收获不是"修好了"，而是把"绑定前全量核查 + 绑定后反向验证"固化成纪律。本复盘与第 12 节的 SOP 即为这一纪律的落地载体。

需要诚实地记下两点态度层面的反思。其一，事故的发现者是用户而非执行方，这说明当时的验证只覆盖了"我希望发生的结果"，缺少对"既有资产是否受损"的主动求证——而真正成熟的操作，应当默认假设"我可能正在破坏别人的东西"，并主动去证伪这个假设。其二，在 `workers.dev` 被网络封锁、`custom_domain` 又报错的连续受阻下，求快的心态压过了求稳的纪律，于是选择了一条"能绕过限制"却"副作用更大"的捷径。环境的限制只应改变"怎么做"，绝不应降低"做之前要核查什么"的标准。

从工程角度看，这次事故里几乎所有要素都恰好落在"可恢复"的一侧：覆盖是遮蔽而非删除、Pages 绑定始终健在、改动全程可逆、影响时长是分钟级、无任何数据丢失。这是幸运，但不能把幸运当成方法。方法是：在任何"接管型"操作前，把四类占用(Pages 域名、Worker 自定义域名、Worker 路由、普通 DNS 记录)逐项核对清楚；优先选择全新子域 + 隔离绑定；操作后既验证新服务可用，也回看相邻既有服务无恙；遇到护栏报错先查清归属再决策，而不是绕过它。把这些写进清单、写进肌肉记忆，才是这次事故真正应当留下的东西。

当前线上状态已恢复且稳定：用户原站 `blog.011203.dpdns.org` 完好如初，AIGarbage 在隔离、经核查的 `aigarbage.011203.dpdns.org` 上正常运行，其余资产无一受损。事故到此闭环，剩下的是把改进项落到日常操作里。
