import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DataEnvironment,
  DriveKey,
  ExplorationInfo,
  MotionOwner,
  NavSection,
  NavigationInfo,
  OccupancyGrid,
  OperationMode,
  Position2D,
  PuppyStatus,
  RobotDataSource,
  RobotSourceStatus,
  RobotTelemetry,
  SystemPanel,
  VelocityCommand,
  VelocityIntentSource,
  Waypoint,
} from '../types/robot'
import { mockRobotDataSource } from '../data/mockTelemetry'
import { useKeyboardDrive } from '../hooks/useKeyboardDrive'
import { useNavigationDemo } from '../hooks/useNavigationDemo'
import { usePuppyDemo } from '../hooks/usePuppyDemo'
import { angularDelta, clamp, normalizeDeg } from '../lib/polar'
import { SAFE_ANGULAR_RADPS, SAFE_LINEAR_MPS, SAFE_REVERSE_MPS } from '../lib/safety'

const PRESENTATION_SAMPLE_MS = 100
const STOP_COMMAND: VelocityCommand = { linear: 0, angular: 0 }
const EMPTY_NAVIGATION: NavigationInfo = {
  navigationState: 'IDLE',
  goal: null,
  path: [],
  distanceRemainingM: 0,
  progressPct: 0,
}
const EMPTY_EXPLORATION: ExplorationInfo = {
  state: 'IDLE',
  frontierCount: 0,
  selectedFrontier: null,
}

const ENVIRONMENT_FOR_STATUS: Record<RobotSourceStatus, DataEnvironment> = {
  DEMO: 'demo',
  LIVE: 'live',
  DISCONNECTED: 'offline',
}

type VelocityIntentMap = Record<VelocityIntentSource, VelocityCommand | null>

function emptyVelocityIntents(): VelocityIntentMap {
  return { keyboard: null, 'manual-pad': null, autonomy: null }
}

function safeVelocity(command: VelocityCommand): VelocityCommand {
  if (!Number.isFinite(command.linear) || !Number.isFinite(command.angular)) return STOP_COMMAND
  return {
    linear: clamp(command.linear, -SAFE_REVERSE_MPS, SAFE_LINEAR_MPS),
    angular: clamp(command.angular, -SAFE_ANGULAR_RADPS, SAFE_ANGULAR_RADPS),
  }
}

function demoAutonomyCommand(telemetry: RobotTelemetry, goal: NonNullable<NavigationInfo['goal']>): VelocityCommand {
  const { position, headingDeg } = telemetry.odometry
  const dx = goal.position.x - position.x
  const dy = goal.position.y - position.y
  const distance = Math.hypot(dx, dy)
  const targetHeadingDeg = normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI)
  const headingErrorDeg = angularDelta(headingDeg, targetHeadingDeg)

  // Sign note: in mockTelemetry.stepOdometry, headingDeg decreases when angular > 0
  // (CCW rotation). A positive headingErrorDeg means we need to turn CW (increase headingDeg),
  // which requires NEGATIVE angular. Negate to fix the turn direction.
  // Scale forward speed: fast when aligned, slow when turning to face goal.
  // This prevents the robot from curving away from the target during the initial turn.
  const alignmentFactor = Math.max(0, 1 - Math.abs(headingErrorDeg) / 45)
  const rawLinear = distance < 0.1 ? 0 : clamp(distance * 0.36, 0.06, SAFE_LINEAR_MPS)

  return {
    linear: rawLinear * alignmentFactor,
    angular: clamp(-headingErrorDeg / 30, -SAFE_ANGULAR_RADPS, SAFE_ANGULAR_RADPS),
  }
}

interface RobotContextValue {
  telemetry: RobotTelemetry
  /** Exact, authoritative source state. DEMO never means a ROS connection. */
  sourceStatus: RobotSourceStatus
  /** Lowercase presentation mapping retained for existing environment-aware UI. */
  environment: DataEnvironment
  sessionStartedAt: number
  /** True only when a LIVE↔DEMO source transition can be requested safely. */
  canSwitchDataSource: boolean
  /** Performs the backend safety handshake (when LIVE) before changing source. */
  requestDataSourceSwitch: (target: 'LIVE' | 'DEMO') => Promise<boolean>

  activeSection: NavSection
  setActiveSection: (section: NavSection) => void
  systemPanel: SystemPanel
  setSystemPanel: (panel: SystemPanel) => void

