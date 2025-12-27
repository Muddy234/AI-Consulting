"""
Orchestrator - Lead Agent Implementation
==========================================
This module implements the Lead Agent that:
1. Classifies user intent (RESEARCH, ACTION, HYBRID)
2. Detects topic (FOOD, TRAVEL, BOOKS, TECH, PRODUCTS, GENERAL)
3. Selects appropriate specialist agents
4. Invokes agents to generate sub-plans
5. Aggregates plans into unified execution plan
6. Passes to Executor for browser automation

Uses Gemini 2.0 Flash for all operations.
"""

import os
import sys
import json
import logging
import asyncio
from datetime import datetime
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

# Load environment variables
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).parent.resolve()
ENV_FILE = SCRIPT_DIR / ".env"

if ENV_FILE.exists():
    load_dotenv(ENV_FILE)
else:
    load_dotenv()

# Fix Windows encoding
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import google.generativeai as genai

from agent_loader import AgentLoader, AgentProfile

logger = logging.getLogger(__name__)


# ============================================
# Enums and Data Structures
# ============================================

class Intent(Enum):
    """User intent classification."""
    RESEARCH = "research"      # Information gathering only
    ACTION = "action"          # Execute a task (add to cart, reserve, etc.)
    HYBRID = "hybrid"          # Research then action

    @classmethod
    def from_value(cls, value: str) -> "Intent":
        """Look up enum member by value (case-insensitive)."""
        value_lower = value.lower().strip()
        for member in cls:
            if member.value == value_lower:
                return member
        return cls.RESEARCH  # Default fallback


class Topic(Enum):
    """Topic classification for agent selection."""
    FOOD = "food"              # Restaurants, dining, recipes
    TRAVEL = "travel"          # Hotels, destinations, trips
    BOOKS = "books"            # Books, reading, literature
    TECH = "tech"              # Electronics, gadgets, software
    PRODUCTS = "products"      # General shopping, products
    EMAIL = "email"            # Email and calendar
    LOCATION = "location"      # Address, hours, busy times, directions
    GENERAL = "general"        # Doesn't fit specific category

    @classmethod
    def from_value(cls, value: str) -> "Topic":
        """Look up enum member by value (case-insensitive)."""
        value_lower = value.lower().strip()
        for member in cls:
            if member.value == value_lower:
                return member
        return cls.GENERAL  # Default fallback


@dataclass
class AgentSelection:
    """Selected agents for a task."""
    research_agents: List[str] = field(default_factory=list)
    action_agents: List[str] = field(default_factory=list)
    google_always: bool = True  # Google research always runs first


@dataclass
class SubPlan:
    """Plan from a specialist agent."""
    agent_name: str
    agent_type: str  # 'research' or 'action'
    steps: List[Dict]
    output_format: Dict
    verification_signals: List[str]
    site_knowledge: Dict


@dataclass
class UnifiedPlan:
    """Aggregated plan from all agents."""
    task_id: str
    original_request: str
    intent: Intent
    topic: Topic

    # Agent orchestration
    agents_used: List[str]
    sub_plans: List[SubPlan]

    # Unified execution
    execution_phases: List[Dict]  # Ordered phases with steps
    success_criteria: List[str]
    verification_checkpoints: List[Dict]

    # Final prompt for executor
    executor_prompt: str

    # Metadata
    estimated_duration: str
    max_retries: int
    timeout_minutes: int


# ============================================
# Agent Selection Matrix
# ============================================

TOPIC_AGENT_MAP = {
    Topic.FOOD: {
        "research": ["google_research", "yelp_research", "google_maps"],
        "action": ["opentable_reserve"]
    },
    Topic.TRAVEL: {
        "research": ["google_research", "tripadvisor_research", "google_maps"],
        "action": []
    },
    Topic.BOOKS: {
        "research": ["google_research", "goodreads_research"],
        "action": ["amazon_cart"]
    },
    Topic.TECH: {
        "research": ["google_research", "wirecutter_research", "amazon_research"],
        "action": ["amazon_cart"]
    },
    Topic.PRODUCTS: {
        "research": ["google_research", "amazon_research", "google_maps"],
        "action": ["amazon_cart"]
    },
    Topic.EMAIL: {
        "research": [],
        "action": ["email_calendar"]
    },
    Topic.LOCATION: {
        "research": ["google_research", "google_maps"],
        "action": []
    },
    Topic.GENERAL: {
        "research": ["google_research"],
        "action": []
    }
}


