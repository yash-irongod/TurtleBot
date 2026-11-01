import type { OdometryState, Position2D } from '../../types/robot'

export interface KinematicsContext {
  /**
   * True for LIVE mode where we dead-reckon between 20Hz (50ms) ROS packets.
   */
  isLiveMode?: boolean
}

export interface SmoothKinematicsState {
  /** Smoothed render position in map/scene space (x = East, y = South) */
  position: Position2D
  /**
   * Heading in radians: 0 = North (scene -Z), clockwise positive.
   * Applied to scene as rotation.y = -headingRad.
   */
  headingRad: number
  /** Heading in degrees (0–360, 0 = North CW) for display */
  headingDeg: number
  /** Smoothed linear velocity (m/s) for camera and wheel animation */
  linearVelocity: number
  /** Smoothed angular velocity (rad/s) for camera banking */
  angularVelocity: number
  /** Chassis pitch — tilts back on acceleration, forward on braking */
  pitchRad: number
  /** Chassis roll — centrifugal lean during real turns */
  rollRad: number
}

export interface SmoothKinematicsIntegrator {
  update: (dtSec: number, targetOdom: OdometryState, ctx?: KinematicsContext) => SmoothKinematicsState
  snapTo: (targetOdom: OdometryState) => void
  getState: () => SmoothKinematicsState
}

/**
 * 60fps Precision Motion Engine.
 *
 * Architecture: Unified dead-reckoning for BOTH DEMO and LIVE modes.
 *
 * Heading convention: 0 = North, clockwise positive (matches TurtleBot compass frame).
 * In mockTelemetry: headingDeg decreases when angular > 0 (CCW = left turn).
 * In scene: rotation.y = -headingRad.
 */
