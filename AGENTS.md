# AGENTS.md —— 南丰村财务账本

> **面向 AI 助手 / 接手开发者。** 读完这一份，你就知道这个账怎么记、哪些坑别踩。

## 这是什么

**南丰村（＝南丰小区）小区自治账本**。不是公司财务，是**物业式的小区自管账**——
住户停车费、外包保洁、电费、充电桩分成都从这里走。

| 项 | 值 |
|---|---|
| 主体 | 南丰村 = 南丰小区（同一主体，用户原话确认） |
| 出纳 | **成（阿四）**，所有账户都在他**个人名下**，代管小区资金 |
| 记账人 | 成（阿四）；停车费登记由 **xiu秀** 负责（只汇总，不经手钱） |
| 币种 | CNY |
| 规模 | 30 笔凭证 / 37 张凭证图 / 覆盖 2026-02 至 2026-11 |
| 实收 | 56,997.74 元 |
| 支出 | 16,097.53 元 |
| 净额 | **+40,900.21 元** |

**性质决定了取舍**：小区自治**不追求"形式正规"**（单据编号空栏没人管），
但**两条底线必须守住**——①**有凭证**（每笔钱有截图/单据，账可查）②**能对账**（期初+流水完整）。
**余额算准比单据漂亮重要得多**，因为住户会问"钱去哪了"。

---

## 📁 数据到底在哪（2026-11-09 整理后，先看这条）

**唯一账本目录：`D:/Users/wuxw32.CN/WorkBuddy/Claw/南丰村财务/`** —— 本机只有这一份目录。
另一个 `D:/Users/wuxw32.CN/WorkBuddy/南丰村财务`（空目录、0 文件 0 字节）已于 2026-11-09 **删除**，别再找第二套。

> ⚠️ **2026-11-14 写入口切换**：权威账本已迁到另一个系统部署的同款服务，
> 本机这份 `data/ledger.db` 降级为**历史快照 / 灾备**。以后新增/修改/删除明细
> 一律走 WorkBuddy 配置的 `nanfeng-ledger` MCP 工具，**不要用本机 CLI / 7300 写接口**。
> 两端各有独立 SQLite，双写会分叉；切换前已逐笔核对 17 字段 × 30 笔零差异。
> 详见下方「最重要的一条：记账入口」。

| 路径 | 是什么 | 处置 |
|---|---|---|
| `data/ledger.db` | **本机副本**（30 笔基线）；2026-11-14 起权威账本在远端 MCP | 只经 CLI / API 改，绝不手改；**日常记账不再写它** |
| `凭证/` | 30 个凭证号目录：原图 + 聊天原文 + SHA256SUMS | 只增不改，原始证据 |
| `收件箱/` | 新账单暂存队列 `_QUEUE.md` | 按「接收与处理解耦」流程走 |
| `明细分析.md` | 唯一手写业务解读 / 序列规律 | 可追加，不自动生成 |
| （2026-11-10 已清理） | `流水.csv` 删除；旧页面 + `assets/` + 3 个 `server/_old_*.js` 移入 `_归档/历史版本/` | 见下方清理说明 |
| `web/dist/` | React 生产包，7300 端口默认页面 | 由 `web/` 构建 |
| `server/` | Koa + TS 后端与 CLI | 代码 |
| `_归档/` | 历史文档 + OCR 中间图（均已有归档副本或可再生） | 非数据源，可随时清空 |
| `启动账本.bat` | 双击启动服务并打开页面 | — |

**看页面**：服务**不是常驻**的，双击 `启动账本.bat` → 自动起 7300 → 打开 `http://127.0.0.1:7300`。
页面只有 `web/dist/` 这一套，且靠 `fetch('/api/...')` 取数，**必须有后端在跑**。

**2026-11-10 清理**：删掉 `流水.csv`（数据全在 `ledger.db`，需要时 `node dist/cli.js export-csv` 可原样重生）；
把 `账本.html` + `assets/tailwind.js` + 3 个无引用的 `server/_old_*.js` 移入 `_归档/历史版本/`，
并删除 `server/index.ts` 的 `LEGACY` 兜底分支（避免悬空引用）。
⚠️ **`明细分析.md` 保留**：数据库 `analyses` 表为 **0 条**，这 823 行人工业务判断 / 序列规律 /
逐笔档案**不在库里**，删了不可恢复；`流水`=vouchers 表，`明细分析.md`=人工解读，两者不是一回事。

---

## 🏷️ 标签与收支结构（2026-11-10 上线）

