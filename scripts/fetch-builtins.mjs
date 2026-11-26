#!/usr/bin/env node
// 把官方内置插件（motrix.filename-template / motrix.url-resolver …）取到 dist/builtin-plugins。
//
// 为什么需要这层包装（r52）：上游 `vendor/motrix/scripts/fetch-builtins.mjs` 里的下载在
// 本机走 undici fetch 会一路 "fetch failed"（重试 5 次都失败），但 Node 原生 fetch 抓同一个
// GitHub Release 资产是 200 —— 于是这里用原生 fetch 先下到本地缓存目录，再以
// `MOTRIX_BUILTIN_ARTIFACT_DIR` 交给上游脚本做 **sha256 + Ed25519 签名** 校验和解包。
//
// 产物：vendor/motrix/dist/builtin-plugins/<id>/（registry 会按 builtin 扫描，UI 里显示"已安装"）
// 缓存：build/builtin-artifacts/（gitignore，locakfile 变化才重下）
//
// 用法：node scripts/fetch-builtins.mjs [--force]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const VENDOR = path.join(ROOT, 'vendor/motrix')
const LOCK = path.join(VENDOR, 'scripts/builtins.lock.json')
const CACHE = path.join(ROOT, 'build/builtin-artifacts')
const force = process.argv.includes('--force')

const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
fs.mkdirSync(CACHE, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function download(url, target) {
  let lastError
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(target, bytes)
      return bytes.length
    } catch (error) {
      lastError = error
      await sleep(500 * 2 ** attempt)
    }
  }
  throw new Error(`${url}: ${lastError && lastError.message}`)
}

let downloaded = 0
for (const [id, entry] of Object.entries(lock.plugins)) {
  for (const suffix of ['', '.sig']) {
    const file = `${entry.file}${suffix}`
    const target = path.join(CACHE, file)
    if (!force && fs.existsSync(target)) continue
    const url = `https://github.com/${lock.repo}/releases/download/${entry.tag}/${entry.file}${suffix}`
    try {
      const size = await download(url, target)
      console.log(`[builtins] 下载 ${id}${suffix || ' moext'} (${size} B)`)
      downloaded += 1
    } catch (error) {
      console.error(`[builtins] ✗ ${url}\n  ${error.message}`)
      process.exit(1)
    }
  }
}
if (downloaded === 0) console.log('[builtins] 缓存已是最新（--force 可强制重下）')

const upstream = path.join(VENDOR, 'scripts/fetch-builtins.mjs')
const result = spawnSync(process.execPath, [upstream], {
  cwd: VENDOR,
  stdio: 'inherit',
  env: { ...process.env, MOTRIX_BUILTIN_ARTIFACT_DIR: CACHE },
})
if (result.status !== 0) {
  console.error('[builtins] 上游 fetch-builtins 校验/解包失败')
  process.exit(result.status ?? 1)
}
