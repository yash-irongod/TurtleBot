#!/usr/bin/env python3
"""
TurtleBot 3 Burger ROS 2 WebSocket Bridge.

Features:
- Telemetry: /odom, /scan, /imu, /battery_state -> WebSocket broadcast
  * Robot pose on the map is derived from TF (map -> base_link/base_footprint), while
    velocity still comes from /odom.
- Velocity Control: receives { type: "cmd_vel", linear, angular } -> publishes /cmd_vel
- Nav2 Autonomous Navigation: ROS 2 ActionClient for nav2_msgs/action/NavigateToPose (/navigate_to_pose)
  * Accepts { type: "nav_goal", x, y, yaw } in map frame
  * Accepts { type: "nav_cancel" } -> cancels action goal + sends zero velocity
  * Streams feedback (distance remaining) and result (GOAL_REACHED, CANCELED, FAILED)
  * Streams Nav2 global/local path topics when available.
- Auto Explore Management:
  * Ensures ~/turtlebot3_ws/launch/control_center_mapping_navigation.launch.py is running
    for Cartographer + Nav2, then supervises the explorer-only launch process.
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
import struct
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, Optional, Set

# Attempt ROS 2 imports with informative error guidance
HAS_NAV2 = False
HAS_TF2 = False
try:
    import rclpy
    from rclpy.action import ActionClient
    from rclpy.node import Node
    try:
        from rclpy.executors import MultiThreadedExecutor
    except ImportError:
        MultiThreadedExecutor = None
    from rclpy.qos import (
        DurabilityPolicy,
        HistoryPolicy,
        QoSProfile,
        ReliabilityPolicy,
        qos_profile_sensor_data,
    )

    from action_msgs.msg import GoalStatus
    from geometry_msgs.msg import Point, PointStamped, Pose, PoseArray, PoseStamped, PoseWithCovarianceStamped, Quaternion, Twist
    from nav_msgs.msg import OccupancyGrid, Odometry, Path
    from sensor_msgs.msg import BatteryState, Imu, LaserScan, PointCloud2, PointField
    from visualization_msgs.msg import Marker, MarkerArray

    try:
        from nav2_msgs.action import NavigateToPose, ComputePathToPose
        HAS_NAV2 = True
    except ImportError:
        HAS_NAV2 = False
        NavigateToPose = None
        ComputePathToPose = None

    try:
        from tf2_ros import Buffer, TransformListener
        HAS_TF2 = True
    except ImportError:
        HAS_TF2 = False
        Buffer = None
        TransformListener = None

    try:
        from lifecycle_msgs.srv import GetState as LifecycleGetState
        HAS_LIFECYCLE_MSGS = True
    except ImportError:
        HAS_LIFECYCLE_MSGS = False
        LifecycleGetState = None

except ImportError as e:
    print(f"[ERROR] Failed to import ROS 2 modules: {e}", file=sys.stderr)
    print("[INFO] Ensure you have sourced your ROS 2 environment: source ~/turtlebot_env.sh", file=sys.stderr)
    # Allow compile-checking without ROS environment
    rclpy = None
    PointCloud2 = None
    PointField = None

try:
    import websockets
except ImportError:
    print("[ERROR] websockets module not found. Install with: pip install websockets", file=sys.stderr)
    websockets = None

WS_HOST = "0.0.0.0"
WS_PORT = 8765
MAPPING_NAV_LAUNCH_PATH = os.path.expanduser("~/turtlebot3_ws/launch/control_center_mapping_navigation.launch.py")
EXPLORATION_LAUNCH_PATH = os.path.expanduser("~/turtlebot3_ws/launch/frontier_explorer_only.launch.py")
ENV_SCRIPT_PATH = os.path.expanduser("~/turtlebot_env.sh")
BRIDGE_LOG_DIR = os.path.expanduser("~/turtlebot3_ws/logs")
MAP_FRAME = "map"
BASE_FRAMES = ("base_link", "base_footprint")

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

    virtual_boundary = {
        "enabled": False,
        "min_x": -0.6,
        "max_x": 0.6,
        "min_y": -0.4,
        "max_y": 0.4,
        "safety_margin": 0.08,
    }

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

        # 2b. Map-frame pose tracking via TF2 and direct SLAM topic fallback
        self.map_pose: Optional[Dict[str, Any]] = None
        if HAS_TF2 and Buffer is not None and TransformListener is not None:
            try:
                self.tf_buffer = Buffer()
                self.tf_listener = TransformListener(self.tf_buffer, self.node)
                self.logger.info("tf2_ros TransformListener initialized for map->base tracking")
            except Exception as e:
                self.logger.warn(f"Failed to initialize tf2_ros TransformListener: {e}")
                self.tf_buffer = None
                self.tf_listener = None
        else:
            self.tf_buffer = None
            self.tf_listener = None

        # Fallback SLAM pose subscriptions in case tf2 is delayed or missing
        try:
            self.tracked_pose_sub = self.node.create_subscription(
                PoseStamped, "/tracked_pose", self._on_map_pose, qos_profile_sensor_data
            )
        except Exception:
            self.tracked_pose_sub = None

        try:
            self.slam_pose_sub = self.node.create_subscription(
                PoseWithCovarianceStamped, "/pose", self._on_map_pose, qos_profile_sensor_data
            )
        except Exception:
            self.slam_pose_sub = None

        try:
            self.amcl_pose_sub = self.node.create_subscription(
                PoseWithCovarianceStamped, "/amcl_pose", self._on_map_pose, qos_profile_sensor_data
            )
        except Exception:
            self.amcl_pose_sub = None

        try:
            self.robot_pose_sub = self.node.create_subscription(
                PoseWithCovarianceStamped, "/robot_pose", self._on_map_pose, qos_profile_sensor_data
            )
        except Exception:
            self.robot_pose_sub = None

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
        self.plan_sub = self.node.create_subscription(Path, "/plan", self._on_plan, 10)
        self.global_plan_sub = self.node.create_subscription(Path, "/global_plan", self._on_plan, 10)
        self.local_plan_sub = self.node.create_subscription(Path, "/local_plan", self._on_local_plan, 10)
        if PointCloud2 is not None:
            try:
                self.boundary_cloud_pub = self.node.create_publisher(PointCloud2, "/tabletop_boundary", 10)
            except Exception:
                self.boundary_cloud_pub = None
        else:
            self.boundary_cloud_pub = None
        self._last_boundary_pub = 0.0
        self.last_plan_broadcast = 0.0
        self.last_local_plan_broadcast = 0.0
        self.map_pose_timer = None
        if hasattr(self.node, "create_timer"):
            self.map_pose_timer = self.node.create_timer(0.033, self._publish_map_pose)

        # 4. Nav2 NavigateToPose ActionClient
        self.nav_client = None
        self.plan_client = None
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
            if ComputePathToPose is not None:
                self.plan_client = ActionClient(self.node, ComputePathToPose, "compute_path_to_pose")
                self.logger.info("Nav2 ComputePathToPose ActionClient initialized on /compute_path_to_pose")
        else:
            self.logger.warn("nav2_msgs.action.NavigateToPose not found; Nav2 action client disabled")

        # Nav2 lifecycle readiness flag — set True after bt_navigator is confirmed active.
        # Reset on goal rejection so the next attempt re-checks.
        self._nav2_confirmed_active = False
        self._lifecycle_client = None

        # Robot clock synchronization tracker (offline mobile hotspot time fix)
        self._last_clock_sync_at: float = 0.0

        # High-frequency map-frame odometry fusion cache
        self._latest_map_to_odom = None
        self._last_map_to_odom_lookup: float = 0.0
        self._last_tf_map_pose = None

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
        self.mapping_process: Optional[subprocess.Popen] = None
        self.mapping_process_started_by_bridge = False
        self._mapping_stack_lock = threading.Lock()
        self._mapping_stack_in_progress = False

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
        self._explore_lock = threading.RLock()  # Must be reentrant: clear_map_data uses getattr fallback

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

        # Virtual Boundary / Tabletop Edge Protection
        self.virtual_boundary: Dict[str, Any] = {
            "enabled": False,
            "min_x": -0.6,
            "max_x": 0.6,
            "min_y": -0.4,
            "max_y": 0.4,
            "safety_margin": 0.08,
        }
        self._boundary_file = os.path.expanduser("~/turtlebot3_ws/config/virtual_boundary.json")
        self._load_virtual_boundary()

        self._setup_exploration_subscribers(map_qos)
        self._manual_watchdog_thread.start()

        # Kick off background clock synchronization with the robot (critical for offline hotspot)
        threading.Thread(
            target=self._sync_robot_clock, name="robot-clock-sync", daemon=True
        ).start()

        # Rate-limiting timestamps
        self.last_odom_broadcast = 0.0
        self.last_scan_broadcast = 0.0
        self.last_imu_broadcast = 0.0
        self.last_map_broadcast = 0.0
        self.last_battery_broadcast = 0.0
        self._last_opt_map_broadcast = 0.0

        self.logger.info("Bridge Node initialized successfully.")

    def _load_virtual_boundary(self):
        try:
            if os.path.exists(self._boundary_file):
                with open(self._boundary_file, "r") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        self.virtual_boundary = {
                            "enabled": bool(data.get("enabled", False)),
                            "min_x": float(data.get("min_x", -0.6)),
                            "max_x": float(data.get("max_x", 0.6)),
                            "min_y": float(data.get("min_y", -0.4)),
                            "max_y": float(data.get("max_y", 0.4)),
                            "safety_margin": float(data.get("safety_margin", 0.08)),
                            "rotation_deg": float(data.get("rotation_deg", data.get("rotationDeg", 0.0))),
                        }
                        self.logger.info(f"Loaded virtual boundary from config: {self.virtual_boundary}")
        except Exception as exc:
            self.logger.warn(f"Could not load virtual boundary: {exc}")

    def _save_virtual_boundary(self):
        try:
            os.makedirs(os.path.dirname(self._boundary_file), exist_ok=True)
            with open(self._boundary_file, "w") as f:
                json.dump(self.virtual_boundary, f, indent=2)
        except Exception as exc:
            self.logger.warn(f"Could not save virtual boundary: {exc}")

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
    def _on_map_pose(self, msg):
        """Update map-frame SLAM robot pose from Cartographer / slam_toolbox / AMCL."""
        try:
            if hasattr(msg, "pose") and hasattr(msg.pose, "pose"):
                pos = msg.pose.pose.position
                ori = msg.pose.pose.orientation
            elif hasattr(msg, "pose") and hasattr(msg.pose, "position"):
                pos = msg.pose.position
                ori = msg.pose.orientation
            else:
                return

            siny_cosp = 2.0 * (ori.w * ori.z + ori.x * ori.y)
            cosy_cosp = 1.0 - 2.0 * (ori.y * ori.y + ori.z * ori.z)
            yaw_rad = math.atan2(siny_cosp, cosy_cosp)

            self.map_pose = {
                "position": {"x": float(pos.x), "y": float(pos.y)},
                "yaw_rad": float(yaw_rad),
                "orientation": {"x": ori.x, "y": ori.y, "z": ori.z, "w": ori.w},
                "timestamp": time.time(),
            }
        except Exception:
            pass

    def _get_latest_map_pose(self) -> Optional[Dict[str, Any]]:
        """Resolve the latest robot pose in the map frame via direct TF or SLAM topic.

        Uses non-blocking TF lookup (timeout=0) to prevent single-threaded ROS executor
        starvation, eliminating 1-second lag and packet burst stuttering.
        """
        # 1. Non-blocking direct TF buffer lookup (base_footprint first, then base_link)
        if self.tf_buffer is not None:
            for base_frame in ("base_footprint", "base_link"):
                try:
                    tf_stamped = self.tf_buffer.lookup_transform(
                        MAP_FRAME,
                        base_frame,
                        rclpy.time.Time(),
                        timeout=rclpy.duration.Duration(seconds=0.0),
                    )
                    trans = tf_stamped.transform.translation
                    rot = tf_stamped.transform.rotation
                    siny_cosp = 2.0 * (rot.w * rot.z + rot.x * rot.y)
                    cosy_cosp = 1.0 - 2.0 * (rot.y * rot.y + rot.z * rot.z)
                    yaw_rad = math.atan2(siny_cosp, cosy_cosp)
                    pose = {
                        "position": {"x": float(trans.x), "y": float(trans.y)},
                        "yaw_rad": float(yaw_rad),
                        "orientation": {"x": rot.x, "y": rot.y, "z": rot.z, "w": rot.w},
                        "timestamp": time.time(),
                    }
                    self._last_tf_map_pose = pose
                    return pose
                except Exception:
                    continue

        # 2. Authoritative direct SLAM pose from /tracked_pose (published by Cartographer)
        if self.map_pose is not None and (time.time() - self.map_pose.get("timestamp", 0) < 0.5):
            return {
                "position": self.map_pose["position"],
                "yaw_rad": self.map_pose["yaw_rad"],
                "orientation": self.map_pose["orientation"],
            }

        # 3. Fall back to fresh cached TF pose (< 0.5s) to absorb momentary TF cycle gaps
        if hasattr(self, "_last_tf_map_pose") and self._last_tf_map_pose is not None:
            if time.time() - self._last_tf_map_pose.get("timestamp", 0) < 0.5:
                return self._last_tf_map_pose

        return None


    def is_point_inside_boundary(self, x: float, y: float, margin: float = 0.08) -> bool:
        """Check if (x, y) in map frame lies safely inside virtual boundary."""
        if not self.virtual_boundary.get("enabled"):
            return True
        b = self.virtual_boundary
        min_x = float(b.get("min_x", -0.6))
        max_x = float(b.get("max_x", 0.6))
        min_y = float(b.get("min_y", -0.4))
        max_y = float(b.get("max_y", 0.4))
        if max_x <= min_x or max_y <= min_y:
            return True
        rot_deg = float(b.get("rotation_deg", b.get("rotationDeg", 0.0)))
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0
        hw = max(0.05, (max_x - min_x) / 2.0)
        hl = max(0.05, (max_y - min_y) / 2.0)
        if abs(rot_deg) > 1e-3:
            rad = math.radians(rot_deg)
            cos_a = math.cos(rad)
            sin_a = math.sin(rad)
            dx = x - cx
            dy = y - cy
            u = dx * cos_a + dy * sin_a
            v = -dx * sin_a + dy * cos_a
            return abs(u) <= (hw - margin) and abs(v) <= (hl - margin)
        else:
            return (min_x + margin <= x <= max_x - margin) and (min_y + margin <= y <= max_y - margin)

    def is_step_safe(self, curr_x: float, curr_y: float, next_x: float, next_y: float, margin: float = 0.06) -> bool:
        """Check if moving from (curr_x, curr_y) to (next_x, next_y) is safe within virtual boundary."""
        if not self.virtual_boundary.get("enabled"):
            return True
        b = self.virtual_boundary
        min_x = float(b.get("min_x", -0.6))
        max_x = float(b.get("max_x", 0.6))
        min_y = float(b.get("min_y", -0.4))
        max_y = float(b.get("max_y", 0.4))
        if max_x <= min_x or max_y <= min_y:
            return True
        rot_deg = float(b.get("rotation_deg", b.get("rotationDeg", 0.0)))
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0
        hw = max(0.05, (max_x - min_x) / 2.0)
        hl = max(0.05, (max_y - min_y) / 2.0)

        rad = math.radians(rot_deg) if abs(rot_deg) > 1e-3 else 0.0
        cos_a = math.cos(rad)
        sin_a = math.sin(rad)

        curr_u = (curr_x - cx) * cos_a + (curr_y - cy) * sin_a
        curr_v = -(curr_x - cx) * sin_a + (curr_y - cy) * cos_a
        next_u = (next_x - cx) * cos_a + (next_y - cy) * sin_a
        next_v = -(next_x - cx) * sin_a + (next_y - cy) * cos_a

        limit_u = max(0.0, hw - margin)
        limit_v = max(0.0, hl - margin)

        if abs(next_u) <= limit_u and abs(next_v) <= limit_v:
            return True

        violating_u = abs(next_u) > limit_u and abs(next_u) >= abs(curr_u)
        violating_v = abs(next_v) > limit_v and abs(next_v) >= abs(curr_v)
        if violating_u or violating_v:
            return False

        return True

    def _publish_tabletop_boundary(self):
        if not hasattr(self, "boundary_cloud_pub") or self.boundary_cloud_pub is None:
            return
        if not self.virtual_boundary.get("enabled"):
            return
        try:
            b = self.virtual_boundary
            min_x = float(b["min_x"])
            max_x = float(b["max_x"])
            min_y = float(b["min_y"])
            max_y = float(b["max_y"])
            if max_x <= min_x or max_y <= min_y:
                return

            cx = (min_x + max_x) / 2.0
            cy = (min_y + max_y) / 2.0
            hw = (max_x - min_x) / 2.0
            hl = (max_y - min_y) / 2.0
            rot_deg = float(b.get("rotation_deg", b.get("rotationDeg", 0.0)))

            points = []
            step = 0.04
            rad = math.radians(rot_deg)
            cos_a = math.cos(rad)
            sin_a = math.sin(rad)

            def to_world(u, v):
                return (cx + u * cos_a - v * sin_a, cy + u * sin_a + v * cos_a, 0.05)

            # Perimeter and 4cm outer buffer strip
            u = -hw
            while u <= hw + 0.001:
                points.append(to_world(u, hl))
                points.append(to_world(u, -hl))
                points.append(to_world(u, hl + 0.04))
                points.append(to_world(u, -hl - 0.04))
                u += step
            v = -hl
            while v <= hl + 0.001:
                points.append(to_world(-hw, v))
                points.append(to_world(hw, v))
                points.append(to_world(-hw - 0.04, v))
                points.append(to_world(hw + 0.04, v))
                v += step

            if not points or PointCloud2 is None or PointField is None:
                return

            msg = PointCloud2()
            if hasattr(self, "node") and hasattr(self.node, "get_clock"):
                msg.header.stamp = self.node.get_clock().now().to_msg()
            msg.header.frame_id = "map"
            msg.height = 1
            msg.width = len(points)
            msg.fields = [
                PointField(name="x", offset=0, datatype=PointField.FLOAT32, count=1),
                PointField(name="y", offset=4, datatype=PointField.FLOAT32, count=1),
                PointField(name="z", offset=8, datatype=PointField.FLOAT32, count=1),
            ]
            msg.is_bigendian = False
            msg.point_step = 12
            msg.row_step = 12 * len(points)
            msg.is_dense = True
            buffer = bytearray()
            for px, py, pz in points:
                buffer.extend(struct.pack("fff", float(px), float(py), float(pz)))
            msg.data = bytes(buffer)
            self.boundary_cloud_pub.publish(msg)
        except Exception as exc:
            self.logger.debug(f"Boundary cloud publish note: {exc}")

    def _publish_map_pose(self):
        pose = self._get_latest_map_pose()
        if pose is not None:
            if self.virtual_boundary.get("enabled"):
                b = self.virtual_boundary
                rx = pose["position"]["x"]
                ry = pose["position"]["y"]
                m = b.get("safety_margin", 0.08)
                is_breaching = not self.is_point_inside_boundary(rx, ry, margin=m)
                if is_breaching:
                    if self.motion_owner == MOTION_NAVIGATION:
                        self.logger.error(f"VIRTUAL BOUNDARY LIMIT REACHED at ({rx:.2f}, {ry:.2f})! Halting motion for table safety.")
                        self.cancel_navigation()
                        if self.cmd_vel_pub is not None:
                            msg = Twist()
                            self.cmd_vel_pub.publish(msg)
                        self.broadcast({
                            "type": "boundary_alert",
                            "status": "BREACH",
                            "message": "Virtual boundary limit reached — robot halted for table edge safety",
                        })
            self.broadcast({
                "type": "pose_map",
                "pose": {
                    "position": pose["position"],
                    "yaw_rad": pose["yaw_rad"],
                    "timestamp": pose.get("timestamp", time.time()),
                }
            })

        # Periodic boundary obstacle broadcast for Nav2 costmaps
        now_mono = time.monotonic()
        if hasattr(self, "_last_boundary_pub") and now_mono - self._last_boundary_pub > 1.0:
            self._last_boundary_pub = now_mono
            self._publish_tabletop_boundary()

    def _on_plan(self, msg: Path):
        now = time.time()
        if now - self.last_plan_broadcast < 0.2:  # max ~5 Hz
            return
        self.last_plan_broadcast = now
        path_points = [{"x": float(p.pose.position.x), "y": float(p.pose.position.y)} for p in msg.poses]
        # Tabletop boundary is enforced in Nav2 costmap as lethal obstacles and by the 20 Hz map pose geofence.
        payload = {
            "type": "nav_plan",
            "navigation": {
                "path": path_points,
                "frame_id": str(getattr(msg.header, "frame_id", "")),
            },
        }
        self.broadcast(payload)

    def _on_local_plan(self, msg: Path):
        now = time.time()
        if now - self.last_local_plan_broadcast < 0.2:
            return
        self.last_local_plan_broadcast = now

        frame_id = str(getattr(msg.header, "frame_id", ""))
        transform = None
        if frame_id and frame_id != MAP_FRAME and self.tf_buffer is not None:
            try:
                tf_stamped = self.tf_buffer.lookup_transform(
                    MAP_FRAME,
                    frame_id,
                    rclpy.time.Time(),
                    timeout=rclpy.duration.Duration(seconds=0.0),
                )
                transform = tf_stamped.transform
            except Exception:
                transform = None

        path_points = []
        for p in msg.poses:
            x = float(p.pose.position.x)
            y = float(p.pose.position.y)
            if transform is not None:
                tx = transform.translation.x
                ty = transform.translation.y
                rot = transform.rotation
                siny_cosp = 2.0 * (rot.w * rot.z + rot.x * rot.y)
                cosy_cosp = 1.0 - 2.0 * (rot.y * rot.y + rot.z * rot.z)
                yaw = math.atan2(siny_cosp, cosy_cosp)
                cos_y = math.cos(yaw)
                sin_y = math.sin(yaw)
                px = tx + (x * cos_y - y * sin_y)
                py = ty + (x * sin_y + y * cos_y)
                path_points.append({"x": px, "y": py})
            elif frame_id == MAP_FRAME or not frame_id:
                path_points.append({"x": x, "y": y})

        payload = {
            "type": "nav_local_plan",
            "navigation": {
                "local_path": path_points,
                "frame_id": MAP_FRAME,
            },
        }
        self.broadcast(payload)

    def _on_odom(self, msg: Odometry):
        now = time.time()
        if now - self.last_odom_broadcast < 0.033:  # max ~30 Hz
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
        map_pose = self._get_latest_map_pose()
        if map_pose is not None:
            payload["map_pose"] = map_pose
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
        if now - self.last_map_broadcast < 0.5:  # ~2 Hz real-time broadcast
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

    def clear_map_data(self):
        """Clears cached map, navigation plans, and exploration data, and notifies clients."""
        with getattr(self, "_explore_lock", threading.RLock()):
            self._latest_map_payload = None
            self._latest_optimized_map_payload = None
            self.selected_frontier = None
            self.frontier_count = 0
            self.last_map_broadcast = 0.0
            self._last_opt_map_broadcast = 0.0
            self.latest_global_plan = []
            self.latest_local_plan = []
        self.broadcast({"type": "map_cleared"})
        self.broadcast({
            "type": "exploration",
            "state": getattr(self, "exploration_state", "IDLE"),
            "frontier_count": 0,
            "selected_frontier": None,
        })
        # Key must match frontend expectation: navigation.path (not "poses")
        self.broadcast({"type": "nav_plan", "navigation": {"path": []}})
        # Key must match frontend expectation: navigation.local_path (not "poses")
        self.broadcast({"type": "nav_local_plan", "navigation": {"local_path": []}})
        if hasattr(self, "logger"):
            self.logger.info("Cleared cached map and exploration telemetry.")

    def refresh_map_data(self):
        """Reset map caches and trigger fresh mapping retrieval."""
        self.clear_map_data()
        self.ensure_mapping_stack_async()

    def ensure_mapping_stack_async(self):
        """Asynchronously ensure Cartographer + Nav2 are running with single-flight concurrency protection."""
        with self._mapping_stack_lock:
            if self._mapping_stack_in_progress:
                self.logger.info("Mapping stack launch already in progress; skipping duplicate request")
                return
            if (
                self._nav2_confirmed_active
                and self.mapping_process is not None
                and self.mapping_process.poll() is None
            ):
                self.broadcast({"type": "mapping_status", "status": "ready"})
                return
            self._mapping_stack_in_progress = True

        def _worker():
            try:
                self.broadcast({"type": "mapping_status", "status": "starting"})
                success = self._ensure_mapping_navigation_stack(timeout_sec=25.0)
                if success:
                    self.broadcast({"type": "mapping_status", "status": "ready"})
                else:
                    self.broadcast({"type": "mapping_status", "status": "error"})
            except Exception as exc:
                if hasattr(self, "logger"):
                    self.logger.warn(f"ensure_mapping_stack_async exception: {exc}")
                self.broadcast({"type": "mapping_status", "status": "error"})
            finally:
                with self._mapping_stack_lock:
                    self._mapping_stack_in_progress = False

        threading.Thread(target=_worker, daemon=True, name="ensure_mapping_stack").start()

    def _on_optimized_map(self, msg: OccupancyGrid):
        # Optimized exploration maps are NOT authoritative. They use a distinct message
        # type so the frontend never confuses them with /map, and a separate throttle
        # timer so they don't steal /map's 1 Hz broadcast window.
        payload = self._build_map_payload(msg)
        payload["type"] = "optimized_map"
        self._latest_optimized_map_payload = payload
        now = time.time()
        if now - getattr(self, "_last_opt_map_broadcast", 0.0) < 1.0:
            return
        self._last_opt_map_broadcast = now
        self.broadcast(payload)

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
    # Nav2 Lifecycle Readiness
    # --------------------------------------------------------------------------
    def _wait_for_nav2_lifecycle_active(self, timeout_sec: float = 30.0) -> bool:
        """Wait for bt_navigator to reach 'active' lifecycle state (id=3).

        Without this check, the action server exists (wait_for_server returns True)
        but rejects all goals because the lifecycle manager hasn't activated it yet.
        """
        if not HAS_LIFECYCLE_MSGS or LifecycleGetState is None:
            self.logger.warn("lifecycle_msgs unavailable; using 8s fallback delay for Nav2 activation")
            time.sleep(8.0)
            return True

        if self._lifecycle_client is None:
            self._lifecycle_client = self.node.create_client(
                LifecycleGetState, '/bt_navigator/get_state'
            )
        client = self._lifecycle_client

        if not client.wait_for_service(timeout_sec=min(timeout_sec, 10.0)):
            self.logger.warn("/bt_navigator/get_state service not available; using 8s fallback delay")
            time.sleep(8.0)
            return True

        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            req = LifecycleGetState.Request()
            future = client.call_async(req)
            # Wait for the future to complete (MultiThreadedExecutor processes it)
            wait_end = time.monotonic() + 3.0
            while not future.done() and time.monotonic() < wait_end:
                time.sleep(0.1)

            if future.done():
                try:
                    result = future.result()
                except Exception:
                    result = None
                if result is not None:
                    state = result.current_state
                    if state.id == 3:  # PRIMARY_STATE_ACTIVE
                        self.logger.info(
                            f"bt_navigator lifecycle: {state.label} (id={state.id}) "
                            f"-- Nav2 ready for goals"
                        )
                        self._nav2_confirmed_active = True
                        return True
                    self.logger.info(
                        f"bt_navigator lifecycle: {state.label} (id={state.id}), "
                        f"waiting for 'active'..."
                    )
            else:
                self.logger.info("bt_navigator lifecycle service call timed out, retrying...")

            time.sleep(2.0)

        self.logger.error(
            f"bt_navigator did not reach 'active' state within {timeout_sec:.0f}s"
        )
        return False

    def _sync_robot_clock(self, target_host: Optional[str] = None, max_skew_sec: float = 0.2) -> bool:
        """Synchronize the Raspberry Pi system clock with the VM clock over SSH.

        On an offline hotspot without internet, Raspberry Pi 4 boots with a frozen/stale
        time (no hardware RTC battery). If the Pi and VM clocks differ by more than ~0.2 second,
        ROS 2 TF transforms fail ('Lookup would require extrapolation into the past'),
        costmaps freeze, and Nav2 rejects goals.

        Uses passwordless SSH (configured via ssh-copy-id turtlebot@raspberrypi.local).
        NEVER restarts docker containers mid-session to avoid destroying odometry or hardware nodes.
        """
        now = time.monotonic()
        if now - getattr(self, "_last_clock_sync_at", 0.0) < 15.0:
            return True

        host = target_host or os.environ.get("ROBOT_HOST", "raspberrypi.local")
        try:
            # 1. Probe the Pi clock
            check_cmd = [
                "ssh", "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=no",
                f"turtlebot@{host}", "date +%s"
            ]
            res = subprocess.run(check_cmd, capture_output=True, text=True, timeout=5.0)
            if res.returncode != 0:
                self.logger.warn(f"Clock probe to {host} returned {res.returncode}: {res.stderr.strip() or 'failed'}")
                return False

            pi_epoch = float(res.stdout.strip())
            vm_epoch = time.time()
            skew = abs(vm_epoch - pi_epoch)

            if skew <= max_skew_sec:
                self.logger.info(f"Robot clock is in sync with VM (skew: {skew:.3f}s)")
                self._last_clock_sync_at = now
                return True

            self.logger.warn(
                f"Robot clock skew is {skew:.1f}s (VM: {vm_epoch:.0f}, Pi: {pi_epoch:.0f}). Synchronizing..."
            )

            # 2. Sync Pi clock to current VM UTC timestamp (DO NOT restart docker container!)
            current_utc = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(vm_epoch))
            sync_cmd = (
                f"ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no turtlebot@{host} "
                f"\"sudo date -u -s '{current_utc}'\""
            )
            sync_res = subprocess.run(["bash", "-c", sync_cmd], capture_output=True, text=True, timeout=10.0)
            if sync_res.returncode == 0:
                # Re-verify skew after setting clock
                verify_res = subprocess.run(check_cmd, capture_output=True, text=True, timeout=5.0)
                if verify_res.returncode == 0:
                    new_skew = abs(time.time() - float(verify_res.stdout.strip()))
                    if new_skew <= max_skew_sec:
                        self.logger.info(
                            f"Successfully synchronized Raspberry Pi clock with VM! (new skew: {new_skew:.3f}s, was {skew:.1f}s)"
                        )
                        self._last_clock_sync_at = now
                        return True
                    else:
                        self.logger.warn(
                            f"Clock set succeeded but skew remains {new_skew:.3f}s > {max_skew_sec:.2f}s threshold. Ensure chrony is active."
                        )
                        return False
                self._last_clock_sync_at = now
                return True
            else:
                self.logger.warn(f"Failed to set clock on {host}: {sync_res.stderr.strip()}")
                return False
        except subprocess.TimeoutExpired:
            self.logger.warn(f"Clock synchronization with {host} timed out")
            return False
        except Exception as exc:
            self.logger.warn(f"Clock synchronization exception: {exc}")
            return False

    def _cleanup_stale_nav2_processes(self):
        """Kill orphaned Nav2/Cartographer processes from previous bridge sessions.

        Called before launching a new mapping stack to prevent stale TF state
        and dual /map publishers causing corrupt transforms and goal rejections.
        """
        targets = (
            "cartographer_node",
            "cartographer_occupancy_grid_node",
            "controller_server",
            "planner_server",
            "behavior_server",
            "bt_navigator",
            "waypoint_follower",
            "lifecycle_manager_navigation",
        )
        pattern = "|".join(targets)
        try:
            subprocess.run(
                ["bash", "-c", f"pkill -9 -f '{pattern}' 2>/dev/null; true"],
                timeout=5.0,
                capture_output=True,
            )
            self.logger.info("Cleaned up stale Nav2/Cartographer processes (if any)")
        except Exception as exc:
            self.logger.warn(f"Stale process cleanup warning: {exc}")

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
        # Use the configured custom Behavior Tree matching the nav2 YAML configuration
        custom_bt_xml = os.path.expanduser("~/turtlebot3_ws/config/navigate_to_pose_burger.xml")
        if os.path.isfile(custom_bt_xml):
            goal_msg.behavior_tree = custom_bt_xml
            self.logger.info(f"Using custom Nav2 Behavior Tree: {custom_bt_xml}")
        else:
            self.logger.info("Using default YAML-configured Nav2 Behavior Tree")
        goal_msg.pose.header.frame_id = "map"
        # Zero timestamp tells tf2 in Nav2 to use the latest available transform, preventing clock-skew aborts
        try:
            goal_msg.pose.header.stamp = rclpy.time.Time().to_msg()
        except Exception:
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

    async def plan_goal_async(self, x: float, y: float, yaw: float):
        """Compute path to goal without moving the robot, broadcasting READY preview."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._plan_goal_blocking, float(x), float(y), float(yaw))

    def _plan_goal_blocking(self, x: float, y: float, yaw: float):
        m = self.virtual_boundary.get("safety_margin", 0.08)
        if not self.is_point_inside_boundary(x, y, margin=m):
            self.logger.warn(f"plan_goal rejected: target ({x:.2f}, {y:.2f}) is outside tabletop boundary")
            self.broadcast({
                "type": "nav_plan",
                "navigation": {
                    "path": [],
                    "frame_id": "map",
                    "status": "REJECTED_OUTSIDE_BOUNDARY",
                    "goal": {"x": x, "y": y, "yaw": yaw},
                }
            })
            return

        if not HAS_NAV2 or getattr(self, "plan_client", None) is None:
            self.logger.debug("ComputePathToPose ActionClient not available; cannot pre-plan")
            return

        if not self.plan_client.wait_for_server(timeout_sec=2.0):
            self.logger.debug("/compute_path_to_pose action server not ready")
            return

        try:
            goal_msg = ComputePathToPose.Goal()
            goal_msg.pose = PoseStamped()
            if hasattr(self, "node") and hasattr(self.node, "get_clock"):
                goal_msg.pose.header.stamp = self.node.get_clock().now().to_msg()
            goal_msg.pose.header.frame_id = "map"
            goal_msg.pose.pose.position.x = float(x)
            goal_msg.pose.pose.position.y = float(y)
            goal_msg.pose.pose.position.z = 0.0
            half_yaw = yaw / 2.0
            goal_msg.pose.pose.orientation.x = 0.0
            goal_msg.pose.pose.orientation.y = 0.0
            goal_msg.pose.pose.orientation.z = math.sin(half_yaw)
            goal_msg.pose.pose.orientation.w = math.cos(half_yaw)
            goal_msg.planner_id = "GridBased"
            goal_msg.use_start = False

            self.logger.info(f"Computing route to goal ({x:.2f}, {y:.2f}) via /compute_path_to_pose...")
            send_goal_future = self.plan_client.send_goal_async(goal_msg)
            start_t = time.time()
            while not send_goal_future.done() and (time.time() - start_t) < 3.0:
                time.sleep(0.05)

            if not send_goal_future.done():
                self.logger.warn("ComputePathToPose send_goal timed out")
                return

            goal_handle = send_goal_future.result()
            if not goal_handle.accepted:
                self.logger.warn("ComputePathToPose goal was rejected by planner_server")
                return

            get_result_future = goal_handle.get_result_async()
            start_t = time.time()
            while not get_result_future.done() and (time.time() - start_t) < 4.0:
                time.sleep(0.05)

            if not get_result_future.done():
                self.logger.warn("ComputePathToPose get_result timed out")
                return

            result_obj = get_result_future.result()
            if result_obj and hasattr(result_obj, "result") and hasattr(result_obj.result, "path"):
                path_poses = result_obj.result.path.poses
                path_points = [{"x": float(p.pose.position.x), "y": float(p.pose.position.y)} for p in path_poses]
                self.logger.info(f"Planned route successfully computed with {len(path_points)} waypoints")
                self.broadcast({
                    "type": "nav_plan",
                    "navigation": {
                        "path": path_points,
                        "frame_id": "map",
                        "status": "READY",
                        "goal": {"x": x, "y": y, "yaw": yaw},
                    }
                })
        except Exception as exc:
            self.logger.warn(f"Exception during ComputePathToPose: {exc}")

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

        if self.virtual_boundary.get("enabled"):
            b = self.virtual_boundary
            m = b.get("safety_margin", 0.08)
            if not self.is_point_inside_boundary(x, y, margin=m):
                self.logger.warn(f"NavigateToPose rejected: target ({x:.2f}, {y:.2f}) is outside tabletop boundary safe zone")
                self._broadcast_nav_status("FAILED", "Target rejected: outside tabletop virtual boundary")
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
            self.logger.info("Auto-stopping active exploration to transition to NavigateToPose target...")
            self.stop_exploration()
            start_wait = time.time()
            while time.time() - start_wait < 2.5:
                with self._explore_lock:
                    if self.exploration_state in ("IDLE", "COMPLETE", "ERROR"):
                        break
                time.sleep(0.05)

        if not HAS_NAV2 or self.nav_client is None:
            self.logger.error("NavigateToPose requested but Nav2 action client is not available")
            self._broadcast_nav_status("FAILED", "Nav2 action client not available on ROS bridge")
            return

        map_pose = self._get_latest_map_pose()
        if map_pose is None:
            self.logger.info("Bridge has not cached map->base TF yet; proceeding to let Nav2 action server transform pose")

        # Atomic ownership acquisition happens before the server wait, so another motion
        # source cannot enter while this request is blocked on Nav2 availability.
        if not self._try_acquire_ownership(MOTION_NAVIGATION):
            self._broadcast_nav_status("FAILED", "Navigation rejected: another motion owner is active")
            return

        self.logger.info("Checking if /navigate_to_pose action server is ready...")
        if not self.nav_client.wait_for_server(timeout_sec=2.0):
            self.logger.info("Nav2 action server not immediately ready, ensuring mapping/nav stack is running...")
            if not self._ensure_mapping_navigation_stack(timeout_sec=15.0):
                self.logger.error("Nav2 /navigate_to_pose action server is not active")
                self._release_ownership(MOTION_NAVIGATION)
                self._broadcast_nav_status("FAILED", "Nav2 action server not responding (verify Nav2 is launched)")
                return

        if not self.accepting_commands:
            self.logger.warn("NavigateToPose aborted: operator session ended during server wait")
            self._release_ownership(MOTION_NAVIGATION)
            return

        # Ensure bt_navigator has reached 'active' lifecycle state.
        # Without this, wait_for_server() succeeds but goals are rejected.
        if not self._nav2_confirmed_active:
            if not self._wait_for_nav2_lifecycle_active(timeout_sec=20.0):
                self.logger.error("Nav2 bt_navigator is not active; cannot navigate")
                self._release_ownership(MOTION_NAVIGATION)
                self._broadcast_nav_status("FAILED", "Nav2 is still initializing -- try again in a few seconds")
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
            # Reset lifecycle flag so next attempt re-checks bt_navigator state
            self._nav2_confirmed_active = False
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
                self._broadcast_nav_status("FAILED", "Goal rejected by Nav2: target may be in obstacle clearance zone or unmapped")
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
                    if status == GoalStatus.STATUS_ABORTED:
                        terminal_detail = "Nav2 aborted route: goal is unreachable or in obstacle clearance zone"
                    else:
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

    def _broadcast_nav_status(self, state: str, detail: str = "", status_code: Optional[int] = None):
        with self._nav_state_lock:
            goal = self.current_goal_pose if state in ("PLANNING", "NAVIGATING", "PAUSED", "CANCELING") else None
        payload = {
            "type": "nav_status",
            "navigation": {
                "navigationState": state,
                "detail": detail,
                "status_code": status_code,
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

    def _open_subprocess_logs(self, prefix: str):
        """Open timestamped log files for a subprocess.

        Returns (stdout_file, stderr_file). Falls back to DEVNULL if the log
        directory cannot be created. The caller does NOT need to close these
        handles: the subprocess inherits the file descriptors and the kernel
        reclaims them when the process exits.
        """
        try:
            os.makedirs(BRIDGE_LOG_DIR, exist_ok=True)
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            stdout_path = os.path.join(BRIDGE_LOG_DIR, f"{prefix}_{timestamp}_stdout.log")
            stderr_path = os.path.join(BRIDGE_LOG_DIR, f"{prefix}_{timestamp}_stderr.log")
            stdout_file = open(stdout_path, "w")
            stderr_file = open(stderr_path, "w")
            self.logger.info(f"Subprocess logs: {stdout_path} / {stderr_path}")
            return stdout_file, stderr_file
        except Exception as exc:
            self.logger.warn(f"Could not open subprocess logs ({prefix}): {exc}")
            return subprocess.DEVNULL, subprocess.DEVNULL

    def _ensure_mapping_navigation_stack(self, timeout_sec: float = 25.0) -> bool:
        """Ensure Cartographer + Nav2 are running without starting a frontier explorer."""
        nav_client = getattr(self, "nav_client", None)
        if nav_client is None:
            return False

        # If an external mapping/navigation launch is already active, reuse it.
        try:
            if nav_client.wait_for_server(timeout_sec=0.5):
                if not self._nav2_confirmed_active:
                    self._wait_for_nav2_lifecycle_active(timeout_sec=min(timeout_sec, 20.0))
                return True
        except Exception:
            pass

        # Before spawning a new subprocess, check if Cartographer/Nav2 nodes
        # already exist in the ROS graph. If our own process started them, wait
        # for the action server. If they are orphans from a previous bridge
        # session, kill them — they carry stale TF state that causes Nav2 to
        # reject every goal.
        try:
            known_mapping_nodes = {
                'cartographer_node', 'cartographer_occupancy_grid_node',
                'controller_server', 'bt_navigator', 'planner_server',
            }
            active_names = {n[0].lstrip('/') for n in self.node.get_node_names_and_namespaces()}
            stale_nodes = known_mapping_nodes.intersection(active_names)
            if stale_nodes:
                our_process_alive = (
                    self.mapping_process_started_by_bridge
                    and self.mapping_process is not None
                    and self.mapping_process.poll() is None
                )
                if our_process_alive:
                    self.logger.info(
                        f"Mapping/Nav2 nodes from our process in ROS graph ({stale_nodes}); "
                        f"waiting for action server"
                    )
                    server_ok = nav_client.wait_for_server(timeout_sec=min(timeout_sec, 20.0))
                    if server_ok and not self._nav2_confirmed_active:
                        self._wait_for_nav2_lifecycle_active(timeout_sec=min(timeout_sec, 30.0))
                    return server_ok
                else:
                    self.logger.warn(
                        f"Found ORPHANED Nav2/Cartographer nodes ({stale_nodes}) from a "
                        f"previous session; killing them to prevent stale TF state"
                    )
                    self._cleanup_stale_nav2_processes()
                    time.sleep(3.0)  # Let processes die and ROS graph settle
        except Exception as exc:
            self.logger.warn(f"ROS graph check failed (non-fatal): {exc}")

        if not os.path.exists(MAPPING_NAV_LAUNCH_PATH):
            self.logger.error(f"Mapping/Nav2 launch file not found: {MAPPING_NAV_LAUNCH_PATH}")
            return False

        process = getattr(self, "mapping_process", None)
        if process is not None and process.poll() is None:
            return nav_client.wait_for_server(timeout_sec=min(timeout_sec, 20.0))

        # Ensure robot clock is aligned before launching Cartographer / Nav2
        self._sync_robot_clock()

        cmd = f"source {ENV_SCRIPT_PATH} && ros2 launch {MAPPING_NAV_LAUNCH_PATH}"
        try:
            log_out, log_err = self._open_subprocess_logs("mapping_nav2")
            process = subprocess.Popen(
                ["bash", "-c", cmd],
                start_new_session=True,
                stdout=log_out,
                stderr=log_err,
            )
            self.mapping_process = process
            self.mapping_process_started_by_bridge = True
            self.logger.info(f"Mapping/Nav2 process started with PID: {process.pid}")
        except Exception as exc:
            self.logger.error(f"Failed to start Mapping/Nav2 stack: {exc}")
            return False

        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            if process.poll() is not None:
                self.logger.error(f"Mapping/Nav2 process exited early with code {process.returncode}")
                self.mapping_process = None
                self.mapping_process_started_by_bridge = False
                return False
            try:
                if nav_client.wait_for_server(timeout_sec=0.5):
                    # Action server exists but bt_navigator may still be inactive.
                    # Wait for lifecycle activation before declaring ready.
                    remaining = max(5.0, deadline - time.monotonic())
                    self._wait_for_nav2_lifecycle_active(timeout_sec=remaining)
                    return True
            except Exception:
                pass
        self.logger.error("Mapping/Nav2 stack did not expose /navigate_to_pose before timeout")
        if self.mapping_process_started_by_bridge:
            self._terminate_mapping_navigation_stack(timeout_sec=3.0)
            self.mapping_process = None
            self.mapping_process_started_by_bridge = False
        return False

    def _terminate_mapping_navigation_stack(self, timeout_sec: float = 8.0) -> bool:
        process = getattr(self, "mapping_process", None)
        if process is None or process.poll() is not None:
            return True
        try:
            os.killpg(process.pid, signal.SIGINT)
        except ProcessLookupError:
            return True
        except Exception as exc:
            self.logger.warn(f"Mapping/Nav2 SIGINT warning: {exc}")
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline and process.poll() is None:
            time.sleep(0.1)
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and process.poll() is None:
            time.sleep(0.1)
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return process.poll() is not None

    def start_exploration(self):
        """Launch only the frontier explorer after ensuring the mapping/Nav2 stack is alive."""
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
                self.logger.error(f"Exploration-only launch file not found: {EXPLORATION_LAUNCH_PATH}")
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

            if not self._ensure_mapping_navigation_stack():
                self.exploration_state = "ERROR"
                self._explore_monitor_active = False
                self._release_ownership(MOTION_EXPLORATION)
                self._broadcast_exploration_telemetry()
                return

            cmd = f"source {ENV_SCRIPT_PATH} && ros2 launch {EXPLORATION_LAUNCH_PATH}"
            process = None
            try:
                explore_log_out, explore_log_err = self._open_subprocess_logs("frontier_explorer")
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
                        stdout=explore_log_out,
                        stderr=explore_log_err,
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

    def _stop_motion_burst(self, count=5, interval=0.05):
        """Publish zero-velocity burst in background to override lingering controller/behavior outputs."""
        def _burst():
            msg = Twist()
            msg.linear.x = 0.0
            msg.angular.z = 0.0
            for _ in range(count):
                time.sleep(interval)
                with self._motion_owner_lock:
                    if self.motion_owner in (MOTION_NAVIGATION, MOTION_EXPLORATION):
                        # A new autonomous goal has taken ownership; abort zero burst immediately
                        break
                try:
                    if self.cmd_vel_pub is not None:
                        self.cmd_vel_pub.publish(msg)
                except Exception:
                    pass
        threading.Thread(target=_burst, name="zero-stop-burst", daemon=True).start()

    def _release_navigation_with_zero(self):
        """Atomically zero and release NAVIGATION so a fresh owner cannot interleave between them."""
        with self._motion_owner_lock:
            self._publish_zero_locked()
            if self.motion_owner == MOTION_NAVIGATION:
                self.motion_owner = MOTION_NONE
                self.logger.info("Motion ownership released by: NAVIGATION")
        self._stop_motion_burst()
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
        try:
            if self.cmd_vel_pub is not None:
                self.cmd_vel_pub.publish(msg)
        except Exception:
            pass

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

        with self._motion_owner_lock:
            if self.motion_owner in (MOTION_NAVIGATION, MOTION_EXPLORATION):
                # Autonomous operation owns motion -- browser manual cmd_vel (zero or non-zero)
                # must not interrupt or inject zeroes into the physical control stream.
                if not is_zero:
                    self.logger.warn(f"Manual cmd_vel rejected: {self.motion_owner} owns motion")
                return

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
            if self.virtual_boundary.get("enabled") and linear != 0.0:
                pose = self._get_latest_map_pose()
                if pose is not None:
                    rx = pose["position"]["x"]
                    ry = pose["position"]["y"]
                    yaw = pose.get("yaw_rad", 0.0)
                    b = self.virtual_boundary
                    m = float(b.get("safety_margin", 0.06))
                    dt = 0.2
                    next_x = rx + linear * math.cos(yaw) * dt
                    next_y = ry + linear * math.sin(yaw) * dt
                    if not self.is_step_safe(rx, ry, next_x, next_y, margin=m):
                        linear = 0.0

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

        mapping_terminal = True
        if getattr(self, "mapping_process_started_by_bridge", False):
            mapping_terminal = self._terminate_mapping_navigation_stack(timeout_sec=max(1.0, min(8.0, timeout_sec)))
            if mapping_terminal:
                self.mapping_process = None
                self.mapping_process_started_by_bridge = False
            else:
                self.logger.error(
                    "Bridge shutdown timed out waiting for the bridge-started Mapping/Nav2 stack; "
                    "use the physical power switch as the final emergency stop"
                )
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
        return nav_terminal and explore_terminal and mapping_terminal

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
                if hasattr(self.bridge_node, "virtual_boundary") and self.bridge_node.virtual_boundary:
                    init_payload["boundary"] = self.bridge_node.virtual_boundary
                await websocket.send(json.dumps(init_payload))

                # Proactively ensure Cartographer + Nav2 stack is running for real-time map retrieval across modes
                self.bridge_node.ensure_mapping_stack_async()

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

        elif msg_type == "plan_goal":
            x = _parse_finite_number(data.get("x"))
            y = _parse_finite_number(data.get("y"))
            yaw = _parse_finite_number(data.get("yaw"))
            if x is not None and y is not None:
                if yaw is None:
                    yaw = 0.0
                asyncio.create_task(self.bridge_node.plan_goal_async(x, y, yaw))

        elif msg_type == "set_virtual_boundary":
            enabled = bool(data.get("enabled", False))
            min_x = _parse_finite_number(data.get("min_x"))
            max_x = _parse_finite_number(data.get("max_x"))
            min_y = _parse_finite_number(data.get("min_y"))
            max_y = _parse_finite_number(data.get("max_y"))
            margin = _parse_finite_number(data.get("safety_margin"))
            rot_deg = _parse_finite_number(data.get("rotation_deg"))
            if rot_deg is None:
                rot_deg = _parse_finite_number(data.get("rotationDeg"))
            if rot_deg is None:
                rot_deg = 0.0
            if min_x is not None and max_x is not None and min_y is not None and max_y is not None:
                self.bridge_node.virtual_boundary = {
                    "enabled": enabled,
                    "min_x": min(min_x, max_x),
                    "max_x": max(min_x, max_x),
                    "min_y": min(min_y, max_y),
                    "max_y": max(min_y, max_y),
                    "safety_margin": max(0.04, margin if margin is not None else 0.08),
                    "rotation_deg": rot_deg,
                }
                self.bridge_node._save_virtual_boundary()
                self.bridge_node._publish_tabletop_boundary()
                self.bridge_node.broadcast({
                    "type": "virtual_boundary",
                    "boundary": self.bridge_node.virtual_boundary,
                })

        elif msg_type == "clear_map":
            self.bridge_node.clear_map_data()

        elif msg_type == "refresh_map":
            self.bridge_node.refresh_map_data()

        elif msg_type in ("ensure_mapping", "start_mapping"):
            self.bridge_node.ensure_mapping_stack_async()

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
            if MultiThreadedExecutor is not None:
                executor = MultiThreadedExecutor()
                executor.add_node(bridge_node.node)
                executor.spin()
            else:
                rclpy.spin(bridge_node.node)
        except Exception as e:
            print(f"[ROS EXCEPTION] {e}")

    ros_thread = threading.Thread(target=ros_spin, daemon=True)
    ros_thread.start()

    # Start WebSocket async server. Newer websockets releases require serve() to be
    # constructed while the target asyncio loop is actively running.
    print(f"[INFO] Starting WebSocket server on {WS_HOST}:{WS_PORT}...")

    async def start_websocket_server():
        # Raise the default 1 MiB frame limit. Large OccupancyGrid maps (500x500+)
        # serialized as JSON integer arrays routinely exceed 1 MiB, causing the
        # connection to drop with PayloadTooBig or code 1009.
        return await websockets.serve(server.handler, WS_HOST, WS_PORT, max_size=10 * 1024 * 1024)

    start_server = loop.run_until_complete(start_websocket_server())
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
        except Exception as exc:
            print(f"[SHUTDOWN] Note during shutdown_blocking: {exc}")
        finally:
            try:
                bridge_node.node.destroy_node()
            except Exception:
                pass
            try:
                if rclpy.ok():
                    rclpy.shutdown()
            except Exception:
                pass
            if ros_thread.is_alive():
                ros_thread.join(timeout=2.0)
            try:
                loop.close()
            except Exception:
                pass
            if shutdown_ok:
                print("[SHUTDOWN] Bridge stopped cleanly: tracked motion sources terminated.")
            else:
                print(
                    "[SHUTDOWN] Bridge process stopped, but one or more tracked motion sources "
                    "were not confirmed terminal; use the physical power switch as the final emergency stop."
                )


if __name__ == "__main__":
    main()
