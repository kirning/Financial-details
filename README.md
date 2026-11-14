# 南丰村财务 · 账本系统

```
南丰村财务/
├── server/                Koa + SQLite 后端（Node ≥ 22.5，TypeScript）
│   ├── index.ts           HTTP 服务 + 静态托管（默认 127.0.0.1:7300）
│   ├── db.ts              SQLite 数据层（内置 node:sqlite，免原生编译）
│   ├── cli.ts             命令行记账（直接写库，不经 HTTP）
│   ├── scripts/fix-links.mjs  pnpm 链接修复（本机 junction 权限受限时的兜底）
│   └── dist/              ★ tsc 编译产物（实际运行的是它，勿手改）
├── web/                   ★前端：Vite + React 18 + TypeScript + Tailwind
│   ├── src/
│   │   ├── App.tsx            页面编排、全局状态、快捷键
│   │   ├── lib/types.ts       接口类型定义
│   │   ├── lib/api.ts         fetch 封装（统一错误提示）
│   │   ├── components/        ui / Panels / VoucherTable / VoucherViewer /
│   │   │                      VoucherForm / TodoPanel
│   │   └── styles/index.css   Tailwind 入口 + 少量自定义工具类
│   ├── scripts/fix-links.mjs pnpm 链接修复（本机 junction 权限受限时的兜底）
│   └── dist/                   生产产物（由 Koa 在 /app/ 下托管）
├── data/
│   └── ledger.db          ★唯一数据源（SQLite）
├── 凭证/                   ★原始证据：凭证图片 + SHA256SUMS.txt（按凭证号分目录）
├── 收件箱/                 新账单暂存队列 _QUEUE.md（先落盘、后处理）
├── 明细分析.md             ★人工手写的业务解读（analyses 表为空，库里没有，勿删）
├── 启动账本.bat            ★双击即启动服务并打开页面（Windows）
├── AGENTS.md              记账规范 / 目录速查
└── _归档/                 历史文档 + OCR 中间图，非数据源，可随时清空
```

> 全盘**只有这一份账**。`D:/Users/wuxw32.CN/WorkBuddy/南丰村财务` 那个同名空目录
> 已于 2026-11-09 删除。数据来源判定详见 `AGENTS.md` 的「数据到底在哪」。

## 启动

### 日常使用（Windows 双击）

双击根目录的 **`启动账本.bat`**：自动检测 7300，未启动则最小化拉起服务，
然后打开 `http://127.0.0.1:7300`。关掉那个最小化的 `NanfengLedger` 窗口即停服务。
> 服务**不是常驻**的；页面只有 `web/dist/` 这一套，靠 `fetch('/api/...')` 取数，后端停了就打不开。
> 旧版 `账本.html` 及 `assets/` 已于 2026-11-10 移入 `_归档/历史版本/`，`LEGACY` 兜底代码同步移除。

### 命令行（一条命令）

```bash
cd 南丰村财务/server
npm start        # → http://127.0.0.1:7300
```

后端会直接托管 `web/dist` 的 React 生产包，**打开 <http://127.0.0.1:7300> 即是完整页面**。
页面数据全部来自后端接口，改一笔账刷新即变。

> 若改了 `server/*.ts`，需先 `pnpm build`（或 `pnpm dev` 同时跑 tsc --watch），
> **运行的是 `dist/` 里的编译产物，不是 .ts 本身**。

### 后端开发（TypeScript）

```bash
cd 南丰村财务/server
pnpm install          # 首次
pnpm build            # tsc → dist/
pnpm typecheck        # 只查类型，不产出
pnpm dev              # tsc --watch + node --watch dist/index.js
```

类型定义：`db.ts` 里导出了全部接口类型（`Voucher` `VoucherInput` `Account` `Todos` …），
路由层通过 `import type { ... } from './db.js'` 复用，前后端字段名一一对应。

### 前端开发（热更新）

```bash
# 终端 1：后端
cd 南丰村财务/server && npm start

# 终端 2：Vite dev server
cd 南丰村财务/web
pnpm install       # 首次
pnpm dev           # → http://127.0.0.1:7301
```

Vite 会把 `/api`、`/凭证`、`/assets` 转发到 7300。

### 构建生产包

```bash
cd 南丰村财务/web && pnpm build      # 产物在 web/dist，base=/app/
```

