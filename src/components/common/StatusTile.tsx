import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { HealthLevel } from '../../types/robot'
import { healthColor } from '../../lib/health'
import { MicroLabel } from './MicroLabel'
import { StatusPulse } from './StatusPulse'

interface StatusTileProps {
  label: string
  health: HealthLevel
  value: string
  icon?: ReactNode
  /** DEMO values should be visually present but not impersonate a live feed. */
  pulse?: boolean
}

/** A compact health readout tile: icon + label, status dot, and a supporting value. */
export function StatusTile({ label, health, value, icon, pulse = true }: StatusTileProps) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {icon}
          <MicroLabel>{label}</MicroLabel>
        </div>
        <StatusPulse level={health} live={pulse} />
      </div>
      <div className={clsx('mt-1.5 font-mono text-[12px]', healthColor[health].text)}>{value}</div>
    </div>
  )
}
