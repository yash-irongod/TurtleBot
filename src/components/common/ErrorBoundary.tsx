import { Component, type ReactNode } from 'react'
import { OctagonAlert, RotateCcw } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Custom fallback UI shown instead of the default error panel. */
  fallback?: ReactNode
  /** Short label shown in the default fallback panel header. */
  label?: string
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * React error boundary that intercepts rendering failures and displays a
 * styled fallback panel that matches the app's dark design language.
 * Supports a "Retry" button that resets the boundary and re-attempts rendering.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught rendering error:', error, info.componentStack)
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    if (this.props.fallback) return this.props.fallback

    const label = this.props.label ?? 'View Unavailable'

    return (
      <div className="flex h-full w-full items-center justify-center rounded-xl border border-critical-500/20 bg-void-950 p-6">
        <div className="flex max-w-xs flex-col items-center gap-4 text-center">
          <OctagonAlert className="h-9 w-9 text-critical-400" strokeWidth={1.5} />
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-critical-400">
              {label}
            </p>
            {this.state.error && (
              <p className="mt-2 max-w-[260px] break-words font-mono text-[10px] leading-relaxed text-ink-500">
                {this.state.error.message}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-300 transition-colors hover:border-signal-400/40 hover:bg-signal-900/20 hover:text-signal-300"
          >
            <RotateCcw className="h-3 w-3" strokeWidth={1.75} />
            Retry
          </button>
        </div>
      </div>
    )
  }
}
