#!/bin/bash
# ============================================================================
# TurtleBot3 Control Center — Navigation Diagnostics Script
# ============================================================================
# Run this on Ubuntu VM WHILE bridge.py is running and the frontend is connected.
# It collects all the info needed to diagnose why Nav2 rejects goals.
#
# Usage:
#   chmod +x ~/nav_diagnostics.sh
#   source ~/turtlebot_env.sh
#   ~/nav_diagnostics.sh
# ============================================================================

echo "============================================"
echo " TurtleBot3 Nav2 Diagnostics"
echo " $(date)"
echo "============================================"

echo ""
echo "=== 1. ROS 2 Node List ==="
ros2 node list 2>&1

echo ""
echo "=== 2. Lifecycle State of Nav2 Nodes ==="
for node in /bt_navigator /planner_server /controller_server /behavior_server /waypoint_follower /lifecycle_manager_navigation; do
    state=$(ros2 lifecycle get $node 2>&1)
    echo "  $node : $state"
done

echo ""
echo "=== 3. Action Servers Available ==="
ros2 action list 2>&1

echo ""
echo "=== 4. Action Server Info (/navigate_to_pose) ==="
ros2 action info /navigate_to_pose 2>&1

echo ""
echo "=== 5. TF Tree Summary ==="
ros2 run tf2_ros tf2_monitor --once 2>&1 | head -60

echo ""
echo "=== 6. TF Frames (map -> odom -> base) ==="
ros2 run tf2_ros tf2_echo map odom --once 2>&1 | head -10
echo "---"
ros2 run tf2_ros tf2_echo odom base_link --once 2>&1 | head -10
echo "---"
ros2 run tf2_ros tf2_echo map base_link --once 2>&1 | head -10

echo ""
echo "=== 7. Topic List ==="
ros2 topic list 2>&1

echo ""
echo "=== 8. /map Topic Info ==="
ros2 topic info /map --verbose 2>&1

echo ""
echo "=== 9. /cmd_vel Topic Info ==="
ros2 topic info /cmd_vel --verbose 2>&1

echo ""
echo "=== 10. Check for velocity_smoother ==="
ros2 node list 2>&1 | grep -i velocity
ros2 node list 2>&1 | grep -i smoother
echo "(Should be empty if Fix 10 is deployed correctly)"

echo ""
echo "=== 11. Nav2 Global Costmap Status ==="
ros2 topic echo /global_costmap/costmap_raw --once 2>&1 | head -20

echo ""
echo "=== 12. /scan Topic Check ==="
ros2 topic hz /scan --window 5 2>&1 &
SCAN_PID=$!
sleep 3
kill $SCAN_PID 2>/dev/null
wait $SCAN_PID 2>/dev/null

echo ""
echo "=== 13. /odom Topic Check ==="
ros2 topic hz /odom --window 5 2>&1 &
ODOM_PID=$!
sleep 3
kill $ODOM_PID 2>/dev/null
wait $ODOM_PID 2>/dev/null

echo ""
echo "=== 14. Quick CLI Nav Goal Test ==="
echo "Sending test goal to (0.0, 0.0, 0.0)..."
timeout 10 ros2 action send_goal /navigate_to_pose nav2_msgs/action/NavigateToPose \
  "{pose: {header: {frame_id: 'map'}, pose: {position: {x: 0.0, y: 0.0, z: 0.0}, orientation: {w: 1.0}}}}" 2>&1

echo ""
echo "============================================"
echo " Diagnostics Complete"
echo "============================================"
