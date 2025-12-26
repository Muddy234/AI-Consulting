"""
Task Planner - AI-Powered Task Analysis and Planning
=====================================================
This module provides an intelligent planning layer that:
1. Analyzes user requests to understand intent
2. Breaks tasks into actionable steps
3. Anticipates potential issues and plans fallbacks
4. Defines clear success criteria
5. Sets appropriate timeouts and retry limits
6. Verifies results meet objectives

This sits between the user's request and the browser agent,
making the agent significantly smarter and more reliable.
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

# Use Google's generative AI directly for planning (simpler than browser_use's ChatGoogle)
import google.generativeai as genai

logger = logging.getLogger(__name__)


# ============================================
# Data Structures
# ============================================

class TaskType(Enum):
    """Types of tasks the agent can perform."""
    EMAIL_SYNC = "email_sync"
    SHOPPING = "shopping"
    RESERVATION = "reservation"
    RESEARCH = "research"
    PRICE_COMPARISON = "price_comparison"
    CUSTOM = "custom"


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
    verification: str  # How to verify this step succeeded
    on_failure: str  # What to do if this step fails


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
    clarifications: List[str]  # Any assumptions made

    # Success criteria
    success_criteria: List[str]
    partial_success_acceptable: bool

    # Execution plan
    steps: List[TaskStep]
    estimated_duration: str  # e.g., "2-5 minutes"

    # Risk management
    potential_issues: List[PotentialIssue]
    max_retries: int
    timeout_minutes: int

    # Failure handling
    on_complete_failure: str  # What to report if everything fails

    # Generated prompt for browser agent
    enhanced_prompt: str


# ============================================
# Task Planner Class
# ============================================

class TaskPlanner:
    """
    AI-powered task planner that analyzes requests and creates
    detailed execution plans for the browser agent.
    """

    def __init__(self):
        # Use Google's generative AI directly
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_API_KEY environment variable not set")

        # Configure the API key
        genai.configure(api_key=api_key)

        # Create the model
        self.model = genai.GenerativeModel("gemini-2.0-flash")

        # Planning prompt template
        self.planning_prompt = self._load_planning_prompt()

    def _load_planning_prompt(self) -> str:
        """Load the system prompt for task planning."""
        return """You are an expert task planner for a browser automation agent. Your job is to:
1. Understand what the user wants to accomplish
2. Break it down into clear, actionable steps
3. Anticipate what could go wrong
4. Plan fallback strategies
5. Define clear success criteria

You must respond with a valid JSON object (no markdown, no code blocks, just pure JSON).

The JSON must have this exact structure:
{
    "interpreted_goal": "What the user actually wants to achieve",
    "clarifications": ["Any assumptions you're making about the request"],
    "success_criteria": ["Specific, measurable criteria for success"],
    "partial_success_acceptable": true/false,
    "steps": [
        {
            "step_number": 1,
            "action": "What to do",
            "expected_outcome": "What should happen",
            "verification": "How to verify it worked",
            "on_failure": "What to do if it fails"
        }
    ],
    "estimated_duration": "X-Y minutes",
    "potential_issues": [
        {
            "issue": "What might go wrong",
            "likelihood": "low/medium/high",
            "solution": "How to handle it",
            "fallback_action": "Alternative approach if solution fails"
        }
    ],
    "max_retries": 3,
    "timeout_minutes": 5,
    "on_complete_failure": "What to report to user if everything fails"
}

IMPORTANT GUIDELINES:
- Be specific and actionable in your steps
- Anticipate real-world issues (login prompts, CAPTCHAs, out of stock, etc.)
- Set realistic timeouts based on task complexity
- Always have fallback strategies
- Success criteria should be measurable
- Consider the user's implicit preferences (quality, price, speed)
"""

    async def plan_task(self, user_request: str, task_type: Optional[TaskType] = None) -> TaskPlan:
        """
        Analyze a user request and create a detailed execution plan.

        Args:
            user_request: The raw request from the user
            task_type: Optional task type hint

        Returns:
            TaskPlan object with complete execution strategy
        """
        logger.info(f"Planning task: {user_request[:50]}...")

        # Detect task type if not provided
        if task_type is None:
            task_type = self._detect_task_type(user_request)

        # Get context based on task type
        context = self._get_task_context(task_type)

        # Build the planning request
        planning_request = f"""
{self.planning_prompt}

TASK CONTEXT:
{context}

USER REQUEST:
"{user_request}"

