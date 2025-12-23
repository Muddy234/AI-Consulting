"""
AI Agent Web Dashboard
======================
Flask-based web interface for managing AI tasks.
"""

import os
import asyncio
import json
import threading
from datetime import datetime
from functools import wraps

from flask import Flask, render_template, request, jsonify, redirect, url_for, flash
from flask_socketio import SocketIO, emit

from task_executor import (
    TaskExecutor, Task, TaskType, TaskStatus,
    CommandParser, create_email_task, create_calendar_task
)
from outlook_sync import OutlookStateSync, Config

# ================= APP SETUP =================
app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-key-change-in-production")

# SocketIO for real-time updates
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Global instances
executor = TaskExecutor()
sync_bot = None  # Initialized on demand

# Background task tracking
background_tasks = {}


# ================= ASYNC HELPERS =================
def run_async(coro):
    """Run async function in a new event loop"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def async_task(f):
    """Decorator to run async functions in background thread"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        thread = threading.Thread(target=lambda: run_async(f(*args, **kwargs)))
        thread.start()
        return thread
    return wrapper


# ================= ROUTES: DASHBOARD =================
@app.route('/')
def index():
    """Main dashboard"""
    queue_status = executor.get_queue_status()
    history = executor.get_history(limit=10)

    return render_template('index.html',
                           queue_status=queue_status,
                           history=history,
                           task_types=[t.value for t in TaskType])


@app.route('/status')
def status():
    """Get current system status"""
    return jsonify({
        "executor": executor.get_queue_status(),
        "sync_bot": sync_bot.get_status() if sync_bot else None,
        "timestamp": datetime.now().isoformat()
    })


# ================= ROUTES: TASK MANAGEMENT =================
@app.route('/tasks')
def tasks_page():
    """Task management page"""
    return render_template('tasks.html',
                           queue=executor.task_queue,
                           history=executor.get_history(limit=20),
                           task_types=[t.value for t in TaskType])


@app.route('/tasks/add', methods=['POST'])
def add_task():
    """Add a new task"""
    try:
        data = request.form.to_dict()

        # Handle JSON input
        if data.get('json_input'):
            tasks = CommandParser.from_json(data['json_input'])
            for task in tasks:
                executor.add_task(task)
            flash(f"Added {len(tasks)} task(s) from JSON", "success")
            return redirect(url_for('tasks_page'))

        # Handle natural language input
        if data.get('natural_input'):
            task = CommandParser.from_natural_language(data['natural_input'])
            executor.add_task(task)
            flash(f"Added task: {task.task_type.value}", "success")
            return redirect(url_for('tasks_page'))

        # Handle structured form input
        task_type = TaskType(data.get('task_type', 'browser_task'))
        parameters = {}

        # Collect all parameter fields
        for key, value in data.items():
            if key.startswith('param_') and value:
                param_name = key.replace('param_', '')
                parameters[param_name] = value

        # Add prompt if provided
        if data.get('prompt'):
            parameters['prompt'] = data['prompt']

        task = Task(
            task_type=task_type,
            parameters=parameters,
            priority=int(data.get('priority', 1)),
            max_retries=int(data.get('max_retries', 3))
        )

        task_id = executor.add_task(task)
        flash(f"Task added: {task_id}", "success")

    except Exception as e:
        flash(f"Error adding task: {e}", "error")

    return redirect(url_for('tasks_page'))


@app.route('/tasks/<task_id>/remove', methods=['POST'])
def remove_task(task_id):
    """Remove a task from queue"""
    if executor.remove_task(task_id):
        flash(f"Task {task_id} removed", "success")
    else:
        flash(f"Task {task_id} not found in queue", "error")
    return redirect(url_for('tasks_page'))


@app.route('/tasks/<task_id>')
def get_task(task_id):
    """Get task details"""
    task = executor.get_task(task_id)
    if task:
        return jsonify(task.to_dict())
    return jsonify({"error": "Task not found"}), 404


@app.route('/tasks/run', methods=['POST'])
def run_tasks():
    """Run all tasks in queue"""
    @async_task
    async def run_all():
        socketio.emit('task_started', {'message': 'Task execution started'})
        results = await executor.run_all()
        socketio.emit('task_completed', results)

    run_all()
    flash("Task execution started", "info")
    return redirect(url_for('tasks_page'))


@app.route('/tasks/run-next', methods=['POST'])
def run_next_task():
    """Run the next task only"""
    @async_task
    async def run_next():
        task = await executor.run_next()
        if task:
            socketio.emit('task_completed', task.to_dict())

    run_next()
    flash("Running next task", "info")
    return redirect(url_for('tasks_page'))


@app.route('/tasks/stop', methods=['POST'])
def stop_tasks():
    """Stop task execution"""
    executor.stop()
    flash("Task execution stopped", "warning")
    return redirect(url_for('tasks_page'))


