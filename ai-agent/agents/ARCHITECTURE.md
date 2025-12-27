# Multi-Agent Architecture Documentation

## Overview

This system uses a multi-agent architecture to handle complex tasks from Telegram. A Lead Agent orchestrates specialist agents for planning, then hands off a unified plan to an Executor Agent for browser automation.

---

## File Structure

```
ai-agent/
├── telegram_bot.py          # Entry point - receives Telegram messages
├── task_planner.py          # Current planning logic (to be refactored)
├── agent_tasks.py           # Browser automation runner
├── .env                     # API keys and configuration
│
└── agents/                  # Agent definitions
    ├── ARCHITECTURE.md      # This file
    │
    ├── lead_agent.md        # Orchestrator - parses prompts, selects agents
    ├── executor.md          # Browser automation with self-correction
    │
    ├── research/            # Information gathering specialists
    │   ├── google_research.md      # Baseline (always runs first)
    │   ├── yelp_research.md        # Food & dining
    │   ├── tripadvisor_research.md # Travel & destinations
    │   ├── goodreads_research.md   # Books & reading
    │   ├── amazon_research.md      # Product research
    │   └── wirecutter_research.md  # Tech & electronics
    │
    └── action/              # Task execution specialists
        ├── amazon_cart.md          # Add/remove cart items
        ├── opentable_reserve.md    # Restaurant reservations
        └── email_calendar.md       # Email sync & calendar
```

---

## System Flowchart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERACTION                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TELEGRAM BOT                                    │
│                           (telegram_bot.py)                                  │
│                                                                              │
│  • Receives user message                                                     │
│  • Passes to Lead Agent                                                      │
│  • Returns final response to user                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LEAD AGENT                                      │
│                           (lead_agent.md)                                    │
│                                                                              │
│  PHASE 1: ANALYZE                                                            │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • Parse user prompt (remove conversational fluff)                      │ │
│  │ • Classify intent: RESEARCH | ACTION | HYBRID                          │ │
│  │ • Detect specialty topic (food, travel, books, tech, products)         │ │
│  │ • Determine which agents are needed                                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│                                      ▼                                       │
│  PHASE 2: INVOKE SPECIALISTS                                                 │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     Invoke selected agents in parallel                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                 ┌────────────────────┼────────────────────┐
                 │                    │                    │
                 ▼                    ▼                    ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
│   GOOGLE RESEARCH    │ │  SPECIALTY RESEARCH  │ │    ACTION AGENT      │
│   (Always first)     │ │  (Based on topic)    │ │  (If action needed)  │
│                      │ │                      │ │                      │
│ • Search Google      │ │ • Yelp (food)        │ │ • Amazon Cart        │
│ • Top 3 organic      │ │ • TripAdvisor(travel)│ │ • OpenTable          │
│ • Extract snippets   │ │ • Goodreads (books)  │ │ • Email/Calendar     │
│ • Note sources       │ │ • Amazon (products)  │ │                      │
│                      │ │ • Wirecutter (tech)  │ │                      │
└──────────┬───────────┘ └──────────┬───────────┘ └──────────┬───────────┘
           │                        │                        │
           │    (Each returns a sub-plan with steps)         │
           │                        │                        │
           └────────────────────────┼────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LEAD AGENT                                      │
│                         (Plan Aggregation)                                   │
│                                                                              │
│  PHASE 3: MERGE & OPTIMIZE                                                   │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • Receive sub-plans from all agents                                    │ │
│  │ • Cross-reference findings (items in multiple sources = high conf.)    │ │
│  │ • Resolve conflicts (specialty wins for domain-specific)               │ │
│  │ • Determine execution order (research before action)                   │ │
│  │ • Create unified execution plan                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            EXECUTOR AGENT                                    │
│                            (executor.md)                                     │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         BROWSER_USE ENGINE                              │ │
│  │                                                                         │ │
│  │  • Execute steps sequentially                                          │ │
│  │  • Verify each step before proceeding                                  │ │
│  │  • Self-correct if stuck (loop detection, recovery)                    │ │
│  │  • Escalate to Lead Agent if recovery fails                            │ │
│  │  • Checkpoint every 3 steps                                            │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  MODEL SELECTION:                                                            │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  Normal execution: Gemini 2.0 Flash (fast, cost-effective)             │ │
│  │  When stuck:       Gemini 3.0 Flash (better reasoning for recovery)    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RESULT FORMATTING                                  │
│                                                                              │
│  • Extract final result from browser_use AgentHistoryList                   │
│  • Format according to task type (research → bullets, action → confirm)     │
│  • Send concise response back to Telegram                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                 USER                                         │
│                          (Receives response)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Agent Selection Matrix (MECE)

