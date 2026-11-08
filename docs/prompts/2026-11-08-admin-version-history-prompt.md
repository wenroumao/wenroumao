# 后台版本历史与一键回退 · 提示词

> 用法：整段复制给你的编码 Agent（Trae / Cursor / Claude Code 等）。它已经把仓库现状、接口风格、约束和验收口径都写死了，能让 AI 少猜、少改无关文件。

---

## 一、精简版（想在对话框里快速贴）

给本站本地后台加「修改留痕 + 一键回退」：每次新建/保存/删除文章、保存配置、改部署配置，都要在 `bak/admin/revisions/` 下留一条带时间戳的版本记录（含内容哈希、变更行数、动作类型）；后台新增「历史」视图和 `/admin/api/revisions` 系列接口，能按文章筛选、按时间倒序、看旧→新 diff；点「回退到这一版」二次确认后恢复文件内容，回退本身也生成新版本（可再回退），并自动重新生成站点。要求：不新增第三方依赖、不改认证方式、不改主题、历史数据不进 `public/`、路径必须走现有白名单校验。

---

## 二、完整版（推荐）

### 任务
在 Hexo 本地后台里增加「版本历史（revision history）」能力：**任何一次内容提交都能在后台查到，能看改了什么，能一键回退到任意历史版本**。回退本身也必须是一个可回退的动作。

### 先确认现状（不要重新发明）
项目根：`J:\hexo-blog-wenroumao`，Hexo 6.3 + 自建本地后台。

- 后台挂载：`scripts/admin-server.js` 注册 `server_middleware`，仅在 `hexo server` 时生效；实际逻辑在 `tools/admin/server.js`。
- 路由前缀：页面 `/admin/*`，接口 `/admin/api/*`；统一 JSON 风格 `{ ok: true, ... }`，失败走现有的 `fail(res, code, msg)`。
- 已有接口：`POST /admin/api/login|logout`；`GET|POST /admin/api/posts`；`GET|PUT|DELETE /admin/api/posts/<urlencoded rel>`；`POST /admin/api/preview`；`PUT /admin/api/config`；`POST /admin/api/features`；`PUT /admin/api/deploy`；`POST /admin/api/publish`。
- 鉴权：HttpOnly 会话 Cookie + 写操作校验 `X-CSRF-Token` 与同源 `Origin`，默认只监听 loopback。
- 可写范围：`source/_posts/*.md`；`_config.yml` 与 `_config.fomalhaut.yml` 的白名单字段。路径校验已在 `tools/admin/core.js` 里，必须复用，不要新增文件系统入口。
- 已有备份（本次要升级的就是它）：`core.backupFile()` 在写盘前把整文件复制到 `bak/admin/<时间戳>/<相对路径>`。`bak/` 已在 `.gitignore`，且不会进 `public/`。
- 现有测试：`node --test tools/tests/admin.test.cjs`；目标实现也必须有测试覆盖。

### 功能需求（按验收口径写）

1. **留痕范围**：文章新建、文章保存、文章删除、配置保存、部署配置保存，每次成功写盘都要产生一条 revision（同一次请求里改了多个配置字段算一条）。
2. **记录内容**：`id`（时间戳+随机后缀，字典序即时间序）、`at`（ISO 时间）、`action`（create / update / delete / config / deploy）、`target`（post / config / deploy）、`path`（相对路径）、`bytes`、`sha256`、`stats`（`+n / -m` 行，配置类为「改了哪几个字段」）、可选 `note`、`restoreOf`（若由回退产生，指向被回退的 revision id）。
3. **可查**：后台新增「历史」视图，支持按目标文件筛选、按时间倒序、分页或限制条数（默认 50）；每行展示时间、动作徽章、文件名/字段名、`+/-` 行数、大小。
4. **可看差异**：点开某条记录看旧→新 diff（行级红绿；配置类按「字段 → 旧值 / 新值」表格展示，不按行 diff）。
5. **一键回退**：每条记录右侧「回退到这一版」→ 二次确认（文案写明「当前内容会先另存为一个新版本，可再回退」）→ 写入旧内容 → 以 `action: restore`、`restoreOf: <该 id>` 新增一条 revision → 触发一次自动 `hexo generate`。
6. **删除可恢复**：删除文章时把内容快照一起存进 revision；历史里对 delete 记录提供「恢复这篇文章」，等于重建文件。
7. **幂等与容量**：内容 `sha256` 与同一 `path` 的上一条记录相同则不新增记录（避免空保存刷屏）；每个 path 默认保留最近 200 条，超限按时间清理并在索引里保留一条 `{ purged: true }` 占位，UI 显示「已清理，仅剩记录」。
8. **安全**：历史接口 `Cache-Control: no-store`；回退路径必须经过现有路径校验（防目录穿越）；历史数据只写 `bak/`，不得写入 `public/`、不得注入前端 HTML。

