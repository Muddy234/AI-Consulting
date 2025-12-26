"""
Telegram Bot Interface for AI Agent
====================================
Control your AI agent via Telegram messages.

Commands:
  /todo - Sync flagged emails to calendar
  /buy <item> [under $XX] - Search Amazon and add to cart
  /reserve <restaurant/cuisine> <date> <time> <party size> - Book reservation
  /research <topic> - Research a topic
  /compare <item> - Compare prices across sites
  /status - Check agent status
  /help - Show available commands
"""

import os
import sys
import asyncio
import logging
import re
from datetime import datetime, timedelta
from typing import Optional

# Load environment variables from .env file FIRST
from pathlib import Path
from dotenv import load_dotenv

# Get the directory where this script is located
SCRIPT_DIR = Path(__file__).parent.resolve()
ENV_FILE = SCRIPT_DIR / ".env"

print(f"📂 Looking for .env at: {ENV_FILE}")

# Load .env from the script's directory
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)
    print(f"✅ Loaded .env file successfully!")
    # Debug: show what was loaded (masked)
    api_key = os.getenv("GOOGLE_API_KEY", "")
    if api_key:
        print(f"   GOOGLE_API_KEY: {api_key[:10]}...{api_key[-4:]}")
    else:
        print("   ⚠️ GOOGLE_API_KEY is empty in .env file!")
else:
    print(f"❌ ERROR: .env file NOT FOUND!")
    print(f"   Please create a file called '.env' at:")
    print(f"   {ENV_FILE}")
    print(f"   With your API keys inside.")
    load_dotenv()  # Try default locations anyway

# Fix Windows console encoding
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    os.environ['PYTHONIOENCODING'] = 'utf-8'

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

# Import our task runner and planner
from agent_tasks import AgentTaskRunner
from task_planner import TaskPlanner, TaskType, plan_and_describe

# ================= CONFIGURATION =================
class Config:
    # Telegram Bot Token (from @BotFather)
    BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "8546821678:AAHeYC6HUBvbTaZ4vUu4y2IgOjMRCIWkPQU")

    # Authorized User ID (only this user can control the bot)
    AUTHORIZED_USER_ID = int(os.getenv("TELEGRAM_USER_ID", "8574496788"))

    # User's name for personalized responses
    USER_NAME = os.getenv("TELEGRAM_USER_NAME", "Nate")


# ================= LOGGING =================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler('telegram_bot.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


