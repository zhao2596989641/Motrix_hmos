# 真机测试方法（HarmonyOS PC / 2in1）

> 本项目没有端侧 CI：每轮改动靠"真机装包 + 看日志 + 看界面"验收。
> 这里记录可复用的操作，避免每次重新摸索。

## 1. 安装 / 覆盖安装

`hdc` 在 HarmonyOS 命令行工具里（`<CLT>/sdk/default/openharmony/toolchains/hdc`）。
**必须在用户自己的系统终端里跑**（应用沙箱内 hdc 连不上设备）。

```sh
HDC=<你的命令行工具>/sdk/default/openharmony/toolchains/hdc
$HDC list targets                     # 应输出 127.0.0.1:<port>
$HDC install -r <hap>                 # 覆盖安装，保留数据
$HDC uninstall com.lyldeer.motrix     # 卸载（clean install 测试用）
```

## 2. 日志在哪

应用数据目录（el2）：

```
/data/app/el2/100/base/com.lyldeer.motrix/haps/entry/files/
├── ability-diag.log     # Ability 层：窗口/托盘/深链/退出的诊断行
├── arkts-diag.log       # Web 侧：注入脚本、路由跳转、通知、页面进度
├── node-output.log      # Node 宿主 + Motrix server + aria2 的 stdout/stderr
├── boot-stage.json      # 启动阶段时间线（stages[] 含每步 deltaMs）
├── spawn-probe.json     # 原生件 exec 自检结果（延迟 8s 生成）
├── host-ready.json      # 端口/pid/cookie（0600）
├── host-ready.dev.json  # 同上，仅 debug 包生成（0666，便于脚本读取）
└── motrix/              # 业务数据：settings.json / motrix.db / tray-state.json / deeplink-cmd.jsonl …
```

拉取方式（用户终端）：

```sh
F=/data/app/el2/100/base/com.lyldeer.motrix/haps/entry/files
$HDC file recv $F/node-output.log ./node-output.log
$HDC file recv $F/ability-diag.log ./ability-diag.log
$HDC file recv $F/arkts-diag.log ./arkts-diag.log
```

> 复制不出来时用 `hdc shell "cat $F/xxx.log"` 重定向保存；`*.dev.json` 是 0666，`host-ready.json` 是 0600。

## 3. 常用触发命令

```sh
# 冷启动 / 热启动深链（磁力链）
$HDC shell aa start -a EntryAbility -b com.lyldeer.motrix \
  -U "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny"

# 强杀应用（用于验证孤儿 aria2 清理：杀的时候最好有下载在跑）
$HDC shell aa force-stop com.lyldeer.motrix

# 看应用状态
$HDC shell "ps -A | grep com.lyldeer.motrix"
```

## 4. 验收要点（每轮通用）

1. **引擎**：仪表板显示 Ready；`node-output.log` 有 `aria2 process spawned`。
2. **下载**：小文件能完成、MD5 对得上；暂停/继续/删除/重试都试一遍。
3. **窗口**：拖拽移动、最大化时不能拖、三键避让（隐藏边栏后页头按钮不被压住）。
4. **托盘**：左键面板（三行任务行 / 按钮 / 图表）、右键菜单跳页、关窗收托盘、唤回。
5. **系统集成**：通知横幅、Dock 进度条、深链与 `.torrent`「打开方式」。
6. **回归面**：主题/语言、设置持久化、重启后任务恢复。

## 5. 排障入口

- 启动卡住：先看 `boot-stage.json` 的 `stages[]`（哪一步没到）与 `node-output.log` 末尾
- 引擎起不来：看 `node-output.log` 的 `libs 可执行：aria2c = …` 与 `spawn-probe.json`
- 托盘/面板异常：看 `ability-diag.log` 的 `tray`、`MOTRIX-TRAY`、`quick bar` 相关行
- 深链没反应：看 `ability-diag.log` 的 `deep link (…)` 与 `node-output.log` 的 `深链磁力链 -> status=…`