### 建议实现（按文件落点，允许微调但保持结构）

- `tools/admin/core.js`
  - `hashText(text)`：`crypto.createHash('sha256')`。
  - `revisionsDir(baseDir)` → `bak/admin/revisions/`；索引 `index.json`，快照正文另存 `files/<sha256>.md`（同内容多版本共用一份文件，天然去重；配置类快照同样按 sha256 存文本）。
  - `appendRevision(baseDir, entry)`：读索引 → 去重判断 → 追加 → 原子写回（先写 `index.json.tmp` 再 `fs.rename`），索引超过上限时裁剪最旧项。
  - `listRevisions(baseDir, { path, limit })`、`readRevision(baseDir, id)`（返回索引项 + 旧文本 + 新文本，新文本按 id 时刻的当前内容取，取不到就留空）。
  - `restoreRevision(baseDir, id)`：校验目标仍在白名单内 → 写回旧文本 → 追加 restore 记录。
  - `diffLines(oldText, newText)`：纯手写行级 diff（LCS 或按行对比+简单上下文），返回 `[{ type: 'add' | 'del' | 'same', text }]`，不引入 diff 库。
  - 保留 `backupFile()` 原有行为，`appendRevision` 在其内部或调用处衔接，避免两套备份语义打架。
- `tools/admin/server.js`
  - `GET /admin/api/revisions`（查询参数 `path`、`action`、`limit`）→ `{ revisions: [...] }`。
  - `GET /admin/api/revisions/<id>` → `{ revision, diff, oldText, newText }`。
  - `POST /admin/api/revisions/<id>/restore` → 走 `requireSession(req, res, true)`（含 CSRF）→ 恢复 → `scheduleAutoGenerate()` → `{ ok: true, build }`。
  - 在 `createPost` / `updatePost` / `deletePost` / 配置保存 / 部署配置保存的成功分支里各调一次 `appendRevision`，不要散落在多处各写一套。
- `tools/admin/ui/app.js` + `index.html` + `style.css`
  - 新增第五个视图「历史」，或在文章编辑页右上角加「历史」抽屉（两处入口都可，数据同源）。
  - 行内操作：`查看差异`、`回退`（危险色，二次确认弹窗复用现有 modal）、delete 记录额外 `恢复`。
  - diff 渲染只做 `<pre>` 行级着色，不做语法高亮、不引三方库；无障碍与 `prefers-reduced-motion` 跟现有风格一致。
- `tools/tests/admin.test.cjs`
  - 必须覆盖：连续保存两次产生两条记录；同内容保存被去重；回退后文件内容等于旧文本且新增一条 `restore` 记录；删除后可重建；非法路径回退被拒；缺 CSRF 的回退被拒；超过保留条数被裁剪。

### 明确不做（避免跑偏）
- 不做多人协作 / 角色权限 / 审核流。
- 不与 git 提交历史混用（若要展示 `git log`，只做只读展示，不参与回退逻辑）。
- 不引入任何第三方依赖（含 diff、编辑器、数据库）；不把索引换成 SQLite/JSONL 之外的方案。
- 不改认证方式、不改现有接口返回结构、不改主题、不把后台页面写进 `public/`。
- 不做图片/二进制文件的版本（只处理 `.md` 与两份 YAML）。

### 交付与自检
1. 给出改动文件清单和每个文件的主要改动点。
2. `node --test tools/tests/admin.test.cjs` 全绿；对改动文件跑 `node -c` 或 `node --check`。
3. 手工验收路径：启动 `hexo server` → 改一篇文章保存 → 历史里出现记录 → 看 diff → 回退 → 前台内容变回旧版 → 再回退一次能回到「回退前」。
4. 说明 `bak/admin/revisions/` 的增长速度与清理策略，确认不会写进 `public/` 和 git。