  activeMode: OperationMode
  setActiveMode: (mode: OperationMode) => void

  /** Current motion owner - exactly one at a time. */
  motionOwner: MotionOwner

  /** Shared command arbiter for keyboard, pad, and DEMO autonomy intent. */
  setVelocityIntent: (source: VelocityIntentSource, command: VelocityCommand) => void
  clearVelocityIntent: (source: VelocityIntentSource) => void
  /** Clears every local intent and synchronously sends a zero command. */
  stopMotion: () => void
  activeKeys: ReadonlySet<DriveKey>
  safeLinearMps: number
  safeAngularRadps: number

  navigation: NavigationInfo
  /** True only when the active source can safely accept an interactive map goal. */
  canEditMapGoal: boolean
  setGoal: () => void
  /** Place or move a goal in map coordinates. DEMO resets to READY; LIVE delegates to its source. */
  setGoalAt: (position: Position2D) => void
  startNavigation: () => void
  pauseNavigation: () => void
  resumeNavigation: () => void
  cancelNavigation: () => void

  /** Real Frontier Exploration states and lifecycle controls */
  exploration: ExplorationInfo
  startExploration: () => void
  stopExploration: () => void

  /** Live SLAM /map occupancy grid (null if awaiting feed in LIVE mode or in DEMO mode) */
  liveOccupancyGrid: OccupancyGrid | null

  puppy: PuppyStatus
  acquireTarget: () => void
  pausePuppy: () => void
  resumePuppy: () => void
  stopPuppy: () => void

  emergencyStopped: boolean
  triggerEmergencyStop: () => void
  resetEmergencyStop: () => void
}

const RobotContext = createContext<RobotContextValue | null>(null)

interface RobotProviderProps {
  children: React.ReactNode
  /**
   * Injection keeps the source seam testable and makes the eventual ROS
   * source a localized provider change rather than a component rewrite.
   */
  dataSource?: RobotDataSource
}

/**
 * Central cross-cutting state layer. The source owns telemetry delivery and
 * transport; this provider owns UI state, source provenance, command safety,
 * and the explicitly DEMO-only navigation/puppy models.
 */