**核心原则：统计是对流水的加工，不是改写流水。** 每笔流水有独立 `tag` 字段，
`subject`（科目）保留入账时的原始写法，**绝不因合并展示而改写**。

| 项 | 说明 |
|---|---|
| 标签来源 | `server/db.ts` 的 `normalizeTag(subject, type)`：去月份前后缀；电费统一 `小区电费(生活缴费)`；保洁工资统一 `支付保洁员工资`；其余 = 科目原文 |
| 回填 | 启动时 `ensureColumn('vouchers','tag')` + **只补空值**（幂等），手工设过的标签不会被覆盖 |
| 手工改 | 记账/编辑表单「统计标签」框；留空 = 自动推断；也可 `PATCH /api/vouchers/:vno` 传 `tag` |
| 聚合 | `expenseStructure()` / `incomeStructure()` 按 `tag` 分组，`COALESCE(NULLIF(TRIM(tag),''), subject)` 兜底 |
| 展示 | 流水明细表摘要列下显示 `#标签`；执行 `export-csv` 生成的 CSV 也带「统计标签」列 |

**页面交互**（`web/src/components/StructureDrilldown.tsx`）：

- 「收支结构」章节顶部有**月粒度区间控件**，默认今年 01—12；「时间口径」可切
  `归属期（费用所属月）` / `实付日`，默认归属期（与月度趋势图一致）。
- 点击结构表任一标签 → 一级弹窗：该标签在**当前区间**内的合并明细表（含合计）。
- 再点其中一行 → 二级弹窗：单笔交易全字段 + 凭证图入口。
- 占比以**当前区间内合计**为分母，不是全账累计；概览卡片 / 月度图始终是全量。

**接口**：`GET /api/summary?from=YYYY-MM&to=YYYY-MM&basis=belong|date`（不传=全量）、
`GET /api/structure/vouchers?tag=…&from=&to=&basis=`。
改了 `server/*.ts` 要 `npm run build`；改了 `web/src` 要 `cd web && npm run build`；
**两边都改过必须重启 7300 服务**才生效。

---

## 🤖 MCP 服务（Streamable HTTP，2026-11-14 起）

与 Web 服务**同进程**（`server/index.ts` 启动时一并拉起），默认 `http://127.0.0.1:7302/mcp`，
健康检查 `GET /health`。共用同一个 SQLite 连接，所以还原数据库时不会出现多进程指向不同文件的问题。

**工具覆盖：明细 CRUD + 凭证附件 + 待办缺口 + 一致性校验 + 整库备份/还原（共 14 个）**。
不提供统计工具 —— web 的收支结构、月度趋势、余额全部由明细实时算出，改明细即反映到统计。

| 工具 | 作用 |
|---|---|
| `ledger_list_vouchers` | 条件查询（period / type / acc / from / to / q / tag + limit / offset） |
| `ledger_get_voucher` | 按凭证号查单笔完整字段 |
| `ledger_create_voucher` | 新增（凭证号自动分配；附图请随后调 `ledger_attach_file`） |
| `ledger_update_voucher` | 局部修改，只传要改的字段 |
| `ledger_delete_voucher` | 删除（**必须 confirm=true**；仅删 DB 记录，不动凭证图） |
| `ledger_attach_file` | 传附件（base64 ≤ 8 MB，仅取 basename）→ MinIO 主存 + 本地镜像 + `attachments` 表 + 重算 `SHA256SUMS.txt`；同名同内容幂等跳过 |
| `ledger_list_attachments` | 列出某凭证附件，并列 `localSize` / `remoteSize` 判断证据链是否完整 |
| `ledger_get_attachment` | 按相对路径读回 base64（先 MinIO、失败回退本地，密钥不出后端） |
| `ledger_delete_attachment` | 删附件（**必须 confirm=true**）：删记录 + 本地文件 + MinIO 对象 + 刷新 `SHA256SUMS.txt` |
| `ledger_todos` | 待办与缺口（与 Web 待办面板同源）：电费/外部停车场缺月 `gaps`、缺凭证 `nopay`、待核 `review`、负账户 `negAcc`、首期 `first` |
| `ledger_verify` | 校验各凭证目录 `SHA256SUMS.txt` 与实际文件哈希 |
| `ledger_backup_db` | `VACUUM INTO` 一致快照 → MinIO `backups/` → 回读校验 SHA256 → 写 `.json` 元数据 |
| `ledger_list_backups` | 列出备份（按文件名倒序） |
| `ledger_restore_db` | 还原（**必须 confirm=true**）：校验 → 自动预备份 → 本地留底 → 关连接 → 替换 → 重开 |

