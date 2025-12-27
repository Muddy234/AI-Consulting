"""
Task Planner - AI-Powered Task Analysis and Planning
=====================================================
This module provides an intelligent planning layer that:
1. Uses the Orchestrator to select and coordinate specialist agents
2. Generates detailed execution plans from agent profiles
3. Creates enhanced prompts for browser automation
4. Verifies results meet objectives

This is the main interface for planning - it wraps the Orchestrator
and provides backward-compatible methods.
"""

import os
import sys
import json
import logging
import asyncio
from datetime import datetime
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
from enum import Enum

# Load environment variables from .env file FIRST
from pathlib import Path
from dotenv import load_dotenv

# Get the directory where this script is located
SCRIPT_DIR = Path(__file__).parent.resolve()
ENV_FILE = SCRIPT_DIR / ".env"

# Load .env from the script's directory
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)
else:
    load_dotenv()  # Try default locations

# Fix Windows encoding
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import google.generativeai as genai

# Import new orchestrator and agent system
from orchestrator import Orchestrator, UnifiedPlan, Intent, Topic, BrowserPhase
from agent_loader import AgentLoader

logger = logging.getLogger(__name__)


# ============================================
# Data Structures (kept for backward compatibility)
# ============================================

class TaskType(Enum):
    """Types of tasks the agent can perform."""
    EMAIL_SYNC = "email_sync"
    SHOPPING = "shopping"
    RESERVATION = "reservation"
    RESEARCH = "research"
    PRICE_COMPARISON = "price_comparison"
    CUSTOM = "custom"


# Map TaskType to Topic for orchestrator
TASK_TYPE_TO_TOPIC = {
    TaskType.EMAIL_SYNC: Topic.EMAIL,
    TaskType.SHOPPING: Topic.PRODUCTS,
    TaskType.RESERVATION: Topic.FOOD,
    TaskType.RESEARCH: Topic.GENERAL,
    TaskType.PRICE_COMPARISON: Topic.PRODUCTS,
    TaskType.CUSTOM: Topic.GENERAL,
}


@dataclass
class PotentialIssue:
    """A potential issue that might occur during task execution."""
    issue: str
    likelihood: str  # "low", "medium", "high"
    solution: str
    fallback_action: Optional[str] = None


@dataclass
class TaskStep:
    """A single step in the task execution plan."""
    step_number: int
    action: str
    expected_outcome: str
    verification: str
    on_failure: str


@dataclass
class TaskPlan:
    """Complete plan for executing a task."""
    # Task identification
    task_id: str
    task_type: TaskType
    original_request: str
    timestamp: str

    # Understanding
    interpreted_goal: str
    clarifications: List[str]

    # Success criteria
    success_criteria: List[str]
    partial_success_acceptable: bool

    # Execution plan
    steps: List[TaskStep]
    estimated_duration: str

    # Risk management
    potential_issues: List[PotentialIssue]
    max_retries: int
    timeout_minutes: int

    # Failure handling
    on_complete_failure: str

    # Generated prompt for browser agent
    enhanced_prompt: str

    # New: Reference to unified plan if available
    unified_plan: Optional[UnifiedPlan] = None


# ============================================
# Task Planner Class
# ============================================

