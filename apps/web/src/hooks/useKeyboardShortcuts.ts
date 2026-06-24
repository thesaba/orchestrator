import { useEffect } from 'react'

interface Shortcut {
  key: string
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
  handler: () => void
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return

      for (const s of shortcuts) {
        const metaMatch  = s.meta  ? (e.metaKey || e.ctrlKey) : !e.metaKey && !e.ctrlKey
        const ctrlMatch  = s.ctrl  ? e.ctrlKey  : true
        const shiftMatch = s.shift ? e.shiftKey : !e.shiftKey
        if (
          e.key.toLowerCase() === s.key.toLowerCase() &&
          metaMatch && shiftMatch &&
          (!s.ctrl || ctrlMatch)
        ) {
          e.preventDefault()
          s.handler()
          break
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [shortcuts])
}
