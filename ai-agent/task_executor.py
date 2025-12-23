"""
Task Executor - Modular AI Task Execution Framework
====================================================
Provides structured task definitions, templates, and execution with retry logic.
"""

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Dict, Optional, Any
from queue import PriorityQueue

from browser_use import Agent
from browser_use.llm.models import ChatGoogle

# ================= LOGGING =================
logger = logging.getLogger(__name__)

# Set API key
os.environ["GOOGLE_API_KEY"] = os.getenv("GOOGLE_API_KEY", "")


# ================= TASK TYPES =================
class TaskType(Enum):
    # Email Operations
    EMAIL_SEND = "email_send"
    EMAIL_REPLY = "email_reply"
    EMAIL_FORWARD = "email_forward"
    EMAIL_FLAG = "email_flag"
    EMAIL_UNFLAG = "email_unflag"
    EMAIL_ARCHIVE = "email_archive"
    EMAIL_DELETE = "email_delete"
    EMAIL_SEARCH = "email_search"
    EMAIL_SUMMARY = "email_summary"

    # Calendar Operations
    CALENDAR_CREATE = "calendar_create"
    CALENDAR_UPDATE = "calendar_update"
    CALENDAR_DELETE = "calendar_delete"
    CALENDAR_SEARCH = "calendar_search"
    CALENDAR_SUMMARY = "calendar_summary"

    # Sync Operations
    SYNC_FLAGGED_TO_CALENDAR = "sync_flagged_to_calendar"
    SYNC_CALENDAR_TO_SHEET = "sync_calendar_to_sheet"

    # Custom/Generic
    CUSTOM = "custom"
    BROWSER_TASK = "browser_task"


class TaskStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


# ================= TASK DATA CLASS =================
@dataclass
class Task:
    task_type: TaskType
    parameters: Dict[str, Any]
    priority: int = 1  # Higher = more important
    max_retries: int = 3
    timeout: int = 300  # seconds

    # Auto-generated fields
    id: str = field(default_factory=lambda: datetime.now().strftime("%Y%m%d%H%M%S%f")[:18])
    status: TaskStatus = TaskStatus.PENDING
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    result: Optional[Dict] = None
    error: Optional[str] = None
    attempts: int = 0

    def __lt__(self, other):
        # For priority queue comparison (higher priority first)
        return self.priority > other.priority

    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "type": self.task_type.value,
            "parameters": self.parameters,
            "priority": self.priority,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "result": self.result,
            "error": self.error,
            "attempts": self.attempts
        }


