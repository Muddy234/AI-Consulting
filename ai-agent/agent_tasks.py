"""
Agent Tasks - Browser Automation Executor
==========================================
Executes browser automation tasks using the Executor agent profile.
Integrates with the Orchestrator for enhanced prompt generation.

Supports both Windows (Edge) and Raspberry Pi (Chromium).

Model Configuration:
- Browser automation: Gemini 2.0 Flash (stable for browser_use)
- Orchestration/Research: Gemini 2.5 Flash - see orchestrator.py
- Summary/Verification: Gemini 2.5 Flash - see task_planner.py
"""

import os
import sys
import platform
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Optional, List, Any
import asyncio
import logging

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

# Fix Windows console encoding
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from browser_use import Agent, BrowserProfile, BrowserSession
from browser_use.llm.models import ChatGoogle

# Import agent system
from agent_loader import AgentLoader, AgentProfile

logger = logging.getLogger(__name__)


# =====================================================
# Phased Execution Data Structures
# =====================================================

@dataclass
class PhaseResult:
    """Result from a single browser phase execution."""
    phase_name: str
    status: str  # "success", "partial", "failed"
    output: str  # Raw output from browser agent
    parsed_data: Optional[Dict] = None  # Parsed JSON if available
    error: Optional[str] = None
    duration_seconds: float = 0.0


@dataclass
class PhasedExecutionResult:
    """Aggregated result from all phases."""
    overall_status: str  # "success", "partial", "failed"
    phase_results: List[PhaseResult]
    final_output: str  # Combined summary for user
    total_duration_seconds: float = 0.0


