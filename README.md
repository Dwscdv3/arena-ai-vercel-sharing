# arena-ai-vercel-sharing

把 [arena.ai](https://arena.ai)（LMArena）上的对战对话保存下来，通过 Vercel 后端生成**公开可访问的匿名分享链接**：

- 访客打开链接看到的是「模型 A / 模型 B」的匿名对话，**默认隐藏模型名称**（与 arena.ai 一致）；
- 每一轮对话各自投票（A 更好 / B 更好 / 平局 / 两个都差），投完某一轮后该轮的真实模型名才会揭晓；
- 每一轮的投票都会单独计入存储，站点所有者可在 **`/admin.html`** 页面用 SHARE_TOKEN 查看每个轮次的明细与整场合计（含历史数据）；
- 创建分享链接的接口由 **SHARE_TOKEN** 保护，token 保存在用户脚本的本地存储（GM storage）中，**不进仓库**。

## 组成

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 油猴用户脚本 | `userscript/arena-ai-share.user.js` | 在 arena.ai 页面抓取当前对话（优先按每条消息旁的「复制」按钮定位消息容器，提示词与两侧回答都能抓到，通用选择器兜底），审核后 POST 给后端 |
| 后端 API | `api/` | Vercel serverless functions，零依赖，直接调用 Upstash/Vercel KV REST API |
| 分享页 | `public/share.html` | `share.html?id=<uuid>`，对话界面风格、黑白双主题（跟随 `prefers-color-scheme`）、无顶栏/无标题、Markdown 渲染；**每一轮对话下方各有独立投票区**（「哪个回答更好？」+ 4 个按钮），投完某一轮才在该轮回答栏头部揭晓模型名 |
| 管理页 | `public/admin.html` | `/admin.html`，token 登录后查看所有分享的投票统计，含**每一轮对话**的明细 |
| 首页 | `public/index.html` | 项目说明 |

## 架构

```
arena.ai 页面
   │  用户脚本抓取对话（可编辑审核）
   ▼
POST /api/shares   ← Authorization: Bearer <SHARE_TOKEN>
   │  写入 Vercel KV：share:<id>（对话 JSON）、shares:index（索引）
   ▼
{ url: "https://<your-app>/share.html?id=<uuid>" }
   │
   ▼
访客 GET /share.html?id=<id> ─► 分享页（纯对话界面）─► GET /api/share/<id>（模型名隐藏；若浏览器已对某轮投票则该轮揭晓 + 记录该轮票数）
   │
   ▼
POST /api/vote/<id> { choice: a|b|tie|bad, turn: <轮次下标，从 0 开始> }  ← 该轮计票写入 votes:<id>（含全场总票数与 per-turn 明细），下发 voted_<id>_<turn>=1 cookie 并揭晓该轮模型名
   │
   ▼
GET /api/admin/votes  ← Bearer <SHARE_TOKEN>，/admin.html 页面渲染统计
```

## 部署步骤（已在你的账号中创建好的资源）

1. **GitHub 仓库**：本仓库 `Dwscdv3/arena-ai-vercel-sharing`（公开）。
2. **Vercel 项目**：`arena-blind-share`（team: Jingyao，outputDirectory: `public`，framework: Other）。
3. **KV 数据库**：已关联到 `arena-blind-share`（Vercel 集成自动注入了 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 等环境变量，代码对 Upstash 直接集成注入的 `UPSTASH_REDIS_REST_*` 命名也兼容）。
4. **SHARE_TOKEN**：已由部署流程设置为项目环境变量（encrypted）。用户脚本首次使用前，在油猴菜单里设置同一个 token（见下）。
5. **关闭部署保护**（你选择的公开访问方案）：Vercel Dashboard → `arena-blind-share` → Settings → Deployment Protection → 关闭 / 调整为「仅预览」。否则 `*.vercel.app` 链接需要 Vercel 登录才能访问，外人打不开。

> 注意：环境变量修改后需要**重新部署**才生效。创建并关联 KV、改完部署保护后，在 Vercel 里点一次 Redeploy，或让我重新部署。


## 部署说明（2026-11-20 首次部署的取舍）

- 线上地址：<https://arena-blind-share.vercel.app>（部署 ID `dpl_F43BQAJrvDUSjHjirhNZGC7dG4XF`，READY，别名 `arena-blind-share-jingyao.vercel.app`）。
- 部署通过 Vercel API 直接上传文件（而非 Git 集成）完成，因为当前 Vercel 账号**未连接 GitHub**；如需 `git push` 自动部署，可在 Vercel Dashboard → `arena-blind-share` → Settings → Git 连接 `Dwscdv3/arena-ai-vercel-sharing`。
- 本仓库因此**不使用 `vercel.json`**（上传部署不支持顶层 JSON 配置）；项目框架预设为 `vite`、buildCommand 为 `echo skip`（无需构建，静态文件直接来自 `public/`），分享链接形如 `/share.html?id=<uuid>`、管理页为 `/admin.html`。本地 `vercel dev` / Git 部署同样可用这两个地址。如需 `/s/<uuid>` 美观路径，连上 GitHub 后重新加入 `vercel.json` rewrites 即可。
- 因此 API 响应头里也没有额外的安全响应头；函数本身带有 `Cache-Control: no-store`。
- KV 未创建时 API 返回 `503 STORAGE_NOT_CONFIGURED`；SHARE_TOKEN 未配置时创建接口返回 500。

## 安装用户脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Firefox / Edge）。
2. 打开本脚本：`userscript/arena-ai-share.user.js`（raw 链接：<https://raw.githubusercontent.com/Dwscdv3/arena-ai-vercel-sharing/main/userscript/arena-ai-share.user.js>），Tampermonkey 会提示安装。
3. 在 arena.ai 页面打开油猴菜单：
   - **设置 SHARE_TOKEN**：粘贴你的 token（只存在你本机的 GM 存储里）；
   - （可选）**设置 API 地址**：默认为 `https://arena-blind-share.vercel.app`，如部署域名不同请修改。
4. 页面右下角会出现「分享对话」按钮：抓取 → 审核 JSON（可手动修正）→ 生成链接 → 复制 / 打开。

## 使用

1. 在 arena.ai 打一场 battle，回答生成完毕后点右下角「分享对话」。
2. 检查抓取结果（抓取优先以复制按钮为锚点定位每条消息；arena.ai 的 DOM 会变化，抓不准就手动编辑 JSON；模型名可删掉保持匿名）。
3. 点「生成分享链接」，把 `/share.html?id=<uuid>` 链接发出去。
4. 访客对每一轮分别投票后，才能看到对应轮的模型名；你自己在 `/admin.html` 输入 SHARE_TOKEN 查看每条分享的分轮次 A/B/平局/都差票数与整场合计。

## API

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/shares` | `Bearer SHARE_TOKEN` | 创建分享，返回 `{ id, url, created_at }` |
| GET | `/api/share/<id>` | 无 | 返回对话；每轮模型名仅在该轮投过票后随该轮返回（`turns[].models`），全场前 `models: null`；`voted_turns` 列出已投票的轮次，`turn_tallies` 为分轮票数 |
| POST | `/api/vote/<id>` | 无（同浏览器逐轮防重复计票 cookie） | body: `{"choice":"a\|b\|tie\|bad","turn":<轮次,从0开始>}`，返回揭晓后的模型 + 该轮票数 |
| GET | `/api/admin/votes` | `Bearer SHARE_TOKEN` | 所有分享的投票统计：每轮次明细 + 整场合计（`/admin.html` 页面使用） |

存储键：`share:<id>`（分享 JSON，含所有轮次的 prompt 与两侧回答）、`votes:<id>`（`{a,b,tie,bad, turns:{ "<轮次>": {a,b,tie,bad} }}`；平铺字段为全场总票数，`turns` 为分轮明细；旧数据没有 `turns` 字段，会被兼容读取）、`shares:index`（管理索引，最多 1000 条）。投票防重复 cookie：`voted_<id>_<轮次>`（旧版为 `voted_<id>`，读取时会视为所有轮次已投）。

## 安全说明

- `SHARE_TOKEN` 只通过环境变量和 GM 存储存在，仓库里没有任何真实 token（`.env*` 已 gitignore，`.env.example` 只有占位符）。
- 模型名在服务端按「该浏览器是否已投过该轮」决定是否返回：每轮模型名（`turns[].models`， arena.ai 每轮模型对可能不同）仅在该轮已投票时随该轮返回，未投票的轮次为 `null`；旧版分享没有每轮模型名，则投过任意一轮后整场 `models` 解锁。
- 投票接口不要求登录（和公开投票一致），防重复计票依赖浏览器 cookie，可被清除绕过——如需强防刷，建议加验证码或登录。
- `/admin.html` 使用 `crypto.timingSafeEqual` 比较 token。

## 已知限制

- arena.ai 是单页应用且 DOM 结构不定期变更，自动抓取是尽力而为的启发式方案；审核弹窗支持手动修正 / 手动粘贴 JSON，兜底可用。
- Vercel Hobby 计划无持久文件系统，必须依赖 KV（或兼容 Upstash REST 的任何 Redis）。
- KV 未创建 / 未关联时，API 会返回 `503 STORAGE_NOT_CONFIGURED`，前端会提示原因。

## 本地开发

```bash
cp .env.example .env   # 填入真实值（不要提交）
npm i -g vercel
vercel dev
```

## License

MIT
