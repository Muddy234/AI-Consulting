"""
Outlook State Sync - AI-Powered Email & Calendar Manager
=========================================================
Phase 1 (Auditor): Selenium scrapes flagged emails → Google Sheet
Phase 2 (Enforcer): AI Agent syncs Sheet → Outlook Calendar
"""

import os
import time
import hashlib
import re
import logging
import asyncio
from datetime import datetime
from typing import List, Dict, Optional

import gspread
from google.oauth2 import service_account

# Selenium imports
from selenium import webdriver
from selenium.webdriver.edge.options import Options as EdgeOptions
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# Browser-use imports (native - no LangChain wrapper needed)
from browser_use import Agent
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
    EDGE_EXE_PATH = os.getenv("EDGE_EXE_PATH", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    PROFILE_DIRECTORY = os.getenv("EDGE_PROFILE", "Default")

    # API Keys (prefer environment variables)
    GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")

    # Google Sheet URL
    SHEET_URL = os.getenv("SHEET_URL", "")
    SERVICE_ACCOUNT_FILE = os.getenv("SERVICE_ACCOUNT_FILE", "service_account.json")

    # Outlook URLs
    FLAGGED_FOLDER = "https://outlook.office.com/mail/flaggedemail"
    CALENDAR_URL = "https://outlook.office.com/calendar/view/week"

    # Timing
    SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL", 900))  # 15 minutes
    MAX_RETRIES = 3
    RETRY_DELAY = 5


# Set API key in environment
os.environ["GOOGLE_API_KEY"] = Config.GOOGLE_API_KEY


# ================= TASK DATA CLASS =================
class FlaggedTask:
    def __init__(self, task_id: str, description: str, status: str = "Active"):
        self.id = task_id
        self.description = description
        self.status = status
        self.created_at = datetime.now()

    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "description": self.description,
            "status": self.status
        }

    def to_row(self) -> List[str]:
        return [self.id, self.description, self.status]


