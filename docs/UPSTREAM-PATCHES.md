# 上游补丁清单（`vendor/motrix/` 里的移植改动）

> `vendor/motrix/` 是 **Motrix Turbo 2.4.5 上游快照**，原则上不改上游业务代码。
> 但有两类改动无法避免，必须记录在这里，方便：① 升级上游时逐条复查；② 排查问题时知道哪些不是上游行为。
>
> 判定方法：源码里带 **`HarmonyOS 移植`** / `鸿蒙` 注释的即为本清单条目；
> 新增文件用「＋」，修改文件用「～」。

## 1. 平台判定与注入值（渲染层）

| 文件 | 类型 | 改了什么 |
|---|---|---|
| `src/renderer/lib/platform-actions.ts` | ＋ | 平台动作桥：读原生壳注入的 `window.__MOTRIX_PLATFORM__`（`language`/`colorMode`/`portVersion`/**`pluginRuntime`**），提供 `isHarmonyShell()`、`harmonyPortVersion()`、`pluginsRuntimeAvailable()`、`supportsHostFileActions()`；`reveal/open/外链` 动作编码成 `motrix-action://` 私有 scheme 由 ArkTS `onLoadIntercept` 接管 |
| `src/renderer/routes/plugins/plugins-page.tsx` | ～ | **r47**：`pluginsRuntimeAvailable() === false` 时页面顶部显示横幅（端侧插件沙箱不可用、插件保留但不激活、下载不受影响）；文案在 `locales/{en-US,zh-CN}.json` 的 `plugins.runtimeUnavailable` |
| `src/renderer/lib/platform-bridge.ts` | ～ | 同上，宿主动作桥的渲染层出口 |
| `src/renderer/lib/initial-theme.ts` | ～ | ArkWeb 的 `prefers-color-scheme` 不可靠 → 初始主题读注入值 |
| `src/renderer/components/language-sync.tsx` | ～ | 语言跟随系统/注入值（ArkWeb `navigator.language` 不可靠） |
| `src/renderer/lib/i18n.ts` | ～ | 语言解析适配 |
| `src/renderer/lib/transport/http-ws.ts` | ～ | ① 纯 JS web 传输（本机就是 web 形态）；② r45 新增**只读诊断**：`query burst`（≥5 条读在飞）/ `slow query`（≥3s），仅鸿蒙壳、每类 ≤12 行 |
| `src/renderer/lib/open-task-file.ts` | ～ | 「打开文件/显示位置」走平台动作桥（web 上上游恒为 false，菜单项本会消失） |
| `src/renderer/lib/platform-actions.ts` | ～ | **r54**：新增 `harmonyAutoStartupStatus()` 与 `openAutoStartupSettings()`（前者读壳注入的平台值，后者发 `motrix-action://autostart`） |
| `src/renderer/platform/web-services.ts` / `platform/nas.ts` | ～ | NAS/Synology 分支在端侧恒不启用 |

## 2. 引擎与状态（渲染层）

| 文件 | 类型 | 改了什么 |
|---|---|---|
| `src/renderer/hooks/use-engine-display-status.ts` | ～ | **r45 重写为模块级单例 store**：全局一份快照 + 最多 1 条在飞读、失败退避 5s→30s、事件流为主通道。原因：ArkWeb 同 host 仅 6 条连接，原"每挂载 2 条读"在切页时压满连接池 → 卡"引擎启动中" |
| `src/renderer/hooks/use-engine-restart-required-toast.ts` | ～ | 重启提示的阈值/时序适配（端侧引擎启动慢） |
| `src/core/plugin/host/activation-dispatcher.ts` | ～ | **r47**：`WebAssembly === undefined`（端侧 jitless）时跳过插件激活并只告警一次——否则 QuickJS 沙箱必失败，critical hook 会让整条下载任务 abort |
| `src/core/plugin/hooks/hook-orchestrator.ts` | ～ | **r47**：`abortsChainOnFailure()` 在无 WebAssembly 时一律返回 false（fail-open），保证插件故障不拖垮下载 |
| `src/renderer/components/ui/toast.tsx` | ～ | Toast 顶部下移，避让系统三键区域 |

## 3. 入口可见性（渲染层）

| 文件 | 类型 | 改了什么 |
|---|---|---|
| `src/renderer/routes/downloads/global-stats-bar.tsx` | ～ | 只隐藏「完成后关机」菜单（`DownloadsMoreMenu`），其余徽章保留 |
| `src/renderer/routes/settings/cards/about-dialog.tsx` | ～ | 版本旁 `HarmonyOS Port rNN` 徽章（**r54 起与 `2.4.5` 中轴对齐**）；**r54：更新区域 + 自动检查开关在鸿蒙壳整块不渲染**，`useAppUpdate(false)` 不再查询更新状态；r42 的「开机自启提示」段已删除（改到设置→通用，见下） |
| `src/renderer/routes/settings/cards/general-dialog.tsx` | ～ | **r54**：鸿蒙壳在「启动与退出」里插入 `HarmonyAutostartRow`（状态 + 跳转系统设置按钮），替代上游开关 |
| `src/renderer/routes/settings/cards/harmony-autostart-row.tsx` | ＋ | **r54 新增**：开机自启行。显示 `__MOTRIX_PLATFORM__.autoStartup`（enabled/disabled/unsupported/unknown）+ 监听 `motrix-platform-change` 刷新；按钮发 `motrix-action://autostart` |
| `src/renderer/routes/dashboard/components/dashboard-grid.tsx` | ～ | 仪表板页头 tooltip 朝向改为 `bottom`（默认朝上会顶到窗口三键区域） |
| `src/renderer/routes/dashboard/activity/activity-calendar.tsx` | ～ | 活动日历的日期/性能适配（jitless 下渲染开销） |
| `src/renderer/index.tsx` | ～ | 启动引导补丁（平台值、启动守卫/看门狗） |
| `src/shared/locales/{en-US,zh-CN}.json` | ～ | 移植专属文案（其它语言 fallback 英文）：**r54** 新增 `settings.general.harmonyAutostart{Desc,Open,UnsupportedHint,Status.*}`；删除已废弃的 `settings.about.harmonyAutostartHint` |

## 4. 服务端（`src/server/`、`src/core/`）

| 文件 | 类型 | 改了什么 |
|---|---|---|
| `src/server/index.ts` | ～ | 安装**原生通知桥**（文件队列 → ArkTS 系统通知）；必须用静态 import（动态 import 不会被 vite 收进端侧 bundle）；失败只记日志不阻断启动 |
| `src/server/native-notify-bridge.ts` | ～ | 通知走原生壳的文件队列（`notify-queue.jsonl`）而不是 Electron |
| `src/core/engine/aria2/aria2-process-manager.ts` | ～ | 修两个上游历史 bug（真机踩到）：① `gracefulStop` 超时分支 `SIGKILL` 后不 resolve ⇒ 重启引擎永久卡在 stopping；② `kill('SIGTERM')` 无 try-catch（ESRCH/EPERM）同样永久 pending。现在任何路径都保证 resolve |
| `src/core/engine/engine-supervisor.ts` | ～ | 记录**实际**连上 RPC 的端口（可能因端口顺延而与 settings 里的值不同），诊断/重启据此判断 |
| `src/core/notifications/notification-center.ts` | ～ | 加系统通知转发钩子（钩子为 null 时是空操作，桌面形态不受影响） |
| `src/renderer/components/desktop-kit/cubic-glass/renderer.ts` | ～ | 玻璃/K 线渲染的 WebGL 细节适配（ArkWeb GPU 差异） |

## 5. 构建期（不是运行时行为）

- `package.json`：`packageManager` 版本、`cssMinify` 关闭（lightningcss 原生件在鸿蒙不可用）
  —— 只为能在本机构建，不影响产物逻辑。
- `dist/server/index.mjs` 与 `dist/renderer-web` **由上述源码构建而来**，不入库（`.gitignore`）。

## 6. 升级上游时怎么复查

1. 用上游新版本替换 `vendor/motrix/`，先按 `docs/BUILD.md` 出一次包（不应用本清单）。
2. 逐条对照本表把改动重新应用（每处源码都有 `HarmonyOS 移植` 注释可 grep）。
3. 重点回归：平台值注入（语言/主题/轮次徽章）、`motrix-action://` 动作、引擎状态 store、
   入口可见性（只隐藏完成后关机）、只读诊断日志。
4. 上游若已实现同等能力，删掉对应补丁而不是叠加（避免双份逻辑）。