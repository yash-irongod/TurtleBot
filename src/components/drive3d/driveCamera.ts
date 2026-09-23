import * as THREE from 'three'
import type { Position2D } from '../../types/robot'

export type CameraMode = 'CHASE' | 'FPV' | 'ORBIT'

export interface DriveCameraManager {
  camera: THREE.PerspectiveCamera
  mode: CameraMode
  setMode: (mode: CameraMode) => void
  update: (
    dtSec: number,
    robotPos: Position2D,
    headingDeg: number,
    linearVel: number,
    angularVel: number,
  ) => void
  snapToRobot: (robotPos: Position2D, headingDeg: number) => void
  resize: (width: number, height: number) => void
}

/**
 * Forza Horizon / GTA-grade dynamic chase camera.
 *
 * Features:
 * - Spring-arm centrifugal yaw lag (camera trails the robot's turning with mass)
 * - Speed-scaled look-ahead (0.45m idle → 1.65m at max speed)
 * - Lateral camera shift into the turn (centripetal "weight" feel)
 * - Acceleration squat: camera lowers and pulls back during acceleration
 * - Braking load: camera rises and pushes forward during hard braking
 * - Dynamic FOV punch: 54° idle → up to 78° at max speed + full acceleration
 * - Subtle FOV narrowing during hard turns (corner-entry feel)
 * - High-speed harmonic road vibration (micro-jitter)
 * - Natural turn roll and banking (with dead zone to prevent micro-banking)
 * - Instant camera snap on mode switch (no 0.8s drift)
 */