> **Node 版本要求 ≥ 22.5**（后端用内置 `node:sqlite`，无需编译原生模块）。
> 后端依赖仅 3 个：`koa` `@koa/router` `koa-bodyparser`。
> 前端用 **pnpm**（npm 在本机会被 `fsevents` 的 arborist bug 卡住）。

### 版本号

版本号单一来源是根目录 `VERSION`（`x.y.z`），**每次改动代码后、提交前**递增：

```bash
cd server
npm run bump              # patch +1（bug / 文案）
npm run bump -- --minor   # minor +1（新功能、新工具）
npm run bump -- --major   # major +1（破坏性变更）
```

脚本 `scripts/bump-version.mjs` 同时写回 `server/package.json` 与 `web/package.json`。
版本号出现在三处：`GET /api/health` 的 `version`、MCP `GET /health` 的 `version`
（也是 MCP `serverInfo.version`）、页面右上角 `vX.Y.Z` 角标（Vite 构建期注入，
**改完必须重新 `pnpm build`**）。只改文档不 bump。

## 前端：Vite + React + TypeScript

**依赖**：React 18 + Tailwind（自定义暗色原子类）、**antd 5.29.3**（UI 组件）、
**echarts 5.6.0**（图表）、`@ant-design/cssinjs 1.23.0`（样式上下文）。
入口 `src/main.tsx` 用 `ConfigProvider theme.darkAlgorithm` + `StyleProvider hashPriority="high"`
把 antd 融进现有暗色主题，后者用于避免 Tailwind preflight 覆盖 antd 的 CSS-in-JS 样式。

> **图表约定（2026-11-10 起）**：所有统计图表统一用 echarts，且统一走
> `src/components/EChart.tsx`（已注册 `nanfeng-dark` 暗色主题、自动 resize / dispose、支持点击钻取）。
> 新增图表类型在该文件的 `echarts.use([...])` 追加注册，不要在 option 里重复写暗色样式。
> 示例：`Panels.tsx` 的 `MonthlyChart`（收支柱状 / 净额折线 + antd `Segmented` 切换）。
> 新增 UI 控件优先用 antd。依赖版本务必写精确值，详见 `AGENTS.md`「前端 UI 与图表框架」。

构建产物按 `vendor-react` / `vendor-antd` / `vendor-echarts` 拆包（`vite.config.ts` 的
`manualChunks`），后续新增统计图只改主包，约 40 KB。

| 文件 | 职责 |
|------|------|
| `App.tsx` | 页面编排：取数、筛选/排序状态、弹窗状态、快捷键（`/` 搜索、`n` 新增） |
| `lib/types.ts` | 全部接口类型（`Voucher` `Summary` `Todo` …），后端字段一一对应 |
| `lib/api.ts` | `api()` 封装，失败时抛中文错误给 toast |
| `components/ui.tsx` | `Modal` `Money` `Badge` `Button` 等基础件 |
| `components/Panels.tsx` | 卡片组、月度收支趋势图、账户余额表、稳定序列表 |
| `components/VoucherTable.tsx` | 明细表：7 列可排序、筛选、行高亮、跳转定位 |
| `components/VoucherViewer.tsx` | 凭证查看器：缩略图列、**旋转**、键盘 ←→ |
| `components/VoucherForm.tsx` | 记一笔/编辑：类型 Radio、凭证号只读预览、科目 datalist、拖拽/粘贴上传 |
| `components/TodoPanel.tsx` | 待办与缺口，点凭证号可跳转并打开查看器 |

### 开发代理为什么自己写

`server.proxy` 的 key 只按**字符串前缀**匹配，写 `'/凭证'` 不生效——凭证图片请求会被
当成 SPA 路由返回 `index.html`，表现为图片 `naturalWidth = 0`。`vite.config.ts` 里改用
Node 原生 `http` 转发 + 正则 `^/(api|凭证|assets)(\/|$)`，同时先 `decodeURIComponent` 再判断。

### 凭证旋转的实现

容器按**原图宽高比**（`onLoad` 读 `naturalWidth/naturalHeight`）预留空间，
旋转 90°/270° 时宽高互换（`1/ratio`），避免图片被压扁或裁切。切换图片自动复位 0°。

## 记一笔

**方式 A：网页上记** —— 打开页面点右上角「+ 记一笔」。

**方式 B：命令行**（更快，适合让我批量处理）

```bash
cd 南丰村财务/server
node dist/cli.js add --date 2026-06-25 --period 2026-06 --type 支出 \
  --amount 1250.00 --subject "清理隔油池" --account wx \
  --party "高邮疏通" --summary "清理隔油池服务费" \
  --kind 收款收据 --files "D:/path/收据.jpg" --note "用户原话"
```

