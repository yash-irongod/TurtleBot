import type { Waypoint } from '../types/robot'

export const WAYPOINTS: Waypoint[] = [
  { id: 'wp1', label: 'Alpha Outpost', position: { x: -0.1, y: 0 }, status: 'reached' },
  { id: 'wp2', label: 'Basalt Ridge', position: { x: 1.35, y: -0.25 }, status: 'reached' },
  { id: 'wp3', label: 'Ruined Portal Arch', position: { x: -1.0, y: 0.7 }, status: 'active' },
  { id: 'wp4', label: 'Impact Crater Site', position: { x: 2.2, y: -0.8 }, status: 'pending' },
]
