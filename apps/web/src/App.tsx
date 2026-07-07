import { AppProvider, Spinner } from '@shopify/polaris'
import enTranslations from '@shopify/polaris/locales/en.json'
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { ComponentProps, lazy, Suspense } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { AppLayout } from './components/AppLayout'
import { InstallPrompt } from './components/InstallPrompt'
import { LoginPage } from './pages/LoginPage'

// Route-level code splitting: each page (and its heavy deps — Monaco, xterm,
// recharts) ships as a separate chunk loaded on demand, so the initial bundle
// stays small and mobile first-load is fast.
const named = <T,>(p: Promise<Record<string, T>>, key: string) => p.then((m) => ({ default: m[key] as any }))
const DashboardPage  = lazy(() => named(import('./pages/DashboardPage'), 'DashboardPage'))
const SitesPage      = lazy(() => named(import('./pages/SitesPage'), 'SitesPage'))
const ProvisionPage  = lazy(() => named(import('./pages/ProvisionPage'), 'ProvisionPage'))
const SiteDetailPage = lazy(() => named(import('./pages/SiteDetailPage'), 'SiteDetailPage'))
const MonitoringPage = lazy(() => named(import('./pages/MonitoringPage'), 'MonitoringPage'))
const SettingsPage   = lazy(() => named(import('./pages/SettingsPage'), 'SettingsPage'))
const TeamPage       = lazy(() => named(import('./pages/TeamPage'), 'TeamPage'))
const TasksPage      = lazy(() => named(import('./pages/TasksPage'), 'TasksPage'))
const NotesPage      = lazy(() => named(import('./pages/NotesPage'), 'NotesPage'))
const CalendarPage   = lazy(() => named(import('./pages/CalendarPage'), 'CalendarPage'))
const ServerPage     = lazy(() => named(import('./pages/ServerPage'), 'ServerPage'))
const SystemPage     = lazy(() => named(import('./pages/SystemPage'), 'SystemPage'))
const ErrorsPage     = lazy(() => named(import('./pages/ErrorsPage'), 'ErrorsPage'))
const AssistantPage  = lazy(() => named(import('./pages/AssistantPage'), 'AssistantPage'))
const ServersPage    = lazy(() => named(import('./pages/ServersPage'), 'ServersPage'))
const StatusPage     = lazy(() => named(import('./pages/StatusPage'), 'StatusPage'))

function RouteFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
      <Spinner accessibilityLabel="Loading page" size="large" />
    </div>
  )
}

function PolarisLink({ children, url, ...rest }: ComponentProps<'a'> & { url: string }) {
  return <Link to={url} {...(rest as any)}>{children}</Link>
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth()
  return token ? <>{children}</> : <Navigate to="/login" replace />
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { token, isAdmin } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  if (!isAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/status/:token" element={<Suspense fallback={<RouteFallback />}><StatusPage /></Suspense>} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/"           element={<DashboardPage />} />
                  <Route path="/sites"      element={<SitesPage />} />
                  <Route path="/sites/new"  element={<ProvisionPage />} />
                  <Route path="/sites/:id"  element={<SiteDetailPage />} />
                  <Route path="/monitoring" element={<MonitoringPage />} />
                  <Route path="/settings"   element={<SettingsPage />} />
                  <Route path="/team"       element={<AdminRoute><TeamPage /></AdminRoute>} />
                  <Route path="/server"     element={<AdminRoute><ServerPage /></AdminRoute>} />
                  <Route path="/servers"    element={<AdminRoute><ServersPage /></AdminRoute>} />
                  <Route path="/system"     element={<AdminRoute><SystemPage /></AdminRoute>} />
                  <Route path="/errors"     element={<AdminRoute><ErrorsPage /></AdminRoute>} />
                  <Route path="/assistant"  element={<AdminRoute><AssistantPage /></AdminRoute>} />
                  <Route path="/tasks"      element={<TasksPage />} />
                  <Route path="/notes"      element={<NotesPage />} />
                  <Route path="/calendar"   element={<CalendarPage />} />
                  <Route path="*"           element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </AppLayout>
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <AppProvider i18n={enTranslations} linkComponent={PolarisLink}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
          <InstallPrompt />
        </BrowserRouter>
      </AuthProvider>
    </AppProvider>
  )
}
