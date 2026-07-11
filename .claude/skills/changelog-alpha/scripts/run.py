#!/usr/bin/env python3
"""
changelog-alpha runner:
  - Reads _todo.md
  - Finds sections headed "## [x] TODO-NNN: ..."
  - Prints one CHANGELOG line per completed TODO
  - Rewrites _todo.md: [x] → [~] (already logged)

Usage: python3 run.py >> _CHANGELOG-alpha.md
"""

import re
import os
from datetime import datetime

TODO_PATH = os.path.join(os.getcwd(), "_todo.md")
TIMESTAMP = datetime.now().strftime("%Y-%m-%d %H:%M")


def parse_todo_sections(text: str):
    """Yield (heading_line, heading_marker, heading_title, body_lines) for each completed TODO."""
    lines = text.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        m = re.match(r"^## \[(.)\]\s+(TODO-\d+)(.*)", lines[i])
        if m:
            marker, todo_id, rest = m.group(1), m.group(2), m.group(3).strip()
            if marker == "x":
                # Collect body until next ## or end
                j = i + 1
                body = []
                while j < len(lines) and not lines[j].startswith("## "):
                    body.append(lines[j].rstrip())
                    j += 1
                yield i, marker, todo_id, rest, body
                i = j
                continue
        i += 1


def clean_text(text: str) -> str:
    """Strip markdown bold, backticks, and extra whitespace."""
    t = text
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"`(.+?)`", r"\1", t)
    return t.strip().rstrip("，：:,;；：")


def extract_goal_section(body_lines: list[str]) -> str | None:
    """Extract content from ### 目标 section."""
    in_goal = False
    items = []
    for ln in body_lines:
        line = ln.strip()
        if line.startswith("### 目标"):
            in_goal = True
            continue
        if in_goal:
            if line.startswith("###"):
                break
            if line and not line.startswith("---"):
                item = re.sub(r"^\d+\.\s*", "", line)
                item = re.sub(r"^- ", "", item)
                item = clean_text(item)
                if item:
                    items.append(item)
    return "，".join(items) if items else None


def generate_changelog(todo_id: str, title_rest: str, body_lines: list[str]) -> str:
    """Generate a human-readable CHANGELOG line from title and goal."""
    title = (title_rest or todo_id).lstrip("：:").strip()
    goal = extract_goal_section(body_lines)
    if goal:
        return f"{TIMESTAMP}: {title} —— {goal}"
    return f"{TIMESTAMP}: {title}"


def rewrite_todo(text: str, matched_lines: set[int]) -> str:
    """Replace [x] → [~] on matched heading lines."""
    lines = text.splitlines(keepends=True)
    for lineno in sorted(matched_lines, reverse=True):
        lines[lineno] = lines[lineno].replace("[x]", "[~]", 1)
    return "".join(lines)


def main():
    if not os.path.exists(TODO_PATH):
        print(f"⚠ _todo.md not found at {TODO_PATH}", file=__import__("sys").stderr)
        raise SystemExit(1)

    with open(TODO_PATH) as f:
        text = f.read()

    entries = list(parse_todo_sections(text))
    if not entries:
        print("ℹ No completed TODO entries found.", file=__import__("sys").stderr)
        return

    matched = set()
    for lineno, marker, todo_id, title, body in entries:
        line = generate_changelog(todo_id, title, body)
        print(line)
        matched.add(lineno)

    new_text = rewrite_todo(text, matched)
    with open(TODO_PATH, "w") as f:
        f.write(new_text)

    print(f"ℹ {len(entries)} entries logged, TODO markers updated.", file=__import__("sys").stderr)


if __name__ == "__main__":
    main()