Create a detailed execution plan for this request. Remember to output ONLY valid JSON, no other text.
"""

        try:
            # Call Gemini to create the plan
            response = await self.model.generate_content_async(planning_request)
            plan_json = self._parse_json_response(response.text)

            # Create TaskPlan object
            task_plan = self._build_task_plan(
                plan_json=plan_json,
                original_request=user_request,
                task_type=task_type
            )

            # Generate the enhanced prompt for the browser agent
            task_plan.enhanced_prompt = self._generate_enhanced_prompt(task_plan)

            logger.info(f"Task plan created with {len(task_plan.steps)} steps")
            return task_plan

        except Exception as e:
            logger.error(f"Error creating task plan: {e}")
            # Return a basic plan as fallback
            return self._create_fallback_plan(user_request, task_type, str(e))

    def _detect_task_type(self, request: str) -> TaskType:
        """Detect the type of task from the request."""
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

    def _get_task_context(self, task_type: TaskType) -> str:
        """Get relevant context for the task type."""
        contexts = {
            TaskType.EMAIL_SYNC: """
This is an EMAIL/CALENDAR task using Outlook Web (outlook.office.com).
- User has 3 inboxes: Main, Becky, Tyler
- Must use Filter > Flagged to find flagged emails
- Creates ONE calendar event "🤖 {To-Do List}" for tomorrow at 7 AM
- Must READ each email to understand context
- Browser is pre-authenticated (no login needed)
""",
            TaskType.SHOPPING: """
This is a SHOPPING task, typically on Amazon.
- User wants to ADD TO CART (not complete purchase) unless specified
- Consider: price limits, ratings (4+ stars preferred), Prime eligibility
- Browser is pre-authenticated (no login needed)
- If item not found, suggest alternatives
- Watch for: out of stock, price changes, wrong item variants
""",
            TaskType.RESERVATION: """
This is a RESTAURANT RESERVATION task using OpenTable.
- Need: restaurant/cuisine, date, time, party size
- Browser is pre-authenticated (no login needed)
- If exact time unavailable, find closest available
- Confirm all details before completing
- Watch for: no availability, wrong date format, restaurant closed
""",
            TaskType.RESEARCH: """
This is a RESEARCH task using web search.
- Goal is to gather information and compile a report
- Use multiple sources (3+) for credibility
- Distinguish facts from opinions
- Cite all sources
- Watch for: outdated info, unreliable sources, paywalls
""",
            TaskType.PRICE_COMPARISON: """
This is a PRICE COMPARISON task across multiple sites.
- Sites to check: Amazon, Walmart, Target, Best Buy
- Include shipping costs in total
- Note any special deals or coupons
- Compare equivalent products (same model/specs)
- Watch for: different variants, refurbished vs new
""",
            TaskType.CUSTOM: """
This is a CUSTOM task that doesn't fit standard categories.
- Analyze carefully what the user wants
- Break into logical steps
- Be extra careful about assumptions
- Ask for clarification if truly ambiguous
"""
        }
        return contexts.get(task_type, contexts[TaskType.CUSTOM])

    def _parse_json_response(self, response_text: str) -> Dict:
        """Parse JSON from the model response."""
        # Clean up the response
        text = response_text.strip()

        # Remove markdown code blocks if present
        if text.startswith('```'):
            lines = text.split('\n')
            # Remove first and last lines (```json and ```)
            text = '\n'.join(lines[1:-1])

        # Try to parse JSON
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            logger.warning(f"JSON parse error: {e}")
            # Try to find JSON in the text
            import re
            json_match = re.search(r'\{[\s\S]*\}', text)
            if json_match:
                return json.loads(json_match.group())
            raise ValueError(f"Could not parse JSON from response: {text[:200]}")

    def _build_task_plan(self, plan_json: Dict, original_request: str, task_type: TaskType) -> TaskPlan:
        """Build a TaskPlan object from the JSON response."""
        import uuid

        # Parse steps
        steps = []
        for step_data in plan_json.get('steps', []):
            steps.append(TaskStep(
                step_number=step_data.get('step_number', len(steps) + 1),
                action=step_data.get('action', ''),
                expected_outcome=step_data.get('expected_outcome', ''),
                verification=step_data.get('verification', ''),
                on_failure=step_data.get('on_failure', 'Report error and continue')
            ))

        # Parse potential issues
        issues = []
        for issue_data in plan_json.get('potential_issues', []):
            issues.append(PotentialIssue(
                issue=issue_data.get('issue', ''),
                likelihood=issue_data.get('likelihood', 'medium'),
                solution=issue_data.get('solution', ''),
                fallback_action=issue_data.get('fallback_action')
            ))

        return TaskPlan(
            task_id=str(uuid.uuid4())[:8],
            task_type=task_type,
            original_request=original_request,
            timestamp=datetime.now().isoformat(),
            interpreted_goal=plan_json.get('interpreted_goal', original_request),
            clarifications=plan_json.get('clarifications', []),
            success_criteria=plan_json.get('success_criteria', []),
            partial_success_acceptable=plan_json.get('partial_success_acceptable', True),
            steps=steps,
            estimated_duration=plan_json.get('estimated_duration', '3-5 minutes'),
            potential_issues=issues,
            max_retries=plan_json.get('max_retries', 3),
            timeout_minutes=plan_json.get('timeout_minutes', 5),
            on_complete_failure=plan_json.get('on_complete_failure', 'Report detailed error to user'),
            enhanced_prompt=""  # Will be set after
        )

    def _generate_enhanced_prompt(self, plan: TaskPlan) -> str:
        """Generate an enhanced prompt for the browser agent based on the plan."""

        # Format steps
        steps_text = "\n".join([
            f"""
