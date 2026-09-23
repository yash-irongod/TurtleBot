/** Small geometry helpers for the polar/radar-style spatial display. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Converts a bearing (degrees, 0 = up/forward, clockwise-positive) and a
 * radius fraction (0-1 of the display radius) into SVG x/y coordinates
 * centred on (cx, cy).
 */
export function polarToXY(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
  radiusFraction: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  const r = radius * radiusFraction
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  }
}

export function normalizeDeg(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

/** Shortest signed distance from `from` to `to`, in degrees, in the range (-180, 180]. */
export function angularDelta(from: number, to: number): number {
  let delta = normalizeDeg(to - from)
  if (delta > 180) delta -= 360
  return delta
}

/** Deterministic pseudo-random value in [0, 1) for a given seed — stable across renders. */
export function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}
