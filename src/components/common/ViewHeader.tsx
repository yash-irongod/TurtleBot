import clsx from 'clsx'

interface ViewHeaderProps {
  title: string
  description?: string
  className?: string
}

export function ViewHeader({ title, description, className }: ViewHeaderProps) {
  return (
    <div className={clsx('min-w-0 shrink-0', className)}>
      <h1 className="text-[16px] font-semibold tracking-tight text-ink-100">{title}</h1>
      {description && <p className="mt-1 max-w-2xl text-[12px] leading-5 text-ink-500 sm:text-[13px]">{description}</p>}
    </div>
  )
}
