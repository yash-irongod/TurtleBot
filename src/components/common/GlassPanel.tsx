import clsx from 'clsx'
import type { ReactNode } from 'react'

interface GlassPanelProps {
  children: ReactNode
  className?: string
  padded?: boolean
  tone?: 'neutral' | 'signal' | 'amber' | 'critical'
  /** Adds quiet viewfinder-style corner brackets — reserved for the spatial/instrument panels. */
  corners?: boolean
}

const toneBorder: Record<NonNullable<GlassPanelProps['tone']>, string> = {
  neutral: 'border-white/[0.07]',
  signal: 'border-signal-400/25',
  amber: 'border-amber-400/30',
  critical: 'border-critical-500/40',
}

const cornerClass = 'absolute h-3 w-3 border-signal-400/40'

/**
 * The shared instrument surface: mostly opaque, with a hairline border and a
 * restrained inner highlight. The slight blur keeps layered map panels legible
 * without turning the console into a glassmorphism-heavy dashboard.
 */
export function GlassPanel({ children, className, padded = true, tone = 'neutral', corners = false }: GlassPanelProps) {
  return (
    <div
      className={clsx(
        'relative rounded-lg border bg-void-900/[0.84] shadow-panel backdrop-blur-xs',
        toneBorder[tone],
        padded && 'p-3 sm:p-4',
        className,
      )}
    >
      {corners && (
        <>
          <span className={clsx(cornerClass, 'pointer-events-none left-2.5 top-2.5 border-l border-t')} aria-hidden="true" />
          <span className={clsx(cornerClass, 'pointer-events-none right-2.5 top-2.5 border-r border-t')} aria-hidden="true" />
          <span className={clsx(cornerClass, 'pointer-events-none bottom-2.5 left-2.5 border-b border-l')} aria-hidden="true" />
          <span className={clsx(cornerClass, 'pointer-events-none bottom-2.5 right-2.5 border-b border-r')} aria-hidden="true" />
        </>
      )}
      {children}
    </div>
  )
}
