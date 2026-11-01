import { useEffect, useRef, useState } from 'react'
import type { DriveKey, VelocityCommand } from '../types/robot'
import { clamp } from '../lib/polar'
import { SAFE_ANGULAR_RADPS, SAFE_LINEAR_MPS, SAFE_REVERSE_MPS } from '../lib/safety'

function toDriveKey(event: KeyboardEvent): DriveKey | null {
  const key = event.key.toLowerCase()
  const code = event.code
  if (key === 'w' || code === 'KeyW' || key === 'arrowup' || code === 'ArrowUp') return 'w'
  if (key === 's' || code === 'KeyS' || key === 'arrowdown' || code === 'ArrowDown') return 's'
  if (key === 'a' || code === 'KeyA' || key === 'arrowleft' || code === 'ArrowLeft') return 'a'
  if (key === 'd' || code === 'KeyD' || key === 'arrowright' || code === 'ArrowRight') return 'd'
  return null
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
  onSpace?: () => void
}

/**
 * First-class WASD + arrow keys + space keyboard drive.
 * A genuine keydown initiates motion. While keys are held down, OS repeat
 * refreshes the command intent to ensure continuous velocity streaming.
 * Callbacks are held in refs so the listener always uses the current command boundary.
 */
export function useKeyboardDrive({ enabled, onCommand, onRelease, onSpace }: UseKeyboardDriveOptions) {
  const [activeKeys, setActiveKeys] = useState<ReadonlySet<DriveKey>>(new Set())
  const heldRef = useRef<Set<DriveKey>>(new Set())
  const callbacksRef = useRef({ onCommand, onRelease, onSpace })

  useEffect(() => {
    callbacksRef.current = { onCommand, onRelease, onSpace }
  }, [onCommand, onRelease, onSpace])

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
        callbacksRef.current.onSpace?.()
        return
      }

      const driveKey = toDriveKey(event)
      if (!driveKey) return

      event.preventDefault()

      if (event.repeat) {
        // If the drive key is held, re-apply commands to keep manual lease alive
        if (heldRef.current.has(driveKey)) {
          applyHeld()
        }
        return
      }

      heldRef.current.add(driveKey)
      applyHeld()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      const driveKey = toDriveKey(event)
      if (!driveKey) return
      heldRef.current.delete(driveKey)
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
