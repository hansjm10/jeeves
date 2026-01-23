#!/usr/bin/env python3
"""
Ralph Terminal Viewer - A simple TUI for monitoring Ralph in SSH/Docker
"""

import argparse
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional


class RalphTerminalViewer:
    """Terminal-based viewer for Ralph"""
    
    COLORS = {
        'reset': '\033[0m',
        'red': '\033[91m',
        'green': '\033[92m',
        'yellow': '\033[93m',
        'blue': '\033[94m',
        'magenta': '\033[95m',
        'cyan': '\033[96m',
        'gray': '\033[90m',
        'bold': '\033[1m',
        'dim': '\033[2m',
    }
    
    PHASE_COLORS = {
        'design': 'magenta',
        'implement': 'yellow',
        'review': 'yellow',
        'coverage': 'red',
        'coverage-fix': 'red',
        'sonar': 'green',
        'complete': 'blue',
        'prd': 'cyan',
    }
    
    def __init__(self, state_dir: str):
        self.state_dir = Path(state_dir)
        self.pr_d_file = self.state_dir / "prd.json"
        self.issue_file = self.state_dir / "issue.json"
        self.progress_file = self.state_dir / "progress.txt"
        self.last_run_log = self.state_dir / "last-run.log"
        self.last_message = self.state_dir / "last-message.txt"
        self.coverage_failures = self.state_dir / "coverage-failures.md"
        self.open_questions = self.state_dir / "open-questions.md"
        self.last_update = 0
        self._cache: Dict = {}
        self.last_log_lines = []
    
    def color(self, text: str, color_name: str) -> str:
        """Apply color to text"""
        return f"{self.COLORS[color_name]}{text}{self.COLORS['reset']}"
    
    def get_state(self) -> Dict:
        """Get current Ralph state"""
        now = time.time()
        if now - self.last_update < 0.3 and self._cache:
            return self._cache
        
        state = {
            "timestamp": datetime.now().isoformat(),
            "mode": "unknown",
            "config": {},
            "status": {},
            "progress_lines": [],
            "recent_logs": []
        }
        
        # Determine mode
        if self.issue_file.exists():
            state["mode"] = "issue"
            state["config"] = self._read_json(self.issue_file) or {}
        elif self.pr_d_file.exists():
            state["mode"] = "prd"
            state["config"] = self._read_json(self.pr_d_file) or {}
        
        # Get progress
        if self.progress_file.exists():
            state["progress_lines"] = self._read_lines_tail(self.progress_file, 20)
        
        # Get recent logs
        if self.last_run_log.exists():
            state["recent_logs"] = self._read_lines_tail(self.last_run_log, 50)
        
        # Parse status
        if state["mode"] == "issue":
            config = state["config"]
            status = config.get("status", {})
            state["status"] = {
                "phase": self._determine_phase(config, status),
                "implemented": status.get("implemented", False),
                "pr_created": status.get("prCreated", False) or config.get("pullRequest", {}).get("number"),
                "pr_number": config.get("pullRequest", {}).get("number"),
                "pr_url": config.get("pullRequest", {}).get("url"),
                "review_clean": status.get("reviewClean", False),
                "coverage_clean": status.get("coverageClean", False),
                "coverage_needs_fix": status.get("coverageNeedsFix", False),
                "sonar_clean": status.get("sonarClean", False),
                "has_coverage_failures": self.coverage_failures.exists() and self.coverage_failures.stat().st_size > 0,
                "has_open_questions": self.open_questions.exists() and self.open_questions.stat().st_size > 0,
                "issue_number": config.get("issue", {}).get("number") or config.get("issueNumber"),
                "branch_name": config.get("branchName")
            }
        elif state["mode"] == "prd":
            config = state["config"]
            stories = config.get("userStories", [])
            total = len(stories)
            passing = sum(1 for s in stories if s.get("passes", False))
            state["status"] = {
                "phase": "prd",
                "total_stories": total,
                "passing_stories": passing,
                "remaining_stories": total - passing
            }
        
        self._cache = state
        self.last_update = now
        return state
    
    def _determine_phase(self, config: Dict, status: Dict) -> str:
        """Determine current phase from config"""
        implemented = status.get("implemented", False)
        pr_created = status.get("prCreated", False) or config.get("pullRequest", {}).get("number")
        pr_desc_ready = status.get("prDescriptionReady", False)
        review_clean = status.get("reviewClean", False)
        coverage_clean = status.get("coverageClean", False)
        coverage_needs_fix = status.get("coverageNeedsFix", False)
        sonar_clean = status.get("sonarClean", False)
        
        if not config.get("designDocPath"):
            return "design"
        if not (implemented and pr_created and pr_desc_ready):
            return "implement"
        if not review_clean:
            return "review"
        if coverage_needs_fix:
            return "coverage-fix"
        if not coverage_clean:
            return "coverage"
        if not sonar_clean:
            return "sonar"
        return "complete"
    
    def _read_json(self, path: Path) -> Optional[Dict]:
        """Read JSON file"""
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return None
    
    def _read_lines_tail(self, path: Path, count: int) -> list:
        """Read last N lines from file"""
        try:
            with open(path) as f:
                lines = f.readlines()
                return [line.rstrip("\n") for line in lines[-count:]]
        except Exception:
            return []
    
    def render_status_icon(self, value: bool) -> str:
        """Render check/cross icon"""
        if value:
            return self.color("✓", "green")
        return self.color("✗", "gray")
    
    def render(self):
        """Render the terminal UI"""
        state = self.get_state()
        
        # Clear screen
        print("\033[2J\033[H", end="")
        
        # Header
        print(self.color("╔" + "═" * 76 + "╗", "bold"))
        title = "🤖 Ralph Terminal Viewer"
        padding = " " * ((78 - len(title)) // 2)
        print(self.color("║", "bold") + padding + self.color(title, "bold") + padding + self.color("║", "bold"))
        print(self.color("╚" + "═" * 76 + "╝", "bold"))
        print()
        
        # Status bar
        mode = state["mode"].upper()
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"Mode: {self.color(mode, 'cyan')} | Updated: {self.color(timestamp, 'gray')}")
        print()
        
        # Status panel
        status = state["status"]
        
        if state["mode"] == "issue":
            phase = status.get("phase", "unknown")
            phase_color = self.PHASE_COLORS.get(phase, "gray")
            phase_name = self.color(f"[{phase.upper()}]", phase_color)
            
            print(self.color("Status:", "bold"))
            print(f"  Phase: {phase_name}")
            
            if status.get("issue_number"):
                print(f"  Issue: {self.color('#' + str(status['issue_number']), 'blue')}")
            
            if status.get("pr_number"):
                print(f"  PR: {self.color('#' + str(status['pr_number']), 'blue')}")
            
            if status.get("branch_name"):
                print(f"  Branch: {self.color(status['branch_name'], 'yellow')}")
            
            print()
            print(self.color("Progress:", "bold"))
            items = [
                ("Implemented", status.get("implemented", False)),
                ("PR Created", status.get("pr_created", False)),
                ("Review Clean", status.get("review_clean", False)),
                ("Coverage Clean", status.get("coverage_clean", False)),
                ("Sonar Clean", status.get("sonar_clean", False)),
            ]
            
            for label, value in items:
                icon = self.render_status_icon(value)
                print(f"  {icon} {label}")
            
            if status.get("has_coverage_failures"):
                print(f"  {self.color('⚠', 'red')} Coverage failures detected")
            
            if status.get("has_open_questions"):
                print(f"  {self.color('?', 'yellow')} Open questions pending")
        
        elif state["mode"] == "prd":
            total = status.get("total_stories", 0)
            passing = status.get("passing_stories", 0)
            remaining = status.get("remaining_stories", 0)
            progress = int((passing / total * 100)) if total > 0 else 0
            
            print(self.color("Status:", "bold"))
            print(f"  Phase: {self.color('[PRD]', 'cyan')}")
            print()
            print(self.color("Progress:", "bold"))
            print(f"  Stories: {passing}/{total} complete")
            print(f"  Progress: {progress}%")
            
            # Simple progress bar
            bar_length = 50
            filled = int(bar_length * progress / 100) if progress > 0 else 0
            bar = self.color("█" * filled, "green") + "·" * (bar_length - filled)
            print(f"  [{bar}]")
        
        print()
        print(self.color("Recent Logs:", "bold"))
        print(self.color("─" * 78, "gray"))
        
        logs = state.get("recent_logs", [])
        if not logs:
            print(self.color("No logs yet...", "dim"))
        else:
            for line in logs[-12:]:
                color = "reset"
                if "[ERROR]" in line or "Error:" in line:
                    color = "red"
                elif "[WARN]" in line or "Warning:" in line:
                    color = "yellow"
                elif "[INFO]" in line:
                    color = "blue"
                elif "[DEBUG]" in line:
                    color = "dim"
                elif "✓" in line or "completed" in line.lower():
                    color = "green"
                
                # Truncate long lines
                if len(line) > 76:
                    line = line[:73] + "..."
                
                print(self.color(line, color))
        
        print(self.color("─" * 78, "gray"))
        print(self.color("Press Ctrl+C to exit | Auto-refreshing...", "dim"))
    
    def run(self):
        """Run the terminal viewer loop"""
        print(f"\n🔍 Starting Ralph Terminal Viewer...")
        print(f"📁 State directory: {self.state_dir}")
        print(f"   Press Ctrl+C to stop\n")
        
        try:
            while True:
                self.render()
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n\n👋 Shutting down...")
            return 0


def find_state_dir() -> Optional[str]:
    """Find Ralph state directory"""
    cwd = Path.cwd()
    
    # Check current directory
    state_dir = cwd / "ralph"
    if state_dir.exists():
        return str(state_dir)
    
    # Check parent directories
    for parent in [cwd] + list(cwd.parents):
        state_dir = parent / "ralph"
        if state_dir.exists():
            return str(state_dir)
    
    return None


def main():
    parser = argparse.ArgumentParser(description="Ralph Terminal Viewer")
    parser.add_argument("--state-dir", "-s", type=str, help="Path to Ralph state directory")
    args = parser.parse_args()
    
    state_dir = args.state_dir or find_state_dir()
    if not state_dir:
        print("Error: Could not find Ralph state directory")
        print("Run this from your project directory or specify --state-dir")
        return 1
    
    viewer = RalphTerminalViewer(state_dir)
    return viewer.run()


if __name__ == "__main__":
    exit(main())
