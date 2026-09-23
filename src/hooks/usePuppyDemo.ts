import { useCallback, useEffect, useRef, useState } from 'react'
import type { PuppyStatus } from '../types/robot'
import { clamp } from '../lib/polar'

const INITIAL: PuppyStatus = { puppyState: 'STOPPED', targetBearingDeg: 0, distanceM: 0, confidencePct: 0 }
const SEARCH_MS = 1300
const LOCK_MS = 900

/**
 * Puppy mode's state machine. This is demo perception, not a real person
 * detector — SEARCHING → TARGET_FOUND → FOLLOWING advance on fixed timers
 * after acquireTarget(), and distance/bearing/confidence animate off the
 * shared telemetry clock while FOLLOWING. TARGET_LOST exists in the type and
 * has a defined visual treatment, but nothing here triggers it automatically
 * — inventing "lost signal" events would just be more fake data.
 */
export function usePuppyDemo(active: boolean, clockMs: number) {
  const [puppy, setPuppy] = useState<PuppyStatus>(INITIAL)
  const timersRef = useRef<number[]>([])

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id))
    timersRef.current = []
  }, [])

  const after = useCallback(
    (ms: number, fn: () => void) => {
      timersRef.current.push(window.setTimeout(fn, ms))
    },
    [],
  )

  useEffect(() => {
    if (!active) {
      clearTimers()
      setPuppy(INITIAL)
    }
    return clearTimers
  }, [active, clearTimers])

  useEffect(() => {
    setPuppy((prev) => {
      if (prev.puppyState !== 'FOLLOWING') return prev
      const t = clockMs / 1000
      return {
        ...prev,
        targetBearingDeg: (Math.sin(t / 3) * 40 + 360) % 360,
        distanceM: clamp(1.1 + Math.sin(t / 2.2) * 0.5, 0.4, 2.4),
        confidencePct: clamp(80 + Math.sin(t / 1.7) * 12, 0, 100),
      }
    })
  }, [clockMs])

  const acquireTarget = useCallback(() => {
    clearTimers()
    setPuppy({ puppyState: 'SEARCHING', targetBearingDeg: 0, distanceM: 0, confidencePct: 15 })
    after(SEARCH_MS, () =>
      setPuppy((prev) => (prev.puppyState === 'SEARCHING' ? { ...prev, puppyState: 'TARGET_FOUND', confidencePct: 55 } : prev)),
    )
    after(SEARCH_MS + LOCK_MS, () =>
      setPuppy((prev) => (prev.puppyState === 'TARGET_FOUND' ? { ...prev, puppyState: 'FOLLOWING' } : prev)),
    )
  }, [clearTimers, after])

  const pausePuppy = useCallback(() => {
    clearTimers()
    setPuppy((prev) => (prev.puppyState === 'FOLLOWING' ? { ...prev, puppyState: 'PAUSED' } : prev))
  }, [clearTimers])

  const resumePuppy = useCallback(() => {
    setPuppy((prev) => (prev.puppyState === 'PAUSED' ? { ...prev, puppyState: 'FOLLOWING' } : prev))
  }, [])

  const stopPuppy = useCallback(() => {
    clearTimers()
    setPuppy(INITIAL)
  }, [clearTimers])

  return { puppy, acquireTarget, pausePuppy, resumePuppy, stopPuppy }
}
