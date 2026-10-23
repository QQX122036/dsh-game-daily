# dsh-game-daily · 游戏日常

**简体中文** | [English](README.en.md)

DSH 桌面端插件：把「原神 / 崩坏3 / 崩坏：星穹铁道」的每日自动化收进设置页一个面板里 —— 顶部切游戏、每游戏一个默认关闭的代理开关、按游戏配排班，保存后自动建立 Windows 计划任务，到点无人值守地跑一轮日常，跑完弹通知并（可选）开一个会话向你汇报。

## 安装

从源码安装（推荐）：先把仓库 clone 到本地任意目录，再让 Harness 的 `plugin_manager` 指向该目录（它自己完成 package 安装与 bundle 选择；**不要**手写 profile 的 `package.json` / `cordis.patch.yml`）：

```powershell
git clone https://github.com/gychen-NJU/dsh-game-daily.git
```

```
plugin_manager  action: install_bundle  target: <clone 下来的 dsh-game-daily 目录>
```

开发期（link 到某个 profile，改代码即时生效；改完仍需重启桌面端才会重新加载代码）：

```powershell
dsh plugin --profile web add link:<本仓库目录>
```

装好后：设置 → 游戏日常。插件包声明了 `dsh.bundle.patch` 与 `dsh.client`，profile 的 `dsh.profile.bundles` 会列出 `dsh-game-daily`。

### 交给 Agent 安装（一句话）

把下面这句直接发给你的 DSH Agent：

> 帮我把 https://github.com/gychen-NJU/dsh-game-daily 装进当前 DSH 桌面端：clone 到本地目录后用 plugin_manager install_bundle 指向该目录，装完确认「设置 → 游戏日常」出现并跑一次依赖体检，缺什么按提示修好。

Agent 会自己完成 clone、`install_bundle`、确认插件已激活，并按依赖体检结果补齐 BetterGI / computer-use / 技能等外部条件。

## 面板里能做什么

- **顶部游戏页签**：原神 / 崩坏3 / 崩坏：星穹铁道 / 绝区零（后者暂停，仅占位说明）。
- **代理日常开关（默认关）**：打开后才出现排班与执行设置；改动先落在本地草稿，点「保存并应用」才写盘并重建计划任务。
- **排班**：每天时间、执行日（每天 / 指定星期）、超时、模式（真实执行 / 演练只诊断）、错过补跑、跑完开一个会话汇报、游戏路径（原神可指定 `BetterGI.exe`）。
- **依赖体检**：dsh CLI、DSH 版本、headless 运行器（含 credentials 补丁）、computer-use 插件、技能文件、坐标校准、提权助手、BetterGI、bettergi MCP。缺任何一项都给出「让 DSH 修这个」按钮：插件会新开一个 DSH 会话，把修复步骤（含备份/回读要求）交给 Harness 执行，并把界面切过去。
- **立即运行一次 / 停止 / 关闭全部代理**：立即运行走「已保存」的配置；停止会杀掉该游戏的 headless 运行进程；关闭全部代理会移除所有计划任务。
- **最近运行**：读取 `report.json`（状态、模式、步骤、证据、结论）与 stdout 尾部。

## 执行链路

```
设置页 ──POST /api/game-daily/apply──▶ 写 state.json + automation/tasks.json
                                              │
                                              └─▶ automation/game-daily-register.ps1（提权一次）
                                                     └─▶ Windows 计划任务 game-daily-<game>
                                                            每天 HH:MM 触发
                                                            │
                                                             ▼
                                             node automation/run-headless.mjs --game <id>
                                                            │  spawn
                                                            ▼
                              dsh --profile headless --patch automation/headless-overlay.yml "<prompt>"
                                                            │
                                                            ▼
                                 按技能执行（原神走 bettergi-control；崩3/星铁走 game-daily-*）
                                                            │
                                                            ▼
                                  <stateDir>/runs/<game>/<runId>/{meta.json,report.json,stdout.log,screens/}
                                                            │  插件每 60s reconcile
                                                            ▼
                                        记录历史 → Windows 通知 → （可选）开汇报会话
```

- headless 侧通过 `--patch` 叠加 overlay 注入 bettergi MCP（原神需要），并带 `DSH_PERMISSION_MODE=danger-full-access` 实现无人值守；崩3/星铁没有 wincu 时按技能说明用提权助手（`scripts/run-step.mjs --ps`）。
- 报告是唯一判定依据：`report.json` 的 `status` 为 `success / partial / failed`；插件只认这个文件，不猜进程退出码。
- **前台守护**：每轮运行开始时，插件从 `automation/keep-foreground.ps1` 起一个 1 秒轮询的守护进程，游戏窗口被别的窗口抢走时立即拉回（四级回退：`SetForegroundWindow` → AttachThreadInput → 模拟 Alt → `SwitchToThisWindow`），结束/停止时写 `.stop` 自动退出；日志在 `<stateDir>/automation/guard-<game>.log`。面板排班卡里有「前台守护」开关（`ui.foregroundGuard`，默认开）。