# ================= BOT CLASS =================
class AIAgentBot:
    def __init__(self):
        self.task_runner = AgentTaskRunner()
        self.planner = TaskPlanner()
        self.current_task = None
        self.current_plan = None
        self.task_start_time = None
        self.use_planner = True  # Can be toggled with /planner command

    def is_authorized(self, user_id: int) -> bool:
        """Check if user is authorized to use the bot."""
        return user_id == Config.AUTHORIZED_USER_ID

    async def plan_and_execute(self, update: Update, user_request: str, task_type: TaskType = None) -> dict:
        """
        Plan a task using AI, show the plan to the user, and execute it.

        Args:
            update: Telegram update for sending messages
            user_request: The user's original request
            task_type: Optional task type hint

        Returns:
            Dict with execution result
        """
        try:
            # Phase 1: Create the plan
            await update.message.reply_text("🧠 Analyzing your request...")
            plan = await self.planner.plan_task(user_request, task_type)
            self.current_plan = plan

            # Phase 2: Show plan summary to user
            plan_summary = self._format_plan_summary(plan)
            await update.message.reply_text(plan_summary, parse_mode='Markdown')

            # Phase 3: Execute with enhanced prompt
            await update.message.reply_text("🚀 Executing plan...")
            result = await self.task_runner.run_with_prompt(plan.enhanced_prompt)

            # Phase 4: Verify result
            if result["status"] == "success":
                verification = await self.planner.verify_result(plan, result.get("result", ""))
                result["verification"] = verification

                if verification.get("success") is True:
                    result["verified"] = True
                    result["verification_summary"] = verification.get("summary", "Task completed successfully")
                elif verification.get("success") is False:
                    result["verified"] = False
                    result["verification_summary"] = f"Some criteria not met: {', '.join(verification.get('criteria_not_met', []))}"
                else:
                    result["verified"] = None
                    result["verification_summary"] = "Could not verify automatically"

            return result

        except Exception as e:
            logger.error(f"Error in plan_and_execute: {e}")
            return {"status": "error", "message": str(e)}

    def _format_plan_summary(self, plan) -> str:
        """Format a plan into a readable summary for Telegram."""
        steps_text = "\n".join([f"  {s.step_number}. {s.action}" for s in plan.steps[:5]])
        if len(plan.steps) > 5:
            steps_text += f"\n  ... and {len(plan.steps) - 5} more steps"

        criteria_text = "\n".join([f"  ✓ {c}" for c in plan.success_criteria[:3]])

        issues_text = ""
        if plan.potential_issues:
            top_issues = [i for i in plan.potential_issues if i.likelihood in ["high", "medium"]][:2]
            if top_issues:
                issues_text = "\n\n⚠️ **Watching for:**\n" + "\n".join([f"  • {i.issue}" for i in top_issues])

        return f"""📋 **Task Plan** (ID: {plan.task_id})

**Goal:** {plan.interpreted_goal}

**Steps:**
{steps_text}

**Success Criteria:**
{criteria_text}

**Estimated Time:** {plan.estimated_duration}{issues_text}
"""

    async def send_unauthorized_message(self, update: Update):
        """Send message to unauthorized users."""
        await update.message.reply_text(
            "⛔ Sorry, this bot is private and only responds to its owner."
        )
        logger.warning(f"Unauthorized access attempt from user {update.effective_user.id}")

    # ================= COMMAND HANDLERS =================

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /start command."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        await update.message.reply_text(
            f"👋 Hey {Config.USER_NAME}! I'm your AI Agent assistant.\n\n"
            "I can help you with:\n"
            "• 📧 /todo - Sync flagged emails to calendar\n"
            "• 🛒 /buy <item> - Add items to Amazon cart\n"
            "• 🍽️ /reserve - Book restaurant reservations\n"
            "• 🔍 /research <topic> - Research topics\n"
            "• 💰 /compare <item> - Compare prices\n"
            "• ❓ /help - Show all commands\n\n"
            "Or just tell me what you need in plain English!"
        )

    async def help_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /help command."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        planner_status = "ON" if self.use_planner else "OFF"
        help_text = f"""
🤖 **AI Agent Commands**

**Email & Calendar:**
• `/todo` - Sync flagged emails to your calendar

**Shopping:**
• `/buy <item>` - Search Amazon and add to cart
• `/buy <item> under $XX` - With price limit
• `/compare <item>` - Compare prices across sites

**Reservations:**
• `/reserve <restaurant> <date> <time> for <N>`
• Example: `/reserve Nobu tomorrow 7pm for 4`

**Research:**
• `/research <topic>` - Research and compile report

**Status & Settings:**
• `/status` - Check if agent is running
• `/planner` - Toggle AI planner (currently: **{planner_status}**)
• `/cancel` - Cancel current task

**Natural Language:**
You can also just tell me what you need:
• "Add AirPods to my cart"
• "Book a table at a nice Italian place for 2"
• "Research best CRM tools"

**AI Planner Mode** ({planner_status}):
When ON, I analyze your request first, create a detailed plan with steps and fallbacks, then execute smarter. Toggle with /planner.
"""
        await update.message.reply_text(help_text, parse_mode='Markdown')

    async def planner_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /planner command - toggle AI planning mode."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        self.use_planner = not self.use_planner
        status = "ON" if self.use_planner else "OFF"

        if self.use_planner:
            await update.message.reply_text(
                f"🧠 **AI Planner: {status}**\n\n"
                "I will now analyze your requests before executing:\n"
                "• Create detailed step-by-step plans\n"
                "• Anticipate potential issues\n"
                "• Define success criteria\n"
                "• Verify results after completion\n\n"
                "Tasks will be smarter but take slightly longer to start.",
                parse_mode='Markdown'
            )
        else:
            await update.message.reply_text(
                f"⚡ **AI Planner: {status}**\n\n"
                "Switching to direct execution mode.\n"
                "Tasks will start immediately with basic prompts.\n\n"
                "Use `/planner` to re-enable smart planning.",
                parse_mode='Markdown'
            )

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /status command."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        planner_status = "🧠 ON" if self.use_planner else "⚡ OFF"

        if self.current_task:
            elapsed = datetime.now() - self.task_start_time
            plan_info = ""
            if self.current_plan:
                plan_info = f"\n📋 **Plan ID:** {self.current_plan.task_id}\n🎯 **Goal:** {self.current_plan.interpreted_goal[:100]}..."

            await update.message.reply_text(
                f"🔄 **Currently running:** {self.current_task}\n"
                f"⏱️ **Elapsed time:** {elapsed.seconds // 60}m {elapsed.seconds % 60}s\n"
                f"🤖 **AI Planner:** {planner_status}{plan_info}",
                parse_mode='Markdown'
            )
        else:
            await update.message.reply_text(
                f"✅ Agent is idle and ready for tasks.\n"
                f"🤖 **AI Planner:** {planner_status}",
                parse_mode='Markdown'
            )

    async def todo_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /todo command - sync flagged emails to calendar."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        # Build full request for planner
        full_request = "Sync all flagged emails from my Outlook inboxes (Main, Becky, Tyler) to a single consolidated calendar event titled '🤖 {To-Do List}' scheduled for tomorrow at 7 AM"

        self.current_task = "Email To-Do Sync"
        self.task_start_time = datetime.now()

        try:
            if self.use_planner:
                # Use AI planner for smarter execution
                result = await self.plan_and_execute(update, full_request, TaskType.EMAIL_SYNC)
            else:
                # Fall back to basic execution
                await update.message.reply_text("📧 Starting email-to-calendar sync...\nThis may take a few minutes.")
                result = await self.task_runner.run_task("email_todo")

            if result["status"] == "success":
                verified_text = ""
                if result.get("verified") is True:
                    verified_text = "\n✅ **Verified:** " + result.get("verification_summary", "")
                elif result.get("verified") is False:
                    verified_text = "\n⚠️ **Note:** " + result.get("verification_summary", "")

                await update.message.reply_text(
                    f"✅ **Email sync complete!**{verified_text}\n\n"
                    f"Check your calendar for tomorrow's To-Do List.",
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(
                    f"⚠️ Task completed with issues:\n{result.get('message', 'Unknown error')}"
                )
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
            logger.error(f"Error in todo_command: {e}")
        finally:
            self.current_task = None
            self.current_plan = None
            self.task_start_time = None

    async def buy_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /buy command - Amazon purchase."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        # Parse the command
        text = ' '.join(context.args) if context.args else ''

        if not text:
            await update.message.reply_text(
                "Please specify what to buy.\n"
                "Example: `/buy USB-C cable under $15`",
                parse_mode='Markdown'
            )
            return

        # Extract price limit if specified
        max_price = None
        price_match = re.search(r'under\s*\$?(\d+(?:\.\d{2})?)', text, re.IGNORECASE)
        if price_match:
            max_price = float(price_match.group(1))

        # Build full request for planner
        full_request = f"Buy {text} on Amazon and add to cart (don't complete purchase)"
        if max_price:
            full_request += f". Maximum budget: ${max_price}"

        self.current_task = f"Amazon: {text}"
        self.task_start_time = datetime.now()

        try:
            if self.use_planner:
                # Use AI planner for smarter execution
                result = await self.plan_and_execute(update, full_request, TaskType.SHOPPING)
            else:
                # Fall back to basic execution
                await update.message.reply_text(f"🛒 Searching Amazon for: **{text}**", parse_mode='Markdown')
                item_text = re.sub(r'under\s*\$?\d+(?:\.\d{2})?', '', text, flags=re.IGNORECASE).strip()
                result = await self.task_runner.run_task(
                    "amazon_purchase",
                    item_description=item_text,
                    max_price=max_price,
                    add_to_cart_only=True
                )

            if result["status"] == "success":
                verified_text = ""
                if result.get("verified") is True:
                    verified_text = "\n✅ **Verified:** " + result.get("verification_summary", "")
                elif result.get("verified") is False:
                    verified_text = "\n⚠️ **Note:** " + result.get("verification_summary", "")

                await update.message.reply_text(
                    f"✅ **Done!** Check your Amazon cart.{verified_text}\n\n"
                    f"{result.get('result', '')[:500]}",
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(f"⚠️ {result.get('message', 'Could not complete task')}")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
            logger.error(f"Error in buy_command: {e}")
        finally:
            self.current_task = None
            self.current_plan = None

    async def reserve_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /reserve command - OpenTable reservation."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        text = ' '.join(context.args) if context.args else ''

        if not text:
            await update.message.reply_text(
                "Please specify reservation details.\n"
                "Example: `/reserve Nobu tomorrow 7pm for 4`\n"
                "Or: `/reserve Italian restaurant downtown tomorrow 7pm for 2`",
                parse_mode='Markdown'
            )
            return

        # Parse reservation details for display
        party_match = re.search(r'for\s*(\d+)', text, re.IGNORECASE)
        party_size = int(party_match.group(1)) if party_match else 2

        time_match = re.search(r'(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)', text, re.IGNORECASE)
        time = time_match.group(1) if time_match else "7:00 PM"

        # Check for "tomorrow" or specific date
        if 'tomorrow' in text.lower():
            date = (datetime.now() + timedelta(days=1)).strftime("%B %d, %Y")
        else:
            date_match = re.search(r'(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}', text, re.IGNORECASE)
            date = date_match.group(0) if date_match else (datetime.now() + timedelta(days=1)).strftime("%B %d, %Y")

        # Extract restaurant/cuisine
        restaurant = re.sub(r'(tomorrow|for\s*\d+|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)', '', text, flags=re.IGNORECASE).strip()

        # Build full request for planner
        full_request = f"Book a reservation at {restaurant} on {date} at {time} for {party_size} people using OpenTable"

        self.current_task = f"Reservation: {restaurant}"
        self.task_start_time = datetime.now()

        try:
            if self.use_planner:
                # Use AI planner for smarter execution
                result = await self.plan_and_execute(update, full_request, TaskType.RESERVATION)
            else:
                # Fall back to basic execution
                await update.message.reply_text(
                    f"🍽️ Booking reservation:\n• **Where:** {restaurant}\n• **When:** {date} at {time}\n• **Party size:** {party_size}",
                    parse_mode='Markdown'
                )
                result = await self.task_runner.run_task(
                    "opentable_reservation",
                    restaurant_name=restaurant,
                    date=date,
                    time=time,
                    party_size=party_size
                )

            if result["status"] == "success":
                verified_text = ""
                if result.get("verified") is True:
                    verified_text = "\n✅ **Verified:** " + result.get("verification_summary", "")
                elif result.get("verified") is False:
                    verified_text = "\n⚠️ **Note:** " + result.get("verification_summary", "")

                await update.message.reply_text(
                    f"✅ **Reservation complete!**{verified_text}\n\n{result.get('result', '')[:500]}",
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(f"⚠️ {result.get('message', 'Could not complete reservation')}")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
            logger.error(f"Error in reserve_command: {e}")
        finally:
            self.current_task = None
            self.current_plan = None

    async def research_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /research command."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        topic = ' '.join(context.args) if context.args else ''

        if not topic:
            await update.message.reply_text(
                "Please specify a topic.\n"
                "Example: `/research best CRM software for small business`",
                parse_mode='Markdown'
            )
            return

        # Build full request for planner
        full_request = f"Research {topic} and compile a detailed report with findings from multiple credible sources"

        self.current_task = f"Research: {topic}"
        self.task_start_time = datetime.now()

        try:
            if self.use_planner:
                # Use AI planner for smarter execution
                result = await self.plan_and_execute(update, full_request, TaskType.RESEARCH)
            else:
                # Fall back to basic execution
                await update.message.reply_text(
                    f"🔍 Researching: **{topic}**\n\nI'll compile a report from multiple sources...",
                    parse_mode='Markdown'
                )
                result = await self.task_runner.run_task("web_research", topic=topic)

            if result["status"] == "success":
                verified_text = ""
                if result.get("verified") is True:
                    verified_text = "✅ **Verified:** " + result.get("verification_summary", "") + "\n\n"
                elif result.get("verified") is False:
                    verified_text = "⚠️ **Note:** " + result.get("verification_summary", "") + "\n\n"

                # Send result (may need to split if too long)
                response = result.get('result', 'Research complete')
                header = f"📋 **Research Results:**\n\n{verified_text}"

                if len(header + response) > 4000:
                    await update.message.reply_text(header, parse_mode='Markdown')
                    # Split into chunks
                    for i in range(0, len(response), 4000):
                        await update.message.reply_text(response[i:i+4000])
                else:
                    await update.message.reply_text(header + response, parse_mode='Markdown')
            else:
                await update.message.reply_text(f"⚠️ {result.get('message', 'Could not complete research')}")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
            logger.error(f"Error in research_command: {e}")
        finally:
            self.current_task = None
            self.current_plan = None

    async def compare_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /compare command - price comparison."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        item = ' '.join(context.args) if context.args else ''

        if not item:
            await update.message.reply_text(
                "Please specify an item to compare.\n"
                "Example: `/compare Sony WH-1000XM5 headphones`",
                parse_mode='Markdown'
            )
            return

        # Build full request for planner
        full_request = f"Compare prices for {item} across Amazon, Walmart, Target, and Best Buy. Include shipping costs and create a comparison table."

        self.current_task = f"Price comparison: {item}"
        self.task_start_time = datetime.now()

        try:
            if self.use_planner:
                # Use AI planner for smarter execution
                result = await self.plan_and_execute(update, full_request, TaskType.PRICE_COMPARISON)
            else:
                # Fall back to basic execution
                await update.message.reply_text(
                    f"💰 Comparing prices for: **{item}**\n\nChecking Amazon, Walmart, Target, Best Buy...",
                    parse_mode='Markdown'
                )
                result = await self.task_runner.run_task("price_comparison", item_description=item)

            if result["status"] == "success":
                verified_text = ""
                if result.get("verified") is True:
                    verified_text = "\n✅ **Verified:** " + result.get("verification_summary", "")
                elif result.get("verified") is False:
                    verified_text = "\n⚠️ **Note:** " + result.get("verification_summary", "")

                await update.message.reply_text(
                    f"📊 **Price Comparison:**{verified_text}\n\n{result.get('result', '')[:4000]}",
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(f"⚠️ {result.get('message', 'Could not complete comparison')}")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
            logger.error(f"Error in compare_command: {e}")
        finally:
            self.current_task = None
            self.current_plan = None

    # ================= NATURAL LANGUAGE HANDLER =================

    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle natural language messages."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        text = update.message.text.lower()

        # Detect intent from natural language
        if any(word in text for word in ['todo', 'email', 'flagged', 'calendar sync', 'inbox']):
            await self.todo_command(update, context)

        elif any(word in text for word in ['buy', 'purchase', 'order', 'add to cart', 'amazon']):
            # Extract item from message
            item = re.sub(r'(can you |please |buy |purchase |order |add |to cart|to my cart|on amazon|from amazon)', '', text, flags=re.IGNORECASE).strip()
            context.args = item.split()
            await self.buy_command(update, context)

        elif any(word in text for word in ['reserve', 'reservation', 'book', 'table', 'restaurant', 'dinner', 'lunch']):
            context.args = text.split()
            await self.reserve_command(update, context)

        elif any(word in text for word in ['research', 'look up', 'find out', 'learn about']):
            topic = re.sub(r'(can you |please |research |look up |find out about |learn about )', '', text, flags=re.IGNORECASE).strip()
            context.args = topic.split()
            await self.research_command(update, context)

        elif any(word in text for word in ['compare', 'price', 'cheapest', 'best deal']):
            item = re.sub(r'(compare |price for |find cheapest |best deal on |prices for )', '', text, flags=re.IGNORECASE).strip()
            context.args = item.split()
            await self.compare_command(update, context)

        else:
            await update.message.reply_text(
                "🤔 I'm not sure what you're asking for.\n\n"
                "Try one of these:\n"
                "• `/todo` - Sync emails to calendar\n"
                "• `/buy <item>` - Amazon shopping\n"
                "• `/reserve <details>` - Book restaurant\n"
                "• `/research <topic>` - Research something\n"
                "• `/help` - See all commands"
            )


# ================= MAIN =================
def main():
    """Start the Telegram bot."""
    logger.info("🤖 Starting AI Agent Telegram Bot...")
    logger.info(f"   Authorized user: {Config.AUTHORIZED_USER_ID}")

    # Create bot instance
    bot = AIAgentBot()

    # Create application
    application = Application.builder().token(Config.BOT_TOKEN).build()

    # Add command handlers
    application.add_handler(CommandHandler("start", bot.start))
    application.add_handler(CommandHandler("help", bot.help_command))
    application.add_handler(CommandHandler("status", bot.status))
    application.add_handler(CommandHandler("planner", bot.planner_command))
    application.add_handler(CommandHandler("todo", bot.todo_command))
    application.add_handler(CommandHandler("buy", bot.buy_command))
    application.add_handler(CommandHandler("reserve", bot.reserve_command))
    application.add_handler(CommandHandler("research", bot.research_command))
    application.add_handler(CommandHandler("compare", bot.compare_command))

    # Add natural language message handler
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, bot.handle_message))

    # Start the bot
    logger.info("🚀 Bot is running! Send a message to your bot on Telegram.")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
