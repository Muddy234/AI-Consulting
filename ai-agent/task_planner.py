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
6. BUILD IN SELF-CORRECTION CHECKPOINTS

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

CRITICAL GUIDELINES FOR EFFECTIVE SEARCHING:

1. ALWAYS USE SPECIFIC SEARCH TERMS:
   - BAD: Go to r/booksuggestions and browse
   - GOOD: Search Google for "books like [SPECIFIC ITEM] site:reddit.com"
   - When searching ANY site, ALWAYS include the specific item name in the search query
   - Never just browse a general category - always search with specifics

2. TARGETED VS GENERAL SEARCHES:
   - Use Google site-specific searches: "topic site:reddit.com" or "topic site:goodreads.com"
   - When on a site, use its search function WITH the specific item name
   - Prefer subreddits specific to the topic (e.g., r/litrpg for LitRPG books, r/fantasy for fantasy)

3. SELF-CORRECTION CHECKPOINTS (CRITICAL):
   - After every 2-3 actions, ADD A CHECKPOINT STEP to verify progress
   - If scrolling more than 2 times without finding relevant content, STOP and re-evaluate
   - Checkpoint template: "CHECKPOINT: Verify current page shows results for [SPECIFIC ITEM]. If not, use fallback search."

4. RE-EVALUATION TRIGGERS:
   - If search results don't mention the specific item, STOP and try a different search
   - If a page seems generic/unrelated, don't keep scrolling - go back and refine the search
   - Use Google as the universal fallback: search "[specific item] recommendations site:[current site]"

5. PARSING USER REQUESTS (CRITICAL):
   - Extract ONLY the item/product/book name from the request
   - IGNORE conversational fluff: "Thanks", "Please", "Can you", "Hi", "Hey", etc.
   - Example: "Thanks. Add He Who Fights With Monsters to cart"
     → Item = "He Who Fights With Monsters" (NOT "Thanks. He Who Fights With Monsters")

6. SCOPE - DO ONLY WHAT WAS ASKED:
   - Complete the requested task and STOP
   - Do NOT add bonus features, recommendations, or extra suggestions
   - If asked to "add to cart" → add to cart, confirm, done
   - If asked to "research" → research, summarize, done
   - Keep responses focused and minimal

7. OTHER GUIDELINES:
   - Be specific and actionable in your steps
   - Anticipate real-world issues (login prompts, CAPTCHAs, out of stock, etc.)
   - Set realistic timeouts based on task complexity
   - Always have fallback strategies
   - Success criteria should be measurable
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

PARSING THE ITEM NAME (CRITICAL):
- Extract ONLY the product/book name from the request
- IGNORE conversational words like: "Thanks", "Please", "Can you", "Hi", "Hey"
- Example: "Thanks. Can you add He Who Fights With Monsters to my cart?"
  → Item name is: "He Who Fights With Monsters" (NOT "Thanks. He Who Fights With Monsters")

SCOPE - DO ONLY WHAT WAS ASKED:
- If asked to "add to cart" → just add to cart, done
- If asked to "find" → find and report, done
- Do NOT provide recommendations unless specifically asked
- Do NOT add extra features or suggestions
- Keep it simple - complete the task and stop

TASK RULES:
- User wants to ADD TO CART (not complete purchase) unless specified
- Consider: price limits, ratings (4+ stars preferred), Prime eligibility
- Browser is pre-authenticated (no login needed)
- If item not found, suggest alternatives
- Watch for: out of stock, price changes, wrong item variants

OUTPUT FORMAT:
- Just confirm the action: "✅ [Item Name] added to cart"
- No extra recommendations or suggestions unless asked
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

*** TWO-STEP RESEARCH PROCESS (CRITICAL) ***

STEP 1 - GATHER RECOMMENDATIONS:
- Search Reddit/forums/Goodreads for recommendations
- Extract just the TITLES of recommended items
- Reddit usernames are NOT authors - ignore them
- Focus on finding WHAT is recommended, not WHO recommended it