### Research Agent Selection

| User Topic | Google (Baseline) | Specialty Agent |
|------------|:-----------------:|:---------------:|
| Food / Restaurants | ✓ | Yelp |
| Travel / Destinations | ✓ | TripAdvisor |
| Books / Reading | ✓ | Goodreads |
| Products / Shopping | ✓ | Amazon Research |
| Tech / Electronics | ✓ | Wirecutter |
| General / Other | ✓ | (none) |

### Action Agent Selection

| User Intent | Action Agent |
|-------------|:------------:|
| Add/remove from cart | Amazon Cart |
| Make reservation | OpenTable Reserve |
| Sync emails / calendar | Email Calendar |

### Intent Classification

| Intent Type | Description | Flow |
|-------------|-------------|------|
| **RESEARCH** | User wants information | Google + Specialty → Summary |
| **ACTION** | User wants task done | Action Agent → Confirmation |
| **HYBRID** | Research then act | Research → Decision → Action |

---

## Example Flows

### Example 1: Pure Research
**Prompt:** "What are some good books like Dungeon Crawler Carl?"

```
1. Lead Agent analyzes:
   - Intent: RESEARCH
   - Topic: Books
   - Agents needed: Google Research + Goodreads Research

2. Google Research returns:
   - Top 3 results for "books like Dungeon Crawler Carl"
   - Sources: Reddit thread, blog post, Goodreads list

3. Goodreads Research returns:
   - "Readers Also Enjoyed" from DCC page
   - Top 5 similar books with ratings and authors

4. Lead Agent merges:
   - Cross-references: Cradle, He Who Fights With Monsters appear in both
   - Verifies authors from Goodreads (not Reddit usernames)
   - Creates summary with top 3-5 recommendations

5. Response to user:
   • **Cradle** by Will Wight - Fast-paced progression fantasy...
   • **He Who Fights With Monsters** by Shirtaloon - LitRPG with humor...
   • **Primal Hunter** by Zogarth - System apocalypse with crafting...
```

### Example 2: Pure Action
**Prompt:** "Add Cradle to my Amazon cart"

```
1. Lead Agent analyzes:
   - Intent: ACTION
   - Action type: Shopping
   - Agents needed: Amazon Cart only

2. Amazon Cart creates plan:
   - Navigate to Amazon
   - Search for "Cradle Will Wight"
   - Select Kindle edition (default)
   - Add to cart
   - Verify

3. Executor runs plan via browser_use

4. Response to user:
   ✅ Added to cart - Cradle by Will Wight (Kindle Edition) - $4.99
```

### Example 3: Hybrid (Research + Action)
**Prompt:** "Find me a good Italian restaurant in Manhattan and make a reservation for 2 at 7pm tomorrow"

```
1. Lead Agent analyzes:
   - Intent: HYBRID
   - Topics: Food (research) + Reservation (action)
   - Agents needed: Google + Yelp + OpenTable

2. Google Research returns:
   - Top 3 results for "best Italian restaurant Manhattan"

3. Yelp Research returns:
   - Top 5 Italian restaurants, 4+ stars
   - Carbone (4.5★), L'Artusi (4.3★), etc.

4. Lead Agent merges research:
   - Recommends: Carbone (appears in both, highest rated)

5. OpenTable Reserve creates plan:
   - Search Carbone on OpenTable
   - Select: 2 guests, tomorrow, 7:00 PM
   - Complete reservation

6. Executor runs unified plan

7. Response to user:
   Research found Carbone as top recommendation (4.5★, $$$)

   ✅ Reservation confirmed:
   - Carbone, Greenwich Village
   - Tomorrow at 7:00 PM
   - Party of 2
   - Confirmation #: ABC123
```

