#!/usr/bin/env python3
"""
TurtleBot 3 Burger ROS 2 WebSocket Bridge.

Features:
- Telemetry: /odom, /scan, /imu, /battery_state -> WebSocket broadcast
- Velocity Control: receives { type: "cmd_vel", linear, angular } -> publishes /cmd_vel
- Nav2 Autonomous Navigation: ROS 2 ActionClient for nav2_msgs/action/NavigateToPose (/navigate_to_pose)
  * Accepts { type: "nav_goal", x, y, yaw } in map frame
  * Accepts { type: "nav_cancel" } -> cancels action goal + sends zero velocity
  * Streams feedback (distance remaining) and result (GOAL_REACHED, CANCELED, FAILED)
- Auto Explore Management:
  * Manages ~/turtlebot3_ws/launch/autonomous_exploration.launch.py as a supervised subprocess group
  * Accepts { type: "explore_start" } and { type: "explore_stop" }
  * Prevents duplicate exploration instances
  * Clean shutdown with process group signals + immediate zero cmd_vel
  * Reports states: IDLE, STARTING, EXPLORING, STOPPING, COMPLETE, ERROR
- Frontier Telemetry:
  * Subscribes to /explore/frontiers, /explore/selected_frontier, /explore/optimized_map
  * Broadcasts normalized exploration status and selected target
- Real /map:
  * Subscribes to /map (nav_msgs/msg/OccupancyGrid) with transient-local QoS
  * Throttles to ~1 Hz to preserve WebSocket bandwidth

WebSocket endpoint: ws://0.0.0.0:8765
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, Optional, Set

# Attempt ROS 2 imports with informative error guidance
try:
    import rclpy
    from rclpy.action import ActionClient
    from rclpy.node import Node
    from rclpy.qos import (
        DurabilityPolicy,
        HistoryPolicy,
        QoSProfile,
        ReliabilityPolicy,
        qos_profile_sensor_data,
    )

    from action_msgs.msg import GoalStatus
    from geometry_msgs.msg import Point, PointStamped, Pose, PoseArray, PoseStamped, Quaternion, Twist
    from nav_msgs.msg import OccupancyGrid, Odometry, Path
    from sensor_msgs.msg import BatteryState, Imu, LaserScan
    from visualization_msgs.msg import Marker, MarkerArray

    try:
        from nav2_msgs.action import NavigateToPose
        HAS_NAV2 = True
    except ImportError:
        HAS_NAV2 = False
        NavigateToPose = None

except ImportError as e:
    print(f"[ERROR] Failed to import ROS 2 modules: {e}", file=sys.stderr)
    print("[INFO] Ensure you have sourced your ROS 2 environment: source ~/turtlebot_env.sh", file=sys.stderr)
    # Allow compile-checking without ROS environment
    rclpy = None

try:
    import websockets
except ImportError:
    print("[ERROR] websockets module not found. Install with: pip install websockets", file=sys.stderr)
    websockets = None

WS_HOST = "0.0.0.0"
WS_PORT = 8765
EXPLORATION_LAUNCH_PATH = os.path.expanduser("~/turtlebot3_ws/launch/autonomous_exploration.launch.py")
ENV_SCRIPT_PATH = os.path.expanduser("~/turtlebot_env.sh")

# Match src/lib/safety.ts — bridge is the authoritative cmd_vel clamp for LIVE.
SAFE_LINEAR_MPS = 0.18
SAFE_REVERSE_MPS = SAFE_LINEAR_MPS * 0.7
SAFE_ANGULAR_RADPS = 1.0
# Coordinates beyond this are not a plausible indoor TurtleBot map goal.
MAX_NAV_GOAL_ABS_M = 10000.0
MANUAL_COMMAND_TIMEOUT_SEC = 0.8
MANUAL_WATCHDOG_POLL_SEC = 0.15

# Motion ownership constants
MOTION_NONE = "NONE"
MOTION_MANUAL = "MANUAL"
MOTION_NAVIGATION = "NAVIGATION"
MOTION_EXPLORATION = "EXPLORATION"


def _parse_finite_number(value: Any) -> Optional[float]:
    """Return a finite numeric value, rejecting JSON booleans as malformed input."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _clamp_manual_velocity(linear: float, angular: float) -> tuple:
    if linear >= 0.0:
        linear = min(linear, SAFE_LINEAR_MPS)
    else:
        linear = max(linear, -SAFE_REVERSE_MPS)
    angular = max(-SAFE_ANGULAR_RADPS, min(SAFE_ANGULAR_RADPS, angular))
    return linear, angular


@dataclass
class NavGoalRecord:
    """Identity and lifecycle state for exactly one NavigateToPose operation."""

    generation: int
    target: Dict[str, float]
    handle: Any = None
    cancel_requested: bool = False
    cancel_action: Optional[str] = None
    cancel_response_ok: Optional[bool] = None
    cancel_watchdog_started: bool = False
    result_status: Optional[int] = None
    result_event: threading.Event = field(default_factory=threading.Event)


@dataclass
class ExplorationProcessRecord:
    """Identity and completion event for exactly one exploration subprocess."""

    generation: int
    process: subprocess.Popen
    stop_requested: bool = False
    finalized: bool = False
    termination_event: threading.Event = field(default_factory=threading.Event)


