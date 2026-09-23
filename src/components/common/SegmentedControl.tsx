import clsx from 'clsx'

interface SegmentedControlProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  className?: string
}

export function SegmentedControl<T extends string>({ value, onChange, options, className }: SegmentedControlProps<T>) {
  return (
    <div className={clsx('inline-flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5', className)}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={clsx(
              'rounded-md px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-all duration-150',
              active ? 'bg-signal-900/50 text-signal-300 shadow-glow-sm' : 'text-ink-500 hover:text-ink-100',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
