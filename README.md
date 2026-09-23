# TurtleBot // Control Center

A command center for a TurtleBot3 Burger, organized around three
operating modes rather than a grab-bag of dashboard panels:

- **Autonomous** — map, route, and navigation-state handling with Nav2 integration.
- **Manual** — keyboard-first (WASD + space) operator drive, drive pad as fallback,
  with an optional Mission sub-tab.
- **Puppy** — exercises a local follow-state model for future perception integration.

`Command` is the home screen (mode picker + world map + secondary sensor/telemetry
panels); `System` holds the operator-facing hardware views (Robot / Sensors /
Diagnostics) that used to be top-level nav items.

The system includes a ROS 2 WebSocket bridge (`ros_bridge/bridge.py`) that provides
real telemetry, `/cmd_vel` control, Nav2 NavigateToPose action dispatching, and
Frontier Explorer subprocess management. The frontend cleanly separates DEMO
(simulated) and LIVE (ROS-connected) operation.

## Running it

```bash
npm install
npm run dev
```

Then open the printed local URL (typically `http://localhost:5173`).

```bash
npm run build     # type-checks and produces a production build in dist/
npm run typecheck # type-check only
```

## Demo vs. live

The source owns one explicit `RobotSourceStatus`: `DEMO`, `LIVE`, or
`DISCONNECTED` (with a small presentation mapping to `DataEnvironment` for
existing view components). That state is persistent in the top bar and is
repeated only where a map, navigation model, or diagnostics could otherwise
read as a real feed.

The injected `mockRobotDataSource` reports `DEMO`. It generates useful
browser-local presentation data. The `rosRobotDataSource` connects to the
WebSocket bridge and reports `LIVE` when the ROS 2 connection is active.
A disconnect updates the status through the source-status subscription.

## What's real vs. mocked

Everything renders from one `RobotTelemetry` snapshot (`src/types/robot.ts`),
shaped to mirror the ROS 2 messages. In DEMO mode, `mockRobotDataSource`
(`src/data/mockTelemetry.ts`) produces simulated telemetry and a hand-built
occupancy grid (`src/data/mapGrid.ts`). In LIVE mode, `rosRobotDataSource`
(`src/data/rosRobotDataSource.ts`) receives real `/odom`, `/scan`, `/imu`,
`/battery_state`, and `/map` data via the WebSocket bridge.

Autonomous mode's navigation in DEMO uses `useNavigationDemo.ts` (a local
state machine). In LIVE, Nav2 `NavigateToPose` actions are dispatched through
the bridge, with feedback/result streaming. Puppy mode's follow state machine
(`usePuppyDemo.ts`) remains demo-only.

The bridge also manages the Frontier Explorer launch file as a supervised
subprocess group, exposing exploration state and frontier telemetry in LIVE mode.

### Safety & Reliability Highlights

- **Motion ownership**: Exactly one owner at a time (NONE, MANUAL, NAVIGATION, EXPLORATION). Backend is authoritative; frontend derives ownership from navigation/exploration state in LIVE mode.
- **Manual control lease**: LIVE manual motion uses a short-lived browser heartbeat/session lease; if heartbeats stop, the bridge atomically invalidates the session, zeros velocity, and releases MANUAL ownership. Delayed packets from an expired session cannot re-arm motion.
- **Stale callback protection**: Nav2 action callbacks carry generation tokens; stale callbacks never mutate current state. Late-accepted stale goals are explicitly canceled.
- **HOLD/PAUSE semantics**: Preserves navigation target and ownership; RESUME redispatches with new generation. Explicit CANCEL releases ownership.
- **Exploration lifecycle**: Process generation tracking prevents race conditions between stop/start cycles. Unexpected exit reports ERROR and releases ownership.
- **Controller-bound disconnect**: Disarms control immediately, binds commands to the current WebSocket controller, cancels Nav2, stops Frontier Explorer, zeros velocity, and re-arms only after tracked motion sources are terminal. A timeout keeps control locked rather than falsely declaring cleanup complete.
- **DEMO/LIVE separation**: DEMO mode cannot acquire EXPLORATION ownership or start real exploration. LIVE disconnect clears stale navigation/exploration state.
- **Input validation**: Bridge rejects NaN/Infinity, out-of-bounds, and malformed WebSocket commands.
- **3D stability**: Empty LIVE map created once (not per frame). Route geometry rebuilt only when path signature changes; old geometries disposed.
- **Source switching guarded**: LIVE control is atomically reserved/disarmed before a source switch; the bridge also checks navigation and exploration lifecycle records as a defense-in-depth gate, and a failed switch never re-arms a concurrently disconnected session.
- **Restart boundary**: the bridge starts DISARMED and its in-memory lifecycle records do not survive a process crash; deploy it with the ROS/Nav2/Explorer supervisor so a bridge restart is accompanied by a clean autonomy-stack restart/reconciliation rather than assuming an unknown external goal is gone.

