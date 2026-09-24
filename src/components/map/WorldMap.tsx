import clsx from 'clsx'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { useRobot } from '../../context/RobotContext'
import { demoOccupancyGrid } from '../../data/mapGrid'
import { fixed } from '../../lib/format'
import { GlassPanel } from '../common/GlassPanel'
import { MicroLabel } from '../common/MicroLabel'
import { RobotGlyph } from '../robot/RobotGlyph'
import type { DataEnvironment, NavigationState, OccupancyGrid, Position2D } from '../../types/robot'

const CELL_PX = 10

function createEmptyOccupancyGrid(): OccupancyGrid {
  return {
    widthCells: 60,
    heightCells: 40,
    resolutionM: 0.12,
    origin: { x: -3.6, y: -2.4 },
    cells: new Array(60 * 40).fill('unknown'),
  }
}

const NAVIGATION_LABEL: Record<NavigationState, string> = {
  IDLE: 'Idle',
  LOCALIZING: 'Localizing',
  READY: 'Ready',
  PLANNING: 'Planning',
  NAVIGATING: 'Navigating',
  PAUSED: 'Paused',
  CANCELING: 'Canceling',
  GOAL_REACHED: 'Goal reached',
  FAILED: 'Route failed',
  CANCELED: 'Route canceled',
}

const SOURCE_COPY: Record<DataEnvironment, { label: string; compactLabel: string; className: string }> = {
  demo: {
    label: 'DEMO · SIMULATED MAP',
    compactLabel: 'DEMO MAP',
    className: 'border-ink-500/35 bg-void-950/80 text-ink-300',
  },
  live: {
    label: 'LIVE · ROS MAP',
    compactLabel: 'LIVE MAP',
    className: 'border-signal-400/35 bg-signal-900/45 text-signal-300',
  },
  offline: {
    label: 'MAP FEED OFFLINE',
    compactLabel: 'MAP OFFLINE',
    className: 'border-critical-500/40 bg-critical-500/[0.08] text-critical-400',
  },
}

function worldToPx(pos: Position2D, grid: OccupancyGrid) {
  return {
    x: ((pos.x - grid.origin.x) / grid.resolutionM) * CELL_PX,
    y: ((pos.y - grid.origin.y) / grid.resolutionM) * CELL_PX,
  }
}

/** Converts a screen pointer to the centre of a valid occupancy-grid cell. */
function screenToGridPosition(svg: SVGSVGElement, clientX: number, clientY: number, grid: OccupancyGrid): Position2D | null {
  const matrix = svg.getScreenCTM()
  if (!matrix) return null

  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
  const col = Math.floor(point.x / CELL_PX)
  const row = Math.floor(point.y / CELL_PX)
  if (col < 0 || col >= grid.widthCells || row < 0 || row >= grid.heightCells) return null

  return {
    x: grid.origin.x + (col + 0.5) * grid.resolutionM,
    y: grid.origin.y + (row + 0.5) * grid.resolutionM,
  }
}

function cellStateAt(position: Position2D, grid: OccupancyGrid) {
  const col = Math.floor((position.x - grid.origin.x) / grid.resolutionM)
  const row = Math.floor((position.y - grid.origin.y) / grid.resolutionM)
  if (col < 0 || col >= grid.widthCells || row < 0 || row >= grid.heightCells) return null
  return grid.cells[row * grid.widthCells + col]
}

function isFreeGoalPosition(position: Position2D, grid: OccupancyGrid) {
  return cellStateAt(position, grid) === 'free'
}

/**
 * A world-frame occupancy-grid renderer. DEMO geometry is deliberately kept
 * separate from pose, goal, and path overlays; LIVE rendering uses the ROS /map
 * payload and an explicit unknown grid while that feed is unavailable.
 */
export interface WorldMapProps {
  compact?: boolean
  variant?: 'standard' | 'compact' | 'minimap'
  className?: string
  onToggleMaximize?: () => void
}

