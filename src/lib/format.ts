export function fixed(value: number, digits = 1): string {
  return value.toFixed(digits)
}

export function padded(value: number, digits = 2): string {
  return String(Math.round(value)).padStart(digits, '0')
}

export function metersPerSecond(value: number): string {
  return `${fixed(value, 2)} m/s`
}

export function radiansPerSecond(value: number): string {
  return `${fixed(value, 2)} rad/s`
}

export function percent(value: number): string {
  return `${Math.round(value)}%`
}

export function celsius(value: number): string {
  return `${fixed(value, 1)}°C`
}

export function meters(value: number): string {
  return `${fixed(value, 2)} m`
}

export function clockTime(date: Date): string {
  return `${padded(date.getHours())}:${padded(date.getMinutes())}:${padded(date.getSeconds())}`
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${padded(hours)}:${padded(minutes)}:${padded(seconds)}`
}

export function isoDate(date: Date): string {
  return `${date.getFullYear()}.${padded(date.getMonth() + 1)}.${padded(date.getDate())}`
}
