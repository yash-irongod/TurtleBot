import type { LidarScan, MotorState, NetworkState, OdometryState, BatteryState, ImuState, RobotDataSource, RobotTelemetry, VelocityCommand } from '../types/robot'
import { clamp, normalizeDeg, pseudoRandom } from '../lib/polar'
import { SAFE_ANGULAR_RADPS, SAFE_LINEAR_MPS, SAFE_REVERSE_MPS } from '../lib/safety'

/**
 * Demo data source.
 *
 * This is an explicitly DEMO-only source. It owns its timer and simulated
 * telemetry feed, while RobotContext owns the command safety boundary. The
 * real ROS-backed source lives in rosRobotDataSource.ts and is selected only
 * when the application is in LIVE mode.
 */

import { DEMO_OBSTACLE_ITEMS } from './mapGrid'

const LIDAR_RANGE_MAX_M = 3.5
const LIDAR_STEP_DEG = 2

export function generateLidarScan(tick: number, odometry?: OdometryState): LidarScan {
  const points: LidarScan['points'] = []
  const robX = odometry?.position.x ?? 0
  const robY = odometry?.position.y ?? 0
  const headingDeg = odometry?.headingDeg ?? 0
  const headingRad = (headingDeg * Math.PI) / 180

  for (let angleDeg = 0; angleDeg < 360; angleDeg += LIDAR_STEP_DEG) {
    const rayAngleRad = headingRad + (angleDeg * Math.PI) / 180
    const dirX = Math.sin(rayAngleRad)
    const dirY = -Math.cos(rayAngleRad)

    let minDistance = LIDAR_RANGE_MAX_M

    // Test against static disaster arena obstacles
    for (const obs of DEMO_OBSTACLE_ITEMS) {
      const toObsX = obs.x - robX
      const toObsY = obs.y - robY
      const proj = toObsX * dirX + toObsY * dirY
      if (proj > 0) {
        const perpSq = toObsX * toObsX + toObsY * toObsY - proj * proj
        const rSq = obs.radius * obs.radius
        if (perpSq < rSq) {
          const hitDist = proj - Math.sqrt(Math.max(0, rSq - perpSq))
          if (hitDist > 0.05 && hitDist < minDistance) {
            minDistance = hitDist
          }
        }
      }
    }

    // Outer arena perimeter bounds (x in [-3.4, 3.4], y in [-2.2, 2.2])
    const xWall = dirX > 0 ? (3.4 - robX) / dirX : dirX < 0 ? (-3.4 - robX) / dirX : 999
    const yWall = dirY > 0 ? (2.2 - robY) / dirY : dirY < 0 ? (-2.2 - robY) / dirY : 999
    const wallDist = Math.min(xWall > 0 ? xWall : 999, yWall > 0 ? yWall : 999)
    if (wallDist < minDistance) {
      minDistance = wallDist
    }

    const jitter = (pseudoRandom(angleDeg + tick * 13.7) - 0.5) * 0.015
    points.push({ angleDeg, distanceM: clamp(minDistance + jitter, 0.12, LIDAR_RANGE_MAX_M) })
  }
  return { points, rangeMaxM: LIDAR_RANGE_MAX_M, timestamp: Date.now() }
}

function stepOdometry(
  prev: OdometryState,
  dtSec: number,
  command: VelocityCommand,
): OdometryState {
  // No command means no motion. Demo telemetry can still update its sensors,
  // but releasing manual input, canceling a goal, or entering E-stop always
  // settles odometry at zero rather than letting a background wander begin.
  const { linear, angular } = command

  const headingDeg = normalizeDeg(prev.headingDeg - angular * dtSec * (180 / Math.PI))
  const headingRad = (headingDeg * Math.PI) / 180

  return {
    position: {
      x: prev.position.x + linear * dtSec * Math.sin(headingRad),
      y: prev.position.y - linear * dtSec * Math.cos(headingRad),
    },
    headingDeg,
    linearVelocity: linear,
    angularVelocity: angular,
  }
}

function stepBattery(prev: BatteryState, dtSec: number): BatteryState {
  const percentage = clamp(prev.percentage - dtSec * 0.0035, 0, 100)
  const voltage = 12.6 * (0.86 + (percentage / 100) * 0.14) + (pseudoRandom(percentage * 7) - 0.5) * 0.02
  const current = -0.85 - Math.abs(Math.sin(Date.now() / 4200)) * 0.35
  return { percentage, voltage, current, charging: false }
}

