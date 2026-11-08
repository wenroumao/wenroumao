# 本地后台控制台实施方案

## 结论（先看这里）

本站的部署链路是：**本地 `hexo generate` → 把 `public/` 推到 Pages 仓库 → Vercel 托管那份产物**（见 `scripts/vercel-api-copy.js` 顶部注释）。源码仓库本身不跑在 Vercel 上，所以 Vercel 那边没有可写的源码目录，纯 Serverless 无法“改文件再发布”。

因此后台做成 **本地管理端**：随 `hexo server` 一起启动，只监听本机，登录后在网页里改 `source/_posts/` 与两份站点配置，保存后由后台调用 `hexo generate`（可选再调用 `hexo deploy`）。不引入新的服务、不新增依赖、不改主题。

## 已核实的仓库现状

- 启动方式：`start-blog.cmd` → `hexo server -p 4000`。
- 内容：`source/_posts/*.md`，front matter 为扁平字段 + `categories` / `tags` 列表。
- 配置：`_config.yml`（站点）、根目录 `_config.fomalhaut.yml`（主题，覆盖 `themes/fomalhaut/_config.yml`）。
- 现有服务端只有 AI 代理：`api/chat/completions.js`（Vercel）与 `functions/api/chat/completions.js`（Cloudflare Pages），均从环境变量读 Key。
- Hexo 6.3 / hexo-server 支持 `server_middleware` 过滤器，可在 `hexo server` 上挂自己的路由，适合做本地后台。
- Git 远端是主题上游仓库，部署目标仍是占位符（`yourname.github.io`），所以“发布”默认只生成本地 `public/`，推送需显式开启。

## 方案

### 认证与会话

- 单管理员。账号密码来自环境变量 `ADMIN_USER` / `ADMIN_PASSWORD`；也支持 Git 忽略的 `.admin-auth`（`KEY=VALUE` 两行），方便 Windows 本地启动。
- 登录成功后发 `HttpOnly` + `SameSite=Strict` 的随机会话 Cookie，进程内保存，8 小时过期；改状态接口再校验 `X-CSRF-Token` 与同源 `Origin`。
- 登录失败按 IP 限流；密码比较用 SHA-256 后 `timingSafeEqual`，不做明文直接比较。
- 默认只允许 loopback 访问；`ADMIN_ALLOW_LAN=1` 才放行局域网（不推荐）。

### 可编辑范围

- 文章：`source/_posts/` 下的 `.md`，列表 / 新建 / 读取 / 保存 / 删除；路径做穿越校验，只允许该目录内的 `.md`。
- 配置：白名单字段，逐行补丁，保留注释与未改动内容：
  - `_config.yml`：title、subtitle、description、keywords、author、language、url。
  - `_config.fomalhaut.yml`：avatar.img、index_img、default_top_img、footer.owner.since、footer.custom_text、preloader.enable、subtitle.enable、subtitle.effect、subtitle.sub、ai_chat.enable、ai_chat.model。
- 保存前把原文件备份到 `bak/admin/<时间戳>/`（`bak/` 已在 .gitignore）。

### 发布

- 保存文章 / 配置后自动执行 `hexo generate`（可用 `ADMIN_AUTO_GENERATE=0` 关闭）；同一时间只有一个构建任务，连续保存会合并成一次待生成。
- “生成站点”：`node node_modules/hexo/bin/hexo generate`，日志实时回传页面。
- “生成并推送”：**显式配置驱动**，只认 `.admin-deploy.json`（或 `ADMIN_DEPLOY_*` 环境变量）里的仓库 + 分支 + 开关，不读 `_config.yml` 的 deploy，也不回落到仓库现有 remote。
  - 当前目标：`git@github.com:wenroumao/wenroumao.git`，分支 `main`，开关开启。
  - 推送前校验：不是主题上游、不是源码仓库 remote；`git ls-remote` 能连通；目标分支是否存在。失败直接显示原因。
  - 生成后把 `public/` 同步到 `.deploy_git/`，再 `git push <显式 URL> HEAD:refs/heads/<branch> --force`。
  - 永不自动推送，必须在界面点击并二次确认。

### 安全与部署约束

