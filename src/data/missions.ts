import type { Mission } from '../types/robot'

export const MISSIONS: Mission[] = [
  { id: 'm1', name: 'Morning Perimeter Sweep', steps: 6, stepsComplete: 6, status: 'complete', etaMin: 0 },
  { id: 'm2', name: 'Kitchen Delivery Run', steps: 4, stepsComplete: 2, status: 'running', etaMin: 3 },
  { id: 'm3', name: 'Living Room Patrol', steps: 5, stepsComplete: 0, status: 'queued', etaMin: 12 },
  { id: 'm4', name: 'Return to Dock', steps: 1, stepsComplete: 0, status: 'queued', etaMin: 18 },
]
