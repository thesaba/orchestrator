import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

type ColorScheme = 'light' | 'dark'

interface ThemeCtx {
  colorScheme: ColorScheme
  toggleColorScheme: () => void
}

const ThemeContext = createContext<ThemeCtx>({ colorScheme: 'light', toggleColorScheme: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [colorScheme, setColorScheme] = useState<ColorScheme>(
    () => (localStorage.getItem('color-scheme') as ColorScheme) ?? 'light'
  )

  const toggleColorScheme = useCallback(() => {
    setColorScheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light'
      localStorage.setItem('color-scheme', next)
      return next
    })
  }, [])

  return (
    <ThemeContext.Provider value={{ colorScheme, toggleColorScheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() { return useContext(ThemeContext) }