class TaskPlanner:
    """
    AI-powered task planner that uses the Orchestrator
    to coordinate specialist agents and create execution plans.
    """

    def __init__(self):
        # Use Google's generative AI for verification and summary
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_API_KEY environment variable not set")

        genai.configure(api_key=api_key)

        # Model selection for summary/verification: Gemini 2.5 Flash
        # Browser automation uses 2.0 Flash (configured in agent_tasks.py)
        self.model = genai.GenerativeModel("gemini-2.5-flash")

        # Initialize orchestrator (also uses Gemini 2.5 Flash for classification/research)
        self.orchestrator = Orchestrator()

        # Load agent profiles for reference
        self.agent_loader = AgentLoader()

    async def plan_task(self, user_request: str, task_type: Optional[TaskType] = None) -> TaskPlan:
        """
        Analyze a user request and create a detailed execution plan.

        Uses the Orchestrator to:
        1. Classify intent and topic
        2. Select appropriate specialist agents
        3. Generate sub-plans from each agent
        4. Aggregate into unified execution plan

        Args:
            user_request: The raw request from the user
            task_type: Optional task type hint (for backward compatibility)

        Returns:
            TaskPlan object with complete execution strategy
        """
        logger.info(f"Planning task: {user_request[:50]}...")

        try:
            # Use orchestrator for the heavy lifting
            unified_plan = await self.orchestrator.process_request(user_request)

            # Convert to TaskPlan format for backward compatibility
            task_plan = self._unified_to_task_plan(unified_plan, task_type)

            logger.info(f"Task plan created with {len(task_plan.steps)} steps using agents: {unified_plan.agents_used}")
            return task_plan

        except Exception as e:
            logger.error(f"Orchestrator failed, using fallback: {e}")
            # Fall back to simple planning
            if task_type is None:
                task_type = self._detect_task_type(user_request)
            return await self._create_fallback_plan(user_request, task_type, str(e))

    def _unified_to_task_plan(self, unified: UnifiedPlan, task_type_hint: Optional[TaskType] = None) -> TaskPlan:
        """Convert a UnifiedPlan to TaskPlan for backward compatibility."""

        # Determine task type from topic or hint
        if task_type_hint:
            task_type = task_type_hint
        else:
            topic_to_task = {
                Topic.EMAIL: TaskType.EMAIL_SYNC,
                Topic.FOOD: TaskType.RESERVATION if unified.intent == Intent.ACTION else TaskType.RESEARCH,
                Topic.PRODUCTS: TaskType.SHOPPING if unified.intent == Intent.ACTION else TaskType.PRICE_COMPARISON,
                Topic.BOOKS: TaskType.SHOPPING if unified.intent == Intent.ACTION else TaskType.RESEARCH,
                Topic.TECH: TaskType.SHOPPING if unified.intent == Intent.ACTION else TaskType.RESEARCH,
                Topic.TRAVEL: TaskType.RESEARCH,
                Topic.GENERAL: TaskType.RESEARCH,
            }
            task_type = topic_to_task.get(unified.topic, TaskType.CUSTOM)

        # Extract steps from execution phases
        steps = []
        step_num = 1
        for phase in unified.execution_phases:
            for step_data in phase.get('steps', []):
                steps.append(TaskStep(
                    step_number=step_num,
                    action=step_data.get('action', ''),
                    expected_outcome=step_data.get('expected_outcome', ''),
                    verification=step_data.get('verification', ''),
                    on_failure=step_data.get('on_failure', 'Report error and continue')
                ))
                step_num += 1

        # Extract potential issues from checkpoints
        potential_issues = []
        for checkpoint in unified.verification_checkpoints:
            potential_issues.append(PotentialIssue(
                issue=f"Failure at checkpoint: {checkpoint.get('check', '')}",
                likelihood="medium",
                solution=checkpoint.get('on_failure', 'Retry with alternative'),
                fallback_action=None
            ))

        return TaskPlan(
            task_id=unified.task_id,
            task_type=task_type,
            original_request=unified.original_request,
            timestamp=datetime.now().isoformat(),
            interpreted_goal=unified.original_request,
            clarifications=[f"Using agents: {', '.join(unified.agents_used)}"],
            success_criteria=unified.success_criteria,
            partial_success_acceptable=True,
            steps=steps,
            estimated_duration=unified.estimated_duration,
            potential_issues=potential_issues,
            max_retries=unified.max_retries,
            timeout_minutes=unified.timeout_minutes,
            on_complete_failure="Report detailed error with what was attempted",
            enhanced_prompt=unified.executor_prompt,
            unified_plan=unified
        )

    def _detect_task_type(self, request: str) -> TaskType:
        """Detect the type of task from the request (fallback method)."""
        request_lower = request.lower()

        if any(word in request_lower for word in ['email', 'inbox', 'flagged', 'todo', 'calendar']):
            return TaskType.EMAIL_SYNC
        elif any(word in request_lower for word in ['buy', 'purchase', 'order', 'amazon', 'cart', 'shop']):
            return TaskType.SHOPPING
        elif any(word in request_lower for word in ['reserve', 'reservation', 'book', 'table', 'restaurant', 'opentable']):
            return TaskType.RESERVATION
        elif any(word in request_lower for word in ['research', 'find out', 'learn', 'investigate', 'look up']):
            return TaskType.RESEARCH
        elif any(word in request_lower for word in ['compare', 'price', 'cheapest', 'best deal']):
            return TaskType.PRICE_COMPARISON
        else:
            return TaskType.CUSTOM

    async def _create_fallback_plan(self, request: str, task_type: TaskType, error: str) -> TaskPlan:
        """Create a basic fallback plan when orchestrator fails."""
        import uuid

        # Try to get relevant agent profile for context
        topic = TASK_TYPE_TO_TOPIC.get(task_type, Topic.GENERAL)
        context = self._get_fallback_context(task_type)

        return TaskPlan(
            task_id=str(uuid.uuid4())[:8],
            task_type=task_type,
            original_request=request,
            timestamp=datetime.now().isoformat(),
            interpreted_goal=request,
            clarifications=[f"Using fallback planning: {error}"],
            success_criteria=["Complete the requested task"],
            partial_success_acceptable=True,
            steps=[TaskStep(
                step_number=1,
                action=f"Execute: {request}",
                expected_outcome="Task completed",
                verification="User confirms success",
                on_failure="Report error to user"
            )],
            estimated_duration="5-10 minutes",
            potential_issues=[],
            max_retries=3,
            timeout_minutes=10,
            on_complete_failure="Report that the task could not be completed and explain why",
            enhanced_prompt=f"""
MISSION: {request}

AUTHENTICATION: You are using a pre-authenticated browser session. DO NOT attempt to log in.

{context}

Execute this task to the best of your ability. Report any issues encountered.

Begin now.
""",
            unified_plan=None
        )

    def _get_fallback_context(self, task_type: TaskType) -> str:
        """Get context for fallback plans."""
        contexts = {
            TaskType.EMAIL_SYNC: """
CONTEXT: Email/Calendar sync using Outlook Web.
- Check all inboxes for flagged emails
- Create calendar event with action items
- Browser is pre-authenticated
""",
            TaskType.SHOPPING: """
CONTEXT: Shopping task (likely Amazon).
- Search for the item
- Check ratings and price
- Add to cart only (don't purchase)
- Browser is pre-authenticated
""",
            TaskType.RESERVATION: """
CONTEXT: Restaurant reservation (likely OpenTable).
- Search for restaurant
- Check availability for date/time/party size
- Complete booking
- Browser is pre-authenticated
""",
            TaskType.RESEARCH: """
CONTEXT: Web research task.
- Use Google to find relevant sources
- Extract key information
- Provide structured summary
""",
            TaskType.PRICE_COMPARISON: """
CONTEXT: Price comparison across sites.
- Check multiple retailers
- Compare equivalent products
- Include shipping costs
""",
        }
        return contexts.get(task_type, "Execute the task carefully and report results.")

    async def verify_result(self, plan: TaskPlan, result: str) -> Dict[str, Any]:
        """
        Verify if the task result meets the success criteria.

        Args:
            plan: The original task plan
            result: The result from the browser agent

        Returns:
            Dict with verification status and details
        """
        verification_prompt = f"""
You are verifying if a task was completed successfully.

ORIGINAL GOAL:
{plan.interpreted_goal}

SUCCESS CRITERIA:
{chr(10).join(['- ' + c for c in plan.success_criteria])}

AGENTS USED:
{', '.join(plan.unified_plan.agents_used) if plan.unified_plan else 'Standard execution'}

TASK RESULT:
{result}

Analyze if the success criteria were met. Respond with JSON only:
{{
    "success": true/false,
    "criteria_met": ["list of criteria that were met"],
    "criteria_not_met": ["list of criteria that were NOT met"],
    "confidence": "high/medium/low",
    "summary": "Brief summary of what was accomplished",
    "suggestions": ["Any suggestions for improvement or next steps"]
}}
"""

        try:
            response = await self.model.generate_content_async(verification_prompt)
            return self._parse_json_response(response.text)
        except Exception as e:
            logger.error(f"Verification failed: {e}")
            return {
                "success": None,
                "error": str(e),
                "summary": "Could not verify result automatically"
            }

    def _parse_json_response(self, response_text: str) -> Dict:
        """Parse JSON from the model response."""
        text = response_text.strip()

        # Remove markdown code blocks if present
        if text.startswith('```'):
            lines = text.split('\n')
            text = '\n'.join(lines[1:-1])

        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            logger.warning(f"JSON parse error: {e}")
            import re
            json_match = re.search(r'\{[\s\S]*\}', text)
            if json_match:
                return json.loads(json_match.group())
            raise ValueError(f"Could not parse JSON from response: {text[:200]}")

    def plan_to_dict(self, plan: TaskPlan) -> Dict:
        """Convert a TaskPlan to a dictionary for serialization."""
        result = {
            "task_id": plan.task_id,
            "task_type": plan.task_type.value,
            "original_request": plan.original_request,
            "timestamp": plan.timestamp,
            "interpreted_goal": plan.interpreted_goal,
            "clarifications": plan.clarifications,
            "success_criteria": plan.success_criteria,
            "partial_success_acceptable": plan.partial_success_acceptable,
            "steps": [asdict(s) for s in plan.steps],
            "estimated_duration": plan.estimated_duration,
            "potential_issues": [asdict(i) for i in plan.potential_issues],
            "max_retries": plan.max_retries,
            "timeout_minutes": plan.timeout_minutes,
            "on_complete_failure": plan.on_complete_failure
        }

        # Add orchestrator info if available
        if plan.unified_plan:
            result["agents_used"] = plan.unified_plan.agents_used
            result["intent"] = plan.unified_plan.intent.value
            result["topic"] = plan.unified_plan.topic.value

        return result


