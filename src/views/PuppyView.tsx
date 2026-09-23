import clsx from 'clsx'
import { motion } from 'framer-motion'
import { CircleSlash, EyeOff, Pause, Search, Target, type LucideIcon } from 'lucide-react'
import { useRobot } from '../context/RobotContext'
import { EnvironmentTag } from '../components/common/EnvironmentTag'
import { GlassPanel } from '../components/common/GlassPanel'
import { MicroLabel } from '../components/common/MicroLabel'
import { ViewHeader } from '../components/common/ViewHeader'
import { Drive3DView } from '../components/drive3d/Drive3DView'
import { healthColor } from '../lib/health'
import { fixed, percent } from '../lib/format'
import type { HealthLevel, PuppyState } from '../types/robot'

const STATE_META: Record<PuppyState, { icon: LucideIcon; tone: HealthLevel; label: string; detail: string }> = {
  STOPPED: { icon: CircleSlash, tone: 'warning', label: 'Stopped', detail: 'No follow command is active.' },
  SEARCHING: { icon: Search, tone: 'warning', label: 'Searching', detail: 'Acquiring a simulated target.' },
  TARGET_FOUND: { icon: Target, tone: 'warning', label: 'Target found', detail: 'Demo target is ready for follow.' },
  FOLLOWING: { icon: Target, tone: 'nominal', label: 'Following', detail: 'Demo follow behavior is engaged.' },
  TARGET_LOST: { icon: EyeOff, tone: 'critical', label: 'Target lost', detail: 'Follow behavior has stopped.' },
  PAUSED: { icon: Pause, tone: 'warning', label: 'Paused', detail: 'Demo target lock is retained.' },
}

function LockRing({ confidencePct, tone, Icon }: { confidencePct: number; tone: HealthLevel; Icon: LucideIcon }) {
  const progress = confidencePct / 100
  const ringClass = tone === 'nominal' ? 'stroke-signal-400' : tone === 'warning' ? 'stroke-amber-400' : 'stroke-critical-400'
  const iconClass = tone === 'nominal' ? 'text-signal-300' : tone === 'warning' ? 'text-amber-400' : 'text-critical-400'

  return (
    <div className="relative flex h-28 w-28 shrink-0 items-center justify-center">
      <div className="absolute inset-4 rounded-full bg-signal-500/[0.08] blur-lg" />
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r="46" className="fill-none stroke-white/[0.06]" strokeWidth={3} />
        <motion.circle
          cx="50"
          cy="50"
          r="46"
          className={clsx('fill-none', ringClass)}
          strokeWidth={3}
          strokeLinecap="round"
          animate={{ pathLength: progress }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        />
      </svg>
      <Icon className={clsx('h-7 w-7', iconClass)} strokeWidth={1.6} />
    </div>
  )
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | HealthLevel }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <MicroLabel>{label}</MicroLabel>
      <div className={clsx('mt-1 truncate font-mono text-[13px]', tone === 'neutral' ? 'text-ink-100' : healthColor[tone].text)}>{value}</div>
    </div>
  )
}

/** Follow-mode operator view — 3D chase cam + DEMO follow-state panel. */
export function PuppyView() {
  const { puppy, environment, sourceStatus } = useRobot()
  const meta = STATE_META[puppy.puppyState]
  const hasTarget = puppy.puppyState === 'TARGET_FOUND' || puppy.puppyState === 'FOLLOWING' || puppy.puppyState === 'PAUSED'
  const Icon = meta.icon
  const isLive = sourceStatus === 'LIVE'

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ViewHeader title="Follow behavior" description="A clearly labeled DEMO model for future person detection and trailing control." />
        <EnvironmentTag environment={environment} />
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">

        {/* Left: 3D operator view — shows real robot position, heading, and LiDAR in LIVE mode */}
        <section className="relative min-h-[300px] min-w-0" aria-label="Follow behavior 3D view">
          <Drive3DView
            mode="puppy"
            className="h-full"
          />
          {/* Perception offline overlay badge */}
          <div className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-amber-500/35 bg-amber-950/80 px-3 py-1 backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-amber-300">
              Perception Offline · {isLive ? 'Live Robot' : 'Demo Mode'}
            </span>
          </div>
        </section>

        {/* Right: Follow state panel */}
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5" aria-label="Follow behavior details">
          <GlassPanel corners className="flex flex-col items-center justify-center gap-4 py-5 text-center">
            <LockRing confidencePct={puppy.confidencePct} tone={meta.tone} Icon={Icon} />
            <div className={clsx('font-mono text-[14px] uppercase tracking-[0.1em]', healthColor[meta.tone].text)} aria-live="polite">
              {meta.label}
            </div>
            <p className="max-w-[200px] text-[11px] leading-relaxed text-ink-500">{meta.detail}</p>
          </GlassPanel>

          <GlassPanel corners>
            <div className="flex items-center justify-between gap-3">
              <MicroLabel>Target status</MicroLabel>
              <EnvironmentTag environment={environment} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <Stat label="Target" value={hasTarget ? 'Demo target' : 'Not acquired'} tone={hasTarget ? meta.tone : 'neutral'} />
              <Stat label="Confidence" value={percent(puppy.confidencePct)} tone={meta.tone} />
              <Stat label="Distance" value={hasTarget ? `${fixed(puppy.distanceM, 2)} m` : '—'} />
              <Stat label="Bearing" value={hasTarget ? `${Math.round(puppy.targetBearingDeg)}°` : '—'} />
            </div>
          </GlassPanel>

          <GlassPanel>
            <MicroLabel>Integration boundary</MicroLabel>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-500">
              No detector, camera feed, or ROS 2 follow behavior is connected in this build.
              The 3D view shows the real robot position from /odom and real LiDAR from /scan in LIVE mode.
            </p>
          </GlassPanel>
        </aside>
      </div>
    </div>
  )
}