STEP {s.step_number}: {s.action}
   Expected: {s.expected_outcome}
   Verify by: {s.verification}
   If fails: {s.on_failure}
""" for s in plan.steps
        ])

        # Format potential issues
        issues_text = "\n".join([
            f"- {i.issue} ({i.likelihood} likelihood)\n  → Solution: {i.solution}" +
            (f"\n  → Fallback: {i.fallback_action}" if i.fallback_action else "")
            for i in plan.potential_issues
        ])

        # Format success criteria
        criteria_text = "\n".join([f"✓ {c}" for c in plan.success_criteria])

        prompt = f"""
MISSION: {plan.interpreted_goal}

AUTHENTICATION: You are using a pre-authenticated browser session. DO NOT attempt to log in.

=== SUCCESS CRITERIA ===
{criteria_text}

=== EXECUTION PLAN ===
{steps_text}

=== POTENTIAL ISSUES & SOLUTIONS ===
{issues_text}

=== CONSTRAINTS ===
- Maximum retries per step: {plan.max_retries}
- Total timeout: {plan.timeout_minutes} minutes
- Partial success acceptable: {"Yes" if plan.partial_success_acceptable else "No"}

=== IF EVERYTHING FAILS ===
{plan.on_complete_failure}

=== IMPORTANT RULES ===
✅ Follow the steps in order
✅ Verify each step before proceeding
✅ Use fallback strategies when primary approach fails
✅ Report progress and any issues encountered
❌ DO NOT exceed timeout
❌ DO NOT retry more than {plan.max_retries} times per step
❌ DO NOT continue if a critical step fails without a fallback

Begin execution now.
"""
        return prompt

    def _create_fallback_plan(self, request: str, task_type: TaskType, error: str) -> TaskPlan:
        """Create a basic fallback plan when planning fails."""
        import uuid

        return TaskPlan(
            task_id=str(uuid.uuid4())[:8],
            task_type=task_type,
            original_request=request,
            timestamp=datetime.now().isoformat(),
            interpreted_goal=request,
            clarifications=[f"Planning failed, using basic execution: {error}"],
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

Execute this task to the best of your ability. Report any issues encountered.

Begin now.
"""
        )

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

    def plan_to_dict(self, plan: TaskPlan) -> Dict:
        """Convert a TaskPlan to a dictionary for serialization."""
        return {
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

**Steps:**
"""
    for step in plan.steps:
        description += f"{step.step_number}. {step.action}\n"

    description += f"""
**Success Criteria:**
"""
    for criterion in plan.success_criteria:
        description += f"✓ {criterion}\n"

    description += f"""
**Estimated Time:** {plan.estimated_duration}
**Max Retries:** {plan.max_retries}

**Potential Issues:**
"""
    for issue in plan.potential_issues[:3]:  # Show top 3
        description += f"⚠️ {issue.issue} → {issue.solution}\n"

    return description


# ============================================
# CLI Testing
# ============================================

if __name__ == "__main__":
    import asyncio

    async def test_planner():
        planner = TaskPlanner()

        test_requests = [
            "Buy a good USB-C cable for my MacBook under $20",
            "Book a table at a nice Italian restaurant for 2 people tomorrow at 7pm",
            "Sync my flagged emails to the calendar",
            "Research the best CRM software for small businesses",
        ]

        for request in test_requests:
            print(f"\n{'='*60}")
            print(f"Request: {request}")
            print('='*60)

            plan = await planner.plan_task(request)

            print(f"\nGoal: {plan.interpreted_goal}")
            print(f"Type: {plan.task_type.value}")
            print(f"Duration: {plan.estimated_duration}")
            print(f"\nSteps:")
            for step in plan.steps:
                print(f"  {step.step_number}. {step.action}")
            print(f"\nSuccess Criteria:")
            for c in plan.success_criteria:
                print(f"  ✓ {c}")
            print(f"\nPotential Issues:")
            for issue in plan.potential_issues:
                print(f"  ⚠️ {issue.issue} ({issue.likelihood})")
                print(f"     → {issue.solution}")

    asyncio.run(test_planner())
