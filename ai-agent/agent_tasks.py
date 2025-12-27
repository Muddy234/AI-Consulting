"""
Agent Tasks - Browser Automation Executor
==========================================
Executes browser automation tasks using the Executor agent profile.
Integrates with the Orchestrator for enhanced prompt generation.

Supports both Windows (Edge) and Raspberry Pi (Chromium).

Model Configuration:
- Browser automation: Gemini 2.0 Flash (stable for browser_use)
- Orchestration/Research: Gemini 2.0 Flash Exp (3.0) - see orchestrator.py
- Summary/Verification: Gemini 2.0 Flash Exp (3.0) - see task_planner.py
"""

import os
import sys
import platform
from datetime import datetime, timedelta
from typing import Dict, Optional
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
        # Orchestration/Research/Summary use 2.0 Flash Exp (3.0) in orchestrator.py
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
