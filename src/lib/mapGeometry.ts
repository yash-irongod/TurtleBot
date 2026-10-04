import type { OccupancyGrid, Position2D } from '../types/robot'

/* ------------------------------------------------------------------ */
/* Output types                                                       */
/* ------------------------------------------------------------------ */

/** A continuous boundary polyline (simplified from raw cell edges). */
export interface MapBoundaryPolyline {
  /** Ordered world-coordinate vertices forming a continuous polyline or loop. */
  points: Position2D[]
  /** True when the first and last point are effectively identical (closed loop). */
  closed: boolean
}

/** Legacy segment format kept for incremental migration of consumers. */
export interface MapBoundarySegment {
  x1: number; y1: number; x2: number; y2: number; lengthM: number
}

export interface MapObstacleRegion {
  /** Stable deterministic ID — survives small centroid shifts across SLAM updates. */
  id: string
  center: Position2D
  min: Position2D
  max: Position2D
  widthM: number
  heightM: number
  cellCount: number
  /** Occupied cell indices in grid-local coordinates for footprint rendering. */
  cellIndices: number[]
}

export interface MapGeometry {
  /** Continuous simplified boundary polylines (preferred — use for new code). */
  boundaryPolylines: MapBoundaryPolyline[]
  /** Legacy segments derived from polylines (for backward compat). */
  boundarySegments: MapBoundarySegment[]
  /** Interior and peripheral obstacles with stable IDs. */
  obstacles: MapObstacleRegion[]
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/** Douglas-Peucker polyline simplification. */
function simplifyPolyline(points: Position2D[], epsilon: number): Position2D[] {
  if (points.length <= 2) return points

  // Find the point with the maximum distance from the line (start → end)
  let maxDist = 0
  let maxIdx = 0
  const start = points[0]
  const end = points[points.length - 1]
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lenSq = dx * dx + dy * dy

  for (let i = 1; i < points.length - 1; i++) {
    let dist: number
    if (lenSq < 1e-12) {
      // start and end are the same point
      const px = points[i].x - start.x
      const py = points[i].y - start.y
      dist = Math.sqrt(px * px + py * py)
    } else {
      // perpendicular distance to the line
      const t = Math.max(0, Math.min(1,
        ((points[i].x - start.x) * dx + (points[i].y - start.y) * dy) / lenSq
      ))
      const projX = start.x + t * dx
      const projY = start.y + t * dy
      const ex = points[i].x - projX
      const ey = points[i].y - projY
      dist = Math.sqrt(ex * ex + ey * ey)
    }
    if (dist > maxDist) {
      maxDist = dist
      maxIdx = i
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyPolyline(points.slice(0, maxIdx + 1), epsilon)
    const right = simplifyPolyline(points.slice(maxIdx), epsilon)
    return [...left.slice(0, -1), ...right]
  }
  return [start, end]
}

/** Chain raw edge segments (each defined by two endpoints) into continuous polylines. */
function chainEdgeSegments(
  segments: Array<{ a: Position2D; b: Position2D }>,
  snapThreshold: number,
): Position2D[][] {
  if (segments.length === 0) return []

  // Build adjacency: for each endpoint find connected segments
  const snap = (v: Position2D) => `${Math.round(v.x / snapThreshold)}_${Math.round(v.y / snapThreshold)}`
  
  // Adjacency map: snapKey → list of { segIdx, endIdx (0=a, 1=b) }
  const adj = new Map<string, Array<{ seg: number; end: 0 | 1 }>>()
  for (let i = 0; i < segments.length; i++) {
    const ka = snap(segments[i].a)
    const kb = snap(segments[i].b)
    if (!adj.has(ka)) adj.set(ka, [])
    adj.get(ka)!.push({ seg: i, end: 0 })
    if (!adj.has(kb)) adj.set(kb, [])
    adj.get(kb)!.push({ seg: i, end: 1 })
  }

  const used = new Uint8Array(segments.length)
  const chains: Position2D[][] = []

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue
    used[i] = 1

    // Start chain from segment i: a → b
    const chain: Position2D[] = [segments[i].a, segments[i].b]

    // Extend forward from the last point
    const extendChain = (chain: Position2D[], forward: boolean) => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tip = forward ? chain[chain.length - 1] : chain[0]
        const key = snap(tip)
        const candidates = adj.get(key)
        if (!candidates) break
        let found = false
        for (const c of candidates) {
          if (used[c.seg]) continue
          const seg = segments[c.seg]
          // Which end matches the tip?
          const matchEnd = c.end
          const otherEnd: 0 | 1 = matchEnd === 0 ? 1 : 0
          const nextPt = otherEnd === 0 ? seg.a : seg.b
          used[c.seg] = 1
          if (forward) {
            chain.push(nextPt)
          } else {
            chain.unshift(nextPt)
          }
          found = true
          break
        }
        if (!found) break
      }
    }

