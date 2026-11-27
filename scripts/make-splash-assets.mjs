#!/usr/bin/env node
// 生成启动页专用图片资源（r56）。
//
// 为什么需要：`startWindowIcon` 是"放多大画多大"，直接指向 512×512 的 startIcon，
// 系统启动页会显示一个巨大 logo；等我们的 ArkUI 开屏页出现时缩到 112vp，
// 观感就是"大 logo → 小 logo → 网页字标"三段跳。
//
// 做法：改用增强启动页（startWindow profile）的**整窗背景图**，把 logo 预先合成进去；
// 同时 ArkUI 开屏页用同一张图全屏 Contain 渲染，两边像素级一致，切换无跳变。
//
// 产物：
//   entry/src/main/resources/base/media/splash_background.png   （浅色，1200×800）
//   entry/src/main/resources/dark/media/splash_background.png   （深色，1200×800）
//   entry/src/main/resources/base/media/start_window_icon.png   （简易启动页兜底，192×192）
//   entry/src/main/resources/dark/media/start_window_icon.png   （同上）
//
// 用法：node scripts/make-splash-assets.mjs

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BASE = path.join(ROOT, 'entry/src/main/resources/base/media')
const DARK = path.join(ROOT, 'entry/src/main/resources/dark/media')

const LIGHT_BG = [0xff, 0xff, 0xff]
const DARK_BG = [0x1b, 0x1b, 0x1f]
const LOGO_PX = 176
const CANVAS_W = 1200
const CANVAS_H = 800
const ICON_FALLBACK_PX = 192

// ── PNG 解码（只支持 8-bit RGBA/RGB、非隔行，够本项目用）──────────────────────
function readU32(buf, offset) {
  return buf.readUInt32BE(offset)
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function decodePng(buffer) {
  if (readU32(buffer, 0) !== 0x89504e47) throw new Error('不是 PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = readU32(buffer, offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (bitDepth !== 8) throw new Error(`只支持 8-bit，实际 ${bitDepth}`)
      if (data[12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (channels === 0) throw new Error(`不支持的 colorType ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0
      const up = prev[i]
      const upLeft = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      switch (filter) {
        case 0:
          break
        case 1:
          value = (value + left) & 0xff
          break
        case 2:
          value = (value + up) & 0xff
          break
        case 3:
          value = (value + ((left + up) >> 1)) & 0xff
          break
        case 4:
          value = (value + paeth(left, up, upLeft)) & 0xff
          break
        default:
          throw new Error(`未知 PNG filter ${filter}`)
      }
      line[i] = value
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels
      const dst = (y * width + x) * 4
      if (channels === 4) {
        out[dst] = line[src]
        out[dst + 1] = line[src + 1]
        out[dst + 2] = line[src + 2]
        out[dst + 3] = line[src + 3]
      } else if (channels === 3) {
        out[dst] = line[src]
        out[dst + 1] = line[src + 1]
        out[dst + 2] = line[src + 2]
        out[dst + 3] = 0xff
      } else {
        out[dst] = line[src]
        out[dst + 1] = line[src]
        out[dst + 2] = line[src]
        out[dst + 3] = 0xff
      }
    }
    prev = line
  }
  return { width, height, data: out }
}

// ── PNG 编码（RGBA8，每行 filter 0）──────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 缩放 + 合成 ─────────────────────────────────────────────────────────────
function resizeBilinear(image, targetW, targetH) {
  const out = Buffer.alloc(targetW * targetH * 4)
  const scaleX = image.width / targetW
  const scaleY = image.height / targetH
  for (let y = 0; y < targetH; y += 1) {
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(image.height - 1, y0 + 1)
    const wy = sy - y0
    for (let x = 0; x < targetW; x += 1) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(image.width - 1, x0 + 1)
      const wx = sx - x0
      const dst = (y * targetW + x) * 4
      for (let c = 0; c < 4; c += 1) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + c]
        const p10 = image.data[(y0 * image.width + x1) * 4 + c]
        const p01 = image.data[(y1 * image.width + x0) * 4 + c]
        const p11 = image.data[(y1 * image.width + x1) * 4 + c]
        const top = p00 * (1 - wx) + p10 * wx
        const bottom = p01 * (1 - wx) + p11 * wx
        out[dst + c] = Math.round(top * (1 - wy) + bottom * wy)
      }
    }
  }
  return out
}

function composite(canvasW, canvasH, bg, logo, logoW, logoH) {
  const out = Buffer.alloc(canvasW * canvasH * 4)
  for (let i = 0; i < canvasW * canvasH; i += 1) {
    out[i * 4] = bg[0]
    out[i * 4 + 1] = bg[1]
    out[i * 4 + 2] = bg[2]
    out[i * 4 + 3] = 0xff
  }
  const offsetX = Math.round((canvasW - logoW) / 2)
  const offsetY = Math.round((canvasH - logoH) / 2)
  for (let y = 0; y < logoH; y += 1) {
    for (let x = 0; x < logoW; x += 1) {
      const src = (y * logoW + x) * 4
      const dst = ((offsetY + y) * canvasW + offsetX + x) * 4
      const alpha = logo[src + 3] / 255
      if (alpha <= 0) continue
      out[dst] = Math.round(logo[src] * alpha + out[dst] * (1 - alpha))
      out[dst + 1] = Math.round(logo[src + 1] * alpha + out[dst + 1] * (1 - alpha))
      out[dst + 2] = Math.round(logo[src + 2] * alpha + out[dst + 2] * (1 - alpha))
      out[dst + 3] = 0xff
    }
  }
  return out
}

// ── main ────────────────────────────────────────────────────────────────────
const source = decodePng(fs.readFileSync(path.join(BASE, 'startIcon.png')))
const logo = resizeBilinear(source, LOGO_PX, LOGO_PX)
const iconFallback = resizeBilinear(source, ICON_FALLBACK_PX, ICON_FALLBACK_PX)

fs.mkdirSync(DARK, { recursive: true })
fs.writeFileSync(
  path.join(BASE, 'splash_background.png'),
  encodePng(CANVAS_W, CANVAS_H, composite(CANVAS_W, CANVAS_H, LIGHT_BG, logo, LOGO_PX, LOGO_PX))
)
fs.writeFileSync(
  path.join(DARK, 'splash_background.png'),
  encodePng(CANVAS_W, CANVAS_H, composite(CANVAS_W, CANVAS_H, DARK_BG, logo, LOGO_PX, LOGO_PX))
)
fs.writeFileSync(
  path.join(BASE, 'start_window_icon.png'),
  encodePng(ICON_FALLBACK_PX, ICON_FALLBACK_PX, iconFallback)
)
fs.writeFileSync(
  path.join(DARK, 'start_window_icon.png'),
  encodePng(ICON_FALLBACK_PX, ICON_FALLBACK_PX, iconFallback)
)
console.log('splash assets written')