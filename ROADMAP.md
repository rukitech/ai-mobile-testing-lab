# Roadmap

Each phase ships something usable on its own. Order follows the original
project brief; the lean stack (ARCHITECTURE.md §1) is upgraded only when a
phase actually needs it.

## Phase 1 — workers, devices, builds ✅ (this release)

Worker enrollment + short-lived tokens, WebSocket protocol, device discovery
(iOS sims, Android AVDs, USB Android), boot/shutdown/restart, install/
uninstall/launch/terminate, screenshots, logs, Android screen profiles,
leases with expiry recovery, build store with one-click distribution, audit log.

## Phase 2 — Maestro runs and reports ✅ core / ⏳ rest

Done: shared-mode runs (same flow × N devices), concurrency limit, per-device
status/duration/error, step and final screenshots, JUnit + Maestro logs,
side-by-side run view.

Next, from what the first real run showed:
1. **iOS lock screen after boot.** Unlock or launch before Maestro (try
   `simctl launch` first, then `pressKey: Home` in a prelude flow), and verify on 17.5 and 26.x.
2. **Cancel in-flight Maestro.** Cancelling stops between steps today; add a
   `command.cancel` frame that kills the worker's child process.
3. **Retry policy.** `attempt` exists on `test_tasks`; retry infra errors
   (`WORKER_LOST`, `TIMEOUT`, `LOW_DISK` after cleanup), never test failures.
4. **Disk hygiene.** A worker command to list or erase lab-created simulator
   data, and artifact retention (delete runs older than N days).
5. Multi-flow suites (folders) and tags.

## Phase 3 — Claude + Mobile MCP

Agent roles (Planner, Explorer, Test Generator, Bug Analyzer) as Claude Agent
SDK sessions. An agent **leases a device like any task** (`AgentTaskRunner`
plugs into `Scheduler`) and drives it through Mobile MCP, which runs on the
worker. New tables: `agent_sessions` (tokens, cost, status, timeout, retries),
plus structured outputs stored as artifacts. Explorer output → Test Generator
→ a new Maestro suite, so repeat runs stay deterministic and cheap.

## Phase 4 — parallel independent agent tasks (Mode B)

`test_runs.mode = 'agent'`: different tasks per agent, each with its own
device lease, a per-run concurrency cap and a spending cap. Swap the in-process
queue for BullMQ + Redis here, the first phase that needs multiple server
processes.

## Phase 5 — visual regression

Python/OpenCV service: align → pixel diff → region diff → heatmap, then Claude
Vision for a semantic verdict (clipped text, safe-area, spacing, colour).
Baselines keyed by (suite step, platform, device class, screen size).
Uploaded reference images first, design-tool integrations later. Pixel noise
alone never creates an issue; issues carry severity + confidence.

## Phase 6 — repair loop

Group failures → Bug Analyzer locates code → isolated git worktree → Repair
Agent edits → lint/unit tests → build both platforms → rerun failures, then
regressions. At most 3 attempts per issue. **Never merges or pushes.** A human
reviews the branch. Every step is in `repair_attempts` + `audit_log`.

## Phase 7 — 10–20 devices

Postgres, S3/MinIO artifacts, several workers per platform, per-worker
capacity (RAM/disk-aware scheduling), dashboard pagination and filters.
