import asyncio
import importlib.util
import threading
import time
from collections import deque
from pathlib import Path
import unittest
from unittest import mock
import sys


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "ros_bridge" / "bridge.py"
spec = importlib.util.spec_from_file_location("turtlebot_bridge_under_test", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)


class FakeTwist:
    def __init__(self):
        self.linear = type("Linear", (), {"x": 0.0})()
        self.angular = type("Angular", (), {"z": 0.0})()


class FakePublisher:
    def __init__(self, callback=None):
        self.messages = []
        self.lock = threading.Lock()
        self.callback = callback

    def publish(self, msg):
        with self.lock:
            self.messages.append((msg.linear.x, msg.angular.z))
        if self.callback is not None:
            self.callback(msg)


class FakeLogger:
    def info(self, _message):
        pass

    def warn(self, _message):
        pass

    def error(self, _message):
        pass

    def debug(self, _message):
        pass


def make_node():
    node = bridge.TurtleBotBridgeNode.__new__(bridge.TurtleBotBridgeNode)
    node.motion_owner = bridge.MOTION_NONE
    node._motion_owner_lock = threading.RLock()
    node._source_switch_in_progress = False
    node.accepting_commands = True
    node.last_cmd_vel = {"linear": 0.0, "angular": 0.0}
    node._last_manual_command_at = time.monotonic()
    node._manual_session_id = None
    node._invalidated_manual_session_ids = deque(maxlen=32)
    node._manual_watchdog_stop = threading.Event()
    node._cleanup_generation = 0
    node._cleanup_in_progress = False
    node._cleanup_complete_event = threading.Event()
    node._cleanup_complete_event.set()
    node._nav_state_lock = threading.RLock()
    node._nav_safety_lock_record = None
    node.cmd_vel_pub = FakePublisher()
    node.logger = FakeLogger()
    node.broadcasted = []
    node.last_map_broadcast = 0.0
    node._latest_map_payload = None
    node._latest_optimized_map_payload = None
    node.broadcast = node.broadcasted.append
    return node


bridge.Twist = FakeTwist

if not hasattr(bridge, "GoalStatus"):
    class FakeGoalStatus:
        STATUS_SUCCEEDED = 4
        STATUS_CANCELED = 6
        STATUS_UNKNOWN = 0

    bridge.GoalStatus = FakeGoalStatus


class FakeResultFuture:
    def __init__(self, status):
        self.status = status
        self.callback = None

    def result(self):
        return type("ResultWrap", (), {"status": self.status})()

    def add_done_callback(self, callback):
        self.callback = callback




class FakeGoalHandle:
    def __init__(self, accepted=True):
        self.accepted = accepted

    def get_result_async(self):
        return FakeResultFuture(bridge.GoalStatus.STATUS_CANCELED)


class FakeGoalResponseFuture:
    def __init__(self, goal_handle):
        self.goal_handle = goal_handle

    def result(self):
        return self.goal_handle


