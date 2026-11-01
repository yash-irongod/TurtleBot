import { useCallback, useRef } from 'react'
import { useRobot } from '../../context/RobotContext'
import type { OccupancyGrid, Position2D, VirtualBoundary } from '../../types/robot'

interface VirtualBoundaryOverlayProps {
  grid: OccupancyGrid
  svgRef: React.RefObject<SVGSVGElement | null>
  cellPx?: number
  viewW?: number
  viewH?: number
  isTableFocused?: boolean
}

type HandleType = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'move' | 'rotate'

interface DragState {
  pointerId: number
  handle: HandleType
  startSvgPt: { x: number; y: number }
  startBoundary: VirtualBoundary
}

function worldToPx(pos: Position2D, grid: OccupancyGrid, cellPx: number) {
  return {
    x: ((pos.x - grid.origin.x) / grid.resolutionM) * cellPx,
    y: ((pos.y - grid.origin.y) / grid.resolutionM) * cellPx,
  }
}

function roundM(val: number): number {
  return Number(val.toFixed(2))
}

export function VirtualBoundaryOverlay({
  grid,
  svgRef,
  cellPx = 10,
  viewW: _viewW,
  viewH: _viewH,
  isTableFocused = false,
}: VirtualBoundaryOverlayProps) {
  const { virtualBoundary, setVirtualBoundary, isEditingBoundary } = useRobot()
  const dragStateRef = useRef<DragState | null>(null)

  const { enabled, minX, maxX, minY, maxY } = virtualBoundary
  const rotDeg = virtualBoundary.rotationDeg ?? 0

  const getSvgPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = svgRef.current
      if (!svg) return null
      const ctm = svg.getScreenCTM()
      if (!ctm) return null
      const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
      return { x: pt.x, y: pt.y }
    },
    [svgRef]
  )

  const processDrag = useCallback(
    (svgPt: { x: number; y: number }, state: DragState) => {
      const currWorldX = grid.origin.x + (svgPt.x / cellPx) * grid.resolutionM
      const currWorldY = grid.origin.y + (svgPt.y / cellPx) * grid.resolutionM
      const sb = state.startBoundary
      const minDimensionM = 0.3

      if (state.handle === 'rotate') {
        const cx = (sb.minX + sb.maxX) / 2
        const cy = (sb.minY + sb.maxY) / 2
        const dx = currWorldX - cx
        const dy = currWorldY - cy
        const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
        const normalizedDeg = Math.round(((deg % 360) + 360) % 360)
        setVirtualBoundary({
          ...sb,
          rotationDeg: normalizedDeg,
        })
        return
      }

      let nextMinX = sb.minX
      let nextMaxX = sb.maxX
      let nextMinY = sb.minY
      let nextMaxY = sb.maxY

      switch (state.handle) {
        case 'nw':
          nextMinX = Math.min(sb.maxX - minDimensionM, currWorldX)
          nextMinY = Math.min(sb.maxY - minDimensionM, currWorldY)
          break
        case 'ne':
          nextMaxX = Math.max(sb.minX + minDimensionM, currWorldX)
          nextMinY = Math.min(sb.maxY - minDimensionM, currWorldY)
          break
        case 'sw':
          nextMinX = Math.min(sb.maxX - minDimensionM, currWorldX)
          nextMaxY = Math.max(sb.minY + minDimensionM, currWorldY)
          break
        case 'se':
          nextMaxX = Math.max(sb.minX + minDimensionM, currWorldX)
          nextMaxY = Math.max(sb.minY + minDimensionM, currWorldY)
          break
        case 'n':
          nextMinY = Math.min(sb.maxY - minDimensionM, currWorldY)
          break
        case 's':
          nextMaxY = Math.max(sb.minY + minDimensionM, currWorldY)
          break
        case 'w':
          nextMinX = Math.min(sb.maxX - minDimensionM, currWorldX)
          break
        case 'e':
          nextMaxX = Math.max(sb.minX + minDimensionM, currWorldX)
          break
        case 'move': {
          const startWorldX = grid.origin.x + (state.startSvgPt.x / cellPx) * grid.resolutionM
          const startWorldY = grid.origin.y + (state.startSvgPt.y / cellPx) * grid.resolutionM
          const dx = currWorldX - startWorldX
          const dy = currWorldY - startWorldY
          nextMinX = sb.minX + dx
          nextMaxX = sb.maxX + dx
          nextMinY = sb.minY + dy
          nextMaxY = sb.maxY + dy
          break
        }
      }

      setVirtualBoundary({
        ...sb,
        minX: roundM(nextMinX),
        maxX: roundM(nextMaxX),
        minY: roundM(nextMinY),
        maxY: roundM(nextMaxY),
      })
    },
    [cellPx, grid.origin.x, grid.origin.y, grid.resolutionM, setVirtualBoundary]
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>, handle: HandleType) => {
      if (!isEditingBoundary) return
      e.preventDefault()
      e.stopPropagation()

      const svgPt = getSvgPoint(e.clientX, e.clientY)
      if (!svgPt) return

      const state: DragState = {
        pointerId: e.pointerId,
        handle,
        startSvgPt: svgPt,
        startBoundary: { ...virtualBoundary },
      }
      dragStateRef.current = state

      const onWindowPointerMove = (ev: PointerEvent) => {
        if (!dragStateRef.current || dragStateRef.current.pointerId !== ev.pointerId) return
        ev.preventDefault()
        const pt = getSvgPoint(ev.clientX, ev.clientY)
        if (pt) {
          processDrag(pt, dragStateRef.current)
        }
      }

      const onWindowPointerUp = (ev: PointerEvent) => {
        if (dragStateRef.current?.pointerId === ev.pointerId) {
          dragStateRef.current = null
          window.removeEventListener('pointermove', onWindowPointerMove)
          window.removeEventListener('pointerup', onWindowPointerUp)
          window.removeEventListener('pointercancel', onWindowPointerUp)
        }
      }

      window.addEventListener('pointermove', onWindowPointerMove)
      window.addEventListener('pointerup', onWindowPointerUp)
      window.addEventListener('pointercancel', onWindowPointerUp)
    },
    [getSvgPoint, isEditingBoundary, processDrag, virtualBoundary]
  )

  if (!enabled) return null

  // Calculate table bounding box in SVG pixels
  const p1 = worldToPx({ x: minX, y: minY }, grid, cellPx)
  const p2 = worldToPx({ x: maxX, y: maxY }, grid, cellPx)
  const x = Math.min(p1.x, p2.x)
  const y = Math.min(p1.y, p2.y)
  const w = Math.max(4, Math.abs(p2.x - p1.x))
  const h = Math.max(4, Math.abs(p2.y - p1.y))
  const cx = x + w / 2
  const cy = y + h / 2

  const widthM = maxX - minX
  const lengthM = maxY - minY

  // Corner bracket size
  const cornerLen = Math.min(16, Math.max(6, Math.min(w, h) * 0.25))

  // Rotate only when NOT already focused/rotated by the zoomed container
  const tableTransform = !isTableFocused && rotDeg !== 0 ? `rotate(${rotDeg} ${cx.toFixed(1)} ${cy.toFixed(1)})` : undefined

  return (
    <g className="virtual-boundary-layer" aria-label="Tabletop virtual boundary">
      {/* Table Element Group (rotates with tabletop orientation) */}
      <g transform={tableTransform}>
        {/* 1. Outer Table Edge Perimeter */}
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={3}
          fill="rgba(245, 158, 11, 0.04)"
          className="stroke-amber-400/90"
          strokeWidth={1.8}
          strokeDasharray={isEditingBoundary ? '6 4' : '8 5'}
          pointerEvents="none"
        />

        {/* 2. Corner Accent Brackets */}
        <g pointerEvents="none" className="stroke-amber-400" strokeWidth={2.5} strokeLinecap="round">
          {/* Top-Left */}
          <line x1={x} y1={y} x2={x + cornerLen} y2={y} />
          <line x1={x} y1={y} x2={x} y2={y + cornerLen} />
          {/* Top-Right */}
          <line x1={x + w} y1={y} x2={x + w - cornerLen} y2={y} />
          <line x1={x + w} y1={y} x2={x + w} y2={y + cornerLen} />
          {/* Bottom-Left */}
          <line x1={x} y1={y + h} x2={x + cornerLen} y2={y + h} />
          <line x1={x} y1={y + h} x2={x} y2={y + h - cornerLen} />
          {/* Bottom-Right */}
          <line x1={x + w} y1={y + h} x2={x + w - cornerLen} y2={y + h} />
          <line x1={x + w} y1={y + h} x2={x + w} y2={y + h - cornerLen} />
        </g>

        {/* 3. Table Dimensions & Header Badge */}
        <g pointerEvents="none" transform={`translate(${x + 6}, ${Math.max(14, y - 6)})`}>
          <rect
            x={-2}
            y={-11}
            width={Math.min(w - 8, rotDeg !== 0 ? 175 : 140)}
            height={15}
            rx={3}
            className="fill-void-950/90 stroke-amber-400/50"
            strokeWidth={0.8}
          />
          <text
            x={4}
            y={0}
            className="fill-amber-300 font-mono text-[8px] font-bold uppercase tracking-wider"
          >
            TABLE · {widthM.toFixed(2)}m × {lengthM.toFixed(2)}m{rotDeg !== 0 ? ` · ${rotDeg}°` : ''}
          </text>
        </g>

        {/* 4. Interactive Drag Handles (Rendered only when isEditingBoundary is true) */}
        {isEditingBoundary && (
          <g className="boundary-drag-handles">
            {/* Center Move Handle */}
            <g
              transform={`translate(${cx}, ${cy})`}
              className="cursor-move group"
              onPointerDown={(e) => handlePointerDown(e, 'move')}
            >
              {/* Generous invisible hit target */}
              <circle r={24} fill="transparent" />
              <circle
                r={16}
                className="fill-void-950/95 stroke-cyan-400 group-hover:stroke-cyan-200 transition-colors shadow-lg"
                strokeWidth={2}
              />
              <path
                d="M 0 -8 L 3 -5 L 1 -5 L 1 -1 L 5 -1 L 5 -3 L 8 0 L 5 3 L 5 1 L 1 1 L 1 5 L 3 5 L 0 8 L -3 5 L -1 5 L -1 1 L -5 1 L -5 3 L -8 0 L -5 -3 L -5 -1 L -1 -1 L -1 -5 L -3 -5 Z"
                className="fill-cyan-300 pointer-events-none"
              />
              <text
                y={24}
                textAnchor="middle"
                className="fill-cyan-300 font-mono text-[8px] font-bold uppercase tracking-wider drop-shadow-md select-none pointer-events-none"
              >
                Move Table
              </text>
            </g>

            {/* Rotation Handle (Stem + Top Circular Handle) */}
            <line
              x1={cx}
              y1={y}
              x2={cx}
              y2={y - 24}
              className="stroke-cyan-400/80 pointer-events-none"
              strokeWidth={1.5}
              strokeDasharray="3 2"
            />
            <g
              transform={`translate(${cx}, ${y - 24})`}
              className="cursor-grab active:cursor-grabbing group"
              onPointerDown={(e) => handlePointerDown(e, 'rotate')}
            >
              <circle r={16} fill="transparent" />
              <circle r={8} className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 shadow-md transition-colors" strokeWidth={2} />
              <circle r={3} className="fill-cyan-300 pointer-events-none" />
              <text
                y={-11}
                textAnchor="middle"
                className="fill-cyan-300 font-mono text-[7px] font-bold uppercase tracking-wider pointer-events-none"
              >
                Rotate ({rotDeg}°)
              </text>
            </g>

            {/* 4 Corner Handles */}
            {/* NW */}
            <g onPointerDown={(e) => handlePointerDown(e, 'nw')} className="cursor-nwse-resize group">
              <circle cx={x} cy={y} r={16} fill="transparent" />
              <circle
                cx={x}
                cy={y}
                r={7}
                className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 shadow-md transition-colors"
                strokeWidth={2}
              />
              <circle cx={x} cy={y} r={2.5} className="fill-cyan-300 pointer-events-none" />
            </g>

            {/* NE */}
            <g onPointerDown={(e) => handlePointerDown(e, 'ne')} className="cursor-nesw-resize group">
              <circle cx={x + w} cy={y} r={16} fill="transparent" />
              <circle
                cx={x + w}
                cy={y}
                r={7}
                className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 shadow-md transition-colors"
                strokeWidth={2}
              />
              <circle cx={x + w} cy={y} r={2.5} className="fill-cyan-300 pointer-events-none" />
            </g>

            {/* SW */}
            <g onPointerDown={(e) => handlePointerDown(e, 'sw')} className="cursor-nesw-resize group">
              <circle cx={x} cy={y + h} r={16} fill="transparent" />
              <circle
                cx={x}
                cy={y + h}
                r={7}
                className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 shadow-md transition-colors"
                strokeWidth={2}
              />
              <circle cx={x} cy={y + h} r={2.5} className="fill-cyan-300 pointer-events-none" />
            </g>

            {/* SE */}
            <g onPointerDown={(e) => handlePointerDown(e, 'se')} className="cursor-nwse-resize group">
              <circle cx={x + w} cy={y + h} r={16} fill="transparent" />
              <circle
                cx={x + w}
                cy={y + h}
                r={7}
                className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 shadow-md transition-colors"
                strokeWidth={2}
              />
              <circle cx={x + w} cy={y + h} r={2.5} className="fill-cyan-300 pointer-events-none" />
            </g>

            {/* 4 Edge Midpoint Handles */}
            {/* N */}
            <g onPointerDown={(e) => handlePointerDown(e, 'n')} className="cursor-ns-resize group">
              <rect x={cx - 16} y={y - 10} width={32} height={20} fill="transparent" />
              <rect
                x={cx - 8}
                y={y - 4}
                width={16}
                height={8}
                rx={2}
                className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 transition-colors"
                strokeWidth={1.8}
              />
            </g>

            {/* S */}
            <g onPointerDown={(e) => handlePointerDown(e, 's')} className="cursor-ns-resize group">
              <rect x={cx - 16} y={y + h - 10} width={32} height={20} fill="transparent" />
              <rect
                x={cx - 8}
                y={y + h - 4}
                width={16}
                height={8}
                rx={2}
                className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 transition-colors"
                strokeWidth={1.8}
              />
            </g>

            {/* W */}
            <g onPointerDown={(e) => handlePointerDown(e, 'w')} className="cursor-ew-resize group">
              <rect x={x - 10} y={cy - 16} width={20} height={32} fill="transparent" />
              <rect
                x={x - 4}
                y={cy - 8}
                width={8}
                height={16}
                rx={2}
                className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 transition-colors"
                strokeWidth={1.8}
              />
            </g>

            {/* E */}
            <g onPointerDown={(e) => handlePointerDown(e, 'e')} className="cursor-ew-resize group">
              <rect x={x + w - 10} y={cy - 16} width={20} height={32} fill="transparent" />
              <rect
                x={x + w - 4}
                y={cy - 8}
                width={8}
                height={16}
                rx={2}
                className="fill-void-950 stroke-cyan-400 group-hover:stroke-cyan-200 transition-colors"
                strokeWidth={1.8}
              />
            </g>
          </g>
        )}
      </g>
    </g>
  )
}