> 记账 Agent 的完整闭环：`ledger_todos` 看还缺什么 → `ledger_create_voucher` 记明细 →
> `ledger_attach_file` 附图 → `ledger_verify` 收尾自检。**不需要 Web 界面参与**。

**还原安全网**：先验 `SQLite format 3` 文件头 + `PRAGMA integrity_check` + `vouchers`/`attachments` 表；
还原前自动 `backupDb('pre-restore')` 到 MinIO，本地留 `data/ledger.db.before-restore-<ts>`；
替换失败立即用本地副本回滚，`finally` 里必定 `Q.reopenDatabase()` 恢复连接。
凭证图片独立存在 MinIO / 本地镜像，**还原 DB 不会影响凭证文件**。

**配置**（`server/.env`，样例见 `.env.example`）：`MCP_PORT` / `MCP_HOST` / `MCP_TOKEN`。
默认仅监听 `127.0.0.1` 且无鉴权；**远程暴露必须设 MCP_TOKEN**，客户端带
`Authorization: Bearer <token>`。WorkBuddy 接入可在 `~/.workbuddy/mcp.json` 加：
```json
{"mcpServers":{"nanfeng-ledger":{"url":"http://127.0.0.1:7302/mcp"}}}
```

源码：`server/mcp.ts`（工具与 HTTP 传输）；`db.ts` 为此新增 `closeDatabase()` /
`reopenDatabase()`，`db` 由 `const` 改成 `let`（ESM live binding）。

**2026-11-14 起的日常写入口是远端部署的这套 MCP**（WorkBuddy 里叫 `nanfeng-ledger`），
本机 7302 仅作灾备 / 开发调试；两套服务各有独立 SQLite，**绝不能双写**。
本机与远端共用 MinIO 凭证与备份 bucket，备份/还原统一走远端 MCP。

---

## 🗄️ 凭证对象存储：MinIO（2026-11-14 起）

**主存储是 MinIO，本地 `凭证/` 只作镜像 / 灾备**（15 MB，不删，离线也能看账）。

| 项 | 说明 |
|---|---|
| 配置 | `server/.env`：`MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET / MINIO_REGION / MINIO_FORCE_PATH_STYLE`。**密钥只在这里，绝不写进源码、文档、日志或对话**；`.gitignore` 已排除 |
| SDK | `@aws-sdk/client-s3` + `forcePathStyle: true`（走 CF 必须开，否则会解析成 `bucket.<host>`） |
| 对象 key | **等于文件相对项目根的路径**（如 `凭证/NF-2026-10-006/凭证-微信转账单.jpg`），与 DB `attachments.file`、前端 `fileUrl()` 完全一致，所以迁移没改任何数据结构 |
| 模块 | `server/storage.ts`（S3 客户端 / 读写 / 列对象 / 桶）、`server/minio-sync.ts`（同步与校验） |
| 读图 | `GET /凭证/...` 后端**优先从 MinIO 取**，失败自动回退本地；响应头 `X-Voucher-Source: minio / minio-cache / local` 标来源（密钥不出后端）。**MinIO 经 CF 回源单张 3~10 秒**，故加了 30 分钟 TTL 内存缓存（上限 300 个），同一张图第二次起毫秒级；上传新图会清空缓存 |
| 上传 | `POST /api/vouchers/:vno/attachments` 先写 MinIO、再写本地镜像，DB 同时记 `sha256`；远端失败仍保本地，凭证不丢 |

**CLI**（在 `server/` 下）：
```
node dist/cli.js minio-status                 # 状态 + 对象数（不含密钥）
node dist/cli.js minio-sync   [--force]      # 幂等同步 凭证/ 全部文件，上传后回读比对 SHA256
node dist/cli.js minio-verify                # 全量下载远端对象逐个比对 SHA256
node dist/cli.js verify                      # 本地校验 + 轻量远端检查（1 次 list，比 key 与大小）
```

> 2026-11-14 修正：`minio-sync` 原按 key+大小跳过，**`.txt` 内容变而字节数不变会漏传**
> （实测 SHA256SUMS 格式改正后远端仍是旧版）。现 `.txt` 一律强制重传，与 `syncVoucherDir` 一致。
> `verify` 的轻量远端检查仍只比 key+大小，**要逐字节比对必须跑 `minio-verify`**。

**踩过的坑（别重踩）**：
- 经 CF 的 MinIO 创建桶必须带 `CreateBucketConfiguration.LocationConstraint`，
  否则 SDK 发空 body 会回 `400 MalformedXML`；AWS SDK 的 `BucketLocationConstraint`
  枚举不含 `us-east-1`（S3 默认区不发该字段），故代码里做了显式类型断言，MinIO 不校验取值。
