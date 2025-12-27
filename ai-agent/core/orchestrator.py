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
PROJECT_DIR = SCRIPT_DIR.parent  # ai-agent root
ENV_FILE = PROJECT_DIR / ".env"

if ENV_FILE.exists():
    load_dotenv(ENV_FILE)
else:
    load_dotenv()

# Fix Windows encoding
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import google.generativeai as genai

from .agent_loader import AgentLoader, AgentProfile

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


class BrowserPhase(Enum):
    """
    Browser execution phases - each runs in a separate browser session.
    This prevents long execution plans from overwhelming the browser agent.
    """
    DISCOVERY = "discovery"        # Find URLs, names, basic info from search results
    EXTRACTION = "extraction"      # Scrape detailed data from specific pages
    ACTION = "action"              # Execute state-changing operations
    VERIFICATION = "verification"  # Confirm actions completed successfully

    @classmethod
    def phases_for_intent(cls, intent: Intent) -> List["BrowserPhase"]:
        """Get the phases needed for a given intent."""
        if intent == Intent.RESEARCH:
            return [cls.DISCOVERY, cls.EXTRACTION]
        elif intent == Intent.ACTION:
            return [cls.ACTION, cls.VERIFICATION]
        else:  # HYBRID
            return [cls.DISCOVERY, cls.EXTRACTION, cls.ACTION, cls.VERIFICATION]


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

    # Final prompt for executor (legacy - single prompt for all phases)
    executor_prompt: str

    # Phase-specific prompts (new - separate prompt per browser phase)
    browser_phases: List[BrowserPhase] = field(default_factory=list)
    phase_prompts: Dict[str, str] = field(default_factory=dict)  # phase_name -> prompt

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
        # - Orchestration/Research: Gemini 2.5 Flash
        # - Browser automation uses 2.0 Flash (configured in agent_tasks.py)
        self.model = genai.GenerativeModel("gemini-2.5-flash")

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

        # Determine browser phases needed for this intent
        browser_phases = BrowserPhase.phases_for_intent(intent)

        # Generate phase-specific prompts for focused execution
        phase_prompts = self._generate_phase_prompts(
            user_request=user_request,
            intent=intent,
            topic=topic,
            sub_plans=sub_plans,
            browser_phases=browser_phases
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
            browser_phases=browser_phases,
            phase_prompts=phase_prompts,
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

    def _generate_phase_prompts(
        self,
        user_request: str,
        intent: Intent,
        topic: Topic,
        sub_plans: List[SubPlan],
        browser_phases: List[BrowserPhase]
    ) -> Dict[str, str]:
        """
        Generate focused prompts for each browser execution phase.

        Each phase has a specific, limited scope:
        - DISCOVERY: Find targets, collect URLs and names from search results
        - EXTRACTION: Visit specific URLs and extract detailed data
        - ACTION: Execute state-changing operations (add to cart, book, etc.)
        - VERIFICATION: Confirm actions completed successfully
        """
        phase_prompts = {}

        # Collect site knowledge from all plans
        all_site_knowledge = {}
        for plan in sub_plans:
            if plan.site_knowledge:
                all_site_knowledge[plan.agent_name] = plan.site_knowledge

        site_knowledge_text = json.dumps(all_site_knowledge, indent=2) if all_site_knowledge else "Use standard navigation"

        # Generate prompt for each phase
        for phase in browser_phases:
            if phase == BrowserPhase.DISCOVERY:
                phase_prompts[phase.value] = self._generate_discovery_prompt(
                    user_request, topic, site_knowledge_text
                )
            elif phase == BrowserPhase.EXTRACTION:
                phase_prompts[phase.value] = self._generate_extraction_prompt(
                    user_request, topic, site_knowledge_text
                )
            elif phase == BrowserPhase.ACTION:
                phase_prompts[phase.value] = self._generate_action_prompt(
                    user_request, topic, sub_plans, site_knowledge_text
                )
            elif phase == BrowserPhase.VERIFICATION:
                phase_prompts[phase.value] = self._generate_verification_prompt(
                    user_request, topic
                )

        return phase_prompts

    def _generate_discovery_prompt(self, user_request: str, topic: Topic, site_knowledge: str) -> str:
        """Generate prompt for the Discovery phase - find targets and collect basic info."""
        topic_sites = {
            Topic.FOOD: "Google Maps and Yelp",
            Topic.TRAVEL: "Google Maps and TripAdvisor",
            Topic.BOOKS: "Google and Goodreads",
            Topic.TECH: "Google and Wirecutter",
            Topic.PRODUCTS: "Google and Amazon",
            Topic.LOCATION: "Google Maps",
            Topic.GENERAL: "Google",
        }

        sites = topic_sites.get(topic, "Google")

        return f"""
=== DISCOVERY PHASE ===
MISSION: Find relevant results for "{user_request}"

YOUR ONLY GOAL: Search and collect a list of targets with their URLs.
DO NOT click into individual results. DO NOT extract detailed information.

SITES TO SEARCH: {sites}

STEPS:
1. Navigate to the appropriate search site
2. Enter search query based on user request
3. Wait for results to load
4. Collect from the SEARCH RESULTS page:
   - Names of top 3-5 relevant results
   - URLs/links for each result
   - Any visible ratings or basic info shown in the listing

SITE KNOWLEDGE:
{site_knowledge}

=== OUTPUT FORMAT ===
Provide a JSON list of discovered targets:
```json
{{
  "targets": [
    {{
      "name": "Result Name",
      "url": "https://...",
      "basic_info": "Rating, price, etc. visible in listing"
    }}
  ],
  "search_query_used": "what you searched for",
  "source_site": "where you searched"
}}
```

=== RULES ===
✅ Stay on search results pages - do not click into individual results
✅ Collect URLs exactly as shown
✅ Get 3-5 results maximum
✅ Use "done" action immediately when you have the list
❌ DO NOT visit individual result pages
❌ DO NOT try to get detailed info like hours, phone, reviews
❌ DO NOT spend more than 5 browser actions on this phase
"""

    def _generate_extraction_prompt(self, user_request: str, topic: Topic, site_knowledge: str) -> str:
        """Generate prompt for the Extraction phase - get detailed info from specific pages."""
        topic_fields = {
            Topic.FOOD: "hours, address, phone, rating, price range, cuisine type, popular dishes, reservation availability",
            Topic.TRAVEL: "address, amenities, price range, availability, reviews summary, nearby attractions",
            Topic.BOOKS: "author, publication date, rating, genre, description, price, format options",
            Topic.TECH: "specifications, price, pros/cons, where to buy, rating",
            Topic.PRODUCTS: "price, availability, rating, key features, seller info",
            Topic.LOCATION: "address, hours, phone, busy times, parking, accessibility",
            Topic.GENERAL: "relevant details based on the page content",
        }

        fields = topic_fields.get(topic, "all relevant details")

        return f"""
=== EXTRACTION PHASE ===
MISSION: Extract detailed information for "{user_request}"

YOU WILL RECEIVE: A list of target URLs from the Discovery phase.
YOUR GOAL: Visit each URL and extract specific details.

FIELDS TO EXTRACT: {fields}

SITE KNOWLEDGE:
{site_knowledge}

=== EXECUTION ===
For EACH target URL provided:
1. Navigate directly to the URL
2. Wait for page to load
3. Extract the required fields
4. Move to next URL

NOTE: The target URLs will be provided as input when this phase runs.
If no URLs are provided, search for the top result and extract from that.

=== OUTPUT FORMAT ===
```json
{{
  "extracted_data": [
    {{
      "name": "Business/Product Name",
      "url": "https://...",
      "address": "Full address",
      "phone": "Phone number",
      "hours": "Operating hours",
      "rating": "X.X stars from N reviews",
      "price_range": "$-$$$$",
      "highlights": "Key notable features",
      "additional_info": "Any other relevant details"
    }}
  ]
}}
```

=== RULES ===
✅ Go directly to provided URLs
✅ Extract ALL available fields from each page
✅ Be thorough - this is the main data collection phase
✅ Use "done" when you've extracted from all targets
❌ DO NOT search for new results (use provided URLs)
❌ DO NOT take any actions (add to cart, book, etc.)
❌ Limit to 3-5 targets maximum to avoid timeout
"""

    def _generate_action_prompt(
        self,
        user_request: str,
        topic: Topic,
        sub_plans: List[SubPlan],
        site_knowledge: str
    ) -> str:
        """Generate prompt for the Action phase - execute state-changing operations."""
        # Get action steps from action agent plans
        action_steps = []
        for plan in sub_plans:
            if plan.agent_type == "action":
                action_steps.extend(plan.steps)

        steps_text = ""
        for i, step in enumerate(action_steps[:10], 1):  # Limit to 10 steps
            steps_text += f"{i}. {step.get('action', 'Execute step')}\n"
            if step.get('expected_outcome'):
                steps_text += f"   Expected: {step.get('expected_outcome')}\n"

        if not steps_text:
            steps_text = "Execute the requested action based on user request."

        return f"""
=== ACTION PHASE ===
MISSION: Execute the action for "{user_request}"

YOU WILL RECEIVE: Target information from the Extraction phase.
YOUR GOAL: Complete the requested action (add to cart, make reservation, etc.)

SITE KNOWLEDGE:
{site_knowledge}

=== ACTION STEPS ===
{steps_text}

=== OUTPUT FORMAT ===
Confirm the action was completed:
```json
{{
  "action_completed": true,
  "action_type": "add_to_cart | reservation | purchase | etc.",
  "target": "What was acted on",
  "details": {{
    "confirmation_number": "if provided",
    "price": "if applicable",
    "date_time": "if applicable"
  }},
  "notes": "Any relevant information"
}}
```

=== RULES ===
✅ Use the target information from previous phases
✅ Complete the action fully
✅ Capture confirmation details
✅ Use "done" immediately after action completes
❌ DO NOT search or browse - go directly to action
❌ DO NOT over-engineer - just complete the requested action
"""

    def _generate_verification_prompt(self, user_request: str, topic: Topic) -> str:
        """Generate prompt for the Verification phase - confirm action succeeded."""
        return f"""
=== VERIFICATION PHASE ===
MISSION: Verify that the action for "{user_request}" completed successfully.

YOUR GOAL: Confirm the action was successful and capture proof.

=== VERIFICATION STEPS ===
1. Check for confirmation message/page
2. Verify the action result is visible (item in cart, reservation confirmed, etc.)
3. Capture any confirmation numbers or details
4. Take note of any warnings or issues

=== OUTPUT FORMAT ===
```json
{{
  "verified": true,
  "evidence": "What confirms the action succeeded",
  "confirmation_details": {{
    "confirmation_number": "if available",
    "summary": "what was completed"
  }},
  "issues": "any problems noticed, or null if none"
}}
```

=== RULES ===
✅ Navigate to where confirmation should be visible
✅ Capture specific evidence of success
✅ Use "done" immediately after verification
❌ DO NOT take additional actions
❌ DO NOT repeat the action
"""

    def _get_output_format(self, intent: Intent, topic: Topic) -> str:
        """Get the appropriate output format for the task."""
        formats = {
            (Intent.ACTION, Topic.PRODUCTS): """
=== OUTPUT FORMAT ===
Confirm the action with relevant details:
✅ [Action completed] - [Item name]
   Price: $X.XX
   Status: Added to cart / Purchased / Failed
   Any relevant notes (shipping, seller, etc.)
""",
            (Intent.ACTION, Topic.BOOKS): """
=== OUTPUT FORMAT ===
Confirm the action with relevant details:
✅ [Action completed] - [Book title] by [Author]
   Format: Kindle / Paperback / etc.
   Price: $X.XX
   Any relevant notes
""",
            (Intent.ACTION, Topic.FOOD): """
=== OUTPUT FORMAT ===
Confirm the reservation with all relevant details:
✅ Reservation confirmed
   Restaurant: [Name]
   Address: [Full address]
   Date/Time: [Details]
   Party size: [Number]
   Confirmation #: [If provided]
   Any special notes or instructions
""",
            (Intent.ACTION, Topic.EMAIL): """
=== OUTPUT FORMAT ===
Confirm sync complete with summary:
✅ Email sync complete
   - [X] flagged emails processed
   - Calendar event created for [date]
   - Key items summary
""",
            (Intent.RESEARCH, Topic.FOOD): """
=== OUTPUT FORMAT ===
For each restaurant/venue, provide:
• **[Name]** - [Cuisine type], [Location/Neighborhood]
  - Rating: [X.X stars] from [N reviews]
  - Price range: [$-$$$$]
  - Address: [Full address]
  - Hours: [Today's hours or general hours]
  - Highlights: [What makes it notable - signature dishes, atmosphere, etc.]
  - Any relevant notes (reservations needed, parking, etc.)

Include enough detail to make an informed decision.
""",
            (Intent.RESEARCH, Topic.BOOKS): """
=== OUTPUT FORMAT ===
For each book, provide:
• **[Book Title]** by [Author]
  - Genre/Category
  - Brief description of what it's about
  - Why it's recommended or notable
  - Price/availability if relevant

Include enough detail to decide if it's worth reading.
""",
            (Intent.RESEARCH, Topic.TECH): """
=== OUTPUT FORMAT ===
For each product, provide:
• **[Product Name]** - $[Price]
  - Key specifications
  - Pros and cons
  - Where to buy / availability
  - Any notable reviews or ratings

Include enough detail to compare options.
""",
            (Intent.RESEARCH, Topic.LOCATION): """
=== OUTPUT FORMAT ===
For each location/business, provide:
• **[Business Name]**
  - Address: [Full address]
  - Phone: [Number]
  - Hours: [Operating hours, note if currently open/closed]
  - Description: [What the business offers/does]
  - Rating: [If available]
  - Busy times: [If available - best times to visit]
  - Parking/Access: [If relevant]
  - Any other relevant details for planning a visit

Include enough information to plan a visit or contact them.
""",
            (Intent.RESEARCH, Topic.TRAVEL): """
=== OUTPUT FORMAT ===
For each destination/accommodation, provide:
• **[Name]**
  - Location: [Address/Area]
  - Description: [What it offers]
  - Rating: [If available]
  - Price range: [If applicable]
  - Highlights: [Key features, amenities, attractions]
  - Tips: [Best time to visit, things to know]

Include enough detail to plan accordingly.
""",
        }

        key = (intent, topic)
        if key in formats:
            return formats[key]

        # Default format - more flexible
        return """
=== OUTPUT FORMAT ===
Provide a comprehensive summary organized with bullet points.
Include all relevant details the user needs to make informed decisions or take action.
Structure the response clearly with:
• Key findings or results
• Important details for each item
• Any relevant notes, warnings, or recommendations

Be thorough but organized - quality over brevity.
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