class TurtleBotBridgeNode:
    """ROS 2 Node managing publishers, subscribers, Nav2 ActionClient, and exploration subprocess."""

    def __init__(self, broadcast_callback):
        self.broadcast = broadcast_callback
        self.node = rclpy.create_node("turtlebot_web_bridge")
        self.logger = self.node.get_logger()
        self.logger.info("Initializing TurtleBot 3 Web Bridge Node...")
        self.loop: Optional[asyncio.AbstractEventLoop] = None

        # 1. cmd_vel publisher
        self.cmd_vel_pub = self.node.create_publisher(Twist, "/cmd_vel", 10)

        # 2. Sensor and Telemetry subscriptions
        self.odom_sub = self.node.create_subscription(
            Odometry, "/odom", self._on_odom, qos_profile_sensor_data
        )
        self.scan_sub = self.node.create_subscription(
            LaserScan, "/scan", self._on_scan, qos_profile_sensor_data
        )
        self.imu_sub = self.node.create_subscription(
            Imu, "/imu", self._on_imu, qos_profile_sensor_data
        )
        self.battery_sub = self.node.create_subscription(
            BatteryState, "/battery_state", self._on_battery, qos_profile_sensor_data
        )

        # 3. Real /map subscription (Transient Local QoS for latched maps)
        map_qos = QoSProfile(
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
            reliability=ReliabilityPolicy.RELIABLE,
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
        )
        self.map_sub = self.node.create_subscription(
            OccupancyGrid, "/map", self._on_map, map_qos
        )

        # 4. Nav2 NavigateToPose ActionClient
        self.nav_client = None
        self.current_goal_handle = None
        self.nav_state = "IDLE"
        self.current_goal_pose = None
        self.nav_goal_generation = 0
        self._nav_records: Dict[int, NavGoalRecord] = {}
        self._current_nav_record: Optional[NavGoalRecord] = None
        self._nav_cancel_record: Optional[NavGoalRecord] = None
        self._nav_safety_lock_record: Optional[NavGoalRecord] = None
        self._nav_state_lock = threading.RLock()
        self._nav_cancel_timeout_sec = 8.0
        self._nav_cancel_watchdog_stop = threading.Event()
        if HAS_NAV2:
            self.nav_client = ActionClient(self.node, NavigateToPose, "navigate_to_pose")
            self.logger.info("Nav2 NavigateToPose ActionClient initialized on /navigate_to_pose")
        else:
            self.logger.warn("nav2_msgs.action.NavigateToPose not found; Nav2 action client disabled")

        # 5. Frontier Explorer subscriptions
        self.frontiers_sub = None
        self.selected_frontier_sub = None
        self.optimized_map_sub = None
        self.frontier_count = 0
        self.active_frontiers: Dict[int, Dict[str, float]] = {}  # marker_id -> {x, y}
        self.selected_frontier: Optional[Dict[str, float]] = None
        self.exploration_state = "IDLE"
        self.explore_process: Optional[subprocess.Popen] = None
        self._explore_record: Optional[ExplorationProcessRecord] = None

        # Motion ownership: NONE, MANUAL, NAVIGATION, EXPLORATION.
        # Every acquisition/release is protected by one lock so no two motion sources
        # can win an interleaved check/take race.
        self.motion_owner = MOTION_NONE
        self._motion_owner_lock = threading.RLock()
        self.last_cmd_vel = {"linear": 0.0, "angular": 0.0}
        self._last_manual_command_at = 0.0
        # Manual control is a short-lived lease. The session id prevents delayed
        # commands from an expired browser intent from silently re-arming motion.
        self._manual_session_id: Optional[str] = None
        self._invalidated_manual_session_ids: Deque[str] = deque(maxlen=32)
        self._manual_watchdog_stop = threading.Event()
        self._manual_watchdog_thread = threading.Thread(
            target=self._manual_watchdog_loop, name="manual-cmd-watchdog", daemon=True
        )
        # Refuse all physical control until the websocket operator handshake succeeds.
        self.accepting_commands = False
        self._source_switch_in_progress = False
        self._idle_cleanup_lock = threading.Lock()
        self._idle_cleanup_running = False

        # Navigation command serialization lock (asyncio).
        # All nav operations that mutate current goal state must acquire this.
        self._nav_lock = asyncio.Lock()

        # Exploration process generation: increments on each start_exploration.
        # A monitor thread captures its generation at creation; if it no longer matches
        # the active generation when it wakes, it must not mutate state.
        self._explore_generation = 0
        self._explore_monitor_active = False
        # Exploration lifecycle serialization lock (threading).
        self._explore_lock = threading.Lock()

        # Cleanup session generation: increments on each last-client disconnect.
        # Reconnects before cleanup completes will not re-arm the system.
        self._cleanup_generation = 0
        self._cleanup_in_progress = False
        self._cleanup_complete_event = threading.Event()
        self._cleanup_complete_event.set()

        # Latest real map is cached so a newly connected operator receives /map even
        # when Cartographer published it before the websocket connection existed.
        self._latest_map_payload: Optional[Dict[str, Any]] = None
        self._latest_optimized_map_payload: Optional[Dict[str, Any]] = None

        self._setup_exploration_subscribers(map_qos)
        self._manual_watchdog_thread.start()

        # Rate-limiting timestamps
        self.last_odom_broadcast = 0.0
        self.last_scan_broadcast = 0.0
        self.last_imu_broadcast = 0.0
        self.last_map_broadcast = 0.0
        self.last_battery_broadcast = 0.0

        self.logger.info("Bridge Node initialized successfully.")

    def _setup_exploration_subscribers(self, map_qos):
        """Sets up subscribers for frontier explorer outputs."""
        try:
            # /explore/selected_frontier can be PoseStamped or PointStamped
            self.selected_frontier_sub = self.node.create_subscription(
                PoseStamped,
                "/explore/selected_frontier",
                self._on_selected_frontier_pose,
                10,
            )
        except Exception:
            pass

        try:
            # /explore/frontiers uses visualization_msgs/msg/MarkerArray
            # Actions: ADD (0), MODIFY (0), DELETE (2), DELETEALL (3)
            self.frontiers_sub = self.node.create_subscription(
                MarkerArray,
                "/explore/frontiers",
                self._on_frontiers_marker_array,
                10,
            )
        except Exception:
            pass

        try:
            self.optimized_map_sub = self.node.create_subscription(
                OccupancyGrid,
                "/explore/optimized_map",
                self._on_optimized_map,
                map_qos,
            )
        except Exception:
            pass

    # --------------------------------------------------------------------------
    # Telemetry Callbacks
    # --------------------------------------------------------------------------
    def _on_odom(self, msg: Odometry):
        now = time.time()
        if now - self.last_odom_broadcast < 0.05:  # max ~20 Hz
            return
        self.last_odom_broadcast = now

        pos = msg.pose.pose.position
        ori = msg.pose.pose.orientation
        siny_cosp = 2.0 * (ori.w * ori.z + ori.x * ori.y)
        cosy_cosp = 1.0 - 2.0 * (ori.y * ori.y + ori.z * ori.z)
        yaw_rad = math.atan2(siny_cosp, cosy_cosp)

        payload = {
            "type": "odom",
            "odometry": {
                "position": {"x": pos.x, "y": pos.y},
                # yaw_rad: raw ROS yaw in radians (0 = East/+X, positive CCW).
                # The frontend converts this using rosYawToFrontendHeadingDeg()
                # so that 0° = North, 90° = East matches the compass convention.
                "yaw_rad": yaw_rad,
                "linear_x": msg.twist.twist.linear.x,
                "angular_z": msg.twist.twist.angular.z,
                "orientation": {"x": ori.x, "y": ori.y, "z": ori.z, "w": ori.w},
            },
        }
        self.broadcast(payload)


    def _on_scan(self, msg: LaserScan):
        now = time.time()
        if now - self.last_scan_broadcast < 0.1:  # max ~10 Hz
            return
        self.last_scan_broadcast = now

        # Subsample or transmit valid ranges
        payload = {
            "type": "scan",
            "scan": {
                "range_min": msg.range_min,
                "range_max": msg.range_max,
                "angle_min": msg.angle_min,
                "angle_increment": msg.angle_increment,
                "ranges": list(msg.ranges),
            },
        }
        self.broadcast(payload)

    def _on_imu(self, msg: Imu):
        now = time.time()
        if now - self.last_imu_broadcast < 0.05:  # max ~20 Hz
            return
        self.last_imu_broadcast = now

        payload = {
            "type": "imu",
            "imu": {
                "orientation": {
                    "x": msg.orientation.x,
                    "y": msg.orientation.y,
                    "z": msg.orientation.z,
                    "w": msg.orientation.w,
                },
                "linear_acceleration": {
                    "x": msg.linear_acceleration.x,
                    "y": msg.linear_acceleration.y,
                    "z": msg.linear_acceleration.z,
                },
                "angular_velocity": {
                    "x": msg.angular_velocity.x,
                    "y": msg.angular_velocity.y,
                    "z": msg.angular_velocity.z,
                },
            },
        }
        self.broadcast(payload)

    def _on_battery(self, msg: BatteryState):
        now = time.time()
        if now - self.last_battery_broadcast < 1.0:  # ~1 Hz
            return
        self.last_battery_broadcast = now

        payload = {
            "type": "battery",
            "battery": {
                "percentage": msg.percentage,
                "voltage": msg.voltage,
                "current": msg.current,
                "power_supply_status": msg.power_supply_status,
                "charging": msg.power_supply_status == BatteryState.POWER_SUPPLY_STATUS_CHARGING,
            },
        }
        self.broadcast(payload)

    def _build_map_payload(self, msg: OccupancyGrid) -> Dict[str, Any]:
        return {
            "type": "map",
            "map": {
                "width": msg.info.width,
                "height": msg.info.height,
                "resolution": msg.info.resolution,
                "origin": {
                    "x": msg.info.origin.position.x,
                    "y": msg.info.origin.position.y,
                    "z": msg.info.origin.position.z,
                },
                "data": list(msg.data),
            },
        }

    def _broadcast_map_payload(self, payload: Dict[str, Any]):
        now = time.time()
        if now - self.last_map_broadcast < 1.0:  # ~1 Hz throttled broadcast
            return
        self.last_map_broadcast = now
        self.broadcast(payload)

    def _on_map(self, msg: OccupancyGrid):
        payload = self._build_map_payload(msg)
        # /map is the authoritative live map cached for newly connected operators.
        # Exploration's optimized map is intentionally tracked separately so it cannot
        # silently replace the provenance of this reconnect payload.
        self._latest_map_payload = payload
        self._broadcast_map_payload(payload)

    def _on_optimized_map(self, msg: OccupancyGrid):
        # Optimized exploration maps may still be useful to the existing UI, but they are
        # not treated as the authoritative /map snapshot sent during operator handshake.
        payload = self._build_map_payload(msg)
        self._latest_optimized_map_payload = payload
        self._broadcast_map_payload(payload)

    # --------------------------------------------------------------------------
    # Frontier Explorer Callbacks
    # --------------------------------------------------------------------------
    def _on_selected_frontier_pose(self, msg: PoseStamped):
        with self._explore_lock:
            if self.exploration_state not in ("STARTING", "EXPLORING"):
                return
            self.selected_frontier = {
                "x": msg.pose.position.x,
                "y": msg.pose.position.y,
            }
        self._broadcast_exploration_telemetry()

    def _on_frontiers_marker_array(self, msg: MarkerArray):
        """Handle frontier MarkerArray while respecting the active explorer lifecycle."""
        with self._explore_lock:
            if self.exploration_state not in ("STARTING", "EXPLORING"):
                return

            for marker in msg.markers:
                action = marker.action
                marker_id = marker.id
                if action == Marker.ADD or action == Marker.MODIFY:
                    self.active_frontiers[marker_id] = {
                        "x": marker.pose.position.x,
                        "y": marker.pose.position.y,
                    }
                elif action == Marker.DELETE:
                    self.active_frontiers.pop(marker_id, None)
                elif action == Marker.DELETEALL:
                    self.active_frontiers.clear()

            self.frontier_count = len(self.active_frontiers)
            if self.exploration_state == "STARTING" and self.frontier_count > 0:
                self.exploration_state = "EXPLORING"
                self.logger.info("Exploration frontiers received - state advanced to EXPLORING")
        self._broadcast_exploration_telemetry()


    def _broadcast_exploration_telemetry(self):
        payload = {
            "type": "exploration",
            "exploration": {
                "state": self.exploration_state,
                "frontier_count": self.frontier_count,
                "selected_frontier": self.selected_frontier,
            },
        }
        self.broadcast(payload)

    # --------------------------------------------------------------------------
    # Nav2 NavigateToPose Action Handlers
    # --------------------------------------------------------------------------
    def _bump_nav_generation(self) -> int:
        """Invalidate in-flight callbacks and return the new generation."""
        with self._nav_state_lock:
            self.nav_goal_generation += 1
            return self.nav_goal_generation

    def _is_current_nav_record(self, record: Optional[NavGoalRecord]) -> bool:
        if record is None:
            return False
        with self._nav_state_lock:
            return record.generation == self.nav_goal_generation and self._current_nav_record is record

    def _get_nav_record(self, generation: int) -> Optional[NavGoalRecord]:
        with self._nav_state_lock:
            return self._nav_records.get(generation)

    def _issue_cancel_request(self, record: NavGoalRecord):
        """Issue cancellation for one exact Nav2 goal handle, if that handle exists."""
        with self._nav_state_lock:
            if record.result_event.is_set():
                return
            handle = record.handle
        if handle is None:
            return
        try:
            cancel_future = handle.cancel_goal_async()
            cancel_future.add_done_callback(
                lambda future, r=record: self._on_nav_cancel_response(future, r)
            )
        except Exception as exc:
            with self._nav_state_lock:
                record.cancel_response_ok = False
                self._nav_safety_lock_record = record
                with self._motion_owner_lock:
                    self.motion_owner = MOTION_NAVIGATION
            self.logger.error(
                f"Error requesting Nav2 goal cancellation (gen={record.generation}): {exc}"
            )
            self.publish_zero_velocity()

    def _nav_cancel_watchdog(self, record: NavGoalRecord):
        """Keep a cancellation live until Nav2 reports terminality or the safety timeout expires."""
        deadline = time.monotonic() + self._nav_cancel_timeout_sec
        while not record.result_event.wait(0.75):
            if self._nav_cancel_watchdog_stop.is_set():
                return
            if time.monotonic() >= deadline:
                with self._nav_state_lock:
                    if record.result_event.is_set():
                        return
                    self._nav_safety_lock_record = record
                    with self._motion_owner_lock:
                        self.motion_owner = MOTION_NAVIGATION
                self.publish_zero_velocity()
                self.logger.error(
                    f"Nav2 goal generation {record.generation} did not terminate within "
                    f"{self._nav_cancel_timeout_sec:.1f}s; motion remains safety-locked"
                )
                return
            self._issue_cancel_request(record)

    def _start_cancel_for_record(self, record: NavGoalRecord):
        """Request cancellation for exactly one goal and supervise terminality."""
        with self._nav_state_lock:
            if record.result_event.is_set():
                return
            first_request = not record.cancel_requested
            record.cancel_requested = True
            self._nav_cancel_record = record
            if first_request and not record.cancel_watchdog_started:
                record.cancel_watchdog_started = True
                threading.Thread(
                    target=self._nav_cancel_watchdog,
                    args=(record,),
                    name=f"nav-cancel-{record.generation}",
                    daemon=True,
                ).start()
        self._issue_cancel_request(record)

    def _request_cancel_current_goal(self, cancel_action: Optional[str] = None) -> Optional[NavGoalRecord]:
        """Select the current Nav2 goal and record its lifecycle intent before cancellation begins."""
        with self._nav_state_lock:
            record = self._current_nav_record
            if record is not None and record.result_event.is_set():
                record = None
            if record is None:
                record = self._nav_cancel_record
            if record is not None and record.result_event.is_set():
                record = None
            if record is not None and cancel_action is not None:
                record.cancel_action = cancel_action
        if record is None:
            return None
        self.logger.info(f"Canceling Nav2 goal generation {record.generation}...")
        self._start_cancel_for_record(record)
        return record

    def _send_nav_goal(self, x: float, y: float, yaw: float, generation: int, detail: str):
        """Dispatch NavigateToPose for one generation and create its lifecycle record."""
        record = NavGoalRecord(
            generation=generation,
            target={"x": float(x), "y": float(y), "yaw": float(yaw)},
        )
        with self._nav_state_lock:
            self._nav_records[generation] = record
            # Keep the lifecycle registry bounded. A terminal generation cannot become
            # current again, so old completed records can be safely forgotten once the
            # registry grows beyond a small working window.
            if len(self._nav_records) > 256:
                protected = {
                    item.generation
                    for item in (self._current_nav_record, self._nav_cancel_record, self._nav_safety_lock_record)
                    if item is not None
                }
                terminal_generations = [
                    gen
                    for gen, item in self._nav_records.items()
                    if item.result_event.is_set() and gen not in protected and gen != generation
                ]
                for old_generation in sorted(terminal_generations)[: max(0, len(self._nav_records) - 256)]:
                    self._nav_records.pop(old_generation, None)
            self._current_nav_record = record
            self.current_goal_handle = None

        goal_msg = NavigateToPose.Goal()
        goal_msg.pose.header.frame_id = "map"
        goal_msg.pose.header.stamp = self.node.get_clock().now().to_msg()
        goal_msg.pose.pose.position.x = float(x)
        goal_msg.pose.pose.position.y = float(y)
        goal_msg.pose.pose.position.z = 0.0

        half_yaw = yaw / 2.0
        goal_msg.pose.pose.orientation.x = 0.0
        goal_msg.pose.pose.orientation.y = 0.0
        goal_msg.pose.pose.orientation.z = math.sin(half_yaw)
        goal_msg.pose.pose.orientation.w = math.cos(half_yaw)

        self.logger.info(
            f"Sending NavigateToPose goal gen={generation}: x={x:.2f}, y={y:.2f}, yaw={yaw:.2f}"
        )
        dispatch_rejected = False
        dispatch_rejection_reason = ""
        try:
            # The final acceptance check and ROS dispatch are one short critical section.
            # Disconnect/source-switch cleanup cannot flip the bridge to DISARMED between
            # the check and send_goal_async(). Once the goal is admitted, cleanup can still
            # cancel it through the normal exact-record barrier.
            with self._motion_owner_lock:
                if (
                    self._cleanup_in_progress
                    or self._source_switch_in_progress
                    or not self.accepting_commands
                    or self.motion_owner != MOTION_NAVIGATION
                ):
                    dispatch_rejected = True
                    dispatch_rejection_reason = "Bridge was disarmed before Nav2 dispatch"
                else:
                    send_goal_future = self.nav_client.send_goal_async(
                        goal_msg,
                        feedback_callback=lambda feedback_msg, g=generation: self._on_nav_feedback(feedback_msg, g),
                    )
                    send_goal_future.add_done_callback(
                        lambda future, g=generation: self._on_nav_goal_response(future, g)
                    )
        except Exception as exc:
            self.logger.error(f"Failed to dispatch Nav2 goal generation {generation}: {exc}")
            dispatch_rejected = True
            dispatch_rejection_reason = "Nav2 goal dispatch failed"

        if dispatch_rejected:
            self.logger.warn(
                f"Nav2 goal generation {generation} was not dispatched: {dispatch_rejection_reason}"
            )
            with self._nav_state_lock:
                record.result_status = GoalStatus.STATUS_UNKNOWN if HAS_NAV2 else None
                current = self._is_current_nav_record(record)
                if current:
                    self.current_goal_handle = None
                    self._current_nav_record = None
                    self.nav_state = "CANCELED" if self._cleanup_in_progress else "FAILED"
                    self._release_navigation_with_zero()
            # A dispatch rejection is terminal for this bridge record. Signal the barrier
            # only after all associated state/ownership cleanup is complete.
            record.result_event.set()
            if not self._cleanup_in_progress:
                self._broadcast_nav_status("FAILED", dispatch_rejection_reason)
            return

        self._broadcast_nav_status("PLANNING", detail)

    async def navigate_to_goal_async(self, x: float, y: float, yaw: float):
        """Serialize navigation requests while keeping blocking ROS waits off the event loop."""
        async with self._nav_lock:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None,
                self._navigate_to_goal_blocking,
                float(x),
                float(y),
                float(yaw),
            )

    def navigate_to_goal(self, x: float, y: float, yaw: float):
        """Compatibility entry point; use the serialized async path whenever the bridge loop exists."""
        if self.loop is not None and self.loop.is_running():
            try:
                running_loop = asyncio.get_running_loop()
            except RuntimeError:
                running_loop = None
            if running_loop is self.loop:
                asyncio.create_task(self.navigate_to_goal_async(x, y, yaw))
            else:
                asyncio.run_coroutine_threadsafe(
                    self.navigate_to_goal_async(x, y, yaw), self.loop
                )
            return
        self._navigate_to_goal_blocking(x, y, yaw)

    def _navigate_to_goal_blocking(self, x: float, y: float, yaw: float):
        """Dispatch one deterministic Nav2 operation; caller must already hold _nav_lock."""
        with self._motion_owner_lock:
            accepting_commands = self.accepting_commands
        if not accepting_commands:
            self.logger.warn("NavigateToPose rejected: operator session is not armed")
            self._broadcast_nav_status("FAILED", "Operator session is not armed")
            return

        with self._nav_state_lock:
            safety_locked = self._nav_safety_lock_record is not None
            existing_record = self._current_nav_record or self._nav_cancel_record
            nav_lifecycle_busy = self.nav_state in ("PLANNING", "NAVIGATING", "PAUSED", "CANCELING")
        if safety_locked:
            self.logger.error("NavigateToPose rejected: navigation safety lock is active")
            self._broadcast_nav_status(
                "CANCELING",
                "Navigation locked until the previous Nav2 goal is confirmed terminated",
            )
            return

        with self._explore_lock:
            explore_lifecycle_busy = self.exploration_state in ("STARTING", "EXPLORING", "STOPPING")
        if explore_lifecycle_busy:
            self.logger.warn("NavigateToPose rejected: exploration lifecycle is active")
            self._broadcast_nav_status("FAILED", "Navigation rejected while exploration is active")
            return

        if not HAS_NAV2 or self.nav_client is None:
            self.logger.error("NavigateToPose requested but Nav2 action client is not available")
            self._broadcast_nav_status("FAILED", "Nav2 action client not available on ROS bridge")
            return

        # Atomic ownership acquisition happens before the server wait, so another motion
        # source cannot enter while this request is blocked on Nav2 availability.
        if not self._try_acquire_ownership(MOTION_NAVIGATION):
            self._broadcast_nav_status("FAILED", "Navigation rejected: another motion owner is active")
            return

        self.logger.info("Checking if /navigate_to_pose action server is ready...")
        if not self.nav_client.wait_for_server(timeout_sec=2.0):
            self.logger.error("Nav2 /navigate_to_pose action server is not active")
            self._release_ownership(MOTION_NAVIGATION)
            self._broadcast_nav_status("FAILED", "Nav2 action server not responding")
            return

        if not self.accepting_commands:
            self.logger.warn("NavigateToPose aborted: operator session ended during server wait")
            self._release_ownership(MOTION_NAVIGATION)
            return

        # A prior Nav2 goal must be terminal before this new goal is dispatched.
        if existing_record is not None and not existing_record.result_event.is_set():
            with self._nav_state_lock:
                self._bump_nav_generation()
                if self._current_nav_record is existing_record:
                    self._current_nav_record = None
                self.current_goal_handle = None
                existing_record.cancel_action = existing_record.cancel_action or "REPLACE"
                self.nav_state = "CANCELING"
                # NAVIGATION ownership is deliberately retained while replacement is pending.

            self._start_cancel_for_record(existing_record)
            self.publish_zero_velocity()
            self._broadcast_nav_status("CANCELING", "Waiting for previous Nav2 goal to terminate")

            if not existing_record.result_event.wait(timeout=self._nav_cancel_timeout_sec):
                with self._nav_state_lock:
                    self._nav_safety_lock_record = existing_record
                    with self._motion_owner_lock:
                        self.motion_owner = MOTION_NAVIGATION
                self.publish_zero_velocity()
                self._broadcast_nav_status(
                    "CANCELING",
                    "Previous Nav2 goal is still active; new navigation is blocked",
                )
                return

            with self._nav_state_lock:
                if self._nav_cancel_record is existing_record:
                    self._nav_cancel_record = None
                if self._nav_safety_lock_record is existing_record:
                    self._nav_safety_lock_record = None

        generation = self._bump_nav_generation()
        # Ownership is still NAVIGATION here; try_acquire also preserves same-owner state.
        self._try_acquire_ownership(MOTION_NAVIGATION)
        with self._nav_state_lock:
            self.current_goal_pose = {"x": float(x), "y": float(y), "yaw": float(yaw)}
            self.nav_state = "PLANNING"
        self._send_nav_goal(x, y, yaw, generation, "Goal dispatched to Nav2 planner")

    def _on_nav_goal_response(self, future, generation: int):
        record = self._get_nav_record(generation)
        if record is None:
            return

        try:
            goal_handle = future.result()
        except Exception as exc:
            self.logger.error(f"Nav2 goal response failed (gen={generation}): {exc}")
            with self._nav_state_lock:
                record.result_status = None
                current = self._is_current_nav_record(record)
                if current:
                    self.current_goal_handle = None
                    self._current_nav_record = None
                    self.nav_state = "FAILED"
                    self._release_navigation_with_zero()
            # Keep result_event as a genuine terminality barrier: callers only wake after
            # the corresponding bridge state and owner have been finalized.
            record.result_event.set()
            if current:
                self._broadcast_nav_status("FAILED", "Nav2 goal response failed")
            return

        with self._nav_state_lock:
            record.handle = goal_handle
            current = self._is_current_nav_record(record)
            superseded = not current or record.cancel_requested

        if not goal_handle.accepted:
            with self._nav_state_lock:
                record.result_status = None
                if self._nav_cancel_record is record:
                    self._nav_cancel_record = None
                if self._nav_safety_lock_record is record:
                    self._nav_safety_lock_record = None
                if current:
                    self.current_goal_handle = None
                    self._current_nav_record = None
                    self.nav_state = "FAILED"
                    self._release_navigation_with_zero()
            # No NavigateToPose goal was admitted, but record finalization still precedes
            # waking cancellation/replacement waiters.
            record.result_event.set()
            if current:
                self._broadcast_nav_status("FAILED", "Goal rejected by Nav2")
            return

        result_future = goal_handle.get_result_async()
        result_future.add_done_callback(
            lambda result_future, g=generation: self._on_nav_result(result_future, g)
        )

        if superseded:
            # The goal may have been accepted after cancellation/supersession. Never let
            # such a goal become current; supervise cancellation of this exact handle
            # with the same watchdog used by normal cancellation paths. Do not issue an
            # unconditional zero if a newer Nav2 record is already current.
            self.logger.warn(
                f"Stale Nav2 goal accepted after supersession (gen={generation}); canceling exact handle"
            )
            self._start_cancel_for_record(record)
            with self._nav_state_lock:
                newer_current_exists = (
                    self._current_nav_record is not None and self._current_nav_record is not record
                )
            if not newer_current_exists:
                self.publish_zero_velocity()
            return

        with self._nav_state_lock:
            self.current_goal_handle = goal_handle
            self.nav_state = "NAVIGATING"
        self.logger.info(f"Nav2 NavigateToPose goal accepted (gen={generation})")
        self._broadcast_nav_status("NAVIGATING", "Navigating toward target")

    def _on_nav_feedback(self, feedback_msg, generation: int):
        record = self._get_nav_record(generation)
        if record is None or not self._is_current_nav_record(record):
            return
        feedback = feedback_msg.feedback
        distance_remaining = getattr(feedback, "distance_remaining", 0.0)
        payload = {
            "type": "nav_feedback",
            "navigation": {
                "navigationState": "NAVIGATING",
                "distanceRemainingM": distance_remaining,
                "goal": self.current_goal_pose,
            },
        }
        self.broadcast(payload)

    def _on_nav_result(self, future, generation: int):
        record = self._get_nav_record(generation)
        if record is None:
            return

        try:
            result_wrap = future.result()
            status = result_wrap.status
        except Exception as exc:
            self.logger.error(f"Nav2 result callback failed (gen={generation}): {exc}")
            status = None

        terminal_state = None
        terminal_detail = ""
        should_broadcast = False
        should_zero = False

        with self._nav_state_lock:
            # The terminal event is deliberately NOT set yet. Every waiter that treats
            # result_event as the cancellation barrier must observe the finalized bridge
            # state, not merely the fact that a ROS future completed.
            record.result_status = status
            current = self._is_current_nav_record(record)
            cancel_action = record.cancel_action

            # A terminal record is safe to remove from the pending/cancellation/safety
            # references regardless of whether it is still the current UI operation.
            if self._nav_cancel_record is record:
                self._nav_cancel_record = None
            if self._nav_safety_lock_record is record:
                self._nav_safety_lock_record = None

            if not current:
                # Stale callbacks may only finish the lifecycle of their own record. They
                # must never overwrite a newer goal, but they must still release any
                # stale bookkeeping that points at this now-terminal record.
                if cancel_action == "CANCEL":
                    same_cancel = self._current_nav_record is None and self.nav_state == "CANCELING"
                    if same_cancel:
                        self.current_goal_pose = None
                        if status == GoalStatus.STATUS_SUCCEEDED:
                            self.nav_state = "GOAL_REACHED"
                            terminal_state = "GOAL_REACHED"
                            terminal_detail = "Target waypoint reached before cancellation completed"
                        else:
                            self.nav_state = "CANCELED"
                            terminal_state = "CANCELED"
                            terminal_detail = "Navigation canceled"
                        self._release_navigation_with_zero()
                        should_broadcast = True
                elif cancel_action == "DISCONNECT":
                    # Disconnect cleanup may already have a newer generation only if a
                    # caller violated the admission barrier. Never release ownership
                    # belonging to a newer current record.
                    if self._current_nav_record is None:
                        self.current_goal_handle = None
                        self._release_navigation_with_zero()
                elif cancel_action == "REPLACE":
                    # If replacement B is already current, only A's record is cleaned.
                    # When no newer goal exists, the old replacement target is terminal.
                    if self._current_nav_record is None and self.nav_state == "CANCELING":
                        self.current_goal_handle = None
                        self.nav_state = "CANCELED"
                        self._release_navigation_with_zero()
                        terminal_state = "CANCELED"
                        terminal_detail = "Previous navigation goal terminated"
                        should_broadcast = True
                elif cancel_action == "PAUSE":
                    same_pause = self._current_nav_record is None and self.nav_state == "PAUSED"
                    if same_pause and status == GoalStatus.STATUS_SUCCEEDED:
                        self.nav_state = "GOAL_REACHED"
                        self.current_goal_pose = None
                        self._release_navigation_with_zero()
                        terminal_state = "GOAL_REACHED"
                        terminal_detail = "Target waypoint reached before pause completed"
                        should_broadcast = True
                    elif same_pause and status not in (None, GoalStatus.STATUS_CANCELED):
                        self.nav_state = "FAILED"
                        self._release_navigation_with_zero()
                        terminal_state = "FAILED"
                        terminal_detail = f"Navigation ended with status {status} while pausing"
                        should_broadcast = True
                else:
                    # Unclassified stale terminal records are inert. In particular, never
                    # zero the robot if a newer navigation record is already active.
                    should_zero = self._current_nav_record is None
            else:
                self.current_goal_handle = None
                self._current_nav_record = None
                if status == GoalStatus.STATUS_SUCCEEDED:
                    self.nav_state = "GOAL_REACHED"
                    terminal_state = "GOAL_REACHED"
                    terminal_detail = "Target waypoint reached"
                elif status == GoalStatus.STATUS_CANCELED:
                    self.nav_state = "CANCELED"
                    terminal_state = "CANCELED"
                    terminal_detail = "Route canceled by operator"
                else:
                    self.nav_state = "FAILED"
                    terminal_state = "FAILED"
                    terminal_detail = f"Navigation failed with status {status}"
                self._release_navigation_with_zero()
                should_broadcast = True

        # result_event is observable only after state cleanup and any owner-bound zero have
        # completed. It is therefore a genuine bridge-side terminality barrier for callers.
        if should_zero:
            self.publish_zero_velocity()

        record.result_event.set()

        if should_broadcast and terminal_state is not None:
            self._broadcast_nav_status(terminal_state, terminal_detail)

    def _on_nav_cancel_response(self, future, record: NavGoalRecord):
        """Record cancel-request outcome; Nav2 result remains the terminality barrier."""
        return_code = None
        try:
            response = future.result()
            return_code = getattr(response, "return_code", None)
            # The cancel response tells us whether Nav2 accepted the cancellation
            # request; it does not itself prove that the NavigateToPose goal has
            # reached a terminal result. Keep ownership until result_event is set.
            if return_code is None:
                ok = True
            else:
                ok = return_code in (0, 2, 3)
        except Exception as exc:
            ok = False
            self.logger.error(
                f"Nav2 cancellation request failed (gen={record.generation}): {exc}"
            )

        with self._nav_state_lock:
            record.cancel_response_ok = ok
            if not ok and not record.result_event.is_set():
                self._nav_safety_lock_record = record
                with self._motion_owner_lock:
                    self.motion_owner = MOTION_NAVIGATION

        if ok:
            self.logger.info(
                f"Nav2 cancellation accepted for generation {record.generation}; awaiting terminal result"
            )
        else:
            self.publish_zero_velocity()
            self.logger.error(
                f"Nav2 cancellation not accepted for generation {record.generation}; motion remains locked"
            )

    async def _await_nav_termination(self, record: Optional[NavGoalRecord], timeout: Optional[float] = None) -> bool:
        if record is None or record.result_event.is_set():
            return True
        wait_timeout = self._nav_cancel_timeout_sec if timeout is None else timeout
        loop = asyncio.get_running_loop()
        completed = await loop.run_in_executor(None, record.result_event.wait, wait_timeout)
        if completed:
            with self._nav_state_lock:
                if self._nav_cancel_record is record:
                    self._nav_cancel_record = None
                if self._nav_safety_lock_record is record:
                    self._nav_safety_lock_record = None
            return True
        with self._nav_state_lock:
            self._nav_safety_lock_record = record
            with self._motion_owner_lock:
                self.motion_owner = MOTION_NAVIGATION
        self.publish_zero_velocity()
        self.logger.error(
            f"Nav2 goal generation {record.generation} did not terminate within {wait_timeout:.1f}s"
        )
        return False

    async def cancel_navigation_async(self):
        """Cancel navigation and release ownership only after Nav2 is terminal."""
        async with self._nav_lock:
            record = self._request_cancel_current_goal("CANCEL")
            if record is None:
                with self._nav_state_lock:
                    self._bump_nav_generation()
                    self._current_nav_record = None
                    self.current_goal_handle = None
                    self.current_goal_pose = None
                    self.nav_state = "CANCELED"
                    self._release_navigation_with_zero()
                self._broadcast_nav_status("CANCELED", "Navigation canceled")
                return

            with self._nav_state_lock:
                self._bump_nav_generation()
                self._current_nav_record = None
                self.current_goal_handle = None
                self.nav_state = "CANCELING"
            self.publish_zero_velocity()
            self._broadcast_nav_status("CANCELING", "Waiting for Nav2 cancellation")

            completed = await self._await_nav_termination(record)
            if not completed:
                # Keep NAVIGATION ownership and CANCELING state. A later terminal result
                # will release the safety lock; until then another motion source is blocked.
                return

            with self._nav_state_lock:
                result_status = record.result_status
                self.current_goal_pose = None
                if result_status == GoalStatus.STATUS_SUCCEEDED:
                    self.nav_state = "GOAL_REACHED"
                    terminal_state = "GOAL_REACHED"
                    terminal_detail = "Target waypoint reached before cancellation completed"
                else:
                    self.nav_state = "CANCELED"
                    terminal_state = "CANCELED"
                    terminal_detail = "Navigation canceled"
                self._release_navigation_with_zero()
            self._broadcast_nav_status(terminal_state, terminal_detail)

    async def pause_navigation_async(self):
        """Pause navigation by canceling the goal while retaining the target and ownership."""
        async with self._nav_lock:
            record = self._request_cancel_current_goal("PAUSE")
            if record is None:
                # Lifecycle events (blur/pagehide/visibility) can request a pause even
                # while navigation is idle. Never create a phantom PAUSED navigation owner.
                with self._nav_state_lock:
                    has_preserved_goal = self.current_goal_pose is not None
                self.publish_zero_velocity()
                if not has_preserved_goal:
                    return
                with self._nav_state_lock:
                    self._bump_nav_generation()
                    self.nav_state = "PAUSED"
                if not self._try_acquire_ownership(MOTION_NAVIGATION):
                    with self._nav_state_lock:
                        self.nav_state = "FAILED"
                    self._broadcast_nav_status("FAILED", "Navigation pause could not retain motion ownership")
                    return
                self._broadcast_nav_status("PAUSED", "Navigation paused by operator")
                return

            with self._nav_state_lock:
                self._bump_nav_generation()
                self._current_nav_record = None
                self.current_goal_handle = None
                self.nav_state = "PAUSED"
            self.publish_zero_velocity()
            self._try_acquire_ownership(MOTION_NAVIGATION)
            self._broadcast_nav_status("PAUSED", "Navigation paused by operator")

    async def resume_navigation_async(self):
        """Resume preserved navigation only after any prior pause cancellation is terminal."""
        async with self._nav_lock:
            if not self.accepting_commands:
                self.logger.warn("Resume rejected: no connected operator")
                return

            if not self.current_goal_pose:
                self.logger.warn("Resume requested but no preserved goal to resume")
                self._broadcast_nav_status("FAILED", "No preserved goal to resume")
                return

            if not HAS_NAV2 or self.nav_client is None:
                self.logger.error("Resume requested but Nav2 action client is not available")
                self._broadcast_nav_status("FAILED", "Nav2 action client not available")
                return

            if self._nav_safety_lock_record is not None:
                self.logger.error("Resume rejected: navigation safety lock is active")
                self._broadcast_nav_status("PAUSED", "Resume blocked until the previous Nav2 goal terminates")
                return

            pending = self._nav_cancel_record
            if pending is not None and not pending.result_event.is_set():
                if not await self._await_nav_termination(pending):
                    return
            if pending is not None and pending.result_status == GoalStatus.STATUS_SUCCEEDED:
                with self._nav_state_lock:
                    self.nav_state = "GOAL_REACHED"
                    self.current_goal_pose = None
                    self._release_navigation_with_zero()
                self._broadcast_nav_status("GOAL_REACHED", "Target waypoint reached before resume")
                return

            pose = dict(self.current_goal_pose)
            if not self._try_acquire_ownership(MOTION_NAVIGATION):
                self.logger.error("Resume rejected: navigation ownership is no longer available")
                self._broadcast_nav_status("PAUSED", "Resume blocked because another motion owner is active")
                return
            generation = self._bump_nav_generation()
            with self._nav_state_lock:
                self.nav_state = "PLANNING"
            self._send_nav_goal(
                float(pose["x"]),
                float(pose["y"]),
                float(pose["yaw"]),
                generation,
                "Resuming navigation to preserved goal",
            )

    # Compatibility wrappers for any synchronous internal callers.
    def cancel_navigation(self):
        """Schedule cancellation when called outside the websocket async path."""
        if self.loop is not None:
            asyncio.run_coroutine_threadsafe(self.cancel_navigation_async(), self.loop)

    def pause_navigation(self):
        if self.loop is not None:
            asyncio.run_coroutine_threadsafe(self.pause_navigation_async(), self.loop)

    def resume_navigation(self):
        if self.loop is not None:
            asyncio.run_coroutine_threadsafe(self.resume_navigation_async(), self.loop)

    def _broadcast_nav_status(self, state: str, detail: str = ""):
        with self._nav_state_lock:
            goal = self.current_goal_pose if state in ("PLANNING", "NAVIGATING", "PAUSED", "CANCELING") else None
        payload = {
            "type": "nav_status",
            "navigation": {
                "navigationState": state,
                "detail": detail,
                "goal": goal,
            },
        }
        self.broadcast(payload)

    # --------------------------------------------------------------------------
    # Subprocess Management for Autonomous Exploration
    # --------------------------------------------------------------------------
    def _current_explore_record(self) -> Optional[ExplorationProcessRecord]:
        with self._explore_lock:
            return self._explore_record

    def _finalize_exploration_record(self, record: ExplorationProcessRecord, unexpected: bool) -> bool:
        """Finalize one exact exploration process. Returns True only if it is current."""
        with self._explore_lock:
            if record.finalized:
                if record.process.poll() is not None:
                    record.termination_event.set()
                return False
            if self._explore_record is not record or record.generation != self._explore_generation:
                # A superseded monitor/terminator must be completely inert. In particular,
                # it must not publish a safety zero that could interrupt a newer process.
                if record.process.poll() is not None:
                    record.termination_event.set()
                return False
            if record.process.poll() is None:
                return False

            record.finalized = True
            self.explore_process = None
            self._explore_record = None
            self._explore_monitor_active = False
            self.active_frontiers.clear()
            self.frontier_count = 0
            self.selected_frontier = None

            self.publish_zero_velocity()
            if unexpected and not record.stop_requested:
                self.exploration_state = "ERROR"
            else:
                self.exploration_state = "IDLE"
            self._release_ownership(MOTION_EXPLORATION)
            self._broadcast_exploration_telemetry()
            record.termination_event.set()
            return True

    def start_exploration(self):
        """Launch the existing autonomous exploration stack as one supervised process group."""
        if not self.accepting_commands:
            self.logger.warn("Exploration start rejected: no connected LIVE operator")
            self._broadcast_exploration_telemetry()
            return

        # Snapshot navigation lifecycle before entering the exploration lock. Do not
        # acquire _explore_lock → _nav_state_lock here: disconnect finalization uses the
        # opposite order. The motion-owner lock remains the final admission gate, so a
        # navigation request racing this snapshot still wins/excludes exploration.
        with self._nav_state_lock:
            nav_lifecycle_busy = self.nav_state in ("PLANNING", "NAVIGATING", "PAUSED", "CANCELING")
            nav_safety_locked = self._nav_safety_lock_record is not None

        with self._explore_lock:
            existing = self._explore_record
            if existing is not None:
                if existing.stop_requested or self.exploration_state == "STOPPING":
                    self.logger.warn("Exploration restart rejected: previous process is still stopping")
                    self.exploration_state = "STOPPING"
                    self._broadcast_exploration_telemetry()
                    return
                if existing.process.poll() is None:
                    self.logger.warn("Exploration launch process is already running")
                    if not self._try_acquire_ownership(MOTION_EXPLORATION):
                        self.exploration_state = "ERROR"
                        self._broadcast_exploration_telemetry()
                        return
                    self.exploration_state = "EXPLORING" if self.frontier_count > 0 else "STARTING"
                    self._broadcast_exploration_telemetry()
                    return
                # The process has exited but its monitor may not have finalized it yet.
                self.logger.info("Exploration process has exited; waiting for lifecycle finalization before restart")
                self.exploration_state = "STOPPING"
                self._broadcast_exploration_telemetry()
                return

            if nav_safety_locked:
                self.logger.warn("Exploration start rejected: navigation safety lock is active")
                self.exploration_state = "ERROR"
                self._broadcast_exploration_telemetry()
                return
            if nav_lifecycle_busy:
                self.logger.warn("Exploration start rejected: navigation lifecycle is active")
                self.exploration_state = "ERROR"
                self._broadcast_exploration_telemetry()
                return

            if not os.path.exists(EXPLORATION_LAUNCH_PATH):
                self.logger.error(f"Exploration launch file not found: {EXPLORATION_LAUNCH_PATH}")
                self.exploration_state = "ERROR"
                self._release_ownership(MOTION_EXPLORATION)
                self._broadcast_exploration_telemetry()
                return

            if not self._try_acquire_ownership(MOTION_EXPLORATION):
                self.logger.error("Exploration start rejected: another motion owner is active")
                self.exploration_state = "ERROR"
                self._broadcast_exploration_telemetry()
                return

            # A new run must never inherit frontiers selected by a previous run.
            self.active_frontiers.clear()
            self.frontier_count = 0
            self.selected_frontier = None
            self.exploration_state = "STARTING"
            self._broadcast_exploration_telemetry()

            self._explore_generation += 1
            current_generation = self._explore_generation
            self._explore_monitor_active = True

            cmd = f"source {ENV_SCRIPT_PATH} && ros2 launch {EXPLORATION_LAUNCH_PATH}"
            process = None
            try:
                # Keep launch admission and process-record installation in the same short
                # motion lock. If disconnect/source-switch cleanup wins the lock first, no
                # new autonomous process can be spawned after the bridge is disarmed.
                with self._motion_owner_lock:
                    if (
                        self._cleanup_in_progress
                        or self._source_switch_in_progress
                        or not self.accepting_commands
                        or self.motion_owner != MOTION_EXPLORATION
                    ):
                        raise RuntimeError("Bridge was disarmed before exploration launch")
                    process = subprocess.Popen(
                        ["bash", "-c", cmd],
                        start_new_session=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    record = ExplorationProcessRecord(
                        generation=current_generation,
                        process=process,
                    )
                    self._explore_record = record
                    self.explore_process = process
                    self.logger.info(f"Exploration process group started with PID: {process.pid}")
                    self._broadcast_exploration_telemetry()

                threading.Thread(
                    target=self._monitor_explore_process,
                    args=(record,),
                    daemon=True,
                ).start()
            except Exception as exc:
                self.logger.error(f"Failed to launch exploration subprocess: {exc}")
                if process is not None and self._explore_record is not None:
                    # Popen succeeded, but a later launch/monitor step failed. Never leave
                    # an untracked autonomous process behind just because the monitor thread
                    # could not be installed. Reuse the exact-record terminator synchronously
                    # so ownership is released only after the process is actually stopped.
                    record = self._explore_record
                    record.stop_requested = True
                    self.exploration_state = "STOPPING"
                    self._explore_monitor_active = False
                    try:
                        self._terminate_explore_process(record)
                    except Exception as terminate_exc:
                        self.logger.error(
                            f"Exploration launch cleanup also failed for gen={record.generation}: {terminate_exc}"
                        )
                else:
                    self.exploration_state = "ERROR"
                    self._explore_monitor_active = False
                    self._explore_record = None
                    self.explore_process = None
                    self._release_ownership(MOTION_EXPLORATION)
                self._broadcast_exploration_telemetry()

    def _monitor_explore_process(self, record: ExplorationProcessRecord):
        process = record.process
        exit_code = process.wait()
        self.logger.info(
            f"Exploration subprocess gen={record.generation} pid={process.pid} exited with return code: {exit_code}"
        )
        unexpected = not record.stop_requested
        # Check identity BEFORE any physical action. A stale monitor must be inert.
        self._finalize_exploration_record(record, unexpected=unexpected)

    def stop_exploration(self):
        """Request exact exploration-process termination and immediately zero velocity."""
        with self._explore_lock:
            record = self._explore_record
            if record is None:
                if self.exploration_state not in ("IDLE", "COMPLETE"):
                    self.exploration_state = "IDLE"
                    self._release_ownership(MOTION_EXPLORATION)
                    self._broadcast_exploration_telemetry()
                self.publish_zero_velocity()
                return

            if record.finalized:
                return
            if record.stop_requested:
                # An earlier stop already owns the termination lifecycle. Keep the
                # robot stopped but do not create another termination thread.
                self.publish_zero_velocity()
                return

            record.stop_requested = True
            self.exploration_state = "STOPPING"
            self._broadcast_exploration_telemetry()
            self.publish_zero_velocity()
            process = record.process

            if process.poll() is None:
                threading.Thread(
                    target=self._terminate_explore_process,
                    args=(record,),
                    daemon=True,
                ).start()
            else:
                # The process already exited; let the exact monitor/record finalizer
                # own the lifecycle transition instead of inventing a second one.
                threading.Thread(
                    target=self._finalize_exploration_record,
                    args=(record, False),
                    daemon=True,
                ).start()

    def _terminate_explore_process(self, record: ExplorationProcessRecord):
        """Terminate one exact process object; never follow a mutable global process pointer."""
        process = record.process
        termination_ok = False
        try:
            pgid = os.getpgid(process.pid) if hasattr(os, "getpgid") else None
            if pgid:
                try:
                    os.killpg(pgid, signal.SIGINT)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=3.0)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(pgid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=2.0)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(pgid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        try:
                            process.wait(timeout=2.0)
                        except subprocess.TimeoutExpired:
                            pass
            else:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=3.0)
                except subprocess.TimeoutExpired:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=2.0)
                    except subprocess.TimeoutExpired:
                        pass
            termination_ok = process.poll() is not None
        except Exception as exc:
            self.logger.error(f"Error terminating exploration process gen={record.generation}: {exc}")
        finally:
            # Only the exact current record may mutate the active bridge state. A stale
            # termination thread must not clear/zero/terminate a newer exploration.
            if termination_ok:
                self._finalize_exploration_record(record, unexpected=False)
            else:
                self.logger.error(
                    f"Exploration process gen={record.generation} did not terminate after escalation; keeping owner locked"
                )
                with self._explore_lock:
                    is_current = (
                        self._explore_record is record
                        and record.generation == self._explore_generation
                        and not record.finalized
                    )
                if is_current:
                    self.publish_zero_velocity()
                else:
                    record.termination_event.set()

    # --------------------------------------------------------------------------
    # Velocity Commands & Safety
    # --------------------------------------------------------------------------
    def _try_acquire_ownership(self, owner: str) -> bool:
        """Atomically acquire the sole motion-owner slot for one subsystem."""
        with self._motion_owner_lock:
            # A disarmed session or source-switch reservation must block every new
            # motion owner, even if the caller already checked accepting_commands.
            if self._source_switch_in_progress or not self.accepting_commands:
                return False
            if self.motion_owner == MOTION_NONE:
                self.motion_owner = owner
                self.logger.info(f"Motion ownership transferred to: {owner}")
                return True
            if self.motion_owner == owner:
                return True
            current = self.motion_owner
        self.logger.warn(
            f"Motion command rejected: {owner} requested but {current} owns motion"
        )
        return False

    def _release_navigation_with_zero(self):
        """Atomically zero and release NAVIGATION so a fresh owner cannot interleave between them."""
        with self._motion_owner_lock:
            if self.motion_owner != MOTION_NAVIGATION:
                return False
            self._publish_zero_locked()
            self.motion_owner = MOTION_NONE
            self.logger.info("Motion ownership released by: NAVIGATION")
            return True

    def _release_ownership(self, owner: str):
        with self._motion_owner_lock:
            if self.motion_owner == owner:
                self.motion_owner = MOTION_NONE
                self.logger.info(f"Motion ownership released by: {owner}")

    def _invalidate_manual_session_locked(self) -> Optional[str]:
        """Invalidate the active manual lease while holding _motion_owner_lock."""
        expired_session = self._manual_session_id
        if expired_session is not None:
            self._invalidated_manual_session_ids.append(expired_session)
        self._manual_session_id = None
        self._last_manual_command_at = time.monotonic()
        if self.motion_owner == MOTION_MANUAL:
            self.motion_owner = MOTION_NONE
            self.logger.info("Motion ownership released by: MANUAL")
        return expired_session

    def _publish_zero_locked(self):
        """Publish a zero Twist while _motion_owner_lock is already held."""
        self.last_cmd_vel = {"linear": 0.0, "angular": 0.0}
        self._last_manual_command_at = time.monotonic()
        msg = Twist()
        msg.linear.x = 0.0
        msg.angular.z = 0.0
        self.cmd_vel_pub.publish(msg)

    def publish_velocity(
        self,
        linear: float,
        angular: float,
        manual_session_id: Optional[str] = None,
        new_manual_session: bool = False,
    ):
        """Publish a browser MANUAL cmd_vel through a time-limited control lease."""
        if not (math.isfinite(linear) and math.isfinite(angular)):
            self.logger.warn(f"Manual cmd_vel rejected: non-finite values linear={linear} angular={angular}")
            return
        max_linear = SAFE_LINEAR_MPS if linear >= 0.0 else SAFE_REVERSE_MPS
        if abs(linear) > max_linear + 1e-6 or abs(angular) > SAFE_ANGULAR_RADPS + 1e-6:
            self.logger.warn(
                f"Manual cmd_vel rejected: exceeds safety limits linear={linear} angular={angular}"
            )
            return

        is_zero = linear == 0.0 and angular == 0.0
        if is_zero:
            # Manual stop must be one atomic transition. Otherwise a fresh non-zero command
            # could be accepted between publishing zero and releasing MANUAL ownership.
            with self._motion_owner_lock:
                self._invalidate_manual_session_locked()
                self._publish_zero_locked()
            return

        if not self.accepting_commands:
            self.logger.warn("Manual cmd_vel rejected: operator session is not armed")
            return

        if not isinstance(manual_session_id, str) or not (1 <= len(manual_session_id) <= 128):
            self.logger.warn("Manual cmd_vel rejected: valid manual session id is required")
            return

        with self._nav_state_lock:
            nav_safety_locked = self._nav_safety_lock_record is not None
        if nav_safety_locked:
            self.logger.warn("Manual cmd_vel rejected: navigation safety lock is active")
            return

        with self._motion_owner_lock:
            if self._source_switch_in_progress or not self.accepting_commands:
                return

            if self.motion_owner == MOTION_NONE:
                # A physical manual session must explicitly start after a stop/watchdog
                # expiry. Delayed packets from the previous session cannot re-arm motion.
                if not new_manual_session:
                    self.logger.warn("Manual cmd_vel rejected: fresh manual session start required")
                    return
                if manual_session_id in self._invalidated_manual_session_ids:
                    self.logger.warn("Manual cmd_vel rejected: invalidated manual session id reused")
                    return
                self.motion_owner = MOTION_MANUAL
                self._manual_session_id = manual_session_id
                self.logger.info("Motion ownership transferred to: MANUAL")
            elif self.motion_owner == MOTION_MANUAL:
                if self._manual_session_id != manual_session_id:
                    self.logger.warn("Manual cmd_vel rejected: manual session id does not match active lease")
                    return
            else:
                self.logger.warn(
                    f"Manual cmd_vel rejected: {self.motion_owner} owns motion"
                )
                return

            self._last_manual_command_at = time.monotonic()
            self.last_cmd_vel = {"linear": linear, "angular": angular}
            msg = Twist()
            msg.linear.x = float(linear)
            msg.angular.z = float(angular)
            self.cmd_vel_pub.publish(msg)

    def publish_zero_velocity(self):
        # Zero is always allowed. If MANUAL owns the bridge, clear that lease atomically
        # with the zero publication so a concurrent command cannot leave non-zero motion
        # behind after ownership is released. Non-manual owners remain logically retained.
        with self._motion_owner_lock:
            if self.motion_owner == MOTION_MANUAL:
                self._invalidate_manual_session_locked()
            self._publish_zero_locked()

    def _manual_watchdog_loop(self):
        """Fail-safe manual-motion watchdog for frozen/throttled browser sessions."""
        while not self._manual_watchdog_stop.wait(MANUAL_WATCHDOG_POLL_SEC):
            expired_session = None
            with self._motion_owner_lock:
                if self.motion_owner != MOTION_MANUAL:
                    continue
                if self.last_cmd_vel["linear"] == 0.0 and self.last_cmd_vel["angular"] == 0.0:
                    continue
                if time.monotonic() - self._last_manual_command_at <= MANUAL_COMMAND_TIMEOUT_SEC:
                    continue

                expired_session = self._invalidate_manual_session_locked()
                self._publish_zero_locked()

            self.logger.warn(
                "Manual command heartbeat expired; forcing zero velocity and invalidating the manual session"
            )
            if expired_session is not None:
                self.broadcast({
                    "type": "manual_session_expired",
                    "manual_session_id": expired_session,
                    "reason": "heartbeat_timeout",
                })

    def begin_last_client_disconnect(self):
        """Disarm immediately; cleanup is idempotent until the tracked sources are terminal."""
        with self._motion_owner_lock:
            self.accepting_commands = False
            if not self._cleanup_in_progress:
                self._cleanup_generation += 1
                self._cleanup_in_progress = True
                self._cleanup_complete_event.clear()
        self.publish_zero_velocity()

    def shutdown_blocking(self, timeout_sec: float = 10.0) -> bool:
        """Run bounded physical-motion shutdown and return whether every tracked source terminated."""
        with self._motion_owner_lock:
            self.accepting_commands = False
            self._source_switch_in_progress = True
        self.publish_zero_velocity()
        deadline = time.monotonic() + timeout_sec

        with self._nav_state_lock:
            if self._current_nav_record is not None:
                nav_record = self._current_nav_record
            elif self._nav_cancel_record is not None:
                nav_record = self._nav_cancel_record
            else:
                nav_record = self._nav_safety_lock_record
            if nav_record is not None:
                nav_record.cancel_action = "DISCONNECT"
        nav_record = self._request_cancel_current_goal("DISCONNECT") or nav_record
        if nav_record is not None and not nav_record.result_event.is_set():
            with self._nav_state_lock:
                nav_record.cancel_action = nav_record.cancel_action or "DISCONNECT"
                self._bump_nav_generation()
                if self._current_nav_record is nav_record:
                    self._current_nav_record = None
                self.current_goal_handle = None
                self.nav_state = "CANCELING"
                with self._motion_owner_lock:
                    self.motion_owner = MOTION_NAVIGATION
            self._start_cancel_for_record(nav_record)
            self.publish_zero_velocity()
            remaining = max(0.0, deadline - time.monotonic())
            nav_record.result_event.wait(remaining)

        with self._explore_lock:
            explore_record = self._explore_record
            if explore_record is not None and not explore_record.termination_event.is_set():
                explore_record.stop_requested = True
                self.exploration_state = "STOPPING"
                process = explore_record.process
                if process.poll() is None:
                    threading.Thread(
                        target=self._terminate_explore_process,
                        args=(explore_record,),
                        daemon=True,
                    ).start()

        if explore_record is not None:
            remaining = max(0.0, deadline - time.monotonic())
            explore_record.termination_event.wait(remaining)

        self.publish_zero_velocity()
        self._release_ownership(MOTION_MANUAL)
        if nav_record is None or nav_record.result_event.is_set():
            self._release_ownership(MOTION_NAVIGATION)
        with self._explore_lock:
            if self._explore_record is None or self._explore_record.termination_event.is_set():
                self._release_ownership(MOTION_EXPLORATION)
        self._manual_watchdog_stop.set()
        self._nav_cancel_watchdog_stop.set()
        nav_terminal = nav_record is None or nav_record.result_event.is_set()
        explore_terminal = explore_record is None or explore_record.termination_event.is_set()
        if not nav_terminal:
            self.logger.error(
                "Bridge shutdown timed out waiting for Nav2 termination; physical power switch remains the final emergency stop"
            )
        if not explore_terminal:
            self.logger.error(
                "Bridge shutdown timed out waiting for exploration termination; physical power switch remains the final emergency stop"
            )
        return nav_terminal and explore_terminal

    def _finalize_disconnect_cleanup(self, cleanup_gen: int):
        """Mark disconnect cleanup complete only after every tracked motion source is terminal."""
        with self._motion_owner_lock:
            current_cleanup_gen = self._cleanup_generation
        with self._nav_state_lock:
            if cleanup_gen != current_cleanup_gen:
                return False
            if self._nav_cancel_record is not None and not self._nav_cancel_record.result_event.is_set():
                return False

        # Do not clear the global motion owner until the exploration process has also
        # terminated. A still-running explorer is itself a physical motion source.
        with self._explore_lock:
            record = self._explore_record
            if record is not None and not record.termination_event.is_set():
                return False
            if record is not None and record.process.poll() is None:
                return False
            self._explore_record = None
            self.explore_process = None
            self._explore_monitor_active = False
            self.exploration_state = "IDLE"

        with self._nav_state_lock:
            self._current_nav_record = None
            self.current_goal_handle = None
            self.current_goal_pose = None
            self.nav_state = "IDLE"
            self._nav_safety_lock_record = None
            self._nav_cancel_record = None

        with self._motion_owner_lock:
            self.motion_owner = MOTION_NONE
            self.last_cmd_vel = {"linear": 0.0, "angular": 0.0}
            self._manual_session_id = None
            self._last_manual_command_at = time.monotonic()

        self.publish_zero_velocity()
        with self._motion_owner_lock:
            self._source_switch_in_progress = False
            self.accepting_commands = False
        self._broadcast_nav_status("IDLE", "Operator disconnected")
        self._broadcast_exploration_telemetry()

        finalized = False
        with self._motion_owner_lock:
            if cleanup_gen == self._cleanup_generation:
                self._cleanup_in_progress = False
                self._cleanup_complete_event.set()
                finalized = True
        if not finalized:
            return False
        self.logger.info("Last operator disconnect cleanup completed: motion halted and ownership reset")
        return True

    def _wait_for_disconnect_cleanup(self, cleanup_gen: int, nav_record: Optional[NavGoalRecord], explore_record: Optional[ExplorationProcessRecord]):
        """Wait in a daemon worker until every tracked physical motion source is terminal."""
        if nav_record is not None:
            nav_record.result_event.wait()
        if explore_record is not None:
            explore_record.termination_event.wait()
        self._finalize_disconnect_cleanup(cleanup_gen)

    async def complete_last_client_disconnect(self):
        """Cancel Nav2 and exploration, then re-arm only after both are terminal."""
        with self._motion_owner_lock:
            cleanup_gen = self._cleanup_generation
        with self._idle_cleanup_lock:
            if self._idle_cleanup_running:
                return
            self._idle_cleanup_running = True

        nav_record: Optional[NavGoalRecord] = None
        explore_record: Optional[ExplorationProcessRecord] = None
        try:
            with self._motion_owner_lock:
                self.accepting_commands = False
            self.publish_zero_velocity()

            # Serialize this cleanup with every browser-originated navigation operation.
            async with self._nav_lock:
                with self._nav_state_lock:
                    nav_record = self._current_nav_record or self._nav_cancel_record
                if nav_record is not None and not nav_record.result_event.is_set():
                    if not nav_record.cancel_requested:
                        self._start_cancel_for_record(nav_record)
                    self._bump_nav_generation()
                    self._current_nav_record = None
                    self.current_goal_handle = None
                    self.nav_state = "CANCELING"
                    with self._motion_owner_lock:
                        self.motion_owner = MOTION_NAVIGATION
                    self.publish_zero_velocity()
                    self._broadcast_nav_status("CANCELING", "Operator disconnected; waiting for Nav2 termination")

                if nav_record is not None:
                    nav_done = await self._await_nav_termination(nav_record, timeout=self._nav_cancel_timeout_sec)
                else:
                    nav_done = True

            # Exploration stop uses exact process identity and its own lifecycle lock.
            with self._explore_lock:
                explore_record = self._explore_record
                if explore_record is not None and not explore_record.termination_event.is_set():
                    explore_record.stop_requested = True
                    self.exploration_state = "STOPPING"
                    self._broadcast_exploration_telemetry()
                    self.publish_zero_velocity()
                    process = explore_record.process
                    if process.poll() is None:
                        threading.Thread(
                            target=self._terminate_explore_process,
                            args=(explore_record,),
                            daemon=True,
                        ).start()

            if explore_record is not None:
                loop = asyncio.get_running_loop()
                explore_done = await loop.run_in_executor(None, explore_record.termination_event.wait, 10.0)
            else:
                explore_done = True

            if nav_done and explore_done:
                self._finalize_disconnect_cleanup(cleanup_gen)
            else:
                # Never re-arm on timeout. A background waiter finishes the cleanup if
                # Nav2/process callbacks eventually report terminal state.
                if nav_record is not None or explore_record is not None:
                    threading.Thread(
                        target=self._wait_for_disconnect_cleanup,
                        args=(cleanup_gen, nav_record, explore_record),
                        daemon=True,
                    ).start()
                self.logger.error("Disconnect cleanup is still pending; operator control remains locked")
        finally:
            with self._idle_cleanup_lock:
                self._idle_cleanup_running = False

    async def wait_for_operator_cleanup(self):
        """Do not arm a reconnecting operator until prior disconnect cleanup is complete."""
        with self._motion_owner_lock:
            cleanup_in_progress = self._cleanup_in_progress
        if not cleanup_in_progress:
            return
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._cleanup_complete_event.wait)

    def restore_operator_session(self):
        """Re-arm only after cleanup and every tracked lifecycle are demonstrably idle."""
        with self._motion_owner_lock:
            if self._cleanup_in_progress or self._source_switch_in_progress:
                self.logger.info("Operator restore rejected: bridge cleanup/source switch is still in progress")
                return False
            if self.motion_owner != MOTION_NONE:
                self.logger.info("Operator restore rejected: a motion owner is still active")
                return False
            if self.last_cmd_vel["linear"] != 0.0 or self.last_cmd_vel["angular"] != 0.0:
                self.logger.info("Operator restore rejected: non-zero command state remains")
                return False

        with self._nav_state_lock:
            nav_busy = (
                self._current_nav_record is not None
                or self._nav_cancel_record is not None
                or self._nav_safety_lock_record is not None
                or self.nav_state in ("PLANNING", "NAVIGATING", "PAUSED", "CANCELING")
            )
        if nav_busy:
            self.logger.info("Operator restore rejected: navigation lifecycle is still active")
            return False

        with self._explore_lock:
            explore_busy = (
                self._explore_record is not None
                or self.explore_process is not None
                or self.exploration_state in ("STARTING", "EXPLORING", "STOPPING")
            )
        if explore_busy:
            self.logger.info("Operator restore rejected: exploration lifecycle is still active")
            return False

        with self._motion_owner_lock:
            # Re-check the bridge-level gate after the lifecycle snapshots. This does not
            # replace the cleanup event barrier; it closes the final admission window.
            if self._cleanup_in_progress or self._source_switch_in_progress or self.motion_owner != MOTION_NONE:
                return False
            self.last_cmd_vel = {"linear": 0.0, "angular": 0.0}
            self._manual_session_id = None
            self._last_manual_command_at = time.monotonic()
            self.accepting_commands = True
        return True

    def can_switch_source(self) -> bool:
        # This method is a read-only UI hint. Keep each lock acquisition separate so
        # it cannot participate in an inverse-order deadlock with lifecycle finalizers.
        with self._motion_owner_lock:
            if self._source_switch_in_progress or not self.accepting_commands:
                return False
            if self.motion_owner != MOTION_NONE:
                return False
            if self.last_cmd_vel["linear"] != 0.0 or self.last_cmd_vel["angular"] != 0.0:
                return False
        with self._nav_state_lock:
            if self._nav_safety_lock_record is not None:
                return False
            nav_state = self.nav_state
        if nav_state in ("PLANNING", "NAVIGATING", "PAUSED", "CANCELING"):
            return False
        with self._explore_lock:
            explore_state = self.exploration_state
        if explore_state in ("STARTING", "EXPLORING", "STOPPING"):
            return False
        with self._motion_owner_lock:
            return not self._cleanup_in_progress

    def begin_source_switch(self, requested_source: str) -> bool:
        """Atomically reserve/disarm the LIVE operator before source replacement."""
        if requested_source not in ("LIVE", "DEMO"):
            return False

        # Reservation happens first. Any new MANUAL/NAV/EXPLORATION acquisition will
        # then fail while the current lifecycle state is checked below. Cleanup and source
        # switching share this lock so the failed-switch path cannot race a disarm.
        with self._motion_owner_lock:
            if self._cleanup_in_progress or self._source_switch_in_progress or not self.accepting_commands:
                return False
            if self.motion_owner != MOTION_NONE:
                return False
            if self.last_cmd_vel["linear"] != 0.0 or self.last_cmd_vel["angular"] != 0.0:
                return False
            self._source_switch_in_progress = True
            self.accepting_commands = False
            switch_cleanup_generation = self._cleanup_generation

        # Motion ownership is the first admission gate, but source switching also
        # validates the lifecycle records themselves as a defense-in-depth invariant.
        # Avoid nested locks: lifecycle finalizers use their own lock order.
        with self._nav_state_lock:
            nav_busy = (
                self._current_nav_record is not None
                or self._nav_cancel_record is not None
                or self._nav_safety_lock_record is not None
                or self.nav_state in ("PLANNING", "NAVIGATING", "PAUSED", "CANCELING")
            )
        with self._explore_lock:
            explore_busy = (
                self._explore_record is not None
                or self.explore_process is not None
                or self.exploration_state in ("STARTING", "EXPLORING", "STOPPING")
            )

        with self._motion_owner_lock:
            cleanup_started = (
                self._cleanup_in_progress
                or self._cleanup_generation != switch_cleanup_generation
            )
            if cleanup_started or nav_busy or explore_busy:
                self._source_switch_in_progress = False
                # Never re-arm a session that has entered disconnect cleanup.
                if not self._cleanup_in_progress and self._cleanup_generation == switch_cleanup_generation:
                    self.accepting_commands = True
                return False

        self.publish_zero_velocity()
        return True