def get_browser_profile():
    """
    Create browser profile based on platform.
    - Windows: Uses Edge with user's profile
    - Linux/Pi: Uses Chromium with user's profile
    """
    browser_type = os.getenv("BROWSER_TYPE", "auto").lower()

    # Auto-detect platform
    if browser_type == "auto":
        if sys.platform == 'win32':
            browser_type = "edge"
        else:
            browser_type = "chromium"

    if browser_type == "edge":
        # Windows Edge configuration
        username = os.getenv("OUTLOOK_USERNAME", os.getenv("USERNAME", "User"))
        return BrowserProfile(
            executable_path=os.getenv("EDGE_EXE_PATH", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            user_data_dir=os.getenv("EDGE_PATH", f"C:\\Users\\{username}\\AppData\\Local\\Microsoft\\Edge\\User Data"),
            profile_directory=os.getenv("EDGE_PROFILE", "Default"),
            headless=os.getenv("HEADLESS", "false").lower() == "true",
        )
    else:
        # Linux/Raspberry Pi Chromium configuration
        home = os.path.expanduser("~")
        return BrowserProfile(
            executable_path=os.getenv("CHROMIUM_PATH", "/usr/bin/chromium-browser"),
            user_data_dir=os.getenv("CHROMIUM_USER_DATA", f"{home}/.config/chromium"),
            profile_directory=os.getenv("CHROMIUM_PROFILE", "Default"),
            headless=os.getenv("HEADLESS", "false").lower() == "true",
        )


class AgentTaskRunner:
    """
    Universal task runner that executes browser automation tasks.

    Uses the Executor agent profile for:
    - Self-correction and recovery
    - Verification signals
    - Stuck detection and fallback

    Key Design Principles:
    1. Use existing browser sessions (no login attempts)
    2. Follow structured execution phases
    3. Verify each step before proceeding
    4. Self-correct when stuck
    5. Report clear results
    """

    def __init__(self):
        # Browser profile - auto-detects platform
        self.browser_profile = get_browser_profile()
        logger.info(f"Browser profile configured for: {os.getenv('BROWSER_TYPE', 'auto')}")

        # LLM - Using Gemini 2.0 Flash for browser automation
        # NOTE: Keep at 2.0 Flash for browsing stability
        # Orchestration/Research/Summary use Gemini 2.5 Flash in orchestrator.py
        api_key = os.getenv("GOOGLE_API_KEY")
        if api_key:
            os.environ["GOOGLE_API_KEY"] = api_key
        self.llm = ChatGoogle(model="gemini-2.0-flash")

        # Load executor agent profile
        self.agent_loader = AgentLoader()
        try:
            self.executor_profile = self.agent_loader.load_agent("executor")
            logger.info("Loaded executor agent profile")
        except FileNotFoundError:
            logger.warning("Executor profile not found, using defaults")
            self.executor_profile = None

    async def run_task(self, task_name: str, **params) -> Dict:
        """Run a named task with parameters (backward compatibility)."""

        # Get the task prompt
        task_generators = {
            "email_todo": self._email_todo_task,
            "amazon_purchase": self._amazon_purchase_task,
            "opentable_reservation": self._opentable_reservation_task,
            "web_research": self._web_research_task,
            "price_comparison": self._price_comparison_task,
        }

        if task_name not in task_generators:
            return {"status": "error", "message": f"Unknown task: {task_name}"}

        prompt = task_generators[task_name](**params)

        # Enhance with executor profile context
        enhanced_prompt = self._enhance_with_executor_profile(prompt)

        return await self._execute_browser_task(enhanced_prompt)

    async def run_with_prompt(self, enhanced_prompt: str) -> Dict:
        """
        Run a task with an AI-generated enhanced prompt.
        Used by the TaskPlanner/Orchestrator integration.

        The prompt should already include:
        - Site knowledge
        - Execution steps
        - Verification checkpoints
        - Success criteria

        Args:
            enhanced_prompt: The detailed prompt from Orchestrator

        Returns:
            Dict with status and result
        """
        # Add executor-specific enhancements
        final_prompt = self._add_executor_enhancements(enhanced_prompt)
        return await self._execute_browser_task(final_prompt)

    async def run_phased(self, plan) -> Dict:
        """
        Run a task using phased browser execution (RECOMMENDED).

        Instead of one long execution, breaks the task into focused phases:
        - DISCOVERY: Find targets and URLs from search results
        - EXTRACTION: Visit URLs and extract detailed data
        - ACTION: Execute state-changing operations
        - VERIFICATION: Confirm actions succeeded

        Each phase runs in a separate browser session, which improves
        reliability for complex tasks.

        Args:
            plan: UnifiedPlan from Orchestrator with browser_phases and phase_prompts

        Returns:
            Dict with status, result, and phase_details
        """
        # Check if plan has phased prompts
        if not hasattr(plan, 'phase_prompts') or not plan.phase_prompts:
            # Fall back to single-prompt execution
            logger.warning("Plan missing phase_prompts, falling back to single execution")
            return await self.run_with_prompt(plan.executor_prompt)

        # Use the phased executor
        phased_executor = PhasedBrowserExecutor()
        result = await phased_executor.execute_phased(plan)

        return {
            "status": result.overall_status,
            "result": result.final_output,
            "phase_details": [
                {
                    "phase": pr.phase_name,
                    "status": pr.status,
                    "duration": pr.duration_seconds,
                    "error": pr.error
                }
                for pr in result.phase_results
            ],
            "total_duration": result.total_duration_seconds
        }

    async def _execute_browser_task(self, prompt: str) -> Dict:
        """
        Execute a browser automation task.

        Args:
            prompt: The complete execution prompt

        Returns:
            Dict with status and result
        """
        try:
            # Create browser session
            browser_session = BrowserSession(
                browser_profile=self.browser_profile,
                headless=False,
            )

            agent = Agent(
                task=prompt,
                llm=self.llm,
                browser_session=browser_session,
            )

            result = await agent.run()

            # Extract clean final result
            clean_result = self._extract_final_result(result)
            return {"status": "success", "result": clean_result}

        except Exception as e:
            logger.error(f"Browser task failed: {e}")
            return {"status": "error", "message": str(e)}

    def _enhance_with_executor_profile(self, base_prompt: str) -> str:
        """Add executor profile context to a base prompt."""
        if not self.executor_profile:
            return base_prompt

        # Add self-correction rules from profile
        self_correction = ""
        if self.executor_profile.self_correction:
            self_correction = "\n=== SELF-CORRECTION RULES ===\n"
            for scenario, steps in self.executor_profile.self_correction.items():
                self_correction += f"\n{scenario.upper()}:\n"
                if isinstance(steps, list):
                    for step in steps:
                        self_correction += f"  - {step}\n"
                else:
                    self_correction += f"  {steps}\n"

        # Add verification signals
        verification = ""
        if self.executor_profile.verification_signals:
            verification = "\n=== VERIFICATION SIGNALS ===\n"
            for category, signals in self.executor_profile.verification_signals.items():
                if isinstance(signals, list):
                    verification += f"\n{category}:\n"
                    for signal in signals:
                        if isinstance(signal, dict):
                            verification += f"  - {signal}\n"

        return f"""
{base_prompt}

{self_correction}

{verification}

=== BEHAVIORAL RULES ===
DO:
{chr(10).join(['- ' + rule for rule in self.executor_profile.behavioral_rules.get('do', [])])}

DON'T:
{chr(10).join(['- ' + rule for rule in self.executor_profile.behavioral_rules.get('dont', [])])}
"""

    def _add_executor_enhancements(self, prompt: str) -> str:
        """
        Add executor-specific enhancements to an orchestrator-generated prompt.
        These are lightweight additions that don't duplicate what's in the prompt.
        """
        # Only add stuck detection if not already present
        if "stuck" not in prompt.lower():
            stuck_detection = """

=== STUCK DETECTION ===
If you perform the same action 3 times without progress:
1. STOP and re-evaluate the page state
2. Check if page has fully loaded
3. Try an alternative approach (different selector, scroll, refresh)
4. If still stuck after 5 attempts, report the issue and move on
"""
            prompt += stuck_detection

        return prompt

    def _extract_final_result(self, agent_history) -> str:
        """
        Extract a clean, human-readable result from the AgentHistoryList.
        Returns only the final extracted content.
        """
        try:
            # Look for the final done result with extracted_content
            if hasattr(agent_history, 'all_results'):
                for action_result in reversed(agent_history.all_results):
                    if action_result.is_done and action_result.extracted_content:
                        return action_result.extracted_content

            # Fallback: try to get final_result if available
            if hasattr(agent_history, 'final_result'):
                return str(agent_history.final_result())

            # Last resort
            return "Task completed. Check browser for results."

        except Exception as e:
            logger.warning(f"Could not extract clean result: {e}")
            return "Task completed."

    # =====================================================
    # Task Templates (backward compatibility)
    # =====================================================

    def _email_todo_task(self, inboxes: list = None, **kwargs) -> str:
        """Generate prompt for email to-do list sync."""
        tomorrow = (datetime.now() + timedelta(days=1)).strftime("%A, %B %d, %Y")

        if not inboxes:
            inboxes = [
                {"name": "Main", "url": "https://outlook.office.com/mail/0/"},
            ]

        inbox_list = "\n".join([f"   {i+1}. {inbox['name']}: {inbox['url']}" for i, inbox in enumerate(inboxes)])

        return f"""
MISSION: Create a SINGLE consolidated "To-Do List" calendar event with ALL flagged emails.

AUTHENTICATION: You are using my pre-authenticated browser. DO NOT attempt to log in.

INBOXES TO CHECK:
{inbox_list}

=== PHASE 1: COLLECT FLAGGED EMAILS ===

For EACH inbox:
1. Navigate to the inbox URL
2. Wait 3 seconds for page to load
3. Click "Filter" button → Click "Flagged" in dropdown
4. Wait 2 seconds
5. For each flagged email: Click to open, READ fully, note sender/subject/action needed
6. Move to next inbox

=== PHASE 2: CREATE/UPDATE CALENDAR EVENT ===

Go to: https://outlook.office.com/calendar/view/week

Check if "🤖 {{To-Do List}}" exists:
- If YES: Click and Edit it
- If NO: Create new event

Event details:
- Title: "🤖 {{To-Do List}}"
- Date: Tomorrow ({tomorrow})
- Time: 7:00 AM
- Duration: 30 minutes

Description format:
□ [Action] (from: [Sender]) - [Deadline if mentioned]

=== OUTPUT FORMAT ===
✅ Email sync complete
   - [X] flagged emails processed
   - Calendar event created for {tomorrow}
   - Key items: [Brief list of actions]
"""

    def _amazon_purchase_task(self,
                               item_description: str,
                               max_price: float = None,
                               quantity: int = 1,
                               add_to_cart_only: bool = True,
                               **kwargs) -> str:
        """Generate prompt for Amazon purchase task."""

        price_constraint = f"- Maximum price: ${max_price}" if max_price else "- No price limit specified"
        action = "ADD TO CART (do not complete purchase)" if add_to_cart_only else "COMPLETE PURCHASE"

        return f"""
MISSION: Find and {action.lower()} an item on Amazon.

AUTHENTICATION: You are using my pre-authenticated browser. DO NOT attempt to log in.

ITEM TO FIND:
- Description: {item_description}
- Quantity: {quantity}
{price_constraint}

=== PHASE 1: SEARCH FOR ITEM ===

1. Go to: https://www.amazon.com
2. Wait for page to load
3. Click on the search box
4. Type: "{item_description}"
5. Press Enter or click the search button
6. Wait for results to load

=== PHASE 2: SELECT BEST OPTION ===

1. Review the search results
2. Look for items that match the description
3. Check:
   - Price (must be under ${max_price if max_price else 'any amount'})
   - Rating (prefer 4+ stars)
   - Reviews (prefer items with many reviews)
   - Prime eligibility (prefer Prime items)
4. Click on the BEST matching item
5. READ the product description to confirm it matches

=== PHASE 3: {action} ===

1. Select quantity: {quantity}
2. UNCHECK "Subscribe & Save" if pre-selected
3. Click "Add to Cart" button
4. Dismiss any upsell popups (click "No thanks" or close)
5. Verify "Added to Cart" message appears

=== OUTPUT FORMAT ===
✅ Added to cart - [Item name]
   Price: $X.XX
   Format/Variant: [If applicable]
   Prime: Yes/No
"""

    def _opentable_reservation_task(self,
                                     restaurant_name: str = None,
                                     cuisine_type: str = None,
                                     location: str = None,
                                     date: str = None,
                                     time: str = None,
                                     party_size: int = 2,
                                     **kwargs) -> str:
        """Generate prompt for OpenTable reservation task."""

        search_query = restaurant_name if restaurant_name else f"{cuisine_type} restaurant in {location}"
        reservation_date = date if date else (datetime.now() + timedelta(days=1)).strftime("%B %d, %Y")
        reservation_time = time if time else "7:00 PM"

        return f"""
MISSION: Book a restaurant reservation on OpenTable.

AUTHENTICATION: You are using my pre-authenticated browser. DO NOT attempt to log in.

RESERVATION DETAILS:
- {"Restaurant: " + restaurant_name if restaurant_name else "Search for: " + str(cuisine_type) + " in " + str(location)}
- Date: {reservation_date}
- Time: {reservation_time}
- Party size: {party_size} people

=== PHASE 1: FIND RESTAURANT ===

1. Go to: https://www.opentable.com
2. Wait for page to load
3. In the search box, type: "{search_query}"
4. Set the date to: {reservation_date}
5. Set the time to: {reservation_time}
6. Set party size to: {party_size}
7. Click Search
8. Wait for results

=== PHASE 2: SELECT RESTAURANT ===

1. Review available restaurants
2. Check ratings and availability
3. Click on the best matching restaurant
4. Verify it has availability for requested time

=== PHASE 3: BOOK RESERVATION ===

1. Select an available time slot closest to {reservation_time}
2. Confirm party size is {party_size}
3. Click to proceed with reservation
4. Fill in any required details
5. Complete the reservation

=== OUTPUT FORMAT ===
✅ Reservation confirmed
   Restaurant: [Name]
   Date/Time: {reservation_date} at [Time booked]
   Party size: {party_size} guests
   Confirmation #: [If provided]

   Address: [Restaurant address]
"""

    def _web_research_task(self,
                           topic: str,
                           questions: list = None,
                           num_sources: int = 3,
                           **kwargs) -> str:
        """Generate prompt for web research task."""

        questions_text = ""
        if questions:
            questions_text = "\nSpecific questions to answer:\n" + "\n".join([f"- {q}" for q in questions])

        return f"""
MISSION: Research a topic and compile findings.

AUTHENTICATION: You are using my pre-authenticated browser.

RESEARCH TOPIC: {topic}
{questions_text}

=== PHASE 1: SEARCH FOR INFORMATION ===

1. Go to: https://www.google.com
2. Search for: "{topic}"
3. Review the search results
4. Identify the {num_sources} most relevant sources

=== PHASE 2: GATHER INFORMATION ===

For each source:
1. Click to open the source
2. READ the content thoroughly
3. Note key facts and insights
4. Note the source URL
5. Go back for next source

=== PHASE 3: COMPILE FINDINGS ===

Create a structured summary.

=== OUTPUT FORMAT ===
**{topic}**

KEY FINDINGS:
• [Finding 1 with source]
• [Finding 2 with source]
• [Finding 3 with source]

SOURCES:
1. [Source name] - [URL]
2. [Source name] - [URL]
"""

    def _price_comparison_task(self,
                                item_description: str,
                                sites: list = None,
                                **kwargs) -> str:
        """Generate prompt for price comparison task."""

        if not sites:
            sites = ["amazon.com", "walmart.com", "target.com", "bestbuy.com"]

        sites_list = "\n".join([f"   {i+1}. https://www.{site}" for i, site in enumerate(sites)])

        return f"""
MISSION: Compare prices for an item across multiple websites.

AUTHENTICATION: You are using my pre-authenticated browser.

ITEM TO COMPARE: {item_description}

WEBSITES TO CHECK:
{sites_list}

=== PHASE 1: SEARCH EACH SITE ===

For EACH website:
1. Navigate to the site
2. Wait for page to load
3. Search for: "{item_description}"
4. Find the matching product
5. Note: product name, price, shipping cost, availability

=== PHASE 2: COMPILE COMPARISON ===

=== OUTPUT FORMAT ===
**Price Comparison: {item_description}**

| Site | Price | Shipping | Total |
|------|-------|----------|-------|
| [Site 1] | $X.XX | $X.XX | $X.XX |
| [Site 2] | $X.XX | $X.XX | $X.XX |

RECOMMENDATION:
Best deal: [Site] at $X.XX
"""


# =====================================================
# Phased Browser Executor
# =====================================================

class PhasedBrowserExecutor:
    """
    Executes browser tasks in separate phases to improve reliability.

    Instead of one long execution plan, tasks are split into:
    1. DISCOVERY - Find targets, collect URLs from search results
    2. EXTRACTION - Visit URLs and extract detailed data
    3. ACTION - Execute state-changing operations
    4. VERIFICATION - Confirm actions succeeded

    Each phase runs in a separate browser session, passing data forward.
    This prevents the browser agent from getting overwhelmed by long plans.
    """

    def __init__(self):
        # Browser profile - auto-detects platform
        self.browser_profile = get_browser_profile()
        logger.info(f"PhasedBrowserExecutor initialized for: {os.getenv('BROWSER_TYPE', 'auto')}")

        # LLM - Using Gemini 2.0 Flash for browser automation
        api_key = os.getenv("GOOGLE_API_KEY")
        if api_key:
            os.environ["GOOGLE_API_KEY"] = api_key
        self.llm = ChatGoogle(model="gemini-2.0-flash")

        # Load executor agent profile for self-correction and verification rules
        self.agent_loader = AgentLoader()
        self.executor_profile = None
        try:
            self.executor_profile = self.agent_loader.load_agent("executor")
            logger.info("Loaded executor profile for browser enhancements")
        except FileNotFoundError:
            logger.warning("Executor profile not found, using default behaviors")

    def _get_executor_enhancements(self) -> str:
        """
        Extract key rules from the executor profile to inject into phase prompts.
        This ensures clean, efficient browser automation.
        """
        if not self.executor_profile:
            return self._get_default_enhancements()

        enhancements = "\n=== BROWSER AUTOMATION RULES ===\n"

        # Add self-correction rules
        if self.executor_profile.self_correction:
            enhancements += "\nSELF-CORRECTION:\n"
            for scenario, steps in list(self.executor_profile.self_correction.items())[:3]:
                if isinstance(steps, list):
                    enhancements += f"• {scenario}: {', '.join(steps[:3])}\n"
                else:
                    enhancements += f"• {scenario}: {steps}\n"

        # Add behavioral rules
        if self.executor_profile.behavioral_rules:
            do_rules = self.executor_profile.behavioral_rules.get('do', [])[:4]
            dont_rules = self.executor_profile.behavioral_rules.get('dont', [])[:4]
            if do_rules:
                enhancements += "\nDO:\n" + "\n".join([f"✓ {r}" for r in do_rules]) + "\n"
            if dont_rules:
                enhancements += "\nDON'T:\n" + "\n".join([f"✗ {r}" for r in dont_rules]) + "\n"

        return enhancements

    def _get_default_enhancements(self) -> str:
        """Default browser rules if executor profile is not available."""
        return """
=== BROWSER AUTOMATION RULES ===

SELF-CORRECTION:
• Element not found: Wait 2s, scroll, check for popups blocking
• Action has no effect: Check if disabled, try waiting for JS
• Page looks wrong: Verify URL, check for redirects

DO:
✓ Verify each action completed before proceeding
✓ Dismiss popups/modals that appear
✓ Wait for page to fully load (2-3s)
✓ Use "done" action immediately when complete

DON'T:
✗ Retry same failed action more than 2 times
✗ Continue past unrecoverable errors (CAPTCHA, login required)
✗ Add extra steps beyond what's requested
✗ Spend more than 30 seconds on any single action
"""

    async def execute_phased(self, plan) -> PhasedExecutionResult:
        """
        Execute a UnifiedPlan using phased browser execution.

        Args:
            plan: UnifiedPlan from Orchestrator with phase_prompts

        Returns:
            PhasedExecutionResult with all phase outputs
        """
        phase_results = []
        total_start = time.time()

        # Data passed between phases
        context_data = {}

        # Execute each phase in order
        for phase in plan.browser_phases:
            phase_name = phase.value
            logger.info(f"Starting browser phase: {phase_name}")

            # Get the prompt for this phase
            base_prompt = plan.phase_prompts.get(phase_name, "")
            if not base_prompt:
                logger.warning(f"No prompt found for phase: {phase_name}")
                continue

            # Inject context from previous phases
            prompt_with_context = self._inject_context(base_prompt, phase_name, context_data)

            # Execute the phase
            phase_result = await self._execute_single_phase(phase_name, prompt_with_context)
            phase_results.append(phase_result)

            # Extract data for next phases
            if phase_result.status == "success" and phase_result.parsed_data:
                context_data[phase_name] = phase_result.parsed_data

            # For failed phases, decide whether to continue
            if phase_result.status == "failed":
                logger.warning(f"Phase {phase_name} failed, checking if we should continue...")
                # For research phases, we can continue without all data
                # For action phases, failure usually means we should stop
                if phase_name in ["action", "verification"]:
                    logger.error(f"Critical phase {phase_name} failed, stopping execution")
                    break

        # Calculate total duration
        total_duration = time.time() - total_start

        # Determine overall status
        success_count = sum(1 for r in phase_results if r.status == "success")
        total_count = len(phase_results)

        if success_count == total_count:
            overall_status = "success"
        elif success_count > 0:
            overall_status = "partial"
        else:
            overall_status = "failed"

        # Generate final combined output
        final_output = self._combine_phase_outputs(phase_results, plan.original_request)

        return PhasedExecutionResult(
            overall_status=overall_status,
            phase_results=phase_results,
            final_output=final_output,
            total_duration_seconds=total_duration
        )

    async def _execute_single_phase(self, phase_name: str, prompt: str) -> PhaseResult:
        """Execute a single phase in a new browser session."""
        start_time = time.time()

        try:
            # Inject executor profile enhancements for clean, efficient execution
            enhanced_prompt = prompt + self._get_executor_enhancements()

            # Create fresh browser session for this phase
            browser_session = BrowserSession(
                browser_profile=self.browser_profile,
                headless=False,
            )

            agent = Agent(
                task=enhanced_prompt,
                llm=self.llm,
                browser_session=browser_session,
            )

            logger.info(f"Executing phase: {phase_name}")
            result = await agent.run()

            # Extract the output
            raw_output = self._extract_result(result)
            duration = time.time() - start_time

            # Try to parse JSON from output
            parsed_data = self._try_parse_json(raw_output)

            logger.info(f"Phase {phase_name} completed in {duration:.1f}s")

            return PhaseResult(
                phase_name=phase_name,
                status="success",
                output=raw_output,
                parsed_data=parsed_data,
                duration_seconds=duration
            )

        except Exception as e:
            duration = time.time() - start_time
            logger.error(f"Phase {phase_name} failed after {duration:.1f}s: {e}")

            return PhaseResult(
                phase_name=phase_name,
                status="failed",
                output="",
                error=str(e),
                duration_seconds=duration
            )

    def _inject_context(self, prompt: str, current_phase: str, context_data: Dict) -> str:
        """Inject data from previous phases into the current prompt."""
        context_section = ""

        if current_phase == "extraction" and "discovery" in context_data:
            # Inject discovered URLs into extraction prompt
            discovery_data = context_data["discovery"]
            targets = discovery_data.get("targets", [])

            if targets:
                context_section = "\n=== TARGETS FROM DISCOVERY ===\n"
                for i, target in enumerate(targets, 1):
                    name = target.get("name", "Unknown")
                    url = target.get("url", "")
                    info = target.get("basic_info", "")
                    context_section += f"{i}. {name}\n   URL: {url}\n   Info: {info}\n\n"

        elif current_phase == "action" and "extraction" in context_data:
            # Inject extracted data into action prompt
            extraction_data = context_data["extraction"]
            extracted = extraction_data.get("extracted_data", [])

            if extracted:
                context_section = "\n=== DATA FROM EXTRACTION ===\n"
                # Use the first/best result for action
                if len(extracted) > 0:
                    best = extracted[0]
                    context_section += f"Target: {best.get('name', 'Unknown')}\n"
                    context_section += f"URL: {best.get('url', '')}\n"
                    for key, value in best.items():
                        if key not in ["name", "url"] and value:
                            context_section += f"{key.title()}: {value}\n"

        elif current_phase == "verification" and "action" in context_data:
            # Inject action results into verification prompt
            action_data = context_data["action"]
            context_section = "\n=== ACTION RESULT TO VERIFY ===\n"
            context_section += f"Action completed: {action_data.get('action_completed', 'unknown')}\n"
            context_section += f"Target: {action_data.get('target', 'unknown')}\n"

        # Insert context at the beginning of the prompt
        if context_section:
            return context_section + "\n" + prompt

        return prompt

    def _extract_result(self, agent_history) -> str:
        """Extract clean result from browser agent output."""
        try:
            if hasattr(agent_history, 'all_results'):
                for action_result in reversed(agent_history.all_results):
                    if action_result.is_done and action_result.extracted_content:
                        return action_result.extracted_content

            if hasattr(agent_history, 'final_result'):
                return str(agent_history.final_result())

            return "Phase completed."

        except Exception as e:
            logger.warning(f"Could not extract result: {e}")
            return "Phase completed."

    def _try_parse_json(self, text: str) -> Optional[Dict]:
        """Try to extract and parse JSON from the output text."""
        if not text:
            return None

        # Look for JSON in code blocks
        json_match = re.search(r'```(?:json)?\s*\n?([\s\S]*?)\n?```', text)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # Try to find raw JSON object
        json_obj_match = re.search(r'\{[\s\S]*\}', text)
        if json_obj_match:
            try:
                return json.loads(json_obj_match.group())
            except json.JSONDecodeError:
                pass

        return None

    def _combine_phase_outputs(self, phase_results: List[PhaseResult], original_request: str) -> str:
        """Combine outputs from all phases into a user-friendly summary."""
        output_parts = []
        output_parts.append(f"Results for: {original_request}\n")

        for result in phase_results:
            if result.status == "success":
                if result.parsed_data:
                    # Format the parsed data nicely
                    output_parts.append(self._format_parsed_data(result.phase_name, result.parsed_data))
                else:
                    output_parts.append(f"**{result.phase_name.title()}:** {result.output[:500]}")
            elif result.status == "failed":
                output_parts.append(f"**{result.phase_name.title()}:** Failed - {result.error or 'Unknown error'}")

        return "\n\n".join(output_parts)

    def _format_parsed_data(self, phase_name: str, data: Dict) -> str:
        """Format parsed phase data for user display."""
        if phase_name == "discovery":
            targets = data.get("targets", [])
            if targets:
                lines = [f"**Found {len(targets)} results:**"]
                for t in targets[:5]:
                    lines.append(f"• {t.get('name', 'Unknown')} - {t.get('basic_info', '')}")
                return "\n".join(lines)

        elif phase_name == "extraction":
            extracted = data.get("extracted_data", [])
            if extracted:
                lines = ["**Detailed Information:**"]
                for item in extracted[:5]:
                    lines.append(f"\n• **{item.get('name', 'Unknown')}**")
                    for key, value in item.items():
                        if key != "name" and value:
                            lines.append(f"  - {key.title()}: {value}")
                return "\n".join(lines)

        elif phase_name == "action":
            if data.get("action_completed"):
                return f"✅ Action completed: {data.get('target', 'Unknown')}"
            else:
                return "❌ Action was not completed"

        elif phase_name == "verification":
            if data.get("verified"):
                return f"✅ Verified: {data.get('evidence', 'Action confirmed')}"
            else:
                return f"⚠️ Verification issue: {data.get('issues', 'Could not confirm')}"

        # Default: just dump as formatted JSON
        return json.dumps(data, indent=2)


# =====================================================
# CLI Interface
# =====================================================

async def main():
    import argparse

    parser = argparse.ArgumentParser(description="AI Agent Task Runner")
    parser.add_argument("task", choices=[
        "email_todo",
        "amazon_purchase",
        "opentable_reservation",
        "web_research",
        "price_comparison"
    ], help="Task to run")

    # Task-specific arguments
    parser.add_argument("--item", type=str, help="Item description (for purchase/comparison)")
    parser.add_argument("--max-price", type=float, help="Maximum price")
    parser.add_argument("--restaurant", type=str, help="Restaurant name")
    parser.add_argument("--cuisine", type=str, help="Cuisine type")
    parser.add_argument("--location", type=str, help="Location")
    parser.add_argument("--date", type=str, help="Date for reservation")
    parser.add_argument("--time", type=str, help="Time for reservation")
    parser.add_argument("--party-size", type=int, default=2, help="Party size")
    parser.add_argument("--topic", type=str, help="Research topic")

    args = parser.parse_args()

    runner = AgentTaskRunner()

    # Build params based on task
    params = {}

    if args.task == "amazon_purchase":
        if not args.item:
            print("Error: --item is required for amazon_purchase")
            return
        params = {
            "item_description": args.item,
            "max_price": args.max_price,
            "add_to_cart_only": True
        }

    elif args.task == "opentable_reservation":
        params = {
            "restaurant_name": args.restaurant,
            "cuisine_type": args.cuisine,
            "location": args.location,
            "date": args.date,
            "time": args.time,
            "party_size": args.party_size
        }

    elif args.task == "web_research":
        if not args.topic:
            print("Error: --topic is required for web_research")
            return
        params = {"topic": args.topic}

    elif args.task == "price_comparison":
        if not args.item:
            print("Error: --item is required for price_comparison")
            return
        params = {"item_description": args.item}

    print(f"\n🤖 Running task: {args.task}")
    print(f"   Parameters: {params}\n")

    result = await runner.run_task(args.task, **params)

    print(f"\n{'='*50}")
    print(f"Result: {result['status']}")
    if result.get('result'):
        print(f"\n{result['result']}")
    if result.get('message'):
        print(f"Message: {result['message']}")


if __name__ == "__main__":
    asyncio.run(main())