# ============================================
# Orchestrator Class
# ============================================

class Orchestrator:
    """
    Lead Agent that orchestrates specialist agents.

    Flow:
    1. Parse user request
    2. Classify intent and topic
    3. Select appropriate agents
    4. Generate sub-plans from each agent
    5. Aggregate into unified plan
    6. Generate executor prompt
    """

    def __init__(self):
        # Configure Gemini
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_API_KEY environment variable not set")

        genai.configure(api_key=api_key)

        # Model selection:
        # - Orchestration/Research: Gemini 3.0 Flash
        # - Browser automation uses 2.0 Flash (configured in agent_tasks.py)
        self.model = genai.GenerativeModel("gemini-3-flash")

        # Load agent profiles
        self.agent_loader = AgentLoader()
        self.lead_agent_profile = self.agent_loader.load_agent("lead_agent")
        self.executor_profile = self.agent_loader.load_agent("executor")

    async def process_request(self, user_request: str) -> UnifiedPlan:
        """
        Main entry point - process a user request through the full pipeline.

        Args:
            user_request: The raw user request

        Returns:
            UnifiedPlan ready for executor
        """
        logger.info(f"Orchestrator processing: {user_request[:50]}...")

        # Phase 1: Classify
        intent, topic = await self._classify_request(user_request)
        logger.info(f"Classified as: Intent={intent.value}, Topic={topic.value}")

        # Phase 2: Select Agents
        selection = self._select_agents(intent, topic)
        logger.info(f"Selected agents: Research={selection.research_agents}, Action={selection.action_agents}")

        # Phase 3: Generate Sub-Plans
        sub_plans = await self._generate_sub_plans(user_request, selection, topic)
        logger.info(f"Generated {len(sub_plans)} sub-plans")

        # Phase 4: Aggregate into Unified Plan
        unified_plan = await self._aggregate_plans(
            user_request=user_request,
            intent=intent,
            topic=topic,
            selection=selection,
            sub_plans=sub_plans
        )

        return unified_plan

    async def _classify_request(self, request: str) -> Tuple[Intent, Topic]:
        """
        Classify the user request into intent and topic.
        Uses the Lead Agent's classification logic.
        """
        classification_prompt = f"""
{self.lead_agent_profile.system_prompt}

Classify this user request:
"{request}"

Respond with JSON only:
{{
    "intent": "research | action | hybrid",
    "topic": "food | travel | books | tech | products | email | location | general",
    "confidence": "high | medium | low",
    "reasoning": "Brief explanation of classification"
}}

TOPIC HINTS:
- location: hours, address, busy times, parking, "is it open", "how crowded"
"""

        try:
            response = await self.model.generate_content_async(classification_prompt)
            result = self._parse_json(response.text)

            # Handle case-insensitivity from LLM response using from_value
            intent_str = result.get("intent", "research")
            topic_str = result.get("topic", "general")

            intent = Intent.from_value(intent_str)
            topic = Topic.from_value(topic_str)

            return intent, topic

        except Exception as e:
            logger.warning(f"Classification failed, using defaults: {e}")
            return self._fallback_classification(request)

    def _fallback_classification(self, request: str) -> Tuple[Intent, Topic]:
        """Keyword-based fallback classification."""
        request_lower = request.lower()

        # Intent detection
        action_keywords = ['add to cart', 'buy', 'purchase', 'reserve', 'book',
                          'order', 'remove', 'delete', 'schedule', 'sync']
        research_keywords = ['find', 'search', 'recommend', 'best', 'top',
                            'compare', 'research', 'what is', 'where']

        has_action = any(kw in request_lower for kw in action_keywords)
        has_research = any(kw in request_lower for kw in research_keywords)

        if has_action and has_research:
            intent = Intent.HYBRID
        elif has_action:
            intent = Intent.ACTION
        else:
            intent = Intent.RESEARCH

        # Topic detection
        if any(w in request_lower for w in ['restaurant', 'food', 'eat', 'dinner', 'lunch', 'yelp', 'cuisine']):
            topic = Topic.FOOD
        elif any(w in request_lower for w in ['hotel', 'travel', 'trip', 'vacation', 'destination', 'flight']):
            topic = Topic.TRAVEL
        elif any(w in request_lower for w in ['book', 'read', 'author', 'novel', 'goodreads']):
            topic = Topic.BOOKS
        elif any(w in request_lower for w in ['phone', 'laptop', 'computer', 'electronics', 'tech', 'gadget']):
            topic = Topic.TECH
        elif any(w in request_lower for w in ['email', 'inbox', 'flagged', 'calendar', 'todo', 'outlook']):
            topic = Topic.EMAIL
        elif any(w in request_lower for w in ['hours', 'open', 'closed', 'busy', 'crowded', 'wait time',
                                               'address', 'location', 'directions', 'parking', 'near me',
                                               'how busy', 'is it open', 'what time']):
            topic = Topic.LOCATION
        elif any(w in request_lower for w in ['buy', 'purchase', 'amazon', 'product', 'cart']):
            topic = Topic.PRODUCTS
        else:
            topic = Topic.GENERAL

        return intent, topic

    def _select_agents(self, intent: Intent, topic: Topic) -> AgentSelection:
        """
        Select agents based on intent and topic.
        Uses the TOPIC_AGENT_MAP matrix.
        """
        selection = AgentSelection()

        agent_map = TOPIC_AGENT_MAP.get(topic, TOPIC_AGENT_MAP[Topic.GENERAL])

        # Research agents
        if intent in [Intent.RESEARCH, Intent.HYBRID]:
            selection.research_agents = agent_map.get("research", ["google_research"])
            # Ensure google_research is always first
            if "google_research" not in selection.research_agents:
                selection.research_agents.insert(0, "google_research")

        # Action agents
        if intent in [Intent.ACTION, Intent.HYBRID]:
            selection.action_agents = agent_map.get("action", [])

        return selection

    async def _generate_sub_plans(
        self,
        request: str,
        selection: AgentSelection,
        topic: Topic
    ) -> List[SubPlan]:
        """
        Generate plans from each selected agent.
        Runs research agents first, then action agents.
        """
        sub_plans = []

        # Research agents first (can run in parallel conceptually, but sequential for simplicity)
        for agent_name in selection.research_agents:
            try:
                profile = self.agent_loader.load_agent(agent_name, "research")
                sub_plan = await self._generate_agent_plan(request, profile, "research", topic)
                sub_plans.append(sub_plan)
            except Exception as e:
                logger.warning(f"Failed to generate plan for {agent_name}: {e}")

        # Action agents
        for agent_name in selection.action_agents:
            try:
                profile = self.agent_loader.load_agent(agent_name, "action")
                sub_plan = await self._generate_agent_plan(request, profile, "action", topic)
                sub_plans.append(sub_plan)
            except Exception as e:
                logger.warning(f"Failed to generate plan for {agent_name}: {e}")

        return sub_plans

    async def _generate_agent_plan(
        self,
        request: str,
        profile: AgentProfile,
        agent_type: str,
        topic: Topic
    ) -> SubPlan:
        """
        Generate a plan from a single agent using its profile.
        """
        # Build context from profile
        site_knowledge_text = json.dumps(profile.site_knowledge, indent=2) if profile.site_knowledge else "None"
        examples_text = json.dumps(profile.examples[:2], indent=2) if profile.examples else "None"

        planning_prompt = f"""
You are the {profile.name} specialist.

{profile.system_prompt}

SITE KNOWLEDGE:
{site_knowledge_text}

EXAMPLES:
{examples_text}

DECISION TREES:
{profile.decision_trees}

USER REQUEST:
"{request}"

Create a detailed execution plan for YOUR SPECIFIC responsibility in this task.
Remember your MECE boundary: {profile.mece_boundary}

Respond with JSON only:
{{
    "steps": [
        {{
            "step_number": 1,
            "action": "What to do",
            "expected_outcome": "What should happen",
            "verification": "How to verify success",
            "site_elements": "Relevant selectors/elements to use"
        }}
    ],
    "output_format": {{
        "format_description": "How output should be structured",
        "key_fields": ["field1", "field2"]
    }},
    "verification_signals": ["Signal 1 for success", "Signal 2 for success"],
    "estimated_steps": "X-Y browser actions"
}}
"""

        try:
            response = await self.model.generate_content_async(planning_prompt)
            result = self._parse_json(response.text)

            return SubPlan(
                agent_name=profile.name,
                agent_type=agent_type,
                steps=result.get("steps", []),
                output_format=result.get("output_format", {}),
                verification_signals=result.get("verification_signals", []),
                site_knowledge=profile.site_knowledge
            )

        except Exception as e:
            logger.error(f"Failed to generate plan from {profile.name}: {e}")
            # Return minimal plan
            return SubPlan(
                agent_name=profile.name,
                agent_type=agent_type,
                steps=[{"step_number": 1, "action": f"Execute {profile.name} task", "expected_outcome": "Task completed"}],
                output_format={},
                verification_signals=["Task completed"],
                site_knowledge=profile.site_knowledge
            )

    async def _aggregate_plans(
        self,
        user_request: str,
        intent: Intent,
        topic: Topic,
        selection: AgentSelection,
        sub_plans: List[SubPlan]
    ) -> UnifiedPlan:
        """
        Aggregate sub-plans into a unified execution plan.
        Determines order, handles dependencies, creates checkpoints.
        """
        import uuid

        # Build execution phases
        execution_phases = []
        all_success_criteria = []
        verification_checkpoints = []

        # Phase 1: Research (if any)
        research_plans = [p for p in sub_plans if p.agent_type == "research"]
        if research_plans:
            research_steps = []
            for plan in research_plans:
                for step in plan.steps:
                    step['agent'] = plan.agent_name
                    research_steps.append(step)
                all_success_criteria.extend(plan.verification_signals)

            execution_phases.append({
                "phase": 1,
                "name": "Research",
                "description": "Gather information from sources",
                "steps": research_steps,
                "checkpoint": "Verify research results collected before proceeding"
            })

            verification_checkpoints.append({
                "after_phase": 1,
                "check": "Research complete with relevant results",
                "on_failure": "Retry with alternative search terms"
            })

        # Phase 2: Action (if any)
        action_plans = [p for p in sub_plans if p.agent_type == "action"]
        if action_plans:
            action_steps = []
            for plan in action_plans:
                for step in plan.steps:
                    step['agent'] = plan.agent_name
                    action_steps.append(step)
                all_success_criteria.extend(plan.verification_signals)

            phase_num = 2 if research_plans else 1
            execution_phases.append({
                "phase": phase_num,
                "name": "Action",
                "description": "Execute the requested action",
                "steps": action_steps,
                "checkpoint": "Verify action completed successfully"
            })

            verification_checkpoints.append({
                "after_phase": phase_num,
                "check": "Action completed with confirmation",
                "on_failure": "Report failure with details"
            })

        # Generate the executor prompt
        executor_prompt = self._generate_executor_prompt(
            user_request=user_request,
            intent=intent,
            topic=topic,
            phases=execution_phases,
            success_criteria=all_success_criteria,
            checkpoints=verification_checkpoints,
            sub_plans=sub_plans
        )

        return UnifiedPlan(
            task_id=str(uuid.uuid4())[:8],
            original_request=user_request,
            intent=intent,
            topic=topic,
            agents_used=selection.research_agents + selection.action_agents,
            sub_plans=sub_plans,
            execution_phases=execution_phases,
            success_criteria=all_success_criteria,
            verification_checkpoints=verification_checkpoints,
            executor_prompt=executor_prompt,
            estimated_duration=self._estimate_duration(execution_phases),
            max_retries=3,
            timeout_minutes=10
        )

    def _generate_executor_prompt(
        self,
        user_request: str,
        intent: Intent,
        topic: Topic,
        phases: List[Dict],
        success_criteria: List[str],
        checkpoints: List[Dict],
        sub_plans: List[SubPlan]
    ) -> str:
        """
        Generate the final prompt for the Executor agent.
        Incorporates site knowledge and step-by-step instructions.
        """
        # Build site knowledge section
        site_knowledge_text = ""
        for plan in sub_plans:
            if plan.site_knowledge:
                site_knowledge_text += f"\n### {plan.agent_name.upper()} Site Knowledge:\n"
                site_knowledge_text += json.dumps(plan.site_knowledge, indent=2)

        # Build steps section
        steps_text = ""
        step_num = 1
        for phase in phases:
            steps_text += f"\n=== PHASE {phase['phase']}: {phase['name'].upper()} ===\n"
            steps_text += f"{phase['description']}\n\n"

            for step in phase['steps']:
                agent_tag = f"[{step.get('agent', 'executor')}]"
                steps_text += f"STEP {step_num} {agent_tag}: {step.get('action', '')}\n"
                steps_text += f"   Expected: {step.get('expected_outcome', '')}\n"
                steps_text += f"   Verify: {step.get('verification', '')}\n"
                if step.get('site_elements'):
                    steps_text += f"   Elements: {step.get('site_elements')}\n"
                steps_text += "\n"
                step_num += 1

            steps_text += f"CHECKPOINT: {phase.get('checkpoint', 'Verify phase complete')}\n"

        # Build success criteria
        criteria_text = "\n".join([f"✓ {c}" for c in success_criteria])

        # Build checkpoints
        checkpoints_text = "\n".join([
            f"After Phase {cp['after_phase']}: {cp['check']}\n   On failure: {cp['on_failure']}"
            for cp in checkpoints
        ])

        # Get output format based on intent
        output_format = self._get_output_format(intent, topic)

        prompt = f"""
MISSION: {user_request}

INTENT: {intent.value.upper()}
TOPIC: {topic.value.upper()}

AUTHENTICATION: You are using a pre-authenticated browser session. DO NOT attempt to log in.

{output_format}

=== SUCCESS CRITERIA ===
{criteria_text}

=== SITE KNOWLEDGE ===
{site_knowledge_text if site_knowledge_text else "Use standard browser navigation"}

=== EXECUTION PLAN ===
{steps_text}

=== VERIFICATION CHECKPOINTS ===
{checkpoints_text}

=== SELF-CORRECTION RULES ===
- If stuck on same page for 3+ actions: Stop, re-evaluate, try alternative approach
- If element not found: Check page loaded, scroll, or use alternative selector
- If search returns no results: Try broader/different search terms
- Every 3 steps: Verify you're making progress toward the goal

=== IMPORTANT RULES ===
✅ Follow steps in order
✅ Verify each step before proceeding
✅ Use site knowledge for navigation
✅ When COMPLETE, use "done" action immediately
❌ DO NOT exceed timeout
❌ DO NOT retry more than 3 times per step
❌ DO NOT add extra features unless asked
❌ DO NOT continue after task is complete

Begin execution now.
"""
        return prompt

    def _get_output_format(self, intent: Intent, topic: Topic) -> str:
        """Get the appropriate output format for the task."""
        formats = {
            (Intent.ACTION, Topic.PRODUCTS): """
=== OUTPUT FORMAT ===
Confirm the action:
✅ [Action completed] - [Item name]
   Price: $X.XX
   Status: Added to cart / Purchased / Failed
""",
            (Intent.ACTION, Topic.BOOKS): """
=== OUTPUT FORMAT ===
Confirm the action:
✅ [Action completed] - [Book title] by [Author]
   Format: Kindle / Paperback / etc.
   Price: $X.XX
""",
            (Intent.ACTION, Topic.FOOD): """
=== OUTPUT FORMAT ===
Confirm the reservation:
✅ Reservation confirmed
   Restaurant: [Name]
   Date/Time: [Details]
   Party size: [Number]
   Confirmation #: [If provided]
""",
            (Intent.ACTION, Topic.EMAIL): """
=== OUTPUT FORMAT ===
Confirm sync complete:
✅ Email sync complete
   - [X] flagged emails processed
   - Calendar event created for [date]
   - Key items: [Brief list]
""",
            (Intent.RESEARCH, Topic.FOOD): """
=== OUTPUT FORMAT ===
• **[Restaurant Name]** - [Cuisine], [Neighborhood]
  [Rating] stars | [Price range] | [1 sentence highlight]
""",
            (Intent.RESEARCH, Topic.BOOKS): """
=== OUTPUT FORMAT ===
• **[Book Title]** by [Author]
  [1-2 sentences: genre, what it's about, why recommended]
""",
            (Intent.RESEARCH, Topic.TECH): """
=== OUTPUT FORMAT ===
• **[Product Name]** - $[Price]
  [Key specs] | [1 sentence on pros/cons]
""",
        }

        key = (intent, topic)
        if key in formats:
            return formats[key]

        # Default format
        return """
=== OUTPUT FORMAT ===
Provide a concise summary of what was accomplished.
Use bullet points for multiple items.
Keep response SHORT and actionable.
"""

    def _estimate_duration(self, phases: List[Dict]) -> str:
        """Estimate task duration based on phases and steps."""
        total_steps = sum(len(phase.get('steps', [])) for phase in phases)

        if total_steps <= 5:
            return "1-3 minutes"
        elif total_steps <= 10:
            return "3-5 minutes"
        elif total_steps <= 20:
            return "5-8 minutes"
        else:
            return "8-12 minutes"

    def _parse_json(self, text: str) -> Dict:
        """Parse JSON from model response."""
        text = text.strip()

        # Remove markdown code blocks
        if text.startswith('```'):
            lines = text.split('\n')
            text = '\n'.join(lines[1:-1])

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Try to find JSON in text
            import re
            json_match = re.search(r'\{[\s\S]*\}', text)
            if json_match:
                return json.loads(json_match.group())
            raise ValueError(f"Could not parse JSON: {text[:200]}")


