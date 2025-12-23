"""
Outlook State Sync - AI-Powered Email & Calendar Manager
=========================================================
Smart sync that reads flagged emails and creates contextual calendar events.
Google Sheets integration is optional.
"""

import os
import logging
import asyncio
from datetime import datetime
from typing import List, Dict, Optional

# Browser-use imports (native - no LangChain wrapper needed)
from browser_use import Agent, BrowserProfile
from browser_use.llm.models import ChatGoogle

# ================= LOGGING SETUP =================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler('outlook_sync.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


# ================= CONFIGURATION =================
class Config:
    # User Settings
    USERNAME = os.getenv("OUTLOOK_USERNAME", "NateMcBride")
    EDGE_PATH = os.getenv("EDGE_PATH", f"C:\\Users\\{USERNAME}\\AppData\\Local\\Microsoft\\Edge\\User Data")
    PROFILE_DIRECTORY = os.getenv("EDGE_PROFILE", "Default")

    # API Keys (prefer environment variables)
    GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "AIzaSyAkxpLgxmubGXIrOC2daoMq-viXThIo62Y")

    # Google Sheet (OPTIONAL)
    USE_SHEETS = os.getenv("USE_SHEETS", "false").lower() == "true"
    SHEET_URL = os.getenv("SHEET_URL", "")
    SERVICE_ACCOUNT_FILE = os.getenv("SERVICE_ACCOUNT_FILE", "service_account.json")

    # Outlook URLs
    FLAGGED_FOLDER = "https://outlook.office.com/mail/flaggedemail"
    CALENDAR_URL = "https://outlook.office.com/calendar/view/week"
    INBOX_URL = "https://outlook.office.com/mail/inbox"

    # Timing
    SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL", 900))  # 15 minutes
    MAX_RETRIES = 3
    RETRY_DELAY = 5


# Set API key in environment
if Config.GOOGLE_API_KEY:
    os.environ["GOOGLE_API_KEY"] = Config.GOOGLE_API_KEY


