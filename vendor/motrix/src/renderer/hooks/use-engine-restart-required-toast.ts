import { toast } from '@renderer/components/ui/toast'
import { onSettingsSaved } from '@renderer/lib/settings-save'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

export const ENGINE_RESTART_REQUIRED_TOAST_ID = 'engine-restart-required'

/** Show one coalesced, action-bearing reminder until the engine is Ready again. */
export function useEngineRestartRequiredToast(): void {
  const { t } = useTranslation()
  // `LanguageSync` calls `i18n.changeLanguage()` on every app start, which
  // bumps `t`'s identity via react-i18next even for the same language. Thread
  // `t` through a ref and subscribe exactly once (empty deps) so that identity
  // change never tears down + re-attaches the transport listeners (which would
  // also reset `reminderVisible`). Mirrors use-pair-request-prompts.tsx.
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    let restartPending = false
    let reminderVisible = false

    const restartAction = () => {
      if (restartPending) return
      restartPending = true
      toast.update(ENGINE_RESTART_REQUIRED_TOAST_ID, {
        actionProps: {
          children: tRef.current(
            'notification.engineRestartRequired.restartNow'
          ),
          disabled: true,
          'aria-busy': true,
          onClick: restartAction,
        },
      })
      // HarmonyOS 移植：给用户**即时反馈**。真机上重启要 5~10 秒（停止 aria2 + 等端口
      // 释放 + 重新拉起），期间如果按钮只是"变灰"，用户会以为没反应。
      // Base UI 的 toast：`add()` 返回 id，`timeout: 0` = 不自动消失。
      const progressId = toast.add({
        type: 'info',
        title: tRef.current('notification.engineRestartRequired.restartingTitle'),
        description: tRef.current('notification.engineRestartRequired.restartingBody'),
        timeout: 0,
      })
      void transport
        .invoke(Commands.RestartEngine)
        // 原来这里 `.catch(() => {})` 把失败吞得干干净净，真机上"点了立即重启没反应"
        // 时完全没有线索。现在成功/失败都替换掉那条"进行中"的提示。
        .then(() => {
          toast.close(progressId)
          toast.add({
            type: 'success',
            title: tRef.current('notification.engineRestartRequired.restartDoneTitle'),
            description: tRef.current('notification.engineRestartRequired.restartDoneBody'),
            timeout: 4000,
          })
        })
        .catch((error: unknown) => {
          console.error('[engine-restart] RestartEngine failed:', error)
          toast.close(progressId)
          toast.add({
            type: 'error',
            title: tRef.current('notification.engineRestartRequired.restartFailedTitle'),
            description: String((error as Error)?.message ?? error),
            timeout: 8000,
          })
        })
        .finally(() => {
          restartPending = false
          if (!reminderVisible) return
          toast.update(ENGINE_RESTART_REQUIRED_TOAST_ID, {
            actionProps: {
              children: tRef.current(
                'notification.engineRestartRequired.restartNow'
              ),
              disabled: false,
              onClick: restartAction,
            },
          })
        })
    }

    const onRestartRequired = () => {
      if (reminderVisible) return
      reminderVisible = true
      toast.close(ENGINE_RESTART_REQUIRED_TOAST_ID)
      toast.add({
        id: ENGINE_RESTART_REQUIRED_TOAST_ID,
        title: tRef.current('notification.engineRestartRequired.title'),
        description: tRef.current('notification.engineRestartRequired.body'),
        type: 'warning',
        timeout: 0,
        actionProps: {
          children: tRef.current(
            'notification.engineRestartRequired.restartNow'
          ),
          disabled: restartPending,
          onClick: restartAction,
        },
      })
    }

    const onEngineStateChanged = (...args: unknown[]) => {
      if (args[0] === EngineState.Ready) {
        reminderVisible = false
        toast.close(ENGINE_RESTART_REQUIRED_TOAST_ID)
      }
    }

    transport.on(Events.EngineRestartRequired, onRestartRequired)
    transport.on(Events.EngineStateChanged, onEngineStateChanged)
    const stopSettingsSync = onSettingsSaved((result) => {
      if (result.requiresRestart) onRestartRequired()
    })
    return () => {
      reminderVisible = false
      stopSettingsSync()
      transport.off(Events.EngineRestartRequired, onRestartRequired)
      transport.off(Events.EngineStateChanged, onEngineStateChanged)
    }
  }, [])
}
