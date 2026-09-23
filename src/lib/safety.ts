/**
 * TurtleBot3 Burger is rated for roughly 0.22 m/s / ~2.84 rad/s at full
 * throttle. These are the limits this app is allowed to command — kept
 * comfortably under the rated max for exhibition/demo safety around people
 * and obstacles. If the real hardware needs more, raise it here — this is
 * the one place a commanded-velocity ceiling should ever be defined.
 */
export const SAFE_LINEAR_MPS = 0.18
export const SAFE_ANGULAR_RADPS = 1.0
/** Reversing blind is riskier than driving forward, so it gets its own, lower ceiling. */
export const SAFE_REVERSE_MPS = SAFE_LINEAR_MPS * 0.7