- 中文对象 key 已实测 put/head/get/list 全部正常，不要改成 ASCII 映射。
- 远端读延迟较高（CF 回源），**不要去掉内存缓存**；若仍嫌首图慢，可改为本地镜像优先读（数据仍全量在 MinIO）。
- 新增凭证目录文件后跑一次 `minio-sync` 即可补传（按 key+大小跳过已存在的）；服务启动也会自动补传一次兜底。
- CLI `add` / `attach` 与 HTTP 上传都会在 `hashVoucherDir` 后调 `syncVoucherDir(vno)`，
  把同目录的 `SHA256SUMS.txt`、来源说明一并传到 MinIO（`.txt` 强制重传，避免内容变而大小不变被跳过）。

---

## 📊 前端 UI 与图表框架（2026-11-10 用户约定）

| 项 | 选型 | 落点 |
|---|---|---|
| UI 组件 | **antd 5.29.3** | `web/src/main.tsx`：`ConfigProvider theme.darkAlgorithm` + token 对齐 tailwind 配色；外层 `StyleProvider hashPriority="high"`（防 Tailwind preflight 覆盖 CSS-in-JS） |
| 图表 | **echarts 5.6.0**（按需引入 `echarts/core`） | `web/src/components/EChart.tsx`：统一注册 `nanfeng-dark` 暗色主题 + 常用图表/组件，自动 resize / dispose，支持 click 钻取 |

**🔒 硬约定：后续所有统计图表一律用 echarts，且统一走 `EChart` 组件** ——
不要再写纯 CSS 图表，也不要引入第二个图表库。新增图表类型时在 `EChart.tsx` 的
`echarts.use([...])` 里追加注册；配色复用 `nanfeng-dark` 主题，不要在每个 option 里
重复写暗色样式。新增 UI 控件优先用 antd。

**版本坑**：pnpm 11 把 `^5` / `^1` 按 `lowest-direct` 解析到 5.0.0 / 1.0.0，
曾导致 `@ant-design/cssinjs` 与 antd 内部用的 1.23.0 变成两个副本（样式 context 不通）。
`package.json` 已锁 `antd ^5.29.3` / `echarts ^5.6.0` / `@ant-design/cssinjs ^1.23.0`，
**升级或重装依赖务必写精确版本**。

已落地示例：`Panels.tsx` 的 `MonthlyChart`（EChart 柱状 / 折线 + antd `Segmented` 切换）、
页头「+ 记一笔」antd `Button`。Vite 已按 react / antd / echarts 拆 vendor chunk（主包约 40 KB）。

---

## ⚡ 收件箱：接收与处理解耦（用户 2026-11-08 要求，优先级最高）

用户会**连续甩多笔账单**，不要等上一笔跑完 verify / 写索引才接下一笔。

### 第一动作：先落盘，秒回（一次工具调用内做完，不做任何识别/查库）

1. 图片原样下载到 `收件箱/<YYYYMMDD-HHmm>_<短名>/`（不裁剪、不压缩、不覆盖）
2. 同目录写 `原文.txt`：聊天记录全文（谁 / 何时 / 说了什么）+ 附件原始链接 + 补图状态
3. `收件箱/_QUEUE.md` 追加一行，状态 `⏳ 待处理`（缺图则 `⏳ 待补图`）
4. **立刻回用户「已收 N 笔，排队中」** —— 不 OCR、不查账本、不跑 verify

> 目的：用户发下一笔时我不在忙；即使中途被打断/中断，凭证与原文已在盘上，不会丢。

### 处理阶段（可延后、可攒批）

- **图片识别派子智能体并行**：一个子智能体只读一组图，返回结构化字段
  （日期 / 金额 / 收支方向 / 付款方 / 账户 / 事由 / 模糊处 / 需确认项），
  **严禁写库、严禁改文档**。多笔可同时派，识别互不干扰。
- **入账必须主进程串行**，理由不是保守，是硬冲突：
  `data/ledger.db` 单文件 + `nextVno(period)` 按期间自增 → 并发会撞凭证号；
  `_INDEX.md` / `明细分析.md` 是手写文件 → 并发 Edit 会互相覆盖；
  `hashVoucherDir` / `verify` / `export-csv` 是全量操作 → 并发跑会读半写状态。
- 串行顺序：`insertVoucher` → `hashVoucherDir` → `verify` → `export-csv`
  → 更新索引/明细分析 → 队列标 `✓ 已入账` 回填凭证号 → `present_files`
