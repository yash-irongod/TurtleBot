import clsx from 'clsx'
import { BatteryCharging, Hand, Map, OctagonAlert, ShieldCheck, Square } from 'lucide-react'
import { useState } from 'react'
import { useRobot } from '../context/RobotContext'
import { GlassPanel } from '../components/common/GlassPanel'
import { EnvironmentTag } from '../components/common/EnvironmentTag'
import { MicroLabel } from '../components/common/MicroLabel'
import { ViewHeader } from '../components/common/ViewHeader'
import { SegmentedControl } from '../components/common/SegmentedControl'
import { RadarDisplay } from '../components/robot/RadarDisplay'
import { ThrottleGauge } from '../components/controls/ThrottleGauge'
import { MissionQueue } from '../components/manual/MissionQueue'
import { Drive3DView } from '../components/drive3d/Drive3DView'
import { SAFE_ANGULAR_RADPS, SAFE_LINEAR_MPS, SAFE_REVERSE_MPS } from '../lib/safety'
import { fixed, percent } from '../lib/format'
import { WorldMap } from '../components/map/WorldMap'

function BigKeyCap({ label, active }: { label: string; active: boolean }) {
  return (
    <div
      className={clsx(
        'flex h-11 w-11 items-center justify-center rounded-lg border font-mono text-[14px] font-semibold uppercase transition-colors duration-100',
        active
          ? 'border-signal-400 bg-signal-500/25 text-signal-200 shadow-glow-sm'
          : 'border-white/[0.1] bg-white/[0.03] text-ink-300',
      )}
      aria-hidden="true"
    >
      {label}
    </div>
  )
}

function Cockpit() {
  const { activeKeys, telemetry, emergencyStopped, stopMotion, environment } = useRobot()
  const keyboardActive = activeKeys.size > 0
  const stateLabel = emergencyStopped ? 'Software stop active' : keyboardActive ? 'Command held' : 'Drive idle'

  return (
    <GlassPanel corners className="flex h-full min-h-[360px] flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Hand className="h-4 w-4 text-signal-400" strokeWidth={1.75} />
            <MicroLabel>Manual command</MicroLabel>
            <EnvironmentTag environment={environment} />
          </div>
          <div className="mt-2 flex items-center gap-2" aria-live="polite">
            <span
              className={clsx(
                'h-2 w-2 rounded-full',
                emergencyStopped ? 'bg-critical-500' : keyboardActive ? 'animate-pulse-soft bg-signal-400' : 'bg-ink-500',
              )}
            />
            <span className={clsx('font-mono text-[13px] uppercase tracking-[0.08em]', emergencyStopped ? 'text-critical-400' : 'text-ink-100')}>
              {stateLabel}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-3 grid-rows-2 gap-1.5" aria-label="WASD keyboard layout">
          <div />
          <BigKeyCap label="W" active={activeKeys.has('w')} />
          <div />
          <BigKeyCap label="A" active={activeKeys.has('a')} />
          <BigKeyCap label="S" active={activeKeys.has('s')} />
          <BigKeyCap label="D" active={activeKeys.has('d')} />
        </div>
      </div>

      <div className="mt-7 space-y-5">
        <ThrottleGauge
          label="Linear velocity"
          unit="m/s"
          value={telemetry.odometry.linearVelocity}
          min={-SAFE_REVERSE_MPS}
          max={SAFE_LINEAR_MPS}
        />
        <ThrottleGauge
          label="Turn rate"
          unit="rad/s"
          value={telemetry.odometry.angularVelocity}
          min={-SAFE_ANGULAR_RADPS}
          max={SAFE_ANGULAR_RADPS}
        />
      </div>

      <div className="mt-auto grid gap-3 border-t border-white/[0.06] pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-signal-400" strokeWidth={1.75} />
            <MicroLabel>Software command limits</MicroLabel>
          </div>
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-500">
            Forward {fixed(SAFE_LINEAR_MPS, 2)} m/s · reverse {fixed(SAFE_REVERSE_MPS, 2)} m/s · turn ±{fixed(SAFE_ANGULAR_RADPS, 1)} rad/s
          </p>
        </div>
        <button
          type="button"
          onClick={stopMotion}
          disabled={emergencyStopped}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-100 transition-colors hover:border-signal-400/35 hover:bg-signal-900/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Square className="h-3 w-3" fill="currentColor" strokeWidth={1.75} />
          Stop drive
        </button>
      </div>
      <p className="mt-2 flex items-start gap-1.5 font-mono text-[10px] leading-relaxed text-ink-500">
        <OctagonAlert className="mt-0.5 h-3 w-3 shrink-0 text-critical-400" strokeWidth={1.75} />
        The persistent E-STOP is a software stop request; it is not a physical safety circuit.
      </p>
    </GlassPanel>
  )
}

