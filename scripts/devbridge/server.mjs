#!/usr/bin/env node
// 命令桥 · 服务端（**在用户的系统终端里跑**）
//
// 为什么需要它：
//   DSH 的 shell 在应用沙箱（u:r:develop_tools_debug_hap）里，起不了 hdc server
//   （UDS /data/hdc/... 无写权限 + libusb 不可用 + 缺 hdc 密钥），所以设备控制类命令
//   （hdc / devecocli device|log|ui）只能在**用户域**执行。
//   本机没有 sshd，无法 SSH 进来；于是用"回环 TCP + 共享 token"做一个最小命令桥：
//   用户在终端起它，沙箱侧的 client.mjs 连 127.0.0.1，把命令交给用户域执行。
//
// 安全边界（务必保持）：
//   · 只 bind 127.0.0.1，不对外网暴露；
//   · 必须有 token（不传就随机生成并打印）；
//   · 每条命令都写审计日志（谁在什么时候跑了什么、退出码、耗时）；
//   · 用户随时 Ctrl-C 关掉，桥就没了；
//   · 空闲 --idle-exit-minutes 分钟后自动退出（默认 120）。
//
// 用法（在系统终端）：
//   node scripts/devbridge/server.mjs --port 29111
//   # → listening on 127.0.0.1:29111  token=xxxx
//   # 把 token 发给 agent，agent 那边：
//   node scripts/devbridge/client.mjs --port 29111 --token xxxx -- "hdc list targets"

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import os from 'node:os'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < args.length) return args[i + 1]
  const inline = args.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return fallback
}

const PORT = Number(arg('port', '29111'))
const TOKEN = arg('token', '') || randomBytes(16).toString('hex')
const MAX_OUTPUT = Number(arg('max-output', String(8 * 1024 * 1024)))
const IDLE_EXIT_MIN = Number(arg('idle-exit-minutes', '120'))
const AUDIT = arg('audit', path.join(os.homedir(), 'Documents', 'codes', 'Motrix', 'logs', 'devbridge-audit.log'))
// 可选：只允许前缀匹配的命令（默认不限制，因为这是自用机器上的合作式桥）
const ALLOW = (arg('allow', '') || '').split(',').filter((s) => s.trim().length > 0)

function audit(line) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true })
    fs.appendFileSync(AUDIT, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text
  return `${text.slice(0, MAX_OUTPUT)}\n…[输出被截断，原始长度 ${text.length} 字节]`
}

function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code, extra) => {
      if (settled) return
      settled = true
      resolve({
        ok: code === 0,
        code: code === null ? -1 : code,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        ms: Date.now() - started,
        ...(extra ? { note: extra } : {}),
      })
    }
    if (ALLOW.length > 0 && !ALLOW.some((prefix) => cmd.trim().startsWith(prefix.trim()))) {
      finish(126, `命令不在允许清单内（--allow ${ALLOW.join(',')}）`)
      return
    }
    let child
    try {
      child = spawn('/bin/sh', ['-c', cmd], {
        cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(127, String(error && error.message))
      return
    }
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += chunk.toString()
    })
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
          finish(124, `超时（${timeoutMs}ms），已 SIGKILL`)
        }, timeoutMs)
      : null
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      finish(127, String(error && error.message))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      finish(code)
    })
  })
}

let lastActivity = Date.now()
const server = net.createServer((socket) => {
  socket.setNoDelay(true)
  socket.setEncoding('utf8')
  let buffer = ''
  let authed = false
  lastActivity = Date.now()

  socket.on('data', async (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      lastActivity = Date.now()
      let request
      try {
        request = JSON.parse(line)
      } catch {
        socket.write(`${JSON.stringify({ ok: false, code: 2, stderr: '请求不是合法 JSON' })}\n`)
        continue
      }
      if (!authed) {
        if (request.token !== TOKEN) {
          audit(`REJECT bad-token from ${socket.remoteAddress}`)
          socket.write(`${JSON.stringify({ ok: false, code: 403, stderr: 'token 不匹配' })}\n`)
          socket.destroy()
          return
        }
        authed = true
        socket.write(`${JSON.stringify({ ok: true, hello: 'motrix-devbridge', cwd: os.homedir() })}\n`)
        continue
      }
      const cmd = String(request.cmd ?? '')
      const timeout = Number(request.timeout ?? 120_000)
      audit(`RUN cwd=${request.cwd ?? '-'} timeout=${timeout} cmd=${JSON.stringify(cmd)}`)
      const result = await runCommand(cmd, request.cwd, timeout)
      audit(`DONE code=${result.code} ms=${result.ms} cmd=${JSON.stringify(cmd)}`)
      socket.write(`${JSON.stringify(result)}\n`)
    }
  })
  socket.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`motrix-devbridge 监听 127.0.0.1:${PORT}`)
  console.log(`token = ${TOKEN}`)
  console.log(`审计日志：${AUDIT}`)
  console.log(`空闲 ${IDLE_EXIT_MIN} 分钟自动退出；Ctrl-C 随时关闭`)
})

setInterval(() => {
  if (Date.now() - lastActivity > IDLE_EXIT_MIN * 60_000) {
    console.log('空闲超时，退出')
    process.exit(0)
  }
}, 30_000).unref()