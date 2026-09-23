import clsx from 'clsx'
import { useId } from 'react'
import { Compass, Octagon, Play, Sparkles } from 'lucide-react'
import { useRobot } from '../../context/RobotContext'
import { fixed } from '../../lib/format'
import { GlassPanel } from '../common/GlassPanel'
import { MicroLabel } from '../common/MicroLabel'
import type { ExplorationState } from '../../types/robot'

type ExploreTone = 'neutral' | 'nominal' | 'warning' | 'critical'

interface ExplorePresentation {
  label: string
  detail: string
  tone: ExploreTone
}

const EXPLORATION_PRESENTATION: Record<ExplorationState, ExplorePresentation> = {
  IDLE: {
    label: 'Idle',
    detail: 'Frontier exploration stack is ready to launch.',
    tone: 'neutral',
  },
  STARTING: {
    label: 'Starting',
    detail: 'Initializing autonomous exploration launch...',
    tone: 'warning',
  },
  EXPLORING: {
    label: 'Exploring',
    detail: 'Autonomous frontier seeking and SLAM map expansion in progress.',
    tone: 'nominal',
  },
  STOPPING: {
    label: 'Stopping',
    detail: 'Terminating exploration process group & zeroing velocity...',
    tone: 'warning',
  },
  COMPLETE: {
    label: 'Complete',
    detail: 'No accessible frontiers remaining; exploration complete.',
    tone: 'nominal',
  },
  ERROR: {
    label: 'Error',
    detail: 'Exploration process exited with an error or failed to launch.',
    tone: 'critical',
  },
}

const TONE_CLASS: Record<ExploreTone, { dot: string; text: string; border: string; surface: string }> = {
  neutral: {
    dot: 'bg-ink-500',
    text: 'text-ink-300',
    border: 'border-white/[0.09]',
    surface: 'bg-white/[0.02]',
  },
  nominal: {
    dot: 'bg-signal-400',
    text: 'text-signal-300',
    border: 'border-signal-400/25',
    surface: 'bg-signal-900/25',
  },
  warning: {
    dot: 'bg-amber-400',
    text: 'text-amber-400',
    border: 'border-amber-400/25',
    surface: 'bg-amber-500/[0.06]',
  },
  critical: {
    dot: 'bg-critical-500',
    text: 'text-critical-400',
    border: 'border-critical-500/30',
    surface: 'bg-critical-500/[0.07]',
  },
}

export function AutoExplorePanel() {
  const { exploration, startExploration, stopExploration, sourceStatus, emergencyStopped } = useRobot()
  const panelTitleId = useId().replace(/:/g, '')
  const presentation = EXPLORATION_PRESENTATION[exploration.state]
  const tone = TONE_CLASS[presentation.tone]
  const isLive = sourceStatus === 'LIVE'
  const isExploring = exploration.state === 'EXPLORING' || exploration.state === 'STARTING'
  const isStopping = exploration.state === 'STOPPING'
  const isBusy = exploration.state === 'STARTING' || exploration.state === 'STOPPING'

  return (
    <GlassPanel corners className="overflow-hidden" aria-labelledby={panelTitleId}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Compass className="h-3.5 w-3.5 text-signal-400" />
          <h2 id={panelTitleId} className="font-mono text-micro uppercase tracking-[0.14em] text-ink-500">
            Auto Explore
          </h2>
        </div>
        <span
          className={clsx(
            'shrink-0 rounded-full border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em]',
            isLive
              ? 'border-signal-400/35 bg-signal-900/40 text-signal-300'
              : 'border-ink-500/35 bg-white/[0.03] text-ink-400',
          )}
        >
          {isLive ? 'FRONTIER EXPLORER' : 'DEMO MODE'}
        </span>
      </div>

      {/* State Banner */}
      <div className={clsx('mt-3 rounded-lg border px-3 py-3', tone.border, tone.surface)}>
        <div className="flex items-start gap-2.5">
          <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone.dot)} aria-hidden="true" />
          <div className="min-w-0">
            <div className={clsx('font-mono text-sm uppercase tracking-[0.06em]', tone.text)} role="status" aria-live="polite">
              {presentation.label}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{presentation.detail}</p>
          </div>
        </div>
      </div>

      {/* Telemetry Stats */}
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-3 font-mono text-[10px]">
        <div>
          <MicroLabel>Frontiers</MicroLabel>
          <div className="mt-0.5 text-[12px] text-ink-100 flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-signal-400" />
            <span>{exploration.frontierCount} detected</span>
          </div>
        </div>
        <div className="border-l border-white/[0.06] pl-3">
          <MicroLabel>Selected Target</MicroLabel>
          <div className="mt-0.5 truncate text-[12px] text-ink-100" title={exploration.selectedFrontier ? `X ${fixed(exploration.selectedFrontier.x, 2)}, Y ${fixed(exploration.selectedFrontier.y, 2)}` : 'None'}>
            {exploration.selectedFrontier
              ? `${fixed(exploration.selectedFrontier.x, 2)}, ${fixed(exploration.selectedFrontier.y, 2)} m`
              : 'Scanning...'}
          </div>
        </div>
      </div>

      {/* Action Controls */}
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        {isExploring ? (
          <button
            type="button"
            onClick={stopExploration}
            disabled={exploration.state === 'STOPPING'}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-critical-500/40 bg-critical-500/[0.12] px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-critical-300 shadow-sm transition hover:bg-critical-500/[0.22] active:bg-critical-500/[0.30] disabled:opacity-50"
          >
            <Octagon className="h-3.5 w-3.5" />
            <span>{exploration.state === 'STARTING' ? 'Stop Exploration' : 'Stop Exploration'}</span>
          </button>
        ) : isStopping ? (
          <button
            type="button"
            disabled
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-400/30 bg-amber-500/[0.06] px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-amber-300 shadow-sm disabled:opacity-70"
          >
            <Octagon className="h-3.5 w-3.5" />
            <span>Stopping...</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={startExploration}
            disabled={emergencyStopped || isBusy || !isLive}
            title={!isLive ? 'Requires a live ROS 2 WebSocket connection' : undefined}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-signal-400/40 bg-signal-900/40 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-signal-300 shadow-sm transition hover:bg-signal-900/65 active:bg-signal-900/80 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            <span>Start Exploration</span>
          </button>
        )}
      </div>

      {!isLive && (
        <p className="mt-3 text-[10px] leading-relaxed text-ink-500">
          Connect to the ROS 2 WebSocket bridge to launch the real Frontier Explorer stack.
        </p>
      )}
    </GlassPanel>
  )
}
