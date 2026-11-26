#!/usr/bin/env node
// 命令桥 · 客户端（在 **DSH 沙箱** 里跑，由 agent 调用）
//
// 与 server.mjs 配对：把命令交给"用户系统终端"里跑，拿回 stdout/stderr/退出码。
// 存在的唯一理由：沙箱内起不了 hdc server（UDS/libUSB/密钥三重限制），
// 而设备控制（hdc / devecocli device|log|ui）必须在用户域执行。
//
// 用法：
//   node scripts/devbridge/client.mjs --port 29111 --token <t> -- "hdc list targets"
//   node scripts/devbridge/client.mjs --port 29111 --token <t> --cwd ~ --timeout 60000 -- "hdc install -r x.hap"
//   node scripts/devbridge/client.mjs --port 29111 --token <t> --file cmds.txt   # 逐行执行
//
// 退出码：把远端命令的退出码原样返回（0 = 成功）；连不上/协议错 = 200/201/202。

import net from 'node:net'
import fs from 'node:fs'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < args.length) return args[i + 1]
  const inline = args.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return fallback
}
const dartIndex = args.indexOf('--')
const PORT = Number(arg('port', '29111'))
const TOKEN = arg('token', '')
const TIMEOUT = Number(arg('timeout', '120000'))
const CWD = arg('cwd', '')
const FILE = arg('file', '')
const quiet = args.includes('--quiet')

if (!TOKEN) {
  console.error('缺少 --token（由 server.mjs 启动时打印）')
  process.exit(200)
}

function oneShot(cmd) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: PORT })
    socket.setNoDelay(true)
    let buffer = ''
    let stage = 'auth'
    let settled = false
    const done = (payload) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {}
      resolve(payload)
    }
    socket.setTimeout(Math.max(TIMEOUT + 15000, 20000), () => done({ ok: false, code: 201, stderr: '连接超时' }))
    socket.on('error', (error) => done({ ok: false, code: 200, stderr: `连接失败：${error.message}` }))
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let payload
        try {
          payload = JSON.parse(line)
        } catch {
          continue
        }
        if (stage === 'auth') {
          if (!payload.ok) return done({ ok: false, code: 403, stderr: payload.stderr || '认证失败' })
          stage = 'cmd'
          socket.write(`${JSON.stringify({ cmd, cwd: CWD || undefined, timeout: TIMEOUT })}\n`)
          continue
        }
        return done(payload)
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token: TOKEN })}\n`)
    })
  })
}

const cmds = []
if (FILE) {
  const text = fs.readFileSync(FILE, 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim() && !line.trim().startsWith('#')) cmds.push(line)
  }
} else {
  const rest = dartIndex >= 0 ? args.slice(dartIndex + 1) : []
  if (rest.length > 0) cmds.push(rest.join(' '))
}

if (cmds.length === 0) {
  console.error('没有要执行的命令。用法：client.mjs --port --token -- "cmd"')
  process.exit(202)
}

let lastCode = 0
for (const cmd of cmds) {
  const result = await oneShot(cmd)
  if (!quiet) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.note) process.stdout.write(`\n[bridge] ${result.note}\n`)
    process.stdout.write(`\n[bridge] exit=${result.code ?? '?'} ${result.ms ? `in ${result.ms}ms` : ''}\n`)
  } else if (result.stdout) {
    process.stdout.write(result.stdout)
  }
  lastCode = Number(result.code ?? 1)
}
process.exit(Number.isFinite(lastCode) ? lastCode : 1)