import clsx from 'clsx'
import { motion } from 'framer-motion'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, OctagonAlert, Square, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useRobot } from '../../context/RobotContext'
import type { VelocityCommand, NavigationState, PuppyState, HealthLevel } from '../../types/robot'
import { SAFE_ANGULAR_RADPS, SAFE_LINEAR_MPS, SAFE_REVERSE_MPS } from '../../lib/safety'
import { metersPerSecond, radiansPerSecond } from '../../lib/format'
import { healthColor } from '../../lib/health'
import { MicroLabel } from '../common/MicroLabel'

const HOLD_MS = 650

/* ------------------------------------------------------------------ */
/* Shared small pieces                                                 */
/* ------------------------------------------------------------------ */

function DeckButton({
  label,
  onClick,
  tone = 'neutral',
  disabled,
  title,
}: {
  label: string
  onClick: () => void
  tone?: 'neutral' | 'signal' | 'critical'
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        'min-h-9 shrink-0 whitespace-nowrap rounded-md border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] transition-all duration-150 active:scale-[0.98] sm:px-3.5 sm:text-[11px]',
        tone === 'signal' && 'border-signal-400/40 bg-signal-900/40 text-signal-300 hover:bg-signal-900/60',
        tone === 'critical' && 'border-critical-500/40 bg-critical-500/[0.08] text-critical-400 hover:bg-critical-500/[0.16]',
        tone === 'neutral' && 'border-white/[0.1] bg-white/[0.03] text-ink-100 hover:border-white/[0.2]',
        disabled && 'cursor-not-allowed opacity-30',
      )}
    >
      {label}
    </button>
  )
}

