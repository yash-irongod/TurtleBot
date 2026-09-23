import type { OperationMode, RobotSourceStatus } from '../types/robot'

export interface Autonomous3DPredicateOptions {
  sourceStatus: RobotSourceStatus
  activeMode: OperationMode
  emergencyStopped: boolean
}

/**
 * Pure shared selector defining when the 3D third-person drive view is active.
 *
 * Requirements:
 * - AUTONOMOUS operation mode
 * - Emergency stop is not engaged
 * - In LIVE mode:
 *   * Always show 3D (idle, waiting for map, ready for goal, navigating, exploring)
 * - In DEMO mode:
 *   * Show 3D in autonomous mode (idle, ready, navigating) for consistent operator experience
 */
export function isAutonomous3DActive({
  sourceStatus,
  activeMode,
  emergencyStopped,
}: Autonomous3DPredicateOptions): boolean {
  if (emergencyStopped || activeMode !== 'AUTONOMOUS') return false

  if (sourceStatus === 'LIVE') {
    // In LIVE autonomous mode, 3D is always available as the primary operator view
    // regardless of navigation/exploration state
    return true
  }

  // DEMO mode: show 3D in autonomous for consistent operator experience
  // (idle, ready, navigating) - only hide when not in autonomous
  return sourceStatus === 'DEMO'
}
