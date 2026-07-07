import { Frame, Navigation, TopBar, Toast } from '@shopify/polaris'
import {
  HomeIcon, GlobeIcon, ChartVerticalIcon, SettingsIcon,
  UploadIcon, CodeIcon, LockIcon, GaugeIcon,
  DatabaseIcon, WandIcon, BugIcon, ShieldCheckMarkIcon,
  WrenchIcon, ListBulletedIcon, AutomationIcon, PackageIcon,
  CodeAddIcon, FolderIcon, ClipboardChecklistIcon, PinIcon,
  RefreshIcon, TeamIcon, CalendarIcon, NoteIcon, MagicIcon
} from '@shopify/polaris-icons'
import { ReactNode, useState, useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate, useMatch, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ToastContext, ToastOptions } from '../context/toast'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { CommandPalette } from './CommandPalette'
import { NotificationBell } from './NotificationBell'
import { QuickActionsFab } from './QuickActionsFab'
import { api, AuditEntry, Site } from '../api/client'

// ── Recent Activity Panel ──────────────────────────────────────────────────────
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
                {log.userEmail && <span style={{ marginLeft: 4 }}>· {log.userEmail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Site Selector Dropdown ────────────────────────────────────────────────────
interface SiteSelectorProps {
  allSites: Pick<Site, 'id' | 'domain' | 'name' | 'status'>[]
  currentSite: { id: number; domain: string; name: string } | null
  onSelect: (id: number) => void
  onAddNew: () => void
}

function SiteSelector({ allSites, currentSite, onSelect, onAddNew }: SiteSelectorProps) {
  const [open, setOpen]     = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false); setSearch('')
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const filtered = search.trim()
    ? allSites.filter(s =>
        s.domain.toLowerCase().includes(search.toLowerCase()) ||
        (s.name ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : allSites

  const statusColor = (status: string) => {
    if (status === 'active')       return '#94d82d'
    if (status === 'error')        return '#de3618'
    if (status === 'provisioning') return '#458fff'
    return '#adb5bd'
  }

  return (
    <div ref={ref} style={{ padding: '12px 10px 10px', borderBottom: '1px solid var(--oc-border)', position: 'relative' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--oc-text-subdued)', letterSpacing: '0.08em', marginBottom: 6, paddingLeft: 2, textTransform: 'uppercase' }}>
        Workspace
      </div>

      {/* Trigger button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 10px',
          background: open ? 'rgba(69,143,255,0.08)' : 'var(--oc-bg-secondary)',
          border: `1px solid ${open ? 'var(--oc-accent)' : 'var(--oc-border)'}`,
          borderRadius: 8, cursor: 'pointer', color: 'var(--p-color-text)',
          transition: 'border-color 0.15s, background 0.15s',
        }}
      >
        {currentSite ? (
          <>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: statusColor(allSites.find(s => s.id === currentSite.id)?.status ?? '')
            }} />
            <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
              {currentSite.domain}
            </span>
          </>
        ) : (
          <span style={{ flex: 1, fontSize: 13, color: 'var(--oc-text-subdued)', textAlign: 'left' }}>
            Select a site…
          </span>
        )}
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}>
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% - 4px)', left: 10, right: 10, zIndex: 600,
          background: 'var(--p-color-bg-surface)',
          border: '1px solid var(--oc-border)',
          borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          overflow: 'hidden',
        }}>
          {/* Search input */}
          <div style={{ padding: '8px 8px 4px' }}>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sites…"
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '6px 10px',
                border: '1px solid var(--oc-border-input)', borderRadius: 6,
                fontSize: 12, background: 'var(--oc-bg)', color: 'var(--oc-text)', outline: 'none',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--oc-accent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--oc-border-input)' }}
            />
          </div>

          {/* Site list */}
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '16px', fontSize: 12, color: 'var(--oc-text-subdued)', textAlign: 'center' }}>
                No sites found
              </div>
            ) : (
              filtered.map(site => {
                const isActive = site.id === currentSite?.id
                return (
                  <button
                    key={site.id}
                    onClick={() => { onSelect(site.id); setOpen(false); setSearch('') }}
                    style={{
                      width: '100%', padding: '8px 12px', textAlign: 'left',
                      border: 'none', cursor: 'pointer', fontSize: 12,
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: isActive ? 'rgba(69,143,255,0.12)' : 'transparent',
                      color: 'var(--p-color-text)',
                    }}
                    onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--oc-bg-secondary)' }}
                    onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: statusColor(site.status) }} />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontWeight: isActive ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {site.domain}
                      </div>
                      {site.name && site.name !== site.domain && (
                        <div style={{ fontSize: 11, color: 'var(--oc-text-subdued)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {site.name}
                        </div>
                      )}
                    </div>
                    {isActive && <span style={{ color: 'var(--oc-accent)', fontSize: 14, flexShrink: 0 }}>✓</span>}
                  </button>
                )
              })
            )}
          </div>

          {/* Footer */}
          <div style={{ borderTop: '1px solid var(--oc-border)', padding: '6px 8px' }}>
            <button
              onClick={() => { onAddNew(); setOpen(false); setSearch('') }}
              style={{
                width: '100%', padding: '7px 10px', border: 'none',
                background: 'none', cursor: 'pointer', fontSize: 12,
                color: 'var(--oc-accent)', textAlign: 'left',
                display: 'flex', alignItems: 'center', gap: 6, borderRadius: 6,
              }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(69,143,255,0.08)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'none'}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Add new site
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── App Layout ────────────────────────────────────────────────────────────────
export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileNavOpen,    setMobileNavOpen]    = useState(false)
  const [userMenuOpen,     setUserMenuOpen]      = useState(false)
  const [paletteOpen,      setPaletteOpen]       = useState(false)
  const [panelTitle,       setPanelTitle]        = useState('Orchestrator')
  const [toastState,       setToastState]        = useState<{ content: string; error?: boolean } | null>(null)
  const [pinnedSites,      setPinnedSites]       = useState<{ id: number; domain: string; name: string }[]>([])
  const [allSites,         setAllSites]          = useState<Pick<Site, 'id' | 'domain' | 'name' | 'status'>[]>([])
  const [deployInProgress, setDeployInProgress]  = useState(false)
  const [activityOpen,     setActivityOpen]      = useState(false)

  const { logout, user: authUser, isAdmin } = useAuth()
  const navigate   = useNavigate()
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()

  const siteMatch     = useMatch('/sites/:id')
  const currentSiteId = siteMatch ? Number(siteMatch.params.id) : null
  const [currentSite, setCurrentSite] = useState<{ id: number; domain: string; name: string } | null>(null)

  useEffect(() => {
    if (!currentSiteId) { setCurrentSite(null); return }
    api.sites.get(currentSiteId)
      .then(s => setCurrentSite({ id: s.id, domain: s.domain, name: s.name }))
      .catch(() => setCurrentSite(null))
  }, [currentSiteId])

  const showToast = useCallback((content: string, options: ToastOptions = {}) => {
    setToastState({ content, error: options.error })
  }, [])

  const handleLogout = useCallback(() => { logout(); navigate('/login') }, [logout, navigate])

  useEffect(() => {
    api.settings.get()
      .then((s) => { if (s.panel_title?.trim()) setPanelTitle(s.panel_title.trim()) })
      .catch(() => {})
  }, [])

  // Load all sites once (for selector + pinned)
  useEffect(() => {
    api.sites.list()
      .then(sites => {
        setAllSites(sites.map(s => ({ id: s.id, domain: s.domain, name: s.name, status: s.status })))
        setPinnedSites(sites.filter(s => s.pinned).map(s => ({ id: s.id, domain: s.domain, name: s.name })))
      })
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

  useKeyboardShortcuts([
    { key: 'k', meta: true, handler: () => setPaletteOpen(true) },
    { key: '/', handler: () => setPaletteOpen(true) }
  ])

  const contextControl = (
    <div className="oc-panel-name" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
      <div className="oc-logo"><img src="/logo.svg" alt="Orchestrator" style={{ width: 22, height: 22, display: 'block' }} /></div>
      {panelTitle}
    </div>
  )

  const siteTabUrl = (slug: string) => `/sites/${currentSite?.id}?tab=${slug}`
  const isSiteTab  = (slug: string) => pathname === `/sites/${currentSite?.id}` && searchParams.get('tab') === slug

  const navContent = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* ── Global site selector (fixed, never scrolls) ── */}
      <div style={{ flexShrink: 0 }}>
        <SiteSelector
          allSites={allSites}
          currentSite={currentSite}
          onSelect={(id) => navigate(`/sites/${id}`)}
          onAddNew={() => navigate('/sites/new')}
        />
      </div>

      {/* ── Navigation sections (scrolls independently once content overflows) ── */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
      <Navigation location={pathname + (currentSite ? `?tab=${searchParams.get('tab') ?? 'deploys'}` : '')}>
        <Navigation.Section
          items={[
            { label: 'Dashboard',  icon: HomeIcon,          url: '/',           exactMatch: true },
            { label: 'Sites',      icon: GlobeIcon,         url: '/sites' },
            { label: 'Monitoring', icon: ChartVerticalIcon, url: '/monitoring' },
            ...(isAdmin ? [{ label: 'Errors', icon: BugIcon, url: '/errors' }] : []),
            ...(isAdmin ? [{ label: 'AI Assistant', icon: MagicIcon, url: '/assistant' }] : []),
            { label: 'Settings',   icon: SettingsIcon,      url: '/settings' },
            ...(isAdmin ? [{ label: 'Team', icon: TeamIcon, url: '/team' }] : []),
            ...(isAdmin ? [{ label: 'Server', icon: GaugeIcon, url: '/server' }] : []),
            ...(isAdmin ? [{ label: 'System', icon: WrenchIcon, url: '/system' }] : []),
          ]}
        />

        <Navigation.Section
          title="Workspace"
          items={[
            { label: 'Tasks',    icon: ClipboardChecklistIcon, url: '/tasks' },
            { label: 'Notes',    icon: NoteIcon,                url: '/notes' },
            { label: 'Calendar', icon: CalendarIcon,            url: '/calendar' },
          ]}
        />

        {/* Pinned sites — only when NOT on a site detail page */}
        {pinnedSites.length > 0 && !currentSite && (
          <Navigation.Section
            title="Pinned Sites"
            items={pinnedSites.map(site => ({
              label: site.domain,
              icon: PinIcon,
              url: `/sites/${site.id}`,
            }))}
          />
        )}

        {/* Site-specific sections — shown when on /sites/:id */}
        {currentSite && (
          <>
            <Navigation.Section
              title={currentSite.domain}
              items={[
                { label: 'Deployments',     icon: UploadIcon,    url: siteTabUrl('deploys'),  selected: isSiteTab('deploys') || (!searchParams.get('tab') && pathname === `/sites/${currentSite.id}`) },
                { label: 'Deploy Settings', icon: RefreshIcon,   url: siteTabUrl('settings'), selected: isSiteTab('settings') },
              ]}
            />
            <Navigation.Section
              title="Configuration"
              items={[
                { label: 'Config Files', icon: CodeIcon,  url: siteTabUrl('config'),  selected: isSiteTab('config') },
                { label: '.env Editor',  icon: LockIcon,  url: siteTabUrl('env'),     selected: isSiteTab('env') },
                { label: 'PHP-FPM',      icon: GaugeIcon, url: siteTabUrl('phpfpm'),  selected: isSiteTab('phpfpm') },
              ]}
            />
            <Navigation.Section
              title="Database"
              items={[
                { label: 'Database',    icon: DatabaseIcon, url: siteTabUrl('database'),    selected: isSiteTab('database') },
                { label: 'Artisan',     icon: WandIcon,     url: siteTabUrl('artisan'),     selected: isSiteTab('artisan') },
                { label: 'Failed Jobs', icon: BugIcon,      url: siteTabUrl('failed-jobs'), selected: isSiteTab('failed-jobs') },
              ]}
            />
            <Navigation.Section
              title="Monitoring"
              items={[
                { label: 'SSL',          icon: ShieldCheckMarkIcon, url: siteTabUrl('ssl'),         selected: isSiteTab('ssl') },
                { label: 'Maintenance',  icon: WrenchIcon,          url: siteTabUrl('maintenance'), selected: isSiteTab('maintenance') },
                { label: 'Laravel Logs', icon: ListBulletedIcon,    url: siteTabUrl('logs'),        selected: isSiteTab('logs') },
              ]}
            />
            <Navigation.Section
              title="Server"
              items={[
                { label: 'Workers',       icon: AutomationIcon,       url: siteTabUrl('workers'),   selected: isSiteTab('workers') },
                { label: 'Composer',      icon: PackageIcon,          url: siteTabUrl('composer'),  selected: isSiteTab('composer') },
                { label: 'Terminal',      icon: CodeAddIcon,          url: siteTabUrl('terminal'),  selected: isSiteTab('terminal') },
                { label: 'File Manager',  icon: FolderIcon,           url: siteTabUrl('files'),     selected: isSiteTab('files') },
                { label: 'Provision Log', icon: ClipboardChecklistIcon, url: siteTabUrl('provision'), selected: isSiteTab('provision') },
              ]}
            />
          </>
        )}
      </Navigation>
      </div>
    </div>
  )

  const topBar = (
    <TopBar
      showNavigationToggle
      onNavigationToggle={() => setMobileNavOpen((p) => !p)}
      contextControl={contextControl}
      secondaryMenu={<NotificationBell />}
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
          name={authUser?.email ?? 'Admin'}
          detail={authUser?.role ?? ''}
          initials={(authUser?.email?.[0] ?? 'A').toUpperCase()}
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
          navigation={navContent}
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
            position: 'fixed', right: 0, top: 57, bottom: 0, width: 'min(320px, 100vw)',
            background: 'var(--p-color-bg-surface)',
            borderLeft: '1px solid var(--oc-border)',
            zIndex: 400, overflowY: 'auto', padding: 16,
            boxShadow: '-4px 0 16px rgba(0,0,0,0.08)'
          }}>
            <RecentActivityPanel onClose={() => setActivityOpen(false)} />
          </div>
        )}
      </>
    </ToastContext.Provider>
  )
}
