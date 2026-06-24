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
  const [email,     setEmail]     = useState('admin@localhost')
  const [password,  setPassword]  = useState('')
  const [totpCode,  setTotpCode]  = useState('')
  const [needTotp,  setNeedTotp]  = useState(false)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const { login } = useAuth()
  const navigate  = useNavigate()

  const handleSubmit = async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const res = await api.auth.login(email, password, needTotp ? totpCode : undefined)

      if ('requiresTOTP' in res) {
        setNeedTotp(true)
        return
      }

      login(res.token)
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
                  {!needTotp ? (
                    <>
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
                    </>
                  ) : (
                    <>
                      <Banner tone="info">
                        Two-factor authentication is enabled. Enter the 6-digit code from your authenticator app.
                      </Banner>
                      <TextField
                        label="Authenticator code"
                        type="text"
                        value={totpCode}
                        onChange={setTotpCode}
                        autoComplete="one-time-code"
                        maxLength={6}
                        placeholder="000000"
                      />
                    </>
                  )}
                  <Button
                    variant="primary"
                    onClick={handleSubmit}
                    loading={loading}
                    fullWidth
                    size="large"
                  >
                    {needTotp ? 'Verify' : 'Sign in'}
                  </Button>
                  {needTotp && (
                    <Button
                      variant="plain"
                      onClick={() => { setNeedTotp(false); setTotpCode(''); setError('') }}
                    >
                      Back
                    </Button>
                  )}
                </FormLayout>
              </div>
            </BlockStack>
          </Card>
        </BlockStack>
      </div>
    </div>
  )
}