export function WorldMap({ compact = false, variant = 'standard', className, onToggleMaximize }: WorldMapProps) {
  const isMinimap = variant === 'minimap'
  const isCompact = compact || isMinimap
  const { telemetry, navigation, environment, canEditMapGoal, setGoalAt, sourceStatus, liveOccupancyGrid, exploration } = useRobot()
  const isLive = sourceStatus === 'LIVE'
  const isAwaitingLiveMap = isLive && !liveOccupancyGrid
  const emptyLiveGrid = useMemo(() => createEmptyOccupancyGrid(), [])
  const grid = isLive && !liveOccupancyGrid ? emptyLiveGrid : (liveOccupancyGrid ?? demoOccupancyGrid)
  const instanceId = useId().replace(/:/g, '')
  const glowId = `${instanceId}-map-glow`
  const gridPatternId = `${instanceId}-map-grid`
  const titleId = `${instanceId}-map-title`
  const goalInteractionHintId = `${instanceId}-goal-help`
  const svgRef = useRef<SVGSVGElement>(null)
  const dragPointerIdRef = useRef<number | null>(null)
  const draftGoalRef = useRef<Position2D | null>(null)
  const previewFrameRef = useRef<number | null>(null)
  const [draftGoal, setDraftGoal] = useState<Position2D | null>(null)
  const [draggingGoal, setDraggingGoal] = useState(false)
  const [goalEditNotice, setGoalEditNotice] = useState<string | null>(null)

  const viewW = grid.widthCells * CELL_PX
  const viewH = grid.heightCells * CELL_PX
  const robotPx = worldToPx(telemetry.odometry.position, grid)
  const displayedGoalPosition = draftGoal ?? navigation.goal?.position ?? null
  const goalPx = displayedGoalPosition ? worldToPx(displayedGoalPosition, grid) : null
  const frontierPx = exploration?.selectedFrontier ? worldToPx(exploration.selectedFrontier, grid) : null
  const source = SOURCE_COPY[environment]
  const progress = Math.max(0, Math.min(100, navigation.progressPct))
  const goalLabel = navigation.goal?.label ?? 'Map target'

  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current)
    },
    [],
  )

  const mapPositionFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current
      return svg ? screenToGridPosition(svg, clientX, clientY, grid) : null
    },
    [grid],
  )

  const queueGoalPreview = useCallback((position: Position2D) => {
    draftGoalRef.current = position
    if (previewFrameRef.current !== null) return

    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null
      if (draftGoalRef.current) setDraftGoal({ ...draftGoalRef.current })
    })
  }, [])

  const showInvalidGoalNotice = useCallback(() => {
    setGoalEditNotice((current) =>
      current ?? (isLive ? 'Choose a mapped free cell for the live goal.' : 'Choose a mapped free cell for the demo goal.'),
    )
  }, [isLive])

  const handleMapClick = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      if (!canEditMapGoal) return
      const position = mapPositionFromClient(event.clientX, event.clientY)
      if (!position || !isFreeGoalPosition(position, grid)) {
        showInvalidGoalNotice()
        return
      }

      setGoalEditNotice(
        isLive
          ? 'Live target updated — press Start to run the new route.'
          : 'Demo target updated — press Start to run the new route.',
      )
      setGoalAt(position)
    },
    [canEditMapGoal, grid, mapPositionFromClient, setGoalAt, showInvalidGoalNotice, isLive],
  )

  const handleGoalPointerDown = useCallback(
    (event: PointerEvent<SVGGElement>) => {
      if (!canEditMapGoal || !navigation.goal) return
      event.preventDefault()
      event.stopPropagation()
      dragPointerIdRef.current = event.pointerId
      event.currentTarget.setPointerCapture(event.pointerId)
      draftGoalRef.current = { ...navigation.goal.position }
      setDraftGoal({ ...navigation.goal.position })
      setDraggingGoal(true)
      setGoalEditNotice(null)
    },
    [canEditMapGoal, navigation.goal],
  )

  const handleGoalPointerMove = useCallback(
    (event: PointerEvent<SVGGElement>) => {
      if (dragPointerIdRef.current !== event.pointerId) return
      const position = mapPositionFromClient(event.clientX, event.clientY)
      if (!position || !isFreeGoalPosition(position, grid)) {
        showInvalidGoalNotice()
        return
      }
      setGoalEditNotice(null)
      queueGoalPreview(position)
    },
    [grid, mapPositionFromClient, queueGoalPreview, showInvalidGoalNotice],
  )

  const finishGoalDrag = useCallback(
    (event: PointerEvent<SVGGElement>, commit: boolean) => {
      if (dragPointerIdRef.current !== event.pointerId) return

      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      dragPointerIdRef.current = null
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current)
        previewFrameRef.current = null
      }

      const pointerPosition = mapPositionFromClient(event.clientX, event.clientY)
      const finalPosition =
        pointerPosition && isFreeGoalPosition(pointerPosition, grid) ? pointerPosition : draftGoalRef.current

      draftGoalRef.current = null
      setDraftGoal(null)
      setDraggingGoal(false)

      if (!commit || !finalPosition) return
      setGoalEditNotice(
        isLive
          ? 'Live target repositioned — press Start to run the new route.'
          : 'Demo target repositioned — press Start to run the new route.',
      )
      setGoalAt(finalPosition)
    },
    [grid, mapPositionFromClient, setGoalAt, isLive],
  )

  const handleGoalKeyDown = useCallback(
    (event: KeyboardEvent<SVGGElement>) => {
      if (!canEditMapGoal || !displayedGoalPosition) return
      const move = grid.resolutionM
      let nextPosition: Position2D | null = null

      switch (event.key) {
        case 'ArrowUp':
          nextPosition = { ...displayedGoalPosition, y: displayedGoalPosition.y - move }
          break
        case 'ArrowDown':
          nextPosition = { ...displayedGoalPosition, y: displayedGoalPosition.y + move }
          break
        case 'ArrowLeft':
          nextPosition = { ...displayedGoalPosition, x: displayedGoalPosition.x - move }
          break
        case 'ArrowRight':
          nextPosition = { ...displayedGoalPosition, x: displayedGoalPosition.x + move }
          break
        default:
          return
      }

      event.preventDefault()
      if (!isFreeGoalPosition(nextPosition, grid)) {
        showInvalidGoalNotice()
        return
      }
      setGoalEditNotice(
        isLive
          ? 'Live target repositioned — press Start to run the new route.'
          : 'Demo target repositioned — press Start to run the new route.',
      )
      setGoalAt(nextPosition)
    },
    [canEditMapGoal, displayedGoalPosition, grid, setGoalAt, showInvalidGoalNotice, isLive],
  )

  const pathD = useMemo(() => {
    const pathPx = navigation.path.map((point) => worldToPx(point, grid))
    return pathPx.length > 1 ? `M ${pathPx.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')}` : ''
  }, [grid, navigation.path])

  const mapImageUrl = useMemo(() => {
    if (typeof document === 'undefined' || grid.widthCells <= 0 || grid.heightCells <= 0) return null
    if (grid.cells.length <= 2500) return null // Use crisp SVG rects for demo map
    const canvas = document.createElement('canvas')
    canvas.width = grid.widthCells
    canvas.height = grid.heightCells
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const imgData = ctx.createImageData(grid.widthCells, grid.heightCells)
    const d = imgData.data
    for (let i = 0; i < grid.cells.length; i++) {
      const cell = grid.cells[i]
      const pxIdx = i * 4
      if (cell === 'occupied') {
        d[pxIdx] = 13
        d[pxIdx + 1] = 148
        d[pxIdx + 2] = 136
        d[pxIdx + 3] = 230
      } else if (cell === 'unknown') {
        d[pxIdx] = 15
        d[pxIdx + 1] = 23
        d[pxIdx + 2] = 42
        d[pxIdx + 3] = 120
      }
    }
    ctx.putImageData(imgData, 0, 0)
    return canvas.toDataURL()
  }, [grid])

  const cellRects = useMemo(
    () => {
      if (mapImageUrl) return null
      return grid.cells.map((state, index) => {
        if (state === 'free') return null
        const col = index % grid.widthCells
        const row = Math.floor(index / grid.widthCells)
        return (
          <rect
            key={index}
            x={col * CELL_PX}
            y={row * CELL_PX}
            width={CELL_PX - 0.6}
            height={CELL_PX - 0.6}
            className={state === 'occupied' ? 'fill-signal-900 stroke-signal-400/35' : 'fill-ink-500/[0.09]'}
            strokeWidth={state === 'occupied' ? 0.5 : 0}
          />
        )
      })
    },
    [grid, mapImageUrl],
  )

  const mapDescription = [
    environment === 'demo' ? 'Demo occupancy map generated in the browser.' : source.label,
    `Navigation ${NAVIGATION_LABEL[navigation.navigationState]}.`,
    displayedGoalPosition
      ? `Goal ${goalLabel} at x ${fixed(displayedGoalPosition.x, 2)}, y ${fixed(displayedGoalPosition.y, 2)} metres.`
      : 'No goal assigned.',
    `Robot pose x ${fixed(telemetry.odometry.position.x, 2)}, y ${fixed(telemetry.odometry.position.y, 2)} metres.`,
  ].join(' ')

  const goalEditHint =
    goalEditNotice ??
    (navigation.goal
      ? 'Click a free cell to replace the target · drag the target to move it'
      : isLive
        ? 'Click a free cell to place a live target'
        : 'Click a free cell to place a demo target')

  return (
    <GlassPanel
      corners
      className={clsx(
        'relative flex h-full flex-col overflow-hidden !p-0',
        isMinimap ? 'min-h-0 border-signal-400/30 bg-void-950/90 shadow-2xl backdrop-blur-md' : 'min-h-[260px]',
        className,
      )}
    >
      <div className={clsx('flex items-center justify-between gap-2', isMinimap ? 'px-2.5 pt-2 pb-1' : isCompact ? 'px-3 pt-3' : 'px-5 pt-4')}>
        <div className="min-w-0">
          <MicroLabel>{isMinimap ? 'Minimap' : isCompact ? 'Map / world' : 'World map / map frame'}</MicroLabel>
          {!isCompact && <div className="mt-0.5 text-[11px] text-ink-500">Occupancy, route, goal, and robot pose</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canEditMapGoal && (
            <span
              className={clsx(
                'rounded-full border border-signal-400/20 bg-signal-900/20 font-mono uppercase tracking-[0.08em] text-signal-300',
                isMinimap ? 'px-1.5 py-0.5 text-[8px]' : 'hidden px-2 py-1 text-[9px] lg:inline-flex',
              )}
              title={goalEditHint}
            >
              {isMinimap ? 'Drag Goal' : 'Click map · drag goal'}
            </span>
          )}
          {!isMinimap && (
            <span className={clsx('rounded-full border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em]', source.className)}>
              {compact ? source.compactLabel : source.label}
            </span>
          )}
          {isMinimap && onToggleMaximize && (
            <button
              type="button"
              onClick={onToggleMaximize}
              className="rounded p-1 text-ink-400 hover:bg-white/[0.08] hover:text-ink-100"
              title="Expand 2D map"
              aria-label="Expand 2D map"
            >
              <span className="font-mono text-[10px]">↗</span>
            </button>
          )}
        </div>
      </div>

      <div className={clsx('relative flex min-h-0 flex-1 items-center justify-center', isMinimap ? 'p-1 pb-2' : compact ? 'p-2' : 'px-4 pb-4 pt-3')}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${viewW} ${viewH}`}
          preserveAspectRatio="xMidYMid meet"
          className={clsx('h-full w-full', canEditMapGoal && 'cursor-crosshair')}
          role={canEditMapGoal ? 'group' : 'img'}
          aria-label={canEditMapGoal ? (isLive ? 'Interactive live occupancy map' : 'Interactive demo occupancy map') : undefined}
          aria-labelledby={canEditMapGoal ? undefined : titleId}
          aria-describedby={canEditMapGoal ? goalInteractionHintId : undefined}
          onClick={handleMapClick}
        >
          <title id={titleId}>{mapDescription}</title>
          <defs>
            <radialGradient id={glowId} cx="50%" cy="50%" r="74%">
              <stop offset="0%" stopColor="#0F2C3D" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#04060A" stopOpacity="0" />
            </radialGradient>
            <pattern id={gridPatternId} width={CELL_PX * 5} height={CELL_PX * 5} patternUnits="userSpaceOnUse">
              <path
                d={`M ${CELL_PX * 5} 0 L 0 0 0 ${CELL_PX * 5}`}
                className="fill-none stroke-signal-400/[0.07]"
                strokeWidth="0.75"
              />
            </pattern>
          </defs>

          <rect x={0} y={0} width={viewW} height={viewH} className="fill-void-950" />
          <rect x={0} y={0} width={viewW} height={viewH} fill={`url(#${glowId})`} />
          <rect x={0} y={0} width={viewW} height={viewH} fill={`url(#${gridPatternId})`} />
          {mapImageUrl ? (
            <image
              href={mapImageUrl}
              x={0}
              y={0}
              width={viewW}
              height={viewH}
              preserveAspectRatio="none"
              style={{ imageRendering: 'pixelated' }}
            />
          ) : (
            cellRects
          )}

          <line x1={viewW / 2} y1={0} x2={viewW / 2} y2={viewH} className="stroke-signal-400/[0.10]" strokeWidth={1} />
          <line x1={0} y1={viewH / 2} x2={viewW} y2={viewH} className="stroke-signal-400/[0.10]" strokeWidth={1} />
          <text x={10} y={18} className="fill-ink-500 font-mono text-[9px] tracking-[0.16em]">
            MAP
          </text>
          <text x={viewW - 28} y={18} className="fill-ink-500 font-mono text-[9px] tracking-[0.16em]">
            N
          </text>

          {pathD && (
            <>
              <path d={pathD} className="fill-none stroke-signal-900" strokeWidth={5} strokeLinecap="round" />
              <path
                d={pathD}
                className="fill-none stroke-signal-300"
                strokeWidth={1.7}
                strokeDasharray="2 5"
                strokeLinecap="round"
              />
            </>
          )}

          {frontierPx && (
            <g transform={`translate(${frontierPx.x} ${frontierPx.y})`} aria-label="Frontier target">
              <circle cx={0} cy={0} r={16} className="fill-signal-400/[0.12] stroke-signal-400/60" strokeWidth={1} />
              <polygon points="0,-8 8,0 0,8 -8,0" className="fill-signal-400/35 stroke-signal-300" strokeWidth={1.5} />
              <circle cx={0} cy={0} r={2.5} className="fill-signal-200" />
              <text x={0} y={-12} textAnchor="middle" className="fill-signal-300 font-mono text-[8px] uppercase tracking-wider font-semibold">
                FRONTIER
              </text>
            </g>
          )}

          {isAwaitingLiveMap && (
            <g transform={`translate(${viewW / 2} ${viewH / 2})`} aria-label="Awaiting ROS map">
              <circle r={36} className="fill-signal-950/70 stroke-signal-400/30" strokeWidth={1} strokeDasharray="4 4" />
              <circle r={18} className="fill-none stroke-signal-400/50" strokeWidth={1} />
              <text y={46} textAnchor="middle" className="fill-signal-400 font-mono text-[9px] uppercase tracking-wider">
                Awaiting /map stream...
              </text>
            </g>
          )}

          {goalPx && (
            <g
              className={clsx('map-goal-handle', canEditMapGoal && 'cursor-grab')}
              aria-label={
                canEditMapGoal
                  ? `${goalLabel}. Drag to move the ${isLive ? 'live' : 'demo'} target, or use arrow keys to move one map cell.`
                  : `Goal ${goalLabel}`
              }
              role={canEditMapGoal ? 'button' : undefined}
              tabIndex={canEditMapGoal ? 0 : undefined}
              onPointerDown={canEditMapGoal ? handleGoalPointerDown : undefined}
              onPointerMove={canEditMapGoal ? handleGoalPointerMove : undefined}
              onPointerUp={canEditMapGoal ? (event) => finishGoalDrag(event, true) : undefined}
              onPointerCancel={canEditMapGoal ? (event) => finishGoalDrag(event, false) : undefined}
              onLostPointerCapture={canEditMapGoal ? (event) => finishGoalDrag(event, false) : undefined}
              onKeyDown={canEditMapGoal ? handleGoalKeyDown : undefined}
              onClick={(event) => event.stopPropagation()}
            >
              {/* Concentric radar rings matching user photo */}
              <circle cx={goalPx.x} cy={goalPx.y} r={18} className="fill-critical-500/[0.06] stroke-critical-500/30" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={goalPx.x} cy={goalPx.y} r={12} className="fill-critical-500/[0.10] stroke-critical-500/60" strokeWidth={1.2} />
              <circle cx={goalPx.x} cy={goalPx.y} r={4} className="fill-critical-400 stroke-white" strokeWidth={0.8} />

              {/* Glowing Red Warning Triangle (⚠️) */}
              <g transform={`translate(${goalPx.x} ${goalPx.y - 14})`}>
                <polygon
                  points="0,-9 8,5 -8,5"
                  className="fill-critical-500/25 stroke-critical-500 drop-shadow-[0_0_8px_rgba(255,23,68,0.85)]"
                  strokeWidth={1.8}
                  strokeLinejoin="round"
                />
                {/* Exclamation mark */}
                <line x1={0} y1={-4.5} x2={0} y2={-0.5} className="stroke-white" strokeWidth={1.4} strokeLinecap="round" />
                <circle cx={0} cy={2.4} r={0.8} className="fill-white" />
              </g>
            </g>
          )}

          <g transform={`translate(${robotPx.x} ${robotPx.y})`} aria-label="Current robot position">
            <circle r={19} className="fill-signal-500/[0.10] stroke-signal-400/25" strokeWidth={1} />
            <circle r={13} className="fill-void-950/70" />
            <g transform={`rotate(${telemetry.odometry.headingDeg}) translate(-13 -13)`}>
              <RobotGlyph size={26} />
            </g>
          </g>
        </svg>

        {!isMinimap && (
          <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex flex-wrap items-end justify-between gap-2">
            <div className="rounded-md border border-white/[0.08] bg-void-950/85 px-2.5 py-1.5 backdrop-blur-sm">
              <MicroLabel>Pose / map</MicroLabel>
              <div className="mt-0.5 font-mono text-[11px] text-ink-100">
                X {fixed(telemetry.odometry.position.x, 2)} · Y {fixed(telemetry.odometry.position.y, 2)} m
              </div>
            </div>
            <div className="rounded-md border border-white/[0.08] bg-void-950/85 px-2.5 py-1.5 text-right backdrop-blur-sm">
              <MicroLabel>{displayedGoalPosition ? (draggingGoal ? 'Editing target' : 'Route') : 'Map resolution'}</MicroLabel>
              <div className="mt-0.5 font-mono text-[11px] text-ink-100">
                {displayedGoalPosition
                  ? draggingGoal
                    ? `${fixed(displayedGoalPosition.x, 2)} · ${fixed(displayedGoalPosition.y, 2)} m`
                    : `${Math.round(progress)}% · ${NAVIGATION_LABEL[navigation.navigationState]}`
                  : `${fixed(grid.resolutionM, 2)} m / cell`}
              </div>
            </div>
          </div>
        )}
      </div>

      {canEditMapGoal && (
        <p id={goalInteractionHintId} className="sr-only" aria-live="polite">
          {goalEditHint}. Only free cells accept a {isLive ? 'live' : 'demo'} goal.
          {isLive
            ? ' Moving a target replaces the current goal and requires Start.'
            : ' Moving a target returns demo navigation to Ready and requires Start.'}
        </p>
      )}
    </GlassPanel>
  )
}
