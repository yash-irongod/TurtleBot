import clsx from 'clsx'
import { clamp } from '../../lib/polar'
import { fixed } from '../../lib/format'
import { MicroLabel } from '../common/MicroLabel'

interface ThrottleGaugeProps {
  value: number
  min: number
  max: number
  label: string
  unit: string
}

/** A center-zero throttle bar — reverse fills left of center, forward fills right. */
export function ThrottleGauge({ value, min, max, label, unit }: ThrottleGaugeProps) {
  const valuePct = clamp(((value - min) / (max - min)) * 100, 0, 100)
  const centerPct = clamp((0 - min) / (max - min), 0, 1) * 100
  const fillLeft = Math.min(centerPct, valuePct)
  const fillWidth = Math.abs(valuePct - centerPct)

  return (
    <div>
      <div className="flex items-center justify-between">
        <MicroLabel>{label}</MicroLabel>
        <span className="font-mono text-lg text-ink-100">
          {fixed(value, 2)} <span className="text-xs text-ink-500">{unit}</span>
        </span>
      </div>
      <div className="relative mt-2 h-3 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="absolute inset-y-0 w-px bg-white/20" style={{ left: `${centerPct}%` }} />
        <div
          className={clsx('absolute inset-y-0 rounded-full bg-signal-400 shadow-glow-sm transition-all duration-150 ease-out')}
          style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
        />
      </div>
    </div>
  )
}