## HTTP 接口（Host 侧，前缀 `/api/game-daily`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 全部游戏状态 + 任务摘要（计划任务信息走缓存，不阻塞） |
| GET | `/probe?games=genshin,hi` | 依赖体检结果 |
| POST | `/ui` | 保存界面偏好（如 `lastGame`、`reportSessions`） |
| POST | `/apply` | 保存排班并重建计划任务；`{dryRun:true}` 只打印将注册的动作、不落盘 |
| POST | `/disable` | 移除某游戏（或全部）计划任务并关闭开关 |
| POST | `/run` | 立即运行一次：`{game, mode:'real'|'dry'}` |
| POST | `/stop` | 停止该游戏的运行进程 |
| POST | `/run-task` | 立刻触发已注册的计划任务（由任务管理器跑，而不是插件直启） |
| POST | `/install` | 生成修复会话：`{check:'bettergi'}` 或 `{action:'fix-headless-credentials'}` |
| GET | `/runs?game=genshin` | 历史运行摘要 |
| GET | `/run?id=<runId>` | 单次运行的 report/meta/stdout 全文 |
| POST | `/reconcile` | 手动触发一次对账（平时每 60s 自动跑） |

## 数据位置

- 状态与运行产物：`$DSH_HOME/game-daily/`（默认 `%USERPROFILE%\.dsh\game-daily`）
  - `state.json`（原子写）、`runs/<game>/<runId>/`、`automation/{tasks.json,game-daily-register.ps1,register-result.json,headless-overlay.yml,run-headless.log}`、`notifications.log`

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `DSH_HOME` | `%USERPROFILE%\.dsh` | DSH 主目录 |
| `DSH_PROFILE` | `desktop` | 用来检查 headless / 插件的 profile 名 |
| `DSH_SKILLS_ROOT` | `%USERPROFILE%\.agents\skills` | 技能目录（game-daily 家族） |
| `DSH_GAME_DAILY_DEV` | — | `1` = 开发隔离：状态目录加 `/dev`、任务前缀 `game-daily-dev-` |
| `DSH_GAME_DAILY_STATE_DIR` | `$DSH_HOME/game-daily` | 覆盖状态目录 |
| `DSH_GAME_DAILY_TASK_PREFIX` | `game-daily-` | 覆盖计划任务名前缀 |
| `DSH_GAME_DAILY_BETTERGI_MCP` | 自动解析（见下） | bettergi MCP 服务器脚本的显式路径（优先级最高） |
| `DSH_GAME_DAILY_BETTERGI` | `D:\software\BetterGI\BetterGI.exe` | BetterGI 安装位置（体检用） |

## bettergi-mcp 从哪来

原神的 `bgi_*` 工具由独立仓库 [`gychen-NJU/bettergi-mcp`](https://github.com/gychen-NJU/bettergi-mcp) 提供（单文件、零依赖的 MCP 服务器）。插件**不捆绑**它，按以下顺序解析：

1. 环境变量 `DSH_GAME_DAILY_BETTERGI_MCP` 指向的脚本；
2. 插件状态目录下的下载副本：`$DSH_HOME/game-daily/vendor/bettergi-mcp/bettergi-mcp.mjs`；
3. 与本插件同级的 `dsh-betterGI/tools/bettergi-mcp/bettergi-mcp.mjs`（开发者本机布局）。

体检发现没有脚本时，面板给出「下载 bettergi-mcp（从 GitHub）」按钮，点一下就把单文件下载到 (2)；启用原神的排班并点「保存并应用」时也会顺手补齐。要自己 clone 也可以：

```powershell
git clone https://github.com/gychen-NJU/bettergi-mcp
# 然后设置 DSH_GAME_DAILY_BETTERGI_MCP=<clone 目录>\bettergi-mcp.mjs
```

## 依赖与边界

- 原神：BetterGI（默认 `D:\software\BetterGI`，可在面板里改）+ bettergi-mcp（见上）；BetterGI 没有 HTTP API，只能命令行/配置组驱动。
- 崩坏3 / 星铁：`game-daily` 家族技能 + 提权助手（坐标点击被拦时按技能说明改用 computer-use）。
- 没有「后台挂机」：原神必须可见且前台、16:9 ≥1920×1080；锁屏会失败。
- 注册计划任务、跑 BetterGI 需要一次 UAC；面板会在按钮旁说明。
- 账号风险由使用方式决定：官方条款把第三方软件/模拟操作列为封号理由之一，低调使用。

## 开发

```powershell
node test/smoke.mjs          # 纯 Node 冒烟（不触网、不弹 UAC）
node --check index.js        # 语法自检
```

`lib/` 全部是纯 Node 模块（无第三方依赖）；`client.js` 是 Harness 的 lazy client 工厂（`window.__ModuleLoader__.load`），只注册 `settings.section` 一个 slot。

## 许可

[MIT](LICENSE) © 2026 gychen-NJU

