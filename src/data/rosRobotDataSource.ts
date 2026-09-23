import type {
  BatteryState,
  ExplorationInfo,
  HealthLevel,
  ImuState,
  LidarPoint,
  LidarScan,
  MotorState,
  NavigationInfo,
  NavigationState,
  NetworkState,
  OccupancyGrid,
  OdometryState,
  RobotDataSource,
  RobotNavigationDataSource,
  RobotSourceStatus,
  RobotTelemetry,
  SelectedFrontier,
  VelocityCommand,
  Waypoint,
} from '../types/robot'
import {
  convertRosOccupancyGridToFrontend,
  frontendHeadingDegToRosYaw,
  frontendToRosPosition,
  rosToFrontendPosition,
  rosYawToFrontendHeadingDeg,
  type RosOccupancyGridPayload,
} from '../lib/rosCoordinates'

const DEFAULT_ROS_BRIDGE_URL = 'ws://192.168.0.112:8765'
const RECONNECT_DELAY_MS = 3000
const LIDAR_RANGE_MAX_DEFAULT = 3.5

function createFallbackTelemetry(): RobotTelemetry {
  const odometry: OdometryState = {
    position: { x: 0, y: 0 },
    headingDeg: 0,
    linearVelocity: 0,
    angularVelocity: 0,
  }
  const imu: ImuState = {
    roll: 0,
    pitch: 0,
    yaw: 0,
    linearAcceleration: { x: 0, y: 0, z: 9.81 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  }
  const battery: BatteryState = {
    percentage: 0,
    voltage: 0,
    current: 0,
    charging: false,
  }
  const lidar: LidarScan = {
    points: [],
    rangeMaxM: LIDAR_RANGE_MAX_DEFAULT,
    timestamp: Date.now(),
  }
  const motors: MotorState[] = []
  const network: NetworkState = {
    latencyMs: 0,
    signalPct: 0,
    rosbridgeConnected: false,
  }

  return {
    connection: 'offline',
    odometry,
    battery,
    imu,
    lidar,
    motors,
    network,
    temperatureC: 0,
    lidarHealth: 'warning',
    rosHealth: 'warning',
    timestamp: Date.now(),
  }
}

/**
 * Flexible payload parser that adapts to telemetry packets emitted by bridge.py.
 * Centralizes conversion through src/lib/rosCoordinates.ts to maintain 100%
 * coordinate consistency across /odom, /map, LiDAR, and Nav2 goals.
 */
function parseBridgePayload(raw: any, current: RobotTelemetry): RobotTelemetry {
  if (!raw || typeof raw !== 'object') return current

  const data = raw.data ?? raw.msg ?? raw.payload ?? raw
  const now = Date.now()

  // 1. Odometry extraction: convert ROS REP-103 to frontend presentation coordinates
  const rawOdom =
    data.odometry ??
    data.odom ??
    (data.linear_x !== undefined || data.angular_z !== undefined || data.pose || data.twist || data.x !== undefined
      ? data
      : null)

  let odometry: OdometryState = current.odometry
  if (rawOdom) {
    const rawPos = rawOdom.position ?? rawOdom.pose?.pose?.position ?? rawOdom.pose?.position ?? rawOdom
    const rawX =
      typeof rawPos.x === 'number'
        ? rawPos.x
        : typeof data.x === 'number'
          ? data.x
          : odometry.position.x
    const rawY =
      typeof rawPos.y === 'number'
        ? rawPos.y
        : typeof data.y === 'number'
          ? data.y
          : -odometry.position.y

    // Convert ROS REP-103 (+X East, +Y North) to frontend presentation (+X East, -Y North)
    const position = rosToFrontendPosition(rawX, rawY)

    // Heading: bridge sends yaw_rad (preferred, added to fix coordinate mismatch) or
    // headingDeg (legacy, 0=East ROS convention). Both need rosYawToFrontendHeadingDeg
    // to produce frontend compass bearing: 0°=North, 90°=East, increases CW.
    let headingDeg = odometry.headingDeg
    if (typeof rawOdom.yaw_rad === 'number') {
      // Preferred path: raw ROS yaw in radians → frontend compass bearing
      headingDeg = rosYawToFrontendHeadingDeg(rawOdom.yaw_rad)
    } else if (typeof rawOdom.headingDeg === 'number') {
      // Legacy path: bridge sent degrees in ROS convention (0=East) — convert
      headingDeg = rosYawToFrontendHeadingDeg((rawOdom.headingDeg * Math.PI) / 180)
    } else if (typeof data.headingDeg === 'number') {
      headingDeg = rosYawToFrontendHeadingDeg((data.headingDeg * Math.PI) / 180)
    } else if (typeof rawOdom.heading === 'number') {
      headingDeg = rosYawToFrontendHeadingDeg((rawOdom.heading * Math.PI) / 180)
    } else if (typeof rawOdom.yaw === 'number') {
      headingDeg = rosYawToFrontendHeadingDeg(rawOdom.yaw)
    } else if (typeof data.yaw === 'number') {
      headingDeg = rosYawToFrontendHeadingDeg(data.yaw)
    } else {
      const q =
        rawOdom.orientation ??
        rawOdom.pose?.pose?.orientation ??
        rawOdom.pose?.orientation ??
        data.orientation ??
        data.pose?.orientation
      if (q && typeof q.z === 'number' && typeof q.w === 'number') {
        const qx = q.x ?? 0
        const qy = q.y ?? 0
        const qz = q.z
        const qw = q.w
        const sinyCosp = 2 * (qw * qz + qx * qy)
        const cosyCosp = 1 - 2 * (qy * qy + qz * qz)
        const yawRad = Math.atan2(sinyCosp, cosyCosp)
        headingDeg = rosYawToFrontendHeadingDeg(yawRad)
      }
    }

    // Normalized to [0, 360)
    headingDeg = ((headingDeg % 360) + 360) % 360

    // Velocities: consume linear_x and angular_z per bridge.py specification
    const linearVelocity =
      typeof rawOdom.linear_x === 'number'
        ? rawOdom.linear_x
        : typeof data.linear_x === 'number'
          ? data.linear_x
          : typeof rawOdom.linearVelocity === 'number'
            ? rawOdom.linearVelocity
            : typeof rawOdom.linear === 'number'
              ? rawOdom.linear
              : typeof rawOdom.twist?.twist?.linear?.x === 'number'
                ? rawOdom.twist.twist.linear.x
                : typeof rawOdom.twist?.linear?.x === 'number'
                  ? rawOdom.twist.linear.x
                  : typeof rawOdom.twist?.linear_x === 'number'
                    ? rawOdom.twist.linear_x
                    : typeof data.linear?.x === 'number'
                      ? data.linear.x
                      : odometry.linearVelocity

    const angularVelocity =
      typeof rawOdom.angular_z === 'number'
        ? rawOdom.angular_z
        : typeof data.angular_z === 'number'
          ? data.angular_z
          : typeof rawOdom.angularVelocity === 'number'
            ? rawOdom.angularVelocity
            : typeof rawOdom.angular === 'number'
              ? rawOdom.angular
              : typeof rawOdom.twist?.twist?.angular?.z === 'number'
                ? rawOdom.twist.twist.angular.z
                : typeof rawOdom.twist?.angular?.z === 'number'
                  ? rawOdom.twist.angular.z
                  : typeof rawOdom.twist?.angular_z === 'number'
                    ? rawOdom.twist.angular_z
                    : typeof data.angular?.z === 'number'
                      ? data.angular.z
                      : odometry.angularVelocity

    odometry = {
      position,
      headingDeg,
      linearVelocity,
      angularVelocity,
    }
  }

  // 2. LiDAR Scan extraction
  const rawScan = data.lidar ?? data.scan
  let lidar: LidarScan = current.lidar
  let lidarHealth: HealthLevel = current.lidarHealth
  if (rawScan) {
    const rangeMax = typeof rawScan.rangeMaxM === 'number' ? rawScan.rangeMaxM : (rawScan.range_max ?? LIDAR_RANGE_MAX_DEFAULT)

    if (Array.isArray(rawScan.points)) {
      lidar = {
        points: rawScan.points,
        rangeMaxM: rangeMax,
        timestamp: now,
      }
      lidarHealth = rawScan.points.length > 0 ? 'nominal' : 'warning'
    } else if (Array.isArray(rawScan.ranges)) {
      const ranges: number[] = rawScan.ranges
      const angleMin = typeof rawScan.angle_min === 'number' ? rawScan.angle_min : 0
      const angleIncrement =
        typeof rawScan.angle_increment === 'number' ? rawScan.angle_increment : (2 * Math.PI) / Math.max(1, ranges.length)
      const rangeMin = typeof rawScan.range_min === 'number' ? rawScan.range_min : 0.12

      const points: LidarPoint[] = []
      for (let i = 0; i < ranges.length; i++) {
        const d = ranges[i]
        if (Number.isFinite(d) && d >= rangeMin && d <= rangeMax) {
          const rad = angleMin + i * angleIncrement
          // Map ROS CCW angle from forward into display polar angle (0 = forward, CW positive)
          const deg = (((-rad * 180 / Math.PI) % 360) + 360) % 360
          points.push({ angleDeg: deg, distanceM: d })
        }
      }
      lidar = {
        points,
        rangeMaxM: rangeMax,
        timestamp: now,
      }
      lidarHealth = points.length > 0 ? 'nominal' : 'warning'
    }
  }

  // 3. IMU extraction
  const rawImu = data.imu
  let imu: ImuState = current.imu
  if (rawImu) {
    let roll = current.imu.roll
    let pitch = current.imu.pitch
    let yaw = odometry.headingDeg

    const q = rawImu.orientation ?? rawImu.pose?.orientation
    if (q && typeof q.w === 'number' && typeof q.z === 'number') {
      const qx = q.x ?? 0
      const qy = q.y ?? 0
      const qz = q.z
      const qw = q.w

      // Roll (x-axis rotation)
      const sinrCosp = 2 * (qw * qx + qy * qz)
      const cosrCosp = 1 - 2 * (qx * qx + qy * qy)
      roll = (Math.atan2(sinrCosp, cosrCosp) * 180) / Math.PI

      // Pitch (y-axis rotation)
      const sinp = 2 * (qw * qy - qz * qx)
      pitch = (Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp)) * (180 / Math.PI)

      // Yaw (z-axis rotation)
      const sinyCosp = 2 * (qw * qz + qx * qy)
      const cosyCosp = 1 - 2 * (qy * qy + qz * qz)
      const yawRad = Math.atan2(sinyCosp, cosyCosp)
      yaw = rosYawToFrontendHeadingDeg(yawRad)
    } else {
      if (typeof rawImu.roll === 'number') roll = rawImu.roll
      if (typeof rawImu.pitch === 'number') pitch = rawImu.pitch
      if (typeof rawImu.yaw === 'number') yaw = rosYawToFrontendHeadingDeg(rawImu.yaw)
    }

    imu = {
      roll,
      pitch,
      yaw,
      linearAcceleration: {
        x: rawImu.linearAcceleration?.x ?? rawImu.linear_acceleration?.x ?? imu.linearAcceleration.x,
        y: rawImu.linearAcceleration?.y ?? rawImu.linear_acceleration?.y ?? imu.linearAcceleration.y,
        z: rawImu.linearAcceleration?.z ?? rawImu.linear_acceleration?.z ?? imu.linearAcceleration.z,
      },
      angularVelocity: {
        x: rawImu.angularVelocity?.x ?? rawImu.angular_velocity?.x ?? imu.angularVelocity.x,
        y: rawImu.angularVelocity?.y ?? rawImu.angular_velocity?.y ?? imu.angularVelocity.y,
        z: rawImu.angularVelocity?.z ?? rawImu.angular_velocity?.z ?? odometry.angularVelocity,
      },
    }
  }

  // 4. Battery extraction
  const rawBattery = data.battery ?? data.battery_state
  let battery: BatteryState = current.battery
  if (rawBattery) {
    let percentage = typeof rawBattery.percentage === 'number' ? rawBattery.percentage : battery.percentage
    if (percentage <= 1.0 && percentage > 0) percentage = percentage * 100
    percentage = Math.max(0, Math.min(100, percentage))

    battery = {
      percentage,
      voltage: typeof rawBattery.voltage === 'number' ? rawBattery.voltage : battery.voltage,
      current: typeof rawBattery.current === 'number' ? rawBattery.current : battery.current,
      charging: Boolean(rawBattery.charging || rawBattery.power_supply_status === 1),
    }
  }

  // 5. Motor status: strictly real telemetry, no invented RPM
  const motors: MotorState[] = Array.isArray(data.motors) ? data.motors : []

  return {
    connection: 'online',
    odometry,
    battery,
    imu,
    lidar,
    motors,
    network: {
      latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : current.network.latencyMs,
      signalPct: typeof data.signalPct === 'number' ? data.signalPct : 0,
      rosbridgeConnected: true,
    },
    temperatureC:
      typeof data.temperatureC === 'number'
        ? data.temperatureC
        : typeof data.temperature === 'number'
          ? data.temperature
          : 0,
    lidarHealth,
    rosHealth: 'nominal',
    timestamp: now,
  }
}

