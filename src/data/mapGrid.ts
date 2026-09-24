import type { CellState, OccupancyGrid, Position2D } from '../types/robot'

/**
 * A hand-built demo occupancy grid standing in for a real accumulated
 * /map (nav_msgs/OccupancyGrid). Shaped exactly like the real thing
 * (width/height/resolution/origin/cells) so a real grid can drop straight
 * into WorldMap later without changing the renderer — see RobotDataSource
 * for the same seam applied to telemetry.
 *
 * Room bounds mirror the robot's mock odometry range so the demo path stays
 * inside the mapped area.
 */

const RESOLUTION_M = 0.12
const WORLD = { xMin: -3.6, xMax: 3.6, yMin: -2.4, yMax: 2.4 }

// Sparse, realistic disaster items (matching user specification: fallen drum, slabs, cone, tilted pipe)
export interface DemoObstacleItem {
  id: string
  type: 'fallen_drum' | 'slab' | 'cone' | 'tilted_pipe' | 'upright_drum'
  x: number
  y: number
  radius: number
  label: string
}

export const DEMO_OBSTACLE_ITEMS: DemoObstacleItem[] = [
  { id: 'obs-fallen-drum', type: 'fallen_drum', x: -1.3, y: -0.7, radius: 0.26, label: 'Fallen Hazmat Drum' },
  { id: 'obs-slab-1', type: 'slab', x: 1.3, y: -0.8, radius: 0.36, label: 'Shattered Slab & Rebar' },
  { id: 'obs-cone', type: 'cone', x: 0.8, y: 1.2, radius: 0.22, label: 'Safety Cones' },
  { id: 'obs-tilted-pipe', type: 'tilted_pipe', x: -1.4, y: 0.9, radius: 0.32, label: 'Tilted Drainage Pipe' },
  { id: 'obs-upright-drum', type: 'upright_drum', x: 0.3, y: -1.5, radius: 0.24, label: 'Weathered Fuel Drum' },
  { id: 'obs-slab-2', type: 'slab', x: -0.8, y: 1.4, radius: 0.30, label: 'Concrete Foundation Debris' },
]

const WIDTH_CELLS = Math.round((WORLD.xMax - WORLD.xMin) / RESOLUTION_M)
const HEIGHT_CELLS = Math.round((WORLD.yMax - WORLD.yMin) / RESOLUTION_M)
const ORIGIN: Position2D = { x: WORLD.xMin, y: WORLD.yMin }

function worldToCell(pos: Position2D) {
  return {
    col: Math.round((pos.x - ORIGIN.x) / RESOLUTION_M),
    row: Math.round((pos.y - ORIGIN.y) / RESOLUTION_M),
  }
}

function buildDemoGrid(): OccupancyGrid {
  const cells: CellState[] = new Array(WIDTH_CELLS * HEIGHT_CELLS).fill('free')
  const at = (row: number, col: number) => row * WIDTH_CELLS + col

  // 1. Mark cells occupied for the few distinct disaster items
  for (const item of DEMO_OBSTACLE_ITEMS) {
    const centerCell = worldToCell({ x: item.x, y: item.y })
    const rCells = Math.max(1, Math.round(item.radius / RESOLUTION_M))
    for (let dr = -rCells; dr <= rCells; dr++) {
      for (let dc = -rCells; dc <= rCells; dc++) {
        if (dr * dr + dc * dc <= rCells * rCells) {
          const row = centerCell.row + dr
          const col = centerCell.col + dc
          if (row >= 0 && row < HEIGHT_CELLS && col >= 0 && col < WIDTH_CELLS) {
            cells[at(row, col)] = 'occupied'
          }
        }
      }
    }
  }

  // 2. Outer arena perimeter border (perimeter bounds at ±3.4m X, ±2.2m Y)
  for (let row = 0; row < HEIGHT_CELLS; row++) {
    for (let col = 0; col < WIDTH_CELLS; col++) {
      const isPerimeter = row === 0 || row === HEIGHT_CELLS - 1 || col === 0 || col === WIDTH_CELLS - 1
      if (isPerimeter) {
        cells[at(row, col)] = 'occupied'
      }
    }
  }

  // 3. Unexplored Sector Mist in the outer perimeter
  const corners: Array<[number, number]> = [
    [2, 2],
    [2, WIDTH_CELLS - 3],
    [HEIGHT_CELLS - 3, 2],
    [HEIGHT_CELLS - 3, WIDTH_CELLS - 3],
  ]
  const fogRadiusCells = 7
  for (const [cr, cc] of corners) {
    for (let row = Math.max(0, cr - fogRadiusCells); row < Math.min(HEIGHT_CELLS, cr + fogRadiusCells); row++) {
      for (let col = Math.max(0, cc - fogRadiusCells); col < Math.min(WIDTH_CELLS, cc + fogRadiusCells); col++) {
        const dist = Math.hypot(row - cr, col - cc)
        if (dist < fogRadiusCells && cells[at(row, col)] === 'free') {
          cells[at(row, col)] = 'unknown'
        }
      }
    }
  }

  return { widthCells: WIDTH_CELLS, heightCells: HEIGHT_CELLS, resolutionM: RESOLUTION_M, origin: ORIGIN, cells }
}

/** Static for this pass — a real /map subscription would replace this with live cell data. */
export const demoOccupancyGrid: OccupancyGrid = buildDemoGrid()
