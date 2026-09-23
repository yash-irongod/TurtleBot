import clsx from 'clsx'
import { Radio } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useRobot } from '../../context/RobotContext'
import { MicroLabel } from '../common/MicroLabel'
import { StatusPulse } from '../common/StatusPulse'
import { EnvironmentTag } from '../common/EnvironmentTag'
import { clockTime, isoDate, percent } from '../../lib/format'
import { batteryHealth, healthColor } from '../../lib/health'

function Divider({ className }: { className?: string }) {
  return <span className={clsx('h-4 w-px bg-white/[0.09]', className)} aria-hidden="true" />
}

export function TopBar() {
  const { telemetry, activeMode, emergencyStopped, environment } = useRobot()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const battHealth = batteryHealth(telemetry.battery.percentage)

  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] bg-void-950/[0.86] px-3 backdrop-blur-xs sm:px-5 lg:h-16"
      aria-label="Control center status"
    >
      <div className="flex min-w-0 items-center gap-2.5 sm:gap-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-signal-400/30 bg-signal-900/35 shadow-glow-sm">
          <Radio className="h-4 w-4 text-signal-400" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[14px] font-semibold tracking-tight text-ink-100 sm:text-[15px]">
            TURTLEBOT <span className="font-normal text-ink-500">// CONTROL CENTER</span>
          </div>
          <div className="mt-0.5 hidden items-center gap-2 sm:flex">
            <MicroLabel>Unit 03</MicroLabel>
            <Divider />
            <MicroLabel>TurtleBot3 Burger</MicroLabel>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5 sm:gap-4">
        <div className="hidden sm:block" title={emergencyStopped ? 'Software stop is active' : 'Controls are ready'}>
          {emergencyStopped ? (
            <StatusPulse level="critical" label="Software stop" live={false} />
          ) : (
            <StatusPulse level="nominal" label="Control ready" />
          )}
        </div>

        <EnvironmentTag environment={environment} />

        <Divider className="hidden lg:block" />

        <div className="hidden items-center gap-2 lg:flex">
          <MicroLabel>Mode</MicroLabel>
          <span className="font-mono text-xs text-signal-300">{activeMode}</span>
        </div>

        <Divider className="hidden sm:block" />

        <div className="hidden items-center gap-2 sm:flex" title="Battery charge">
          <MicroLabel>Batt</MicroLabel>
          <span className={clsx('font-mono text-xs', healthColor[battHealth].text)}>
            {percent(telemetry.battery.percentage)}
          </span>
        </div>

        <Divider className="hidden xl:block" />

        <time dateTime={now.toISOString()} className="hidden text-right leading-tight xl:block">
          <div className="font-mono text-xs text-ink-100">{clockTime(now)}</div>
          <div className="font-mono text-[10px] text-ink-500">{isoDate(now)}</div>
        </time>
      </div>
    </header>
  )
}
