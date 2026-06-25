import { AppProvider } from '@shopify/polaris'
import enTranslations from '@shopify/polaris/locales/en.json'
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { ComponentProps } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { AppLayout } from './components/AppLayout'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { SitesPage } from './pages/SitesPage'
import { ProvisionPage } from './pages/ProvisionPage'
import { SiteDetailPage } from './pages/SiteDetailPage'
import { MonitoringPage } from './pages/MonitoringPage'
import { SettingsPage } from './pages/SettingsPage'
import { TeamPage } from './pages/TeamPage'

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
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Routes>
                <Route path="/"           element={<DashboardPage />} />
                <Route path="/sites"      element={<SitesPage />} />
                <Route path="/sites/new"  element={<ProvisionPage />} />
                <Route path="/sites/:id"  element={<SiteDetailPage />} />
                <Route path="/monitoring" element={<MonitoringPage />} />
                <Route path="/settings"   element={<SettingsPage />} />
                <Route path="/team"       element={<AdminRoute><TeamPage /></AdminRoute>} />
                <Route path="*"           element={<Navigate to="/" replace />} />
              </Routes>
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
        </BrowserRouter>
      </AuthProvider>
    </AppProvider>
  )
}
