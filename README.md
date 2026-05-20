# Lottery Lab

本地彩票分析实验台 — 为 macOS 打包为原生 `.app`，基于 Tauri 2 + React 18 + Vite + TypeScript。

> 这是本地自用工具，不宣称能提高真实中奖概率。推荐结果是「规则合法 + 启发式排序 + AI 解释」的实验输出。

## 功能

- **推荐生成** — 一句自然语言（「双色球 20 元稳一点」），解析意图 → 加权随机候选 → 启发式评分 → 多专家 LLM 解释
- **数据同步** — 中彩网 / 体彩官方接口抓取；失败时降级到备用源；启动 + 每 6 小时定时 + 可自定义期数的手动同步
- **开奖复盘** — 同步完成后自动对比已推荐票与实际开奖结果，记录命中数
- **历史回测** — 多策略（`balanced` / `anti_popular` / `recency_fade`）对比，支持 JSON / CSV 导出
- **提示词配置** — 三个 AI 专家角色的 prompt 可编辑
- **AI 设置** — 切换 provider / base URL / model / API Key，未配置时离线回退

## 前置依赖

- macOS 12 (Monterey) 或以上
- Node.js 18+（Node 22 已验证）
- Rust 1.70+，经 [rustup](https://rustup.rs/) 安装
- Xcode Command Line Tools (`xcode-select --install`)

## 本地运行

```bash
# 安装 JS 依赖
npm install

# 开发（自动打开原生窗口，支持热更新）
npm run tauri dev

# 生产打包 .app
npm run tauri build
```

首次启动会在 `~/Library/Application Support/com.elijah.lottery-lab/` 下创建 `lottery_lab.db`。

## 配置 LLM

打开应用 → 「设置」页面 → 填写：

- Provider（预置 OpenAI Compatible / Anthropic / DeepSeek / OpenRouter / LM Studio / Custom）
- Base URL
- Model（如 `gpt-4o-mini` / `deepseek-chat`）
- API Key（本地存储，不通过网络回显）

未配置时推荐页仍可用，AI 解释会回退到离线启发式摘要。

## 开发命令

| 命令 | 功能 |
| --- | --- |
| `npm run dev` | 仅 Vite dev server（浏览器 `:1420`），调 Tauri 命令会失败 |
| `npm run build` | `tsc --noEmit` + Vite 产物 |
| `npm run typecheck` | TS 类型检查 |
| `npm run lint` | ESLint |
| `npm run test` | Vitest |
| `cargo check` (`src-tauri/`) | Rust 类型检查 |
| `cargo clippy -- -D warnings` (`src-tauri/`) | Rust 严格 lint |

## 项目结构

```
.
├── src/                          # React + TS 前端
│   ├── App.tsx                   # Router + 侧边栏
│   ├── main.tsx                  # QueryClient + Router provider
│   ├── components/               # 可复用 UI（SyncStatusCard / RecommendationPanel / Sidebar）
│   ├── domain/                   # 彩票规则 / 票面数学 / 解析 / 评分 / 推荐 / 回测
│   ├── lib/                      # IPC + DB 封装
│   ├── pages/                    # 五个页面：推荐 / 历史 / 回测 / 提示词 / 设置
│   └── index.css                 # Tailwind + shadcn 设计 token
├── src-tauri/                    # Rust / Tauri 壳
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── lib.rs                # entry，注册 plugin + commands + scheduler
│       ├── commands.rs           # Tauri IPC commands
│       ├── db.rs                 # sqlx pool（与 tauri-plugin-sql 共享文件）
│       ├── sources/              # 官方 + 备用数据源
│       ├── sync.rs               # 同步服务（抓取 + 降级 + 入库 + sync_runs）
│       ├── reviews.rs            # 开奖复盘
│       ├── recommendation.rs     # 推荐存储 + LLM 调用
│       ├── backtest.rs           # 回测存储 + 导出
│       ├── prompts.rs            # 提示词默认 + CRUD
│       ├── settings.rs           # AI 设置
│       ├── llm.rs                # OpenAI 兼容客户端
│       ├── scheduler.rs          # 启动 + 周期同步调度
│       ├── state.rs              # AppState（sqlx pool 句柄）
│       ├── errors.rs             # 统一错误类型
│       └── time_utils.rs         # Beijing 时间
├── vitest.config.ts
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

## 数据存储

- SQLite：`~/Library/Application Support/com.elijah.lottery-lab/lottery_lab.db`
- 迁移：`src-tauri/src/schema.rs` 中的共享 SQL，由 Rust sqlx pool 和 `tauri-plugin-sql` 共同使用
- AI Key：macOS Keychain；非密钥设置：`app_settings` 表
- 提示词：`prompts` 表，首次启动从默认值 seed

## 路线图（已完成）

- PR1 Tauri + React + Vite + Tailwind 骨架
- PR2 SQLite schema + 彩票领域逻辑 + Vitest
- PR3 数据同步（reqwest + sqlx + scheduler）
- PR4 推荐生成 + LLM 调用
- PR5 开奖复盘
- PR6 历史回测 + JSON/CSV 导出
- PR7 提示词 + AI 设置页面
- PR8 README + 验证 + 打包

## 不做

- 真实代购 / 实际出票
- 「能提高中奖概率」任何暗示
- 多用户 / 鉴权 / 云端托管
- 反反爬虫 / 代理池
- Windows / Linux / App Store 分发
- Apple 开发者签名 + 公证（本地自用不值 $99/年）
- 自动更新
