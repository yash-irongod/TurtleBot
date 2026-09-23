import type { ComponentType } from 'react'
import { useRobot } from '../context/RobotContext'
import { SegmentedControl } from '../components/common/SegmentedControl'
import { ViewHeader } from '../components/common/ViewHeader'
import { EnvironmentTag } from '../components/common/EnvironmentTag'
import { RobotView } from './RobotView'
import { SensorsView } from './SensorsView'
import { DiagnosticsView } from './DiagnosticsView'
import type { SystemPanel } from '../types/robot'

const PANELS: Record<SystemPanel, ComponentType> = {
  ROBOT: RobotView,
  SENSORS: SensorsView,
  DIAGNOSTICS: DiagnosticsView,
}

/** Useful to the operator, but secondary to day-to-day operation — see spec §18. */
export function SystemView() {
  const { systemPanel, setSystemPanel, environment, sourceStatus } = useRobot()
  const ActivePanel = PANELS[systemPanel]
  const description = sourceStatus === 'LIVE'
    ? 'Live hardware state, sensor condition, and ROS bridge diagnostics.'
    : sourceStatus === 'DEMO'
      ? 'Simulated hardware state and local diagnostics for the DEMO source.'
      : 'Connection state and local diagnostics while the ROS source is unavailable.'

  return (
    <div className="flex h-full min-h-0 flex-col p-3 sm:p-4">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <ViewHeader title="System" description={description} />
          <EnvironmentTag environment={environment} className="mt-0.5" />
        </div>
        <SegmentedControl
          value={systemPanel}
          onChange={setSystemPanel}
          options={[
            { value: 'ROBOT', label: 'Robot' },
            { value: 'SENSORS', label: 'Sensors' },
            { value: 'DIAGNOSTICS', label: 'Diagnostics' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">
        <ActivePanel />
      </div>
    </div>
  )
}