STEP 2 - RESEARCH EACH ITEM:
- For each title found, search Google/Amazon/Wikipedia for REAL info
- Find the ACTUAL author/creator (not Reddit usernames!)
- Get a brief description of what it is
- Understand WHY it would appeal to fans of the original item

EXAMPLE - If searching "books like Dungeon Crawler Carl":
1. Find titles: "He Who Fights Monsters", "Cradle", etc.
2. Research each: "He Who Fights Monsters" → Author: Shirtaloon, LitRPG with humor
3. Explain fit: "Similar comedic tone and progression mechanics"

CRITICAL RULES:
- NEVER use Reddit usernames as authors
- ALWAYS verify author names from Amazon/Goodreads
- Explain WHY each recommendation fits, not just list them

SEARCH STRATEGY:
- Use Google site-specific searches: "[topic] site:reddit.com"
- Use niche subreddits (r/litrpg, r/fantasy) NOT general ones
- After finding titles, search "[Book Title] author" to verify

GENERAL:
- Goal is to provide useful recommendations with context
- Explain why each item would appeal to the user
- Keep final output SHORT and actionable
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

    def _get_output_format(self, task_type: TaskType) -> str:
        """Get task-type specific output format instructions."""
        formats = {
            TaskType.SHOPPING: """
=== REQUIRED OUTPUT FORMAT (CRITICAL) ===
Your FINAL response must be SHORT and confirm the action:

✅ [Action completed] - [Item name]

EXAMPLES:
- "✅ Added to cart - He Who Fights With Monsters"
- "✅ Removed from cart - He Who Fights With Monsters"
- "✅ Item not found in cart"

RULES:
- Just confirm what was done in ONE sentence
- NO recommendations unless asked
- NO extra information
- Complete the task and STOP
""",
            TaskType.RESEARCH: """
=== REQUIRED OUTPUT FORMAT (CRITICAL) ===
Your FINAL response must be a SHORT, CONCISE summary:

📚 **Recommendations for [Original Item] fans:**

• **[Title]** by [REAL Author]
  [1-2 sentences: what it is + why it fits]

RULES:
- REAL author names only (NOT Reddit usernames)
- Explain WHY it appeals to fans
- Maximum 2 sentences per item
- NO raw data or attachments
""",
            TaskType.RESERVATION: """
=== REQUIRED OUTPUT FORMAT (CRITICAL) ===
Your FINAL response must confirm the reservation:

✅ Reservation confirmed:
- Restaurant: [Name]
- Date/Time: [Date and Time]
- Party size: [Number]
- Confirmation #: [If available]

RULES:
- Just confirm the details
- NO extra suggestions
""",
            TaskType.EMAIL_SYNC: """
=== REQUIRED OUTPUT FORMAT (CRITICAL) ===
Your FINAL response must summarize what was done:

✅ Email sync complete:
- [Number] flagged emails processed
- Calendar event created for [date]

RULES:
- Brief summary only
- List key actions taken
""",
        }
        return formats.get(task_type, """
=== REQUIRED OUTPUT FORMAT (CRITICAL) ===
Your FINAL response must be SHORT and confirm what was done.
Just state the action completed in 1-2 sentences.
NO extra information or suggestions.
""")

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

        # Task-type specific output format
        output_format = self._get_output_format(plan.task_type)

        prompt = f"""
MISSION: {plan.interpreted_goal}

AUTHENTICATION: You are using a pre-authenticated browser session. DO NOT attempt to log in.

{output_format}


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
✅ When task is COMPLETE, use "done" action immediately - do NOT continue
✅ Keep output SHORT - confirm action and stop
❌ DO NOT exceed timeout
❌ DO NOT retry more than {plan.max_retries} times per step
❌ DO NOT add extra features or recommendations unless asked
❌ DO NOT continue after the task is complete

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
