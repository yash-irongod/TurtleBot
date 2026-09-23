import clsx from 'clsx'
import { Compass, Radar, Satellite } from 'lucide-react'
import { useRobot } from '../../context/RobotContext'
import { GlassPanel } from '../common/GlassPanel'
import { MicroLabel } from '../common/MicroLabel'
import { StatusTile } from '../common/StatusTile'
import { batteryHealth, healthColor, proximityHealth } from '../../lib/health'
import { fixed, meters, metersPerSecond, percent, radiansPerSecond } from '../../lib/format'
import type { DataEnvironment, HealthLevel } from '../../types/robot'

function sourceCopy(environment: DataEnvironment) {
  if (environment === 'demo') return { lidarLabel: 'LiDAR model', imuLabel: 'IMU model', rosLabel: 'Not connected' }
  if (environment === 'live') return { lidarLabel: 'LiDAR', imuLabel: 'IMU', rosLabel: 'Connected' }
  return { lidarLabel: 'LiDAR', imuLabel: 'IMU', rosLabel: 'Unavailable' }
}

function sourceHealth(environment: DataEnvironment): HealthLevel {
  return environment === 'offline' ? 'critical' : environment === 'live' ? 'nominal' : 'warning'
}

function Readout({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt>
        <MicroLabel>{label}</MicroLabel>
      </dt>
      <dd className="mt-1 truncate font-mono text-[12px] text-ink-100">{value}</dd>
      {detail && <div className="mt-0.5 truncate font-mono text-[10px] text-ink-500">{detail}</div>}
    </div>
  )
}

/**
 * Command's intentionally compact operator summary. Detailed motors,
 * temperature, and reference hardware belong on System; this column stays
 * focused on what affects the next decision.
 */
export function TelemetryPanel() {
  const { telemetry, environment } = useRobot()
  const { battery, odometry, lidar, imu, lidarHealth } = telemetry
  const nearestObstacleM = lidar.points.length ? Math.min(...lidar.points.map((point) => point.distanceM)) : null
  const battHealth = batteryHealth(battery.percentage)
  const clearanceHealth = nearestObstacleM === null ? 'warning' : proximityHealth(nearestObstacleM)
  const labels = sourceCopy(environment)
  const rosHealth = sourceHealth(environment)

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto pr-0.5">
      <GlassPanel>
        <div className="flex items-center justify-between gap-3">
          <MicroLabel>Primary telemetry</MicroLabel>
          <span className={clsx('font-mono text-[13px]', healthColor[battHealth].text)}>{percent(battery.percentage)}</span>
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between gap-3">
            <MicroLabel>Battery</MicroLabel>
            <span className="font-mono text-[10px] text-ink-500">
              {fixed(battery.voltage, 2)} V · {fixed(battery.current, 2)} A
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={clsx('h-full rounded-full transition-[width] duration-500 ease-out', healthColor[battHealth].dot)}
              style={{ width: `${battery.percentage}%` }}
            />
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-3">
          <Readout label="Motion" value={metersPerSecond(odometry.linearVelocity)} detail={radiansPerSecond(odometry.angularVelocity)} />
          <Readout
            label="Pose / heading"
            value={`X ${fixed(odometry.position.x, 2)} · Y ${fixed(odometry.position.y, 2)}`}
            detail={`${Math.round(odometry.headingDeg)}° map frame`}
          />
        </dl>
      </GlassPanel>

      <GlassPanel>
        <div className="flex items-center justify-between gap-3">
          <MicroLabel>Sensor context</MicroLabel>
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-500">
            {environment === 'demo' ? 'Demo source' : environment === 'live' ? 'Live source' : 'No source'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <StatusTile
            label={labels.lidarLabel}
            health={lidarHealth}
            value={lidarHealth === 'nominal' ? 'Available' : lidarHealth}
            icon={<Radar className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={environment === 'live'}
          />
          <StatusTile
            label="Clearance"
            health={clearanceHealth}
            value={nearestObstacleM === null ? 'No scan' : meters(nearestObstacleM)}
            icon={<Radar className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={environment === 'live'}
          />
          <StatusTile
            label={labels.imuLabel}
            health="nominal"
            value={`${Math.round(imu.yaw)}° yaw`}
            icon={<Compass className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={environment === 'live'}
          />
          <StatusTile
            label="ROS 2"
            health={rosHealth}
            value={labels.rosLabel}
            icon={<Satellite className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={environment === 'live'}
          />
        </div>
      </GlassPanel>
    </div>
  )
}
