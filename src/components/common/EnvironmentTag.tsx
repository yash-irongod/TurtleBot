import { useState } from 'react'
import clsx from 'clsx'
import { useRobot } from '../../context/RobotContext'
import type { DataEnvironment } from '../../types/robot'

interface EnvironmentStyle {
  label: string
  description: string
  className: string
  dotClassName: string
}

// Keep this string-keyed rather than exhaustive so a future data-source state can
// still render safely before the operator copy gets a dedicated visual treatment.
const STYLES: Record<string, EnvironmentStyle> = {
  demo: {
    label: 'Demo',
    description: 'Simulated telemetry — not connected to ROS',
    className: 'border-ink-500/35 bg-white/[0.035] text-ink-300',
    dotClassName: 'bg-ink-500',
  },
  live: {
    label: 'Live • ROS',
    description: 'Live ROS data source',
    className: 'border-signal-400/40 bg-signal-900/40 text-signal-300',
    dotClassName: 'bg-signal-400',
  },
  offline: {
    label: 'Disconnected',
    description: 'No data source is connected',
    className: 'border-critical-500/40 bg-critical-500/[0.08] text-critical-400',
    dotClassName: 'bg-critical-500',
  },
  disconnected: {
    label: 'Disconnected',
    description: 'No data source is connected',
    className: 'border-critical-500/40 bg-critical-500/[0.08] text-critical-400',
    dotClassName: 'bg-critical-500',
  },
}

const UNKNOWN_STYLE: EnvironmentStyle = {
  label: 'Source unknown',
  description: 'The data source state is not recognized',
  className: 'border-amber-400/35 bg-amber-500/[0.08] text-amber-400',
  dotClassName: 'bg-amber-400',
}

/**
 * The one job of this component: never let simulated data read as live.
 * Used anywhere telemetry, connection state, or "system events" are shown —
 * see TopBar, SystemView's boot log, and the mode views.
 */
export function EnvironmentTag({
  environment,
  className,
  allowToggle = true,
}: {
  environment: DataEnvironment | string
  className?: string
  allowToggle?: boolean
}) {
  const style = STYLES[environment.toLowerCase()] ?? UNKNOWN_STYLE
  const { sourceStatus, canSwitchDataSource, requestDataSourceSwitch } = useRobot()
  const [switching, setSwitching] = useState(false)

  const targetSource = sourceStatus === 'LIVE' ? 'DEMO' : 'LIVE'
  const canToggle =
    allowToggle &&
    !switching &&
    !(sourceStatus === 'LIVE' && !canSwitchDataSource)

  const handleToggle = async () => {
    if (!canToggle) return
    setSwitching(true)
    try {
      await requestDataSourceSwitch(targetSource)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={!canToggle}
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition-opacity hover:opacity-85',
        style.className,
        className,
      )}
      title={!canToggle && sourceStatus === 'LIVE' ? 'Source switch unavailable while live motion is active' : `${style.description} · Click to switch data source (DEMO ↔ LIVE ROS)`}
      aria-label={`${style.description} · Click to switch data source (DEMO ↔ LIVE ROS)`}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', style.dotClassName)} aria-hidden="true" />
      {style.label}
    </button>
  )
}
