import type { CellState, OccupancyGrid, Position2D } from '../types/robot'
import { normalizeDeg } from './polar'

/**
 * Single authoritative conversion layer between ROS REP-103 standard coordinates
 * and the frontend presentation coordinate conventions.
 *
 * Coordinate conventions:
 * 1. ROS REP-103:
 *    - Origin (0,0) in map frame.
 *    - +X is Forward / East.
 *    - +Y is Left / North.
 *    - Yaw (θ) in radians: 0 along +X, positive counter-clockwise (+Y is π/2 = 90°).
 *    - OccupancyGrid: row 0 is at origin.y (South / bottom of map).
 *
 * 2. Frontend presentation coordinates:
 *    - +X is East (right).
 *    - -Y is North (up), +Y is South (down) matching SVG / screen coords.
 *    - headingDeg: 0° is North (facing top of display), increases clockwise:
 *      * North = 0°
 *      * East  = 90°
 *      * South = 180°
 *      * West  = 270°
 *    - In 3D (Three.js): Scene X = frontend X, Scene Z = frontend Y.
 *      Moving towards North (heading 0°) decreases frontend Y / Three.js -Z.
 *
 * Direct mathematical mapping:
 *    x_front = x_ros
 *    y_front = -y_ros
 *
 *    headingDeg = ((90 - (yaw_ros * 180 / π)) % 360 + 360) % 360
 *    yaw_ros    = ((90 - headingDeg) * π / 180)
 */

/** Converts a 2D planar position from ROS REP-103 (x=East, y=North) to Frontend (x=East, y=-North). */
export function rosToFrontendPosition(xRos: number, yRos: number): Position2D {
  return {
    x: xRos,
    y: -yRos,
  }
}

/** Converts a 2D planar position from Frontend to ROS REP-103 (x=East, y=North). */
export function frontendToRosPosition(pos: Position2D): Position2D {
  return {
    x: pos.x,
    y: -pos.y,
  }
}

/** Converts ROS yaw (radians CCW from East/+X) to Frontend compass heading (degrees CW from North). */
export function rosYawToFrontendHeadingDeg(yawRad: number): number {
  const yawDeg = (yawRad * 180) / Math.PI
  return normalizeDeg(90 - yawDeg)
}

/** Converts Frontend compass heading (degrees CW from North) to ROS yaw (radians CCW from East/+X). */
export function frontendHeadingDegToRosYaw(headingDeg: number): number {
  const deg = normalizeDeg(90 - headingDeg)
  // Bring into [-180, 180] for standard ROS quaternion / yaw representations
  const normalizedYawDeg = deg > 180 ? deg - 360 : deg
  return (normalizedYawDeg * Math.PI) / 180
}

/**
 * Raw ROS OccupancyGrid message structure payload emitted by bridge.py.
 */
export interface RosOccupancyGridPayload {
  width: number
  height: number
  resolution: number
  origin: {
    x: number
    y: number
    z?: number
    yaw?: number
  }
  /** Flat row-major int8 array (-1 = unknown, 0 = free, 100 = occupied) */
  data: number[]
}

/**
 * Converts a ROS nav_msgs/OccupancyGrid payload into the frontend OccupancyGrid model.
 *
 * In ROS: row 0 is at origin.y (South), row (H-1) is at North.
 * In Frontend: row 0 is at y_min (North, top of map), row (H-1) is at South.
 * We flip the rows vertically so every cell (col, row) satisfies:
 *   x_front = x_ros
 *   y_front = -y_ros
 */
export function convertRosOccupancyGridToFrontend(rosMap: RosOccupancyGridPayload): OccupancyGrid {
  const widthCells = Math.max(1, Math.round(rosMap.width))
  const heightCells = Math.max(1, Math.round(rosMap.height))
  const resolutionM = Math.max(0.001, rosMap.resolution)
  const rawData = rosMap.data ?? []

  // In ROS: y_ros runs from origin.y to origin.y + height * resolution.
  // In Frontend: y_front = -y_ros, so y_front runs from -(origin.y + height * resolution) to -origin.y.
  // The top-left cell (row 0, col 0 in frontend) corresponds to ROS (col 0, row H-1).
  const origin: Position2D = {
    x: rosMap.origin.x,
    y: -(rosMap.origin.y + heightCells * resolutionM),
  }

  const cells: CellState[] = new Array(widthCells * heightCells)

  for (let rFront = 0; rFront < heightCells; rFront++) {
    // Row in ROS bottom-up grid:
    const rRos = heightCells - 1 - rFront
    const rosRowOffset = rRos * widthCells
    const frontRowOffset = rFront * widthCells

    for (let c = 0; c < widthCells; c++) {
      const val = rawData[rosRowOffset + c]
      if (val === undefined || val < 0) {
        cells[frontRowOffset + c] = 'unknown'
      } else if (val >= 50) {
        cells[frontRowOffset + c] = 'occupied'
      } else {
        cells[frontRowOffset + c] = 'free'
      }
    }
  }

  return {
    widthCells,
    heightCells,
    resolutionM,
    origin,
    cells,
  }
}