- 队列里攒了多笔时**一次跑完再统一回一次汇总**，不要每笔回一次长文。

### 铁律不变

- **无凭证不入账**：消息里只有 `[图片]` 占位 / 无附件链接 → 队列标 `⏳ 待补图`，
  回用户「这张图没传过来，请补发」，**绝不猜金额**。
- 凭证号按业务发生日所属期；支出双凭证；内部→微信零钱 / 外部→农行 6316；有图必留。
- 收件箱只是接收暂存区；**权威账本在远端 MCP**，本机 `data/ledger.db` 为灾备副本（2026-11-14 起）。
  入账那一步改为调 `ledger_create_voucher`，仍须串行，不要并发。

---

## ⚡ 最重要的一条：记账入口（2026-11-14 起改为远端 MCP）

**权威写入口 = WorkBuddy 配置的 `nanfeng-ledger` MCP 服务**（另一系统已部署同款代码，
端点与凭据见本机 `~/.workbuddy/mcp.json`，不写入本文件）。新增/修改/删除明细一律调用
`ledger_create_voucher` / `ledger_update_voucher` / `ledger_delete_voucher`（删除需 `confirm=true`）；
查询用 `ledger_list_vouchers` / `ledger_get_voucher`；备份还原用
`ledger_backup_db` / `ledger_list_backups` / `ledger_restore_db`（还原需 `confirm=true`）。

**为什么改**：本机与远端各有独立 SQLite 文件，双写必然分叉。切换前逐笔核对
**17 字段 × 30 笔零差异**（收入 56,997.74 / 支出 -16,097.53 / 净 40,900.21），
9 个支出标签、39 附件、MinIO 110 对象、5 个 .db 备份全部一致。

⚠️ 本机 `data/ledger.db`、7300 页面、7302 MCP、`verify` / `report` / `export-csv`
从此只作**灾备 / 只读 / 代码维护**，结果**不是权威数据**；两端共用同一 MinIO bucket，
**本地不要再跑 backup/restore**，否则会覆盖远端。
⚠️ MCP 目前**没有上传凭证图的工具**：带图新增需走远端 Web 上传接口或后续补工具。

### 本机 CLI（仅灾备 / 离线维护，日常记账不要跑）

```bash
cd D:/Users/wuxw32.CN/WorkBuddy/Claw/南丰村财务/server

node dist/cli.js add --date 2026-06-25 --period 2026-06 --type 支出 \
  --amount 1250.00 --subject "管道疏通/清理隔油池" --account wx \
  --party "佛山市禅城区高邮疏通服务部" --summary "清理隔油池·管道疏通服务费" \
  --kind 收款收据 --files "D:/path/收据.jpg" --note "用户原话"
```

**凭证号自动分配、凭证图片自动归档到 `凭证/<凭证号>/`、SHA256 自动生成。实测 2 秒。**

其余命令：

| 命令 | 作用 |
|------|------|
| `node dist/cli.js verify` | 校验所有凭证 SHA256 |
| `node dist/cli.js report` | 汇总报表（账户余额 + 月度） |
| `node dist/cli.js attach --vno NF-... --files "a.jpg\|b.jpg"` | 补凭证图 |
| `node dist/cli.js export-csv` | 按需生成 `流水.csv` 导出备份（根目录默认不保留该文件） |
| `node dist/cli.js migrate` | 兼容旧迁移入口；源 CSV 已清理，现为空操作（`existsSync` 保护，不报错） |

> ⚠️ **CLI 没有改单据的命令**（不能改金额/日期/备注）；远端 MCP 的
> `ledger_update_voucher` 可直接改任意字段，**日常修改一律走它**。仅在灾备本机时：
> 要改已有凭证的字段，
> 写一次性 `.mjs` 调 `updateVoucher(vno, { note })`（`db.ts` 导出，**部分更新**，
> 未传字段沿用原值，安全）；改完记得重跑 `hashVoucherDir` / `verify` 与 `export-csv`。
> （临时脚本用完即删，别留在 `server/` 里。）

**`--amount` 永远传正数**，支出由脚本自动取负。

### 为什么强调这个

历史上曾手工编辑 `账本.md` / `账本.html`，**单笔耗时 12 分钟**——因为在重复劳动：
逐笔明细档案、待办清单、HTML 回填，全是脚本能自动算的东西。

历史架构定死过「`data/ledger.db` 是唯一数据源」；**2026-11-14 起该表述只适用于本机副本**，
权威账本在远端 MCP（见本章开头）。页面始终从接口取数渲染。
**`账本.md` 是历史归档，`账本.html` 是 React 上线前的兜底，都不要维护。**