- 后台页面只从 `tools/admin/ui/` 读取，**不会**进入 `public/`，也就不会随站点发布。
- 所有响应带 CSP、`nosniff`、`no-store`；不引入第三方 CDN。
- 环境变量不写进前端页面、不提交仓库；`.admin-auth` 加入 `.gitignore`。
- 远程（Vercel / Pages）没有后台。需要远程管理时，必须改成“GitHub API 提交 + Vercel Deploy Hook”模式，这属于另一个方案。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `tools/admin/core.js` | 纯函数：读取管理员配置、安全比较、front matter 解析/补丁、YAML 路径读写、路径校验 |
| `tools/admin/deploy.js` | 显式部署配置、远端守卫、`git ls-remote` 预检、`public/` → `.deploy_git` → 显式 push |
| `tools/admin/server.js` | connect 中间件：路由、会话、CSRF、静态页面、文章/配置/发布 API |
| `tools/admin/ui/index.html` | 后台骨架（四个视图 + 弹窗 + 提示条） |
| `tools/admin/ui/style.css` | 界面样式（纸墨编辑部风格、中文、浅/深色、移动端、reduced-motion） |
| `tools/admin/ui/app.js` | 登录、文章列表/筛选/快捷删除、编辑与实时预览、配置、发布轮询 |
| `tools/admin/ui/preview.html` | 预览 iframe 骨架，结构与主题 `post.pug` 对齐 |
| `tools/admin/ui/preview.css` | 预览页最小适配（不改正文排版，排版全部来自站点样式） |
| `tools/admin/ui/preview.js` | 预览页消息协议：渲染、主题、滚动同步 |
| `scripts/admin-server.js` | 注册 `server_middleware`，仅在 `hexo server` 时挂载 |
| `tools/tests/admin.test.cjs` | node:test 单元 + HTTP 集成测试 |
| `README.md` | 增加“本地后台”一节，写清环境变量 |

## 实施任务

1. `core.js`：认证配置、front matter、YAML 补丁、路径校验；先写测试。
2. `server.js`：API 与静态资源；注入式 `runBuild` 便于测试。
3. UI：登录 / 文章 / 配置 / 发布四个视图。
4. `scripts/admin-server.js` 接入；`.gitignore` 增加 `.admin-auth`；README 补说明。
5. 验证：`node --test tools/tests/admin.test.cjs`、`node -c` 语法检查、启动 `hexo server` 实测登录与保存。

## 已确认的取舍

1. 托管平台：本地生成 + 产物推送；后台只在本机随 `hexo server` 运行。远程 Vercel 后台不在本次范围。
2. 账号来源：单个管理员、环境变量或 `.admin-auth`；不做注册、多人、角色。
3. 可改范围：文章 + 上面白名单配置；不开放任意文件编辑。
4. 发布动作：保存后自动生成；推送独立开关 + 手动确认，推送目标 `git@github.com:wenroumao/wenroumao.git` / `main`。

## 第二阶段：界面改版与编辑体验（已完成）

- **界面**：纸墨编辑部风格，宋体标题 + 中文文案，浅/深色切换、移动端断点、`prefers-reduced-motion`。四视图（文章 / 编辑 / 配置 / 生成与推送）与统一弹窗、Toast。
- **列表**：标题 / 文件名 / 摘要 / 分类 / 标签的即时搜索，已发布 / 草稿筛选，计数；行内「编辑 / 删除」，删除走二次确认，成功后刷新列表并触发自动生成。
- **草稿语义**：用 front matter `published: false`，不新建 `_drafts/` 目录。列表与筛选据此区分；改回发布时删除该键。
- **编辑**：编辑 / 分屏 / 预览三档；`Ctrl/Cmd+S` 保存；未保存时离开视图、关闭页面都会提示。
- **实时预览**：iframe 指向 `/admin/preview`，直接引用站点自己的 `/css/index.css`，正文容器与主题 `post.pug` 一致（`#content-inner > #post > article#article-container.post-content`）。代码块在服务端复用 hexo 内置 `backtick_code_block`，输出与前台相同的 `<figure class="highlight js">`。编辑区与预览区双向滚动同步。
- **安全调整**：预览页允许同源嵌入（`X-Frame-Options: SAMEORIGIN`、`frame-ancestors 'self'`），其余后台页面仍为 `DENY` / `'none'`；预览页不使用内联脚本/样式，保持 `script-src 'self'`、`style-src 'self'`。
- **未新增任何第三方依赖**：没有引入所见即所得编辑器。完整 WYSIWYG 需要第三方编辑器（如 Vditor / ProseMirror）并改写存储格式，属于较大改造，暂不做。

### 预览的已知边界

- Butterfly 外挂标签（`{% note %}`、`{% tabs %}`、`{% gallery %}` 等）在预览里不会求值，显示为原始文本；前台由 Hexo 标签插件渲染。要完全一致需在预览链路里执行标签插件，会带来副作用风险，暂不做。
- 预览读取的是**已生成**的 `public/css/index.css`。改主题 `.styl` 后需要重新生成，预览样式才会更新。
- 预览只渲染正文，不包含文章头图、目录、版权、上下篇等外围模块。

## 环境限制

- 当前执行环境里 `gh` CLI 不存在、也没有可用的 GitHub SSH Key / 外网访问，无法用 `gh repo view` 或 `git ls-remote` 实际验证 `wenroumao/wenroumao` 与 `main` 分支。代码里的预检会在用户本机执行，并给出明确失败原因；验收前请确认本机 SSH Key 已添加到 GitHub。
- 分支暂按 `main`；如果该仓库 Pages 用的是别的分支，请在后台「生成与推送」里改。