function ManualMappingWorkspace() {
  const { sourceStatus, liveOccupancyGrid, telemetry } = useRobot()
  const isLive = sourceStatus === 'LIVE'
  const grid = liveOccupancyGrid
  const knownPct = grid && grid.cells.length > 0
    ? (grid.cells.filter((cell) => cell !== 'unknown').length / grid.cells.length) * 100
    : 0

  return (
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-h-[420px] min-w-0">
        <WorldMap className="h-full" />
      </div>
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
        <GlassPanel corners>
          <div className="flex items-center gap-2">
            <Map className="h-4 w-4 text-signal-400" strokeWidth={1.75} />
            <MicroLabel>Manual SLAM mapping</MicroLabel>
          </div>
          <div className="mt-2 font-mono text-[13px] uppercase tracking-[0.08em] text-ink-100">
            {isLive ? 'LIVE MAP BUILDING' : 'DEMO MAP PREVIEW'}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
            {isLive
              ? 'Drive with WASD while Cartographer updates the real /map. Explore the whole arena manually, then switch to Autonomous and place a Nav2 target.'
              : 'Connect the live ROS source for actual manual SLAM mapping.'}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-3">
            <div>
              <MicroLabel>Map coverage</MicroLabel>
              <div className="mt-1 font-mono text-[13px] text-ink-100">{isLive && grid ? `${Math.round(knownPct)}% known` : '—'}</div>
            </div>
            <div className="border-l border-white/[0.06] pl-3">
              <MicroLabel>Battery</MicroLabel>
              <div className="mt-1 flex items-center gap-1 font-mono text-[13px] text-ink-100">
                <BatteryCharging className="h-3.5 w-3.5 text-signal-400" strokeWidth={1.75} />
                {percent(telemetry.battery.percentage)}
              </div>
            </div>
          </div>
        </GlassPanel>
        <Cockpit />
      </aside>
    </div>
  )
}

/** Keyboard-first operator cockpit; the persistent deck supplies the touch fallback. */
export function ManualView() {
  const [subTab, setSubTab] = useState<'drive3d' | 'drive' | 'mapping' | 'mission'>('drive3d')

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <ViewHeader title="Manual control" description="Keyboard-first drive with a shared, software-limited command path." />
        <SegmentedControl
          value={subTab}
          onChange={setSubTab}
          options={[
            { value: 'drive3d', label: '3D Chase Cam' },
            { value: 'drive', label: 'Cockpit' },
            { value: 'mapping', label: 'SLAM Mapping' },
            { value: 'mission', label: 'Mission' },
          ]}
        />
      </div>

      {subTab === 'drive' ? (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-h-[360px] min-w-0">
            <Cockpit />
          </div>
          <div className="min-h-[300px]">
            <RadarDisplay />
          </div>
        </div>
      ) : subTab === 'mapping' ? (
        <ManualMappingWorkspace />
      ) : subTab === 'drive3d' ? (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="relative min-h-[360px] min-w-0">
            <Drive3DView mode="manual" />
          </div>
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
            <Cockpit />
          </aside>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MissionQueue />
        </div>
      )}
    </div>
  )
}