function StatusChip({ label, tone }: { label: string; tone: HealthLevel }) {
  const toneBorder =
    tone === 'nominal' ? 'border-signal-400/30 bg-signal-900/30' : tone === 'warning' ? 'border-amber-400/30 bg-amber-500/10' : 'border-critical-500/40 bg-critical-500/10'
  return (
    <span
      className={clsx(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em]',
        toneBorder,
        healthColor[tone].text,
      )}
      aria-label={`Navigation status: ${label.replace(/_/g, ' ')}`}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', healthColor[tone].dot)} />
      {label.replace(/_/g, ' ')}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* AUTONOMOUS                                                          */
/* ------------------------------------------------------------------ */

function navTone(state: NavigationState): HealthLevel {
  if (state === 'FAILED') return 'critical'
  if (state === 'NAVIGATING' || state === 'GOAL_REACHED') return 'nominal'
  return 'warning'
}

function AutonomousControls() {
  const {
    navigation,
    exploration,
    sourceStatus,
    canEditMapGoal,
    setGoal,
    startNavigation,
    pauseNavigation,
    resumeNavigation,
    cancelNavigation,
    startExploration,
    stopExploration,
    emergencyStopped,
  } = useRobot()
  const { navigationState, goal } = navigation
  const busy = navigationState === 'PLANNING' || navigationState === 'NAVIGATING' || navigationState === 'CANCELING'
  const isExploring = exploration.state === 'EXPLORING' || exploration.state === 'STARTING' || exploration.state === 'STOPPING'
  const isLive = sourceStatus === 'LIVE'

  return (
    <>
      <StatusChip
        label={isExploring ? `EXPLORE: ${exploration.state}` : navigationState}
        tone={isExploring ? (exploration.state === 'EXPLORING' ? 'nominal' : 'warning') : navTone(navigationState)}
      />
      <div className="h-8 w-px shrink-0 bg-white/[0.06]" />

      {/* Auto Explore Action */}
      {isExploring ? (
        exploration.state === 'STOPPING' ? (
          <DeckButton label="Stopping…" tone="critical" onClick={() => {}} disabled />
        ) : (
          <DeckButton label="Stop Explore" tone="critical" onClick={stopExploration} />
        )
      ) : (
        <DeckButton
          label="Auto Explore"
          tone="signal"
          onClick={startExploration}
          disabled={busy || !isLive || emergencyStopped}
          title={!isLive ? 'Requires a live ROS 2 WebSocket connection' : undefined}
        />
      )}

      {/* Target Navigation Actions */}
      {sourceStatus === 'DEMO' ? (
        <DeckButton label="Set Goal" onClick={setGoal} disabled={busy || isExploring || !canEditMapGoal} />
      ) : canEditMapGoal && !isExploring && !busy && navigationState !== 'READY' ? (
        <span className="hidden shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-500 sm:inline">
          Click map for target
        </span>
      ) : null}

      {navigationState === 'READY' && !isExploring && (
        <DeckButton label="Start" tone="signal" onClick={startNavigation} />
      )}
      {navigationState === 'NAVIGATING' && sourceStatus === 'DEMO' && (
        <DeckButton label="Pause" onClick={pauseNavigation} />
      )}
      {navigationState === 'PAUSED' && sourceStatus === 'DEMO' && (
        <DeckButton label="Resume" tone="signal" onClick={resumeNavigation} />
      )}
      {/* LIVE mode Hold/Resume */}
      {navigationState === 'NAVIGATING' && isLive && (
        <DeckButton label="Hold" tone="critical" onClick={pauseNavigation} title="Cancel Nav2 goal but preserve for resume" />
      )}
      {navigationState === 'PAUSED' && isLive && (
        <DeckButton label="Resume" tone="signal" onClick={resumeNavigation} title="Redispatch preserved Nav2 goal" />
      )}
      {(navigationState === 'NAVIGATING' || navigationState === 'PAUSED' || navigationState === 'PLANNING' || navigationState === 'CANCELING') && (
        <DeckButton label="Cancel" tone="critical" onClick={cancelNavigation} />
      )}

      {/* Status Label */}
      {isExploring ? (
        <span className="ml-auto hidden shrink-0 font-mono text-[11px] text-ink-500 lg:block">
          Frontiers: <span className="text-signal-300">{exploration.frontierCount}</span>
        </span>
      ) : goal ? (
        <span className="ml-auto hidden shrink-0 font-mono text-[11px] text-ink-500 lg:block">
          Goal: <span className="text-ink-300">{goal.label}</span>
        </span>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* MANUAL                                                              */
/* ------------------------------------------------------------------ */

function KeyCap({ label, active }: { label: string; active: boolean }) {
  return (
    <div
      className={clsx(
        'flex h-7 w-7 items-center justify-center rounded-md border font-mono text-[11px] font-semibold uppercase transition-all duration-100',
        active
          ? 'border-signal-400 bg-signal-500/25 text-signal-200 shadow-glow-sm'
          : 'border-white/[0.1] bg-white/[0.03] text-ink-300',
      )}
    >
      {label}
    </div>
  )
}

function KeyboardIndicator() {
  const { activeKeys } = useRobot()
  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className="grid grid-cols-3 grid-rows-2 gap-1">
        <div />
        <KeyCap label="W" active={activeKeys.has('w')} />
        <div />
        <KeyCap label="A" active={activeKeys.has('a')} />
        <KeyCap label="S" active={activeKeys.has('s')} />
        <KeyCap label="D" active={activeKeys.has('d')} />
      </div>
      <div className="flex flex-col items-start gap-1">
        <span className="font-mono text-[9px] uppercase tracking-wide text-signal-400">Keyboard Active</span>
        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-500">Space = Stop</span>
      </div>
    </div>
  )
}

type Direction = 'forward' | 'back' | 'left' | 'right'

const DIRECTION_VELOCITY: Record<Direction, VelocityCommand> = {
  forward: { linear: SAFE_LINEAR_MPS, angular: 0 },
  back: { linear: -SAFE_REVERSE_MPS, angular: 0 },
  left: { linear: 0, angular: SAFE_ANGULAR_RADPS },
  right: { linear: 0, angular: -SAFE_ANGULAR_RADPS },
}

interface DriveButtonProps {
  icon: LucideIcon
  label: string
  disabled: boolean
  center?: boolean
  onPointerDown: () => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerCancel: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  onKeyUp?: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function DriveButton({
  icon: Icon,
  label,
  disabled,
  center,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  onKeyDown,
  onKeyUp,
}: DriveButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
      onBlur={onPointerLeave}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className={clsx(
        'flex h-7 w-7 flex-col items-center justify-center gap-0.5 rounded-md border transition-all duration-150 active:scale-[0.96] sm:h-[30px] sm:w-[30px]',
        center
          ? 'border-critical-500/25 bg-critical-500/[0.08] text-critical-400 hover:bg-critical-500/[0.16]'
          : 'border-white/[0.08] bg-white/[0.02] text-ink-300 hover:border-signal-400/30 hover:bg-signal-900/30 hover:text-signal-300',
        disabled && 'cursor-not-allowed opacity-30',
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
    </button>
  )
}

function DrivePadFallback() {
  const { setVelocityIntent, clearVelocityIntent, stopMotion, emergencyStopped } = useRobot()

  const bind = (direction: Direction) => {
    const sendDirection = () => setVelocityIntent('manual-pad', DIRECTION_VELOCITY[direction])
    const releaseDirection = () => clearVelocityIntent('manual-pad')

    return {
      onPointerDown: sendDirection,
      onPointerUp: releaseDirection,
      onPointerLeave: releaseDirection,
      onPointerCancel: releaseDirection,
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return
        event.preventDefault()
        sendDirection()
      },
      onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        releaseDirection()
      },
    }
  }

  const stopForKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return
    event.preventDefault()
    stopMotion()
  }

  return (
    <div className="grid shrink-0 grid-cols-3 grid-rows-3 gap-1">
      <div />
      <DriveButton icon={ArrowUp} label="Drive forward while holding" disabled={emergencyStopped} {...bind('forward')} />
      <div />
      <DriveButton icon={ArrowLeft} label="Turn left while holding" disabled={emergencyStopped} {...bind('left')} />
      <DriveButton
        icon={Square}
        label="Send zero velocity command"
        center
        disabled={emergencyStopped}
        onPointerDown={stopMotion}
        onPointerUp={stopMotion}
        onPointerLeave={stopMotion}
        onPointerCancel={stopMotion}
        onKeyDown={stopForKey}
        onKeyUp={stopForKey}
      />
      <DriveButton icon={ArrowRight} label="Turn right while holding" disabled={emergencyStopped} {...bind('right')} />
      <div />
      <DriveButton icon={ArrowDown} label="Drive backward while holding" disabled={emergencyStopped} {...bind('back')} />
      <div />
    </div>
  )
}

function ManualControls() {
  const { telemetry } = useRobot()
  return (
    <>
      <KeyboardIndicator />
      <div className="h-8 w-px shrink-0 bg-white/[0.06]" />
      <DrivePadFallback />
      <div className="hidden shrink-0 flex-col justify-center gap-1 font-mono text-[11px] leading-tight text-ink-300 lg:flex">
        <div>{metersPerSecond(telemetry.odometry.linearVelocity)}</div>
        <div className="text-ink-500">{radiansPerSecond(telemetry.odometry.angularVelocity)}</div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* PUPPY                                                                */
/* ------------------------------------------------------------------ */

function puppyTone(state: PuppyState): HealthLevel {
  if (state === 'TARGET_LOST') return 'critical'
  if (state === 'FOLLOWING') return 'nominal'
  return 'warning'
}

function PuppyControls() {
  const { puppy, acquireTarget, pausePuppy, resumePuppy, stopPuppy } = useRobot()
  const { puppyState } = puppy

  return (
    <>
      <StatusChip label={puppyState} tone={puppyTone(puppyState)} />
      <div className="h-8 w-px shrink-0 bg-white/[0.06]" />
      {(puppyState === 'STOPPED' || puppyState === 'TARGET_LOST') && (
        <DeckButton label="Acquire Target" tone="signal" onClick={acquireTarget} />
      )}
      {puppyState === 'FOLLOWING' && <DeckButton label="Pause Follow" onClick={pausePuppy} />}
      {puppyState === 'PAUSED' && <DeckButton label="Resume" tone="signal" onClick={resumePuppy} />}
      {puppyState !== 'STOPPED' && <DeckButton label="Stop" tone="critical" onClick={stopPuppy} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Persistent: emergency stop                                          */
/* ------------------------------------------------------------------ */

function EmergencyStopButton() {
  const { emergencyStopped, triggerEmergencyStop, resetEmergencyStop } = useRobot()
  const [progress, setProgress] = useState(0)
  const [holding, setHolding] = useState(false)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)

  const cancelHold = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setHolding(false)
    setProgress(0)
  }

  const startHold = () => {
    if (emergencyStopped) return
    cancelHold()
    setHolding(true)
    startRef.current = performance.now()

    const tick = (now: number) => {
      const elapsed = now - startRef.current
      const p = Math.min(1, elapsed / HOLD_MS)
      setProgress(p)
      if (p >= 1) {
        triggerEmergencyStop()
        rafRef.current = null
        setHolding(false)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
  }, [])

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    startHold()
  }

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    cancelHold()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return
    event.preventDefault()
    startHold()
  }

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    cancelHold()
  }

  if (emergencyStopped) {
    return (
      <button
        type="button"
        onClick={resetEmergencyStop}
        aria-label="Reset emergency stop"
        title="Reset the software stop request"
        className="control-deck-estop flex h-[76px] w-[76px] flex-col items-center justify-center gap-1 rounded-full border border-critical-500 bg-critical-500/15 text-critical-400 shadow-glow-critical animate-pulse-soft"
      >
        <OctagonAlert className="control-deck-estop-icon h-5 w-5" strokeWidth={1.75} />
        <span className="font-mono text-[9px] uppercase tracking-wide">Reset</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onLostPointerCapture={cancelHold}
      onBlur={cancelHold}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      className="control-deck-estop group relative flex h-[76px] w-[76px] items-center justify-center rounded-full"
      aria-label="Hold for 0.65 seconds to request a software emergency stop"
      aria-describedby="software-stop-note"
      title="Hold for 0.65 seconds to request a software emergency stop"
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="50" cy="50" r="46" className="fill-none stroke-critical-500/20" strokeWidth={4} />
        <motion.circle
          cx="50"
          cy="50"
          r="46"
          className="fill-none stroke-critical-400"
          strokeWidth={4}
          strokeLinecap="round"
          style={{ pathLength: progress }}
        />
      </svg>
      <div
        className={clsx(
          'control-deck-estop-core flex h-[60px] w-[60px] flex-col items-center justify-center gap-0.5 rounded-full border transition-colors duration-150',
          holding
            ? 'border-critical-400 bg-critical-500/25 text-critical-300'
            : 'border-critical-500/40 bg-critical-500/[0.08] text-critical-400 group-hover:bg-critical-500/[0.16]',
        )}
      >
        <OctagonAlert className="control-deck-estop-icon h-5 w-5" strokeWidth={1.75} />
        <span className="font-mono text-[7px] uppercase tracking-wide">{holding ? 'Hold…' : 'E-Stop'}</span>
      </div>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Deck                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Persistent: system status label + E-STOP, always available regardless of
 * mode. Contextual: the middle section swaps entirely based on activeMode —
 * Autonomous never shows drive controls, Manual never shows goal-setting.
 */
export function ControlDeck() {
  const { activeMode } = useRobot()

  return (
    <div className="control-deck flex h-24 shrink-0 items-center gap-3 border-t border-white/[0.06] bg-void-950/[0.88] px-3 backdrop-blur-xs sm:gap-4 sm:px-5">
      <MicroLabel className="hidden shrink-0 md:block">{activeMode}</MicroLabel>

      <div
        key={activeMode}
        className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto animate-fade-in"
      >
        {activeMode === 'AUTONOMOUS' && <AutonomousControls />}
        {activeMode === 'MANUAL' && <ManualControls />}
        {activeMode === 'PUPPY' && <PuppyControls />}
      </div>

      <div className="hidden h-12 w-px shrink-0 bg-white/[0.06] sm:block" />

      <div className="flex shrink-0 items-center">
        <EmergencyStopButton />
      </div>
      <span id="software-stop-note" className="sr-only">
        This is a software stop request. It is not a physical emergency-stop circuit.
      </span>
    </div>
  )
}
