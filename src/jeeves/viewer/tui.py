#!/usr/bin/env python3
"""Jeeves Terminal Viewer - SDK-only status viewer."""

import argparse
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional


class JeevesTerminalViewer:
    """Terminal-based viewer for Jeeves."""

    COLORS = {
        "reset": "\033[0m",
        "red": "\033[91m",
        "green": "\033[92m",
        "yellow": "\033[93m",
        "blue": "\033[94m",
        "magenta": "\033[95m",
        "cyan": "\033[96m",
        "gray": "\033[90m",
        "bold": "\033[1m",
    }

    PHASE_COLORS = {
        "design_draft": "magenta",
        "design_review": "magenta",
        "design_edit": "magenta",
        "implement": "yellow",
        "code_review": "yellow",
        "code_fix": "yellow",
        "complete": "blue",
    }

    def __init__(self, state_dir: str):
        self.state_dir = Path(state_dir)
        self.issue_file = self.state_dir / "issue.json"
        self.progress_file = self.state_dir / "progress.txt"
        self.last_run_log = self.state_dir / "last-run.log"
        self.viewer_run_log = self.state_dir / "viewer-run.log"
        self.last_update = 0
        self._cache: Dict = {}

    def color(self, text: str, color_name: str) -> str:
        return f"{self.COLORS[color_name]}{text}{self.COLORS['reset']}"

    def get_state(self) -> Dict:
        now = time.time()
        if now - self.last_update < 0.3 and self._cache:
            return self._cache

        state = {
            "timestamp": datetime.now().isoformat(),
            "config": {},
            "status": {},
            "progress_lines": [],
            "recent_logs": [],
        }

        if self.issue_file.exists():
            state["config"] = self._read_json(self.issue_file) or {}

        if self.progress_file.exists():
            state["progress_lines"] = self._read_lines_tail(self.progress_file, 20)

        log_path = self._get_log_path()
        if log_path.exists():
            state["recent_logs"] = self._read_lines_tail(log_path, 50)

        config = state["config"]
        issue = config.get("issue", {})
        state["status"] = {
            "phase": config.get("phase", "design_draft"),
            "issue_number": issue.get("number"),
            "issue_title": issue.get("title"),
            "branch_name": config.get("branch") or config.get("branchName"),
            "design_doc": config.get("designDocPath") or config.get("designDoc"),
        }

        self._cache = state
        self.last_update = now
        return state

    def _get_log_path(self) -> Path:
        if self.last_run_log.exists() and self.last_run_log.stat().st_size > 0:
            return self.last_run_log
        if self.viewer_run_log.exists() and self.viewer_run_log.stat().st_size > 0:
            return self.viewer_run_log
        return self.last_run_log

    def _read_json(self, path: Path) -> Optional[Dict]:
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return None

    def _read_lines_tail(self, path: Path, count: int) -> list:
        try:
            with open(path) as f:
                lines = f.readlines()
                return [line.rstrip("\n") for line in lines[-count:]]
        except Exception:
            return []

    def render(self):
        state = self.get_state()
        status = state["status"]

        print("\033[2J\033[H", end="")
        print(self.color("╔" + "═" * 76 + "╗", "bold"))
        title = "🤖 Jeeves Terminal Viewer"
        padding = " " * ((78 - len(title)) // 2)
        print(self.color("║", "bold") + padding + self.color(title, "bold") + padding + self.color("║", "bold"))
        print(self.color("╚" + "═" * 76 + "╝", "bold"))
        print()

        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"Updated: {self.color(timestamp, 'gray')}")
        print()

        phase = status.get("phase", "design_draft")
        phase_color = self.PHASE_COLORS.get(phase, "gray")
        print(self.color("Status:", "bold"))
        print(f"  Phase: {self.color(phase.upper(), phase_color)}")
        if status.get("issue_number"):
            print(f"  Issue: #{status['issue_number']}")
        if status.get("issue_title"):
            print(f"  Title: {status['issue_title']}")
        if status.get("branch_name"):
            print(f"  Branch: {status['branch_name']}")
        if status.get("design_doc"):
            print(f"  Design Doc: {status['design_doc']}")

        print()
        print(self.color("Recent Logs:", "bold"))
        logs = state.get("recent_logs", [])[-10:]
        if not logs:
            print(self.color("  (no logs)", "gray"))
        else:
            for line in logs:
                print(f"  {line}")

    def run(self):
        try:
            while True:
                self.render()
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nStopping...")
            return 0


def main():
    parser = argparse.ArgumentParser(description="Jeeves Terminal Viewer")
    parser.add_argument("--state-dir", type=str, required=True, help="Path to issue state directory")
    args = parser.parse_args()

    viewer = JeevesTerminalViewer(args.state_dir)
    return viewer.run()


if __name__ == "__main__":
    raise SystemExit(main())
