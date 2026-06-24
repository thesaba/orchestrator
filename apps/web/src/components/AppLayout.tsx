import { Frame, Navigation, TopBar, Toast, Icon } from '@shopify/polaris'
import {
  HomeIcon, GlobeIcon, ChartVerticalIcon, SettingsIcon,
  MoonIcon, SunIcon, SearchIcon
} from '@shopify/polaris-icons'
import { ReactNode, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ToastContext, ToastOptions } from '../context/toast'
import { useTheme } from '../context/ThemeContext'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { CommandPalette } from './CommandPalette'

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileNavOpen,   setMobileNavOpen]   = useState(false)
  const [userMenuOpen,    setUserMenuOpen]     = useState(false)
  const [paletteOpen,     setPaletteOpen]      = useState(false)
  const [toastState,      setToastState]       = useState<{ content: string; error?: boolean } | null>(null)
  const { logout } = useAuth()
  const navigate   = useNavigate()
  const { pathname } = useLocation()
  const { colorScheme, toggleColorScheme } = useTheme()

  const showToast = useCallback((content: string, options: ToastOptions = {}) => {
    setToastState({ content, error: options.error })
  }, [])

  const handleLogout = useCallback(() => { logout(); navigate('/login') }, [logout, navigate])

  // ⌘K → command palette
  useKeyboardShortcuts([
    { key: 'k', meta: true, handler: () => setPaletteOpen(true) },
    { key: '/', handler: () => setPaletteOpen(true) }
  ])

  const nav = (
    <Navigation location={pathname}>
      <Navigation.Section
        items={[
          { label: 'Dashboard',  icon: HomeIcon,           url: '/',           exactMatch: true },
          { label: 'Sites',      icon: GlobeIcon,          url: '/sites' },
          { label: 'Monitoring', icon: ChartVerticalIcon,  url: '/monitoring' },
          { label: 'Settings',   icon: SettingsIcon,       url: '/settings' }
        ]}
      />
    </Navigation>
  )

  const topBar = (
    <TopBar
      showNavigationToggle
      onNavigationToggle={() => setMobileNavOpen((p) => !p)}
      searchField={
        <TopBar.SearchField
          placeholder="Search (/) or ⌘K for commands"
          value=""
          onChange={() => {}}
          onFocus={() => setPaletteOpen(true)}
        />
      }
      secondaryMenu={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingRight: 8 }}>
          <button
            onClick={toggleColorScheme}
            title={colorScheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '6px',
              borderRadius: 6, display: 'flex', alignItems: 'center',
              color: colorScheme === 'dark' ? '#e4e4e7' : '#1a1a2e',
              opacity: 0.8
            }}
          >
            <Icon source={colorScheme === 'dark' ? SunIcon : MoonIcon} />
          </button>
        </div>
      }
      userMenu={
        <TopBar.UserMenu
          actions={[{
            items: [
              { content: '⌘K — Command palette', onAction: () => setPaletteOpen(true) },
              { content: 'Logout', onAction: handleLogout }
            ]
          }]}
          name="Admin"
          initials="A"
          open={userMenuOpen}
          onToggle={() => setUserMenuOpen((p) => !p)}
        />
      }
    />
  )

  return (
    <ToastContext.Provider value={showToast}>
      <Frame
        navigation={nav}
        topBar={topBar}
        showMobileNavigation={mobileNavOpen}
        onNavigationDismiss={() => setMobileNavOpen(false)}
      >
        {children}
        {toastState && (
          <Toast content={toastState.content} error={toastState.error} onDismiss={() => setToastState(null)} />
        )}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </Frame>
    </ToastContext.Provider>
  )
}
