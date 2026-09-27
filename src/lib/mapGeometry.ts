import type { OccupancyGrid, Position2D } from '../types/robot'

export interface MapBoundarySegment {
  x1: number
  y1: number
  x2: number
  y2: number
  lengthM: number
}

export interface MapObstacleRegion {
  center: Position2D
  min: Position2D
  max: Position2D
  widthM: number
  heightM: number
  cellCount: number
}

export interface MapGeometry {
  boundarySegments: MapBoundarySegment[]
  obstacles: MapObstacleRegion[]
}

/**
 * Build a stable geometric interpretation of an occupancy grid.
 *
 * The key distinction is not "large component = border". Instead we flood-fill
 * unknown cells connected to the grid edge (the unmapped outside), then classify
 * occupied components touching that outside as boundary structures. Interior
 * occupied components remain objects. This is considerably more robust to SLAM
 * wall thickness, small gaps, and fragmented sensor returns.
 */
export function extractMapGeometry(grid: OccupancyGrid): MapGeometry {
  const { widthCells: w, heightCells: h, resolutionM: res, origin, cells } = grid
  if (w <= 0 || h <= 0 || cells.length !== w * h || res <= 0) {
    return { boundarySegments: [], obstacles: [] }
  }

  const outsideUnknown = new Uint8Array(w * h)
  const unknownQueue = new Int32Array(w * h)
  let qHead = 0
  let qTail = 0

  const enqueueUnknown = (idx: number) => {
    if (outsideUnknown[idx] || cells[idx] !== 'unknown') return
    outsideUnknown[idx] = 1
    unknownQueue[qTail++] = idx
  }

  // Unknown cells connected to the grid edge are treated as the unmapped outside.
  for (let c = 0; c < w; c++) {
    enqueueUnknown(c)
    enqueueUnknown((h - 1) * w + c)
  }
  for (let r = 0; r < h; r++) {
    enqueueUnknown(r * w)
    enqueueUnknown(r * w + (w - 1))
  }

  const unknownNeighbors: ReadonlyArray<readonly [number, number]> = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]

  while (qHead < qTail) {
    const idx = unknownQueue[qHead++]
    const c = idx % w
    const r = Math.floor(idx / w)
    for (const [dc, dr] of unknownNeighbors) {
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue
      enqueueUnknown(nr * w + nc)
    }
  }

  // Occupied components use 8-connectivity so diagonal wall returns are not split.
  const visited = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  const occupiedNeighbors: ReadonlyArray<readonly [number, number]> = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ]

  const components: Array<{
    cells: number[]
    minC: number
    maxC: number
    minR: number
    maxR: number
    touchesOutside: boolean
  }> = []

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const start = r * w + c
      if (visited[start] || cells[start] !== 'occupied') continue

      visited[start] = 1
      qHead = 0
      qTail = 0
      queue[qTail++] = start

      const componentCells: number[] = []
      let minC = c
      let maxC = c
      let minR = r
      let maxR = r
      let touchesOutside = false

      while (qHead < qTail) {
        const idx = queue[qHead++]
        componentCells.push(idx)
        const cc = idx % w
        const rr = Math.floor(idx / w)

        if (cc === 0 || cc === w - 1 || rr === 0 || rr === h - 1) {
          touchesOutside = true
        }

        for (const [dc, dr] of occupiedNeighbors) {
          const nc = cc + dc
          const nr = rr + dr
          if (nc < 0 || nc >= w || nr < 0 || nr >= h) {
            touchesOutside = true
            continue
          }
          const nIdx = nr * w + nc
          if (cells[nIdx] === 'unknown' && outsideUnknown[nIdx]) {
            touchesOutside = true
          } else if (cells[nIdx] === 'occupied' && !visited[nIdx]) {
            visited[nIdx] = 1
            queue[qTail++] = nIdx
            minC = Math.min(minC, nc)
            maxC = Math.max(maxC, nc)
            minR = Math.min(minR, nr)
            maxR = Math.max(maxR, nr)
          }
        }
      }

      components.push({ cells: componentCells, minC, maxC, minR, maxR, touchesOutside })
    }
  }

  const minBoundarySpanM = Math.max(0.65, res * 5.0)
  const boundaryComponents: typeof components = []
  const obstacles: MapObstacleRegion[] = []

  for (const component of components) {
    if (component.cells.length < 2) continue

    const widthM = (component.maxC - component.minC + 1) * res
    const heightM = (component.maxR - component.minR + 1) * res
    const maxSpanM = Math.max(widthM, heightM)

    // Visual classification pipeline:
    // 1. If component does NOT touch outside unknown / map edge -> Interior obstacle.
    //    Surrounded by explored space (e.g. tables, chairs, columns, dividers).
    // 2. If component DOES touch outside unknown / map edge:
    //    - If sufficiently continuous (span >= minBoundarySpanM or >= 20 cells) -> Perimeter boundary wall.
    //    - If compact cluster (width & height <= 1.5m, >= 3 cells) -> Peripheral obstacle near mapped boundary.
    //    - Otherwise -> Small wall fragment or frontier sensor noise.
    if (!component.touchesOutside) {
      const center = {
        x: origin.x + (component.minC + component.maxC + 1) * 0.5 * res,
        y: origin.y + (component.minR + component.maxR + 1) * 0.5 * res,
      }
      obstacles.push({
        center,
        min: { x: origin.x + component.minC * res, y: origin.y + component.minR * res },
        max: { x: origin.x + (component.maxC + 1) * res, y: origin.y + (component.maxR + 1) * res },
        widthM,
        heightM,
        cellCount: component.cells.length,
      })
    } else {
      const isContinuousLine = maxSpanM >= minBoundarySpanM || component.cells.length >= 20

      if (isContinuousLine) {
        boundaryComponents.push(component)
      } else if (widthM <= 1.5 && heightM <= 1.5 && component.cells.length >= 3) {
        const center = {
          x: origin.x + (component.minC + component.maxC + 1) * 0.5 * res,
          y: origin.y + (component.minR + component.maxR + 1) * 0.5 * res,
        }
        obstacles.push({
          center,
          min: { x: origin.x + component.minC * res, y: origin.y + component.minR * res },
          max: { x: origin.x + (component.maxC + 1) * res, y: origin.y + (component.maxR + 1) * res },
          widthM,
          heightM,
          cellCount: component.cells.length,
        })
      }
    }
  }

  const boundaryCellSet = new Uint8Array(w * h)
  for (const component of boundaryComponents) {
    for (const idx of component.cells) boundaryCellSet[idx] = 1
  }

  // Convert boundary cells to a single-sided contour. Prefer the edge facing known
  // free space; only fall back to the outside edge when a boundary cell has no known
  // free neighbour. This avoids drawing two parallel lines for a one-cell-thick wall.
  const horizontal = new Map<number, Array<{ x1: number; x2: number }>>()
  const vertical = new Map<number, Array<{ y1: number; y2: number }>>()

  const isState = (c: number, r: number, state: 'free' | 'outside') => {
    if (c < 0 || c >= w || r < 0 || r >= h) return state === 'outside'
    const idx = r * w + c
    return state === 'free' ? cells[idx] === 'free' : cells[idx] === 'unknown' && outsideUnknown[idx] === 1
  }

  const addHorizontal = (y: number, x1: number, x2: number) => {
    const key = Math.round(y * 1000)
    const list = horizontal.get(key) ?? []
    list.push({ x1, x2 })
    horizontal.set(key, list)
  }

  const addVertical = (x: number, y1: number, y2: number) => {
    const key = Math.round(x * 1000)
    const list = vertical.get(key) ?? []
    list.push({ y1, y2 })
    vertical.set(key, list)
  }

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const idx = r * w + c
      if (!boundaryCellSet[idx]) continue
      const x = origin.x + c * res
      const y = origin.y + r * res

      const freeTop = isState(c, r - 1, 'free')
      const freeBottom = isState(c, r + 1, 'free')
      const freeLeft = isState(c - 1, r, 'free')
      const freeRight = isState(c + 1, r, 'free')
      const hasKnownFreeFace = freeTop || freeBottom || freeLeft || freeRight

      // Prefer the contour facing mapped free space. If that information is not
      // available yet, use only outside-facing edges as a fallback.
      if (hasKnownFreeFace) {
        if (freeTop) addHorizontal(y, x, x + res)
        if (freeBottom) addHorizontal(y + res, x, x + res)
        if (freeLeft) addVertical(x, y, y + res)
        if (freeRight) addVertical(x + res, y, y + res)
      } else {
        if (isState(c, r - 1, 'outside')) addHorizontal(y, x, x + res)
        if (isState(c, r + 1, 'outside')) addHorizontal(y + res, x, x + res)
        if (isState(c - 1, r, 'outside')) addVertical(x, y, y + res)
        if (isState(c + 1, r, 'outside')) addVertical(x + res, y, y + res)
      }
    }
  }

  const boundarySegments: MapBoundarySegment[] = []
  const minSegmentM = Math.max(0.28, res * 2.0)
  const mergeGapM = res * 2.2

  horizontal.forEach((intervals, key) => {
    intervals.sort((a, b) => a.x1 - b.x1)
    let current = { ...intervals[0] }
    for (let i = 1; i < intervals.length; i++) {
      const next = intervals[i]
      if (next.x1 <= current.x2 + mergeGapM) {
        current.x2 = Math.max(current.x2, next.x2)
      } else {
        const lengthM = current.x2 - current.x1
        if (lengthM >= minSegmentM) {
          boundarySegments.push({ x1: current.x1, y1: key / 1000, x2: current.x2, y2: key / 1000, lengthM })
        }
        current = { ...next }
      }
    }
    const lengthM = current.x2 - current.x1
    if (lengthM >= minSegmentM) {
      boundarySegments.push({ x1: current.x1, y1: key / 1000, x2: current.x2, y2: key / 1000, lengthM })
    }
  })

  vertical.forEach((intervals, key) => {
    intervals.sort((a, b) => a.y1 - b.y1)
    let current = { ...intervals[0] }
    for (let i = 1; i < intervals.length; i++) {
      const next = intervals[i]
      if (next.y1 <= current.y2 + mergeGapM) {
        current.y2 = Math.max(current.y2, next.y2)
      } else {
        const lengthM = current.y2 - current.y1
        if (lengthM >= minSegmentM) {
          boundarySegments.push({ x1: key / 1000, y1: current.y1, x2: key / 1000, y2: current.y2, lengthM })
        }
        current = { ...next }
      }
    }
    const lengthM = current.y2 - current.y1
    if (lengthM >= minSegmentM) {
      boundarySegments.push({ x1: key / 1000, y1: current.y1, x2: key / 1000, y2: current.y2, lengthM })
    }
  })

  return { boundarySegments, obstacles }
}
