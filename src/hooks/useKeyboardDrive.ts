import { useEffect, useRef, useState } from 'react'
import type { DriveKey, VelocityCommand } from '../types/robot'
import { clamp } from '../lib/polar'
import { SAFE_ANGULAR_RADPS, SAFE_LINEAR_MPS, SAFE_REVERSE_MPS } from '../lib/safety'

function isDriveKey(key: string): key is DriveKey {
  return key === 'w' || key === 'a' || key === 's' || key === 'd'
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

function velocityFor(key: DriveKey): VelocityCommand {
  switch (key) {
    case 'w':
      return { linear: SAFE_LINEAR_MPS, angular: 0 }
    case 's':
      return { linear: -SAFE_REVERSE_MPS, angular: 0 }
    case 'a':
      return { linear: 0, angular: SAFE_ANGULAR_RADPS }
    case 'd':
      return { linear: 0, angular: -SAFE_ANGULAR_RADPS }
  }
}

interface UseKeyboardDriveOptions {
  /** Only listens while true — leaving Manual mode (or e-stop) attaches nothing. */
  enabled: boolean
  onCommand: (v: VelocityCommand) => void
  onRelease: () => void
}

/**
 * First-class WASD + space keyboard drive. A genuine new keydown is required
 * to create a command: held keys are forgotten whenever input is disabled,
 * the window loses focus, or the page is hidden. Callbacks are held in refs
 * so the listener always uses the current command boundary without repeated
 * attachment on every render.
 */
export function useKeyboardDrive({ enabled, onCommand, onRelease }: UseKeyboardDriveOptions) {
  const [activeKeys, setActiveKeys] = useState<ReadonlySet<DriveKey>>(new Set())
  const heldRef = useRef<Set<DriveKey>>(new Set())
  const callbacksRef = useRef({ onCommand, onRelease })

  useEffect(() => {
    callbacksRef.current = { onCommand, onRelease }
  }, [onCommand, onRelease])

  useEffect(() => {
    const stopAll = () => {
      heldRef.current.clear()
      setActiveKeys(new Set())
      callbacksRef.current.onRelease()
    }

    if (!enabled) {
      stopAll()
      return
    }

    const applyHeld = () => {
      setActiveKeys(new Set(heldRef.current))
      if (heldRef.current.size === 0) {
        callbacksRef.current.onRelease()
        return
      }

      let linear = 0
      let angular = 0
      for (const key of heldRef.current) {
        const command = velocityFor(key)
        linear += command.linear
        angular += command.angular
      }
      callbacksRef.current.onCommand({
        linear: clamp(linear, -SAFE_REVERSE_MPS, SAFE_LINEAR_MPS),
        angular: clamp(angular, -SAFE_ANGULAR_RADPS, SAFE_ANGULAR_RADPS),
      })
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      if (event.code === 'Space') {
        event.preventDefault()
        stopAll()
        return
      }
      // A key held through an e-stop reset must not re-arm via OS repeat.
      if (event.repeat) return
      const key = event.key.toLowerCase()
      if (!isDriveKey(key) || heldRef.current.has(key)) return
      event.preventDefault()
      heldRef.current.add(key)
      applyHeld()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!isDriveKey(key)) return
      heldRef.current.delete(key)
      applyHeld()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') stopAll()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', stopAll)
    window.addEventListener('pagehide', stopAll)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', stopAll)
      window.removeEventListener('pagehide', stopAll)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      stopAll()
    }
  }, [enabled])

  return { activeKeys }
}