export function createSmoothKinematics(initialOdom: OdometryState): SmoothKinematicsIntegrator {
  let posX = initialOdom.position.x
  let posY = initialOdom.position.y
  let headingRad = (initialOdom.headingDeg * Math.PI) / 180
  let linearVel = initialOdom.linearVelocity
  let angularVel = initialOdom.angularVelocity
  let pitchRad = 0
  let rollRad = 0
  let prevLinearVel = initialOdom.linearVelocity

  // Track last seen odom position to detect actual telemetry position updates
  let lastOdomX = initialOdom.position.x
  let lastOdomY = initialOdom.position.y

  const snapTo = (odom: OdometryState) => {
    posX = odom.position.x
    posY = odom.position.y
    headingRad = (odom.headingDeg * Math.PI) / 180
    linearVel = odom.linearVelocity
    angularVel = odom.angularVelocity
    lastOdomX = odom.position.x
    lastOdomY = odom.position.y
    pitchRad = 0
    rollRad = 0
    prevLinearVel = odom.linearVelocity
  }

  const update = (
    dtSec: number,
    targetOdom: OdometryState,
    ctx?: KinematicsContext,
  ): SmoothKinematicsState => {
    // Cap dt: max 50ms prevents huge jumps when tab regains focus
    const dt = Math.max(0.001, Math.min(0.05, dtSec))

    // Handle large teleports / map resets
    const distToTarget = Math.hypot(targetOdom.position.x - posX, targetOdom.position.y - posY)
    if (distToTarget > 1.0) {
      snapTo(targetOdom)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 1. Velocity smoothing (fast low-pass, always runs)
    //    velLambda=12 → ~17% blend per 16ms frame → velocity tracks tightly
    // ─────────────────────────────────────────────────────────────────────
    const velBlend = 1 - Math.exp(-12.0 * dt)
    linearVel += (targetOdom.linearVelocity - linearVel) * velBlend
    angularVel += (targetOdom.angularVelocity - angularVel) * velBlend

    const isLive = ctx?.isLiveMode ?? false

    if (isLive) {
      // ─────────────────────────────────────────────────────────────────────
      // LIVE Mode: Directly & smoothly converge to authoritative 20 Hz SLAM pose.
      // Eliminates open-loop velocity integration drift, jitter, and spinning.
      // Rate lambda = 18.0 provides ~25% blend per 16ms frame (smooth, responsive).
      // ─────────────────────────────────────────────────────────────────────
      const posBlend = 1 - Math.exp(-18.0 * dt)
      posX += (targetOdom.position.x - posX) * posBlend
      posY += (targetOdom.position.y - posY) * posBlend

      const targetHeadingRad = (targetOdom.headingDeg * Math.PI) / 180
      const angErr = Math.atan2(
        Math.sin(targetHeadingRad - headingRad),
        Math.cos(targetHeadingRad - headingRad),
      )
      const angBlend = 1 - Math.exp(-18.0 * dt)
      headingRad += angErr * angBlend
      headingRad = Math.atan2(Math.sin(headingRad), Math.cos(headingRad))
    } else {
      // ─────────────────────────────────────────────────────────────────────
      // DEMO Mode: Dead-Reckoning from simulated velocities.
      // ─────────────────────────────────────────────────────────────────────
      const forwardX = Math.sin(headingRad)
      const forwardY = -Math.cos(headingRad)
      posX += forwardX * linearVel * dt
      posY += forwardY * linearVel * dt
      headingRad -= angularVel * dt

      const odomChanged =
        targetOdom.position.x !== lastOdomX ||
        targetOdom.position.y !== lastOdomY

      if (odomChanged) {
        lastOdomX = targetOdom.position.x
        lastOdomY = targetOdom.position.y

        const corrBlend = 1 - Math.exp(-4.0 * dt)
        posX += (targetOdom.position.x - posX) * corrBlend
        posY += (targetOdom.position.y - posY) * corrBlend
      }

      const isAtRest = Math.abs(linearVel) < 0.005 && Math.abs(angularVel) < 0.01
      if (isAtRest) {
        const restBlend = 1 - Math.exp(-6.0 * dt)
        posX += (targetOdom.position.x - posX) * restBlend
        posY += (targetOdom.position.y - posY) * restBlend
      }

      const targetHeadingRad = (targetOdom.headingDeg * Math.PI) / 180
      const angErr = Math.atan2(
        Math.sin(targetHeadingRad - headingRad),
        Math.cos(targetHeadingRad - headingRad),
      )
      const angLambda = Math.abs(angularVel) > 0.08 ? 6.0 : (isAtRest ? 8.0 : 4.0)
      headingRad += angErr * (1 - Math.exp(-angLambda * dt))
      headingRad = Math.atan2(Math.sin(headingRad), Math.cos(headingRad))
    }

    // ─────────────────────────────────────────────────────────────────────
    // 5. Suspension Physics (purely visual — pitch & roll)
    // ─────────────────────────────────────────────────────────────────────
    const accel = (linearVel - prevLinearVel) / dt
    prevLinearVel = linearVel

    const targetPitch = Math.max(-0.04, Math.min(0.04, accel * 0.025))
    const targetRoll = Math.max(-0.025, Math.min(0.025, angularVel * linearVel * 0.04))

    const suspBlend = 1 - Math.exp(-8.0 * dt)
    pitchRad += (targetPitch - pitchRad) * suspBlend
    rollRad += (targetRoll - rollRad) * suspBlend

    const headingDeg = (((headingRad * 180) / Math.PI) % 360 + 360) % 360

    return {
      position: { x: posX, y: posY },
      headingRad,
      headingDeg,
      linearVelocity: linearVel,
      angularVelocity: angularVel,
      pitchRad,
      rollRad,
    }
  }

  const getState = (): SmoothKinematicsState => {
    const headingDeg = (((headingRad * 180) / Math.PI) % 360 + 360) % 360
    return {
      position: { x: posX, y: posY },
      headingRad,
      headingDeg,
      linearVelocity: linearVel,
      angularVelocity: angularVel,
      pitchRad,
      rollRad,
    }
  }

  return { update, snapTo, getState }
}
