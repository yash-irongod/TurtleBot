import { Activity, BatteryCharging, Compass, Radar, Satellite } from 'lucide-react'
import { useRobot } from '../context/RobotContext'
import { GlassPanel } from '../components/common/GlassPanel'
import { MicroLabel } from '../components/common/MicroLabel'
import { StatusTile } from '../components/common/StatusTile'
import { EnvironmentTag } from '../components/common/EnvironmentTag'
import { formatDuration } from '../lib/format'
import { batteryHealth } from '../lib/health'
import type { DataEnvironment, HealthLevel } from '../types/robot'

interface SourceNote {
  label: string
  detail: string
}

function sourceNotes(environment: DataEnvironment): SourceNote[] {
  if (environment === 'demo') {
    return [
      { label: 'SOURCE', detail: 'Browser-local DEMO source is supplying generated telemetry snapshots.' },
      { label: 'ROS 2', detail: 'No ROS bridge, Nav2 stack, or hardware command transport is connected.' },
      { label: 'MODELS', detail: 'Map, LiDAR, IMU, and navigation progress are local presentation models.' },
    ]
  }
  if (environment === 'live') {
    return [
      { label: 'SOURCE', detail: 'Values are supplied by the active live data source.' },
      { label: 'STATUS', detail: 'Navigation and telemetry state come from the connected integration boundary.' },
    ]
  }
  return [
    { label: 'SOURCE', detail: 'No data source is connected to this console.' },
    { label: 'CONTROLS', detail: 'Motion commands remain inhibited until a source is available.' },
  ]
}

function sourceHealth(environment: DataEnvironment): HealthLevel {
  return environment === 'offline' ? 'critical' : 'nominal'
}

export function DiagnosticsView() {
  const { telemetry, sessionStartedAt, environment } = useRobot()
  const { lidar, lidarHealth, network, imu, battery, rosHealth } = telemetry
  const isDemo = environment === 'demo'
  const transportConnected = environment === 'live' && network.rosbridgeConnected
  const transportHealth: HealthLevel = environment === 'offline' ? 'critical' : transportConnected ? rosHealth : 'warning'
  const notes = sourceNotes(environment)

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      <GlassPanel corners className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-signal-400" strokeWidth={1.75} />
          <MicroLabel>Console session</MicroLabel>
        </div>
        <div className="flex items-center gap-3">
          <EnvironmentTag environment={environment} />
          <span className="font-mono text-lg text-ink-100">{formatDuration(telemetry.timestamp - sessionStartedAt)}</span>
        </div>
      </GlassPanel>

      <GlassPanel corners>
        <MicroLabel>Data-source condition</MicroLabel>
        <div className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <StatusTile
            label="Data source"
            health={sourceHealth(environment)}
            value={isDemo ? 'Local DEMO' : environment === 'live' ? 'Live source' : 'Unavailable'}
            icon={<Satellite className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={environment === 'live'}
          />
          <StatusTile
            label="ROS 2 transport"
            health={transportHealth}
            value={isDemo ? 'Not connected' : transportConnected ? 'Connected' : 'Unavailable'}
            icon={<Satellite className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={transportConnected}
          />
          <StatusTile
            label={isDemo ? 'LiDAR model' : 'LiDAR'}
            health={lidarHealth}
            value={isDemo ? `${lidar.points.length} rays` : lidarHealth === 'nominal' ? 'Available' : lidarHealth}
            icon={<Radar className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={environment === 'live'}
          />
          <StatusTile
            label={isDemo ? 'IMU model' : 'IMU'}
            health="nominal"
            value={`${Math.round(imu.yaw)}° yaw`}
            icon={<Compass className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={environment === 'live'}
          />
          <StatusTile
            label={isDemo ? 'Battery model' : 'Battery'}
            health={batteryHealth(battery.percentage)}
            value={`${Math.round(battery.percentage)}%`}
            icon={<BatteryCharging className="h-3 w-3 text-ink-500" strokeWidth={1.75} />}
            pulse={environment === 'live'}
          />
        </div>
      </GlassPanel>

      <GlassPanel corners className="flex-1">
        <div className="flex items-center justify-between gap-3">
          <MicroLabel>Integration notes</MicroLabel>
          <EnvironmentTag environment={environment} />
        </div>
        <div className="mt-3 space-y-2.5">
          {notes.map((note) => (
            <div key={note.label} className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-3 font-mono text-[11px] leading-relaxed">
              <span className="text-ink-500">{note.label}</span>
              <span className="text-ink-300">{note.detail}</span>
            </div>
          ))}
        </div>
      </GlassPanel>
    </div>
  )
}
