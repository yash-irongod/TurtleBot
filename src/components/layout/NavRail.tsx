import { Cpu, Footprints, Gamepad2, Gauge, Route, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import type { NavSection, OperationMode } from '../../types/robot'
import { useRobot } from '../../context/RobotContext'

const MODE_SECTIONS: OperationMode[] = ['AUTONOMOUS', 'MANUAL', 'PUPPY']

const SECTIONS: { id: NavSection; label: string; icon: LucideIcon }[] = [
  { id: 'COMMAND', label: 'Command', icon: Gauge },
  { id: 'AUTONOMOUS', label: 'Autonomous', icon: Route },
  { id: 'MANUAL', label: 'Manual', icon: Gamepad2 },
  { id: 'PUPPY', label: 'Puppy', icon: Footprints },
  { id: 'SYSTEM', label: 'System', icon: Cpu },
]

/** COMMAND and SYSTEM are hub screens; the other three engage their matching operating mode. */
function isModeSection(id: NavSection): id is OperationMode {
  return (MODE_SECTIONS as NavSection[]).includes(id)
}

export function NavRail() {
  const { activeSection, setActiveSection, setActiveMode } = useRobot()

  const handleSelect = (id: NavSection) => {
    if (isModeSection(id)) setActiveMode(id)
    else setActiveSection(id)
  }

  return (
    <nav
      className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-white/[0.07] bg-void-950/[0.58] py-3 backdrop-blur-xs sm:w-[76px] sm:py-4"
      aria-label="Primary navigation"
    >
      {SECTIONS.map(({ id, label, icon: Icon }) => {
        const active = activeSection === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => handleSelect(id)}
            aria-current={active ? 'page' : undefined}
            aria-label={label}
            title={label}
            className={clsx(
              'group relative flex w-12 flex-col items-center gap-1.5 rounded-lg py-2.5 transition-colors duration-150 sm:w-[64px]',
              active ? 'bg-white/[0.035] text-signal-300' : 'text-ink-500 hover:bg-white/[0.025] hover:text-ink-100',
            )}
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-full bg-signal-400 shadow-glow-sm" />
            )}
            <span
              className={clsx(
                'flex h-9 w-9 items-center justify-center rounded-lg border transition-all duration-200',
                active
                  ? 'border-signal-400/35 bg-signal-900/40 shadow-glow-sm'
                  : 'border-transparent group-hover:border-white/[0.08] group-hover:bg-white/[0.03]',
              )}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.6} />
            </span>
            <span className="hidden font-mono text-[9px] uppercase tracking-[0.1em] sm:block">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
