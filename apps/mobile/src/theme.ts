import { useColorScheme } from 'react-native'

/**
 * Design tokens. Every screen takes its colours and spacing from here, so the
 * three screens built in parallel still look like one app.
 *
 * The status colours carry meaning, not decoration: green means the pipeline
 * (or you) vouched for a place, amber means it is waiting on your judgement.
 * Never use them for anything else, or the tray stops being scannable.
 */

const light = {
  bg: '#FAFAF9',
  surface: '#FFFFFF',
  surfaceAlt: '#F4F4F2',
  border: '#E7E5E4',
  text: '#1C1917',
  textMuted: '#78716C',
  textFaint: '#A8A29E',
  accent: '#0F766E',
  accentText: '#FFFFFF',
  confirmed: '#15803D',
  confirmedBg: '#DCFCE7',
  needsCheck: '#B45309',
  needsCheckBg: '#FEF3C7',
  danger: '#B91C1C',
  dangerBg: '#FEE2E2',
}

const dark: typeof light = {
  bg: '#0C0A09',
  surface: '#1C1917',
  surfaceAlt: '#292524',
  border: '#3F3A36',
  text: '#F5F5F4',
  textMuted: '#A8A29E',
  textFaint: '#78716C',
  accent: '#2DD4BF',
  accentText: '#042F2E',
  confirmed: '#4ADE80',
  confirmedBg: '#14532D',
  needsCheck: '#FBBF24',
  needsCheckBg: '#451A03',
  danger: '#F87171',
  dangerBg: '#450A0A',
}

export type Colors = typeof light

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const
export const font = {
  small: 12,
  body: 15,
  title: 17,
  heading: 22,
} as const