class WebSocketBridgeServer:
    """Single-operator websocket server with fail-safe disconnect/reconnect semantics."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.clients: Set[Any] = set()
        self.bridge_node: Optional[TurtleBotBridgeNode] = None
        self.operator_client: Optional[Any] = None
        # Every controller connection gets a monotonically increasing session generation.
        # A websocket must match both object identity and session generation before it can
        # submit a physical-control command. This makes stale handlers powerless even if
        # the underlying socket object remains alive briefly after a disconnect.
        self._operator_session_generation = 0
        # One authoritative cleanup task per operator lifecycle. Handler/failure paths
        # may discover the same lost client concurrently, but begin cleanup only once.
        self._operator_cleanup_task: Optional[asyncio.Task] = None
        self._operator_cleanup_websocket: Optional[Any] = None
        self._operator_cleanup_session_generation: Optional[int] = None

    def set_bridge_node(self, node: TurtleBotBridgeNode):
        self.bridge_node = node

    def broadcast_sync(self, payload: Dict[str, Any]):
        """Thread-safe caller from ROS callbacks into asyncio event loop."""
        if self.loop.is_closed() or not self.loop.is_running():
            return
        message_str = json.dumps(payload)
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast_async(message_str), self.loop)
        except RuntimeError:
            # The event loop may be shutting down while a ROS callback is still in flight.
            pass

    async def _run_operator_cleanup(self, websocket, session_generation: int):
        """Run one controller-loss cleanup barrier, then clear that exact controller slot."""
        node = self.bridge_node
        if (
            node is None
            or self.operator_client is not websocket
            or self._operator_session_generation != session_generation
        ):
            return

        cleanup_confirmed = False
        try:
            node.begin_last_client_disconnect()
            await node.complete_last_client_disconnect()

            # complete_last_client_disconnect() can return after its bounded wait while a
            # background waiter still finishes the actual terminal transition. Never expose
            # the controller slot to a reconnect until that event is set.
            loop = asyncio.get_running_loop()
            cleanup_confirmed = await loop.run_in_executor(None, node._cleanup_complete_event.wait)
            cleanup_confirmed = bool(cleanup_confirmed)
        except Exception as exc:
            # Failing cleanup is safer than admitting a new controller against potentially
            # live motion. Keep the exact operator slot occupied and disarmed so another
            # lifecycle detection can retry cleanup instead of silently re-arming the robot.
            print(f"[SAFETY] Controller cleanup failed; keeping operator slot locked: {exc}")
        finally:
            self.clients.discard(websocket)
            if (
                cleanup_confirmed
                and self.operator_client is websocket
                and self._operator_session_generation == session_generation
            ):
                self.operator_client = None
                self._operator_cleanup_session_generation = None
            current_task = asyncio.current_task()
            if self._operator_cleanup_task is current_task:
                self._operator_cleanup_task = None
                self._operator_cleanup_websocket = None

    def _ensure_operator_cleanup(self, websocket, session_generation: Optional[int] = None) -> Optional[asyncio.Task]:
        """Return the one cleanup task for the exact operator session."""
        if session_generation is None:
            session_generation = self._operator_session_generation
        if (
            self.bridge_node is None
            or self.operator_client is not websocket
            or self._operator_session_generation != session_generation
        ):
            return None
        if self._operator_cleanup_task is not None and not self._operator_cleanup_task.done():
            return self._operator_cleanup_task
        self._operator_cleanup_websocket = websocket
        self._operator_cleanup_session_generation = session_generation
        self._operator_cleanup_task = asyncio.create_task(
            self._run_operator_cleanup(websocket, session_generation)
        )
        return self._operator_cleanup_task

    def _is_current_operator(self, websocket, session_generation: Optional[int] = None) -> bool:
        """Control commands are valid only from the currently registered controller session."""
        if websocket is None:
            return False
        if session_generation is None:
            session_generation = self._operator_session_generation
        return (
            self.operator_client is websocket
            and self._operator_session_generation == session_generation
            and websocket in self.clients
        )

    async def _broadcast_async(self, message: str):
        if not self.clients:
            return
        dead_clients = set()
        for client in list(self.clients):
            try:
                await client.send(message)
            except websockets.ConnectionClosed:
                dead_clients.add(client)
            except Exception:
                dead_clients.add(client)
        self.clients.difference_update(dead_clients)
        if self.operator_client in dead_clients:
            # Do not clear operator_client directly. It is the admission gate that keeps a
            # reconnecting controller out while the authoritative cleanup barrier runs.
            dead_operator = self.operator_client
            dead_session = self._operator_session_generation
            self._ensure_operator_cleanup(dead_operator, dead_session)


    async def handler(self, websocket):
        """Handle exactly one control client; all command authorization is bound to this session."""
        if self.operator_client is not None and self.operator_client is not websocket:
            print(f"[WS] Rejecting second control client: {websocket.remote_address}")
            try:
                await websocket.close(code=1008, reason="Operator session already active")
            except Exception:
                pass
            return

        print(f"[WS] Client connected: {websocket.remote_address}")
        self.clients.add(websocket)
        self._operator_session_generation += 1
        session_generation = self._operator_session_generation
        self.operator_client = websocket

        try:
            if self.bridge_node:
                await self.bridge_node.wait_for_operator_cleanup()
                if not self._is_current_operator(websocket, session_generation):
                    return
                if not self.bridge_node.restore_operator_session():
                    try:
                        await websocket.close(code=1013, reason="Bridge is still cleaning up")
                    except Exception:
                        pass
                    return

                init_payload = {
                    "type": "init",
                    "exploration": {
                        "state": self.bridge_node.exploration_state,
                        "frontier_count": self.bridge_node.frontier_count,
                        "selected_frontier": self.bridge_node.selected_frontier,
                    },
                    "navigation": {
                        "navigationState": self.bridge_node.nav_state,
                        "goal": self.bridge_node.current_goal_pose,
                    },
                }
                if self.bridge_node._latest_map_payload is not None:
                    init_payload["map"] = self.bridge_node._latest_map_payload["map"]
                await websocket.send(json.dumps(init_payload))

            async for raw_message in websocket:
                if not self._is_current_operator(websocket, session_generation):
                    break
                try:
                    data = json.loads(raw_message)
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                try:
                    self._handle_client_message(data, websocket, session_generation)
                except Exception as exc:
                    print(f"[WS] Failed to handle client message: {exc}")
        except websockets.ConnectionClosed:
            pass
        finally:
            print(f"[WS] Client disconnected: {websocket.remote_address}")
            node = self.bridge_node if self._is_current_operator(websocket, session_generation) else None
            if node is not None:
                print("[SAFETY] Operator disconnected: halt motion, cancel nav/explore, idle")
                cleanup_task = self._ensure_operator_cleanup(websocket, session_generation)
                if cleanup_task is not None:
                    await asyncio.shield(cleanup_task)
            else:
                self.clients.discard(websocket)

    def _handle_client_message(
        self,
        data: Dict[str, Any],
        websocket=None,
        session_generation: Optional[int] = None,
    ):
        if not self._is_current_operator(websocket, session_generation):
            return
        if not self.bridge_node:
            return

        msg_type = data.get("type")

        if msg_type == "cmd_vel":
            linear = _parse_finite_number(data.get("linear"))
            angular = _parse_finite_number(data.get("angular"))
            if linear is None or angular is None:
                self.bridge_node.logger.warn("cmd_vel rejected: malformed finite numeric values required")
                return
            manual_session_id = data.get("manual_session_id")
            new_manual_session = data.get("new_manual_session") is True
            if manual_session_id is not None and (not isinstance(manual_session_id, str) or not (1 <= len(manual_session_id) <= 128)):
                self.bridge_node.logger.warn("cmd_vel rejected: invalid manual_session_id")
                return
            linear, angular = _clamp_manual_velocity(linear, angular)
            self.bridge_node.publish_velocity(
                linear,
                angular,
                manual_session_id=manual_session_id,
                new_manual_session=new_manual_session,
            )

        elif msg_type == "nav_goal":
            x = _parse_finite_number(data.get("x"))
            y = _parse_finite_number(data.get("y"))
            yaw = _parse_finite_number(data.get("yaw"))
            if x is None or y is None or yaw is None:
                self.bridge_node.logger.warn("nav_goal rejected: malformed finite numeric values required")
                return
            if abs(x) > MAX_NAV_GOAL_ABS_M or abs(y) > MAX_NAV_GOAL_ABS_M:
                self.bridge_node.logger.warn(f"nav_goal rejected: unbounded coordinates x={x}, y={y}")
                return
            asyncio.create_task(self.bridge_node.navigate_to_goal_async(x, y, yaw))

        elif msg_type == "nav_cancel":
            asyncio.create_task(self.bridge_node.cancel_navigation_async())

        elif msg_type == "nav_pause":
            asyncio.create_task(self.bridge_node.pause_navigation_async())

        elif msg_type == "nav_resume":
            asyncio.create_task(self.bridge_node.resume_navigation_async())

        elif msg_type == "explore_start":
            self.bridge_node.start_exploration()

        elif msg_type == "explore_stop":
            self.bridge_node.stop_exploration()

        elif msg_type == "source_switch":
            requested_source = data.get("source", "").upper()
            request_id = data.get("request_id")
            if requested_source not in ("LIVE", "DEMO"):
                self.bridge_node.logger.warn(f"source_switch rejected: invalid source={requested_source}")
                return
            granted = self.bridge_node.begin_source_switch(requested_source)
            self.bridge_node.broadcast({
                "type": "source_switch_result",
                "success": granted,
                "reason": None if granted else "active_motion_operation",
                "requested_source": requested_source,
                "request_id": request_id,
            })

        else:
            self.bridge_node.logger.debug(f"Unknown message type: {msg_type}")


def main():
    if rclpy is None:
        print("[FATAL] Cannot run bridge without ROS 2 environment.", file=sys.stderr)
        sys.exit(1)

    rclpy.init()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    server = WebSocketBridgeServer(loop)
    bridge_node = TurtleBotBridgeNode(broadcast_callback=server.broadcast_sync)
    bridge_node.loop = loop
    server.set_bridge_node(bridge_node)

    # Spin ROS 2 in a background daemon thread
    def ros_spin():
        print("[INFO] ROS 2 executor thread spinning...")
        try:
            rclpy.spin(bridge_node.node)
        except Exception as e:
            print(f"[ROS EXCEPTION] {e}")

    ros_thread = threading.Thread(target=ros_spin, daemon=True)
    ros_thread.start()

    # Start WebSocket async server
    print(f"[INFO] Starting WebSocket server on {WS_HOST}:{WS_PORT}...")
    start_server = websockets.serve(server.handler, WS_HOST, WS_PORT)
    loop.run_until_complete(start_server)
    print(f"[INFO] TurtleBot 3 Bridge is LIVE at ws://{WS_HOST}:{WS_PORT}")

    try:
        loop.run_forever()
    except KeyboardInterrupt:
        print("\n[SHUTDOWN] Interrupted by user. Shutting down...")
    finally:
        # Stop accepting new WebSocket connections before beginning physical-motion shutdown.
        # Existing handlers are fenced by the controller/session lifecycle and will be cleaned
        # through the same bridge safety barrier.
        try:
            start_server.close()
            loop.run_until_complete(start_server.wait_closed())
        except Exception as exc:
            print(f"[SHUTDOWN] WebSocket listener close warning: {exc}")

        shutdown_ok = False
        try:
            shutdown_ok = bridge_node.shutdown_blocking(timeout_sec=10.0)
        finally:
            bridge_node.node.destroy_node()
            rclpy.shutdown()
            if ros_thread.is_alive():
                ros_thread.join(timeout=2.0)
            loop.close()
            if shutdown_ok:
                print("[SHUTDOWN] Bridge stopped cleanly: tracked motion sources terminated.")
            else:
                print(
                    "[SHUTDOWN] Bridge process stopped, but one or more tracked motion sources "
                    "were not confirmed terminal; use the physical power switch as the final emergency stop."
                )


if __name__ == "__main__":
    main()
