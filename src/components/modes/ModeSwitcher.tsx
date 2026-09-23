import clsx from 'clsx'
import { Footprints, Gamepad2, Route, type LucideIcon } from 'lucide-react'
import { useRobot } from '../../context/RobotContext'
import { MODE_DEFINITIONS } from '../../data/modes'
import { GlassPanel } from '../common/GlassPanel'
import type { OperationMode } from '../../types/robot'

const MODE_ICONS: Record<OperationMode, LucideIcon> = {
  AUTONOMOUS: Route,
  MANUAL: Gamepad2,
  PUPPY: Footprints,
}

interface ModeSwitcherProps {
  className?: string
}

/**
 * The three primary operating modes, presented as distinct entry points —
 * this is the "pick your operating system" moment the Command screen exists
 * to deliver, not a row of small chips.
 */
export function ModeSwitcher({ className }: ModeSwitcherProps) {
  const { activeMode, setActiveMode } = useRobot()

  return (
    <div className={clsx('mode-switcher grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3', className)} role="group" aria-label="Operating mode">
      {MODE_DEFINITIONS.map((mode) => {
        const Icon = MODE_ICONS[mode.id]
        const active = mode.id === activeMode
        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => setActiveMode(mode.id)}
            aria-pressed={active}
            aria-label={`Select ${mode.label} mode${active ? ', currently active' : ''}`}
            className="group block appearance-none rounded-lg border-0 bg-transparent p-0 text-left"
          >
            <GlassPanel
              corners
              tone={active ? 'signal' : 'neutral'}
              className={clsx(
                'mode-switcher-card relative h-full min-h-[132px] overflow-hidden transition-[border-color,background-color,box-shadow] duration-200',
                active ? 'bg-signal-900/[0.38] shadow-glow' : 'group-hover:border-white/[0.16] group-hover:bg-void-800/80',
              )}
            >
              {active && (
                <span
                  className="mode-switcher-active absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-signal-400/40 bg-signal-900/60 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-signal-300"
                >
                  <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-signal-400" />
                  Active
                </span>
              )}
              <span
                className={clsx(
                  'mode-switcher-icon flex h-10 w-10 items-center justify-center rounded-md border',
                  active ? 'border-signal-400/40 bg-signal-900/50' : 'border-white/[0.08] bg-white/[0.03]',
                )}
              >
                <Icon className={clsx('h-[18px] w-[18px]', active ? 'text-signal-300' : 'text-ink-300')} strokeWidth={1.6} />
              </span>
              <div className="mode-switcher-title mt-2.5 font-mono text-[13px] uppercase tracking-[0.08em] text-ink-100">{mode.label}</div>
              <div className="mode-switcher-tagline mt-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-signal-400/70">{mode.tagline}</div>
              <p className="mode-switcher-description mt-2 text-[11px] leading-5 text-ink-500">{mode.description}</p>
            </GlassPanel>
          </button>
        )
      })}
    </div>
  )
}