# ============================================
# Convenience Functions
# ============================================

async def plan_and_describe(request: str) -> str:
    """
    Plan a task and return a human-readable description.
    Useful for previewing what the agent will do.
    """
    planner = TaskPlanner()
    plan = await planner.plan_task(request)

    description = f"""
📋 **Task Plan**

**Goal:** {plan.interpreted_goal}

"""

    # Show agents used if available
    if plan.unified_plan:
        description += f"**Agents:** {', '.join(plan.unified_plan.agents_used)}\n"
        description += f"**Intent:** {plan.unified_plan.intent.value} | **Topic:** {plan.unified_plan.topic.value}\n\n"

        # Show browser phases (new phased execution)
        if plan.unified_plan.browser_phases:
            description += "**Browser Phases:**\n"
            for phase in plan.unified_plan.browser_phases:
                phase_desc = {
                    BrowserPhase.DISCOVERY: "🔍 Discovery - Find targets and collect URLs",
                    BrowserPhase.EXTRACTION: "📋 Extraction - Get detailed info from pages",
                    BrowserPhase.ACTION: "⚡ Action - Execute the requested operation",
                    BrowserPhase.VERIFICATION: "✅ Verification - Confirm success"
                }.get(phase, f"📌 {phase.value}")
                description += f"  {phase_desc}\n"
            description += "\n"

    description += "**Steps:**\n"
    for step in plan.steps[:10]:  # Limit to first 10 steps for readability
        description += f"{step.step_number}. {step.action}\n"
    if len(plan.steps) > 10:
        description += f"... and {len(plan.steps) - 10} more steps\n"

    description += "\n**Success Criteria:**\n"
    for criterion in plan.success_criteria[:5]:
        description += f"✓ {criterion}\n"

    description += f"""
**Estimated Time:** {plan.estimated_duration}
**Max Retries:** {plan.max_retries}
"""

    if plan.potential_issues:
        description += "\n**Potential Issues:**\n"
        for issue in plan.potential_issues[:3]:
            description += f"⚠️ {issue.issue} → {issue.solution}\n"

    return description


