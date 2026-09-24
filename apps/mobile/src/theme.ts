import { useMemo } from 'react'
import { useColorScheme } from 'react-native'
import { DarkTheme as NavDark, DefaultTheme as NavLight, type Theme as NavTheme } from 'expo-router'
import { MD3DarkTheme, MD3LightTheme, useTheme, type MD3Theme } from 'react-native-paper'
import { useMaterial3Theme, type Material3Scheme } from '@pchmn/expo-material3-theme'
import { Blend, TonalPalette, argbFromHex, hexFromArgb } from '@material/material-color-utilities'

/**
 * Material 3, via react-native-paper. Every colour on screen is a Material 3
 * role — primary, surface, onSurfaceVariant, errorContainer — never a literal.
 *
 * On Android 12+ the scheme is the phone's own (Material You, taken from the
 * wallpaper). Everywhere else it is generated from the app's seed colour, so
 * iOS and the web get a proper tonal scheme rather than a hand-picked palette.
 *
 * Two custom roles are added, the Material 3 way (a colour, its "on" colour,
 * a container and an "on container", harmonised towards the primary so they
 * sit with whatever the wallpaper produced):
 *
 *   confirmed   — green: the pipeline, or you, vouched for a place
 *   needsCheck  — amber: waiting on your judgement
 *
 * They carry meaning, not decoration. Nothing else may use them, or the tray
 * stops being scannable.
 */

/** The fallback seed when the phone doesn't provide one: the old teal accent. */
const SEED = '#0F766E'
const CONFIRMED = '#15803D'
const NEEDS_CHECK = '#B45309'

interface StatusColors {
  confirmed: string
  onConfirmed: string
  confirmedContainer: string
  onConfirmedContainer: string
  needsCheck: string
  onNeedsCheck: string
  needsCheckContainer: string
  onNeedsCheckContainer: string
}

export type AppColors = MD3Theme['colors'] & Material3Scheme & StatusColors
export type AppTheme = Omit<MD3Theme, 'colors'> & { colors: AppColors }

/** Material 3 spacing runs on a 4dp grid. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const

/** Material 3 shape scale, for the few surfaces Paper doesn't draw itself. */
export const shape = { small: 8, medium: 12, large: 16, full: 999 } as const

export const useAppTheme = () => useTheme<AppTheme>()

/** Builds the theme once at the root. Screens read it with useAppTheme(). */
export function useBuildTheme(): AppTheme {
  const dark = useColorScheme() === 'dark'
  const { theme } = useMaterial3Theme({ fallbackSourceColor: SEED })

  return useMemo(() => {
    const base = dark ? MD3DarkTheme : MD3LightTheme
    const scheme = dark ? theme.dark : theme.light
    return {
      ...base,
      colors: {
        ...base.colors,
        ...scheme,
        ...customRole('confirmed', CONFIRMED, scheme.primary, dark),
        ...customRole('needsCheck', NEEDS_CHECK, scheme.primary, dark),
      } as AppColors,
    }
  }, [dark, theme])
}

/**
 * The navigator's own theme, so scene backgrounds and the brief frame before
 * a screen paints match the Material surfaces around them.
 */
export function navigationTheme(t: AppTheme): NavTheme {
  const base = t.dark ? NavDark : NavLight
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: t.colors.primary,
      background: t.colors.background,
      card: t.colors.surface,
      text: t.colors.onSurface,
      border: t.colors.outlineVariant,
      notification: t.colors.error,
    },
  }
}

/** Material 3 tones for a custom colour role: 40/100/90/10 light, 80/20/30/90 dark. */
function customRole<N extends 'confirmed' | 'needsCheck'>(name: N, hex: string, primary: string, dark: boolean) {
  const palette = TonalPalette.fromInt(Blend.harmonize(argbFromHex(hex), argbFromHex(primary)))
  const tone = (t: number) => hexFromArgb(palette.tone(t))
  const cap = `${name.charAt(0).toUpperCase()}${name.slice(1)}`
  return {
    [name]: tone(dark ? 80 : 40),
    [`on${cap}`]: tone(dark ? 20 : 100),
    [`${name}Container`]: tone(dark ? 30 : 90),
    [`on${cap}Container`]: tone(dark ? 90 : 10),
  } as Pick<StatusColors, Extract<keyof StatusColors, `${N}` | `on${Capitalize<N>}` | `${N}Container` | `on${Capitalize<N>}Container`>>
}
