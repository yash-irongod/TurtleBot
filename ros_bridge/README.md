# TurtleBot 3 Burger ROS 2 WebSocket Bridge

This script connects the TurtleBot Control Center React frontend to the real ROS 2 Humble robotics stack.

## Architecture

- **ROS 2 Node**: Runs inside a dedicated background thread with `rclpy.spin()`.
- **WebSocket Server**: Runs on `ws://0.0.0.0:8765` using `websockets` + `asyncio`.
- **Nav2 Action**: ROS 2 `ActionClient` for `nav2_msgs/action/NavigateToPose` on `/navigate_to_pose`.
  - Generation/token system prevents stale goal callbacks from mutating state.
  - Late-accepted stale goals are explicitly canceled to prevent unintended execution.
  - HOLD/PAUSE preserves the navigation session and ownership; RESUME creates a new generation.
- **Auto Explore**: Manages `~/turtlebot3_ws/launch/autonomous_exploration.launch.py` cleanly as a supervised process group.
  - Process generation tracking prevents old monitor threads from clearing newer exploration state.
  - Explicit stop transitions through STOPPING → IDLE; unexpected exit reports ERROR.
- **Sensor Streams**: `/odom`, `/scan`, `/imu`, `/battery_state`, `/map`, `/explore/frontiers`, `/explore/selected_frontier`.
- **Safety**: Startup is disarmed; physical motion is admitted only after an operator handshake. Manual commands use a short session/heartbeat lease, and an expired manual lease is atomically zeroed and invalidated so delayed packets cannot re-arm motion. The bridge also validates the controller WebSocket/session on every command.
  - Last-client disconnect performs full cleanup (cancel Nav2, stop Explorer, keep ownership until terminality, zero velocity).
  - Cleanup generation prevents premature re-arm on quick reconnect; timeouts keep control locked rather than pretending cleanup succeeded.
  - Bridge process restart is a DISARMED recovery boundary; deploy it with the ROS/Nav2/Explorer supervisor so external autonomous lifecycles are restarted/reconciled together rather than inferred from fresh in-memory bridge state.
- **Input Validation**: All WebSocket commands validated for finite numbers, bounds, and required fields.

## Network safety

The bridge listens on `0.0.0.0:8765` and does not implement TLS or operator authentication. Treat the robot network as trusted/isolated and do not expose this control port directly to the public internet.

## How to Deploy on the Ubuntu VM (192.168.0.112)

1. Copy `bridge.py` to `~/turtlebot_bridge/bridge.py` on the VM:
   ```bash
   mkdir -p ~/turtlebot_bridge
   cp bridge.py ~/turtlebot_bridge/bridge.py
   chmod +x ~/turtlebot_bridge/bridge.py
   ```

2. Ensure dependencies are installed:
   ```bash
   pip install websockets
   ```

3. Run the bridge:
   ```bash
   source ~/turtlebot_env.sh
   python3 ~/turtlebot_bridge/bridge.py
   ```

4. The frontend connects automatically to `ws://192.168.0.112:8765`.
