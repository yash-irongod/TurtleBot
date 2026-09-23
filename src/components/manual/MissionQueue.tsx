import clsx from 'clsx'
import { CircleCheck, CirclePause, CirclePlay, Clock, type LucideIcon } from 'lucide-react'
import { GlassPanel } from '../common/GlassPanel'
import { MISSIONS } from '../../data/missions'
import { healthColor } from '../../lib/health'
import type { HealthLevel, Mission } from '../../types/robot'

const STATUS_META: Record<Mission['status'], { label: string; icon: LucideIcon; health: HealthLevel }> = {
  running: { label: 'Running', icon: CirclePlay, health: 'nominal' },
  queued: { label: 'Queued', icon: Clock, health: 'warning' },
  paused: { label: 'Paused', icon: CirclePause, health: 'warning' },
  complete: { label: 'Complete', icon: CircleCheck, health: 'nominal' },
}

/** Full competition system (checkpoints, timer, leaderboard) is future work — this is the queue shell. */
export function MissionQueue() {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5">
      {MISSIONS.map((mission) => {
        const meta = STATUS_META[mission.status]
        const Icon = meta.icon
        const progress = mission.steps === 0 ? 0 : (mission.stepsComplete / mission.steps) * 100

        return (
          <GlassPanel key={mission.id} corners>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Icon className={clsx('h-4 w-4', healthColor[meta.health].text)} strokeWidth={1.75} />
                <span className="font-mono text-sm text-ink-100">{mission.name}</span>
              </div>
              <span className={clsx('font-mono text-[10px] uppercase tracking-wide', healthColor[meta.health].text)}>
                {meta.label}
              </span>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={clsx('h-full rounded-full transition-all duration-500 ease-out', healthColor[meta.health].dot)}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-ink-500">
              <span>
                {mission.stepsComplete} / {mission.steps} steps
              </span>
              <span>{mission.status === 'complete' ? 'Done' : `ETA ${mission.etaMin} min`}</span>
            </div>
          </GlassPanel>
        )
      })}
    </div>
  )
}
