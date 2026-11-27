/**
 * 端侧 `@motrix/cli` 的检测与直接安装（r63）。
 *
 * 背景（r59~r62 真机探针结论）：
 *   · `READ_WRITE_USER_FILE` 让应用能读写用户目录；
 *   · `CUSTOM_SANDBOX` 把应用进程从 `u:r:debug_hap:s0` 换到
 *     `u:r:develop_tools_debug_hap:s0`，于是**可以 exec 用户自签的 ELF**
 *     （实测 `~/.harmonybrew/bin/node -v` → v26.12.0、`brew --version` → Homebrew 7.0.9）。
 *
 * 因此这里直接复用 Electron 主进程那套成熟的 `CliToolService`
 * （发现包管理器 → 探测版本 → 直接安装 → 返回下一步状态），
 * 只是把环境变量换成鸿蒙用户目录：HOME / SHELL / PATH 都指向真实用户。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { CliToolService } from '@core/cli/cli-tool-service'

const DEFAULT_USER_HOME = '/storage/Users/currentUser'

function userHome(): string {
  const fromEnv = process.env.MOTRIX_USER_HOME?.trim()
  if (fromEnv && fromEnv.length > 0) return fromEnv
  if (existsSync(DEFAULT_USER_HOME)) return DEFAULT_USER_HOME
  return process.env.HOME ?? '/'
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 端侧可用时返回 true（宿主注入 MOTRIX_CLI_DETECT=1） */
export function cliToolRuntimeEnabled(): boolean {
  return process.env.MOTRIX_CLI_DETECT?.trim() === '1'
}

let cached: CliToolService | null = null

export function getCliToolService(): CliToolService {
  if (cached !== null) return cached
  const home = userHome()
  const brewPrefix =
    process.env.MOTRIX_CLI_BREW_PREFIX?.trim() || path.join(home, '.harmonybrew')
  const shell =
    firstExisting([
      process.env.SHELL ?? '',
      path.join(home, '.harmonybrew', 'bin', 'zsh'),
      '/usr/bin/zsh',
      '/bin/sh',
    ]) ?? '/bin/sh'
  const inheritedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SHELL: shell,
    PATH: [
      path.join(brewPrefix, 'bin'),
      process.env.PATH ?? '/system/bin:/bin:/usr/bin',
    ]
      .filter((entry) => entry.length > 0)
      .join(':'),
  }
  cached = new CliToolService({
    directInstallSupported: true,
    platform: process.platform,
    inheritedEnv,
    neutralDir: home,
  })
  return cached
}