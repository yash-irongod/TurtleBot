import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration


def generate_launch_description():
    turtlebot3_cartographer_dir = get_package_share_directory('turtlebot3_cartographer')
    nav2_bringup_dir = get_package_share_directory('nav2_bringup')

    nav2_params = os.path.expanduser(
        '~/turtlebot3_ws/config/nav2_exploration_burger.yaml'
    )

    use_sim_time = LaunchConfiguration('use_sim_time', default='false')
    autostart = LaunchConfiguration('autostart', default='true')

    cartographer_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(turtlebot3_cartographer_dir, 'launch', 'cartographer.launch.py')
        ),
        launch_arguments={
            'use_sim_time': use_sim_time,
            'use_rviz': 'false',
        }.items(),
    )

    nav2_navigation_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(nav2_bringup_dir, 'launch', 'navigation_launch.py')
        ),
        launch_arguments={
            'namespace': '',
            'use_sim_time': use_sim_time,
            'autostart': autostart,
            'params_file': nav2_params,
            'use_composition': 'False',
            'use_respawn': 'False',
            'container_name': 'nav2_container',
            'log_level': 'info',
        }.items(),
    )

    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false', description='Use simulation time'),
        DeclareLaunchArgument('autostart', default_value='true', description='Automatically start Nav2'),
        cartographer_launch,
        nav2_navigation_launch,
    ])