---

## 记账约定（用户已确认，不要再追问）

1. **凭证号** `NF-YYYY-MM-NNN`，按业务所属期编号，**不回收**
2. **摘要 = 事由**。纸质单据的「支出事由」栏可留空，以摘要为准
3. 收入正数、支出负数
4. 单据编号**不强制补齐**
5. 支出类应**双凭证**（纸质单据 + 支付凭证）；**生活缴费无纸质单据属正常，不催补**
6. 账户默认：收入进微信零钱；**内部停车场**走微信零钱，**外部停车场**走农行 6316
7. **未注明付款账户的支出，默认从成（阿四）微信零钱支出**（不再挂"待确认"）
8. **有图必留**，不裁剪不压缩
9. **科目保留入账原文，合并只靠「统计标签」**（2026-11-10 用户明确）：
   不要再为了结构表合并去 `UPDATE subject`。流水有独立 `tag` 字段，由 `normalizeTag()` 自动推断、
   编辑表单可手工覆盖；月份信息仍放 `summary` / `belong`。
   当前合并结果：电费 **5 笔 → `小区电费(生活缴费)` 2,196.81**、
   保洁工资 **6 笔 → `支付保洁员工资` 6,300.00**。详见上方「标签与收支结构」章节。

### 业务上容易搞错的点

**停车费必须分「内部 / 外部」两套科目，不可合并**：

| | 内部停车场 | 外部停车场 |
|---|---|---|
| 科目 | 小区内部停车场收入 | 外部停车场收入 |
| 账户 | **微信零钱** | **农行 6316** |
| 流程 | 各车主**直接转阿四微信**，xiu秀只登记汇总、**不经手钱** | 外部方 → 阿四**工行 3779** → 划转 → 农行 6316 |
| 口径 | 登记单金额即实收，**无应收未收** | 按**资金实际落点**（农行6316）计实收 |
| 频次 | **季度**，约 1.07 万/季（Q2=10,700 / Q3=10,650） | **月度**，约 4,500~5,300/月 |

- 外部停车场常**跨期**（例：09-05 到账但附言写「8月分成」→ 归属期归上月）
- 若后续拿到「外部方汇入工行3779」的原始凭证，**不得重复计收入**

**疏通类分两个科目，不可合并**：

- **管道疏通/清理隔油池** —— 定期清掏（隔油池是厨房油污设施）
- **下水道疏通/清理化粪池** —— **堵塞才叫的应急**

> ⚠️ 这两笔金额极接近（1,250 / 1,200），**极易被误判成同一序列**。
> 2026-10-11 曾因此出错：据单据抬头「外停车场收款」就串成一条序列，实际是两种活。
> **教训：单据抬头 ≠ 业务归属。**

---

## 数据模型要点

四张表：`accounts` / `vouchers` / `attachments` / `analyses`

### `period` 与 `belong` 的区别（**最容易错的地方**）

| 字段 | 含义 | 作用 |
|------|------|------|
| `period` | **凭证号所属期** | 决定凭证号（月结时一批） |
| `belong` | **归属期** = 费用所属月 | 决定收入/支出算在哪个月 |

例：10-05 付的 9 月电费 → 凭证号 `NF-2026-10-002`，但 `belong = 2026-09`。
**月度报表按 `belong` 归集**，否则 9 月电费会被漏掉、缺口月份会被误判。

`belong` 可从 `note` 里的「费用所属期 YYYY-MM」正则提取，见 `db.js` 的 `belongOf()`。

### 账户

| code | 名称 | 角色 | 期初 |
|------|------|------|------|
| `wx` | 微信零钱 | 主账户 | **0（未录）** |
| `ab` | 农行6316 | 外部停车场分成汇集账户 | **0（未录）** |
| `icbc` | 工行3779 | 中转账户 | **0（未录）** |

---

## 🚨 已知缺口（对外引用前必须先解决）

**各账户期初余额未录入。** 页面显示的是「已记录流水净额」，**不是真实余额，不可直接对外引用**。
微信零钱净额为负即由此而来，**不代表实际透支**。

补录：`PATCH /api/accounts/wx/opening` 或直接改 `accounts.opening`。

其他待办（页面「待办与缺口」区会自动列出，点凭证号可跳转）：

| 类型 | 现状 |
|------|------|
| 缺凭证月 · 电费 | **2026-04、2026-06** |
| 缺凭证月 · 外停车场收入 | **2026-04、2026-05** |
| 缺支付凭证 | **8 笔**（仅纸质单据，按约定不催补） |
| 待核事项 | **12 笔**（备注含「待核/待确认/⚠️」） |

