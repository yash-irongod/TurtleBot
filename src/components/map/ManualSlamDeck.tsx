import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Hand, Octagon } from 'lucide-react'
import { useRobot } from '../../context/RobotContext'
import { GlassPanel } from '../common/GlassPanel'
import { MicroLabel } from '../common/MicroLabel'
import { metersPerSecond, radiansPerSecond } from '../../lib/format'
import { SAFE_ANGULAR_RADPS, SAFE_LINEAR_MPS, SAFE_REVERSE_MPS } from '../../lib/safety'
import type { VelocityCommand } from '../../types/robot'

type SpeedPreset = 'slow' | 'medium' | 'fast'

const PRESET_SPEEDS: Record<SpeedPreset, { linear: number; angular: number; label: string }> = {
  slow: { linear: 0.08, angular: 0.5, label: 'Precision (0.08 m/s)' },
  medium: { linear: 0.14, angular: 0.8, label: 'Standard (0.14 m/s)' },
  fast: { linear: SAFE_LINEAR_MPS, angular: SAFE_ANGULAR_RADPS, label: 'Fast (0.18 m/s)' },
}

export function ManualSlamDeck() {
  const {
    telemetry,
    emergencyStopped,
    setVelocityIntent,
    clearVelocityIntent,
    stopMotion,
    exploration,
    stopExploration,
  } = useRobot()

  const [speedPreset, setSpeedPreset] = useState<SpeedPreset>('medium')
  const [activeDirection, setActiveDirection] = useState<'forward' | 'backward' | 'left' | 'right' | null>(null)
  const isExploring = exploration.state === 'EXPLORING' || exploration.state === 'STARTING'

  const activeHoldIntervalRef = useRef<number | null>(null)
  const currentCommandRef = useRef<VelocityCommand>({ linear: 0, angular: 0 })

  const { linear: maxLinear, angular: maxAngular } = PRESET_SPEEDS[speedPreset]

  const dispatchCommand = useCallback(
    (cmd: VelocityCommand) => {
      currentCommandRef.current = cmd
      if (cmd.linear === 0 && cmd.angular === 0) {
        clearVelocityIntent('manual-pad')
        stopMotion()
      } else {
        // If auto exploration was running, stop it so manual drive takes precedence
        if (isExploring) {
          stopExploration()
        }
        setVelocityIntent('manual-pad', cmd)
      }
    },
    [clearVelocityIntent, setVelocityIntent, stopMotion, isExploring, stopExploration],
  )

  const stopActiveCommand = useCallback(() => {
    if (activeHoldIntervalRef.current !== null) {
      window.clearInterval(activeHoldIntervalRef.current)
      activeHoldIntervalRef.current = null
    }
    setActiveDirection(null)
    dispatchCommand({ linear: 0, angular: 0 })
  }, [dispatchCommand])

  const startCommand = useCallback(
    (dir: 'forward' | 'backward' | 'left' | 'right') => {
      if (emergencyStopped) return

      let cmd: VelocityCommand = { linear: 0, angular: 0 }
      if (dir === 'forward') cmd = { linear: maxLinear, angular: 0 }
      if (dir === 'backward') cmd = { linear: -Math.min(SAFE_REVERSE_MPS, maxLinear * 0.7), angular: 0 }
      if (dir === 'left') cmd = { linear: 0, angular: maxAngular }
      if (dir === 'right') cmd = { linear: 0, angular: -maxAngular }

      setActiveDirection(dir)
      dispatchCommand(cmd)

      if (activeHoldIntervalRef.current !== null) {
        window.clearInterval(activeHoldIntervalRef.current)
      }

      // Keep sending intent while button is held
      activeHoldIntervalRef.current = window.setInterval(() => {
        dispatchCommand(cmd)
      }, 100)
    },
    [emergencyStopped, maxLinear, maxAngular, dispatchCommand],
  )

  // Keyboard navigation listener (WASD and Arrow keys)
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.repeat) return

      const key = e.key.toLowerCase()
      if (key === 'w' || key === 'arrowup') {
        e.preventDefault()
        startCommand('forward')
      } else if (key === 's' || key === 'arrowdown') {
        e.preventDefault()
        startCommand('backward')
      } else if (key === 'a' || key === 'arrowleft') {
        e.preventDefault()
        startCommand('left')
      } else if (key === 'd' || key === 'arrowright') {
        e.preventDefault()
        startCommand('right')
      } else if (key === ' ') {
        e.preventDefault()
        stopActiveCommand()
      }
    }

    const handleKeyUp = (e: globalThis.KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (
        key === 'w' ||
        key === 's' ||
        key === 'a' ||
        key === 'd' ||
        key === 'arrowup' ||
        key === 'arrowdown' ||
        key === 'arrowleft' ||
        key === 'arrowright'
      ) {
        stopActiveCommand()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      stopActiveCommand()
    }
  }, [startCommand, stopActiveCommand])

  const handlePointerDown = (dir: 'forward' | 'backward' | 'left' | 'right') => (e: PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    startCommand(dir)
  }

  const handlePointerUp = (e: PointerEvent) => {
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {}
    stopActiveCommand()
  }

  const isMoving = activeDirection !== null || Math.abs(telemetry.odometry.linearVelocity) > 0.01 || Math.abs(telemetry.odometry.angularVelocity) > 0.05

  return (
    <GlassPanel corners className="overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Hand className="h-3.5 w-3.5 text-signal-400" />
          <h2 className="font-mono text-micro uppercase tracking-[0.14em] text-ink-500">
            Manual SLAM Mapping
          </h2>
        </div>
        <span
          className={clsx(
            'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em]',
            isMoving
              ? 'border-signal-400/40 bg-signal-900/50 text-signal-300 animate-pulse'
              : 'border-ink-500/35 bg-white/[0.03] text-ink-400',
          )}
        >
          {isMoving ? 'MAPPING DRIVE ACTIVE' : 'READY TO STEER'}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
        Steer the robot directly around rooms and obstacles to build the SLAM map live. Use on-screen pad or <span className="font-mono text-signal-300">W A S D</span> keys.
      </p>

      {/* Speed Presets */}
      <div className="mt-3 flex items-center gap-1.5 border-t border-white/[0.06] pt-2.5">
        <MicroLabel>Speed Profile:</MicroLabel>
        {(['slow', 'medium', 'fast'] as SpeedPreset[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setSpeedPreset(p)}
            className={clsx(
              'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition',
              speedPreset === p
                ? 'border-signal-400/60 bg-signal-900/60 text-signal-300 font-semibold'
                : 'border-white/[0.08] bg-white/[0.02] text-ink-400 hover:bg-white/[0.06]',
            )}
          >
            {p}
          </button>
        ))}
      </div>

      {/* D-Pad Controller */}
      <div className="mt-3 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
        {/* Forward */}
        <button
          type="button"
          onPointerDown={handlePointerDown('forward')}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={clsx(
            'flex h-11 w-14 items-center justify-center rounded-lg border text-ink-100 shadow transition-all active:scale-95',
            activeDirection === 'forward'
              ? 'border-signal-400 bg-signal-900/80 text-signal-200 ring-2 ring-signal-400/50'
              : 'border-white/[0.12] bg-white/[0.05] hover:bg-white/[0.10]',
          )}
          title="Drive Forward (W / ArrowUp)"
        >
          <ArrowUp className="h-5 w-5" />
        </button>

        {/* Left / Stop / Right */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onPointerDown={handlePointerDown('left')}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={clsx(
              'flex h-11 w-14 items-center justify-center rounded-lg border text-ink-100 shadow transition-all active:scale-95',
              activeDirection === 'left'
                ? 'border-signal-400 bg-signal-900/80 text-signal-200 ring-2 ring-signal-400/50'
                : 'border-white/[0.12] bg-white/[0.05] hover:bg-white/[0.10]',
            )}
            title="Turn Left (A / ArrowLeft)"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={stopActiveCommand}
            className="flex h-11 w-14 items-center justify-center rounded-lg border border-critical-500/40 bg-critical-500/[0.15] text-critical-300 shadow transition-all hover:bg-critical-500/[0.25] active:scale-95"
            title="Emergency Stop (Space)"
          >
            <Octagon className="h-5 w-5" />
          </button>

          <button
            type="button"
            onPointerDown={handlePointerDown('right')}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={clsx(
              'flex h-11 w-14 items-center justify-center rounded-lg border text-ink-100 shadow transition-all active:scale-95',
              activeDirection === 'right'
                ? 'border-signal-400 bg-signal-900/80 text-signal-200 ring-2 ring-signal-400/50'
                : 'border-white/[0.12] bg-white/[0.05] hover:bg-white/[0.10]',
            )}
            title="Turn Right (D / ArrowRight)"
          >
            <ArrowRight className="h-5 w-5" />
          </button>
        </div>

        {/* Backward */}
        <button
          type="button"
          onPointerDown={handlePointerDown('backward')}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={clsx(
            'flex h-11 w-14 items-center justify-center rounded-lg border text-ink-100 shadow transition-all active:scale-95',
            activeDirection === 'backward'
              ? 'border-signal-400 bg-signal-900/80 text-signal-200 ring-2 ring-signal-400/50'
              : 'border-white/[0.12] bg-white/[0.05] hover:bg-white/[0.10]',
          )}
          title="Drive Backward (S / ArrowDown)"
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      </div>

      {/* Live SLAM telemetry summary */}
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-2.5 font-mono text-[10px]">
        <div>
          <span className="text-ink-500 uppercase tracking-wider block">Linear Velocity</span>
          <span className="text-ink-100 text-[12px]">{metersPerSecond(telemetry.odometry.linearVelocity)}</span>
        </div>
        <div className="border-l border-white/[0.06] pl-2">
          <span className="text-ink-500 uppercase tracking-wider block">Angular Velocity</span>
          <span className="text-ink-100 text-[12px]">{radiansPerSecond(telemetry.odometry.angularVelocity)}</span>
        </div>
      </div>
    </GlassPanel>
  )
}
