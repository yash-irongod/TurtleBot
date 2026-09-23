/**
 * Domain types for the control center.
 *
 * These shapes mirror the ROS 2 / Nav2 concepts used by both the mock source
 * and the live WebSocket bridge, so components do not depend on transport details.
 * See each field's comment for the ROS topic / message type it corresponds to.
 */

export interface Vector3 {
  x: number
  y: number
  z: number
}

/** Mirrors geometry_msgs/Pose2D-style planar position, in metres, map frame. */
export interface Position2D {
  x: number
  y: number
}

export type ConnectionStatus = 'online' | 'connecting' | 'offline' | 'error'
export type HealthLevel = 'nominal' | 'warning' | 'critical'

/**
 * The authoritative status of the source feeding RobotContext. This is
 * deliberately separate from a telemetry field such as `connection`: a DEMO
 * source may be producing useful simulated telemetry without any ROS bridge
 * or physical robot connection existing.
 */
export type RobotSourceStatus = 'DEMO' | 'LIVE' | 'DISCONNECTED'

/**
 * Legacy presentation identifier retained for existing view components.
 * New source-aware code should use `RobotSourceStatus`; `offline` maps to
 * `DISCONNECTED` and never describes a simulated ROS connection.
 */
export type DataEnvironment = 'demo' | 'live' | 'offline'

/** Sourced from /odom (nav_msgs/Odometry). */
export interface OdometryState {
  position: Position2D
  /** Yaw, degrees, 0 = facing the top of the display, increases clockwise. */
  headingDeg: number
  linearVelocity: number // m/s, twist.twist.linear.x
  angularVelocity: number // rad/s, twist.twist.angular.z
}

/** Sourced from /battery_state (sensor_msgs/BatteryState). */
export interface BatteryState {
  percentage: number // 0-100
  voltage: number
  current: number // amps, negative while discharging
  charging: boolean
}

/** Sourced from /imu (sensor_msgs/Imu). Angles here in degrees for display. */
export interface ImuState {
  roll: number
  pitch: number
  yaw: number
  linearAcceleration: Vector3
  angularVelocity: Vector3
}

/** A single beam sample from /scan (sensor_msgs/LaserScan), unrolled per-angle. */
export interface LidarPoint {
  angleDeg: number // 0-359, 0 = robot-forward
  distanceM: number
}

export interface LidarScan {
  points: LidarPoint[]
  rangeMaxM: number
  timestamp: number
}

export type MotorId = 'left_wheel' | 'right_wheel'

export interface MotorState {
  id: MotorId
  label: string
  rpm: number
  temperatureC: number
  health: HealthLevel
}

export interface NetworkState {
  latencyMs: number
  signalPct: number
  rosbridgeConnected: boolean
}

/** The full snapshot the UI renders from. One tick of this shape == one frame of the feed. */
export interface RobotTelemetry {
  connection: ConnectionStatus
  odometry: OdometryState
  battery: BatteryState
  imu: ImuState
  lidar: LidarScan
  motors: MotorState[]
  network: NetworkState
  temperatureC: number
  lidarHealth: HealthLevel
  rosHealth: HealthLevel
  timestamp: number
}

/**
 * The three user-facing operating modes. Each is meant to feel like a
 * distinct operating context — not a variation on one dashboard. See
 * ModeSwitcher, the contextual half of ControlDeck, and each mode's view.
 */
export type OperationMode = 'AUTONOMOUS' | 'MANUAL' | 'PUPPY'

export interface ModeDefinition {
  id: OperationMode
  label: string
  tagline: string
  description: string
}

/** COMMAND and SYSTEM are hub/utility screens; the other three double as their matching mode. */
export type NavSection = 'COMMAND' | 'AUTONOMOUS' | 'MANUAL' | 'PUPPY' | 'SYSTEM'

export type SystemPanel = 'ROBOT' | 'SENSORS' | 'DIAGNOSTICS'

export type DriveDirection = 'forward' | 'back' | 'left' | 'right'
export type DriveKey = 'w' | 'a' | 's' | 'd'

export interface Waypoint {
  id: string
  label: string
  position: Position2D
  status: 'pending' | 'active' | 'reached'
}

export interface Mission {
  id: string
  name: string
  steps: number
  stepsComplete: number
  status: 'queued' | 'running' | 'paused' | 'complete'
  etaMin: number
}

/* ------------------------------------------------------------------ */
/* Autonomous mode: navigation                                        */
/* ------------------------------------------------------------------ */

export type NavigationState =
  | 'IDLE'
  | 'LOCALIZING'
  | 'READY'
  | 'PLANNING'
  | 'NAVIGATING'
  | 'PAUSED'
  | 'CANCELING'
  | 'GOAL_REACHED'
  | 'FAILED'
  | 'CANCELED'

