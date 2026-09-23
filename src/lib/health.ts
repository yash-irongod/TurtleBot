import type { HealthLevel } from '../types/robot'

export function batteryHealth(percentage: number): HealthLevel {
  if (percentage <= 15) return 'critical'
  if (percentage <= 35) return 'warning'
  return 'nominal'
}

export function temperatureHealth(celsiusVal: number): HealthLevel {
  if (celsiusVal >= 55) return 'critical'
  if (celsiusVal >= 45) return 'warning'
  return 'nominal'
}

export function signalHealth(signalPct: number): HealthLevel {
  if (signalPct <= 25) return 'critical'
  if (signalPct <= 50) return 'warning'
  return 'nominal'
}

export function proximityHealth(nearestM: number): HealthLevel {
  if (nearestM <= 0.25) return 'critical'
  if (nearestM <= 0.6) return 'warning'
  return 'nominal'
}

/** Tailwind color classes keyed by health level, used consistently across the UI. */
export const healthColor: Record<HealthLevel, { text: string; dot: string; ring: string }> = {
  nominal: { text: 'text-signal-400', dot: 'bg-signal-400', ring: 'ring-signal-400/40' },
  warning: { text: 'text-amber-400', dot: 'bg-amber-400', ring: 'ring-amber-400/40' },
  critical: { text: 'text-critical-400', dot: 'bg-critical-500', ring: 'ring-critical-500/50' },
}