# ================= MAIN CLASS =================
class OutlookStateSync:
    def __init__(self):
        logger.info("Initializing Outlook State Sync System...")

        # Initialize LLM (browser_use native - not LangChain)
        self.llm = ChatGoogle(model="gemini-2.0-flash")

        # Initialize browser profile to use existing Edge session (already logged into Outlook)
        self.browser_profile = BrowserProfile(
            user_data_dir=Config.EDGE_PATH,
            headless=False,
            channel="msedge"  # Use Microsoft Edge
        )
        logger.info(f"   Using Edge profile: {Config.EDGE_PATH}")

        # Optional: Google Sheets
        self.sheets_enabled = False
        if Config.USE_SHEETS:
            self._init_sheets()

        # State tracking
        self.last_sync = None
        self.sync_count = 0
        self.errors = []

    def _init_sheets(self):
        """Initialize Google Sheets connection (optional)"""
        try:
            import gspread
            from google.oauth2 import service_account

            self.creds = service_account.Credentials.from_service_account_file(
                Config.SERVICE_ACCOUNT_FILE,
                scopes=['https://www.googleapis.com/auth/spreadsheets']
            )
            self.gc = gspread.authorize(self.creds)
            self.sh = self.gc.open_by_url(Config.SHEET_URL)
            self.worksheet = self.sh.sheet1
            self.sheets_enabled = True
            logger.info("✅ Connected to Google Sheet (optional)")
        except FileNotFoundError:
            logger.warning(f"⚠️ Service account file not found. Sheets disabled.")
        except Exception as e:
            logger.warning(f"⚠️ Could not connect to Sheets: {e}. Continuing without Sheets.")

    # ================= SMART EMAIL-TO-CALENDAR SYNC =================
    async def run_smart_sync(self) -> Dict:
        """
        AI-powered sync that:
        1. Opens flagged emails folder
        2. Reads each flagged email to understand context
        3. Creates calendar events with meaningful details
        """
        logger.info("🤖 SMART SYNC: Starting AI-powered email-to-calendar sync...")

        prompt = f"""
MISSION: Intelligently sync my flagged Outlook emails to my calendar.

STEP 1: Go to {Config.FLAGGED_FOLDER}
- Look at all flagged emails in the list
- Note the sender, subject, and preview text for each

STEP 2: For each flagged email, click to open it and:
- Read the full email content
- Identify: What is this about? Is there a deadline? Any action items?
- Extract key details: dates, times, people involved, topic

STEP 3: Go to {Config.CALENDAR_URL}
- Check if a calendar event already exists for each flagged email topic
- Look for events starting with "🤖" (these are bot-managed)

STEP 4: For each flagged email that DOESN'T have a matching calendar event:
- Create a new event with:
  - Title: "🤖 [Action verb] - [Brief topic]" (e.g., "🤖 Review - Q4 Budget Report")
  - Date/Time: If the email mentions a deadline, use that. Otherwise, schedule for tomorrow 9:00 AM
  - Duration: 30 minutes (or longer if the task seems complex)
  - Description: Include key context from the email:
    * From: [sender name]
    * Subject: [email subject]
    * Summary: [2-3 sentence summary of what needs to be done]
    * Original email date: [when the email was received]

STEP 5: Clean up
- If you find any "🤖" calendar events that don't match a current flagged email, DELETE them
- This keeps the calendar in sync with what's actually flagged

RULES:
- SAFETY: Only create/modify/delete events that start with "🤖"
- Never touch other calendar events
- Be smart about extracting deadlines from email content
- If an email mentions "by Friday" or "end of week", schedule appropriately

REPORT: At the end, list:
- How many flagged emails found
- How many calendar events created
- How many calendar events deleted
- Brief summary of each event created

Begin now.
"""

        result = {"status": "unknown", "changes": [], "error": None}

        for attempt in range(Config.MAX_RETRIES):
            try:
                logger.info(f"   Attempt {attempt + 1}/{Config.MAX_RETRIES}")

                agent = Agent(
                    task=prompt,
                    llm=self.llm,
                    browser_profile=self.browser_profile
                )

                agent_result = await agent.run()

                result["status"] = "success"
                result["result"] = str(agent_result)
                result["attempts"] = attempt + 1

                logger.info("   ✅ Smart sync completed successfully")

                # Optionally log to sheets
                if self.sheets_enabled:
                    self._log_to_sheet(result)

                break

            except Exception as e:
                logger.warning(f"   ⚠️ Attempt {attempt + 1} failed: {e}")
                result["error"] = str(e)

                if attempt < Config.MAX_RETRIES - 1:
                    await asyncio.sleep(Config.RETRY_DELAY)
                else:
                    result["status"] = "failed"
                    self.errors.append({"phase": "smart_sync", "error": str(e), "time": datetime.now()})

        return result

    # ================= PROCESS SINGLE EMAIL =================
    async def process_single_email(self, email_identifier: str) -> Dict:
        """
        Process a specific email and create a calendar event for it.
        email_identifier can be sender name, subject keywords, etc.
        """
        logger.info(f"🤖 Processing single email: {email_identifier}")

        prompt = f"""
TASK: Find and process a specific email, then create a calendar event.

STEP 1: Go to {Config.INBOX_URL}
- Search for: {email_identifier}
- Open the most relevant email

STEP 2: Read the email carefully and extract:
- Sender name and email
- Subject line
- Key dates or deadlines mentioned
- Action items or requests
- Level of urgency

STEP 3: Go to {Config.CALENDAR_URL}
- Create a new calendar event:
  - Title: "🤖 [Action] - [Topic from email]"
  - Date: Use deadline from email, or tomorrow if none mentioned
  - Time: 9:00 AM (or time mentioned in email)
  - Duration: Based on complexity (30 min for simple, 1 hour for complex)
  - Description:
    * From: [sender]
    * Subject: [subject]
    * Summary: [What needs to be done]
    * Key dates: [Any deadlines mentioned]
    * Context: [Relevant details from the email]

REPORT what you created.
"""

        result = {"status": "unknown", "error": None}

        try:
            agent = Agent(task=prompt, llm=self.llm, browser_profile=self.browser_profile)
            agent_result = await agent.run()
            result["status"] = "success"
            result["result"] = str(agent_result)
        except Exception as e:
            result["status"] = "failed"
            result["error"] = str(e)
            self.errors.append({"phase": "process_single", "error": str(e), "time": datetime.now()})

        return result

    # ================= EMAIL SUMMARY =================
    async def get_email_summary(self, count: int = 5) -> Dict:
        """Get an AI-generated summary of recent/unread emails"""
        logger.info(f"🤖 Getting summary of {count} recent emails...")

        prompt = f"""
TASK: Summarize my recent emails and identify action items.

STEP 1: Go to {Config.INBOX_URL}
- Look at the {count} most recent unread emails (or all recent if fewer unread)

STEP 2: For each email, note:
- Sender
- Subject
- Brief summary (1-2 sentences)
- Any action required? (Yes/No)
- Urgency level (High/Medium/Low)

STEP 3: Provide a summary report:

📧 EMAIL SUMMARY
================
Total emails reviewed: [number]

🔴 HIGH PRIORITY:
[List any urgent emails with action needed]

🟡 MEDIUM PRIORITY:
[List emails that need attention soon]

🟢 LOW PRIORITY / FYI:
[List informational emails]

📋 ACTION ITEMS:
1. [First action needed]
2. [Second action needed]
...

Provide this summary now.
"""

        result = {"status": "unknown", "error": None}

        try:
            agent = Agent(task=prompt, llm=self.llm, browser_profile=self.browser_profile)
            agent_result = await agent.run()
            result["status"] = "success"
            result["summary"] = str(agent_result)
        except Exception as e:
            result["status"] = "failed"
            result["error"] = str(e)

        return result

    # ================= HELPER: LOG TO SHEET =================
    def _log_to_sheet(self, result: Dict):
        """Log sync result to Google Sheet (if enabled)"""
        if not self.sheets_enabled:
            return

        try:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            row = [timestamp, result.get("status", ""), str(result.get("result", ""))[:500]]
            self.worksheet.append_row(row)
            logger.info("   📝 Logged to Google Sheet")
        except Exception as e:
            logger.warning(f"   ⚠️ Could not log to sheet: {e}")

    # ================= MAIN LOOP =================
    async def run_cycle(self):
        """Run a single sync cycle"""
        self.sync_count += 1
        logger.info(f"\n{'='*50}")
        logger.info(f"SYNC CYCLE #{self.sync_count} - {datetime.now()}")
        logger.info(f"{'='*50}")

        # Run the smart sync
        result = await self.run_smart_sync()

        self.last_sync = datetime.now()

        return {
            "cycle": self.sync_count,
            "result": result,
            "timestamp": self.last_sync
        }

    async def run_continuous(self):
        """Run continuous sync loop"""
        logger.info("🚀 Starting continuous sync mode...")
        logger.info(f"   Interval: {Config.SYNC_INTERVAL_SECONDS} seconds")

        while True:
            try:
                await self.run_cycle()
            except Exception as e:
                logger.error(f"Cycle failed: {e}")

            logger.info(f"\n💤 Sleeping for {Config.SYNC_INTERVAL_SECONDS // 60} minutes...")
            await asyncio.sleep(Config.SYNC_INTERVAL_SECONDS)

    def get_status(self) -> Dict:
        """Get current sync status"""
        return {
            "last_sync": self.last_sync.isoformat() if self.last_sync else None,
            "sync_count": self.sync_count,
            "error_count": len(self.errors),
            "sheets_enabled": self.sheets_enabled,
            "recent_errors": self.errors[-5:] if self.errors else []
        }


# ================= CLI ENTRY POINT =================
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Outlook Smart Sync")
    parser.add_argument("--once", action="store_true", help="Run single sync cycle")
    parser.add_argument("--summary", action="store_true", help="Get email summary")
    parser.add_argument("--process", type=str, help="Process specific email by search term")
    args = parser.parse_args()

    sync = OutlookStateSync()

    if args.summary:
        result = asyncio.run(sync.get_email_summary())
        print(result.get("summary", result))
    elif args.process:
        result = asyncio.run(sync.process_single_email(args.process))
        print(result)
    elif args.once:
        asyncio.run(sync.run_cycle())
    else:
        asyncio.run(sync.run_continuous())
