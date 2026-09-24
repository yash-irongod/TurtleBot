import type { ExplorationInfo, NavigationInfo, OperationMode, RobotSourceStatus } from '../types/robot'

export interface Autonomous3DPredicateOptions {
  sourceStatus: RobotSourceStatus
  activeMode: OperationMode
  emergencyStopped: boolean
  navigation: NavigationInfo
  exploration?: ExplorationInfo
}

/**
 * Pure shared selector defining when the 3D third-person drive view is active.
 *
 * Requirements:
 * - AUTONOMOUS operation mode
 * - Emergency stop is not engaged
 * - In LIVE mode:
 *   * Actively NAVIGATING with Nav2 OR actively EXPLORING with Frontier Explorer
 * - In DEMO mode:
 *   * Navigation state is actively NAVIGATING with valid goal and path
 */
export function isAutonomous3DActive({
  sourceStatus,
  activeMode,
  emergencyStopped,
  navigation,
  exploration,
}: Autonomous3DPredicateOptions): boolean {
  if (emergencyStopped || activeMode !== 'AUTONOMOUS') return false

  if (sourceStatus === 'LIVE') {
    const isNavigating = navigation.navigationState === 'NAVIGATING'
    const isExploring = exploration?.state === 'EXPLORING'
    return isNavigating || isExploring
  }

  return (
    sourceStatus === 'DEMO' &&
    navigation.navigationState === 'NAVIGATING' &&
    navigation.goal !== null &&
    navigation.path.length >= 2
  )
}