# ================= ROUTES: QUICK ACTIONS =================
@app.route('/quick/email', methods=['GET', 'POST'])
def quick_email():
    """Quick email compose form"""
    if request.method == 'POST':
        task = create_email_task(
            to=request.form['to'],
            subject=request.form['subject'],
            body=request.form['body'],
            priority=int(request.form.get('priority', 1))
        )
        executor.add_task(task)
        flash("Email task added to queue", "success")
        return redirect(url_for('tasks_page'))

    return render_template('quick_email.html')


@app.route('/quick/calendar', methods=['GET', 'POST'])
def quick_calendar():
    """Quick calendar event form"""
    if request.method == 'POST':
        task = create_calendar_task(
            title=request.form['title'],
            date=request.form['date'],
            start_time=request.form['start_time'],
            duration=request.form.get('duration', '30 minutes'),
            location=request.form.get('location', ''),
            description=request.form.get('description', ''),
            priority=int(request.form.get('priority', 1))
        )
        executor.add_task(task)
        flash("Calendar task added to queue", "success")
        return redirect(url_for('tasks_page'))

    return render_template('quick_calendar.html')


# ================= ROUTES: SYNC BOT =================
@app.route('/sync')
def sync_page():
    """Outlook sync status page"""
    global sync_bot
    status = sync_bot.get_status() if sync_bot else {"status": "not_initialized"}
    return render_template('sync.html', status=status)


@app.route('/sync/start', methods=['POST'])
def start_sync():
    """Start the Outlook sync bot"""
    global sync_bot

    try:
        if not sync_bot:
            sync_bot = OutlookStateSync()

        @async_task
        async def run_sync():
            await sync_bot.run_cycle()
            socketio.emit('sync_completed', sync_bot.get_status())

        run_sync()
        flash("Sync cycle started", "success")
    except Exception as e:
        flash(f"Failed to start sync: {e}", "error")

    return redirect(url_for('sync_page'))


@app.route('/sync/continuous', methods=['POST'])
def start_continuous_sync():
    """Start continuous sync mode"""
    global sync_bot

    try:
        if not sync_bot:
            sync_bot = OutlookStateSync()

        @async_task
        async def run_continuous():
            await sync_bot.run_continuous()

        run_continuous()
        flash("Continuous sync started", "success")
    except Exception as e:
        flash(f"Failed to start continuous sync: {e}", "error")

    return redirect(url_for('sync_page'))


# ================= API ENDPOINTS =================
@app.route('/api/tasks', methods=['GET'])
def api_list_tasks():
    """API: List all tasks"""
    return jsonify({
        "queue": [t.to_dict() for t in executor.task_queue],
        "history": executor.get_history(limit=50)
    })


@app.route('/api/tasks', methods=['POST'])
def api_add_task():
    """API: Add a task (JSON body)"""
    try:
        data = request.get_json()

        if isinstance(data, list):
            tasks = CommandParser.from_json(json.dumps({"tasks": data}))
        else:
            tasks = CommandParser.from_json(json.dumps(data))

        task_ids = [executor.add_task(task) for task in tasks]
        return jsonify({"success": True, "task_ids": task_ids})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


@app.route('/api/tasks/run', methods=['POST'])
def api_run_tasks():
    """API: Run all tasks"""
    @async_task
    async def run():
        return await executor.run_all()

    run()
    return jsonify({"success": True, "message": "Task execution started"})


@app.route('/api/natural', methods=['POST'])
def api_natural_language():
    """API: Add task from natural language"""
    try:
        data = request.get_json()
        text = data.get('text', data.get('prompt', ''))

        if not text:
            return jsonify({"error": "No text provided"}), 400

        task = CommandParser.from_natural_language(text)
        task_id = executor.add_task(task)

        return jsonify({
            "success": True,
            "task_id": task_id,
            "task_type": task.task_type.value,
            "parsed_as": executor.build_prompt(task)[:200]
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


# ================= WEBSOCKET EVENTS =================
@socketio.on('connect')
def handle_connect():
    emit('connected', {'status': 'Connected to AI Agent Dashboard'})


@socketio.on('request_status')
def handle_status_request():
    emit('status_update', {
        'executor': executor.get_queue_status(),
        'sync_bot': sync_bot.get_status() if sync_bot else None
    })


# ================= ERROR HANDLERS =================
@app.errorhandler(404)
def not_found(e):
    return render_template('error.html', error="Page not found"), 404


@app.errorhandler(500)
def server_error(e):
    return render_template('error.html', error="Server error"), 500


# ================= MAIN =================
if __name__ == '__main__':
    print("=" * 50)
    print("AI Agent Web Dashboard")
    print("=" * 50)
    print("Starting server at http://localhost:5000")
    print("=" * 50)

    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