| 参数 | 说明 |
|------|------|
| `--period` | **凭证号所属期** `YYYY-MM`，决定凭证号 |
| `--amount` | 传**正数**，支出自动记负 |
| `--account` | `wx` 微信零钱 / `ab` 农行6316 / `icbc` 工行3779 |
| `--files` | 凭证图路径，多张用 `\|` 分隔 |
| `--kind` | 凭证类型词，用于文件名（如 `收款收据`、`支出证明单`） |
| `--note` | 用户原话；含「无支付凭证」会自动进待办 |

其他命令：

```bash
node dist/cli.js attach --vno NF-2026-09-005 --files "补的转账单.jpg"   # 补凭证图
node dist/cli.js verify      # 校验所有凭证 SHA256
node dist/cli.js report      # 汇总报表
node dist/cli.js export-csv  # 按需生成 流水.csv（根目录默认不保留）
node dist/cli.js minio-status   # MinIO 存储状态
node dist/cli.js minio-sync     # 幂等同步 凭证/ 全部文件到 MinIO
node dist/cli.js minio-verify   # 全量回读远端对象比对 SHA256
```

## MCP 服务（Streamable HTTP）

`server/mcp.ts` 提供基于 HTTP 的 MCP 服务，随后端一起启动，默认
`http://127.0.0.1:7302/mcp`（健康检查 `/health`）。**与 Web 共用同一进程和同一个 SQLite 连接**。

工具 = 明细 CRUD + 凭证附件 + 待办缺口 + 一致性校验 + 整库备份/还原（共 14 个）。
页面上的统计全部由明细实时计算，无需单独统计工具：

| 工具 | 说明 |
|---|---|
| `ledger_list_vouchers` / `ledger_get_voucher` | 条件查询 / 单笔查询 |
| `ledger_create_voucher` / `ledger_update_voucher` | 新增 / 局部修改 |
| `ledger_delete_voucher` | 删除（需 `confirm: true`） |
| `ledger_attach_file` | 传凭证附件（base64 ≤ 8 MB）→ MinIO + 本地镜像 + `attachments` 表 + 刷新 `SHA256SUMS.txt` |
| `ledger_list_attachments` / `ledger_get_attachment` | 列附件（含本地/远端大小对比）/ 读回 base64 |
| `ledger_delete_attachment` | 删附件（需 `confirm: true`，连带清 MinIO 对象） |
| `ledger_todos` | 待办与缺口（缺月、缺凭证、待核、负账户） |
| `ledger_verify` | 校验各凭证目录 `SHA256SUMS.txt` 与实际文件哈希 |
| `ledger_backup_db` / `ledger_list_backups` | 备份 SQLite 到 MinIO `backups/`（VACUUM INTO + SHA256 回读校验）/ 列出备份 |
| `ledger_restore_db` | 从备份还原（需 `confirm: true`；自动预备份 + 本地留底 + 完整性校验） |

配置见 `server/.env.example`：`MCP_PORT` / `MCP_HOST` / `MCP_TOKEN`。
默认只监听本机、不鉴权；远程暴露**必须**设置 `MCP_TOKEN`。
WorkBuddy 客户端配置示例：
```json
{"mcpServers":{"nanfeng-ledger":{"url":"http://127.0.0.1:7302/mcp"}}}
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/storage/status` | MinIO 凭证存储状态（对象数，不含密钥） |
| GET | `/api/vouchers?period=&type=&acc=&from=&to=&q=` | 流水列表（筛选/搜索） |
| GET | `/api/vouchers/:vno` | 单笔详情 |
| POST | `/api/vouchers` | 新增（凭证号可省略，自动分配） |
| PATCH | `/api/vouchers/:vno` | 修改 |
| DELETE | `/api/vouchers/:vno` | 删除（图片文件保留在磁盘） |
| PATCH | `/api/vouchers/:vno/nopay` | 标记缺/不缺支付凭证 |
| POST | `/api/vouchers/:vno/attachments` | 上传凭证图（base64，自动算 SHA256） |
| GET | `/api/summary?from=YYYY-MM&to=YYYY-MM&basis=belong\|date` | **页面主接口**：余额+月度+结构+序列+待办；收支结构按区间与标签聚合，不传参数=全量 |
| GET | `/api/structure/vouchers?tag=&from=&to=&basis=` | 某统计标签在区间内的合并明细（结构钻取一级弹窗） |
| GET | `/api/monthly` `/api/balances` `/api/todos` `/api/accounts` | 分项查询 |
| GET/POST/DELETE | `/api/analyses[/:id]` | 业务解读 |
| PATCH | `/api/accounts/:code/opening` | 设置期初余额 |
| GET | `/api/admin/verify` | 全量校验凭证 |
| POST | `/api/admin/migrate` | 兼容旧迁移入口；源 CSV 已清理，现为空操作 |

