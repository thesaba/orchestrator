import { Frame, Navigation, TopBar, Toast } from '@shopify/polaris'
import { HomeIcon, GlobeIcon, ChartVerticalIcon, SettingsIcon } from '@shopify/polaris-icons'
import { ReactNode, useState, useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ToastContext, ToastOptions } from '../context/toast'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { CommandPalette } from './CommandPalette'
import { QuickActionsFab } from './QuickActionsFab'
import { api, AuditEntry } from '../api/client'

function RecentActivityPanel({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<AuditEntry[]>([])

  useEffect(() => {
    api.audit.list({ limit: 20 }).then(r => setLogs(r.logs)).catch(() => {})
  }, [])

  const formatAction = (action: string) => action.replace(/\./g, ' → ')

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>Recent Activity</strong>
        <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--oc-text-subdued)' }}>×</button>
      </div>
      {logs.length === 0 ? (
        <p style={{ color: 'var(--oc-text-subdued)', fontSize: 13 }}>No recent activity</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {logs.map(log => (
            <div key={log.id} style={{ borderBottom: '1px solid var(--oc-border)', paddingBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{formatAction(log.action)}</div>
              {log.meta && !!(log.meta as Record<string, unknown>).domain && (
                <div style={{ fontSize: 12, color: 'var(--oc-text-subdued)' }}>{String((log.meta as Record<string, unknown>).domain)}</div>
              )}
              <div style={{ fontSize: 11, color: 'var(--oc-text-subdued)', marginTop: 2 }}>
                {new Date(log.createdAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileNavOpen,    setMobileNavOpen]    = useState(false)
  const [userMenuOpen,     setUserMenuOpen]      = useState(false)
  const [paletteOpen,      setPaletteOpen]       = useState(false)
  const [panelTitle,       setPanelTitle]        = useState('Orchestrator')
  const [toastState,       setToastState]        = useState<{ content: string; error?: boolean } | null>(null)
  const [pinnedSites,      setPinnedSites]       = useState<{ id: number; domain: string; name: string }[]>([])
  const [deployInProgress, setDeployInProgress]  = useState(false)
  const [activityOpen,     setActivityOpen]      = useState(false)

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

  useEffect(() => {
    api.sites.list()
      .then(sites => setPinnedSites(
        sites.filter(s => s.pinned).map(s => ({ id: s.id, domain: s.domain, name: s.name }))
      ))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const handler = () => {
      setDeployInProgress(true)
      setTimeout(() => setDeployInProgress(false), 15000)
    }
    window.addEventListener('orchestrator:deploy-start', handler)
    return () => window.removeEventListener('orchestrator:deploy-start', handler)
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
      {pinnedSites.length > 0 && (
        <Navigation.Section
          title="Pinned Sites"
          items={pinnedSites.map(site => ({
            label: site.domain,
            url: `/sites/${site.id}`,
          }))}
        />
      )}
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
              { content: 'Recent activity',      onAction: () => setActivityOpen(p => !p) },
              { content: 'Settings',             onAction: () => navigate('/settings') },
              { content: 'Logout',               onAction: handleLogout }
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
      <>
        {deployInProgress && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, height: 3,
            background: 'linear-gradient(90deg, #458fff 0%, #94d82d 50%, #458fff 100%)',
            backgroundSize: '200% 100%',
            animation: 'oc-progress 1.5s linear infinite',
            zIndex: 9999
          }} />
        )}
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
          <QuickActionsFab />
        </Frame>
        {activityOpen && (
          <div style={{
            position: 'fixed', right: 0, top: 57, bottom: 0, width: 320,
            background: 'var(--p-color-bg-surface)',
            borderLeft: '1px solid var(--oc-border)',
            zIndex: 400, overflowY: 'auto', padding: 16
          }}>
            <RecentActivityPanel onClose={() => setActivityOpen(false)} />
          </div>
        )}
      </>
    </ToastContext.Provider>
  )
}
