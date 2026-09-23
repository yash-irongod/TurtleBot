import type { ModeDefinition } from '../types/robot'

/**
 * The three primary operating modes. Each is a distinct operating context —
 * see ModeSwitcher and the contextual half of ControlDeck — not a shallow
 * variation on one dashboard.
 */
export const MODE_DEFINITIONS: ModeDefinition[] = [
  {
    id: 'AUTONOMOUS',
    label: 'Autonomous',
    tagline: 'Map · Plan · Navigate',
    description: 'Uses the live SLAM/Nav2 pipeline in LIVE mode, with a local navigation model available in DEMO mode.',
  },
  {
    id: 'MANUAL',
    label: 'Manual',
    tagline: 'Keyboard · Drive · Mission',
    description: 'Software-limited keyboard and drive-pad commands for testing and controlled demonstrations.',
  },
  {
    id: 'PUPPY',
    label: 'Puppy',
    tagline: 'Detect · Lock · Follow',
    description: 'Exercises a DEMO target-follow state model; no perception or person-detection backend is connected.',
  },
]
