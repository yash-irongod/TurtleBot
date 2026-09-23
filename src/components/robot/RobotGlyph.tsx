interface RobotGlyphProps {
  size?: number
  className?: string
}

/**
 * A simplified top-down schematic of a TurtleBot3 Burger: circular chassis,
 * differential-drive side wheels, and a central LiDAR puck. Deliberately
 * schematic rather than illustrative — this is an instrument, not a mascot.
 */
export function RobotGlyph({ size = 52, className }: RobotGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className}>
      <circle cx="50" cy="50" r="35" className="fill-void-800/90 stroke-signal-400/70" strokeWidth={1.5} />
      <circle cx="50" cy="50" r="41" className="fill-none stroke-signal-400/15" strokeWidth={1} />

      <rect x="2" y="39" width="11" height="22" rx="3" className="fill-void-700 stroke-signal-400/40" strokeWidth={1} />
      <rect x="87" y="39" width="11" height="22" rx="3" className="fill-void-700 stroke-signal-400/40" strokeWidth={1} />

      <path d="M50 10 L43 23 L57 23 Z" className="fill-signal-400" />

      <circle cx="50" cy="50" r="12" className="fill-signal-900 stroke-signal-300/80" strokeWidth={1.5} />
      <circle cx="50" cy="50" r="3.2" className="fill-signal-300" />
    </svg>
  )
}
