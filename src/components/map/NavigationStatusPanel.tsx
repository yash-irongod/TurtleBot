import clsx from 'clsx'
import { useId } from 'react'
import { useRobot } from '../../context/RobotContext'
import { fixed } from '../../lib/format'
import { GlassPanel } from '../common/GlassPanel'
import { MicroLabel } from '../common/MicroLabel'
import type { DataEnvironment, NavigationState } from '../../types/robot'

type NavigationTone = 'neutral' | 'nominal' | 'warning' | 'critical'

interface NavigationPresentation {
  label: string
  detail: string
  tone: NavigationTone
}

const NAVIGATION_PRESENTATION: Record<NavigationState, NavigationPresentation> = {
  IDLE: { label: 'Idle', detail: 'No route is armed.', tone: 'neutral' },
  LOCALIZING: { label: 'Localizing', detail: 'Establishing map-frame pose.', tone: 'warning' },
  READY: { label: 'Ready', detail: 'A target is ready to start.', tone: 'nominal' },
  PLANNING: { label: 'Planning route', detail: 'Preparing a route to the selected target.', tone: 'warning' },
  NAVIGATING: { label: 'Navigating', detail: 'Following the active route.', tone: 'nominal' },
  PAUSED: { label: 'Paused', detail: 'Route progress is held by the operator.', tone: 'warning' },
  CANCELING: { label: 'Canceling route', detail: 'Waiting for the current Nav2 goal to terminate.', tone: 'warning' },
  GOAL_REACHED: { label: 'Goal reached', detail: 'The target was reached.', tone: 'nominal' },
  FAILED: { label: 'Route failed', detail: 'The route ended without reaching its target.', tone: 'critical' },
  CANCELED: { label: 'Route canceled', detail: 'The active route was cleared.', tone: 'warning' },
}

const TONE_CLASS: Record<NavigationTone, { dot: string; text: string; border: string; surface: string }> = {
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

function presentationFor(state: NavigationState, environment: DataEnvironment): NavigationPresentation {
  const base = NAVIGATION_PRESENTATION[state]
  if (environment !== 'live') return base
  if (state === 'GOAL_REACHED') {
    return { ...base, detail: 'The live robot reached the Nav2 goal.' }
  }
  if (state === 'FAILED') {
    return { ...base, detail: 'Nav2 ended the route without reaching its target.' }
  }
  if (state === 'NAVIGATING') {
    return { ...base, detail: 'Following the live Nav2 route.' }
  }
  if (state === 'PLANNING') {
    return { ...base, detail: 'Preparing the live Nav2 route.' }
  }
  if (state === 'PAUSED') {
    return { ...base, detail: 'The current live goal is retained.' }
  }
  if (state === 'CANCELING') {
    return { ...base, detail: 'Waiting for the live Nav2 goal to terminate.' }
  }
  if (state === 'READY') {
    return { ...base, detail: 'A live map target is ready to start.' }
  }
  return base
}

const SOURCE_LABEL: Record<DataEnvironment, string> = {
  demo: 'DEMO NAVIGATION',
  live: 'LIVE NAVIGATION',
  offline: 'NAVIGATION OFFLINE',
}

function sourceNote(environment: DataEnvironment): string {
  if (environment === 'demo') return 'State and route progress are simulated; this is not a Nav2 status feed.'
  if (environment === 'live') return 'State is supplied by the connected navigation stack.'
  return 'No navigation data source is currently available.'
}

export function NavigationStatusPanel() {
  const { navigation, environment, sourceStatus } = useRobot()
  const { navigationState, goal, distanceRemainingM, progressPct } = navigation
  const isLive = sourceStatus === 'LIVE'
  const panelTitleId = useId().replace(/:/g, '')
  const presentation = presentationFor(navigationState, environment)
  const tone = TONE_CLASS[presentation.tone]
  const progress = Math.max(0, Math.min(100, progressPct))
  const progressLabel = goal
    ? `${Math.round(progress)} percent complete, ${fixed(distanceRemainingM, 2)} metres remaining`
    : 'No route progress because no goal is assigned'

  return (
    <GlassPanel corners className="overflow-hidden" aria-labelledby={panelTitleId}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={panelTitleId} className="font-mono text-micro uppercase tracking-[0.14em] text-ink-500">
          Navigation
        </h2>
        <span
          className={clsx(
            'shrink-0 rounded-full border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em]',
            environment === 'demo'
              ? 'border-ink-500/35 bg-white/[0.03] text-ink-300'
              : environment === 'live'
              ? 'border-signal-400/35 bg-signal-900/40 text-signal-300'
              : 'border-critical-500/40 bg-critical-500/[0.08] text-critical-400',
          )}
        >
          {SOURCE_LABEL[environment]}
        </span>
      </div>

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

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <MicroLabel>Target</MicroLabel>
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-500">
            {goal ? 'Assigned' : 'Awaiting target'}
          </span>
        </div>
        {goal ? (
          <div className="mt-1 min-w-0">
            <div className="truncate font-mono text-[13px] text-ink-100" title={goal.label}>
              {goal.label}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-ink-500">
              X {fixed(goal.position.x, 2)} · Y {fixed(goal.position.y, 2)} m
            </div>
          </div>
        ) : (
          <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
            Click a free cell on the {isLive ? 'live map' : 'demo map'} or select a{' '}
            {isLive ? 'Nav2 goal' : 'demo waypoint'} to prepare a route.
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-white/[0.06] pt-3">
        {isLive ? (
          // LIVE mode: show distance remaining and Nav2 state, no fake percentage
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <MicroLabel>Distance remaining</MicroLabel>
              <span className="font-mono text-[12px] text-ink-100">{goal ? `${fixed(distanceRemainingM, 2)} m` : '—'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <MicroLabel>Nav2 state</MicroLabel>
              <span className={clsx('font-mono text-[12px]', tone.text)}>{presentation.label}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <MicroLabel>Route</MicroLabel>
              <div className="mt-0.5 text-[12px] text-ink-100">{navigation.path.length > 1 ? 'Plan displayed' : 'Not planned'}</div>
            </div>
          </div>
        ) : (
          // DEMO mode: show progress percentage
          <>
            <div className="flex items-center justify-between gap-3">
              <MicroLabel>Route progress</MicroLabel>
              <span className={clsx('font-mono text-[12px]', tone.text)}>{Math.round(progress)}%</span>
            </div>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
              role="progressbar"
              aria-label="Navigation route progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
              aria-valuetext={progressLabel}
            >
              <div className={clsx('h-full rounded-full transition-[width] duration-300 ease-out', tone.dot)} style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 font-mono text-[10px]">
              <div>
                <MicroLabel>Remaining</MicroLabel>
                <div className="mt-0.5 text-[12px] text-ink-100">{goal ? `${fixed(distanceRemainingM, 2)} m` : '—'}</div>
              </div>
              <div className="border-l border-white/[0.06] pl-3">
                <MicroLabel>Route</MicroLabel>
                <div className="mt-0.5 text-[12px] text-ink-100">{navigation.path.length > 1 ? 'Plan displayed' : 'Not planned'}</div>
              </div>
            </div>
          </>
        )}
      </div>

      <p className="mt-4 border-t border-white/[0.06] pt-3 text-[10px] leading-relaxed text-ink-500">{sourceNote(environment)}</p>
    </GlassPanel>
  )
}
