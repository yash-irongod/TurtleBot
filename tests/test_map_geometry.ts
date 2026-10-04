import assert from 'node:assert/strict'
import test from 'node:test'
import { extractMapGeometry } from '../src/lib/mapGeometry.ts'
import type { CellState, OccupancyGrid } from '../src/types/robot.ts'

function createGrid(
  w: number,
  h: number,
  res: number,
  fill: (c: number, r: number) => CellState,
): OccupancyGrid {
  const cells: CellState[] = new Array(w * h)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      cells[r * w + c] = fill(c, r)
    }
  }
  return {
    widthCells: w,
    heightCells: h,
    resolutionM: res,
    origin: { x: 0, y: 0 },
    cells,
  }
}

test('extractMapGeometry handles empty or invalid grids gracefully', () => {
  const emptyGrid: OccupancyGrid = {
    widthCells: 0,
    heightCells: 0,
    resolutionM: 0.05,
    origin: { x: 0, y: 0 },
    cells: [],
  }
  const geo = extractMapGeometry(emptyGrid)
  assert.equal(geo.boundaryPolylines.length, 0)
  assert.equal(geo.boundarySegments.length, 0)
  assert.equal(geo.obstacles.length, 0)
})

test('extractMapGeometry classifies rectangular perimeter as boundary polyline', () => {
  // 30x30 grid:
  // - Margin (0..4 and 25..29): unknown (outside)
  // - Perimeter (5 and 24): occupied (room walls)
  // - Interior (6..23): free
  const w = 30, h = 30, res = 0.05
  const grid = createGrid(w, h, res, (c, r) => {
    if (c < 5 || c > 24 || r < 5 || r > 24) return 'unknown'
    if (c === 5 || c === 24 || r === 5 || r === 24) return 'occupied'
    return 'free'
  })

  const geo = extractMapGeometry(grid)
  assert.ok(geo.boundaryPolylines.length >= 1, 'Should find at least 1 boundary polyline')
  assert.ok(geo.boundarySegments.length >= 4, 'Should generate legacy boundary segments')
  // The perimeter walls touch outside unknown, so no obstacles should be extracted
  assert.equal(geo.obstacles.length, 0, 'No interior obstacles should be detected in empty room')
})

test('extractMapGeometry extracts interior obstacle with stable ID', () => {
  // 30x30 grid: room with a 4x4 block obstacle in the center (c=14..17, r=14..17)
  const w = 30, h = 30, res = 0.05
  const grid = createGrid(w, h, res, (c, r) => {
    if (c < 5 || c > 24 || r < 5 || r > 24) return 'unknown'
    if (c === 5 || c === 24 || r === 5 || r === 24) return 'occupied'
    // Interior obstacle
    if (c >= 14 && c <= 17 && r >= 14 && r <= 17) return 'occupied'
    return 'free'
  })

  const geo = extractMapGeometry(grid)
  assert.equal(geo.obstacles.length, 1, 'Should detect exactly one interior obstacle')
  const obs = geo.obstacles[0]
  assert.ok(obs.id.startsWith('obs_'), `ID should have stable format, got ${obs.id}`)
  assert.equal(obs.cellCount, 16, 'Obstacle cell count should match')
  assert.ok(obs.widthM > 0.1 && obs.heightM > 0.1, 'Obstacle bounding dimensions should be accurate')

  // Run a second time to ensure stable ID determinism
  const geo2 = extractMapGeometry(grid)
  assert.equal(geo2.obstacles[0].id, obs.id, 'Obstacle ID must be strictly deterministic across calls')
})

test('extractMapGeometry rejects isolated 1-cell noise', () => {
  const w = 30, h = 30, res = 0.05
  const grid = createGrid(w, h, res, (c, r) => {
    if (c === 15 && r === 15) return 'occupied' // Single cell noise
    return 'free'
  })

  const geo = extractMapGeometry(grid)
  assert.equal(geo.obstacles.length, 0, 'Single-cell noise component (<2 cells) must be filtered out')
})
