import clsx from 'clsx'
import { useRobot } from '../context/RobotContext'
import { GlassPanel } from '../components/common/GlassPanel'
import { EnvironmentTag } from '../components/common/EnvironmentTag'
import { MicroLabel } from '../components/common/MicroLabel'
import { Sparkline } from '../components/common/Sparkline'
import { RobotGlyph } from '../components/robot/RobotGlyph'
import { AttitudeIndicator } from '../components/robot/AttitudeIndicator'
import { useHistory } from '../hooks/useHistory'
import { clamp, normalizeDeg } from '../lib/polar'
import { celsius, fixed, percent } from '../lib/format'
import { batteryHealth, healthColor } from '../lib/health'

const MOTOR_RPM_SCALE = 130

export function RobotView() {
  const { telemetry, environment } = useRobot()
  const { imu, odometry, motors, battery } = telemetry

  const leftRpmHistory = useHistory(motors[0]?.rpm ?? 0, 30)
  const rightRpmHistory = useHistory(motors[1]?.rpm ?? 0, 30)
  const battHealth = batteryHealth(battery.percentage)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-0">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <GlassPanel corners>
          <div className="flex items-center justify-between gap-3">
            <MicroLabel>Orientation</MicroLabel>
            <EnvironmentTag environment={environment} />
          </div>
          <div className="mt-4 flex items-center gap-6">
            <AttitudeIndicator rollDeg={imu.roll} pitchDeg={imu.pitch} />
            <div className="grid flex-1 grid-cols-3 gap-3">
              <Axis label="Roll" value={imu.roll} />
              <Axis label="Pitch" value={imu.pitch} />
              <Axis label="Yaw" value={imu.yaw} wrap />
            </div>
          </div>
        </GlassPanel>

        <GlassPanel corners className="flex items-center gap-5">
          <div className="relative flex h-[132px] w-[132px] shrink-0 items-center justify-center rounded-full border border-white/[0.08]">
            <div className="absolute inset-0 rounded-full bg-signal-500/[0.06] blur-lg" />
            <div style={{ transform: `rotate(${odometry.headingDeg}deg)`, transition: 'transform 280ms ease-out' }}>
              <RobotGlyph size={78} />
            </div>
          </div>
          <div className="space-y-1.5 font-mono text-[11px] text-ink-300">
            <MicroLabel>Reference platform</MicroLabel>
            <SpecLine label="Frame" value="TurtleBot3 Burger" />
            <SpecLine label="Drive" value="Differential, 2-wheel" />
            <SpecLine label="Sensors" value="360° LiDAR · IMU · Odometry" />
            <SpecLine label="Compute" value="Raspberry Pi 4 + OpenCR" />
          </div>
        </GlassPanel>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <GlassPanel corners>
          <div className="flex items-center justify-between">
            <MicroLabel>Motor Detail</MicroLabel>
            {motors.length === 0 && (
              <span className="font-mono text-[9px] uppercase tracking-wider text-ink-500">
                Awaiting Telemetry
              </span>
            )}
          </div>
          {motors.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <MotorDetail
                label={motors[0]?.label ?? 'LEFT WHEEL'}
                rpm={motors[0]?.rpm ?? 0}
                temp={motors[0]?.temperatureC ?? 0}
                history={leftRpmHistory}
              />
              <MotorDetail
                label={motors[1]?.label ?? 'RIGHT WHEEL'}
                rpm={motors[1]?.rpm ?? 0}
                temp={motors[1]?.temperatureC ?? 0}
                history={rightRpmHistory}
              />
            </div>
          ) : (
            <div className="mt-4 flex flex-col items-center justify-center py-6 text-center border border-dashed border-white/[0.08] rounded-lg bg-white/[0.01]">
              <span className="font-mono text-[11px] text-ink-300">No /joint_states or motor telemetry published</span>
              <span className="mt-1 font-mono text-[9px] text-ink-500">
                Live motor RPM & temperatures are unavailable until published by the ROS bridge
              </span>
            </div>
          )}
        </GlassPanel>

        <GlassPanel corners>
          <div className="flex items-center justify-between">
            <MicroLabel>Battery Detail</MicroLabel>
            <span className={clsx('font-mono text-sm', healthColor[battHealth].text)}>{percent(battery.percentage)}</span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={clsx('h-full rounded-full transition-all duration-700 ease-out', healthColor[battHealth].dot)}
              style={{ width: `${battery.percentage}%` }}
            />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 font-mono text-[12px] text-ink-300">
            <div>
              <MicroLabel>Voltage</MicroLabel>
              <div className="mt-0.5 text-ink-100">{fixed(battery.voltage, 2)} V</div>
            </div>
            <div>
              <MicroLabel>Current</MicroLabel>
              <div className="mt-0.5 text-ink-100">{fixed(battery.current, 2)} A</div>
            </div>
            <div>
              <MicroLabel>Pack</MicroLabel>
              <div className="mt-0.5 text-ink-100">3S Li-Po</div>
            </div>
          </div>
        </GlassPanel>
      </div>
    </div>
  )
}

function Axis({ label, value, wrap }: { label: string; value: number; wrap?: boolean }) {
  const display = wrap ? Math.round(normalizeDeg(value)) : fixed(value, 1)
  return (
    <div>
      <MicroLabel>{label}</MicroLabel>
      <div className="mt-0.5 font-mono text-[13px] text-ink-100">{display}°</div>
    </div>
  )
}

function SpecLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-ink-500">{label}</span>
      <span className="text-ink-100">{value}</span>
    </div>
  )
}

function MotorDetail({ label, rpm, temp, history }: { label: string; rpm: number; temp: number; history: number[] }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-ink-300">{label}</span>
        <span className="font-mono text-[11px] text-ink-100">{Math.round(rpm)} RPM</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full bg-signal-400/70 transition-all duration-500 ease-out"
          style={{ width: `${clamp((rpm / MOTOR_RPM_SCALE) * 100, 2, 100)}%` }}
        />
      </div>
      <Sparkline values={history} width={140} height={26} tone="signal" className="mt-2" />
      <div className="mt-1 font-mono text-[10px] text-ink-500">{celsius(temp)}</div>
    </div>
  )
}