---

## 技术架构

```
南丰村财务/
├── server/                Koa + SQLite 后端（Node ≥ 22.5，TypeScript）
│   ├── index.ts           HTTP 服务 + 静态托管 dist
│   ├── db.ts              数据层（内置 node:sqlite，免原生编译）+ 全部接口类型
│   ├── cli.ts             命令行记账
│   ├── scripts/fix-links.mjs  pnpm 链接修复
│   └── dist/              ★ tsc 编译产物 —— 实际运行的是它，勿手改
├── web/                   Vite + React 18 + TypeScript + Tailwind
│   ├── src/App.tsx        页面编排（唯一的编排层）
│   ├── src/lib/           types.ts（接口类型）/ api.ts（fetch 封装）
│   ├── src/components/    ui / Panels / VoucherTable / VoucherViewer /
│   │                      VoucherForm / TodoPanel
│   └── dist/              生产产物（Koa 在 /app/ 下托管）
├── data/ledger.db         ★唯一数据源
├── 凭证/<凭证号>/          凭证图 + 来源-说明.txt + SHA256SUMS.txt
├── 明细分析.md            ★唯一手写文件（业务解读，库里没有，别删）
└── _归档/历史版本/         旧版页面 / 旧账本 / 旧代码副本（2026-11-10 移入）
```

### 启动

```bash
# 日常：一条命令，后端直接托管 React 产物
cd server && npm start          # → http://127.0.0.1:7300

# 后端开发（TypeScript）：改完 .ts 必须重新 build，跑的是 dist/
cd server && pnpm build          # tsc → dist/
cd server && pnpm dev            # tsc --watch + node --watch dist/index.js

# 前端开发（热更新）
cd web && pnpm dev              # → http://127.0.0.1:7301

# 构建生产包
cd web && pnpm build            # 产物 web/dist，base=/app/
```

> ⚠️ **`npm start` 跑的是 `dist/index.js`，不是 `.ts`**。
> 改了 `server/*.ts` 却不 build，会以为「改了没生效」。

### 版本号（2026-11-15 起，用户要求：改动代码就动版本号）

单一事实来源：项目根 **`VERSION`**（`x.y.z`）。改完代码、提交前跑一次：

```bash
cd server && npm run bump              # patch +1   1.0.0 → 1.0.1   （修 bug / 调整文案）
cd server && npm run bump -- --minor   # minor +1   1.0.0 → 1.1.0   （新增功能、新增工具）
cd server && npm run bump -- --major   # major +1   1.1.0 → 2.0.0   （破坏性变更 / 数据模型不兼容）
cd server && npm run bump -- --set 2.0.0
```

脚本 `scripts/bump-version.mjs` 会同步 `server/package.json` 与 `web/package.json`，三处不再各说各话。

| 版本号出现在哪 | 怎么来的 |
|---|---|
| `GET /api/health` 的 `version` | `server/version.ts` 运行时读 `VERSION` |
| `GET /health`（MCP） 的 `version` | 同上；同时作为 `McpServer` 的 `serverInfo.version` |
| 页面右上角 `v1.0.0` 角标 | Vite 构建时 `define.__APP_VERSION__` 注入，**改完必须重新 `pnpm build`** |

**纪律**：一次代码改动 = 一次 bump + 一次 commit，commit message 带上 `vX.Y.Z`。
只改文档（`*.md`）、只记流水账（走 MCP 写数据）**不算代码变更，不 bump**。
版本号是给「远端部署是否落后」做判断用的，页头角标与 `/health` 不一致就说明远端没重新部署。

### 技术选型理由（别轻易改）

- **用 Node 22 内置 `node:sqlite`（`DatabaseSync`），不用 better-sqlite3** —— 免原生模块编译。
  后端依赖只有 3 个：`koa` `@koa/router` `koa-bodyparser`。
- **后端也是 TypeScript**（2026-10-13 从 JS 迁过来），类型在 `db.ts` 里统一定义并导出，
  路由层 `import type { VoucherInput, Account, ... } from './db.js'` 复用。
- **前端用 pnpm，不用 npm** —— 本机 npm 的 arborist 解析 `fsevents`（macOS 专用包）会抛
  `Invalid Version`，`--omit=optional` 会连必需包一起跳过。
- **Tailwind 走本地构建，不引CDN** —— 这是本地财务工具，CDN 挂了会白屏，没法记账。

### 本机环境坑（都填过，别重踩）

