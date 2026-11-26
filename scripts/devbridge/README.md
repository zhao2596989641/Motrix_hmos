# devbridge · 用户域命令桥

## 为什么需要它

DSH 的 shell 跑在**应用沙箱**里（域 `u:r:develop_tools_debug_hap:s0`），起不了 hdc server：

```
libusb_init failed ctxUSB is nullptr
IsEncryptedPEM: open private key file failed
SetUdsListen: bind uds addr fail! ret:-13 (EACCES)
```

而设备控制（`hdc install/shell`、`devecocli device/log/ui`）必须在**用户域**执行。
本机没有 `sshd`（只有 ssh 客户端），SSH 接不进来；于是用「回环 TCP + token」做桥：
**你在系统终端起 server，agent 在沙箱里用 client 连 127.0.0.1 发命令。**

## 你在系统终端跑（一次；可挂后台）

```sh
cd /storage/Users/currentUser/Documents/codes/Motrix/codes/MotrixOHOS
export PATH=/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/sdk/default/openharmony/toolchains:$PATH
/storage/Users/currentUser/.harmonybrew/bin/node scripts/devbridge/server.mjs --port 29111
```

它会打印：

```
motrix-devbridge 监听 127.0.0.1:29111
token = <32位随机串>
审计日志：/storage/Users/currentUser/Documents/codes/Motrix/logs/devbridge-audit.log
```

**把 token 发给 agent**，agent 就能在用户域执行命令。Ctrl-C 关闭；默认空闲 120 分钟自动退出。

## agent 侧用法（沙箱内）

```sh
node scripts/devbridge/client.mjs --port 29111 --token <t> -- "hdc list targets"
node scripts/devbridge/client.mjs --port 29111 --token <t> --timeout 300000 --cwd ~ -- "hdc install -r xxx.hap"
node scripts/devbridge/client.mjs --port 29111 --token <t> --file cmds.txt   # 逐行执行
```

## 安全边界

- 只 bind `127.0.0.1`，不对局域网/外网开放；
- 必须带 token（不传就随机生成并打印）；
- 每条命令写审计日志（时间、命令、退出码、耗时）；
- 可用 `--allow "hdc,devecocli,ls,cat"` 收窄允许的命令前缀；
- 你随时 Ctrl-C 关掉。

## 自检（在沙箱里验证协议本身，不需要用户参与）

```sh
node scripts/devbridge/server.mjs --port 29111 --token t > /tmp/b.log 2>&1 &
node scripts/devbridge/client.mjs --port 29111 --token t -- "echo ok"
```