## Safety: commanded velocity limits

TurtleBot3 Burger is rated for roughly 0.22 m/s / ~2.84 rad/s. This app never
commands more than `SAFE_LINEAR_MPS` / `SAFE_ANGULAR_RADPS`
(`src/lib/safety.ts`) — comfortably under the rated max, for exhibition
safety around people and obstacles. Manual mode's keyboard drive
(`src/hooks/useKeyboardDrive.ts`) also guarantees motion never continues
without a fresh key press: releasing every key, losing window focus,
switching mode, or the e-stop engaging all immediately zero the commanded
velocity, and OS key-repeat is explicitly ignored so a key still held down
can't silently re-arm movement the instant an e-stop is reset.

## Running the ROS 2 bridge

The WebSocket bridge runs on the robot (or a machine with ROS 2 access):

```bash
source ~/turtlebot_env.sh
python3 ros_bridge/bridge.py
```

It serves on `ws://0.0.0.0:8765`. The frontend connects via `?source=live` or
the stored preference. Keep this port on a trusted/isolated network; transport encryption/authentication is not implemented in this demo bridge.

## Connecting a real robot

The frontend integration is complete; the bridge handles ROS 2 transport:

1. **Telemetry in** — `rosRobotDataSource` subscribes to the bridge for
   `/odom`, `/scan`, `/imu`, `/battery_state`, and `/map` (transient-local QoS).
2. **Velocity out** — `sendVelocityCommand` publishes `/cmd_vel` through the
   bridge, which enforces safety limits and motion ownership.
3. **Navigation** — Nav2 `NavigateToPose` actions are dispatched via the bridge
   action client; feedback and results stream back.
4. **Exploration** — The bridge launches/stops the Frontier Explorer
   `autonomous_exploration.launch.py` subprocess group and streams
   `/explore/frontiers` and `/explore/selected_frontier`.
5. **Map** — Real `/map` occupancy grids stream through the bridge and render
   in `WorldMap` with pose, goal, and path overlays.

## Project structure

```
src/
  types/robot.ts             Domain types — modes, nav sections, nav/puppy
                               state machines, OccupancyGrid, RobotDataSource
  data/                      Mock telemetry + map grid + static demo data
  context/RobotContext.tsx   Owns source subscription, UI state, command
                               safety, and the DEMO-only state models
  hooks/
    useKeyboardDrive.ts        WASD + space manual drive
    useNavigationDemo.ts       Autonomous mode's state machine
    usePuppyDemo.ts            Puppy mode's state machine
  lib/                       Polar/cartesian math, formatting, health
                               thresholds, safe-velocity constants
  components/
    common/                   Glass panel, status pulse/tile, sparkline,
                                environment tag, segmented control
    layout/                    Top bar, nav rail (5 sections)
    robot/                     Radar (local sensor view), robot glyph,
                                 attitude indicator
    map/                       WorldMap (global map view), navigation status
    modes/                     ModeSwitcher (3 primary modes)
    manual/                    Mission queue (Manual mode's sub-tab)
    telemetry/                 Right-hand telemetry panel
    controls/                  Contextual control deck (per-mode controls +
                                 persistent e-stop), throttle gauge
  views/                      CommandView, AutonomousView, ManualView,
                               PuppyView, SystemView (wraps Robot/Sensors/
                               Diagnostics as tabs)
```

## Known items

- `npm install` reports a moderate/high advisory in `esbuild` (via Vite 5) — it's a
  dev-server-only CORS issue (a malicious site could probe `localhost` while
  `npm run dev` is running); it doesn't affect the production build. Fixing it means
  jumping to Vite 8, which is a bigger, untested change than this pass warranted —
  worth doing deliberately later rather than as a drive-by `--force` upgrade.

## Design system

- **Palette** — near-black `void` base, a restrained electric-cyan `signal`
  accent, `amber` for warning states, `critical` red reserved for the e-stop
  and hard faults.
- **Type** — Inter for UI text, JetBrains Mono for anything numeric or
  instrument-like (telemetry values, micro labels, coordinates). Both are
  imported via their `latin` subset only (`src/index.css`) — this is an
  English-only UI, so the Cyrillic/Greek/Vietnamese glyphs `@fontsource`
  ships by default are dead weight; verified every special character actually
  used (°, §, —, …, etc.) is still covered by the latin subset before cutting it.
- **Map vs. radar** — `WorldMap` is the global/world representation (an
  occupancy grid); `RadarDisplay` is the local, instantaneous LiDAR frame.
  They're deliberately different visualizations, not the same thing twice.
- **Motion** — transitions communicate a state change; the radar uses a
  static forward sector rather than a continuously animated sweep. The one
  deliberately-effortful exception is the emergency stop, which requires a
  ~650ms hold before it engages.
