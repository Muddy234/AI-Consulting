"""
Agent Loader - Parses agent .md files to extract configuration
================================================================
This module loads agent definition files and extracts:
- System Prompts
- Input/Output Contracts
- Site Knowledge
- Decision Trees
- Verification Signals
- Self-Correction rules
- Examples
- Behavioral Rules
"""

import os
import re
import json
import logging
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Base path for agent definitions
AGENTS_DIR = Path(__file__).parent / "agents"


@dataclass
class AgentProfile:
    """Parsed agent profile from .md file."""
    name: str
    role: str = ""
    scope_in: List[str] = field(default_factory=list)
    scope_out: List[str] = field(default_factory=list)
    mece_boundary: str = ""
    trigger_keywords: List[str] = field(default_factory=list)
    system_prompt: str = ""
    input_contract: Dict = field(default_factory=dict)
    output_contract: Dict = field(default_factory=dict)
    site_knowledge: Dict = field(default_factory=dict)
    decision_trees: str = ""
    verification_signals: Dict = field(default_factory=dict)
    self_correction: Dict = field(default_factory=dict)
    examples: List[Dict] = field(default_factory=list)
    error_handling: List[Dict] = field(default_factory=list)
    behavioral_rules: Dict = field(default_factory=dict)
    raw_content: str = ""