export function RobotProvider({ children, dataSource = mockRobotDataSource }: RobotProviderProps) {
  const [telemetry, setTelemetry] = useState<RobotTelemetry>(() => dataSource.getInitialTelemetry())
  const latestTelemetryRef = useRef(telemetry)
  const lastPresentationAtRef = useRef(0)
  const [sourceStatus, setSourceStatus] = useState<RobotSourceStatus>(() => dataSource.sourceStatus)
  const [sourceNavigation, setSourceNavigation] = useState<NavigationInfo>(
    () => dataSource.navigation?.getInitialNavigation() ?? EMPTY_NAVIGATION,
  )
  const [liveOccupancyGrid, setLiveOccupancyGrid] = useState<OccupancyGrid | null>(
    () => dataSource.getInitialMap?.() ?? null,
  )
  const [exploration, setExploration] = useState<ExplorationInfo>(
    () => dataSource.navigation?.getInitialExploration?.() ?? EMPTY_EXPLORATION,
  )
  const [sessionStartedAt] = useState(() => Date.now())

  const [activeSection, setActiveSectionState] = useState<NavSection>('COMMAND')
  const [systemPanel, setSystemPanel] = useState<SystemPanel>('ROBOT')
  const [activeMode, setActiveModeState] = useState<OperationMode>('AUTONOMOUS')
  const [emergencyStopped, setEmergencyStopped] = useState(false)
  const [motionOwner, setMotionOwner] = useState<MotionOwner>('NONE')
  const intentRef = useRef<VelocityIntentMap>(emptyVelocityIntents())

  useEffect(() => {
    const initial = dataSource.getInitialTelemetry()
    latestTelemetryRef.current = initial
    setTelemetry(initial)
    lastPresentationAtRef.current = 0

    const unsubscribe = dataSource.subscribe((nextTelemetry) => {
      latestTelemetryRef.current = nextTelemetry
      const now = performance.now()
      // Keep raw source cadence out of the broad presentation context. The
      // future source can retain high-rate sensor data locally while the UI
      // receives an intentionally bounded render stream.
      if (now - lastPresentationAtRef.current >= PRESENTATION_SAMPLE_MS) {
        lastPresentationAtRef.current = now
        setTelemetry(nextTelemetry)
      }
    })

    return () => {
      dataSource.sendVelocityCommand(STOP_COMMAND)
      unsubscribe()
    }
  }, [dataSource])

  useEffect(() => {
    setSourceStatus(dataSource.sourceStatus)
    const unsubscribe = dataSource.subscribeSourceStatus?.(setSourceStatus)
    return () => unsubscribe?.()
  }, [dataSource])

  useEffect(() => {
    const unsubscribe = dataSource.subscribeManualSessionExpired?.(() => {
      // The bridge is authoritative about manual lease expiry. Clear every local
      // manual intent as well as the transient owner so a stale UI session cannot
      // block autonomous control or appear active after the robot has stopped.
      intentRef.current.keyboard = null
      intentRef.current['manual-pad'] = null
      setMotionOwner((current) => (current === 'MANUAL' ? 'NONE' : current))
    })
    return () => unsubscribe?.()
  }, [dataSource])

  useEffect(() => {
    const navigationSource = dataSource.navigation
    setSourceNavigation(navigationSource?.getInitialNavigation() ?? EMPTY_NAVIGATION)
    const unsubscribe = navigationSource?.subscribe(setSourceNavigation)
    return () => unsubscribe?.()
  }, [dataSource])

  useEffect(() => {
    setLiveOccupancyGrid(dataSource.getInitialMap?.() ?? null)
    const unsubscribe = dataSource.subscribeMap?.(setLiveOccupancyGrid)
    return () => unsubscribe?.()
  }, [dataSource])

  useEffect(() => {
    const navigationSource = dataSource.navigation
    setExploration(navigationSource?.getInitialExploration?.() ?? EMPTY_EXPLORATION)
    const unsubscribe = navigationSource?.subscribeExploration?.(setExploration)
    return () => unsubscribe?.()
  }, [dataSource])

  const getDemoCurrentPosition = useCallback(() => ({ ...latestTelemetryRef.current.odometry.position }), [])
  const demoNavigationEnabled = sourceStatus === 'DEMO' && activeMode === 'AUTONOMOUS' && !emergencyStopped
  const demoNavigation = useNavigationDemo({ enabled: demoNavigationEnabled, getCurrentPosition: getDemoCurrentPosition })
  const navigation = sourceStatus === 'DEMO' ? demoNavigation.navigation : sourceNavigation

  const puppyDemoEnabled = sourceStatus === 'DEMO' && activeMode === 'PUPPY' && !emergencyStopped
  const puppyDemo = usePuppyDemo(puppyDemoEnabled, telemetry.timestamp)

  const resolvedVelocity = useCallback((): VelocityCommand => {
    if (emergencyStopped || sourceStatus === 'DISCONNECTED') return STOP_COMMAND

    const intents = intentRef.current
    if (activeMode === 'MANUAL') return intents['manual-pad'] ?? intents.keyboard ?? STOP_COMMAND
    if (sourceStatus === 'DEMO' && activeMode === 'AUTONOMOUS') return intents.autonomy ?? STOP_COMMAND
    return STOP_COMMAND
  }, [activeMode, emergencyStopped, sourceStatus])

  const sendResolvedVelocity = useCallback(() => {
    dataSource.sendVelocityCommand(resolvedVelocity())
  }, [dataSource, resolvedVelocity])

  const stopMotion = useCallback(() => {
    intentRef.current = emptyVelocityIntents()
    dataSource.sendVelocityCommand(STOP_COMMAND)
    if (motionOwner === 'MANUAL') setMotionOwner('NONE')
  }, [dataSource, motionOwner])

  const setVelocityIntent = useCallback(
    (source: VelocityIntentSource, command: VelocityCommand) => {
      const manualIntent = source === 'keyboard' || source === 'manual-pad'
      const permitted =
        !emergencyStopped &&
        sourceStatus !== 'DISCONNECTED' &&
        ((manualIntent && activeMode === 'MANUAL') || (source === 'autonomy' && sourceStatus === 'DEMO' && activeMode === 'AUTONOMOUS'))

      if (!permitted) {
        intentRef.current[source] = null
        // Release ownership if this source was the owner
        if ((manualIntent && motionOwner === 'MANUAL') || (source === 'autonomy' && motionOwner === 'NAVIGATION')) {
          setMotionOwner('NONE')
        }
        sendResolvedVelocity()
        return
      }

      // Enforce single motion ownership
      if (manualIntent && motionOwner !== 'NONE' && motionOwner !== 'MANUAL') {
        // Another owner has control - reject
        intentRef.current[source] = null
        sendResolvedVelocity()
        return
      }
      if (source === 'autonomy' && motionOwner !== 'NONE' && motionOwner !== 'NAVIGATION') {
        // Another owner has control - reject
        intentRef.current[source] = null
        sendResolvedVelocity()
        return
      }

      intentRef.current[source] = safeVelocity(command)
      // Take ownership
      if (manualIntent) setMotionOwner('MANUAL')
      if (source === 'autonomy') setMotionOwner('NAVIGATION')
      // One fresh manual input supersedes the other. Releasing a pad cannot
      // revive an old held keyboard intent, and vice versa.
      if (source === 'keyboard') intentRef.current['manual-pad'] = null
      if (source === 'manual-pad') intentRef.current.keyboard = null
      sendResolvedVelocity()
    },
    [activeMode, emergencyStopped, sendResolvedVelocity, sourceStatus, motionOwner],
  )

  const clearVelocityIntent = useCallback(
    (source: VelocityIntentSource) => {
      intentRef.current[source] = null
      if (source === 'keyboard' || source === 'manual-pad') {
        const hasManualIntent = Boolean(intentRef.current.keyboard || intentRef.current['manual-pad'])
        if (!hasManualIntent && motionOwner === 'MANUAL') setMotionOwner('NONE')
      }
      sendResolvedVelocity()
    },
    [motionOwner, sendResolvedVelocity],
  )

  const setActiveSection = useCallback((section: NavSection) => {
    setActiveSectionState(section)
  }, [])

const setActiveMode = useCallback(
    (mode: OperationMode) => {
      // Operation-mode changes are distinct from DEMO/LIVE data-source changes.
      // A LIVE autonomous lifecycle must be explicitly terminated before moving into
      // a mode that does not own that lifecycle; otherwise the UI could switch context
      // while Nav2/Explorer still owns the physical motion path.
      if (sourceStatus === 'LIVE' && mode !== 'AUTONOMOUS') {
        const autonomousStillActive =
          motionOwner === 'NAVIGATION' ||
          motionOwner === 'EXPLORATION' ||
          navigation.navigationState === 'NAVIGATING' ||
          navigation.navigationState === 'PLANNING' ||
          navigation.navigationState === 'PAUSED' ||
          navigation.navigationState === 'CANCELING' ||
          exploration.state === 'STARTING' ||
          exploration.state === 'EXPLORING' ||
          exploration.state === 'STOPPING'
        if (autonomousStillActive) {
          console.warn('[RobotContext] Mode switch blocked: stop the active autonomous operation first')
          return
        }
      }

      stopMotion()
      setMotionOwner('NONE')
      setActiveModeState(mode)
      setActiveSectionState(mode)
    },
    [exploration.state, navigation.navigationState, sourceStatus, stopMotion],
  )


  const canEditMapGoal =
    !emergencyStopped &&
    activeMode === 'AUTONOMOUS' &&
    sourceStatus !== 'DISCONNECTED' &&
    (sourceStatus === 'DEMO' || (typeof dataSource.navigation?.setGoal === 'function' && !!liveOccupancyGrid))

  const setGoal = useCallback(() => {
    if (emergencyStopped || activeMode !== 'AUTONOMOUS' || sourceStatus !== 'DEMO') return
    // A fresh target is an explicit route change, so zero the prior
    // autonomous command before the demo state machine selects it.
    clearVelocityIntent('autonomy')
    demoNavigation.setGoal()
  }, [activeMode, clearVelocityIntent, demoNavigation, emergencyStopped, sourceStatus])

const setGoalAt = useCallback(
    (position: Position2D) => {
      if (!canEditMapGoal || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return

      // Moving a target must synchronously inhibit a prior DEMO command. The
      // hook then resets the demo route to READY, requiring an intentional
      // new start; a LIVE source owns its corresponding transport behavior.
      clearVelocityIntent('autonomy')
      if (sourceStatus === 'DEMO') {
        demoNavigation.setGoalAt(position)
        return
      }

      // LIVE mode: setting a new goal while navigation is active (PLANNING, NAVIGATING, PAUSED)
      // should cancel the old Nav2 goal to prevent split-brain (UI shows B, Nav2 executes A).
      const nav = dataSource.navigation
      const isNavActive = navigation.navigationState === 'PLANNING' || navigation.navigationState === 'NAVIGATING' || navigation.navigationState === 'PAUSED' || navigation.navigationState === 'CANCELING'
      if (nav && isNavActive) {
        nav.cancelNavigation()
      }

      const goal: Waypoint = {
        id: 'map-target',
        label: 'Map target',
        position: { ...position },
        status: 'pending',
      }
      dataSource.navigation?.setGoal?.(goal)
    },
    [canEditMapGoal, clearVelocityIntent, dataSource, demoNavigation, sourceStatus, navigation.navigationState]
  )

  const startNavigation = useCallback(() => {
    if (emergencyStopped) return
    // Take navigation ownership
    if (motionOwner !== 'NONE' && motionOwner !== 'NAVIGATION') return
    if (sourceStatus === 'LIVE' && typeof dataSource.navigation?.startNavigation !== 'function') return
    setMotionOwner('NAVIGATION')
    if (sourceStatus === 'DEMO') {
      demoNavigation.startNavigation()
      return
    }
    dataSource.navigation?.startNavigation()
  }, [dataSource, demoNavigation, emergencyStopped, sourceStatus, motionOwner])

  const pauseNavigation = useCallback(() => {
    if (emergencyStopped) return
    // Do not wait for the navigation state render/effect to settle before
    // removing an autonomous velocity command.
    clearVelocityIntent('autonomy')
    // PAUSED navigation STILL owns the NAVIGATION control slot.
    // The preserved navigation session is logically active and must not be
    // competed with by exploration/manual arbitration.
    // Do NOT release ownership here - only on explicit CANCEL or abandonment.
    if (sourceStatus === 'DEMO') {
      demoNavigation.pauseNavigation()
      return
    }
    dataSource.navigation?.pauseNavigation()
  }, [clearVelocityIntent, dataSource, demoNavigation, emergencyStopped, sourceStatus])

  const resumeNavigation = useCallback(() => {
    if (emergencyStopped) return
    // Ownership is already NAVIGATION from the original start (preserved through PAUSE).
    // Only take ownership if somehow lost (defensive).
    if (motionOwner !== 'NAVIGATION') setMotionOwner('NAVIGATION')
    if (sourceStatus === 'DEMO') {
      demoNavigation.resumeNavigation()
      return
    }
    dataSource.navigation?.resumeNavigation()
  }, [dataSource, demoNavigation, emergencyStopped, sourceStatus, motionOwner])

  const cancelNavigation = useCallback(() => {
    clearVelocityIntent('autonomy')
    if (sourceStatus === 'DEMO') {
      if (motionOwner === 'NAVIGATION') setMotionOwner('NONE')
      demoNavigation.cancelNavigation()
      return
    }
    // LIVE navigation ownership remains held until the backend confirms terminal
    // cancellation. This prevents another owner from taking over while Nav2 may
    // still be able to publish velocity.
    dataSource.navigation?.cancelNavigation()
  }, [clearVelocityIntent, dataSource, demoNavigation, motionOwner, sourceStatus])

  const acquireTarget = useCallback(() => {
    if (!emergencyStopped && sourceStatus === 'DEMO') puppyDemo.acquireTarget()
  }, [emergencyStopped, puppyDemo, sourceStatus])

  const pausePuppy = useCallback(() => {
    if (!emergencyStopped && sourceStatus === 'DEMO') puppyDemo.pausePuppy()
  }, [emergencyStopped, puppyDemo, sourceStatus])

  const resumePuppy = useCallback(() => {
    if (!emergencyStopped && sourceStatus === 'DEMO') puppyDemo.resumePuppy()
  }, [emergencyStopped, puppyDemo, sourceStatus])

  const stopPuppy = useCallback(() => {
    if (sourceStatus === 'DEMO') puppyDemo.stopPuppy()
  }, [puppyDemo, sourceStatus])

  const startExploration = useCallback(() => {
    if (emergencyStopped) return
    // DEMO mode can NEVER acquire EXPLORATION motion ownership.
    // This is a hard safety invariant - only LIVE ROS-backed exploration
    // can control the physical robot.
    if (sourceStatus !== 'LIVE') return
    if (typeof dataSource.navigation?.startExploration !== 'function') return
    if (motionOwner !== 'NONE' && motionOwner !== 'EXPLORATION') return
    setMotionOwner('EXPLORATION')
    dataSource.navigation.startExploration()
  }, [dataSource, emergencyStopped, sourceStatus, motionOwner])

  const stopExploration = useCallback(() => {
    // LIVE EXPLORATION retains ownership through STOPPING; the backend releases it
    // only when the exact process has terminated. DEMO has no real explorer owner.
    if (sourceStatus === 'DEMO' && motionOwner === 'EXPLORATION') setMotionOwner('NONE')
    dataSource.navigation?.stopExploration?.()
  }, [dataSource, motionOwner, sourceStatus])

  const triggerEmergencyStop = useCallback(() => {
    stopMotion()
    setMotionOwner('NONE')
    setEmergencyStopped(true)
    if (sourceStatus === 'DEMO') {
      demoNavigation.cancelNavigation()
    } else {
      dataSource.navigation?.cancelNavigation()
      dataSource.navigation?.stopExploration?.()
    }
    if (sourceStatus === 'DEMO') puppyDemo.stopPuppy()
  }, [dataSource, demoNavigation, puppyDemo, sourceStatus, stopMotion])

  const resetEmergencyStop = useCallback(() => {
    // Reset only removes the latch. It never restores a prior command,
    // autonomous route, held key, or pad press.
    stopMotion()
    setMotionOwner('NONE')
    setEmergencyStopped(false)
  }, [stopMotion])

  const { activeKeys } = useKeyboardDrive({
    enabled: activeMode === 'MANUAL' && !emergencyStopped && sourceStatus !== 'DISCONNECTED',
    onCommand: (command) => setVelocityIntent('keyboard', command),
    onRelease: () => clearVelocityIntent('keyboard'),
  })

  const autoNavigationActive =
    sourceStatus === 'DEMO' &&
    activeMode === 'AUTONOMOUS' &&
    !emergencyStopped &&
    navigation.navigationState === 'NAVIGATING' &&
    navigation.goal !== null

  useEffect(() => {
    if (!autoNavigationActive || !navigation.goal) {
      clearVelocityIntent('autonomy')
      return
    }
    // Use latestTelemetryRef.current (updates every 50ms tick) rather than
    // the React-state 'telemetry' (gated at 100ms via PRESENTATION_SAMPLE_MS)
    // so the proportional controller responds to the freshest position data.
    setVelocityIntent('autonomy', demoAutonomyCommand(latestTelemetryRef.current, navigation.goal))
  }, [
    autoNavigationActive,
    clearVelocityIntent,
    navigation.goal,
    setVelocityIntent,
    telemetry, // still used as the trigger so we re-evaluate on every presentation tick
  ])

  useEffect(() => {
    if (sourceStatus === 'DISCONNECTED') {
      stopMotion()
      setMotionOwner('NONE')
    }
  }, [sourceStatus, stopMotion])

  // P0: Derive motionOwner from authoritative backend state in LIVE mode.
  // Frontend optimistically sets ownership, but backend is the source of truth for
  // persistent autonomous operations (NAVIGATION, EXPLORATION).
  // MANUAL ownership is transient and driven by local intent; we never derive it from backend.
  useEffect(() => {
    if (sourceStatus !== 'LIVE') return

    // Only sync persistent autonomous ownership from backend.
    // MANUAL ownership is always set/cleared by local intent (keyboard/pad).
    let derivedOwner: MotionOwner = 'NONE'
    if (navigation.navigationState === 'NAVIGATING' || navigation.navigationState === 'PLANNING' || navigation.navigationState === 'PAUSED' || navigation.navigationState === 'CANCELING') {
      derivedOwner = 'NAVIGATION'
    } else if (exploration.state === 'EXPLORING' || exploration.state === 'STARTING' || exploration.state === 'STOPPING') {
      derivedOwner = 'EXPLORATION'
    }

    // Only update if derived owner is a persistent autonomous owner AND
    // we don't currently have a conflicting manual intent.
    // We never clear MANUAL ownership from this effect - only set NAVIGATION/EXPLORATION.
    if (derivedOwner !== 'NONE' && motionOwner !== 'MANUAL' && derivedOwner !== motionOwner) {
      setMotionOwner(derivedOwner)
    }
    // If backend shows no autonomous owner but frontend has NAVIGATION/EXPLORATION,
    // clear it (backend is authoritative for autonomous ownership).
    if (derivedOwner === 'NONE' && (motionOwner === 'NAVIGATION' || motionOwner === 'EXPLORATION')) {
      setMotionOwner('NONE')
    }
  }, [sourceStatus, motionOwner, navigation.navigationState, exploration.state, setMotionOwner])

  useEffect(() => {
    const haltForLifecycle = () => {
      stopMotion()
      if (sourceStatus === 'DEMO') {
        demoNavigation.pauseNavigation()
        puppyDemo.stopPuppy()
      } else {
        dataSource.navigation?.pauseNavigation()
        dataSource.navigation?.stopExploration?.()
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') haltForLifecycle()
    }

    window.addEventListener('blur', haltForLifecycle)
    window.addEventListener('pagehide', haltForLifecycle)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('blur', haltForLifecycle)
      window.removeEventListener('pagehide', haltForLifecycle)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [dataSource, demoNavigation, puppyDemo, sourceStatus, stopMotion])

  const canSwitchDataSource =
    sourceStatus !== 'LIVE' ||
    (
      !emergencyStopped &&
      motionOwner === 'NONE' &&
      !['PLANNING', 'NAVIGATING', 'PAUSED', 'CANCELING'].includes(navigation.navigationState) &&
      !['STARTING', 'EXPLORING', 'STOPPING'].includes(exploration.state)
    )

  const requestDataSourceSwitch = useCallback(
    async (target: 'LIVE' | 'DEMO') => {
      if (target === sourceStatus) return true

      // Switching away from LIVE is a physical safety operation. The frontend
      // performs the cheap state check first, then asks the bridge to confirm it
      // sees the same safe state before the React provider is replaced.
      if (sourceStatus === 'LIVE') {
        if (!canSwitchDataSource) return false
        const granted = await dataSource.requestSourceSwitch?.(target)
        if (granted === false) return false
        // The bridge reservation disarms the LIVE operator. Close the old transport
        // before React replaces the source so the bridge can complete last-client cleanup.
        dataSource.disconnect?.()
      }

      if (typeof window !== 'undefined') {
        localStorage.setItem('turtlebot_data_source', target.toLowerCase())
        window.dispatchEvent(new Event('turtlebot_source_change'))
      }
      return true
    },
    [canSwitchDataSource, dataSource, sourceStatus],
  )

  const environment = ENVIRONMENT_FOR_STATUS[sourceStatus]
  const value = useMemo<RobotContextValue>(
    () => ({
      telemetry,
      sourceStatus,
      environment,
      sessionStartedAt,
      canSwitchDataSource,
      requestDataSourceSwitch,

      activeSection,
      setActiveSection,
      systemPanel,
      setSystemPanel,

      activeMode,
      setActiveMode,

      motionOwner,

      setVelocityIntent,
      clearVelocityIntent,
      stopMotion,
      activeKeys,
      safeLinearMps: SAFE_LINEAR_MPS,
      safeAngularRadps: SAFE_ANGULAR_RADPS,

      navigation,
      canEditMapGoal,
      setGoal,
      setGoalAt,
      startNavigation,
      pauseNavigation,
      resumeNavigation,
      cancelNavigation,

      exploration,
      startExploration,
      stopExploration,

      liveOccupancyGrid,

      puppy: puppyDemo.puppy,
      acquireTarget,
      pausePuppy,
      resumePuppy,
      stopPuppy,

      emergencyStopped,
      triggerEmergencyStop,
      resetEmergencyStop,
    }),
    [
      acquireTarget,
      activeKeys,
      activeMode,
      activeSection,
      canEditMapGoal,
      canSwitchDataSource,
      cancelNavigation,
      clearVelocityIntent,
      emergencyStopped,
      environment,
      exploration,
      liveOccupancyGrid,
      motionOwner,
      navigation,
      pauseNavigation,
      pausePuppy,
      puppyDemo.puppy,
      resetEmergencyStop,
      requestDataSourceSwitch,
      resumeNavigation,
      resumePuppy,
      sessionStartedAt,
      setActiveMode,
      setActiveSection,
      setGoal,
      setGoalAt,
      setVelocityIntent,
      sourceStatus,
      startExploration,
      startNavigation,
      stopExploration,
      stopMotion,
      stopPuppy,
      systemPanel,
      telemetry,
      triggerEmergencyStop,
    ],
  )

  return <RobotContext.Provider value={value}>{children}</RobotContext.Provider>
}

export function useRobot(): RobotContextValue {
  const context = useContext(RobotContext)
  if (!context) throw new Error('useRobot must be used within a RobotProvider')
  return context
}
