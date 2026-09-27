import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, TimerAction
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration


def generate_launch_description():
    frontier_exploration_dir = get_package_share_directory('frontier_exploration_ros2')

    frontier_params = os.path.expanduser(
        '~/turtlebot3_ws/config/frontier_burger.yaml'
    )

    use_sim_time = LaunchConfiguration('use_sim_time', default='false')

    frontier_explorer_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(frontier_exploration_dir, 'launch', 'frontier_explorer.launch.py')
        ),
        launch_arguments={
            'namespace': '',
            'params_file': frontier_params,
            'use_sim_time': use_sim_time,
            'autostart': 'true',
            'control_service_enabled': 'false',
            'map_qos_durability': 'transient_local',
            'map_qos_autodetect_on_startup': 'false',
            'map_qos_autodetect_timeout_s': '2.0',
            'costmap_qos_reliability': 'reliable',
            'log_level': 'info',
        }.items(),
    )

    # Keep frontier startup separate from Cartographer/Nav2 so stopping the explorer
    # does not tear down the mapping/navigation stack that manual mapping and goal
    # navigation continue to rely on.
    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false', description='Use simulation time'),
        TimerAction(period=15.0, actions=[frontier_explorer_launch]),
    ])
