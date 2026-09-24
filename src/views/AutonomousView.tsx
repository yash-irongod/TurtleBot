import clsx from 'clsx'
import { useState, useEffect } from 'react'
import { Battery, Eye, Gauge, MapPin, Radar } from 'lucide-react'
import { useRobot } from '../context/RobotContext'
import { GlassPanel } from '../components/common/GlassPanel'
import { MicroLabel } from '../components/common/MicroLabel'
import { WorldMap } from '../components/map/WorldMap'
import { AutoExplorePanel } from '../components/map/AutoExplorePanel'
import { NavigationStatusPanel } from '../components/map/NavigationStatusPanel'
import { batteryHealth, healthColor, proximityHealth } from '../lib/health'
import { fixed, meters, metersPerSecond, percent } from '../lib/format'
import { isAutonomous3DActive } from '../lib/driveSelectors'
import { AutonomousDrive3DView } from '../components/drive3d/AutonomousDrive3DView'

function AutonomousReadout() {
  const { telemetry } = useRobot()
  const { battery, lidar, odometry } = telemetry
  const nearestObstacleM = lidar.points.length ? Math.min(...lidar.points.map((point) => point.distanceM)) : null
  const obstacleHealth = nearestObstacleM === null ? 'warning' : proximityHealth(nearestObstacleM)
  const batteryTone = batteryHealth(battery.percentage)

  return (
    <GlassPanel corners>
      <MicroLabel>Motion & clearance</MicroLabel>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 font-mono text-[12px]">
        <Readout icon={Gauge} label="Velocity" value={metersPerSecond(odometry.linearVelocity)} />
        <Readout icon={Battery} label="Battery" value={percent(battery.percentage)} tone={batteryTone} />
        <Readout
          icon={MapPin}
          label="Pose"
          value={`${fixed(odometry.position.x, 2)}, ${fixed(odometry.position.y, 2)}`}
        />
        <Readout
          icon={Radar}
          label="Nearest obstacle"
          value={nearestObstacleM === null ? 'Unavailable' : meters(nearestObstacleM)}
          tone={obstacleHealth}
        />
      </dl>

      <div className="mt-3 border-t border-white/[0.06] pt-2.5 font-mono text-[10px] leading-relaxed text-ink-500">
        <span className={clsx('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', healthColor[telemetry.lidarHealth].dot)} />
        LiDAR {telemetry.lidarHealth === 'nominal' ? 'available' : telemetry.lidarHealth} · heading {Math.round(odometry.headingDeg)}°
      </div>
    </GlassPanel>
  )
}

function Readout({
  icon: Icon,
  label,
  value,
  tone = 'nominal',
}: {
  icon: typeof Gauge
  label: string
  value: string
  tone?: 'nominal' | 'warning' | 'critical'
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.08em] text-ink-500">
        <Icon className="h-3 w-3" strokeWidth={1.75} />
        {label}
      </dt>
      <dd className={clsx('mt-1 truncate text-[12px]', tone === 'nominal' ? 'text-ink-100' : healthColor[tone].text)}>{value}</dd>
    </div>
  )
}

/** The primary workspace: 2D SLAM/Nav2 map that smoothly engages 3D Chase Cam when navigating. */
export function AutonomousView() {
  const { sourceStatus, activeMode, emergencyStopped, navigation, exploration } = useRobot()
  const is3DActive = isAutonomous3DActive({ sourceStatus, activeMode, emergencyStopped, navigation, exploration })
  const [operatorOverride2D, setOperatorOverride2D] = useState(false)

  // Reset override whenever active navigation route resets
  useEffect(() => {
    if (!is3DActive) {
      setOperatorOverride2D(false)
    }
  }, [is3DActive])

  const show3D = is3DActive && !operatorOverride2D

  return (
    <div className="grid h-full min-h-0 gap-3 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_310px]">
      <section className="relative min-h-[280px] min-w-0" aria-label="Autonomous workspace">
        {show3D ? (
          <AutonomousDrive3DView
            onToggleFull2DMap={() => setOperatorOverride2D(true)}
          />
        ) : (
          <div className="relative h-full w-full">
            <WorldMap />
            {is3DActive && operatorOverride2D && (
              <button
                type="button"
                onClick={() => setOperatorOverride2D(false)}
                className="absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-lg border border-signal-400/40 bg-void-950/85 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-signal-300 shadow-xl backdrop-blur-md hover:bg-signal-900/60"
                title="Return to 3D Chase Cam"
              >
                <Eye className="h-3.5 w-3.5" />
                <span>Return to 3D Chase Cam</span>
              </button>
            )}
          </div>
        )}
      </section>
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5" aria-label="Autonomous navigation status">
        <AutoExplorePanel />
        <NavigationStatusPanel />
        <AutonomousReadout />
        <p className="px-1 font-mono text-[10px] leading-relaxed text-ink-500">
          Autonomous controls connect directly to ROS 2 Nav2 and Frontier Explorer in LIVE mode, and run the simulated navigation model in DEMO mode.
        </p>
      </aside>
    </div>
  )
}