# ================= TASK TEMPLATES =================
TASK_TEMPLATES = {
    # Email Templates
    TaskType.EMAIL_SEND: """
Navigate to https://outlook.office.com/mail/

TASK: Send a new email
1. Click 'New mail' button
2. In the 'To' field, enter: {to}
3. In the 'Subject' field, enter: {subject}
4. In the body, type:
{body}
5. Click 'Send'

Confirm the email was sent successfully.
""",

    TaskType.EMAIL_REPLY: """
Navigate to https://outlook.office.com/mail/

TASK: Reply to an email
1. Search for email from: {sender}
   With subject containing: {subject_contains}
2. Open the email
3. Click 'Reply' (or 'Reply All' if specified)
4. Type this response:
{reply_body}
5. Click 'Send'

Confirm the reply was sent.
""",

    TaskType.EMAIL_FORWARD: """
Navigate to https://outlook.office.com/mail/

TASK: Forward an email
1. Search for email with subject: {subject_contains}
2. Open the email
3. Click 'Forward'
4. In 'To' field, enter: {forward_to}
5. Add this message above the forwarded content:
{message}
6. Click 'Send'
""",

    TaskType.EMAIL_FLAG: """
Navigate to https://outlook.office.com/mail/

TASK: Flag an email for follow-up
1. Search for email from: {sender}
   Or with subject: {subject_contains}
2. Right-click the email (or click the flag icon)
3. Select 'Flag' or 'Follow up'

Confirm the email is now flagged.
""",

    TaskType.EMAIL_SEARCH: """
Navigate to https://outlook.office.com/mail/

TASK: Search for emails and report findings
1. Use the search bar to search for: {query}
2. Review the results
3. Report back:
   - How many emails found
   - Senders
   - Subject lines
   - Brief summary of content
""",

    TaskType.EMAIL_SUMMARY: """
Navigate to https://outlook.office.com/mail/

TASK: Summarize recent emails
1. Go to the inbox
2. Review the {count} most recent unread emails
3. Provide a summary including:
   - Sender names
   - Subject lines
   - Key points from each email
   - Any action items identified
""",

    # Calendar Templates
    TaskType.CALENDAR_CREATE: """
Navigate to https://outlook.office.com/calendar/

TASK: Create a new calendar event
1. Click 'New event' button
2. Set the title: {title}
3. Set the date: {date}
4. Set the start time: {start_time}
5. Set duration/end time: {duration}
6. Set location (if provided): {location}
7. Add description: {description}
8. Click 'Save'

Confirm the event was created.
""",

    TaskType.CALENDAR_UPDATE: """
Navigate to https://outlook.office.com/calendar/

TASK: Update an existing calendar event
1. Find the event titled: {event_title}
   On date: {event_date}
2. Click to open it
3. Click 'Edit'
4. Update the following:
{updates}
5. Click 'Save'

Confirm changes were saved.
""",

    TaskType.CALENDAR_DELETE: """
Navigate to https://outlook.office.com/calendar/

TASK: Delete a calendar event
1. Find the event titled: {event_title}
   On date: {event_date}
2. Click to open it
3. Click 'Delete' or trash icon
4. Confirm deletion

Report that the event was deleted.
""",

    TaskType.CALENDAR_SUMMARY: """
Navigate to https://outlook.office.com/calendar/

TASK: Summarize calendar for a time period
1. Navigate to view: {view} (day/week/month)
2. Look at dates: {date_range}
3. List all events including:
   - Event title
   - Date and time
   - Duration
   - Location (if any)
4. Identify any conflicts or gaps
""",

    # Sync Templates
    TaskType.SYNC_FLAGGED_TO_CALENDAR: """
MULTI-STEP TASK: Sync flagged emails to calendar

STEP 1: Go to https://outlook.office.com/mail/flaggedemail
- List all flagged emails (sender, subject)

STEP 2: Go to https://outlook.office.com/calendar/view/week
- Check which flagged items already have calendar events (marked with 🤖)

STEP 3: For any flagged email NOT on the calendar:
- Create a new event titled: 🤖 [Subject from email]
- Schedule for: {default_time}
- Duration: 30 minutes

STEP 4: Report what was synced.
""",

    # Custom/Generic
    TaskType.CUSTOM: "{prompt}",
    TaskType.BROWSER_TASK: "{prompt}"
}