class FakeNavigateToPose:
    class Goal:
        def __init__(self):
            self.pose = type(
                "PoseStamped",
                (),
                {
                    "header": type("Header", (), {"frame_id": "", "stamp": None})(),
                    "pose": type(
                        "Pose",
                        (),
                        {
                            "position": type("Position", (), {"x": 0.0, "y": 0.0, "z": 0.0})(),
                            "orientation": type(
                                "Orientation",
                                (),
                                {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                            )(),
                        },
                    )(),
                },
            )()


class FakeWebSocket:
    def __init__(self, name="socket", send_exception=None, messages=None):
        self.name = name
        self.remote_address = name
        self.ready_state = True
        self.send_exception = send_exception
        self.messages = list(messages or [])
        self.sent = []
        self.closed = False

    async def send(self, message):
        if self.send_exception is not None:
            raise self.send_exception
        self.sent.append(message)

    async def close(self, *args, **kwargs):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.messages:
            return self.messages.pop(0)
        raise StopAsyncIteration

    def __repr__(self):
        return f"<FakeWebSocket {self.name}>"


class FakeServerNode:
    def __init__(self):
        self._cleanup_complete_event = threading.Event()
        self._cleanup_complete_event.set()
        self.exploration_state = "IDLE"
        self.frontier_count = 0
        self.selected_frontier = None
        self.nav_state = "IDLE"
        self.current_goal_pose = None
        self._latest_map_payload = None
        self.accepting_commands = True
        self.exploration_state = "IDLE"
        self.frontier_count = 0
        self.selected_frontier = None
        self.nav_state = "IDLE"
        self.current_goal_pose = None
        self._latest_map_payload = None
        self.publish_velocity_calls = []
        self.begin_calls = 0
        self.complete_calls = 0
        self.restore_calls = 0
        self.messages = []

    def begin_last_client_disconnect(self):
        self.begin_calls += 1
        self._cleanup_complete_event.clear()

    async def complete_last_client_disconnect(self):
        self.complete_calls += 1
        self._cleanup_complete_event.set()

    async def wait_for_operator_cleanup(self):
        while not self._cleanup_complete_event.is_set():
            await asyncio.sleep(0)

    def restore_operator_session(self):
        self.restore_calls += 1
        return True

    def publish_velocity(self, *args, **kwargs):
        self.publish_velocity_calls.append((args, kwargs))
def make_nav_node(generation=1, owner=bridge.MOTION_NAVIGATION):
    node = make_node()
    record = bridge.NavGoalRecord(
        generation=generation,
        target={"x": 1.0, "y": 2.0, "yaw": 0.0},
    )
    node.nav_goal_generation = generation
    node._nav_records = {generation: record}
    node._current_nav_record = record
    node._nav_cancel_record = None
    node._nav_safety_lock_record = None
    node.current_goal_handle = object()
    node.current_goal_pose = {"x": 1.0, "y": 2.0, "yaw": 0.0}
    node.nav_state = "NAVIGATING"
    node.motion_owner = owner
    node._broadcast_nav_status = lambda state, detail="": node.broadcasted.append({"state": state, "detail": detail})
    return node, record


class ManualLeaseTests(unittest.TestCase):
    def test_boolean_numeric_input_is_rejected_as_malformed(self):
        self.assertIsNone(bridge._parse_finite_number(True))
        self.assertIsNone(bridge._parse_finite_number(False))

    def test_first_nonzero_requires_a_fresh_session(self):
        node = make_node()
        node.publish_velocity(0.1, 0.0, manual_session_id="session-a", new_manual_session=False)
        self.assertEqual(node.motion_owner, bridge.MOTION_NONE)
        self.assertEqual(node.last_cmd_vel, {"linear": 0.0, "angular": 0.0})
        self.assertEqual(node.cmd_vel_pub.messages, [])

    def test_atomic_manual_start_allows_exactly_one_concurrent_owner(self):
        node = make_node()
        start = threading.Barrier(3)

        def worker(session_id):
            start.wait()
            node.publish_velocity(
                0.1,
                0.0,
                manual_session_id=session_id,
                new_manual_session=True,
            )

        threads = [
            threading.Thread(target=worker, args=("session-a",)),
            threading.Thread(target=worker, args=("session-b",)),
        ]
        for thread in threads:
            thread.start()
        start.wait()
        for thread in threads:
            thread.join(timeout=2.0)

        self.assertEqual(node.motion_owner, bridge.MOTION_MANUAL)
        self.assertIn(node._manual_session_id, {"session-a", "session-b"})
        self.assertEqual(node.cmd_vel_pub.messages.count((0.1, 0.0)), 1)

    def test_explicit_zero_invalidates_old_session_and_cannot_leave_motion_behind(self):
        node = make_node()
        node.publish_velocity(0.1, 0.0, manual_session_id="session-a", new_manual_session=True)
        node.publish_zero_velocity()

        self.assertEqual(node.motion_owner, bridge.MOTION_NONE)
        self.assertEqual(node.last_cmd_vel, {"linear": 0.0, "angular": 0.0})

        before = len(node.cmd_vel_pub.messages)
        node.publish_velocity(0.1, 0.0, manual_session_id="session-a", new_manual_session=False)
        self.assertEqual(len(node.cmd_vel_pub.messages), before)
        self.assertEqual(node.motion_owner, bridge.MOTION_NONE)

        node.publish_velocity(0.1, 0.0, manual_session_id="session-b", new_manual_session=True)
        self.assertEqual(node.motion_owner, bridge.MOTION_MANUAL)
        self.assertEqual(node._manual_session_id, "session-b")
        self.assertEqual(node.last_cmd_vel, {"linear": 0.1, "angular": 0.0})

    def test_watchdog_zeroes_and_invalidates_current_session(self):
        node = make_node()
        node.publish_velocity(0.1, 0.0, manual_session_id="session-a", new_manual_session=True)
        node._last_manual_command_at = time.monotonic() - 10.0

        old_timeout = bridge.MANUAL_COMMAND_TIMEOUT_SEC
        old_poll = bridge.MANUAL_WATCHDOG_POLL_SEC
        try:
            bridge.MANUAL_COMMAND_TIMEOUT_SEC = 0.0
            bridge.MANUAL_WATCHDOG_POLL_SEC = 0.01
            thread = threading.Thread(target=node._manual_watchdog_loop, daemon=True)
            thread.start()
            deadline = time.monotonic() + 1.0
            while node.motion_owner != bridge.MOTION_NONE and time.monotonic() < deadline:
                time.sleep(0.01)
            node._manual_watchdog_stop.set()
            thread.join(timeout=1.0)
        finally:
            bridge.MANUAL_COMMAND_TIMEOUT_SEC = old_timeout
            bridge.MANUAL_WATCHDOG_POLL_SEC = old_poll

        self.assertEqual(node.motion_owner, bridge.MOTION_NONE)
        self.assertEqual(node.last_cmd_vel, {"linear": 0.0, "angular": 0.0})
        self.assertEqual(node._manual_session_id, None)
        self.assertIn("session-a", node._invalidated_manual_session_ids)
        self.assertTrue(any(msg.get("type") == "manual_session_expired" for msg in node.broadcasted))


    def test_source_switch_rejects_live_lifecycle_even_if_owner_slot_is_clear(self):
        node = make_node()
        node._cleanup_in_progress = False
        node._source_switch_in_progress = False
        node._nav_cancel_record = None
        node._nav_safety_lock_record = None
        node._current_nav_record = None
        node.nav_state = "NAVIGATING"
        node._explore_lock = threading.RLock()
        node._explore_record = None
        node.explore_process = None
        node.exploration_state = "IDLE"

        self.assertFalse(node.begin_source_switch("DEMO"))
        self.assertFalse(node._source_switch_in_progress)
        self.assertTrue(node.accepting_commands)

    def test_restore_rejects_active_lifecycle_even_if_owner_slot_is_clear(self):
        node = make_node()
        node._cleanup_in_progress = False
        node._source_switch_in_progress = False
        node._nav_cancel_record = None
        node._nav_safety_lock_record = None
        node._current_nav_record = None
        node.nav_state = "PAUSED"
        node._explore_lock = threading.RLock()
        node._explore_record = None
        node.explore_process = None
        node.exploration_state = "IDLE"

        self.assertFalse(node.restore_operator_session())
        self.assertTrue(node.accepting_commands)

    def test_watchdog_expiry_cannot_be_followed_by_old_nonzero_packet(self):
        node = make_node()
        node.publish_velocity(0.1, 0.0, manual_session_id="session-a", new_manual_session=True)
        node._last_manual_command_at = time.monotonic() - 10.0

        bridge.MANUAL_COMMAND_TIMEOUT_SEC = 0.0
        bridge.MANUAL_WATCHDOG_POLL_SEC = 0.01
        try:
            node._manual_watchdog_stop.set()
            # Exercise the same atomic transition directly; the watchdog thread test above
            # separately verifies the loop and broadcast behavior.
            with node._motion_owner_lock:
                node._invalidate_manual_session_locked()
                node._publish_zero_locked()

            before = len(node.cmd_vel_pub.messages)
            node.publish_velocity(0.1, 0.0, manual_session_id="session-a", new_manual_session=False)
            self.assertEqual(len(node.cmd_vel_pub.messages), before)
            self.assertEqual(node.motion_owner, bridge.MOTION_NONE)
        finally:
            bridge.MANUAL_COMMAND_TIMEOUT_SEC = 0.8
            bridge.MANUAL_WATCHDOG_POLL_SEC = 0.15


class NavigationLifecycleTests(unittest.TestCase):
    def test_nav_terminal_event_is_set_only_after_bridge_state_and_zero(self):
        observed_event_before_zero = []
        node, record = make_nav_node()
        node.cmd_vel_pub = FakePublisher(
            callback=lambda _msg: observed_event_before_zero.append(record.result_event.is_set())
        )

        node._on_nav_result(FakeResultFuture(bridge.GoalStatus.STATUS_SUCCEEDED), record.generation)

        self.assertEqual(observed_event_before_zero, [False])
        self.assertTrue(record.result_event.is_set())
        self.assertEqual(node.nav_state, "GOAL_REACHED")
        self.assertEqual(node.motion_owner, bridge.MOTION_NONE)
        self.assertIsNone(node._current_nav_record)
        self.assertEqual(node.last_cmd_vel, {"linear": 0.0, "angular": 0.0})

    def test_stale_goal_acceptance_does_not_zero_newer_navigation(self):
        node, old_record = make_nav_node(generation=1)
        new_record = bridge.NavGoalRecord(
            generation=2,
            target={"x": 3.0, "y": 4.0, "yaw": 0.5},
        )
        node.nav_goal_generation = 2
        node._nav_records[2] = new_record
        node._current_nav_record = new_record
        node.current_goal_handle = object()
        node.nav_state = "NAVIGATING"
        node.motion_owner = bridge.MOTION_NAVIGATION
        old_record.cancel_requested = True

        canceled = []
        node._start_cancel_for_record = lambda record: canceled.append(record)
        before = len(node.cmd_vel_pub.messages)

        node._on_nav_goal_response(FakeGoalResponseFuture(FakeGoalHandle(True)), old_record.generation)

        self.assertEqual(canceled, [old_record])
        self.assertEqual(len(node.cmd_vel_pub.messages), before)
        self.assertIs(node._current_nav_record, new_record)
        self.assertEqual(node.motion_owner, bridge.MOTION_NAVIGATION)

    def test_stale_replace_result_cleans_old_record_without_releasing_new_owner(self):
        node, old_record = make_nav_node(generation=1)
        new_record = bridge.NavGoalRecord(
            generation=2,
            target={"x": 3.0, "y": 4.0, "yaw": 0.5},
        )
        node.nav_goal_generation = 2
        node._nav_records[2] = new_record
        node._current_nav_record = new_record
        node.nav_state = "NAVIGATING"
        node.motion_owner = bridge.MOTION_NAVIGATION
        node._nav_cancel_record = old_record
        node._nav_safety_lock_record = old_record
        old_record.cancel_action = "REPLACE"

        before = len(node.cmd_vel_pub.messages)
        node._on_nav_result(FakeResultFuture(bridge.GoalStatus.STATUS_CANCELED), old_record.generation)

        self.assertTrue(old_record.result_event.is_set())
        self.assertIs(node._current_nav_record, new_record)
        self.assertEqual(node.nav_state, "NAVIGATING")
        self.assertEqual(node.motion_owner, bridge.MOTION_NAVIGATION)
        self.assertIsNone(node._nav_cancel_record)
        self.assertIsNone(node._nav_safety_lock_record)
        # A stale old-goal result must be physically inert while newer navigation is active.
        self.assertEqual(len(node.cmd_vel_pub.messages), before)
        self.assertEqual(node.last_cmd_vel, {"linear": 0.0, "angular": 0.0})




class NavigationAdmissionTests(unittest.TestCase):
    def test_nav2_dispatch_is_rejected_if_disconnect_disarms_before_send(self):
        node = make_node()
        node.nav_client = type("NavClient", (), {})()
        node.current_goal_pose = {"x": 1.0, "y": 2.0, "yaw": 0.0}
        node.nav_state = "PLANNING"
        node.nav_goal_generation = 1
        node._nav_records = {}
        node._current_nav_record = None
        node._nav_cancel_record = None
        node._nav_safety_lock_record = None
        node.node = type("RosNode", (), {"get_clock": lambda self: type("Clock", (), {"now": lambda self: type("Stamp", (), {"to_msg": lambda self: None})()})()})()
        calls = []
        node.nav_client.send_goal_async = lambda *args, **kwargs: calls.append((args, kwargs))
        node.motion_owner = bridge.MOTION_NAVIGATION
        node.accepting_commands = False

        old_has_nav2 = getattr(bridge, "HAS_NAV2", False)
        old_action = getattr(bridge, "NavigateToPose", None)
        try:
            bridge.HAS_NAV2 = True
            bridge.NavigateToPose = FakeNavigateToPose
            node._send_nav_goal(1.0, 2.0, 0.0, 1, "test dispatch")
        finally:
            bridge.HAS_NAV2 = old_has_nav2
            bridge.NavigateToPose = old_action

        self.assertEqual(calls, [])
        self.assertEqual(node.motion_owner, bridge.MOTION_NONE)
        self.assertEqual(node.last_cmd_vel, {"linear": 0.0, "angular": 0.0})


class ExplorationAdmissionTests(unittest.TestCase):
    def test_explorer_launch_is_rejected_if_cleanup_wins_before_process_spawn(self):
        node = make_node()
        node._explore_lock = threading.RLock()
        node.explore_process = None
        node._explore_record = None
        node._explore_generation = 0
        node._explore_monitor_active = False
        node.exploration_state = "IDLE"
        node.frontier_count = 0
        node.active_frontiers = {}
        node.selected_frontier = None
        node._nav_state_lock = threading.RLock()
        node._nav_cancel_record = None
        node._nav_safety_lock_record = None
        node._current_nav_record = None
        node.nav_state = "IDLE"
        original_acquire = node._try_acquire_ownership

        def acquire_then_disconnect(owner):
            granted = original_acquire(owner)
            if granted:
                node.begin_last_client_disconnect()
            return granted

        node._try_acquire_ownership = acquire_then_disconnect
        node.accepting_commands = True

        with mock.patch.object(bridge.subprocess, "Popen", side_effect=AssertionError("spawned after cleanup")):
            with mock.patch.object(bridge.os.path, "exists", return_value=True):
                node.start_exploration()

        self.assertIsNone(node._explore_record)
        self.assertIsNone(node.explore_process)
        self.assertEqual(node.motion_owner, bridge.MOTION_NONE)
        self.assertFalse(node.accepting_commands)


class WebSocketControlLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def make_server(self):
        loop = asyncio.get_running_loop()
        server = bridge.WebSocketBridgeServer(loop)
        node = FakeServerNode()
        server.set_bridge_node(node)
        return server, node

    async def test_second_controller_is_rejected_without_replacing_current_controller(self):
        server, _node = self.make_server()
        first = FakeWebSocket("first")
        second = FakeWebSocket("second")
        server.clients = {first}
        server.operator_client = first

        await server.handler(second)

        self.assertTrue(second.closed)
        self.assertIs(server.operator_client, first)
        self.assertIn(first, server.clients)
        self.assertNotIn(second, server.clients)

    async def test_stale_socket_cannot_dispatch_control_after_controller_changes(self):
        server, node = self.make_server()
        first = FakeWebSocket("first")
        second = FakeWebSocket("second")
        server.clients = {first, second}
        server.operator_client = second

        calls = []
        node.publish_velocity = lambda *args, **kwargs: calls.append((args, kwargs))
        server._handle_client_message(
            {
                "type": "cmd_vel",
                "linear": 0.1,
                "angular": 0.0,
                "manual_session_id": "stale",
                "new_manual_session": True,
            },
            first,
        )

        self.assertEqual(calls, [])

    async def test_dead_controller_detected_during_broadcast_starts_authoritative_cleanup(self):
        server, node = self.make_server()
        dead = FakeWebSocket("dead", send_exception=RuntimeError("socket gone"))
        server.clients = {dead}
        server.operator_client = dead

        await server._broadcast_async("{}")
        task = server._operator_cleanup_task
        self.assertIsNotNone(task)
        await asyncio.wait_for(task, timeout=1.0)

        self.assertEqual(node.begin_calls, 1)
        self.assertEqual(node.complete_calls, 1)
        self.assertIsNone(server.operator_client)
        self.assertNotIn(dead, server.clients)

    async def test_init_send_failure_still_runs_controller_cleanup(self):
        server, node = self.make_server()
        socket = FakeWebSocket("init-failure", send_exception=RuntimeError("init send failed"))

        with self.assertRaises(RuntimeError):
            await server.handler(socket)

        # handler's finally must not leak the controller slot when initialization send fails.
        self.assertEqual(node.begin_calls, 1)
        self.assertEqual(node.complete_calls, 1)
        self.assertIsNone(server.operator_client)
        self.assertNotIn(socket, server.clients)

    async def test_failed_controller_cleanup_keeps_operator_slot_locked(self):
        server, node = self.make_server()
        socket = FakeWebSocket("cleanup-failure")
        server.clients = {socket}
        server.operator_client = socket

        async def failing_complete():
            node.complete_calls += 1
            raise RuntimeError("cleanup failed")

        node.complete_last_client_disconnect = failing_complete
        task = server._ensure_operator_cleanup(socket)
        self.assertIsNotNone(task)
        await asyncio.wait_for(task, timeout=1.0)

        # Cleanup failure must never expose the control slot to a reconnect. The stale
        # socket is removed from the client set, but the controller identity remains
        # reserved until a later cleanup attempt can confirm terminality.
        self.assertIs(server.operator_client, socket)
        self.assertNotIn(socket, server.clients)
        self.assertEqual(node.begin_calls, 1)
        self.assertEqual(node.complete_calls, 1)

    async def test_controller_cleanup_is_idempotent_when_two_paths_detect_same_socket(self):
        server, node = self.make_server()
        socket = FakeWebSocket("same")
        server.clients = {socket}
        server.operator_client = socket

        first = server._ensure_operator_cleanup(socket)
        second = server._ensure_operator_cleanup(socket)
        self.assertIs(first, second)
        await asyncio.wait_for(first, timeout=1.0)

        self.assertEqual(node.begin_calls, 1)
        self.assertEqual(node.complete_calls, 1)


class MapProvenanceTests(unittest.TestCase):
    def test_optimized_map_cannot_replace_authoritative_reconnect_map_cache(self):
        node = make_node()
        node.last_map_broadcast = 0.0
        node._latest_map_payload = None
        node._latest_optimized_map_payload = None

        class Position:
            x = 1.0
            y = 2.0
            z = 0.0

        class Origin:
            position = Position()

        class Info:
            width = 2
            height = 1
            resolution = 0.05
            origin = Origin()

        class Grid:
            info = Info()
            data = [0, 100]

        node._on_map(Grid())
        raw = node._latest_map_payload
        node._on_optimized_map(Grid())

        self.assertIs(node._latest_map_payload, raw)
        self.assertIsNotNone(node._latest_optimized_map_payload)
        self.assertIsNot(node._latest_optimized_map_payload, raw)


class SourceSwitchRaceTests(unittest.TestCase):
    def test_failed_source_switch_never_rearms_after_disconnect_cleanup_begins(self):
        node = make_node()
        original_nav_lock = node._nav_state_lock

        class TriggerCleanupLock:
            def __init__(self, wrapped, trigger):
                self.wrapped = wrapped
                self.trigger = trigger

            def __enter__(self):
                self.wrapped.acquire()
                return self

            def __exit__(self, exc_type, exc, tb):
                self.wrapped.release()
                self.trigger()
                return False

        node.nav_state = "IDLE"
        node._current_nav_record = None
        node._nav_cancel_record = None
        node._nav_safety_lock_record = None
        node._explore_record = None
        node.explore_process = None
        node.exploration_state = "IDLE"
        node._explore_lock = threading.RLock()
        node._cleanup_in_progress = False
        node._cleanup_generation = 0
        node._source_switch_in_progress = False
        node.accepting_commands = True
        node._nav_state_lock = TriggerCleanupLock(original_nav_lock, node.begin_last_client_disconnect)

        self.assertFalse(node.begin_source_switch("DEMO"))
        self.assertTrue(node._cleanup_in_progress)
        self.assertFalse(node.accepting_commands)


if __name__ == "__main__":
    unittest.main()