function stepImu(odometry: OdometryState, tick: number): ImuState {
  return {
    roll: (pseudoRandom(tick * 3.1) - 0.5) * 1.1,
    pitch: (pseudoRandom(tick * 5.7) - 0.5) * 1.1,
    yaw: odometry.headingDeg,
    linearAcceleration: {
      x: (pseudoRandom(tick * 2.2) - 0.5) * 0.4,
      y: (pseudoRandom(tick * 7.4) - 0.5) * 0.4,
      z: 9.81 + (pseudoRandom(tick * 1.3) - 0.5) * 0.05,
    },
    angularVelocity: { x: 0, y: 0, z: odometry.angularVelocity },
  }
}

function stepMotors(odometry: OdometryState, tick: number): MotorState[] {
  const baseRpm = Math.abs(odometry.linearVelocity) * 210
  const turnBias = odometry.angularVelocity * 55
  return [
    {
      id: 'left_wheel',
      label: 'LEFT WHEEL',
      rpm: Math.max(0, baseRpm - turnBias),
      temperatureC: 34 + Math.sin(tick / 50) * 2.4,
      health: 'nominal',
    },
    {
      id: 'right_wheel',
      label: 'RIGHT WHEEL',
      rpm: Math.max(0, baseRpm + turnBias),
      temperatureC: 34.6 + Math.cos(tick / 50) * 2.4,
      health: 'nominal',
    },
  ]
}

function stepNetwork(): NetworkState {
  return {
    latencyMs: 0,
    signalPct: 0,
    rosbridgeConnected: false,
  }
}

function createInitialTelemetry(): RobotTelemetry {
  const odometry: OdometryState = { position: { x: 0, y: 0 }, headingDeg: 0, linearVelocity: 0, angularVelocity: 0 }
  return {
    // The demo feed is available locally, but it is not a ROS connection.
    connection: 'offline',
    odometry,
    battery: { percentage: 87, voltage: 12.1, current: -0.9, charging: false },
    imu: stepImu(odometry, 0),
    lidar: generateLidarScan(0, odometry),
    motors: stepMotors(odometry, 0),
    network: stepNetwork(),
    temperatureC: 37.4,
    lidarHealth: 'nominal',
    rosHealth: 'warning',
    timestamp: Date.now(),
  }
}

function step(
  prev: RobotTelemetry,
  tick: number,
  dtSec: number,
  command: VelocityCommand,
): RobotTelemetry {
  const odometry = stepOdometry(prev.odometry, dtSec, command)
  const battery = stepBattery(prev.battery, dtSec)
  return {
    connection: 'offline',
    odometry,
    battery,
    imu: stepImu(odometry, tick),
    lidar: generateLidarScan(tick, odometry),
    motors: stepMotors(odometry, tick),
    network: stepNetwork(),
    temperatureC: clamp(prev.temperatureC + (pseudoRandom(tick) - 0.5) * 0.006, 30, 55),
    lidarHealth: 'nominal',
    rosHealth: 'warning',
    timestamp: Date.now(),
  }
}

const TICK_MS = 50
const STOP_COMMAND: VelocityCommand = { linear: 0, angular: 0 }

function sanitizeDemoCommand(command: VelocityCommand): VelocityCommand {
  if (!Number.isFinite(command.linear) || !Number.isFinite(command.angular)) return STOP_COMMAND
  return {
    linear: clamp(command.linear, -SAFE_REVERSE_MPS, SAFE_LINEAR_MPS),
    angular: clamp(command.angular, -SAFE_ANGULAR_RADPS, SAFE_ANGULAR_RADPS),
  }
}

/**
 * Creates an isolated demo source. Exporting the factory keeps provider
 * injection testable without adding a fake live source or ROS transport.
 */
export function createMockRobotDataSource(): RobotDataSource {
  let telemetry = createInitialTelemetry()
  let tick = 0
  let command = STOP_COMMAND
  let intervalId: number | null = null
  const listeners = new Set<(next: RobotTelemetry) => void>()

  const stopTicker = () => {
    if (intervalId !== null) window.clearInterval(intervalId)
    intervalId = null
  }

  const advance = () => {
    tick += 1
    telemetry = step(telemetry, tick, TICK_MS / 1000, command)
    listeners.forEach((listener) => listener(telemetry))
  }

  const startTicker = () => {
    if (intervalId === null) intervalId = window.setInterval(advance, TICK_MS)
  }

  return {
    sourceStatus: 'DEMO',
    getInitialTelemetry: () => telemetry,
    subscribe: (listener) => {
      listeners.add(listener)
      startTicker()

      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          command = STOP_COMMAND
          stopTicker()
        }
      }
    },
    sendVelocityCommand: (nextCommand) => {
      command = sanitizeDemoCommand(nextCommand)
    },
  }
}

/** The one concrete RobotDataSource this app has today. */
export const mockRobotDataSource = createMockRobotDataSource()