# ============================================
# CLI Testing
# ============================================

if __name__ == "__main__":
    import asyncio

    logging.basicConfig(level=logging.INFO)

    async def test_planner():
        planner = TaskPlanner()

        test_requests = [
            "Buy a good USB-C cable for my MacBook under $20",
            "Book a table at a nice Italian restaurant for 2 people tomorrow at 7pm",
            "Sync my flagged emails to the calendar",
            "Research the best CRM software for small businesses",
            "Find books similar to The Name of the Wind and add the top pick to my cart",
        ]

        for request in test_requests:
            print(f"\n{'='*60}")
            print(f"Request: {request}")
            print('='*60)

            plan = await planner.plan_task(request)

            print(f"\nTask ID: {plan.task_id}")
            print(f"Type: {plan.task_type.value}")
            if plan.unified_plan:
                print(f"Intent: {plan.unified_plan.intent.value}")
                print(f"Topic: {plan.unified_plan.topic.value}")
                print(f"Agents: {plan.unified_plan.agents_used}")
            print(f"Duration: {plan.estimated_duration}")
            print(f"\nSteps ({len(plan.steps)}):")
            for step in plan.steps[:5]:  # Show first 5
                print(f"  {step.step_number}. {step.action[:60]}...")
            if len(plan.steps) > 5:
                print(f"  ... and {len(plan.steps) - 5} more steps")
            print(f"\nSuccess Criteria:")
            for c in plan.success_criteria[:3]:
                print(f"  ✓ {c}")

    asyncio.run(test_planner())
