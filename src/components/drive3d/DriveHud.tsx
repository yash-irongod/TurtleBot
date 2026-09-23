import clsx from 'clsx'
import { Activity, Compass, Gauge, TriangleAlert, AlertCircle } from 'lucide-react'
import type { CameraMode } from './driveCamera'
import type { ExplorationInfo, NavigationInfo, NavigationState, OdometryState } from '../../types/robot'
import { fixed } from '../../lib/format'

export interface DriveHudProps {
  odometry: OdometryState
  navigation?: NavigationInfo | null
  exploration?: ExplorationInfo | null
  cameraMode: CameraMode
  onSelectCameraMode: (mode: CameraMode) => void
  onToggleFull2DMap?: () => void
  projectedGoalPos?: { x: number; y: number; visible: boolean } | null
  isLive?: boolean
  mode?: 'autonomous' | 'manual' | 'puppy'
  emergencyStopped?: boolean
  awaitingLiveMap?: boolean
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function getCompassHeading(deg: number): string {
  const norm = ((deg % 360) + 360) % 360
  const idx = Math.round(norm / 45) % 8
  return `${Math.round(norm).toString().padStart(3, '0')}° ${COMPASS_POINTS[idx]}`
}

function getNavigationTone(state: NavigationState): { dot: string; text: string; border: string; surface: string } {
  switch (state) {
    case 'NAVIGATING':
    case 'GOAL_REACHED':
      return { dot: 'bg-signal-400', text: 'text-signal-300', border: 'border-signal-400/25', surface: 'bg-signal-900/25' }
    case 'PLANNING':
    case 'LOCALIZING':
    case 'PAUSED':
    case 'CANCELING':
    case 'CANCELED':
      return { dot: 'bg-amber-400', text: 'text-amber-400', border: 'border-amber-400/25', surface: 'bg-amber-500/[0.06]' }
    case 'FAILED':
      return { dot: 'bg-critical-500', text: 'text-critical-400', border: 'border-critical-500/30', surface: 'bg-critical-500/[0.07]' }
    default:
      return { dot: 'bg-ink-500', text: 'text-ink-300', border: 'border-white/[0.09]', surface: 'bg-white/[0.02]' }
  }
}

export function DriveHud({
  odometry,
  navigation,
  exploration,
  cameraMode,
  onSelectCameraMode,
  projectedGoalPos,
  isLive = false,
  mode = 'autonomous',
  emergencyStopped = false,
  awaitingLiveMap = false,
}: DriveHudProps) {
  const speed = odometry.linearVelocity
  const headingText = getCompassHeading(odometry.headingDeg)
  const goal = navigation?.goal
  const distance = navigation?.distanceRemainingM ?? 0
  const progress = Math.max(0, Math.min(100, navigation?.progressPct ?? 0))
  const isNavigatingWithGoal = Boolean(goal && navigation?.navigationState === 'NAVIGATING')
  const isExploring = Boolean(exploration?.state === 'EXPLORING')
  const isPuppyMode = mode === 'puppy'

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3 sm:p-4 font-mono select-none overflow-hidden">
      {/* Top Header Bar */}
      <header className="flex items-start justify-between gap-3">
        {/* Left: Source Provenance Badge */}
        <div className="flex flex-col gap-1">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-signal-400/40 bg-void-950/85 px-3 py-1 shadow-lg backdrop-blur-md">
            <span
              className={clsx(
                'h-2 w-2 rounded-full animate-pulse',
                isLive ? 'bg-signal-400' : 'bg-signal-300',
              )}
            />
            <span className="text-[10px] tracking-[0.14em] uppercase font-semibold text-signal-300">
              {awaitingLiveMap
                ? '3D OPERATOR VIEW · AWAITING /MAP'
                : isLive
                ? '3D OPERATOR VIEW · LIVE TELEMETRY'
                : '3D CHASE CAM · SYNTHETIC DEMO'}
            </span>
          </div>
          <span className="px-2 text-[9px] text-ink-500 tracking-wide">
            {awaitingLiveMap
              ? 'WAITING FOR LIVE SLAM MAP · REAL ROBOT POSE ACTIVE'
              : isLive
              ? 'REAL-TIME SENSOR STREAM · ROS 2 BRIDGE'
              : 'NOT CERTIFIED SENSOR IMAGERY · KINEMATIC SIMULATION'}
          </span>
        </div>

        {/* Center: Compass Heading & Speed */}
        <div className="hidden sm:flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md border border-white/[0.1] bg-void-950/80 px-3 py-1 text-ink-100 shadow-md backdrop-blur-sm">
            <Compass className="h-3.5 w-3.5 text-signal-400" />
            <span className="text-[11px] tracking-wider font-semibold">{headingText}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-white/[0.1] bg-void-950/80 px-2.5 py-1 text-ink-100 shadow-md backdrop-blur-sm font-mono">
            <Gauge className="h-3 w-3 text-signal-400" />
            <span className="text-[11px] font-bold text-signal-300">{fixed(speed, 2)}</span>
            <span className="text-[9px] text-ink-400 uppercase">m/s</span>
          </div>
        </div>

        {/* Right: Camera Mode Toggles (Chase & FPV) */}
        <div className="pointer-events-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-white/[0.08] bg-void-950/85 p-0.5 shadow-lg backdrop-blur-md">
            {(['CHASE', 'FPV'] as CameraMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onSelectCameraMode(m)}
                className={clsx(
                  'rounded px-3 py-1 text-[9px] uppercase tracking-wider font-semibold transition-all duration-150',
                  cameraMode === m
                    ? 'border border-signal-400/40 bg-signal-500/25 text-signal-200 shadow-glow-sm'
                    : 'text-ink-400 hover:text-ink-100 hover:bg-white/[0.04]',
                )}
                title={`Switch camera to ${m} mode`}
              >
                {m === 'CHASE' ? 'Chase' : 'FPV'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Projected 3D Goal / Frontier Target Reticle */}
      {projectedGoalPos && projectedGoalPos.visible && (isNavigatingWithGoal || isExploring) && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-75"
          style={{ left: `${projectedGoalPos.x}px`, top: `${projectedGoalPos.y}px` }}
        >
          <div className="relative flex flex-col items-center">
            {isNavigatingWithGoal ? (
              <>
                {/* Holographic Glowing Red Warning Triangle (Matching User's Photo) */}
                <div className="relative flex flex-col items-center animate-pulse">
                  <div className="relative flex items-center justify-center">
                    <TriangleAlert className="h-10 w-10 text-critical-500 drop-shadow-[0_0_14px_rgba(255,23,68,0.95)]" strokeWidth={2.4} />
                  </div>
                  <div className="mt-1 flex items-center gap-1 rounded-full border border-critical-500/40 bg-void-950/90 px-2 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-critical-400 shadow-[0_0_10px_rgba(255,23,68,0.3)] backdrop-blur-sm whitespace-nowrap">
                    <span className="h-1.5 w-1.5 rounded-full bg-critical-500 animate-ping" />
                    <span>WAYPOINT · {fixed(distance, 1)}m</span>
                  </div>
                </div>
              </>
            ) : isExploring ? (
              <>
                {/* Holographic Reticle Lock Box (Cyber Cyan) */}
                <div className="relative h-12 w-12 flex items-center justify-center animate-pulse">
                  <div className="absolute inset-0 rotate-45 border-2 border-signal-400 shadow-glow-sm opacity-85" />
                  <div className="h-1.5 w-1.5 rounded-full bg-signal-400" />
                </div>
                <div className="mt-1 rounded border border-signal-400/30 bg-void-950/90 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-signal-300 backdrop-blur-sm whitespace-nowrap">
                  FRONTIER TARGET
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Bottom HUD Bar */}
      <footer className="flex items-end justify-between gap-3">
        {/* Left: Empty anchor to leave bottom-left corner clear for the 2D minimap */}
        <div className="min-w-[120px] pointer-events-none" />



        {/* Right: Route Telemetry (if active goal) OR Frontier Exploration OR Real-Time Pose Status */}
        {isNavigatingWithGoal ? (
          <div className="rounded-xl border border-critical-500/30 bg-void-950/85 p-3 text-right shadow-2xl backdrop-blur-md min-w-[160px]">
            <div className="flex items-center justify-end gap-1.5 text-[9px] uppercase text-critical-400 tracking-widest font-semibold">
              <TriangleAlert className="h-3 w-3 text-critical-400" />
              <span>Waypoint: {goal?.label ?? 'Active Target'}</span>
            </div>

            <div className="mt-1 text-[11px] font-semibold text-ink-100">
              {fixed(distance, 2)} <span className="text-[9px] text-ink-400 font-normal">m remaining</span>
            </div>

            {isLive ? (
              // LIVE mode: show Nav2 state, no fake percentage
              <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-ink-400">
                <span>Nav2 state</span>
                <span className={clsx('font-mono text-[12px]', getNavigationTone(navigation?.navigationState ?? 'IDLE').text)}>{navigation?.navigationState}</span>
              </div>
            ) : (
              // DEMO mode: show progress percentage
              <>
                <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-ink-400">
                  <span>Route</span>
                  <span className="text-signal-300 font-semibold">{Math.round(progress)}%</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className="h-full rounded-full bg-signal-400 transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </>
            )}
          </div>
        ) : isExploring ? (
          <div className="rounded-xl border border-signal-400/30 bg-void-950/85 p-3 text-right shadow-2xl backdrop-blur-md min-w-[170px]">
            <div className="flex items-center justify-end gap-1.5 text-[9px] uppercase text-signal-400 tracking-widest">
              <span className="h-1.5 w-1.5 rounded-full bg-signal-400 animate-pulse" />
              <span>Frontier Explore</span>
            </div>

            <div className="mt-1 text-[11px] font-semibold text-ink-100">
              {exploration?.frontierCount ?? 0} <span className="text-[9px] text-ink-400 font-normal">frontiers found</span>
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-ink-400">
              <span>Target</span>
              <span className="text-signal-300 font-mono">
                {exploration?.selectedFrontier
                  ? `X ${fixed(exploration.selectedFrontier.x, 1)} Y ${fixed(exploration.selectedFrontier.y, 1)}`
                  : 'Searching...'}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className="h-full rounded-full bg-signal-400 animate-pulse transition-all duration-200"
                style={{ width: '100%' }}
              />
            </div>
          </div>
        ) : awaitingLiveMap ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-950/40 p-3 text-right shadow-2xl backdrop-blur-md min-w-[170px]">
            <div className="flex items-center justify-end gap-1.5 text-[9px] uppercase text-amber-400 tracking-widest font-semibold">
              <AlertCircle className="h-3 w-3 text-amber-400" />
              <span>Awaiting /map Stream</span>
            </div>
            <div className="mt-1 text-[11px] font-semibold text-amber-300">
              Real robot pose · Real LiDAR · No map yet
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-ink-400">
              <span>Pose</span>
              <span className="text-ink-100 font-mono">
                X {fixed(odometry.position.x, 2)} · Y {fixed(odometry.position.y, 2)}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
              <div className="h-full rounded-full bg-amber-400 animate-pulse" style={{ width: '100%' }} />
            </div>
          </div>
        ) : isPuppyMode ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-950/40 p-3 text-right shadow-2xl backdrop-blur-md min-w-[170px]">
            <div className="flex items-center justify-end gap-1.5 text-[9px] uppercase text-amber-400 tracking-widest font-semibold">
              <AlertCircle className="h-3 w-3 text-amber-400" />
              <span>PERCEPTION OFFLINE</span>
            </div>
            <div className="mt-1 text-[11px] font-semibold text-amber-300">
              Real robot · Real LiDAR · No person detector
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-ink-400">
              <span>Pose</span>
              <span className="text-ink-100 font-mono">
                X {fixed(odometry.position.x, 2)} · Y {fixed(odometry.position.y, 2)}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
              <div className="h-full rounded-full bg-amber-400" style={{ width: '100%' }} />
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.1] bg-void-950/85 p-3 text-right shadow-2xl backdrop-blur-md min-w-[170px]">
            <div className="flex items-center justify-end gap-1.5 text-[9px] uppercase text-ink-500 tracking-widest">
              <Activity className="h-3 w-3 text-signal-400" />
              <span>Telemetry · {isLive ? 'LIVE ROS' : 'DEMO'}</span>
            </div>

            <div className="mt-1 text-[11px] font-semibold text-ink-100 font-mono">
              X {fixed(odometry.position.x, 2)} · Y {fixed(odometry.position.y, 2)}{' '}
              <span className="text-[9px] text-ink-400 font-normal">m</span>
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-ink-400">
              <span>Mode</span>
              <span
                className={clsx(
                  'font-semibold uppercase tracking-wider',
                  emergencyStopped ? 'text-critical-400' : 'text-signal-300',
                )}
              >
                {emergencyStopped ? 'E-STOP' : mode.toUpperCase()}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className={clsx(
                  'h-full rounded-full transition-all duration-200',
                  emergencyStopped ? 'bg-critical-500' : 'bg-signal-400',
                )}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        )}
      </footer>
    </div>
  )
}