| 坑 | 症状 | 解法 |
|---|---|---|
| npm 解析 `fsevents` 报错 | `Invalid Version` | **用 pnpm** |
| pnpm 只落包不建顶层链接 | 「已是最新」但 import 不到 | `node scripts/fix-links.mjs`（递归建 junction，含原生二进制） |
| **`tsc` 产物在 `dist/`，比源码深一层** | **改完后跑起来「0 笔凭证」——连到了新建的空库** | `db.ts` 里判断 `basename(__dirname)==='dist'` 再多提一级，见 `ROOT` 计算处的注释 |
| `@types/koa__router` 是个空壳 | 装了下 `RouterContext` 还是找不到 | 别装；`RouterContext` 从 `@koa/router` 直接 `import type` |
| `node:sqlite` 的返回值是联合类型 | `as VoucherRow[]` 被 TS 拒绝（类型不充分重叠） | 用 `all<T>()` / `get<T>()` 助手，内部走 `as unknown as T` |
| `ctx.query` 的值是 `string \| string[]` | 传给 `string` 参数报错 | `qs()` 助手取第一个并收窄 |
| `server.proxy` 不认中文 key | 凭证图 `naturalWidth=0`，返回 index.html | `vite.config.ts` 用自定义插件 + 原生 `http` 转发 + 正则 `^/(api\|凭证\|assets)(\/\|$)` |
| 凭证图中文路径 | 需 `split('/').map(encodeURIComponent).join('/')` 逐段编码 | `lib/api.ts` 的 `fileUrl()` |
| `aspect-ratio` 预留空间 | 旋转时图片被压扁甚至加载失败 | `onLoad` 读 `naturalWidth/naturalHeight` 存 ratio，90°/270° 取 `1/ratio` |

---

## 处理用户凭证的标准流程

用户常从飞书发来 zip（`聊天记录.txt` + 一张照片）。**踩过的坑：**

1. **zip 内文件名是 GBK 编码** —— `unzip` / python `zipfile` 都显示乱码（如 `ÞüèÕñ®ޫ¦բò.txt`）。
   解法：`name.encode('latin-1').decode('gbk')` 回转，或直接用 ASCII 安全名落盘。
2. **图片常横躺 90°** —— 用 pillow 旋转为正向**再归档**，省得日后每次手动转。
   ```python
   Image.open(src).rotate(90, expand=True).save(dst, quality=92)
   ```
3. **单据字迹潦草 / 印章极小** —— **放大 3~6 倍逐处裁剪确认**，不要猜。
4. **先核对同类历史记录**（`node -e "import('./db.js')..."`），确认科目口径与期间归属一致。
5. **微信转账类凭证：先问清每张图是谁的手机拍的** —— 「你发起了一笔转账」是**发起方**视角，
   「你已收款·资金已存入零钱」是**收款方**视角。两张图常来自两部手机，
   据此即可判定资金方向与收款账户归属，不用猜（2026-10-19 `NF-2026-10-005` 实证有效）。
6. 入账（**走远端 MCP**）后用 `ledger_get_voucher` 回查该笔确认落库；
   本机 `verify` / `todos()` 只看得到本机快照，**不要拿它验收远端入账**。

### 铁律：数字矛盾时不许自己挑一个信

2026-10-11 那张 Q2 停车位登记单，底部有三处金额：
「登记人 63,250 元」「确认人 36,000 元」「合计 99,50 + 750 = 107,00 元」——**三者互不相等**。

正确做法：**逐个放大读清 → 全部列出来问用户**，用户答"10700 元"后才入账，
并**把矛盾点写进 `note` 留痕**（会自动进待核清单），不是当作没这回事。

**金额接近 ≠ 同一业务 ≠ 同一供应商。遇到相邻两笔金额相近，先确认，不要推断序列。**

---

## `明细分析.md` 是唯一手写文件

数据库管金额与流水，但这些只能靠理解后写下来：

- **序列规律**：内部停车场约 1.07 万/季、外部停车场 4,500~5,300/月
- **业务判断**：哪些是定期、哪些是应急
- **修正过程**：改过什么、为什么改（避免后人重犯）
- **待查事项**：如 Q2 单据上 63,250 / 36,000 的含义

**这是文件不是程序**，随时可写。往里加内容前先 `Read`，别覆盖既有小节。

---

## 记账约定之外的用户偏好

- 用户**会主动纠正业务归属**，且纠正得对。发现自己推错了，直接承认并改，
  把教训写进 `明细分析.md` 与 MEMORY，别辩解。
- 用户**给的金额以他为准**，即使单据上另有数字。
- 沟通要**直接给结论**，别铺垫。用户嫌慢——之前 12 分钟是因为在重复劳动，不是会话太长。