import type { ComponentType } from 'react'
import { RobotProvider, useRobot } from './context/RobotContext'
import { TopBar } from './components/layout/TopBar'
import { NavRail } from './components/layout/NavRail'
import { ControlDeck } from './components/controls/ControlDeck'
import { CommandView } from './views/CommandView'
import { AutonomousView } from './views/AutonomousView'
import { ManualView } from './views/ManualView'
import { PuppyView } from './views/PuppyView'
import { SystemView } from './views/SystemView'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import type { NavSection } from './types/robot'

import { useEffect, useState } from 'react'
import { mockRobotDataSource } from './data/mockTelemetry'
import { rosRobotDataSource } from './data/rosRobotDataSource'
import type { RobotDataSource } from './types/robot'

const VIEWS: Record<NavSection, ComponentType> = {
  COMMAND: CommandView,
  AUTONOMOUS: AutonomousView,
  MANUAL: ManualView,
  PUPPY: PuppyView,
  SYSTEM: SystemView,
}

function resolveInitialDataSource(): RobotDataSource {
  if (typeof window === 'undefined') return mockRobotDataSource
  const urlParam = new URLSearchParams(window.location.search).get('source')?.toLowerCase()
  if (urlParam === 'live') return rosRobotDataSource
  if (urlParam === 'demo') return mockRobotDataSource
  const stored = localStorage.getItem('turtlebot_data_source')
  if (stored === 'live') return rosRobotDataSource
  return mockRobotDataSource
}

function Shell() {
  const { activeSection } = useRobot()
  const ActiveView = VIEWS[activeSection] ?? CommandView

  return (
    <div className="app-shell relative flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden bg-void-950 text-ink-100">
      <div className="command-bg" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <NavRail />
          <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden lg:overflow-hidden" aria-label="Operator workspace">
            <div className="h-full min-h-0 animate-fade-in">
              {/* Per-view error boundary: a crash in one view never blacks out the whole shell */}
              <ErrorBoundary key={activeSection} label={`${activeSection} View Error`}>
                <ActiveView />
              </ErrorBoundary>
            </div>
          </main>
        </div>
        <ControlDeck />
      </div>
    </div>
  )
}

export default function App() {
  const [dataSource, setDataSource] = useState<RobotDataSource>(resolveInitialDataSource)

  useEffect(() => {
    const handleSourceChange = () => {
      setDataSource(resolveInitialDataSource())
    }
    window.addEventListener('storage', handleSourceChange)
    window.addEventListener('turtlebot_source_change', handleSourceChange)
    return () => {
      window.removeEventListener('storage', handleSourceChange)
      window.removeEventListener('turtlebot_source_change', handleSourceChange)
    }
  }, [])

  return (
    <RobotProvider dataSource={dataSource}>
      {/* Global boundary: if RobotProvider itself fails, show a top-level message */}
      <ErrorBoundary label="Application Error">
        <Shell />
      </ErrorBoundary>
    </RobotProvider>
  )
}
