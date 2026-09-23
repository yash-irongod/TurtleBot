import { useCallback, useEffect, useRef, useState } from 'react'
import type { NavigationInfo, Position2D, Waypoint } from '../types/robot'
import { WAYPOINTS } from '../data/waypoints'

const INITIAL: NavigationInfo = { navigationState: 'IDLE', goal: null, path: [], distanceRemainingM: 0, progressPct: 0 }

const PLANNING_MS = 900
const PROGRESS_TICK_MS = 400
/** Kept under the central manual forward limit for a calm, legible demo. */
const DEMO_ROUTE_SPEED_MPS = 0.14

interface UseNavigationDemoOptions {
  /** The demo must never run alongside a live/disconnected data source. */
  enabled: boolean
  /** Captured only when the operator chooses or starts a demo route. */
  getCurrentPosition: () => Position2D
}

function distanceBetween(a: Position2D, b: Position2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * Local navigation model used only while the source status is DEMO. Timers
 * are scheduled outside state updates so StrictMode cannot duplicate a route
 * progression. A live source supplies navigation state through RobotContext
 * instead; presentation components consume the same NavigationInfo shape.
 */
export function useNavigationDemo({ enabled, getCurrentPosition }: UseNavigationDemoOptions) {
  const [navigation, setNavigation] = useState<NavigationInfo>(INITIAL)
  const navigationRef = useRef<NavigationInfo>(INITIAL)
  const enabledRef = useRef(enabled)
  // Start after the dock preset so the first deck action yields a target that
  // is visibly separate from the robot's initial dock position.
  const goalIndexRef = useRef(0)
  const planningTimerRef = useRef<number | null>(null)
  const progressTimerRef = useRef<number | null>(null)
  const scheduleProgressRef = useRef<() => void>(() => undefined)

  enabledRef.current = enabled

  const commit = useCallback((next: NavigationInfo) => {
    navigationRef.current = next
    setNavigation(next)
  }, [])

  const clearTimers = useCallback(() => {
    if (planningTimerRef.current !== null) window.clearTimeout(planningTimerRef.current)
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current)
    planningTimerRef.current = null
    progressTimerRef.current = null
  }, [])

  const armGoal = useCallback(
    (goal: Waypoint) => {
      if (!enabledRef.current) return

      // A newly selected or repositioned goal always requires an explicit
      // fresh start. That avoids silently continuing a route after its target
      // has moved beneath the demo planner.
      clearTimers()
      const start = getCurrentPosition()
      commit({
        navigationState: 'READY',
        goal: { ...goal, position: { ...goal.position }, status: 'pending' },
        path: [],
        distanceRemainingM: distanceBetween(start, goal.position),
        progressPct: 0,
      })
    },
    [clearTimers, commit, getCurrentPosition],
  )

  const scheduleProgress = useCallback(() => {
    if (!enabledRef.current || progressTimerRef.current !== null) return

    progressTimerRef.current = window.setTimeout(() => {
      progressTimerRef.current = null
      const current = navigationRef.current
      if (!enabledRef.current || current.navigationState !== 'NAVIGATING' || !current.goal || current.path.length < 2) return

      const routeDistance = Math.max(0.01, distanceBetween(current.path[0], current.path[current.path.length - 1]))
      const distanceRemainingM = Math.max(0, current.distanceRemainingM - DEMO_ROUTE_SPEED_MPS * (PROGRESS_TICK_MS / 1000))
      const progressPct = Math.min(100, ((routeDistance - distanceRemainingM) / routeDistance) * 100)

      if (distanceRemainingM <= 0) {
        commit({ ...current, navigationState: 'GOAL_REACHED', distanceRemainingM: 0, progressPct: 100 })
        return
      }

      commit({ ...current, distanceRemainingM, progressPct })
      scheduleProgressRef.current()
    }, PROGRESS_TICK_MS)
  }, [commit])

  scheduleProgressRef.current = scheduleProgress

  const beginPlanning = useCallback(() => {
    const current = navigationRef.current
    if (!enabledRef.current || !current.goal) return

    clearTimers()
    commit({ ...current, navigationState: 'PLANNING', path: [] })

    planningTimerRef.current = window.setTimeout(() => {
      planningTimerRef.current = null
      const planning = navigationRef.current
      if (!enabledRef.current || planning.navigationState !== 'PLANNING' || !planning.goal) return

      const start = getCurrentPosition()
      const distanceRemainingM = distanceBetween(start, planning.goal.position)
      commit({
        ...planning,
        navigationState: 'NAVIGATING',
        path: [start, planning.goal.position],
        distanceRemainingM,
        progressPct: 0,
      })
      scheduleProgressRef.current()
    }, PLANNING_MS)
  }, [clearTimers, commit, getCurrentPosition])

  useEffect(() => {
    if (!enabled) {
      clearTimers()
      commit(INITIAL)
    }

    return clearTimers
  }, [clearTimers, commit, enabled])

  const setGoal = useCallback(() => {
    if (!enabledRef.current) return

    goalIndexRef.current = (goalIndexRef.current + 1) % WAYPOINTS.length
    armGoal(WAYPOINTS[goalIndexRef.current])
  }, [armGoal])

  const setGoalAt = useCallback(
    (position: Position2D) => {
      if (!enabledRef.current || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return
      armGoal({ id: 'map-target', label: 'Map target', position, status: 'pending' })
    },
    [armGoal],
  )

  const startNavigation = useCallback(() => {
    const current = navigationRef.current
    if (!enabledRef.current || current.navigationState !== 'READY' || !current.goal) return
    beginPlanning()
  }, [beginPlanning])

  const pauseNavigation = useCallback(() => {
    const current = navigationRef.current
    if (current.navigationState !== 'PLANNING' && current.navigationState !== 'NAVIGATING') return
    clearTimers()
    commit({ ...current, navigationState: 'PAUSED' })
  }, [clearTimers, commit])

  const resumeNavigation = useCallback(() => {
    const current = navigationRef.current
    if (!enabledRef.current || current.navigationState !== 'PAUSED' || !current.goal) return

    if (current.path.length > 1) {
      clearTimers()
      commit({ ...current, navigationState: 'NAVIGATING' })
      scheduleProgressRef.current()
      return
    }

    beginPlanning()
  }, [beginPlanning, clearTimers, commit])

  const cancelNavigation = useCallback(() => {
    const current = navigationRef.current
    if (!current.goal && current.navigationState === 'IDLE') return
    clearTimers()
    commit({ ...current, navigationState: 'CANCELED', path: [], distanceRemainingM: 0, progressPct: 0 })
  }, [clearTimers, commit])

  return { navigation, setGoal, setGoalAt, startNavigation, pauseNavigation, resumeNavigation, cancelNavigation }
}
