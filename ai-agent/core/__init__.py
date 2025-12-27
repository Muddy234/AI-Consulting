"""
Core modules for the AI Agent system.

This package contains:
- orchestrator: Lead Agent that coordinates specialist agents
- task_planner: AI-powered task analysis and planning
- agent_loader: Loads agent profiles from markdown files
- agent_tasks: Browser automation executor
- task_executor: Modular task execution framework
"""

from .orchestrator import Orchestrator, UnifiedPlan, Intent, Topic, BrowserPhase
from .task_planner import TaskPlanner, TaskPlan, TaskType
from .agent_loader import AgentLoader, AgentProfile
from .agent_tasks import AgentTaskRunner, PhasedBrowserExecutor

__all__ = [
    'Orchestrator',
    'UnifiedPlan',
    'Intent',
    'Topic',
    'BrowserPhase',
    'TaskPlanner',
    'TaskPlan',
    'TaskType',
    'AgentLoader',
    'AgentProfile',
    'AgentTaskRunner',
    'PhasedBrowserExecutor',
]