### 统计标签（2026-11-10 起）

流水明细有独立 `tag` 字段，**`subject`（科目）保留入账原文不改写**；收支结构按 `tag` 聚合。
标签由 `server/db.ts` 的 `normalizeTag()` 自动推断（去月份前后缀；电费 → `小区电费(生活缴费)`；
保洁工资 → `支付保洁员工资`），记账/编辑表单可手工覆盖，留空=自动推断。
执行 `export-csv` 生成的 `流水.csv` 也带「统计标签」列（该文件不常驻，按需生成）。

页面「收支结构」章节含**月粒度区间控件**（默认今年 01—12，可切归属期 / 实付日），
点击标签弹合并明细表、再点单行弹单笔交易详情；占比按当前区间合计计算。
详见 `AGENTS.md`「标签与收支结构」。

### 凭证存储：MinIO（2026-11-14 起）

凭证文件主存 MinIO（`forcePathStyle: true`，配置见 `server/.env`，**密钥不进代码/文档**），
本地 `凭证/` 保留为镜像 / 灾备。对象 key 等于文件相对路径，因此 DB `attachments.file`
与前端 URL 都不需要改动。读图时后端优先取 MinIO、失败回退本地，响应头
`X-Voucher-Source` 标明来源；上传时两端都写。命令：`minio-status` / `minio-sync` /
`minio-verify`，详见 `AGENTS.md`「凭证对象存储」。

## 数据模型

**accounts** — 账户字典（3 个，均在成阿四个人名下）

**vouchers** — 流水主表

| 字段 | 含义 |
|------|------|
| `vno` | 凭证号 `NF-YYYY-MM-NNN`，按**业务所属期**编号，不回收 |
| `date` | 发生/实付日 |
| `period` | 凭证号所属期 |
| `belong` | **归属期** —— 跨月支付时为费用所属月（如 10-05 付的 9 月电费，`belong=2026-09`），否则同 period |
| `type` / `amount` | 收入 / 支出；收入正数、支出负数 |
| `acc_code` | 账户 |
| `summary` | 摘要 = 事由 |
| `nopay` | 1 = 仅纸质单据缺支付凭证 |

> **`period` 与 `belong` 的区别很重要**：`period` 决定凭证号（月结时一批），
> `belong` 决定收入/支出算在哪个月（权责归属）。月度报表按 `belong` 归集。

**attachments** — 凭证图片（一笔多张，含 sha256）
**analyses** — 手写业务解读

## 记账约定（不变）

1. **凭证号** `NF-YYYY-MM-NNN`，按业务所属期编，**不回收**
2. **摘要 = 事由**，不依赖单据事由栏
3. 收入正数、支出负数
4. 单据编号**不强制补齐** —— 小区自治，形式要件不强求
5. 支出类应**双凭证**（纸质单据 + 支付凭证）；生活缴费无纸质单据属正常
6. 账户默认：收入进微信零钱；**内部停车场**走微信零钱，**外部停车场**走农行 6316
7. 未注明付款账户的支出，默认阿四微信零钱
8. **有图必留**，不裁剪不压缩；凭证目录四件套（凭证图 + 来源说明 + SHA256SUMS）

## 已知限制

- **期初余额未录**，页面显示的是「已记录流水净额」，**不可直接对外引用**。
  微信零钱净额为负即由此而来，不代表实际透支。补录可用 `PATCH /api/accounts/wx/opening`。
- 服务只监听 `127.0.0.1`，不对外网开放。
- 网页记账时若未上传凭证图，事后需用 `cli.js attach` 或 `POST /api/vouchers/:vno/attachments` 补图。
- 本机 `pnpm install` 可能只落包不建顶层链接（junction 权限），跑 `node scripts/fix-links.mjs` 修复。
- `node:sqlite` 在 Node 22 属实验特性，会有 ExperimentalWarning，属正常。