class AgentLoader:
    """
    Loads and parses agent definition files.

    Agent files are markdown with specific sections that define
    how the agent should behave, what it can do, and how to
    interact with specific sites.
    """

    def __init__(self, agents_dir: Path = None):
        self.agents_dir = agents_dir or AGENTS_DIR
        self._cache: Dict[str, AgentProfile] = {}

    def load_agent(self, agent_name: str, category: str = None) -> AgentProfile:
        """
        Load an agent profile by name.

        Args:
            agent_name: Name of the agent (e.g., 'lead_agent', 'yelp_research')
            category: Optional category subfolder ('research', 'action')

        Returns:
            AgentProfile with parsed configuration
        """
        cache_key = f"{category}/{agent_name}" if category else agent_name

        if cache_key in self._cache:
            return self._cache[cache_key]

        # Find the file
        if category:
            file_path = self.agents_dir / category / f"{agent_name}.md"
        else:
            file_path = self.agents_dir / f"{agent_name}.md"

        if not file_path.exists():
            raise FileNotFoundError(f"Agent file not found: {file_path}")

        # Parse the file
        content = file_path.read_text(encoding='utf-8')
        profile = self._parse_agent_file(agent_name, content)

        self._cache[cache_key] = profile
        return profile

    def load_all_research_agents(self) -> Dict[str, AgentProfile]:
        """Load all research agents."""
        research_dir = self.agents_dir / "research"
        agents = {}

        if research_dir.exists():
            for file_path in research_dir.glob("*.md"):
                name = file_path.stem
                agents[name] = self.load_agent(name, "research")

        return agents

    def load_all_action_agents(self) -> Dict[str, AgentProfile]:
        """Load all action agents."""
        action_dir = self.agents_dir / "action"
        agents = {}

        if action_dir.exists():
            for file_path in action_dir.glob("*.md"):
                name = file_path.stem
                agents[name] = self.load_agent(name, "action")

        return agents

    def _parse_agent_file(self, name: str, content: str) -> AgentProfile:
        """Parse markdown content into AgentProfile."""
        profile = AgentProfile(name=name, raw_content=content)

        # Extract role from first ## Role section
        role_match = re.search(r'## Role\s*\n(.+?)(?=\n##|\Z)', content, re.DOTALL)
        if role_match:
            profile.role = role_match.group(1).strip()

        # Extract scope
        scope_match = re.search(r'## Scope\s*\n(.+?)(?=\n##|\Z)', content, re.DOTALL)
        if scope_match:
            scope_text = scope_match.group(1)

            # IN SCOPE
            in_scope = re.search(r'\*\*IN SCOPE:\*\*\s*\n((?:- .+\n?)+)', scope_text)
            if in_scope:
                profile.scope_in = [line.strip('- \n') for line in in_scope.group(1).split('\n') if line.strip().startswith('-')]

            # OUT OF SCOPE
            out_scope = re.search(r'\*\*OUT OF SCOPE:\*\*\s*\n((?:- .+\n?)+)', scope_text)
            if out_scope:
                profile.scope_out = [line.strip('- \n') for line in out_scope.group(1).split('\n') if line.strip().startswith('-')]

            # MECE Boundary
            mece = re.search(r'\*\*MECE (?:BOUNDARY|Boundary):\*\*\s*\n?(.+?)(?=\n\n|\n\*\*|\Z)', scope_text, re.DOTALL)
            if mece:
                profile.mece_boundary = mece.group(1).strip()

        # Extract trigger keywords
        trigger_match = re.search(r'## Trigger Keywords\s*\n(.+?)(?=\n##|\n---|\Z)', content, re.DOTALL)
        if trigger_match:
            keywords_text = trigger_match.group(1)
            # Parse backtick-enclosed keywords
            profile.trigger_keywords = re.findall(r'`([^`]+)`', keywords_text)

        # Extract system prompt
        prompt_match = re.search(r'## System Prompt\s*\n+```\s*\n(.+?)\n```', content, re.DOTALL)
        if prompt_match:
            profile.system_prompt = prompt_match.group(1).strip()

        # Extract input contract
        input_match = re.search(r'## Input Contract\s*\n+```json\s*\n(.+?)\n```', content, re.DOTALL)
        if input_match:
            try:
                profile.input_contract = json.loads(input_match.group(1))
            except json.JSONDecodeError:
                logger.warning(f"Failed to parse input contract for {name}")
                profile.input_contract = {"raw": input_match.group(1)}

        # Extract output contract (may have multiple for different scenarios)
        output_matches = re.findall(r'(?:## Output Contract|### \w+)\s*\n+```json\s*\n(.+?)\n```', content, re.DOTALL)
        if output_matches:
            try:
                # Use first one as primary
                profile.output_contract = json.loads(output_matches[0])
            except json.JSONDecodeError:
                profile.output_contract = {"raw": output_matches[0]}

        # Extract site knowledge
        site_match = re.search(r'## Site Knowledge[^\n]*\s*\n(.+?)(?=\n## |\n---\s*\n## |\Z)', content, re.DOTALL)
        if site_match:
            profile.site_knowledge = self._parse_site_knowledge(site_match.group(1))

        # Extract decision trees (keep as raw text for LLM)
        tree_match = re.search(r'## Decision Trees\s*\n(.+?)(?=\n---\s*\n|\n## |\Z)', content, re.DOTALL)
        if tree_match:
            profile.decision_trees = tree_match.group(1).strip()

        # Extract verification signals
        verify_match = re.search(r'## Verification Signals\s*\n(.+?)(?=\n---\s*\n|\n## |\Z)', content, re.DOTALL)
        if verify_match:
            profile.verification_signals = self._parse_tables(verify_match.group(1))

        # Extract self-correction
        correct_match = re.search(r'## Self-Correction\s*\n(.+?)(?=\n---\s*\n|\n## |\Z)', content, re.DOTALL)
        if correct_match:
            profile.self_correction = self._parse_correction_rules(correct_match.group(1))

        # Extract examples
        examples_match = re.search(r'## Examples\s*\n(.+?)(?=\n---\s*\n|\n## |\Z)', content, re.DOTALL)
        if examples_match:
            profile.examples = self._parse_examples(examples_match.group(1))

        # Extract error handling
        error_match = re.search(r'## Error Handling\s*\n(.+?)(?=\n---\s*\n|\n## |\Z)', content, re.DOTALL)
        if error_match:
            profile.error_handling = self._parse_error_table(error_match.group(1))

        # Extract behavioral rules
        rules_match = re.search(r'## Behavioral Rules\s*\n(.+?)(?=\n---\s*\n|\n## |\Z)', content, re.DOTALL)
        if rules_match:
            profile.behavioral_rules = self._parse_behavioral_rules(rules_match.group(1))

        return profile

    def _parse_site_knowledge(self, text: str) -> Dict:
        """Parse site knowledge section with tables."""
        knowledge = {}

        # Find all subsections
        subsections = re.findall(r'### ([^\n]+)\s*\n((?:(?!###).)+)', text, re.DOTALL)

        for title, content in subsections:
            title_key = title.strip().lower().replace(' ', '_')
            # Parse tables in subsection
            tables = self._parse_tables(content)
            if tables:
                knowledge[title_key] = tables
            else:
                knowledge[title_key] = content.strip()

        return knowledge

    def _parse_tables(self, text: str) -> Dict:
        """Parse markdown tables into dictionaries."""
        tables = {}

        # Find tables (| header | header |)
        table_pattern = r'\|([^\n]+)\|\s*\n\|[-\s|]+\|\s*\n((?:\|[^\n]+\|\s*\n?)+)'
        matches = re.findall(table_pattern, text)

        for i, (header, rows) in enumerate(matches):
            headers = [h.strip() for h in header.split('|') if h.strip()]
            table_data = []

            for row in rows.strip().split('\n'):
                cells = [c.strip() for c in row.split('|') if c.strip()]
                if len(cells) == len(headers):
                    table_data.append(dict(zip(headers, cells)))

            if table_data:
                tables[f"table_{i}"] = table_data

        return tables if tables else {}

    def _parse_correction_rules(self, text: str) -> Dict:
        """Parse self-correction rules."""
        rules = {}

        # Find subsections like "### When Product Not Found"
        subsections = re.findall(r'### ([^\n]+)\s*\n((?:(?!###).)+)', text, re.DOTALL)

        for title, content in subsections:
            title_key = title.strip().lower().replace(' ', '_').replace('when_', '')
            # Extract numbered steps
            steps = re.findall(r'\d+\.\s+(.+)', content)
            rules[title_key] = steps if steps else content.strip()

        return rules

    def _parse_examples(self, text: str) -> List[Dict]:
        """Parse examples section."""
        examples = []

        # Find example blocks
        example_blocks = re.findall(r'### Example \d+[^\n]*\s*\n(.+?)(?=### Example|\Z)', text, re.DOTALL)

        for block in example_blocks:
            example = {}

            # Extract input
            input_match = re.search(r'\*\*Input:\*\*\s*\n```json\s*\n(.+?)\n```', block, re.DOTALL)
            if input_match:
                try:
                    example['input'] = json.loads(input_match.group(1))
                except json.JSONDecodeError:
                    example['input'] = input_match.group(1)

            # Extract execution steps
            exec_match = re.search(r'\*\*Execution:\*\*\s*\n(.+?)(?=\*\*Output|\Z)', block, re.DOTALL)
            if exec_match:
                example['execution'] = exec_match.group(1).strip()

            # Extract output
            output_match = re.search(r'\*\*Output:\*\*\s*\n```json\s*\n(.+?)\n```', block, re.DOTALL)
            if output_match:
                try:
                    example['output'] = json.loads(output_match.group(1))
                except json.JSONDecodeError:
                    example['output'] = output_match.group(1)

            if example:
                examples.append(example)

        return examples

    def _parse_error_table(self, text: str) -> List[Dict]:
        """Parse error handling table."""
        errors = []

        # Find the table
        tables = self._parse_tables(text)
        if tables:
            # Combine all table entries
            for table_data in tables.values():
                errors.extend(table_data)

        return errors

    def _parse_behavioral_rules(self, text: str) -> Dict:
        """Parse behavioral rules (DO/DON'T lists)."""
        rules = {
            'do': [],
            'dont': []
        }

        # Find DO section
        do_match = re.search(r'\*\*DO:\*\*\s*\n((?:- .+\n?)+)', text)
        if do_match:
            rules['do'] = [line.strip('- \n') for line in do_match.group(1).split('\n') if line.strip().startswith('-')]

        # Find DON'T section
        dont_match = re.search(r"\*\*DON'T:\*\*\s*\n((?:- .+\n?)+)", text)
        if dont_match:
            rules['dont'] = [line.strip('- \n') for line in dont_match.group(1).split('\n') if line.strip().startswith('-')]

        return rules


