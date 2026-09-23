import clsx from 'clsx'
import type { HealthLevel } from '../../types/robot'
import { healthColor } from '../../lib/health'

interface StatusPulseProps {
  level: HealthLevel
  label?: string
  live?: boolean
  className?: string
}

/** A small health dot with an optional slow pulse ring, used for connection/system status. */
export function StatusPulse({ level, label, live = true, className }: StatusPulseProps) {
  const colors = healthColor[level]
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <span className="relative flex h-2 w-2">
        {live && (
          <span className={clsx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', colors.dot)} />
        )}
        <span className={clsx('relative inline-flex h-2 w-2 rounded-full', colors.dot)} />
      </span>
      {label && <span className={clsx('font-mono text-micro uppercase tracking-[0.12em]', colors.text)}>{label}</span>}
    </span>
  )
}
