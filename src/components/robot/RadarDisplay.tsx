import clsx from 'clsx'
import { useId } from 'react'
import { useRobot } from '../../context/RobotContext'
import { GlassPanel } from '../common/GlassPanel'
import { MicroLabel } from '../common/MicroLabel'
import { RobotGlyph } from './RobotGlyph'
import { polarToXY } from '../../lib/polar'
import { fixed } from '../../lib/format'
import type { DataEnvironment } from '../../types/robot'

const SIZE = 520
const CENTER = SIZE / 2
const MAX_RADIUS = 220
const RING_FRACTIONS = [0.34, 0.67, 1]

function wedgePath(angleStart: number, angleEnd: number): string {
  const p1 = polarToXY(CENTER, CENTER, MAX_RADIUS, angleStart, 1)
  const p2 = polarToXY(CENTER, CENTER, MAX_RADIUS, angleEnd, 1)
  return `M ${CENTER} ${CENTER} L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${MAX_RADIUS} ${MAX_RADIUS} 0 0 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} Z`
}

function sourceLabel(environment: DataEnvironment): string {
  if (environment === 'demo') return 'DEMO SCAN'
  if (environment === 'live') return 'LIVE SCAN'
  return 'SCAN OFFLINE'
}

interface RadarDisplayProps {
  /** Drops the header/footer chrome for use as a smaller secondary panel (e.g. on Command/Autonomous). */
  compact?: boolean
  className?: string
}

/**
 * Local LiDAR reference frame, deliberately distinct from WorldMap's global
 * occupancy view. The forward sector is static: data updates communicate
 * state without a continuous decorative sweep consuming render time.
 */
export function RadarDisplay({ compact = false, className }: RadarDisplayProps) {
  const { telemetry, environment } = useRobot()
  const { lidar, odometry } = telemetry
  const instanceId = useId().replace(/:/g, '')
  const glowId = `${instanceId}-radar-glow`
  const headingPoint = polarToXY(CENTER, CENTER, MAX_RADIUS - 8, odometry.headingDeg, 1)
  const source = sourceLabel(environment)

  return (
    <GlassPanel
      corners
      className={clsx('relative flex h-full flex-col overflow-hidden !p-0', compact ? 'min-h-0' : 'min-h-[220px]', className)}
    >
      {!compact && (
        <div className="flex items-center justify-between px-5 pt-4">
          <MicroLabel>LiDAR / local frame</MicroLabel>
          <MicroLabel className="text-signal-400/70">{source}</MicroLabel>
        </div>
      )}

      <div className="relative flex flex-1 items-center justify-center px-2">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="h-full w-full max-w-[560px]"
          role="img"
          aria-label={`${source.toLowerCase()} spatial display centered on the robot`}
        >
          <defs>
            <radialGradient id={glowId} cx="50%" cy="50%" r="65%">
              <stop offset="0%" stopColor="#0F2C3D" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#04060A" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle cx={CENTER} cy={CENTER} r={MAX_RADIUS + 16} fill={`url(#${glowId})`} />

          {Array.from({ length: 8 }).map((_, i) => {
            const angle = i * 45
            const p = polarToXY(CENTER, CENTER, MAX_RADIUS, angle, 1)
            return (
              <line
                key={angle}
                x1={CENTER}
                y1={CENTER}
                x2={p.x}
                y2={p.y}
                className="stroke-signal-400/[0.07]"
                strokeWidth={1}
              />
            )
          })}

          {RING_FRACTIONS.map((fraction) => (
            <circle
              key={fraction}
              cx={CENTER}
              cy={CENTER}
              r={MAX_RADIUS * fraction}
              className="fill-none stroke-signal-400/[0.15]"
              strokeWidth={1}
            />
          ))}
          {RING_FRACTIONS.map((fraction) => (
            <text
              key={`label-${fraction}`}
              x={CENTER + 6}
              y={CENTER - MAX_RADIUS * fraction + 12}
              className="fill-ink-500 font-mono text-[9px] tracking-wide"
            >
              {fixed(lidar.rangeMaxM * fraction, 1)}M
            </text>
          ))}

          <path d={wedgePath(-52, 18)} className="fill-signal-400/[0.10]" />

          {lidar.points.map((point) => {
            const { x, y } = polarToXY(CENTER, CENTER, MAX_RADIUS, point.angleDeg, point.distanceM / lidar.rangeMaxM)
            const near = point.distanceM < 0.7
            return (
              <circle
                key={point.angleDeg}
                cx={x}
                cy={y}
                r={near ? 2.1 : 1.4}
                className={near ? 'fill-amber-400' : 'fill-signal-300'}
                style={{ opacity: near ? 0.85 : 0.5 }}
              />
            )
          })}

          <line
            x1={CENTER}
            y1={CENTER}
            x2={headingPoint.x}
            y2={headingPoint.y}
            className="stroke-signal-300"
            strokeWidth={1.5}
            strokeDasharray="1 6"
            strokeLinecap="round"
          />
        </svg>

        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="absolute inset-[-20px] rounded-full bg-signal-500/10 blur-xl" />
          <div className="transition-transform duration-300 ease-out" style={{ transform: `rotate(${odometry.headingDeg}deg)` }}>
            <RobotGlyph size={compact ? 40 : 58} />
          </div>
        </div>
      </div>

      {!compact && (
        <div className="grid grid-cols-3 gap-3 border-t border-white/[0.06] px-5 py-3">
          <Readout label="Heading" value={`${String(Math.round(odometry.headingDeg)).padStart(3, '0')}°`} />
          <Readout label="Position (m)" value={`${fixed(odometry.position.x, 2)}, ${fixed(odometry.position.y, 2)}`} />
          <Readout label="Max range" value={`${fixed(lidar.rangeMaxM, 1)} m`} />
        </div>
      )}
    </GlassPanel>
  )
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <MicroLabel>{label}</MicroLabel>
      <div className="mt-0.5 font-mono text-[13px] text-ink-100">{value}</div>
    </div>
  )
}
