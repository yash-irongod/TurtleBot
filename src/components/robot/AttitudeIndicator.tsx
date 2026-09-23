import { motion } from 'framer-motion'
import { clamp } from '../../lib/polar'

interface AttitudeIndicatorProps {
  rollDeg: number
  pitchDeg: number
  size?: number
}

/** A small artificial-horizon instrument — a deliberate aerospace reference point for the Robot view. */
export function AttitudeIndicator({ rollDeg, pitchDeg, size = 132 }: AttitudeIndicatorProps) {
  const pitchPx = clamp(pitchDeg, -15, 15) * 2.4

  return (
    <div className="relative shrink-0 rounded-full border border-white/[0.08] shadow-panel" style={{ width: size, height: size }}>
      <div className="absolute inset-0 overflow-hidden rounded-full">
        <motion.div
          className="absolute"
          style={{ inset: '-60%' }}
          animate={{ rotate: rollDeg, y: pitchPx }}
          transition={{ type: 'spring', stiffness: 60, damping: 16 }}
        >
          <div className="absolute inset-0 bg-gradient-to-b from-signal-900/70 from-[46%] via-void-700 via-[50%] to-void-950 to-[54%]" />
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-signal-300/70" />
          <div className="absolute inset-x-0 top-[46%] h-px -translate-y-1/2 bg-signal-400/20" />
          <div className="absolute inset-x-0 top-[54%] h-px -translate-y-1/2 bg-signal-400/20" />
        </motion.div>
      </div>
      <div className="pointer-events-none absolute inset-[6px] rounded-full border border-white/[0.06]" />
      <div className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-ink-100" />
      <div className="absolute left-1/2 top-2 h-1.5 w-px -translate-x-1/2 bg-ink-300/70" />
    </div>
  )
}
