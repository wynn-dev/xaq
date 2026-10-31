import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

type Theme = 'light' | 'dark' | 'system'

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: 'system', setTheme: () => {} })

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('xaq.theme') as Theme) ?? 'system')

  useEffect(() => {
    localStorage.setItem('xaq.theme', theme)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches))
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>
}

export const useTheme = () => useContext(ThemeContext)

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <SunIcon className="dark:hidden" />
          <MoonIcon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="light">
            <SunIcon /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