# ================= TASK EXECUTOR =================
class TaskExecutor:
    """Executes tasks using browser_use AI agents"""

    def __init__(self, model: str = "gemini-2.0-flash"):
        self.llm = ChatGoogle(model=model)
        self.task_queue: List[Task] = []
        self.history: List[Task] = []
        self.is_running = False

    def add_task(self, task: Task) -> str:
        """Add task to queue, returns task ID"""
        self.task_queue.append(task)
        # Sort by priority (higher first)
        self.task_queue.sort(key=lambda t: t.priority, reverse=True)
        logger.info(f"Task added: {task.id} ({task.task_type.value})")
        return task.id

    def remove_task(self, task_id: str) -> bool:
        """Remove task from queue"""
        for i, task in enumerate(self.task_queue):
            if task.id == task_id:
                self.task_queue.pop(i)
                logger.info(f"Task removed: {task_id}")
                return True
        return False

    def get_task(self, task_id: str) -> Optional[Task]:
        """Get task by ID (from queue or history)"""
        for task in self.task_queue + self.history:
            if task.id == task_id:
                return task
        return None

    def build_prompt(self, task: Task) -> str:
        """Build prompt from task template and parameters"""
        template = TASK_TEMPLATES.get(task.task_type, TASK_TEMPLATES[TaskType.CUSTOM])

        # Fill in template parameters
        try:
            prompt = template.format(**task.parameters)
        except KeyError as e:
            # If parameter missing, use raw prompt or partial fill
            prompt = template
            for key, value in task.parameters.items():
                prompt = prompt.replace(f"{{{key}}}", str(value))

        return prompt.strip()

    async def execute_task(self, task: Task) -> Task:
        """Execute a single task with retry logic"""
        task.status = TaskStatus.RUNNING
        task.started_at = datetime.now()

        prompt = self.build_prompt(task)
        logger.info(f"Executing task {task.id}: {task.task_type.value}")
        logger.debug(f"Prompt: {prompt[:200]}...")

        for attempt in range(task.max_retries):
            task.attempts = attempt + 1

            try:
                agent = Agent(task=prompt, llm=self.llm)
                result = await asyncio.wait_for(
                    agent.run(),
                    timeout=task.timeout
                )

                task.status = TaskStatus.COMPLETED
                task.result = {
                    "output": str(result),
                    "attempts": task.attempts
                }
                task.completed_at = datetime.now()

                logger.info(f"Task {task.id} completed in {task.attempts} attempt(s)")
                break

            except asyncio.TimeoutError:
                task.error = f"Timeout after {task.timeout}s"
                logger.warning(f"Task {task.id} timed out (attempt {attempt + 1})")

            except Exception as e:
                task.error = str(e)
                logger.warning(f"Task {task.id} failed (attempt {attempt + 1}): {e}")

            # Retry delay
            if attempt < task.max_retries - 1:
                await asyncio.sleep(5)

        # If all retries failed
        if task.status != TaskStatus.COMPLETED:
            task.status = TaskStatus.FAILED
            task.completed_at = datetime.now()
            logger.error(f"Task {task.id} failed after {task.attempts} attempts")

        return task

    async def run_next(self) -> Optional[Task]:
        """Execute the next task in queue"""
        if not self.task_queue:
            return None

        task = self.task_queue.pop(0)
        result = await self.execute_task(task)
        self.history.append(result)
        return result

    async def run_all(self) -> Dict:
        """Execute all tasks in queue"""
        self.is_running = True
        results = {"completed": 0, "failed": 0, "tasks": []}

        while self.task_queue and self.is_running:
            task = await self.run_next()
            if task:
                results["tasks"].append(task.to_dict())
                if task.status == TaskStatus.COMPLETED:
                    results["completed"] += 1
                else:
                    results["failed"] += 1

        self.is_running = False
        return results

    def stop(self):
        """Stop execution after current task"""
        self.is_running = False

    def get_queue_status(self) -> Dict:
        """Get current queue status"""
        return {
            "queue_length": len(self.task_queue),
            "is_running": self.is_running,
            "pending_tasks": [t.to_dict() for t in self.task_queue],
            "history_count": len(self.history)
        }

    def get_history(self, limit: int = 10) -> List[Dict]:
        """Get recent task history"""
        return [t.to_dict() for t in self.history[-limit:]]


