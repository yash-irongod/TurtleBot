import clsx from 'clsx'
import { Shield, ShieldAlert, ShieldCheck, Pencil, Check, Crosshair, Plus, Minus } from 'lucide-react'
import { useRobot } from '../../context/RobotContext'
import { fixed } from '../../lib/format'

export function VirtualBoundaryControls({ compact = false }: { compact?: boolean }) {
  const {
    virtualBoundary,
    setVirtualBoundary,
    toggleVirtualBoundary,
    isEditingBoundary,
    setIsEditingBoundary,
    resetBoundaryAroundRobot,
    telemetry,
  } = useRobot()

  const { enabled, minX, maxX, minY, maxY, safetyMarginM } = virtualBoundary
  const widthM = Math.max(0.1, maxX - minX)
  const lengthM = Math.max(0.1, maxY - minY)

  // Calculate live proximity to table edges
  const rx = telemetry.odometry.position.x
  const ry = telemetry.odometry.position.y
  const distLeft = rx - minX
  const distRight = maxX - rx
  const distBottom = ry - minY
  const distTop = maxY - ry
  const minEdgeDist = Math.min(distLeft, distRight, distBottom, distTop)
  const isBreached = minEdgeDist <= 0.0
  const isNearEdge = !isBreached && minEdgeDist <= safetyMarginM

  const adjustWidth = (deltaM: number) => {
    const halfDelta = deltaM / 2
    const nextMinX = Number((minX - halfDelta).toFixed(2))
    const nextMaxX = Number((maxX + halfDelta).toFixed(2))
    if (nextMaxX - nextMinX >= 0.3) {
      setVirtualBoundary({
        ...virtualBoundary,
        minX: nextMinX,
        maxX: nextMaxX,
      })
    }
  }

  const adjustLength = (deltaM: number) => {
    const halfDelta = deltaM / 2
    const nextMinY = Number((minY - halfDelta).toFixed(2))
    const nextMaxY = Number((maxY + halfDelta).toFixed(2))
    if (nextMaxY - nextMinY >= 0.3) {
      setVirtualBoundary({
        ...virtualBoundary,
        minY: nextMinY,
        maxY: nextMaxY,
      })
    }
  }

  const adjustRotation = (deltaDeg: number) => {
    const curr = virtualBoundary.rotationDeg ?? 0
    const next = ((curr + deltaDeg) % 360 + 360) % 360
    setVirtualBoundary({
      ...virtualBoundary,
      rotationDeg: next,
    })
  }

  return (
    <div className={clsx(
      'flex flex-wrap items-center justify-between gap-1.5 border-t border-white/[0.06] bg-void-950/70 px-3 py-1.5 backdrop-blur-sm',
      compact && 'text-[10px]'
    )}>
      {/* Left: Table Safety Toggle & Edit Mode */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => toggleVirtualBoundary()}
          className={clsx(
            'flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition',
            enabled
              ? 'border-amber-400/50 bg-amber-500/20 text-amber-300 shadow-[0_0_12px_rgba(245,158,11,0.25)] hover:bg-amber-500/30'
              : 'border-white/[0.10] bg-white/[0.04] text-ink-400 hover:border-white/20 hover:text-ink-200'
          )}
          title={enabled ? 'Tabletop cliff protection is ACTIVE' : 'Click to ENABLE tabletop virtual boundary protection'}
        >
          {enabled ? (
            <>
              <ShieldCheck className="h-3.5 w-3.5 text-amber-400" />
              <span>Tabletop Safety ON</span>
            </>
          ) : (
            <>
              <Shield className="h-3.5 w-3.5 text-ink-500" />
              <span>Tabletop Safety OFF</span>
            </>
          )}
        </button>

        {enabled && (
          <button
            type="button"
            onClick={() => setIsEditingBoundary(!isEditingBoundary)}
            className={clsx(
              'flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition',
              isEditingBoundary
                ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-300'
                : 'border-white/[0.10] bg-white/[0.04] text-ink-300 hover:border-cyan-400/30 hover:text-cyan-200'
            )}
            title="Toggle interactive boundary drag handles on the map"
          >
            {isEditingBoundary ? (
              <>
                <Check className="h-3 w-3 text-cyan-400" />
                <span>Done Editing</span>
              </>
            ) : (
              <>
                <Pencil className="h-3 w-3" />
                <span>Edit Border</span>
              </>
            )}
          </button>
        )}

        {enabled && (
          <button
            type="button"
            onClick={() => resetBoundaryAroundRobot(1.2, 0.8)}
            className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-400 transition hover:border-white/20 hover:text-ink-200"
            title="Center 1.2m x 0.8m table boundary around robot's current position"
          >
            <Crosshair className="h-3 w-3" />
            <span className="hidden sm:inline">Fit to Robot</span>
          </button>
        )}
      </div>

      {/* Right: Live Proximity Badge & Dimensions */}
      {enabled && (
        <div className="flex items-center gap-2">
          {/* Edge Proximity Status */}
          <div
            className={clsx(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider',
              isBreached
                ? 'border-critical-500/60 bg-critical-500/20 text-critical-300 animate-pulse'
                : isNearEdge
                  ? 'border-amber-400/60 bg-amber-500/20 text-amber-300'
                  : 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
            )}
          >
            {isBreached ? (
              <>
                <ShieldAlert className="h-3 w-3 text-critical-400" />
                <span>AT EDGE (HALTED)</span>
              </>
            ) : isNearEdge ? (
              <>
                <ShieldAlert className="h-3 w-3 text-amber-400" />
                <span>Edge Near: {(minEdgeDist * 100).toFixed(0)}cm</span>
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span>Safe: {(minEdgeDist * 100).toFixed(0)}cm</span>
              </>
            )}
          </div>

          {/* Table Size Controls */}
          <div className="hidden lg:flex items-center gap-1.5 font-mono text-[9px] text-ink-400">
            <span className="text-ink-500">W:</span>
            <span className="text-ink-200">{fixed(widthM, 2)}m</span>
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => adjustWidth(-0.1)}
                className="rounded px-1 py-0.5 hover:bg-white/[0.08] hover:text-ink-100"
                title="Decrease table width by 10cm"
              >
                <Minus className="h-2.5 w-2.5" />
              </button>
              <button
                type="button"
                onClick={() => adjustWidth(0.1)}
                className="rounded px-1 py-0.5 hover:bg-white/[0.08] hover:text-ink-100"
                title="Increase table width by 10cm"
              >
                <Plus className="h-2.5 w-2.5" />
              </button>
            </div>

            <span className="text-ink-500 ml-1">L:</span>
            <span className="text-ink-200">{fixed(lengthM, 2)}m</span>
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => adjustLength(-0.1)}
                className="rounded px-1 py-0.5 hover:bg-white/[0.08] hover:text-ink-100"
                title="Decrease table length by 10cm"
              >
                <Minus className="h-2.5 w-2.5" />
              </button>
              <button
                type="button"
                onClick={() => adjustLength(0.1)}
                className="rounded px-1 py-0.5 hover:bg-white/[0.08] hover:text-ink-100"
                title="Increase table length by 10cm"
              >
                <Plus className="h-2.5 w-2.5" />
              </button>
            </div>

            <span className="text-ink-500 ml-1.5">Rot:</span>
            <span className="text-ink-200">{virtualBoundary.rotationDeg ?? 0}°</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => adjustRotation(-5)}
                className="rounded px-1 py-0.5 font-mono text-[8px] hover:bg-white/[0.08] hover:text-ink-100"
                title="Rotate counter-clockwise 5°"
              >
                -5°
              </button>
              <button
                type="button"
                onClick={() => adjustRotation(5)}
                className="rounded px-1 py-0.5 font-mono text-[8px] hover:bg-white/[0.08] hover:text-ink-100"
                title="Rotate clockwise 5°"
              >
                +5°
              </button>
              {(virtualBoundary.rotationDeg ?? 0) !== 0 && (
                <button
                  type="button"
                  onClick={() => setVirtualBoundary({ ...virtualBoundary, rotationDeg: 0 })}
                  className="rounded px-1 py-0.5 font-mono text-[8px] text-cyan-400 hover:bg-white/[0.08]"
                  title="Reset rotation to 0°"
                >
                  0°
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
