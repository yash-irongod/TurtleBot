import clsx from 'clsx'
import { useRobot } from '../context/RobotContext'
import { GlassPanel } from '../components/common/GlassPanel'
import { MicroLabel } from '../components/common/MicroLabel'
import { normalizeDeg } from '../lib/polar'
import { fixed } from '../lib/format'
import { healthColor, proximityHealth } from '../lib/health'
import type { LidarPoint } from '../types/robot'

const SECTOR_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function sectorMinimums(points: LidarPoint[], rangeMaxM: number): number[] {
  const mins = new Array(8).fill(rangeMaxM)
  for (const p of points) {
    const sector = Math.floor(normalizeDeg(p.angleDeg + 22.5) / 45) % 8
    if (p.distanceM < mins[sector]) mins[sector] = p.distanceM
  }
  return mins
}

export function SensorsView() {
  const { telemetry, environment } = useRobot()
  const { lidar, imu } = telemetry

  const sectors = sectorMinimums(lidar.points, lidar.rangeMaxM)
  const nearestIndex = sectors.indexOf(Math.min(...sectors))
  const nearestDistance = sectors[nearestIndex]

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
        <GlassPanel corners>
          <div className="flex items-center justify-between">
            <MicroLabel>Sector Proximity</MicroLabel>
            <span className="font-mono text-[11px] text-ink-500">
              {environment === 'demo' ? 'DEMO scan' : environment === 'live' ? 'Live scan' : 'Scan unavailable'} · {lidar.points.length} rays
            </span>
          </div>
          <div className="mt-4 space-y-2.5">
            {SECTOR_LABELS.map((label, i) => {
              const distance = sectors[i]
              const health = proximityHealth(distance)
              const widthPct = Math.min(100, (distance / lidar.rangeMaxM) * 100)
              return (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-7 shrink-0 font-mono text-[11px] text-ink-500">{label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className={clsx('h-full rounded-full transition-all duration-500 ease-out', healthColor[health].dot)}
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                  <span className={clsx('w-14 shrink-0 text-right font-mono text-[11px]', healthColor[health].text)}>
                    {fixed(distance, 2)} m
                  </span>
                </div>
              )
            })}
          </div>
        </GlassPanel>

        <div className="flex flex-col gap-4">
          <GlassPanel corners>
            <MicroLabel>Nearest Obstacle</MicroLabel>
            <div className="mt-2 flex items-baseline gap-2">
              <span className={clsx('font-mono text-2xl', healthColor[proximityHealth(nearestDistance)].text)}>
                {fixed(nearestDistance, 2)}
              </span>
              <span className="font-mono text-sm text-ink-500">m · bearing {SECTOR_LABELS[nearestIndex]}</span>
            </div>
          </GlassPanel>

          <GlassPanel corners className="flex-1">
            <MicroLabel>{environment === 'demo' ? 'IMU Model Axes' : 'IMU Axes'}</MicroLabel>
            <div className="mt-3 grid grid-cols-3 gap-3 font-mono text-[11px]">
              <AxisStat label="Accel X" value={`${fixed(imu.linearAcceleration.x, 2)} m/s²`} />
              <AxisStat label="Accel Y" value={`${fixed(imu.linearAcceleration.y, 2)} m/s²`} />
              <AxisStat label="Accel Z" value={`${fixed(imu.linearAcceleration.z, 2)} m/s²`} />
              <AxisStat label="Gyro X" value={`${fixed(imu.angularVelocity.x, 2)} rad/s`} />
              <AxisStat label="Gyro Y" value={`${fixed(imu.angularVelocity.y, 2)} rad/s`} />
              <AxisStat label="Gyro Z" value={`${fixed(imu.angularVelocity.z, 2)} rad/s`} />
            </div>
          </GlassPanel>
        </div>
      </div>
    </div>
  )
}

function AxisStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-ink-500">{label}</div>
      <div className="mt-0.5 text-ink-100">{value}</div>
    </div>
  )
}
