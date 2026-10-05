#!/usr/bin/env python3
"""Accept only trusted T3 Code Hermes patch-drift GitHub events."""

from __future__ import annotations

import json
import re
import sys

REPOSITORY = "NateWeav/t3code-hermes"
DRIFT_LABEL = "hermes-patch-drift"
MANUAL_LABEL = "hermes-auto-resolve"
BOT_LOGINS = {"github-actions[bot]", "github-actions"}
OWNER_LOGIN = "NateWeav"
TITLE_PREFIX = "Hermes patch drift ("
STATUSES = {"doesNotApply", "obsolete", "stackConflict", "testsFailed", "ok"}
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9_.@+\-/]+$")


def ignore() -> None:
    print("[SILENT]")
    raise SystemExit(0)


def safe_path(path: str) -> bool:
    return (
        bool(SAFE_PATH.fullmatch(path))
        and not path.startswith("/")
        and ".." not in path.split("/")
    )


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        ignore()

    repository = payload.get("repository") or {}
    issue = payload.get("issue") or {}
    sender = payload.get("sender") or {}
    action = payload.get("action")

    if repository.get("full_name") != REPOSITORY:
        ignore()
    if not isinstance(issue.get("number"), int) or issue["number"] < 1:
        ignore()
    if not str(issue.get("title") or "").startswith(TITLE_PREFIX):
        ignore()

    labels = {
        str(label.get("name"))
        for label in issue.get("labels") or []
        if isinstance(label, dict)
    }
    if DRIFT_LABEL not in labels:
        ignore()

    sender_login = sender.get("login")
    comment = payload.get("comment")
    if isinstance(comment, dict):
        if action != "created" or sender_login not in BOT_LOGINS:
            ignore()
        source_text = str(comment.get("body") or "")
        trigger = "scheduled drift report comment"
    elif action in {"opened", "reopened"} and sender_login in BOT_LOGINS:
        source_text = str(issue.get("body") or "")
        trigger = "scheduled drift issue"
    elif (
        action == "labeled"
        and sender_login == OWNER_LOGIN
        and (payload.get("label") or {}).get("name") == MANUAL_LABEL
    ):
        source_text = str(issue.get("body") or "")
        trigger = "manual resolution request"
    else:
        ignore()

    hermes_match = re.search(r"(?m)^Hermes main:\s+`([0-9a-fA-F]{40})`\s*$", source_text)
    run_match = re.search(
        rf"https://github\.com/{re.escape(REPOSITORY)}/actions/runs/(\d+)",
        source_text,
    )
    status_section = re.search(
        r"Patch status:\s*\n(.*?)(?:\n\s*\n|\Z)", source_text, re.DOTALL
    )
    if not hermes_match or not run_match or not status_section:
        ignore()

    patches = []
    current = None
    for line in status_section.group(1).splitlines():
        patch_match = re.fullmatch(r"-\s+`([^`]+)`:\s+`([A-Za-z]+)`(?:\s+\(.*\))?\s*", line)
        test_match = re.fullmatch(r"\s{2,}-\s+`([^`]+)`\s*", line)
        if patch_match:
            patch_id, status = patch_match.groups()
            current = None
            if SAFE_ID.fullmatch(patch_id) and status in STATUSES:
                current = {"id": patch_id, "status": status, "failing_tests": []}
                patches.append(current)
        elif test_match and current is not None:
            path = test_match.group(1)
            if safe_path(path) and path.startswith("tests/"):
                current["failing_tests"].append(path)
    patches = list({patch["id"]: patch for patch in patches}.values())[:20]
    for patch in patches:
        patch["failing_tests"] = list(dict.fromkeys(patch["failing_tests"]))[:20]

    drifted = [patch for patch in patches if patch["status"] != "ok"]
    if not drifted:
        ignore()

    issue_number = issue["number"]
    run_id = run_match.group(1)
    hermes_sha = hermes_match.group(1).lower()
    result = {
        "repo": REPOSITORY,
        "issue_number": issue_number,
        "issue_url": f"https://github.com/{REPOSITORY}/issues/{issue_number}",
        "run_url": f"https://github.com/{REPOSITORY}/actions/runs/{run_id}",
        "hermes_sha": hermes_sha,
        "hermes_sha12": hermes_sha[:12],
        "drifted_ids": ", ".join(patch["id"] for patch in drifted),
        "patches": patches,
        "trigger": trigger,
    }
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
