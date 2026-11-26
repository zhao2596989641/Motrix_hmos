import { ArrowUpRightIcon } from '@renderer/components/icons'
import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { Button } from '@renderer/components/ui/button'
import {
  FormDescription,
  FormLabel,
} from '@renderer/components/ui/form'
import {
  type HarmonyAutoStartupStatus,
  harmonyAutoStartupStatus,
  openAutoStartupSettings,
} from '@renderer/lib/platform-actions'
import { cn } from '@renderer/lib/utils'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * HarmonyOS 版「登录时启动」行（替代上游的开关）。
 *
 * 为什么不是开关：`autoStartupManager` 只有查询接口，没有设置接口——
 * 三方应用在鸿蒙上**无法**自行开启开机自启，必须由用户到
 * 「设置 → 应用和元服务 → 应用启动管理」手动添加。
 * 所以这里显示当前状态，并给一个跳转系统设置的按钮（Clash 鸿蒙版同样的做法）。
 */
export function HarmonyAutostartRow() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<HarmonyAutoStartupStatus>(() =>
    harmonyAutoStartupStatus()
  )

  useEffect(() => {
    const refresh = () => setStatus(harmonyAutoStartupStatus())
    // 原生壳查到状态后会派发这个事件（见 Index.ets 的 __motrixSetPlatform）
    window.addEventListener('motrix-platform-change', refresh)
    // 从系统设置返回时也刷新一次（窗口重新获得焦点）
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      window.removeEventListener('motrix-platform-change', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <SettingsFormRow>
      <div className="space-y-1">
        <FormLabel>{t('settings.general.launchAtStartup')}</FormLabel>
        <FormDescription className="text-xs">
          {t('settings.general.harmonyAutostartDesc')}
        </FormDescription>
        {status !== 'unknown' && (
          <p
            className={cn(
              'text-xs',
              status === 'enabled'
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground'
            )}
          >
            {t(`settings.general.harmonyAutostartStatus.${status}`)}
          </p>
        )}
        {status === 'unsupported' && (
          <p className="text-xs text-muted-foreground">
            {t('settings.general.harmonyAutostartUnsupportedHint')}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => openAutoStartupSettings()}
      >
        {t('settings.general.harmonyAutostartOpen')}
        <ArrowUpRightIcon aria-hidden="true" className="size-3" />
      </Button>
    </SettingsFormRow>
  )
}