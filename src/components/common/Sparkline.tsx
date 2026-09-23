type SparkTone = 'signal' | 'amber' | 'critical'

const toneClasses: Record<SparkTone, { stroke: string; fill: string }> = {
  signal: { stroke: 'stroke-signal-400', fill: 'fill-signal-400' },
  amber: { stroke: 'stroke-amber-400', fill: 'fill-amber-400' },
  critical: { stroke: 'stroke-critical-400', fill: 'fill-critical-400' },
}

interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  tone?: SparkTone
  className?: string
}

/** A quiet inline trend line for a rolling window of telemetry samples. */
export function Sparkline({ values, width = 96, height = 28, tone = 'signal', className }: SparklineProps) {
  const t = toneClasses[tone]

  if (values.length < 2) {
    return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} />
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = width / (values.length - 1)
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(' ')
  const lastY = height - ((values[values.length - 1] - min) / range) * height

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className}>
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={t.stroke}
      />
      <circle cx={width} cy={lastY} r={2} className={t.fill} />
    </svg>
  )
}
