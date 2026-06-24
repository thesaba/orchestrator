import { Frame, Navigation, TopBar, Toast } from '@shopify/polaris'
import { HomeIcon, GlobeIcon, ChartVerticalIcon, SettingsIcon } from '@shopify/polaris-icons'
import { ReactNode, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ToastContext, ToastOptions } from '../context/toast'

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [toastState, setToastState] = useState<{ content: string; error?: boolean } | null>(null)
  const { logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const showToast = useCallback((content: string, options: ToastOptions = {}) => {
    setToastState({ content, error: options.error })
  }, [])

  const handleLogout = useCallback(() => {
    logout()
    navigate('/login')
  }, [logout, navigate])

  const nav = (
    <Navigation location={pathname}>
      <Navigation.Section
        items={[
          { label: 'Dashboard', icon: HomeIcon, url: '/', exactMatch: true },
          { label: 'Sites',     icon: GlobeIcon, url: '/sites' },
          { label: 'Monitoring', icon: ChartVerticalIcon, url: '/monitoring' },
          { label: 'Settings',  icon: SettingsIcon, url: '/settings' }
        ]}
      />
    </Navigation>
  )

  const topBar = (
    <TopBar
      showNavigationToggle
      onNavigationToggle={() => setMobileNavOpen((p) => !p)}
      userMenu={
        <TopBar.UserMenu
          actions={[{ items: [{ content: 'Logout', onAction: handleLogout }] }]}
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
      </Frame>
    </ToastContext.Provider>
  )
}