# ================= COMMAND PARSER =================
class CommandParser:
    """Parse commands from various input formats"""

    @staticmethod
    def from_json(json_str: str) -> List[Task]:
        """Parse JSON task definitions"""
        try:
            data = json.loads(json_str)

            # Handle single task or list
            task_list = data.get("tasks", [data]) if isinstance(data, dict) else data

            tasks = []
            for item in task_list:
                task = Task(
                    task_type=TaskType(item["type"]),
                    parameters=item.get("params", item.get("parameters", {})),
                    priority=item.get("priority", 1),
                    max_retries=item.get("max_retries", 3),
                    timeout=item.get("timeout", 300)
                )
                tasks.append(task)

            return tasks

        except (json.JSONDecodeError, KeyError, ValueError) as e:
            logger.error(f"Failed to parse JSON: {e}")
            return []

    @staticmethod
    def from_natural_language(text: str) -> Task:
        """Parse natural language into a task"""
        text_lower = text.lower()

        # Email patterns
        if any(kw in text_lower for kw in ["send email", "email to", "compose email"]):
            return Task(
                task_type=TaskType.EMAIL_SEND,
                parameters={"prompt": text}
            )

        if any(kw in text_lower for kw in ["reply to", "respond to"]):
            return Task(
                task_type=TaskType.EMAIL_REPLY,
                parameters={"prompt": text}
            )

        if any(kw in text_lower for kw in ["forward email", "forward to"]):
            return Task(
                task_type=TaskType.EMAIL_FORWARD,
                parameters={"prompt": text}
            )

        if any(kw in text_lower for kw in ["flag email", "mark for follow"]):
            return Task(
                task_type=TaskType.EMAIL_FLAG,
                parameters={"prompt": text}
            )

        if any(kw in text_lower for kw in ["search email", "find email", "look for email"]):
            return Task(
                task_type=TaskType.EMAIL_SEARCH,
                parameters={"prompt": text}
            )

        if any(kw in text_lower for kw in ["summarize email", "email summary", "inbox summary"]):
            return Task(
                task_type=TaskType.EMAIL_SUMMARY,
                parameters={"prompt": text, "count": 10}
            )

        # Calendar patterns
        if any(kw in text_lower for kw in ["schedule", "create event", "add to calendar", "book meeting"]):
            return Task(
                task_type=TaskType.CALENDAR_CREATE,
                parameters={"prompt": text}
            )

        if any(kw in text_lower for kw in ["update event", "change meeting", "reschedule"]):
            return Task(
                task_type=TaskType.CALENDAR_UPDATE,
                parameters={"prompt": text}
            )

        if any(kw in text_lower for kw in ["delete event", "cancel meeting", "remove from calendar"]):
            return Task(
                task_type=TaskType.CALENDAR_DELETE,
                parameters={"prompt": text}
            )

        if any(kw in text_lower for kw in ["calendar summary", "what's on my calendar", "my schedule"]):
            return Task(
                task_type=TaskType.CALENDAR_SUMMARY,
                parameters={"prompt": text}
            )

        # Sync patterns
        if any(kw in text_lower for kw in ["sync", "synchronize"]):
            return Task(
                task_type=TaskType.SYNC_FLAGGED_TO_CALENDAR,
                parameters={"prompt": text}
            )

        # Default: generic browser task
        return Task(
            task_type=TaskType.BROWSER_TASK,
            parameters={"prompt": text}
        )


# ================= HELPER FUNCTIONS =================
def create_email_task(to: str, subject: str, body: str, priority: int = 1) -> Task:
    """Helper to create an email send task"""
    return Task(
        task_type=TaskType.EMAIL_SEND,
        parameters={"to": to, "subject": subject, "body": body},
        priority=priority
    )


def create_calendar_task(title: str, date: str, start_time: str,
                         duration: str = "30 minutes", location: str = "",
                         description: str = "", priority: int = 1) -> Task:
    """Helper to create a calendar event task"""
    return Task(
        task_type=TaskType.CALENDAR_CREATE,
        parameters={
            "title": title,
            "date": date,
            "start_time": start_time,
            "duration": duration,
            "location": location,
            "description": description
        },
        priority=priority
    )


# ================= CLI TESTING =================
if __name__ == "__main__":
    async def test():
        executor = TaskExecutor()

        # Test natural language parsing
        task = CommandParser.from_natural_language(
            "Send an email to test@example.com about the project update"
        )
        print(f"Parsed task: {task.task_type.value}")
        print(f"Prompt would be: {executor.build_prompt(task)[:200]}...")

    asyncio.run(test())
