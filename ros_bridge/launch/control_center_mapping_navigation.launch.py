"""
Launch file for TurtleBot3 Control Center: Cartographer SLAM + Nav2 Navigation.

This replaces the stock nav2_bringup/navigation_launch.py inclusion so that we
can exclude the velocity_smoother node.  The velocity_smoother's idle-timeout
publishes zero-velocity to /cmd_vel at 20 Hz whenever Nav2 isn't navigating,
which fights with bridge.py's manual cmd_vel commands.

All Nav2 nodes are launched as standalone processes (no composition) to keep
debugging simple.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    # ── directories ──────────────────────────────────────────────────────
    turtlebot3_cartographer_dir = get_package_share_directory('turtlebot3_cartographer')

    # ── parameters ───────────────────────────────────────────────────────
    nav2_params = os.path.expanduser(
        '~/turtlebot3_ws/config/nav2_exploration_burger.yaml'
    )

    use_sim_time = LaunchConfiguration('use_sim_time', default='false')
    autostart = LaunchConfiguration('autostart', default='true')
    log_level = LaunchConfiguration('log_level', default='info')

    # Topic remappings shared by all Nav2 nodes
    remappings = [('/tf', 'tf'), ('/tf_static', 'tf_static')]

    # ── Cartographer SLAM ────────────────────────────────────────────────
    cartographer_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(turtlebot3_cartographer_dir, 'launch', 'cartographer.launch.py')
        ),
        launch_arguments={
            'use_sim_time': use_sim_time,
            'use_rviz': 'false',
        }.items(),
    )

    # ── Nav2 nodes (WITHOUT velocity_smoother) ───────────────────────────
    # These are the same nodes that nav2_bringup/navigation_launch.py
    # launches, minus velocity_smoother and smoother_server.
    #
    # controller_server publishes directly to /cmd_vel (no remapping)
    # because there is no velocity_smoother intermediary.

    controller_server_node = Node(
        package='nav2_controller',
        executable='controller_server',
        name='controller_server',
        output='screen',
        respawn=False,
        respawn_delay=2.0,
        parameters=[nav2_params],
        arguments=['--ros-args', '--log-level', log_level],
        remappings=remappings,
    )

    planner_server_node = Node(
        package='nav2_planner',
        executable='planner_server',
        name='planner_server',
        output='screen',
        respawn=False,
        respawn_delay=2.0,
        parameters=[nav2_params],
        arguments=['--ros-args', '--log-level', log_level],
        remappings=remappings,
    )

    behavior_server_node = Node(
        package='nav2_behaviors',
        executable='behavior_server',
        name='behavior_server',
        output='screen',
        respawn=False,
        respawn_delay=2.0,
        parameters=[nav2_params],
        arguments=['--ros-args', '--log-level', log_level],
        remappings=remappings,
    )

    bt_navigator_node = Node(
        package='nav2_bt_navigator',
        executable='bt_navigator',
        name='bt_navigator',
        output='screen',
        respawn=False,
        respawn_delay=2.0,
        parameters=[nav2_params],
        arguments=['--ros-args', '--log-level', log_level],
        remappings=remappings,
    )

    waypoint_follower_node = Node(
        package='nav2_waypoint_follower',
        executable='waypoint_follower',
        name='waypoint_follower',
        output='screen',
        respawn=False,
        respawn_delay=2.0,
        parameters=[nav2_params],
        arguments=['--ros-args', '--log-level', log_level],
        remappings=remappings,
    )

    # Lifecycle manager manages only the nodes we actually launched.
    # velocity_smoother and smoother_server are intentionally excluded —
    # see module docstring.
    lifecycle_nodes_without_smoother = [
        'controller_server',
        'planner_server',
        'behavior_server',
        'bt_navigator',
        'waypoint_follower',
    ]

    lifecycle_manager_node = Node(
        package='nav2_lifecycle_manager',
        executable='lifecycle_manager',
        name='lifecycle_manager_navigation',
        output='screen',
        arguments=['--ros-args', '--log-level', log_level],
        parameters=[{
            'use_sim_time': use_sim_time,
            'autostart': autostart,
            'node_names': lifecycle_nodes_without_smoother,
            'bond_timeout': 4.0,
            'attempt_respawn_reconnection': True,
            'bond_respawn_max_duration': 10.0,
        }],
    )

    # ── Assemble ─────────────────────────────────────────────────────────
    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false',
                              description='Use simulation time'),
        DeclareLaunchArgument('autostart', default_value='true',
                              description='Automatically start Nav2 lifecycle nodes'),
        DeclareLaunchArgument('log_level', default_value='info',
                              description='Log level for Nav2 nodes'),

        # Cartographer SLAM
        cartographer_launch,

        # Nav2 navigation stack (no velocity_smoother)
        controller_server_node,
        planner_server_node,
        behavior_server_node,
        bt_navigator_node,
        waypoint_follower_node,
        lifecycle_manager_node,
    ])