export interface RosRobotDataSourceOptions {
  url?: string
}

/**
 * Creates a real ROS 2 RobotDataSource that communicates directly with
 * bridge.py over WebSocket at ws://192.168.0.112:8765.
 *
 * Implements:
 * - Real /odom, /scan, /imu, /battery_state telemetry
 * - Real /cmd_vel publishing
 * - Real Nav2 NavigateToPose action dispatching & feedback
 * - Real Frontier Explorer subprocess start/stop & telemetry
 * - Real /map OccupancyGrid streaming & conversion
 */
export function createRosRobotDataSource(options: RosRobotDataSourceOptions = {}): RobotDataSource {
  const url = options.url ?? DEFAULT_ROS_BRIDGE_URL
  let status: RobotSourceStatus = 'DISCONNECTED'
  let telemetry = createFallbackTelemetry()
  let ws: WebSocket | null = null
  let reconnectTimer: number | null = null
  let isSubscribed = false
  let socketGeneration = 0
  let handshakeTimer: number | null = null
  let manualHeartbeatTimer: number | null = null
  let lastVelocityCommand: VelocityCommand = { linear: 0, angular: 0 }
  let manualSessionId: string | null = null
  let manualSessionSequence = 0

  // Navigation state
  let navInfo: NavigationInfo = {
    navigationState: 'IDLE',
    goal: null,
    path: [],
    distanceRemainingM: 0,
    progressPct: 0,
  }

  // Exploration state
  let explorationInfo: ExplorationInfo = {
    state: 'IDLE',
    frontierCount: 0,
    selectedFrontier: null,
  }

  // Live map grid
  let liveMap: OccupancyGrid | null = null
  let pendingReplacementGoal: Waypoint | null = null

  const telemetryListeners = new Set<(telemetry: RobotTelemetry) => void>()
  const statusListeners = new Set<(status: RobotSourceStatus) => void>()
  const manualSessionExpiredListeners = new Set<() => void>()
  const navListeners = new Set<(navigation: NavigationInfo) => void>()
  const explorationListeners = new Set<(exploration: ExplorationInfo) => void>()
  const mapListeners = new Set<(map: OccupancyGrid | null) => void>()

  let sourceSwitchRequestSequence = 0
  let pendingSourceSwitch: {
    target: 'LIVE' | 'DEMO'
    requestId: number
    resolve: (success: boolean) => void
    timer: number
  } | null = null

  const settlePendingSourceSwitch = (success: boolean) => {
    const pending = pendingSourceSwitch
    if (!pending) return
    window.clearTimeout(pending.timer)
    pendingSourceSwitch = null
    pending.resolve(success)
  }

  const clearManualHeartbeat = () => {
    if (manualHeartbeatTimer !== null) {
      window.clearInterval(manualHeartbeatTimer)
      manualHeartbeatTimer = null
    }
  }

  const createManualSessionId = () => {
    manualSessionSequence += 1
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${crypto.randomUUID()}-${manualSessionSequence}`
    }
    return `${Date.now()}-${manualSessionSequence}-${Math.random().toString(36).slice(2)}`
  }

  const sendVelocityPayload = (
    socket: WebSocket,
    command: VelocityCommand,
    sessionId: string | null = manualSessionId,
    newManualSession = false,
  ) => {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(
      JSON.stringify({
        type: 'cmd_vel',
        linear: command.linear,
        angular: command.angular,
        ...(sessionId ? { manual_session_id: sessionId } : {}),
        ...(newManualSession ? { new_manual_session: true } : {}),
      }),
    )
  }

  const resetLiveState = () => {
    pendingReplacementGoal = null
    notifyNav({
      navigationState: 'IDLE',
      goal: null,
      path: [],
      distanceRemainingM: 0,
      progressPct: 0,
    })
    notifyExploration({
      state: 'IDLE',
      frontierCount: 0,
      selectedFrontier: null,
    })
    notifyMap(null)
    telemetry = createFallbackTelemetry()
    notifyTelemetry(telemetry)
  }

  const notifyStatus = (nextStatus: RobotSourceStatus) => {
    if (status === nextStatus) return
    status = nextStatus
    statusListeners.forEach((listener) => listener(status))
  }

  const notifyTelemetry = (nextTelemetry: RobotTelemetry) => {
    telemetry = nextTelemetry
    telemetryListeners.forEach((listener) => listener(telemetry))
  }

  const notifyNav = (nextNav: NavigationInfo) => {
    navInfo = nextNav
    navListeners.forEach((listener) => listener(navInfo))
  }

  const notifyExploration = (nextExploration: ExplorationInfo) => {
    explorationInfo = nextExploration
    explorationListeners.forEach((listener) => listener(explorationInfo))
  }

  const notifyMap = (nextMap: OccupancyGrid | null) => {
    liveMap = nextMap
    mapListeners.forEach((listener) => listener(nextMap))
  }

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  const scheduleReconnect = () => {
    if (!isSubscribed || reconnectTimer !== null) return
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connectWebSocket()
    }, RECONNECT_DELAY_MS)
  }

  const connectWebSocket = () => {
    if (!isSubscribed) return
    clearReconnect()

    const generation = ++socketGeneration
    try {
      const socket = new WebSocket(url)
      ws = socket

      socket.onopen = () => {
        if (ws !== socket || generation !== socketGeneration) return
        if (handshakeTimer !== null) window.clearTimeout(handshakeTimer)
        handshakeTimer = window.setTimeout(() => {
          if (ws !== socket || generation !== socketGeneration) return
          try {
            socket.close(1000, 'Bridge handshake timeout')
          } catch {}
        }, 20000)
      }

      socket.onmessage = (event) => {
        if (ws !== socket || generation !== socketGeneration) return
        try {
          const raw = JSON.parse(event.data)
          if (!raw || typeof raw !== 'object') return
          const msgType = raw.type

          if (msgType === 'map' && raw.map) {
            const grid = convertRosOccupancyGridToFrontend(raw.map as RosOccupancyGridPayload)
            notifyMap(grid)
            return
          }

          if (msgType === 'exploration' && raw.exploration) {
            const exp = raw.exploration
            let selectedFrontier: SelectedFrontier | null = null
            if (exp.selected_frontier && typeof exp.selected_frontier.x === 'number' && typeof exp.selected_frontier.y === 'number') {
              const fPos = rosToFrontendPosition(exp.selected_frontier.x, exp.selected_frontier.y)
              selectedFrontier = { x: fPos.x, y: fPos.y }
            }
            notifyExploration({
              state: exp.state ?? explorationInfo.state,
              frontierCount: typeof exp.frontier_count === 'number' ? exp.frontier_count : explorationInfo.frontierCount,
              selectedFrontier,
            })
            return
          }

          if (msgType === 'nav_status' || msgType === 'nav_feedback' || msgType === 'nav_result') {
            const nav = raw.navigation ?? raw
            const nextState: NavigationState = nav.navigationState ?? nav.state ?? navInfo.navigationState
            const distanceRemainingM = typeof nav.distanceRemainingM === 'number' ? nav.distanceRemainingM : navInfo.distanceRemainingM
            let resolvedState = nextState
            let nextGoal = navInfo.goal
            if (nav.goal && typeof nav.goal.x === 'number' && typeof nav.goal.y === 'number') {
              const gPos = rosToFrontendPosition(nav.goal.x, nav.goal.y)
              nextGoal = {
                id: 'live-nav-target',
                label: 'Nav2 Target',
                position: gPos,
                status: nextState === 'GOAL_REACHED' ? 'reached' : 'active',
              }
            } else if (nextState === 'CANCELED' || nextState === 'FAILED' || nextState === 'IDLE') {
              nextGoal = null
            } else if (nextState === 'GOAL_REACHED' && nextGoal) {
              nextGoal = { ...nextGoal, status: 'reached' }
            }

            // A map target selected while Nav2 was active is held locally until the old
            // goal reaches terminal CANCELED. This prevents the UI from losing the new
            // target when the backend reports completion of the superseded goal.
            if (pendingReplacementGoal) {
              nextGoal = { ...pendingReplacementGoal, status: 'pending' }
              if (nextState === 'CANCELED') {
                resolvedState = 'READY'
                pendingReplacementGoal = null
              } else if (nextState === 'IDLE' || nextState === 'FAILED' || nextState === 'GOAL_REACHED') {
                pendingReplacementGoal = null
              }
            }

            const nextPath = Array.isArray(nav.path)
              ? nav.path.map((point: any) => rosToFrontendPosition(point.x, point.y))
              : navInfo.path

            notifyNav({
              navigationState: resolvedState,
              goal: nextGoal,
              path: nextPath,
              distanceRemainingM,
              progressPct: nextState === 'GOAL_REACHED' ? 100 : 0,
            })
            return
          }

          if (msgType === 'init') {
            pendingReplacementGoal = null
            if (handshakeTimer !== null) {
              window.clearTimeout(handshakeTimer)
              handshakeTimer = null
            }
            manualSessionId = null
            lastVelocityCommand = { linear: 0, angular: 0 }
            clearManualHeartbeat()
            if (raw.exploration) {
              const exp = raw.exploration
              let sf: SelectedFrontier | null = null
              if (exp.selected_frontier && typeof exp.selected_frontier.x === 'number' && typeof exp.selected_frontier.y === 'number') {
                const fPos = rosToFrontendPosition(exp.selected_frontier.x, exp.selected_frontier.y)
                sf = { x: fPos.x, y: fPos.y }
              }
              notifyExploration({
                state: exp.state ?? 'IDLE',
                frontierCount: typeof exp.frontier_count === 'number' ? exp.frontier_count : 0,
                selectedFrontier: sf,
              })
            }
            if (raw.navigation) {
              const nav = raw.navigation
              let initialGoal: Waypoint | null = navInfo.goal
              if (nav.goal && typeof nav.goal.x === 'number' && typeof nav.goal.y === 'number') {
                const gPos = rosToFrontendPosition(nav.goal.x, nav.goal.y)
                initialGoal = {
                  id: 'live-nav-target',
                  label: 'Nav2 Target',
                  position: gPos,
                  status: nav.navigationState === 'GOAL_REACHED' ? 'reached' : 'active',
                }
              }
              notifyNav({
                ...navInfo,
                navigationState: nav.navigationState ?? 'IDLE',
                goal: initialGoal,
              })
            }
            if (raw.map) {
              notifyMap(convertRosOccupancyGridToFrontend(raw.map as RosOccupancyGridPayload))
            }
            notifyStatus('LIVE')
            notifyTelemetry({
              ...telemetry,
              connection: 'online',
              network: { ...telemetry.network, rosbridgeConnected: true },
              rosHealth: 'nominal',
            })
            return
          }

          if (msgType === 'manual_session_expired') {
            if (!manualSessionId || raw.manual_session_id === manualSessionId) {
              manualSessionId = null
              lastVelocityCommand = { linear: 0, angular: 0 }
              clearManualHeartbeat()
              manualSessionExpiredListeners.forEach((listener) => listener())
            }
            return
          }

          if (msgType === 'source_switch_result') {
            if (
              pendingSourceSwitch &&
              pendingSourceSwitch.target === raw.requested_source &&
              raw.request_id === pendingSourceSwitch.requestId
            ) {
              settlePendingSourceSwitch(Boolean(raw.success))
            }
            return
          }

          const updated = parseBridgePayload(raw, telemetry)
          notifyTelemetry(updated)
        } catch {
          // Drop malformed frames without destabilizing the LIVE transport.
        }
      }

      socket.onerror = () => {
        if (ws !== socket || generation !== socketGeneration) return
      }

      socket.onclose = () => {
        if (ws !== socket || generation !== socketGeneration) return
        if (handshakeTimer !== null) {
          window.clearTimeout(handshakeTimer)
          handshakeTimer = null
        }
        clearManualHeartbeat()
        ws = null
        manualSessionId = null
        lastVelocityCommand = { linear: 0, angular: 0 }
        notifyStatus('DISCONNECTED')
        settlePendingSourceSwitch(false)
        resetLiveState()
        scheduleReconnect()
      }
    } catch {
      if (generation !== socketGeneration) return
      ws = null
      notifyStatus('DISCONNECTED')
      settlePendingSourceSwitch(false)
      resetLiveState()
      scheduleReconnect()
    }
  }

  const disconnectWebSocket = () => {
    clearReconnect()
    clearManualHeartbeat()
    if (handshakeTimer !== null) {
      window.clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
    socketGeneration += 1
    const socket = ws
    ws = null
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try { socket.close() } catch {}
      }
    }
    lastVelocityCommand = { linear: 0, angular: 0 }
    manualSessionId = null
    settlePendingSourceSwitch(false)
    notifyStatus('DISCONNECTED')
    resetLiveState()
  }

  // Navigation companion implementing RobotNavigationDataSource
  const navigationDataSource: RobotNavigationDataSource = {
    getInitialNavigation: () => navInfo,
    subscribe: (listener) => {
      navListeners.add(listener)
      listener(navInfo)
      return () => {
        navListeners.delete(listener)
      }
    },
    setGoal: (goal: Waypoint) => {
      const hasActiveNav = ['PLANNING', 'NAVIGATING', 'PAUSED', 'CANCELING'].includes(navInfo.navigationState)
      if (hasActiveNav) {
        pendingReplacementGoal = { ...goal, status: 'pending' }
        notifyNav({
          ...navInfo,
          navigationState: 'CANCELING',
          goal: pendingReplacementGoal,
          distanceRemainingM: 0,
          progressPct: 0,
        })
        return
      }
      pendingReplacementGoal = null
      notifyNav({
        ...navInfo,
        navigationState: 'READY',
        goal: { ...goal, status: 'pending' },
        distanceRemainingM: 0,
        progressPct: 0,
      })
    },
    startNavigation: () => {
      if (status !== 'LIVE' || !ws || ws.readyState !== WebSocket.OPEN || !navInfo.goal) return
      if (navInfo.navigationState === 'CANCELING') return
      pendingReplacementGoal = null

      // Convert frontend target position to ROS map frame (x_ros = x_front, y_ros = -y_front)
      const rosPos = frontendToRosPosition(navInfo.goal.position)
      // Convert frontend heading to ROS yaw
      const rosYaw = frontendHeadingDegToRosYaw(telemetry.odometry.headingDeg)

      notifyNav({
        ...navInfo,
        navigationState: 'PLANNING',
        goal: { ...navInfo.goal, status: 'active' },
      })

      try {
        ws.send(
          JSON.stringify({
            type: 'nav_goal',
            x: rosPos.x,
            y: rosPos.y,
            yaw: rosYaw,
          }),
        )
      } catch (err) {
        notifyNav({ ...navInfo, navigationState: 'FAILED' })
      }
    },
    cancelNavigation: () => {
      if (status !== 'LIVE' || !ws || ws.readyState !== WebSocket.OPEN) return
      pendingReplacementGoal = null
      try {
        // LIVE cancellation is asynchronous. Let bridge.py report CANCELING and the
        // final terminal state so the frontend never releases ownership prematurely.
        ws.send(JSON.stringify({ type: 'nav_cancel' }))
      } catch (err) {
        notifyNav({ ...navInfo, navigationState: 'FAILED' })
      }
    },
    pauseNavigation: () => {
      // Nav2 pause: cancel current goal but preserve for resume
      if (status === 'LIVE' && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'nav_pause' }))
        } catch (e) {}
      }
    },
    resumeNavigation: () => {
      // Nav2 resume: redispatch preserved goal
      if (status === 'LIVE' && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'nav_resume' }))
        } catch (e) {}
      }
    },

    // Auto Explore lifecycle
    getInitialExploration: () => explorationInfo,
    subscribeExploration: (listener) => {
      explorationListeners.add(listener)
      listener(explorationInfo)
      return () => {
        explorationListeners.delete(listener)
      }
    },
    startExploration: () => {
      if (status !== 'LIVE' || !ws || ws.readyState !== WebSocket.OPEN) return
      notifyExploration({ ...explorationInfo, state: 'STARTING' })
      try {
        ws.send(JSON.stringify({ type: 'explore_start' }))
      } catch (err) {
        notifyExploration({ ...explorationInfo, state: 'ERROR' })
      }
    },
    stopExploration: () => {
      if (status !== 'LIVE' || !ws || ws.readyState !== WebSocket.OPEN) return
      notifyExploration({ ...explorationInfo, state: 'STOPPING' })
      try {
        ws.send(JSON.stringify({ type: 'explore_stop' }))
      } catch (err) {
        notifyExploration({ ...explorationInfo, state: 'IDLE' })
      }
    },
  }

  return {
    get sourceStatus() {
      return status
    },
    subscribeSourceStatus: (listener) => {
      statusListeners.add(listener)
      listener(status)
      return () => {
        statusListeners.delete(listener)
      }
    },
    subscribeManualSessionExpired: (listener) => {
      manualSessionExpiredListeners.add(listener)
      return () => {
        manualSessionExpiredListeners.delete(listener)
      }
    },
    getInitialTelemetry: () => telemetry,
    subscribe: (listener) => {
      telemetryListeners.add(listener)
      if (!isSubscribed) {
        isSubscribed = true
        connectWebSocket()
      }
      return () => {
        telemetryListeners.delete(listener)
        if (telemetryListeners.size === 0) {
          isSubscribed = false
          disconnectWebSocket()
        }
      }
    },
    sendVelocityCommand: (command: VelocityCommand) => {
      const isNonZero = command.linear !== 0 || command.angular !== 0
      if (!Number.isFinite(command.linear) || !Number.isFinite(command.angular)) return

      const socket = ws
      if (!socket || socket.readyState !== WebSocket.OPEN || status !== 'LIVE') {
        if (!isNonZero) {
          clearManualHeartbeat()
          manualSessionId = null
          lastVelocityCommand = { linear: 0, angular: 0 }
        }
        return
      }

      if (!isNonZero) {
        const sessionAtStop = manualSessionId
        lastVelocityCommand = { linear: 0, angular: 0 }
        try {
          sendVelocityPayload(socket, lastVelocityCommand, sessionAtStop, false)
        } catch {
          // The local lease is still invalidated even if the explicit zero could not send.
        }
        manualSessionId = null
        clearManualHeartbeat()
        return
      }

      if (manualSessionId === null) {
        manualSessionId = createManualSessionId()
        lastVelocityCommand = { ...command }
        try {
          sendVelocityPayload(socket, lastVelocityCommand, manualSessionId, true)
        } catch {
          manualSessionId = null
          return
        }
      } else {
        lastVelocityCommand = { ...command }
        try {
          sendVelocityPayload(socket, lastVelocityCommand, manualSessionId, false)
        } catch {
          return
        }
      }

      if (manualHeartbeatTimer === null) {
        manualHeartbeatTimer = window.setInterval(() => {
          if (!ws || ws !== socket || ws.readyState !== WebSocket.OPEN || status !== 'LIVE' || !manualSessionId) {
            clearManualHeartbeat()
            return
          }
          try {
            sendVelocityPayload(socket, lastVelocityCommand, manualSessionId, false)
          } catch {
            clearManualHeartbeat()
          }
        }, 200)
      }
    },

    disconnect: () => {
      isSubscribed = false
      disconnectWebSocket()
    },
    requestSourceSwitch: (target: 'LIVE' | 'DEMO') => {
      const socket = ws
      if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false)
      if (pendingSourceSwitch) return Promise.resolve(false)

      return new Promise<boolean>((resolve) => {
        const requestId = ++sourceSwitchRequestSequence
        const timer = window.setTimeout(() => {
          if (pendingSourceSwitch?.requestId !== requestId) return
          pendingSourceSwitch = null
          resolve(false)
          // A lost switch acknowledgement can otherwise leave the bridge reserved and
          // disarmed indefinitely while this browser still believes it owns LIVE. Closing
          // the transport deliberately triggers the bridge's disconnect cleanup barrier.
          // Reconnect afterward so the LIVE provider can recover once cleanup completes.
          disconnectWebSocket()
          if (isSubscribed) scheduleReconnect()
        }, 2500)
        pendingSourceSwitch = { target, requestId, resolve, timer }
        try {
          socket.send(JSON.stringify({ type: 'source_switch', source: target, request_id: requestId }))
        } catch (err) {
          settlePendingSourceSwitch(false)
        }
      })
    },
    navigation: navigationDataSource,
    getInitialMap: () => liveMap,
    subscribeMap: (listener) => {
      mapListeners.add(listener)
      const current = liveMap
      if (current) listener(current)
      return () => {
        mapListeners.delete(listener)
      }
    },
  }
}

/** Singleton instance for the real TurtleBot3 ROS bridge */
export const rosRobotDataSource = createRosRobotDataSource()
