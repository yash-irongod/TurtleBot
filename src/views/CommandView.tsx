import { useState, useEffect } from 'react'
import { Activity, CircleStop, Eye, Route, ShieldCheck } from 'lucide-react'
import { useRobot } from '../context/RobotContext'
import { ModeSwitcher } from '../components/modes/ModeSwitcher'
import { WorldMap } from '../components/map/WorldMap'
import { RadarDisplay } from '../components/robot/RadarDisplay'
import { TelemetryPanel } from '../components/telemetry/TelemetryPanel'
import { GlassPanel } from '../components/common/GlassPanel'
import { EnvironmentTag } from '../components/common/EnvironmentTag'
import { MicroLabel } from '../components/common/MicroLabel'
import { MODE_DEFINITIONS } from '../data/modes'
import { isAutonomous3DActive } from '../lib/driveSelectors'
import { AutonomousDrive3DView } from '../components/drive3d/AutonomousDrive3DView'

function currentActivity(
  activeMode: string,
  navigationState: string,
  goalLabel: string | undefined,
  emergencyStopped: boolean,
  isLive: boolean,
) {
  if (emergencyStopped) return { label: 'Software stop requested', detail: 'Motion commands are inhibited until reset.' }

  if (activeMode === 'AUTONOMOUS') {
    if (navigationState === 'NAVIGATING') {
      return {
        label: 'Navigating',
        detail: goalLabel
          ? `Heading toward ${goalLabel}.`
          : isLive
            ? 'Following the live Nav2 route.'
            : 'Following the selected demo route.',
      }
    }
    if (navigationState === 'PLANNING') {
      return {
        label: 'Planning route',
        detail: isLive ? 'Preparing the live Nav2 route.' : 'Preparing the selected demo route.',
      }
    }
    if (navigationState === 'PAUSED') {
      return {
        label: 'Navigation paused',
        detail: isLive ? 'The current live goal is retained.' : 'The current demo goal is retained.',
      }
    }
    if (navigationState === 'GOAL_REACHED') return { label: 'Goal reached', detail: 'Select another goal when ready.' }
    return {
      label: 'Autonomous ready',
      detail: isLive ? 'Set a live map goal to begin.' : 'Set a demo goal to begin.',
    }
  }

  if (activeMode === 'MANUAL') return { label: 'Manual control ready', detail: 'Keyboard input is armed only in Manual mode.' }
  return { label: 'Follow mode ready', detail: 'Demo target acquisition is available from the control deck.' }
}

function CommandBrief() {
  const { activeMode, navigation, emergencyStopped, environment, sourceStatus } = useRobot()
  const modeLabel = MODE_DEFINITIONS.find((mode) => mode.id === activeMode)?.label ?? activeMode
  const activity = currentActivity(
    activeMode,
    navigation.navigationState,
    navigation.goal?.label,
    emergencyStopped,
    sourceStatus === 'LIVE',
  )
  const Icon = emergencyStopped ? CircleStop : activeMode === 'AUTONOMOUS' ? Route : activeMode === 'MANUAL' ? ShieldCheck : Activity

  return (
    <GlassPanel corners className="command-brief flex min-w-0 items-start gap-3.5 !py-3">
      <span className={emergencyStopped ? 'mt-0.5 text-critical-400' : 'mt-0.5 text-signal-400'}>
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-100">{activity.label}</span>
          <EnvironmentTag environment={environment} />
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-500">{activity.detail}</p>
      </div>
      <div className="hidden shrink-0 text-right sm:block">
        <MicroLabel>Engaged mode</MicroLabel>
        <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-signal-300">{modeLabel}</div>
      </div>
    </GlassPanel>
  )
}

/**
 * The operator's overview: source truth and current activity first, then a
 * deliberate mode choice, with the world view remaining the working surface.
 */
export function CommandView() {
  const { sourceStatus, activeMode, emergencyStopped, navigation, exploration } = useRobot()
  const is3DActive = isAutonomous3DActive({ sourceStatus, activeMode, emergencyStopped, navigation, exploration })
  const [operatorOverride3D, setOperatorOverride3D] = useState(false)
  const [operatorOverride2D, setOperatorOverride2D] = useState(false)

  // Reset override whenever active navigation route resets
  useEffect(() => {
    if (!is3DActive) {
      setOperatorOverride2D(false)
    }
  }, [is3DActive])

  const show3D = (is3DActive || operatorOverride3D) && !operatorOverride2D

  return (
    <div className="command-view flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <header className="command-view-header grid shrink-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.78fr)] xl:items-end">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight text-ink-100">Command deck</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-ink-500">
            Select an operating mode, review the world state, and keep the current command context in view.
          </p>
        </div>
        <CommandBrief />
      </header>

      <ModeSwitcher className="command-mode-switcher shrink-0" />

      <div className="command-workspace grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="command-map relative min-h-[240px] min-w-0">
          {show3D ? (
            <AutonomousDrive3DView
              onToggleFull2DMap={() => {
                setOperatorOverride2D(true)
                setOperatorOverride3D(false)
              }}
            />
          ) : (
            <div className="relative h-full w-full">
              <WorldMap />
              <button
                type="button"
                onClick={() => {
                  setOperatorOverride3D(true)
                  setOperatorOverride2D(false)
                }}
                className="absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-lg border border-signal-400/40 bg-void-950/85 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-signal-300 shadow-xl backdrop-blur-md hover:bg-signal-900/60"
                title="Switch to 3D View"
              >
                <Eye className="h-3.5 w-3.5" />
                <span>3D Chase Cam</span>
              </button>
            </div>
          )}
        </div>
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5" aria-label="Command telemetry">
          <div className="command-radar h-[188px] shrink-0">
            <RadarDisplay compact />
          </div>
          <div className="command-telemetry min-h-[280px] flex-1">
            <TelemetryPanel />
          </div>
        </aside>
      </div>
    </div>
  )
}