export function createDriveCamera(aspect: number): DriveCameraManager {
  const camera = new THREE.PerspectiveCamera(56, aspect, 0.05, 2000)
  camera.position.set(0, 1.2, 2.0)

  let mode: CameraMode = 'CHASE'
  const currentPos = new THREE.Vector3(0, 1.2, 2.0)
  const currentLookAt = new THREE.Vector3(0, 0.1, 0)
  let currentRoll = 0
  let cameraYawLag = 0
  let shakeTime = 0

  // Store last known robot state for instant snap on mode switch
  let lastRobotPos: Position2D = { x: 0, y: 0 }
  let lastHeadingDeg = 0

  // Velocity tracking for acceleration/braking loads
  let prevLinearVel = 0
  let smoothedAccel = 0  // Exponentially smoothed acceleration (m/s²)

  const snapToRobot = (robotPos: Position2D, headingDeg: number) => {
    const headingRad = (headingDeg * Math.PI) / 180
    const forwardX = Math.sin(headingRad)
    const forwardZ = -Math.cos(headingRad)

    cameraYawLag = headingRad

    if (mode === 'CHASE') {
      const dist = 0.96
      const height = 0.44
      currentPos.set(robotPos.x - forwardX * dist, height, robotPos.y - forwardZ * dist)
      currentLookAt.set(robotPos.x + forwardX * 0.5, 0.12, robotPos.y + forwardZ * 0.5)
    } else if (mode === 'FPV') {
      currentPos.set(robotPos.x + forwardX * 0.06, 0.16, robotPos.y + forwardZ * 0.06)
      currentLookAt.set(robotPos.x + forwardX * 2.0, 0.14, robotPos.y + forwardZ * 2.0)
    } else {
      currentPos.set(robotPos.x, 2.5, robotPos.y + 1.8)
      currentLookAt.set(robotPos.x, 0.08, robotPos.y)
    }

    camera.position.copy(currentPos)
    camera.lookAt(currentLookAt)
  }

  const update = (
    dtSec: number,
    robotPos: Position2D,
    headingDeg: number,
    linearVel: number,
    angularVel: number,
  ) => {
    const dt = Math.max(0.001, Math.min(0.1, dtSec))
    shakeTime += dt

    // Store last known robot state for instant mode switch snapping
    lastRobotPos = robotPos
    lastHeadingDeg = headingDeg

    const headingRad = (headingDeg * Math.PI) / 180
    const speedFactor = Math.min(1, Math.max(0, linearVel / 0.22))

    // ─── Acceleration / Braking load ────────────────────────────────────────
    // Compute raw acceleration from velocity delta, then low-pass filter it.
    // This prevents the jittery camera that would happen from frame-by-frame noise.
    const rawAccel = (linearVel - prevLinearVel) / dt  // m/s²
    prevLinearVel = linearVel
    // Exponential low-pass: tau ≈ 0.33s → smooth 3Hz bandwidth
    smoothedAccel += (rawAccel - smoothedAccel) * (1 - Math.exp(-3.0 * dt))

    // Separate acceleration and braking factors (0→1 each)
    // Scale: 2.5 m/s² gives factor=1.0 (TurtleBot max accel is ~0.5 m/s² so
    // we boost it 5× for visible camera response)
    const accelFactor = Math.max(0, Math.min(1, smoothedAccel / 0.5))   // positive = speeding up
    const brakeFactor = Math.max(0, Math.min(1, -smoothedAccel / 0.5))  // positive = slowing down

    // ─── Spring-Arm Yaw Lag ──────────────────────────────────────────────────
    const deltaYaw = Math.atan2(Math.sin(headingRad - cameraYawLag), Math.cos(headingRad - cameraYawLag))
    const yawSpringLambda = 8.0  // slightly more inertia = heavier feel
    cameraYawLag += deltaYaw * (1 - Math.exp(-yawSpringLambda * dt))

    const camForwardX = Math.sin(cameraYawLag)
    const camForwardZ = -Math.cos(cameraYawLag)

    // Right perpendicular to camera forward in XZ plane:
    // Rotate (camForwardX, camForwardZ) by -90° (CCW): (x,z) → (-z, x)
    const rightX = -camForwardZ  //  cos(cameraYawLag)
    const rightZ = camForwardX   //  sin(cameraYawLag)

    const targetPos = new THREE.Vector3()
    const targetLookAt = new THREE.Vector3()
    let targetFov = 56
    let targetRoll = 0

    if (mode === 'CHASE') {
      // ── Distance & height ────────────────────────────────────────────────
      // Pull back further at speed (more environmental parallax)
      const chaseDist = 0.90 + speedFactor * 0.38  // 0.90m idle → 1.28m at max
      // Lower on acceleration (squat feel), rise slightly on braking
      const chaseHeight = 0.44 - speedFactor * 0.03 - accelFactor * 0.04 + brakeFactor * 0.025
      // Push backward on acceleration, forward on braking
      const loadOffset = (accelFactor - brakeFactor) * 0.07  // positive = extra backward offset
      const effectiveDist = chaseDist + loadOffset

      targetPos.set(
        robotPos.x - camForwardX * effectiveDist,
        chaseHeight,
        robotPos.y - camForwardZ * effectiveDist,
      )

      // ── Speed-scaled look-ahead ──────────────────────────────────────────
      // At idle: look 0.45m ahead — keeps robot visible and close.
      // At max speed: look 1.65m ahead — reveals upcoming terrain.
      const lookAheadM = 0.45 + speedFactor * 1.2
      const forwardX = Math.sin(headingRad)
      const forwardZ = -Math.cos(headingRad)
      targetLookAt.set(
        robotPos.x + forwardX * lookAheadM,
        0.11 - brakeFactor * 0.03,  // dip look-at down slightly during braking
        robotPos.y + forwardZ * lookAheadM,
      )

      // ── Lateral shift: centripetal weight into turns ─────────────────────
      // angularVel > 0 = CCW = left turn.
      // Camera shifts right (toward outside of left turn) = centrifugal g-load feel.
      // Only engage at meaningful speeds to prevent micro-jitter when stationary.
      const lateralAmount = angularVel * speedFactor * 0.20
      // Shift camera position toward outside of turn
      targetPos.x += rightX * lateralAmount
      targetPos.z += rightZ * lateralAmount
      // Shift lookAt less (this shows MORE of the upcoming corner — Forza behavior)
      targetLookAt.x += rightX * lateralAmount * 0.25
      targetLookAt.z += rightZ * lateralAmount * 0.25

      // ── Turn banking (roll) ───────────────────────────────────────────────
      // Dead zone: |angular| > 0.12 rad/s prevents micro-banking from small
      // proportional controller corrections during straight travel.
      const rollAngular = Math.abs(angularVel) > 0.12 ? angularVel : 0
      targetRoll = -rollAngular * 0.058

      // ── Dynamic FOV ───────────────────────────────────────────────────────
      // Base: 54° idle. Speed adds up to +24° (78° at max). Acceleration adds
      // up to +5°. Braking narrows slightly (−3°). Hard turning narrows (−4°).
      const turnNarrow = Math.min(4, Math.abs(angularVel) * 1.8 * speedFactor)
      targetFov = 54 + speedFactor * 24 + accelFactor * 5 - brakeFactor * 3 - turnNarrow

    } else if (mode === 'FPV') {
      // ── First-person bumper/hood camera ──────────────────────────────────
      const forwardX = Math.sin(headingRad)
      const forwardZ = -Math.cos(headingRad)

      targetPos.set(
        robotPos.x + forwardX * 0.07,
        0.155,
        robotPos.y + forwardZ * 0.07,
      )
      // FPV look-ahead also scales with speed (subtle)
      const fpvLookAhead = 2.0 + speedFactor * 2.5
      targetLookAt.set(
        robotPos.x + forwardX * fpvLookAhead,
        0.13,
        robotPos.y + forwardZ * fpvLookAhead,
      )
      targetRoll = -(Math.abs(angularVel) > 0.12 ? angularVel : 0) * 0.04
      targetFov = 76

    } else {
      // ── Tactical Drone Camera ─────────────────────────────────────────────
      targetPos.set(
        robotPos.x,
        2.6,
        robotPos.y + 1.85,
      )
      targetLookAt.set(
        robotPos.x,
        0.05,
        robotPos.y,
      )
      targetRoll = 0
      targetFov = 50
    }

    // ── High-Speed Harmonic Road Vibration (Micro-jitter) ──────────────────
    if (speedFactor > 0.15 && mode === 'CHASE') {
      const shakeAmp = speedFactor * 0.0032
      targetPos.x += Math.sin(shakeTime * 47) * shakeAmp
      targetPos.y += Math.cos(shakeTime * 61) * shakeAmp * 0.55
      targetPos.z += Math.sin(shakeTime * 53) * shakeAmp
    }

    // ── Smooth Damping Convergence ──────────────────────────────────────────
    // Slightly more inertia than before (lambda 8.5→7.0) = heavier, more physical
    const posLambda = 7.0
    const lookLambda = 9.0
    currentPos.lerp(targetPos, 1 - Math.exp(-posLambda * dt))
    currentLookAt.lerp(targetLookAt, 1 - Math.exp(-lookLambda * dt))
    currentRoll = THREE.MathUtils.lerp(currentRoll, targetRoll, 1 - Math.exp(-6.0 * dt))

    camera.position.copy(currentPos)
    camera.lookAt(currentLookAt)

    // Apply turn banking roll (after lookAt which resets rotation.z to 0)
    if (Math.abs(currentRoll) > 0.0001) {
      camera.rotation.z += currentRoll
    }

    // Smooth FOV interpolation
    const clampedFov = Math.max(48, Math.min(82, targetFov))
    if (Math.abs(camera.fov - clampedFov) > 0.1) {
      camera.fov = THREE.MathUtils.lerp(camera.fov, clampedFov, 1 - Math.exp(-6.0 * dt))
      camera.updateProjectionMatrix()
    }
  }

  const resize = (width: number, height: number) => {
    if (height <= 0) return
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  return {
    camera,
    get mode() {
      return mode
    },
    setMode: (next: CameraMode) => {
      if (mode !== next) {
        mode = next
        // Reset acceleration state on mode switch to prevent load artifacts
        smoothedAccel = 0
        prevLinearVel = 0
        // Instantly reposition camera on mode switch — prevents the 0.8s slow drift
        snapToRobot(lastRobotPos, lastHeadingDeg)
      }
    },
    update,
    snapToRobot,
    resize,
  }
}
