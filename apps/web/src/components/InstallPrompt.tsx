import { useEffect, useState } from 'react'
import { Button } from '@shopify/polaris'

// Chromium fires `beforeinstallprompt` when the PWA is installable. We capture
// the event and surface a small "Install app" button instead of relying on the
// browser's default mini-infobar (which many users miss).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault() // stop the default mini-infobar
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setDeferred(null)

    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!deferred) return null

  const install = async () => {
    await deferred.prompt()
    await deferred.userChoice
    setDeferred(null)
  }

  return (
    // Sits above the QuickActions FAB (bottom:24 right:24) so the two never overlap.
    <div style={{ position: 'fixed', right: 24, bottom: 88, zIndex: 520 }}>
      <Button variant="primary" onClick={install}>📲 Install app</Button>
    </div>
  )
}
