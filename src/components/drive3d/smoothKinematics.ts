import type { OdometryState, Position2D } from '../../types/robot'

export interface KinematicsContext {
  /**
   * True only for LIVE mode where we dead-reckon between sparse 100ms ROS packets.
   * In DEMO mode we also dead-reckon (50ms ticks → 20Hz updates) but use a slightly
   * stronger correction when new odom arrives since mock data is authoritative.
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
 * Forza-Grade 60fps Motion Engine.
 *
 * Architecture: Unified dead-reckoning for BOTH DEMO and LIVE modes.
 *
 * Why dead-reckoning instead of position lerping:
 *   - DEMO mode: mock tick fires every 50ms (20Hz). Position lerping would produce
 *     20 visible steps per second. Dead-reckoning at 60fps produces 60 smooth steps
 *     per second. Since we integrate with the same dt*velocity formula that mockTelemetry
 *     uses, dead-reckoned position is MATHEMATICALLY IDENTICAL to what the next tick
 *     will report → zero correction needed at tick boundaries → seamless motion.
 *
 *   - LIVE mode: ROS odometry arrives at ~10Hz. Dead-reckoning at 60fps fills in
 *     the 6 frames between packets. Soft correction on each new ROS odom packet.
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

    // ─────────────────────────────────────────────────────────────────────
    // 1. Velocity smoothing (fast low-pass, always runs)
    //    velLambda=12 → ~17% blend per 16ms frame → velocity tracks tightly
    // ─────────────────────────────────────────────────────────────────────
    const velBlend = 1 - Math.exp(-12.0 * dt)
    linearVel += (targetOdom.linearVelocity - linearVel) * velBlend
    angularVel += (targetOdom.angularVelocity - angularVel) * velBlend

    // ─────────────────────────────────────────────────────────────────────
    // 2. Dead-Reckoning (runs every frame in BOTH modes)
    //
    //    Coordinate system:
    //      map.x = East,  map.y = South (y increases southward)
    //      scene.x = map.x,  scene.z = map.y
    //      heading 0 = North → forward in map = (x=0, y=-1)
    //      sin(headingRad) = x component of forward
    //      -cos(headingRad) = y component of forward (y decreases = North)
    //
    //    Heading convention (same as mockTelemetry.stepOdometry):
    //      positive angular = CCW (left turn) = headingDeg DECREASES
    //      → headingRad decreases when angular > 0
    //      → headingRad -= angularVel * dt
    // ─────────────────────────────────────────────────────────────────────
    const forwardX = Math.sin(headingRad)
    const forwardY = -Math.cos(headingRad)
    posX += forwardX * linearVel * dt
    posY += forwardY * linearVel * dt
    headingRad -= angularVel * dt

    // ─────────────────────────────────────────────────────────────────────
    // 3. Soft correction when new telemetry arrives
    //
    //    odomChanged detects a new tick from the data source.
    //    At DEMO 50ms ticks: dead-reckoned pos ≈ actual (same formula),
    //    so correction magnitude is near-zero → seamless.
    //    At LIVE 100ms ROS packets: correction compensates for any IMU drift.
    //
    //    isLiveMode uses gentler correction (lambda=3) since ROS odom may
    //    have small noise. DEMO uses lambda=4 (stronger, but still gentle).
    // ─────────────────────────────────────────────────────────────────────
    const isLive = ctx?.isLiveMode ?? false
    const odomChanged =
      targetOdom.position.x !== lastOdomX ||
      targetOdom.position.y !== lastOdomY

    if (odomChanged) {
      lastOdomX = targetOdom.position.x
      lastOdomY = targetOdom.position.y

      const corrLambda = isLive ? 3.0 : 4.0
      const corrBlend = 1 - Math.exp(-corrLambda * dt)
      posX += (targetOdom.position.x - posX) * corrBlend
      posY += (targetOdom.position.y - posY) * corrBlend
    }

    // ─────────────────────────────────────────────────────────────────────
    // 4. Heading convergence (every frame — prevents unbounded drift)
    //
    //    Even after dead-reckoning, we softly pull heading toward the
    //    authoritative telemetry value each frame. This catches any
    //    accumulated floating-point error and ensures alignment with odom.
    //    Lambda=6 during turns (fast-tracking), 4 at rest (gentle).
    // ─────────────────────────────────────────────────────────────────────
    const targetHeadingRad = (targetOdom.headingDeg * Math.PI) / 180

    // Shortest-path angular error, always pull softly toward authoritative heading
    const angErr = Math.atan2(
      Math.sin(targetHeadingRad - headingRad),
      Math.cos(targetHeadingRad - headingRad),
    )
    const angLambda = Math.abs(angularVel) > 0.08 ? 6.0 : 4.0
    headingRad += angErr * (1 - Math.exp(-angLambda * dt))

    // Normalize to [-PI, PI] to prevent unbounded accumulation
    headingRad = Math.atan2(Math.sin(headingRad), Math.cos(headingRad))

    // ─────────────────────────────────────────────────────────────────────
    // 5. Suspension Physics (purely visual — pitch & roll)
    // ─────────────────────────────────────────────────────────────────────
    const accel = (linearVel - prevLinearVel) / dt
    prevLinearVel = linearVel

    const targetPitch = Math.max(-0.04, Math.min(0.04, -accel * 0.025))
    const targetRoll = Math.max(-0.025, Math.min(0.025, -angularVel * linearVel * 0.04))

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
