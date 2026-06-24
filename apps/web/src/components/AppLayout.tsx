import { Frame, Navigation, TopBar, Toast } from '@shopify/polaris'
import { HomeIcon, GlobeIcon, ChartVerticalIcon, SettingsIcon } from '@shopify/polaris-icons'
import { ReactNode, useState, useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ToastContext, ToastOptions } from '../context/toast'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { CommandPalette } from './CommandPalette'
import { api } from '../api/client'

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [userMenuOpen,  setUserMenuOpen]  = useState(false)
  const [paletteOpen,   setPaletteOpen]   = useState(false)
  const [panelTitle,    setPanelTitle]    = useState('Orchestrator')
  const [toastState,    setToastState]    = useState<{ content: string; error?: boolean } | null>(null)

  const { logout } = useAuth()
  const navigate   = useNavigate()
  const { pathname } = useLocation()

  const showToast = useCallback((content: string, options: ToastOptions = {}) => {
    setToastState({ content, error: options.error })
  }, [])

  const handleLogout = useCallback(() => { logout(); navigate('/login') }, [logout, navigate])

  useEffect(() => {
    api.settings.get()
      .then((s) => { if (s.panel_title?.trim()) setPanelTitle(s.panel_title.trim()) })
      .catch(() => {})
  }, [])

  // ⌘K / / → command palette
  useKeyboardShortcuts([
    { key: 'k', meta: true, handler: () => setPaletteOpen(true) },
    { key: '/', handler: () => setPaletteOpen(true) }
  ])

  const contextControl = (
    <div className="oc-panel-name" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
      <div className="oc-logo">O</div>
      {panelTitle}
    </div>
  )

  const nav = (
    <Navigation location={pathname}>
      <Navigation.Section
        items={[
          { label: 'Dashboard',  icon: HomeIcon,          url: '/',           exactMatch: true },
          { label: 'Sites',      icon: GlobeIcon,         url: '/sites' },
          { label: 'Monitoring', icon: ChartVerticalIcon, url: '/monitoring' },
          { label: 'Settings',   icon: SettingsIcon,      url: '/settings' }
        ]}
      />
    </Navigation>
  )

  const topBar = (
    <TopBar
      showNavigationToggle
      onNavigationToggle={() => setMobileNavOpen((p) => !p)}
      contextControl={contextControl}
      searchField={
        <TopBar.SearchField
          placeholder="Search or ⌘K for commands"
          value=""
          onChange={() => {}}
          onFocus={() => setPaletteOpen(true)}
        />
      }
      userMenu={
        <TopBar.UserMenu
          actions={[{
            items: [
              { content: 'Command palette  ⌘K', onAction: () => setPaletteOpen(true) },
              { content: 'Settings',            onAction: () => navigate('/settings') },
              { content: 'Logout',              onAction: handleLogout }
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
          <Toast
            content={toastState.content}
            error={toastState.error}
            onDismiss={() => setToastState(null)}
          />
        )}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </Frame>
    </ToastContext.Provider>
  )
}
