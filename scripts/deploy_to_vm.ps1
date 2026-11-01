param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$VmIp,

    [Parameter(Position=1)]
    [string]$VmUser = "yash"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Deploying TurtleBot3 Bridge & Nav2 Config to VM ($VmUser@$VmIp)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$bridgeLocal = "ros_bridge\bridge.py"
$yamlLocal = "ros_bridge\config\nav2_exploration_burger.yaml"
$xmlLocal = "ros_bridge\config\navigate_to_pose_burger.xml"
$xmlInvalidLocal = "ros_bridge\config\navigate_w_replanning_only_if_path_becomes_invalid.xml"

if (-not (Test-Path $bridgeLocal)) {
    Write-Error "Cannot find $bridgeLocal. Run this script from the turtlebot-control-center root."
}

Write-Host "`n1. Copying bridge.py..." -ForegroundColor Yellow
scp $bridgeLocal "${VmUser}@${VmIp}:~/turtlebot_bridge/bridge.py"

Write-Host "2. Copying nav2_exploration_burger.yaml..." -ForegroundColor Yellow
scp $yamlLocal "${VmUser}@${VmIp}:~/turtlebot3_ws/config/nav2_exploration_burger.yaml"

Write-Host "3. Copying behavior tree XML files..." -ForegroundColor Yellow
scp $xmlLocal "${VmUser}@${VmIp}:~/turtlebot3_ws/config/navigate_to_pose_burger.xml"
if (Test-Path $xmlInvalidLocal) {
    scp $xmlInvalidLocal "${VmUser}@${VmIp}:~/turtlebot3_ws/config/navigate_w_replanning_only_if_path_becomes_invalid.xml"
}

Write-Host "`n[SUCCESS] All files deployed successfully to $VmIp!" -ForegroundColor Green
Write-Host "`nTo restart the bridge on the VM, run:" -ForegroundColor Cyan
Write-Host "pkill -9 -f 'cartographer_node|cartographer_occupancy_grid_node|controller_server|planner_server|behavior_server|bt_navigator|waypoint_follower|lifecycle_manager' 2>/dev/null; true" -ForegroundColor White
Write-Host "cd ~/turtlebot_bridge && source ~/turtlebot_env.sh && python3 bridge.py" -ForegroundColor White