    extendChain(chain, true)
    extendChain(chain, false)
    chains.push(chain)
  }

  return chains
}

/* ------------------------------------------------------------------ */
/* Main geometry extraction                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a stable geometric interpretation of an occupancy grid.
 *
 * Algorithm:
 * 1. Flood-fill unknown cells connected to the grid edge → "outside" mask.
 * 2. Extract occupied connected components (8-connectivity).
 * 3. Classify: components touching outside → boundary, interior → obstacle.
 * 4. For boundary: extract outer contour edges, chain into polylines,
 *    simplify with Douglas-Peucker.
 * 5. For obstacles: compute footprint, stable ID from cell set hash.
 */
export function extractMapGeometry(grid: OccupancyGrid): MapGeometry {
  const { widthCells: w, heightCells: h, resolutionM: res, origin, cells } = grid
  if (w <= 0 || h <= 0 || cells.length !== w * h || res <= 0) {
    return { boundaryPolylines: [], boundarySegments: [], obstacles: [] }
  }

  /* ---------- Step 1: Flood-fill outside unknown region ---------- */
  const outsideUnknown = new Uint8Array(w * h)
  const unknownQueue = new Int32Array(w * h)
  let qHead = 0
  let qTail = 0

  const enqueueUnknown = (idx: number) => {
    if (outsideUnknown[idx] || cells[idx] !== 'unknown') return
    outsideUnknown[idx] = 1
    unknownQueue[qTail++] = idx
  }

  for (let c = 0; c < w; c++) {
    enqueueUnknown(c)
    enqueueUnknown((h - 1) * w + c)
  }
  for (let r = 0; r < h; r++) {
    enqueueUnknown(r * w)
    enqueueUnknown(r * w + (w - 1))
  }

  const n4: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]]

  while (qHead < qTail) {
    const idx = unknownQueue[qHead++]
    const c = idx % w
    const r = Math.floor(idx / w)
    for (const [dc, dr] of n4) {
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nc >= w || nr < 0 || nr >= h) continue
      enqueueUnknown(nr * w + nc)
    }
  }

  /* ---------- Step 2: Extract occupied components (8-conn) ---------- */
  const visited = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  const n8: ReadonlyArray<readonly [number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ]

  interface Component {
    cells: number[]
    minC: number; maxC: number; minR: number; maxR: number
    touchesOutside: boolean
  }

  const components: Component[] = []

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const start = r * w + c
      if (visited[start] || cells[start] !== 'occupied') continue

      visited[start] = 1
      qHead = 0; qTail = 0
      queue[qTail++] = start

      const componentCells: number[] = []
      let minC = c, maxC = c, minR = r, maxR = r
      let touchesOutside = false

      while (qHead < qTail) {
        const idx = queue[qHead++]
        componentCells.push(idx)
        const cc = idx % w
        const rr = Math.floor(idx / w)

        if (cc === 0 || cc === w - 1 || rr === 0 || rr === h - 1) {
          touchesOutside = true
        }

        for (const [dc, dr] of n8) {
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

  /* ---------- Step 3: Classify components ---------- */
  const minBoundarySpanM = Math.max(0.65, res * 5.0)
  const boundaryCellSet = new Uint8Array(w * h)
  const obstacles: MapObstacleRegion[] = []

  for (const component of components) {
    if (component.cells.length < 2) continue

    const widthM = (component.maxC - component.minC + 1) * res
    const heightM = (component.maxR - component.minR + 1) * res
    const maxSpanM = Math.max(widthM, heightM)

    if (!component.touchesOutside) {
      // Interior obstacle
      const center: Position2D = {
        x: origin.x + (component.minC + component.maxC + 1) * 0.5 * res,
        y: origin.y + (component.minR + component.maxR + 1) * 0.5 * res,
      }
      // Stable ID: deterministic hash from sorted cell indices
      const sortedCells = [...component.cells].sort((a, b) => a - b)
      const id = `obs_${sortedCells.length}_${sortedCells[0]}_${sortedCells[Math.floor(sortedCells.length / 2)]}_${sortedCells[sortedCells.length - 1]}`
      obstacles.push({
        id,
        center,
        min: { x: origin.x + component.minC * res, y: origin.y + component.minR * res },
        max: { x: origin.x + (component.maxC + 1) * res, y: origin.y + (component.maxR + 1) * res },
        widthM,
        heightM,
        cellCount: component.cells.length,
        cellIndices: component.cells,
      })
    } else {
      const isContinuousLine = maxSpanM >= minBoundarySpanM || component.cells.length >= 20
      if (isContinuousLine) {
        for (const idx of component.cells) boundaryCellSet[idx] = 1
      } else if (widthM <= 1.5 && heightM <= 1.5 && component.cells.length >= 3) {
        // Peripheral obstacle near boundary
        const center: Position2D = {
          x: origin.x + (component.minC + component.maxC + 1) * 0.5 * res,
          y: origin.y + (component.minR + component.maxR + 1) * 0.5 * res,
        }
        const sortedCells = [...component.cells].sort((a, b) => a - b)
        const id = `obs_${sortedCells.length}_${sortedCells[0]}_${sortedCells[Math.floor(sortedCells.length / 2)]}_${sortedCells[sortedCells.length - 1]}`
        obstacles.push({
          id,
          center,
          min: { x: origin.x + component.minC * res, y: origin.y + component.minR * res },
          max: { x: origin.x + (component.maxC + 1) * res, y: origin.y + (component.maxR + 1) * res },
          widthM,
          heightM,
          cellCount: component.cells.length,
          cellIndices: component.cells,
        })
      }
    }
  }

  /* ---------- Step 4: Extract boundary contour edges ---------- */
  // For each boundary cell, extract outer-facing edges (facing outside unknown
  // or free space). Prefer free-space-facing edges to avoid double contours
  // on one-cell-thick walls.
  const isState = (c: number, r: number, state: 'free' | 'outside') => {
    if (c < 0 || c >= w || r < 0 || r >= h) return state === 'outside'
    const idx = r * w + c
    return state === 'free' ? cells[idx] === 'free' : cells[idx] === 'unknown' && outsideUnknown[idx] === 1
  }

  const rawEdges: Array<{ a: Position2D; b: Position2D }> = []

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

      const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
        rawEdges.push({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 } })
      }

      if (hasKnownFreeFace) {
        if (freeTop) addEdge(x, y, x + res, y)
        if (freeBottom) addEdge(x, y + res, x + res, y + res)
        if (freeLeft) addEdge(x, y, x, y + res)
        if (freeRight) addEdge(x + res, y, x + res, y + res)
      } else {
        if (isState(c, r - 1, 'outside')) addEdge(x, y, x + res, y)
        if (isState(c, r + 1, 'outside')) addEdge(x, y + res, x + res, y + res)
        if (isState(c - 1, r, 'outside')) addEdge(x, y, x, y + res)
        if (isState(c + 1, r, 'outside')) addEdge(x + res, y, x + res, y + res)
      }
    }
  }

  /* ---------- Step 5: Chain edges into polylines and simplify ---------- */
  const snapThreshold = res * 0.25
  const rawChains = chainEdgeSegments(rawEdges, snapThreshold)

  // Simplify each chain with Douglas-Peucker
  const epsilon = res * 0.8
  const boundaryPolylines: MapBoundaryPolyline[] = []

  for (const chain of rawChains) {
    if (chain.length < 2) continue

    // Check if chain forms a closed loop
    const first = chain[0]
    const last = chain[chain.length - 1]
    const closeDist = Math.sqrt((first.x - last.x) ** 2 + (first.y - last.y) ** 2)
    const closed = closeDist < res * 0.6

    let simplified = simplifyPolyline(chain, epsilon)

    // Filter out very short polylines (noise)
    let totalLen = 0
    for (let i = 1; i < simplified.length; i++) {
      const dx = simplified[i].x - simplified[i - 1].x
      const dy = simplified[i].y - simplified[i - 1].y
      totalLen += Math.sqrt(dx * dx + dy * dy)
    }
    const minLenM = Math.max(0.28, res * 2.0)
    if (totalLen < minLenM) continue

    boundaryPolylines.push({ points: simplified, closed })
  }

  /* ---------- Step 6: Generate legacy segments from polylines ---------- */
  const boundarySegments: MapBoundarySegment[] = []
  for (const poly of boundaryPolylines) {
    for (let i = 1; i < poly.points.length; i++) {
      const p0 = poly.points[i - 1]
      const p1 = poly.points[i]
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y
      const lengthM = Math.sqrt(dx * dx + dy * dy)
      if (lengthM > 0.001) {
        boundarySegments.push({ x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, lengthM })
      }
    }
    // Close the loop if needed
    if (poly.closed && poly.points.length >= 3) {
      const p0 = poly.points[poly.points.length - 1]
      const p1 = poly.points[0]
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y
      const lengthM = Math.sqrt(dx * dx + dy * dy)
      if (lengthM > 0.001) {
        boundarySegments.push({ x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, lengthM })
      }
    }
  }

  return { boundaryPolylines, boundarySegments, obstacles }
}
