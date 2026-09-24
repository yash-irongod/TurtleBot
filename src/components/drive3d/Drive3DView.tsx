import * as THREE from 'three'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRobot } from '../../context/RobotContext'
import { demoOccupancyGrid } from '../../data/mapGrid'
import { createTurtleBot3Burger } from './turtlebotModel'
import { createSceneEnvironment } from './sceneEnvironment'
import { createDriveCamera, type CameraMode } from './driveCamera'
import { createSmoothKinematics } from './smoothKinematics'
import { createPostProcessingPipeline } from './postprocessing'
import { WorldMap } from '../map/WorldMap'
import { DriveHud } from './DriveHud'
import type { OccupancyGrid, Position2D } from '../../types/robot'

export interface Drive3DViewProps {
  mode?: 'autonomous' | 'manual' | 'puppy'
  initialCameraMode?: CameraMode
  className?: string
  showMinimap?: boolean
  onToggleFull2DMap?: () => void
}

function createEmptyOccupancyGrid(): import('../../types/robot').OccupancyGrid {
  return {
    widthCells: 0,
    heightCells: 0,
    resolutionM: 0.1,
    origin: { x: 0, y: 0 },
    cells: [],
  }
}

export function Drive3DView({
  mode = 'autonomous',
  initialCameraMode = 'CHASE',
  className,
  showMinimap = true,
  onToggleFull2DMap,
}: Drive3DViewProps) {
  const { telemetry, navigation, emergencyStopped, sourceStatus, liveOccupancyGrid, exploration } = useRobot()
  const isLive = sourceStatus === 'LIVE'

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [cameraMode, setCameraMode] = useState<CameraMode>(initialCameraMode)
  const [projectedGoal, setProjectedGoal] = useState<{ x: number; y: number; visible: boolean } | null>(null)
  const [smoothSpeed, setSmoothSpeed] = useState(0)
  const [awaitingLiveMap, setAwaitingLiveMap] = useState(false)

  // Track previous projected goal to avoid 60fps React re-renders from RAF
  const prevGoalRef = useRef<{ x: number; y: number; visible: boolean } | null>(null)

  // Stable references for render loop to avoid re-instantiating WebGL
  const telemetryRef = useRef(telemetry)
  telemetryRef.current = telemetry
  const navigationRef = useRef(navigation)
  navigationRef.current = navigation
  const explorationRef = useRef(exploration)
  explorationRef.current = exploration
  const liveOccupancyGridRef = useRef(liveOccupancyGrid)
  liveOccupancyGridRef.current = liveOccupancyGrid
  const emergencyRef = useRef(emergencyStopped)
  emergencyRef.current = emergencyStopped
  const modeRef = useRef(mode)
  modeRef.current = mode
  const sourceStatusRef = useRef(sourceStatus)
  sourceStatusRef.current = sourceStatus

  const cameraModeRef = useRef(cameraMode)
  cameraModeRef.current = cameraMode

  // P1: Track previous route path to avoid rebuilding geometry every frame
  const prevPathRef = useRef<Position2D[] | null>(null)
  const pathSignatureRef = useRef<string>('')

  // P1: Stable empty occupancy grid reference - create once, not per frame
  const emptyGridRef = useRef<OccupancyGrid>(null as unknown as OccupancyGrid)
  if (!emptyGridRef.current) {
    emptyGridRef.current = createEmptyOccupancyGrid()
  }

  // Update awaitingLiveMap state when sourceStatus or liveOccupancyGrid changes
  useEffect(() => {
    const isLive = sourceStatus === 'LIVE'
    const hasMap = !!liveOccupancyGrid
    setAwaitingLiveMap(isLive && !hasMap)
  }, [sourceStatus, liveOccupancyGrid])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    let width = container.clientWidth || 800
    let height = container.clientHeight || 500

    // All disposables captured for cleanup
    let renderer: THREE.WebGLRenderer | null = null
    let animId: number | null = null
    const cleanupFns: (() => void)[] = []

    try {
      // 1. Three.js Scene (Disaster Sky & Sunset Atmosphere)
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x18071f)
      scene.fog = new THREE.FogExp2(0x240d1c, 0.009)

      // 2. High-Performance WebGL Renderer
      // Try-catch: browsers limit WebGL contexts to ~8-16; creation can fail silently.
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
        stencil: false,
      })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(width, height)
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.04
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap

      // 3. Dynamic Forza Chase Camera
      const driveCamera = createDriveCamera(width / height)
      driveCamera.setMode(cameraModeRef.current)

      // Snap camera initially to robot pose
      const initOdom = telemetryRef.current.odometry
      driveCamera.snapToRobot(initOdom.position, initOdom.headingDeg)

      // 4. AAA Post-Processing Pipeline (UnrealBloom + Speed Motion Blur Shader)
      const postPipeline = createPostProcessingPipeline(
        renderer,
        scene,
        driveCamera.camera,
        width,
        height,
      )

      // 5. Procedural 3D TurtleBot 3 Burger Model
      const turtlebot = createTurtleBot3Burger()
      scene.add(turtlebot.root)

      // 6. Environment: live SLAM map when available. In LIVE mode without a map
      // yet, use one stable unknown/empty grid while awaiting /map; never use the
      // DEMO occupancy map as a LIVE fallback.
      const isLiveSource = sourceStatusRef.current === 'LIVE'
      const initialGrid = liveOccupancyGridRef.current ?? (isLiveSource ? createEmptyOccupancyGrid() : demoOccupancyGrid)
      let activeGrid = initialGrid
      let activeIsLive = isLiveSource
      const environment = createSceneEnvironment(initialGrid, isLiveSource)
      scene.add(environment.root)

      // Set initial route & goal if in autonomous mode
      if (modeRef.current === 'autonomous') {
        if (navigationRef.current?.goal) {
          environment.setGoalPosition(navigationRef.current.goal.position)
        }
        if (navigationRef.current?.path && navigationRef.current.path.length >= 2) {
          environment.setRoutePath(navigationRef.current.path)
        }
      }

      // 7. Continuous Kinematics Filter (Dead-Reckoning with exponential error correction)
      const kinematics = createSmoothKinematics(initOdom)

      // 8. Resize Observer
      const handleResize = () => {
        if (!container) return
        width = container.clientWidth
        height = container.clientHeight
        if (width <= 0 || height <= 0) return

        driveCamera.resize(width, height)
        renderer!.setSize(width, height)
        postPipeline.setSize(width, height)
      }

      const resizeObserver = new ResizeObserver(handleResize)
      resizeObserver.observe(container)
      cleanupFns.push(() => resizeObserver.disconnect())

      // 9. Continuous 60+ FPS Render Loop
      let lastTime = performance.now()
      let lastSpeedUpdate = 0
      let isSuspended = false
      const projectVector = new THREE.Vector3()
      // Smoothed acceleration for postprocessing VFX
      let prevLinVel = 0
      let smoothedPostAccel = 0
      let smoothedTurnBias = 0

      const loop = (now: number) => {
        animId = requestAnimationFrame(loop)
        if (isSuspended || emergencyRef.current) return

        const dt = Math.min(0.064, Math.max(0.001, (now - lastTime) / 1000))
        lastTime = now

        const rawOdom = telemetryRef.current.odometry
        const nav = navigationRef.current
        const currentMode = modeRef.current
        const isLiveSource = sourceStatusRef.current === 'LIVE'
        const expl = explorationRef.current

        // Dynamically update 3D obstacles and real-time designated boundary
        const currentGrid = liveOccupancyGridRef.current ?? (isLiveSource ? emptyGridRef.current : demoOccupancyGrid)
        if (currentGrid !== activeGrid || isLiveSource !== activeIsLive) {
          activeGrid = currentGrid
          activeIsLive = isLiveSource
          environment.updateMapGrid(currentGrid, isLiveSource)
        }

        // A. Advance smooth kinematics.
        const kPose = kinematics.update(dt, rawOdom, { isLiveMode: isLiveSource })

        // Update camera mode if user changed selection
        if (driveCamera.mode !== cameraModeRef.current) {
          driveCamera.setMode(cameraModeRef.current)
        }

        // B. Update 3D Robot Pose: scene.x = map.x, scene.z = map.y, yaw = -headingRad
        turtlebot.root.position.set(kPose.position.x, 0, kPose.position.y)
        turtlebot.root.rotation.y = -kPose.headingRad
        turtlebot.update(dt, kPose.linearVelocity, kPose.angularVelocity, kPose.pitchRad, kPose.rollRad)

        // C. Update Route, Goal, Frontier, and 360° LiDAR visuals
        const hasActiveGoal = Boolean(nav?.goal && (nav?.navigationState === 'NAVIGATING' || nav?.navigationState === 'PAUSED'))
        if (hasActiveGoal && nav?.goal) {
          environment.setGoalPosition(nav.goal.position)

          // P1: Only rebuild route geometry when path actually changes.
          // Compare serialized point signature to avoid 60fps rebuilds.
          const nextPath = nav.path && nav.path.length >= 2 ? nav.path : []
          const pathSig = nextPath.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(';')
          if (pathSig !== pathSignatureRef.current) {
            pathSignatureRef.current = pathSig
            prevPathRef.current = nextPath
            environment.setRoutePath(nextPath)
          }
        } else {
          environment.setGoalPosition(null)
          if (pathSignatureRef.current !== '') {
            pathSignatureRef.current = ''
            environment.setRoutePath([])
          }
        }

        // Update 3D Frontier Beacon if autonomous exploration is active
        const isExploring = Boolean(currentMode === 'autonomous' && expl?.state === 'EXPLORING' && expl?.selectedFrontier)
        if (isExploring && expl?.selectedFrontier) {
          environment.setFrontierTarget(expl.selectedFrontier)
        } else {
          environment.setFrontierTarget(null)
        }

        // D. Update dynamic chase camera
        driveCamera.update(dt, kPose.position, kPose.headingDeg, kPose.linearVelocity, kPose.angularVelocity)
        environment.updateLidarPoints(telemetryRef.current.lidar.points, kPose.position, kPose.headingDeg)
        environment.update(dt, kPose.position, kPose.linearVelocity, driveCamera.camera.position)

        // E. Screen-space goal / frontier reticle calculation
        const targetReticlePos = (hasActiveGoal && nav?.goal)
          ? nav.goal.position
          : (isExploring && expl?.selectedFrontier)
            ? expl.selectedFrontier
            : null

        if (targetReticlePos) {
          projectVector.set(targetReticlePos.x, 0.82, targetReticlePos.y)
          projectVector.project(driveCamera.camera)
          const isBehind = projectVector.z > 1
          const isOffScreen =
            projectVector.x < -1.1 || projectVector.x > 1.1 || projectVector.y < -1.1 || projectVector.y > 1.1

          if (isBehind || isOffScreen) {
            if (prevGoalRef.current !== null) { prevGoalRef.current = null; setProjectedGoal(null) }
          } else {
            const sx = (projectVector.x * 0.5 + 0.5) * width
            const sy = (-projectVector.y * 0.5 + 0.5) * height
            const prev = prevGoalRef.current
            if (!prev || !prev.visible || Math.abs(prev.x - sx) > 2 || Math.abs(prev.y - sy) > 2) {
              const next = { x: sx, y: sy, visible: true as const }
              prevGoalRef.current = next
              setProjectedGoal(next)
            }
          }
        } else {
          if (prevGoalRef.current !== null) { prevGoalRef.current = null; setProjectedGoal(null) }
        }

        // F. Render via AAA Post-Processing
        const rawAccelPost = (kPose.linearVelocity - prevLinVel) / dt
        prevLinVel = kPose.linearVelocity
        smoothedPostAccel += (rawAccelPost - smoothedPostAccel) * (1 - Math.exp(-3.0 * dt))
        const accelFactor = Math.max(0, Math.min(1, smoothedPostAccel / 0.5))
        const rawTurn = Math.max(-1, Math.min(1, kPose.angularVelocity / 1.5))
        smoothedTurnBias += (rawTurn - smoothedTurnBias) * (1 - Math.exp(-4.0 * dt))
        const normalizedSpeed = Math.min(1, Math.max(0, Math.abs(kPose.linearVelocity) / 0.22))
        postPipeline.render(dt, normalizedSpeed, accelFactor, smoothedTurnBias)

        if (now - lastSpeedUpdate > 100) {
          lastSpeedUpdate = now
          setSmoothSpeed(kPose.linearVelocity)
        }
      }

      animId = requestAnimationFrame(loop)

      // 10. Strict Safety Lifecycle Handlers
      const pauseSimulation = () => { isSuspended = true }
      const resumeSimulation = () => { isSuspended = false; lastTime = performance.now() }
      const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') pauseSimulation()
        else resumeSimulation()
      }

      window.addEventListener('blur', pauseSimulation)
      window.addEventListener('focus', resumeSimulation)
      window.addEventListener('pagehide', pauseSimulation)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      cleanupFns.push(() => {
        window.removeEventListener('blur', pauseSimulation)
        window.removeEventListener('focus', resumeSimulation)
        window.removeEventListener('pagehide', pauseSimulation)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        turtlebot.dispose()
        environment.dispose()
        postPipeline.dispose()
      })

    } catch (err) {
      console.error('[Drive3DView] WebGL initialization failed:', err)
      // Do not rethrow — let the component render its HTML fallback overlay instead of crashing React
    }

    return () => {
      if (animId !== null) cancelAnimationFrame(animId)
      cleanupFns.forEach((fn) => fn())
      renderer?.dispose()
    }
  }, [])


  const handleSelectCameraMode = useCallback((modeSelect: CameraMode) => {
    setCameraMode(modeSelect)
  }, [])

  // Create odometry with smoothed speed for HUD
  const hudOdometry = {
    ...telemetry.odometry,
    linearVelocity: smoothSpeed,
  }

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full min-h-[300px] overflow-hidden rounded-xl border border-signal-400/35 bg-void-950 shadow-2xl ${className ?? ''}`}
      aria-label="3D Real-Time Operator Drive View"
    >
      {/* 3D WebGL Canvas */}
      <canvas ref={canvasRef} className="block h-full w-full" />

      {/* Futuristic Sci-Fi Game HUD Overlay */}
      <DriveHud
        odometry={hudOdometry}
        navigation={navigation}
        exploration={exploration}
        cameraMode={cameraMode}
        onSelectCameraMode={handleSelectCameraMode}
        onToggleFull2DMap={onToggleFull2DMap}
        projectedGoalPos={projectedGoal}
        isLive={isLive}
        mode={mode}
        emergencyStopped={emergencyStopped}
        awaitingLiveMap={awaitingLiveMap}
      />

      {/* Interactive Floating Corner 2D Minimap */}
      {showMinimap && (
        <div
          className="pointer-events-auto absolute bottom-4 left-4 z-20 h-[195px] w-[240px] sm:h-[210px] sm:w-[265px] rounded-xl overflow-hidden shadow-2xl border border-signal-400/35 backdrop-blur-md"
          title="Interactive 2D Minimap"
        >
          <WorldMap variant="minimap" onToggleMaximize={onToggleFull2DMap} />
        </div>
      )}
    </div>
  )
}