# ================= MAIN CLASS =================
class OutlookStateSync:
    def __init__(self):
        logger.info("Initializing Outlook State Sync System...")

        # Initialize LLM (browser_use native - not LangChain)
        self.llm = ChatGoogle(model="gemini-2.0-flash")

        # Initialize Google Sheets connection
        self._init_sheets()

        # State tracking
        self.last_sync = None
        self.sync_count = 0
        self.errors = []

    def _init_sheets(self):
        """Initialize Google Sheets connection with error handling"""
        try:
            self.creds = service_account.Credentials.from_service_account_file(
                Config.SERVICE_ACCOUNT_FILE,
                scopes=['https://www.googleapis.com/auth/spreadsheets']
            )
            self.gc = gspread.authorize(self.creds)
            self.sh = self.gc.open_by_url(Config.SHEET_URL)
            self.worksheet = self.sh.sheet1
            logger.info("✅ Connected to Google Sheet")
        except FileNotFoundError:
            logger.error(f"Service account file not found: {Config.SERVICE_ACCOUNT_FILE}")
            raise
        except Exception as e:
            logger.error(f"Failed to connect to Google Sheets: {e}")
            raise

    # ================= PHASE 1: AUDITOR (Selenium) =================
    def run_auditor(self) -> List[FlaggedTask]:
        """
        Scans the Outlook 'Flagged' folder using Selenium.
        Returns list of FlaggedTask objects.
        """
        logger.info("🕵️ AUDITOR: Starting flagged email scan...")
        tasks_found = []
        driver = None

        try:
            # Configure Edge browser
            options = EdgeOptions()
            options.add_argument(f"user-data-dir={Config.EDGE_PATH}")
            options.add_argument(f"--profile-directory={Config.PROFILE_DIRECTORY}")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            # options.add_argument("--headless")  # Uncomment for headless mode

            driver = webdriver.Edge(options=options)
            wait = WebDriverWait(driver, 15)

            # Navigate to flagged folder
            logger.info(f"   Navigating to: {Config.FLAGGED_FOLDER}")
            driver.get(Config.FLAGGED_FOLDER)

            # Wait for email list to load
            wait.until(EC.presence_of_element_located((By.XPATH, "//div[@role='option']")))
            time.sleep(3)  # Allow list to settle

            # Scrape flagged items
            email_items = driver.find_elements(By.XPATH, "//div[@role='option']")
            logger.info(f"   Found {len(email_items)} flagged items")

            for item in email_items:
                try:
                    raw_text = item.get_attribute("aria-label") or item.text
                    clean_text = self._clean_text(raw_text)

                    if clean_text:
                        task_id = hashlib.md5(clean_text.encode()).hexdigest()[:10]
                        tasks_found.append(FlaggedTask(task_id, clean_text))
                except Exception as e:
                    logger.debug(f"   Skipped item: {e}")
                    continue

            logger.info(f"   ✅ Auditor found {len(tasks_found)} valid tasks")

        except Exception as e:
            logger.error(f"   ❌ Auditor failed: {e}")
            self.errors.append({"phase": "auditor", "error": str(e), "time": datetime.now()})
        finally:
            if driver:
                driver.quit()
                logger.info("   Browser closed")

        # Update Google Sheet
        self._update_sheet(tasks_found)
        return tasks_found

    def _clean_text(self, text: str) -> str:
        """Clean email metadata from text"""
        if not text:
            return ""

        # Remove common Outlook metadata
        junk_patterns = [
            r"Flagged,?", r"Unread,?", r"Read,?", r"Selected,?",
            r"High importance,?", r"Low importance,?",
            r"\d{1,2}:\d{2}\s*(AM|PM)?",  # Times
            r"\d{1,2}/\d{1,2}/\d{2,4}",   # Dates
        ]

        for pattern in junk_patterns:
            text = re.sub(pattern, "", text, flags=re.IGNORECASE)

        return text.strip()[:100]  # Truncate to 100 chars

    def _update_sheet(self, tasks: List[FlaggedTask]):
        """Update Google Sheet with current tasks"""
        logger.info("   📝 Updating Google Sheet...")

        try:
            self.worksheet.clear()

            # Headers
            headers = ["ID", "Task Description", "Status", "Last Updated"]
            rows = [headers]

            # Task rows
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
            for task in tasks:
                rows.append([task.id, task.description, task.status, timestamp])

            self.worksheet.update(values=rows, range_name='A1')
            logger.info(f"   ✅ Sheet updated with {len(tasks)} tasks")

        except Exception as e:
            logger.error(f"   ❌ Failed to update sheet: {e}")
            self.errors.append({"phase": "sheet_update", "error": str(e), "time": datetime.now()})

    # ================= PHASE 2: ENFORCER (AI Agent) =================
    async def run_enforcer(self, tasks: List[FlaggedTask]) -> Dict:
        """
        Uses AI Agent to sync tasks with Outlook Calendar.
        Returns result dictionary.
        """
        logger.info("🤖 ENFORCER: Starting calendar sync...")

        if not tasks:
            logger.info("   No tasks to sync. Skipping enforcer.")
            return {"status": "skipped", "reason": "no_tasks"}

        # Build task list for AI
        task_list_str = "\n".join([f"- 🤖 {t.description}" for t in tasks])

        prompt = f"""
MISSION: Synchronize my Outlook Calendar with my Task List.

STEP 1: Navigate to {Config.CALENDAR_URL}
STEP 2: Review all events for THIS WEEK

MY TASK LIST (Source of Truth):
{task_list_str}

RULES:
1. SAFETY: Only modify events that start with "🤖" emoji. Never touch other events.
2. DELETE: Remove any "🤖" calendar events NOT in the list above.
3. CREATE: Add missing tasks as new events (schedule for 9:00 AM tomorrow, 30 min duration).
4. REPORT: List all changes made (created/deleted events).

Begin now.
"""

        result = {"status": "unknown", "changes": [], "error": None}

        for attempt in range(Config.MAX_RETRIES):
            try:
                logger.info(f"   Attempt {attempt + 1}/{Config.MAX_RETRIES}")

                agent = Agent(
                    task=prompt,
                    llm=self.llm
                )

                agent_result = await agent.run()

                result["status"] = "success"
                result["result"] = str(agent_result)
                result["attempts"] = attempt + 1

                logger.info("   ✅ Enforcer completed successfully")
                break

            except Exception as e:
                logger.warning(f"   ⚠️ Attempt {attempt + 1} failed: {e}")
                result["error"] = str(e)

                if attempt < Config.MAX_RETRIES - 1:
                    await asyncio.sleep(Config.RETRY_DELAY)
                else:
                    result["status"] = "failed"
                    self.errors.append({"phase": "enforcer", "error": str(e), "time": datetime.now()})

        return result

    # ================= MAIN LOOP =================
    async def run_cycle(self):
        """Run a single audit → enforce cycle"""
        self.sync_count += 1
        logger.info(f"\n{'='*50}")
        logger.info(f"SYNC CYCLE #{self.sync_count} - {datetime.now()}")
        logger.info(f"{'='*50}")

        # Phase 1: Auditor
        tasks = self.run_auditor()

        # Brief pause between phases
        await asyncio.sleep(5)

        # Phase 2: Enforcer
        result = await self.run_enforcer(tasks)

        self.last_sync = datetime.now()

        return {
            "cycle": self.sync_count,
            "tasks_found": len(tasks),
            "enforcer_result": result,
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
            "recent_errors": self.errors[-5:] if self.errors else []
        }


# ================= CLI ENTRY POINT =================
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Outlook State Sync")
    parser.add_argument("--once", action="store_true", help="Run single cycle only")
    args = parser.parse_args()

    sync = OutlookStateSync()

    if args.once:
        asyncio.run(sync.run_cycle())
    else:
        asyncio.run(sync.run_continuous())
