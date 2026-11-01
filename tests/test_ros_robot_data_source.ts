import assert from 'node:assert/strict'
import test from 'node:test'
import { createRosRobotDataSource } from '../src/data/rosRobotDataSource.ts'

// Provide minimal window shim for Node environment
const mockStorage = {
  getItem: () => null,
  setItem: () => {},
}
if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = {
    location: { search: '' },
    localStorage: mockStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}
if (typeof (globalThis as any).localStorage === 'undefined') {
  ;(globalThis as any).localStorage = mockStorage
}

class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = 1 // OPEN
  sentMessages: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((err: any) => void) | null = null
  onclose: (() => void) | null = null
  url: string

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    setTimeout(() => {
      if (this.onopen) this.onopen()
      if (this.onmessage) {
        // Send initial handshake init
        this.onmessage({ data: JSON.stringify({ type: 'init' }) })
      }
    }, 10)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = 3
    if (this.onclose) this.onclose()
  }
}

test('sendVelocityCommand suppresses steady zero cmd_vel stream', async () => {
  const originalWs = globalThis.WebSocket
  // @ts-ignore
  globalThis.WebSocket = MockWebSocket

  try {
    const ds = createRosRobotDataSource({ bridgeUrl: 'ws://fake:8765' })
    const unsub = ds.subscribe(() => {})

    // Wait for mock connection to open and handshake
    await new Promise((r) => setTimeout(r, 60))
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    assert.ok(ws, 'WebSocket was created')
    assert.equal(ds.sourceStatus, 'LIVE')

    // Initial state: not driving
    ws.sentMessages = []

    // 1. Calling sendVelocityCommand(0, 0) when idle should NOT send any websocket messages!
    for (let i = 0; i < 20; i++) {
      ds.sendVelocityCommand({ linear: 0, angular: 0 })
    }
    assert.equal(
      ws.sentMessages.length,
      0,
      'Calling sendVelocityCommand({0,0}) while idle must NOT emit any cmd_vel frames'
    )

    // 2. Start driving: send non-zero velocity
    ds.sendVelocityCommand({ linear: 0.1, angular: 0 })
    assert.equal(ws.sentMessages.length, 1)
    const driveMsg = JSON.parse(ws.sentMessages[0])
    assert.equal(driveMsg.type, 'cmd_vel')
    assert.equal(driveMsg.linear, 0.1)

    // 3. Stop driving: send zero velocity
    ds.sendVelocityCommand({ linear: 0, angular: 0 })
    assert.equal(ws.sentMessages.length, 2)
    const stopMsg = JSON.parse(ws.sentMessages[1])
    assert.equal(stopMsg.type, 'cmd_vel')
    assert.equal(stopMsg.linear, 0)
    assert.equal(stopMsg.angular, 0)

    // 4. Repeated subsequent calls to zero must be silent
    for (let i = 0; i < 20; i++) {
      ds.sendVelocityCommand({ linear: 0, angular: 0 })
    }
    assert.equal(
      ws.sentMessages.length,
      2,
      'Subsequent calls to sendVelocityCommand({0,0}) must NOT emit any further frames'
    )

    unsub()
    ds.disconnect()
  } finally {
    globalThis.WebSocket = originalWs
  }
})

test('pose_map message updates map-frame position and prevents wheel odom drift', async () => {
  const originalWs = globalThis.WebSocket
  // @ts-ignore
  globalThis.WebSocket = MockWebSocket

  try {
    const ds = createRosRobotDataSource({ bridgeUrl: 'ws://fake:8765' })
    let lastTelemetry: any = null
    const unsub = ds.subscribe((telem) => {
      lastTelemetry = telem
    })

    await new Promise((r) => setTimeout(r, 60))
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]

    // 1. Deliver pose_map message (x=2.0, y=1.5 in ROS map frame)
    ws.onmessage!({
      data: JSON.stringify({
        type: 'pose_map',
        pose: {
          position: { x: 2.0, y: 1.5 },
          yaw_rad: 0.0,
          timestamp: Date.now() / 1000,
        },
      }),
    })

    assert.ok(lastTelemetry, 'Telemetry should be updated')
    // Frontend coordinates: x_front = x_ros = 2.0, y_front = -y_ros = -1.5
    assert.equal(lastTelemetry.odometry.position.x, 2.0)
    assert.equal(lastTelemetry.odometry.position.y, -1.5)

    // 2. Deliver wheel /odom message with drifted position (x=0.5, y=0.2)
    ws.onmessage!({
      data: JSON.stringify({
        type: 'odom',
        odometry: {
          position: { x: 0.5, y: 0.2 },
          linear_x: 0.15,
          angular_z: 0.05,
          yaw_rad: 0.5,
        },
      }),
    })

    // Because fresh map pose is active (<1s), position must NOT be overwritten by wheel odom!
    assert.equal(lastTelemetry.odometry.position.x, 2.0, 'Position must remain map-frame position')
    assert.equal(lastTelemetry.odometry.position.y, -1.5, 'Position must remain map-frame position')
    // But linear and angular velocity MUST be updated from /odom
    assert.equal(lastTelemetry.odometry.linearVelocity, 0.15)
    assert.equal(lastTelemetry.odometry.angularVelocity, 0.05)

    unsub()
    ds.disconnect()
  } finally {
    globalThis.WebSocket = originalWs
  }
})
