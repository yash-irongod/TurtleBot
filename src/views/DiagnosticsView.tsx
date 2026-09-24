import { Activity, BatteryCharging, Compass, Radar, Satellite, Wifi, Check, RefreshCw } from 'lucide-react'
import { useState, useEffect } from 'react'
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
      { label: 'SOURCE', detail: 'Values are supplied by the active live ROS 2 bridge data source.' },
      { label: 'STATUS', detail: 'Real-time navigation, SLAM /map, and designated boundary streams from ROS.' },
      { label: 'BOUNDARY', detail: 'Designated holographic boundary walls are constructed in real-time from the real ROS map.' },
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
  const { telemetry, sessionStartedAt, environment, bridgeUrl, setBridgeUrl } = useRobot()
  const { lidar, lidarHealth, network, imu, battery, rosHealth } = telemetry
  const isDemo = environment === 'demo'
  const transportConnected = environment === 'live' && network.rosbridgeConnected
  const transportHealth: HealthLevel = environment === 'offline' ? 'critical' : transportConnected ? rosHealth : 'warning'
  const notes = sourceNotes(environment)

  const [inputUrl, setInputUrl] = useState(bridgeUrl)
  const [justApplied, setJustApplied] = useState(false)

  useEffect(() => {
    setInputUrl(bridgeUrl)
  }, [bridgeUrl])

  const handleApplyUrl = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!inputUrl.trim()) return
    setBridgeUrl(inputUrl.trim())
    setJustApplied(true)
    setTimeout(() => setJustApplied(false), 2000)
  }

  const handlePreset = (url: string) => {
    setInputUrl(url)
    setBridgeUrl(url)
    setJustApplied(true)
    setTimeout(() => setJustApplied(false), 2000)
  }

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

      {/* ROS 2 Bridge Endpoint Configuration Card */}
      <GlassPanel corners>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-signal-400" strokeWidth={1.75} />
            <MicroLabel>ROS 2 Bridge Endpoint (Ubuntu Laptop / Host)</MicroLabel>
          </div>
          <span
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
              transportConnected
                ? 'border-signal-400/40 bg-signal-900/40 text-signal-300'
                : environment === 'live'
                ? 'border-amber-400/40 bg-amber-950/40 text-amber-300'
                : 'border-white/[0.1] bg-white/[0.03] text-ink-400'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                transportConnected ? 'bg-signal-400' : environment === 'live' ? 'bg-amber-400 animate-pulse' : 'bg-ink-500'
              }`}
            />
            {transportConnected
              ? 'Bridge Connected'
              : environment === 'live'
              ? 'Connecting to ROS...'
              : 'Demo Mode (Click Live to connect)'}
          </span>
        </div>

        <form onSubmit={handleApplyUrl} className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[280px] flex-1">
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="ws://localhost:8765 or ws://<laptop-ip>:8765"
              className="w-full rounded-md border border-white/[0.12] bg-void-950/90 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-600 focus:border-signal-400 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="flex items-center gap-1.5 rounded-md border border-signal-400/40 bg-signal-900/50 px-3 py-1.5 font-mono text-xs font-medium text-signal-300 transition-colors hover:bg-signal-900/80 active:scale-[0.98]"
          >
            {justApplied ? <Check className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {justApplied ? 'Saved & Connecting' : 'Connect / Apply'}
          </button>
        </form>

        <div className="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-ink-400">
          <span className="text-ink-500">Presets:</span>
          <button
            type="button"
            onClick={() => handlePreset('ws://localhost:8765')}
            className="rounded border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 hover:border-signal-400/40 hover:bg-signal-900/30 hover:text-signal-200"
          >
            Ubuntu Laptop Local (ws://localhost:8765)
          </button>
          <button
            type="button"
            onClick={() => handlePreset('ws://192.168.0.112:8765')}
            className="rounded border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 hover:border-signal-400/40 hover:bg-signal-900/30 hover:text-signal-200"
          >
            Default VM (ws://192.168.0.112:8765)
          </button>
        </div>

        <div className="mt-3 rounded border border-white/[0.06] bg-void-950/50 p-2.5 font-mono text-[10px] leading-relaxed text-ink-400">
          <span className="text-signal-400 font-semibold">Ubuntu Setup Note:</span> Start the Python bridge with{' '}
          <code className="rounded bg-white/[0.06] px-1 py-0.5 text-ink-200">python3 ~/turtlebot_bridge/bridge.py</code>. If running
          this app in a remote browser over HTTPS, browsers block insecure WebSocket connections (<code className="text-amber-300">ws://</code>) due to mixed-content security. Run the app locally via{' '}
          <code className="rounded bg-white/[0.06] px-1 py-0.5 text-ink-200">npm run dev</code> on{' '}
          <code className="text-signal-300">http://localhost:3000</code> or use a secure tunnel (e.g. cloudflared, ngrok) to connect directly to your laptop!
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
