import clsx from 'clsx'
import type { ReactNode } from 'react'

/** Small tracked-out uppercase label — reserved for instrument field names, not body copy. */
export function MicroLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono text-micro uppercase tracking-[0.14em] text-ink-500', className)}>{children}</span>
}
