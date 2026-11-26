import type { MotrixIcon } from '@renderer/components/icons'
import {
  DashboardIcon,
  DownloadLibraryIcon,
  MigrationIcon,
  PluginIcon,
  SettingsIcon,
  TrackerIcon,
} from '@renderer/components/icons'
import { NotificationsNavItem } from '@renderer/components/notification-center/notifications-nav-item'
import { useDirection } from '@renderer/components/ui/direction'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@renderer/components/ui/sidebar'
import { isHarmonyShell } from '@renderer/lib/platform-actions'
import { useLegacyImportNavigation } from '@renderer/features/legacy-import/use-legacy-import-navigation'
import { LEGACY_MIGRATION_ROUTE } from '@shared/lib/legacy-import-navigation'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'

interface NavItem {
  to: string
  icon: MotrixIcon
  labelKey: string
  end?: boolean
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', icon: DashboardIcon, labelKey: 'nav.dashboard', end: true },
  { to: '/downloads', icon: DownloadLibraryIcon, labelKey: 'nav.downloads' },
  { to: '/trackers', icon: TrackerIcon, labelKey: 'nav.trackers' },
  { to: '/plugins', icon: PluginIcon, labelKey: 'nav.plugins' },
] as const

const FOOTER_NAV_ITEMS: readonly NavItem[] = [
  { to: '/settings', icon: SettingsIcon, labelKey: 'nav.settings' },
] as const

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()
  const direction = useDirection()
  const { visible } = useLegacyImportNavigation()
  // HarmonyOS 壳里插件系统不可用（--jitless ⇒ 无 WebAssembly，QuickJS 跑不起来）：
  // 入口直接隐藏，避免用户点进去看到一堆"不可用"。
  const navItems = isHarmonyShell()
    ? NAV_ITEMS.filter((item) => item.to !== '/plugins')
    : NAV_ITEMS
  const items = visible
    ? [
        ...navItems,
        {
          to: LEGACY_MIGRATION_ROUTE,
          icon: MigrationIcon,
          labelKey: 'legacyImport.navigation',
        },
      ]
    : navItems

  return (
    <Sidebar
      variant="inset"
      side={direction === 'rtl' ? 'right' : 'left'}
      {...props}
    >
      <SidebarHeader
        style={{
          height: 45,
        }}
      ></SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.to}>
                    <NavLink to={item.to} end={item.end}>
                      {({ isActive }) => (
                        <SidebarMenuButton
                          render={<span />}
                          isActive={isActive}
                          tooltip={t(item.labelKey)}
                          className="cursor-default"
                        >
                          <Icon />
                          <span className="select-none">
                            {t(item.labelKey)}
                          </span>
                        </SidebarMenuButton>
                      )}
                    </NavLink>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-0.5">
        <SidebarMenu>
          <NotificationsNavItem />
          <SidebarMenuItem aria-hidden="true">
            <SidebarSeparator className="mx-0" />
          </SidebarMenuItem>
          {FOOTER_NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <SidebarMenuItem key={item.to}>
                <NavLink to={item.to} end={item.end}>
                  {({ isActive }) => (
                    <SidebarMenuButton
                      render={<span />}
                      isActive={isActive}
                      tooltip={t(item.labelKey)}
                      className="cursor-default"
                    >
                      <Icon />
                      <span className="select-none">{t(item.labelKey)}</span>
                    </SidebarMenuButton>
                  )}
                </NavLink>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