---

## Model Usage Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MODEL ALLOCATION                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PLANNING PHASE                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  Lead Agent Analysis    │  Gemini 3.0 Flash  │  Better reasoning       ││
│  │  Specialist Planning    │  Gemini 3.0 Flash  │  Domain expertise       ││
│  │  Plan Aggregation       │  Gemini 3.0 Flash  │  Complex merging        ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  EXECUTION PHASE                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  Normal Steps           │  Gemini 2.0 Flash  │  Fast, cheap            ││
│  │  When Stuck             │  Gemini 3.0 Flash  │  Recovery reasoning     ││
│  │  After Recovery         │  Gemini 2.0 Flash  │  Back to fast mode      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  COST OPTIMIZATION                                                           │
│  • 3.0 Flash: Used sparingly for planning + recovery (~3-5 calls)           │
│  • 2.0 Flash: Used heavily for execution (~10-20 calls)                     │
│  • Net effect: Quality where it matters, speed where it doesn't             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Error Handling & Recovery

### Stuck Detection (Executor)
```
Trigger Conditions:
├── Same URL visited 3+ times
├── Same action attempted 3+ times
├── No progress after 5 steps
└── Consecutive errors (2+)

Recovery Protocol:
1. Pause and assess current state
2. Try alternative approach (different selector, scroll, wait)
3. If still stuck after 2 attempts → Escalate to Lead Agent
4. Lead Agent may:
   ├── Provide new instructions
   ├── Switch to different site/approach
   └── Abort with partial results
```

### Model Escalation
```
Normal Execution (2.0 Flash)
         │
         ▼
    Stuck Detected?
         │
    ┌────┴────┐
    │ NO      │ YES
    │         ▼
    │    Switch to 3.0 Flash
    │         │
    │         ▼
    │    Recovery attempt
    │         │
    │    ┌────┴────┐
    │    │ SUCCESS │ FAIL
    │    │         │
    │    ▼         ▼
    │  Back to   Escalate to
    │  2.0 Flash Lead Agent
    │
    ▼
 Continue
```

---

## Configuration

### Environment Variables (.env)
```bash
# API Keys
GOOGLE_API_KEY=your_gemini_api_key
TELEGRAM_BOT_TOKEN=your_telegram_token

# Browser Configuration
HEADLESS=false
BROWSER_PATH=/path/to/edge
USER_DATA_DIR=/path/to/profile

# Model Selection (optional overrides)
PLANNING_MODEL=gemini-3.0-flash
EXECUTION_MODEL=gemini-2.0-flash
```

### Agent Loading
```python
# Agents are loaded from .md files at startup
# Each agent definition is parsed and used to construct prompts

agent_definitions = {
    "lead": load_agent("agents/lead_agent.md"),
    "google": load_agent("agents/research/google_research.md"),
    "yelp": load_agent("agents/research/yelp_research.md"),
    # ... etc
}
```

---

## Key Design Principles

1. **MECE Agent Design**
   - Every prompt maps to exactly one specialty
   - No overlap between agent responsibilities
   - Clear handoffs between research and action

2. **Google as Baseline**
   - Always run Google Research first
   - Provides broad context and sanity check
   - Specialty agents add depth, not replace

3. **Separation of Planning and Execution**
   - Specialists plan, Executor executes
   - Executor doesn't make judgment calls
   - Escalation path for edge cases

4. **Cost-Conscious Model Selection**
   - Expensive model for thinking (planning, recovery)
   - Cheap model for doing (execution steps)

5. **Self-Correction Built In**
   - Executor detects loops and stuck states
   - Automatic recovery attempts before escalation
   - Checkpoints every 3 steps

---

## Future Enhancements

- [ ] Add more specialty research agents (Reddit, specific forums)
- [ ] Add more action agents (Resy, direct restaurant booking, flight booking)
- [ ] Implement parallel research execution
- [ ] Add caching for repeated queries
- [ ] Implement conversation memory across sessions
- [ ] Add user preference learning
