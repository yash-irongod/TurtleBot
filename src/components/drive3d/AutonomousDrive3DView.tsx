import { Drive3DView } from './Drive3DView'
import type { CameraMode } from './driveCamera'

export interface AutonomousDrive3DViewProps {
  initialCameraMode?: CameraMode
  className?: string
  showMinimap?: boolean
  onToggleFull2DMap?: () => void
}

/**
 * Autonomous 3D Third-Person Drive View.
 * Backward-compatible wrapper over the reusable Drive3DView with mode="autonomous".
 */
export function AutonomousDrive3DView({
  initialCameraMode,
  className,
  showMinimap,
  onToggleFull2DMap,
}: AutonomousDrive3DViewProps) {
  return (
    <Drive3DView
      mode="autonomous"
      initialCameraMode={initialCameraMode}
      className={className}
      showMinimap={showMinimap}
      onToggleFull2DMap={onToggleFull2DMap}
    />
  )
}
