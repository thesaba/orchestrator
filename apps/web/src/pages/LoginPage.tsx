import {
  Page,
  Card,
  FormLayout,
  TextField,
  Button,
  Banner,
  BlockStack,
  Text
} from '@shopify/polaris'
import { useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const [email, setEmail] = useState('admin@localhost')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const { token } = await api.auth.login(email, password)
      login(token)
      navigate('/')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f6f6f7'
      }}
    >
      <div style={{ width: '100%', maxWidth: 420, padding: '0 16px' }}>
        <BlockStack gap="500">
          <Text as="h1" variant="headingXl" alignment="center">
            Orchestrator
          </Text>
          <Card>
            <BlockStack gap="400">
              {error && <Banner tone="critical">{error}</Banner>}
              <div onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => e.key === 'Enter' && handleSubmit()}>
              <FormLayout>
                <TextField
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  autoComplete="email"
                />
                <TextField
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                />
                <Button
                  variant="primary"
                  onClick={handleSubmit}
                  loading={loading}
                  fullWidth
                  size="large"
                >
                  Sign in
                </Button>
              </FormLayout>
              </div>
            </BlockStack>
          </Card>
        </BlockStack>
      </div>
    </div>
  )
}