def get_agent_system_prompt(agent_name: str, category: str = None) -> str:
    """
    Convenience function to get an agent's system prompt.

    Args:
        agent_name: Name of the agent
        category: Optional category ('research', 'action')

    Returns:
        The agent's system prompt string
    """
    loader = AgentLoader()
    profile = loader.load_agent(agent_name, category)
    return profile.system_prompt


def get_agent_for_keywords(keywords: List[str]) -> Optional[str]:
    """
    Find the best agent based on trigger keywords.

    Args:
        keywords: List of keywords from user input

    Returns:
        Agent name if found, None otherwise
    """
    loader = AgentLoader()

    # Load all agents
    research_agents = loader.load_all_research_agents()
    action_agents = loader.load_all_action_agents()

    all_agents = {**research_agents, **action_agents}

    best_match = None
    best_score = 0

    for agent_name, profile in all_agents.items():
        score = sum(1 for kw in keywords if kw.lower() in [t.lower() for t in profile.trigger_keywords])
        if score > best_score:
            best_score = score
            best_match = agent_name

    return best_match if best_score > 0 else None


# CLI for testing
if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    loader = AgentLoader()

    if len(sys.argv) > 1:
        agent_name = sys.argv[1]
        category = sys.argv[2] if len(sys.argv) > 2 else None

        try:
            profile = loader.load_agent(agent_name, category)
            print(f"\n{'='*60}")
            print(f"Agent: {profile.name}")
            print(f"Role: {profile.role[:100]}...")
            print(f"\nTrigger Keywords: {profile.trigger_keywords}")
            print(f"\nScope IN: {profile.scope_in[:3]}...")
            print(f"Scope OUT: {profile.scope_out[:3]}...")
            print(f"\nMECE Boundary: {profile.mece_boundary}")
            print(f"\nSystem Prompt: {profile.system_prompt[:200]}...")
            print(f"\nExamples: {len(profile.examples)} found")
            print(f"Error Handlers: {len(profile.error_handling)} found")
        except FileNotFoundError as e:
            print(f"Error: {e}")
    else:
        # List all agents
        print("\nResearch Agents:")
        for name in loader.load_all_research_agents():
            print(f"  - {name}")

        print("\nAction Agents:")
        for name in loader.load_all_action_agents():
            print(f"  - {name}")

        # Load lead agent
        print("\nLead Agent:")
        lead = loader.load_agent("lead_agent")
        print(f"  Role: {lead.role[:80]}...")
        print(f"  Keywords: {lead.trigger_keywords[:5]}")
