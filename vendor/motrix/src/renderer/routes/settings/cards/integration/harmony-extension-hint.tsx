import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import { isHarmonyShell } from '@renderer/lib/platform-actions'
import { useTranslation } from 'react-i18next'
import { useBridgeStatus } from './use-bridge'

/**
 * HarmonyOS 专属的扩展连接提示（r55）。
 *
 * 与其他平台的区别：鸿蒙上没有 Electron 的 Native Messaging，扩展无法"自动发现"
 * 本机 App，所以走扩展的**远程 Server 模式**——在扩展设置里手动添加
 * `ws://127.0.0.1:<端口>`，再用 Motrix 显示的 8 位配对码完成首次配对。
 *
 * 端口来自 MDXP 桥的实际监听端口（host 启动时固定并写进远程扩展配置），
 * 不是猜的；桥没起来时给一句"通道未启动"，避免用户对着死地址排查。
 */
export function HarmonyExtensionHint() {
  const { t } = useTranslation()
  const status = useBridgeStatus()

  if (!isHarmonyShell()) return null

  const address = status?.port ? `ws://127.0.0.1:${status.port}` : ''

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border px-3 py-3 text-xs leading-5">
      <p className="font-medium text-foreground">
        {t('settings.integration.browser.harmony.title')}
      </p>
      {address ? (
        <>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
              {address}
            </code>
            <CopyButton
              type="button"
              size="xs"
              variant="outline"
              content={address}
              copiedLabel={t('settings.integration.browser.harmony.copied')}
            >
              {t('settings.integration.browser.harmony.copy')}
            </CopyButton>
          </div>
          <ol className="list-decimal space-y-1 ps-5 text-muted-foreground">
            <li>{t('settings.integration.browser.harmony.stepInstall')}</li>
            <li>{t('settings.integration.browser.harmony.stepAddServer')}</li>
            <li>{t('settings.integration.browser.harmony.stepPair')}</li>
          </ol>
          <p className="text-muted-foreground">
            {t('settings.integration.browser.harmony.sideloadNote')}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">
          {t('settings.integration.browser.harmony.notRunning')}
        </p>
      )}
    </div>
  )
}