export interface NavigationInfo {
  navigationState: NavigationState
  goal: Waypoint | null
  path: Position2D[]
  distanceRemainingM: number
  progressPct: number
}

/* ------------------------------------------------------------------ */
/* Autonomous mode: frontier exploration                              */
/* ------------------------------------------------------------------ */

export type ExplorationState = 'IDLE' | 'STARTING' | 'EXPLORING' | 'STOPPING' | 'COMPLETE' | 'ERROR'

export interface SelectedFrontier {
  x: number
  y: number
}

export interface ExplorationInfo {
  state: ExplorationState
  frontierCount: number
  selectedFrontier: SelectedFrontier | null
}

/* ------------------------------------------------------------------ */
/* Autonomous mode: map                                               */
/* ------------------------------------------------------------------ */

/**
 * Frontend representation of nav_msgs/OccupancyGrid. ROS encodes cell state as
 * int8 (-1 unknown, 0 free, 100 occupied) in one flat array; the control center
 * converts that into a named union for rendering, shared by DEMO and LIVE sources.
 * `cells` is row-major, length === widthCells * heightCells.
 */
export type CellState = 'free' | 'occupied' | 'unknown'

export interface OccupancyGrid {
  widthCells: number
  heightCells: number
  resolutionM: number
  /** World position (metres) of the grid's top-left cell (row 0, col 0). */
  origin: Position2D
  cells: CellState[]
}

/* ------------------------------------------------------------------ */
/* Puppy mode: person-following                                       */
/* ------------------------------------------------------------------ */

export type PuppyState = 'STOPPED' | 'SEARCHING' | 'TARGET_FOUND' | 'FOLLOWING' | 'TARGET_LOST' | 'PAUSED'

export interface PuppyStatus {
  puppyState: PuppyState
  targetBearingDeg: number
  distanceM: number
  confidencePct: number
}

/* ------------------------------------------------------------------ */
/* Data source seam                                                   */
/* ------------------------------------------------------------------ */

export interface VelocityCommand {
  linear: number
  angular: number
}

/** Origins are kept separate so one released input cannot revive another. */
export type VelocityIntentSource = 'keyboard' | 'manual-pad' | 'autonomy'

/** Motion ownership: exactly one owner at a time. */
export type MotionOwner = 'NONE' | 'MANUAL' | 'NAVIGATION' | 'EXPLORATION'

/**
 * Navigation companion implemented by either the local DEMO model or a LIVE source.
 * The interface contains state/actions only and does not prescribe the transport.
 */
export interface RobotNavigationDataSource {
  getInitialNavigation(): NavigationInfo
  subscribe(listener: (navigation: NavigationInfo) => void): () => void
  /**
   * Optional because a read-only navigation integration may not be allowed to
   * publish goals. WorldMap enables direct goal placement only when this is
   * provided by a live source (or while the local DEMO model is active).
   */
  setGoal?(goal: Waypoint): void
  startNavigation(): void
  pauseNavigation(): void
  resumeNavigation(): void
  cancelNavigation(): void

  // Auto Explore extensions
  getInitialExploration?(): ExplorationInfo
  subscribeExploration?(listener: (exploration: ExplorationInfo) => void): () => void
  startExploration?(): void
  stopExploration?(): void
}

/**
 * What RobotContext depends on for telemetry and velocity transport.
 * The repository currently provides both a local DEMO source and a ROS-backed LIVE source.
 */
export interface RobotDataSource {
  readonly sourceStatus: RobotSourceStatus
  /** Optional status subscription for a live source that can disconnect. */
  subscribeSourceStatus?(listener: (status: RobotSourceStatus) => void): () => void
  /** Optional live-control event emitted when the bridge expires a manual lease. */
  subscribeManualSessionExpired?(listener: () => void): () => void
  getInitialTelemetry(): RobotTelemetry
  /** Begin receiving source-owned telemetry updates; return an unsubscribe. */
  subscribe(listener: (telemetry: RobotTelemetry) => void): () => void
  /**
   * Transport a velocity command after RobotContext has applied its safety
   * boundary. The DEMO source uses it to animate local odometry; the LIVE source
   * transports it to the ROS bridge, which publishes `/cmd_vel` after its own
   * physical safety checks.
   */
  sendVelocityCommand(command: VelocityCommand): void
  /** Close a LIVE transport intentionally without triggering automatic reconnect. */
  disconnect?(): void
  /**
   * A source can expose navigation state here; DEMO and LIVE may implement it differently.
   */
  readonly navigation?: RobotNavigationDataSource
  /**
   * Optional live occupancy grid subscription for real ROS /map updates.
   */
  getInitialMap?(): OccupancyGrid | null
  subscribeMap?(listener: (map: OccupancyGrid | null) => void): () => void
  /** Request permission from a LIVE bridge before switching to another data source. */
  requestSourceSwitch?(target: 'LIVE' | 'DEMO'): Promise<boolean>
}
