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

# Fix Windows console encoding
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    os.environ['PYTHONIOENCODING'] = 'utf-8'

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

# Import our task runner
from agent_tasks import AgentTaskRunner

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
        self.current_task = None
        self.task_start_time = None

    def is_authorized(self, user_id: int) -> bool:
        """Check if user is authorized to use the bot."""
        return user_id == Config.AUTHORIZED_USER_ID

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

        help_text = """
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

**Status:**
• `/status` - Check if agent is running
• `/cancel` - Cancel current task

**Natural Language:**
You can also just tell me what you need:
• "Add AirPods to my cart"
• "Book a table at a nice Italian place for 2"
• "Research best CRM tools"
"""
        await update.message.reply_text(help_text, parse_mode='Markdown')

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /status command."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        if self.current_task:
            elapsed = datetime.now() - self.task_start_time
            await update.message.reply_text(
                f"🔄 **Currently running:** {self.current_task}\n"
                f"⏱️ **Elapsed time:** {elapsed.seconds // 60}m {elapsed.seconds % 60}s",
                parse_mode='Markdown'
            )
        else:
            await update.message.reply_text("✅ Agent is idle and ready for tasks.")

    async def todo_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /todo command - sync flagged emails to calendar."""
        if not self.is_authorized(update.effective_user.id):
            await self.send_unauthorized_message(update)
            return

        await update.message.reply_text("📧 Starting email-to-calendar sync...\nThis may take a few minutes.")

        self.current_task = "Email To-Do Sync"
        self.task_start_time = datetime.now()

        try:
            # Run the task
            result = await self.task_runner.run_task("email_todo")

            if result["status"] == "success":
                await update.message.reply_text(
                    "✅ **Email sync complete!**\n\n"
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
            text = re.sub(r'under\s*\$?\d+(?:\.\d{2})?', '', text, flags=re.IGNORECASE).strip()

        await update.message.reply_text(
            f"🛒 Searching Amazon for: **{text}**\n"
            f"{'💰 Max price: $' + str(max_price) if max_price else ''}\n\n"
            "I'll add it to your cart (won't complete purchase).",
            parse_mode='Markdown'
        )

        self.current_task = f"Amazon: {text}"
        self.task_start_time = datetime.now()

        try:
            result = await self.task_runner.run_task(
                "amazon_purchase",
                item_description=text,
                max_price=max_price,
                add_to_cart_only=True
            )

            if result["status"] == "success":
                await update.message.reply_text(
                    f"✅ **Done!** Check your Amazon cart.\n\n"
                    f"{result.get('result', '')[:500]}",
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(f"⚠️ {result.get('message', 'Could not complete task')}")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
        finally:
            self.current_task = None

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

        # Parse reservation details
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

        # Extract restaurant/cuisine (everything before time/date/party info)
        restaurant = re.sub(r'(tomorrow|for\s*\d+|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)', '', text, flags=re.IGNORECASE).strip()

        await update.message.reply_text(
            f"🍽️ Booking reservation:\n"
            f"• **Where:** {restaurant}\n"
            f"• **When:** {date} at {time}\n"
            f"• **Party size:** {party_size}\n\n"
            "Working on it...",
            parse_mode='Markdown'
        )

        self.current_task = f"Reservation: {restaurant}"
        self.task_start_time = datetime.now()

        try:
            result = await self.task_runner.run_task(
                "opentable_reservation",
                restaurant_name=restaurant,
                date=date,
                time=time,
                party_size=party_size
            )

            if result["status"] == "success":
                await update.message.reply_text(
                    f"✅ **Reservation complete!**\n\n{result.get('result', '')[:500]}",
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(f"⚠️ {result.get('message', 'Could not complete reservation')}")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
        finally:
            self.current_task = None

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

        await update.message.reply_text(
            f"🔍 Researching: **{topic}**\n\n"
            "I'll compile a report from multiple sources...",
            parse_mode='Markdown'
        )

        self.current_task = f"Research: {topic}"
        self.task_start_time = datetime.now()

        try:
            result = await self.task_runner.run_task("web_research", topic=topic)

            if result["status"] == "success":
                # Send result (may need to split if too long)
                response = result.get('result', 'Research complete')
                if len(response) > 4000:
                    # Split into chunks
                    for i in range(0, len(response), 4000):
                        await update.message.reply_text(response[i:i+4000])
                else:
                    await update.message.reply_text(f"📋 **Research Results:**\n\n{response}", parse_mode='Markdown')
            else:
                await update.message.reply_text(f"⚠️ {result.get('message', 'Could not complete research')}")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
        finally:
            self.current_task = None

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

        await update.message.reply_text(
            f"💰 Comparing prices for: **{item}**\n\n"
            "Checking Amazon, Walmart, Target, Best Buy...",
            parse_mode='Markdown'
        )

        self.current_task = f"Price comparison: {item}"
        self.task_start_time = datetime.now()

        try:
            result = await self.task_runner.run_task("price_comparison", item_description=item)

            if result["status"] == "success":
                await update.message.reply_text(
                    f"📊 **Price Comparison:**\n\n{result.get('result', '')[:4000]}",
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text(f"⚠️ {result.get('message', 'Could not complete comparison')}")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
        finally:
            self.current_task = None

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