# ============================================
# Convenience Functions
# ============================================

async def orchestrate(request: str) -> UnifiedPlan:
    """
    Convenience function to orchestrate a request.

    Args:
        request: User's natural language request

    Returns:
        UnifiedPlan ready for execution
    """
    orchestrator = Orchestrator()
    return await orchestrator.process_request(request)


async def get_executor_prompt(request: str) -> str:
    """
    Get just the executor prompt for a request.

    Args:
        request: User's natural language request

    Returns:
        Prompt string for the browser automation agent
    """
    plan = await orchestrate(request)
    return plan.executor_prompt


# ============================================
# CLI Testing
# ============================================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    async def test_orchestrator():
        orchestrator = Orchestrator()

        test_requests = [
            "Find a good Italian restaurant in Manhattan and book a table for 2 tomorrow at 7pm",
            "Add Cradle by Will Wight to my Amazon cart",
            "Research the best noise-canceling headphones under $300",
            "Sync my flagged emails to the calendar",
            "Find books similar to The Name of the Wind",
        ]

        for request in test_requests:
            print(f"\n{'='*60}")
            print(f"Request: {request}")
            print('='*60)

            plan = await orchestrator.process_request(request)

            print(f"\nIntent: {plan.intent.value}")
            print(f"Topic: {plan.topic.value}")
            print(f"Agents: {plan.agents_used}")
            print(f"Duration: {plan.estimated_duration}")
            print(f"\nPhases:")
            for phase in plan.execution_phases:
                print(f"  {phase['phase']}. {phase['name']}: {len(phase['steps'])} steps")
            print(f"\nSuccess Criteria:")
            for criterion in plan.success_criteria[:3]:
                print(f"  ✓ {criterion}")
            print(f"\n--- Executor Prompt Preview ---")
            print(plan.executor_prompt[:500] + "...")

    asyncio.run(test_orchestrator())
