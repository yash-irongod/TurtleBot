import { useRef } from 'react'

/**
 * Keeps a rolling window of the last `size` values seen for `value` across
 * renders, without triggering extra re-renders itself. Read the returned
 * array directly — it mutates in place, which is fine for a display-only
 * sparkline or trail that re-renders anyway when its parent's telemetry
 * updates.
 */
export function useHistory<T>(value: T, size = 24): T[] {
  const ref = useRef<T[]>([])
  const history = ref.current
  history.push(value)
  if (history.length > size) history.shift()
  return history
}
