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

// Natural Titan planetary formations (Basalt outcrops, ruined monoliths, crater rims)
const TITAN_FORMATIONS_M = [
  // Basalt ridge formation
  { xMin: -1.9, xMax: -1.0, yMin: -1.4, yMax: -0.8 },
  // Alien monolith spires
  { xMin: 0.8, xMax: 1.7, yMin: 0.5, yMax: 1.2 },
  // Ruined gantry pylon rubble
  { xMin: -0.7, xMax: -0.2, yMin: 1.1, yMax: 1.5 },
  // Impact crater rim boulders
  { xMin: 1.7, xMax: 2.5, yMin: -1.5, yMax: -0.9 },
  // Scattered obsidian crags
  { xMin: -2.8, xMax: -2.2, yMin: 0.2, yMax: 0.8 },
  { xMin: 2.3, xMax: 2.9, yMin: 0.8, yMax: 1.4 },
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

  // 1. Natural Planetary Formations & Ruined Monoliths (NO 4-walled rectangular room!)
  for (const obs of TITAN_FORMATIONS_M) {
    const tl = worldToCell({ x: obs.xMin, y: obs.yMin })
    const br = worldToCell({ x: obs.xMax, y: obs.yMax })
    for (let row = tl.row; row <= br.row; row++) {
      for (let col = tl.col; col <= br.col; col++) {
        if (row >= 0 && row < HEIGHT_CELLS && col >= 0 && col < WIDTH_CELLS) {
          // Add organic variation so it doesn't look like rigid bricks
          const edgeDist = Math.min(row - tl.row, br.row - row, col - tl.col, br.col - col)
          if (edgeDist > 0 || (row + col) % 3 !== 0) {
            cells[at(row, col)] = 'occupied'
          }
        }
      }
    }
  }

  // 2. Natural Border Formations at far perimeter edges (scattered rock crags, not a solid wall)
  for (let row = 0; row < HEIGHT_CELLS; row++) {
    for (let col = 0; col < WIDTH_CELLS; col++) {
      const isOuterEdge = row <= 1 || row >= HEIGHT_CELLS - 2 || col <= 1 || col >= WIDTH_CELLS - 2
      if (isOuterEdge && (row * 7 + col * 13) % 4 === 0) {
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
