# Architecture

AI Mobile Testing Lab drives many iOS simulators and Android emulators from one
control point. You can't run iOS and Android screens inside a single simulator
(iOS Simulator is macOS-only and simulates one device model per instance). The
lab instead gives you **one orchestrator** for many simulators: pick devices,
install a build on all of them, run the same Maestro flow in parallel and
compare the screenshots side by side.

This document covers the shipped lean core (Phases 1–2) and the seams where
the later phases (Claude agents, visual regression, auto-repair) plug in.

## 1. Components

```
                    ┌──────────────────────────── server (Node/Fastify) ─────────────────────────────┐
 Dashboard (React) ─┤ REST /api/*   WS /ws/dashboard (live events)                                     │
 CLI (lab ...)     ─┤ Registry (workers, devices)  Lease manager  Scheduler  Build store  Artifact store│
                    │ SQLite (node:sqlite) - schema kept Postgres-portable                              │
                    └───────────────▲──────────────────────────────────▲──────────────────────────────┘
                                    │ WS /ws/worker (outbound from     │
                                    │ worker, token in header)         │
                ┌───────────────────┴──────────┐        ┌──────────────┴───────────────┐
                │ macOS worker                 │        │ Windows worker (same code)   │
                │  IosSimDriver   (xcrun simctl)│        │  AndroidDriver (adb/emulator)│
                │  AndroidDriver  (adb/emulator)│        │  Maestro CLI                 │
                │  Maestro CLI                 │        └──────────────────────────────┘
                └──────────────────────────────┘
```

* **One worker codebase, platform drivers chosen by host OS.** A macOS worker
  exposes both iOS simulators and Android emulators; a Windows/Linux worker
  only enables the Android driver. The iOS driver refuses to load when
  `process.platform !== 'darwin'`. Nothing ever assumes iOS runs off macOS.
* **Workers dial out.** A worker opens a WebSocket *to* the server, so it works
  behind NAT/firewalls and the server never needs SSH or shell access to a
  worker machine.
* **The server is the only writer of state.** Workers report facts (devices,
  command results, artifacts). They never touch the database.

### Why this stack instead of the full spec stack (for now)

| Spec item | Lean choice now | Upgrade path |
|---|---|---|
| NestJS | Fastify 5 modules (`registry`, `leases`, `scheduler`, `builds`) | Each module is a plain class with injected deps, so it maps 1:1 onto Nest providers |
| PostgreSQL | SQLite via built-in `node:sqlite` (zero native deps, no Docker) | SQL is ANSI + `TEXT` ids + ISO timestamps; migrations are plain `.sql` files |
| Redis + BullMQ | In-process scheduler with a concurrency limit, durable state in `test_tasks` | Swap `Scheduler.enqueue` for a BullMQ queue; task rows already carry status/attempts |
| S3 | `LAB_DATA_DIR/artifacts` on local disk behind `ArtifactStore` | Implement the same interface against S3/MinIO |
| Tailwind + shadcn | Plain CSS design tokens | Cosmetic; does not affect contracts |

The lean core removes Docker, Postgres and Redis as prerequisites, because the
dev Mac this was built on has none of them and very little free disk.

## 2. Device identity — the subtle part

| Platform | Stable key (`deviceKey`) | Runtime handle | Notes |
|---|---|---|---|
| iOS Simulator | simulator UDID | same UDID | UDID exists while the simulator is shut down |
| Android Emulator | AVD name | `emulator-<port>` serial, assigned at boot | Serial is **not** stable. The worker boots on a chosen even port so it knows the serial in advance, and maps running emulators back to AVDs with `adb -s <serial> emu avd name` |

The server id of a device is `<workerId>:<platform>:<deviceKey>`, so two
workers can't collide.

### Screen profiles (Android only)

`device.screenProfile` runs `adb shell wm size WxH` + `wm density D` on a
*running* emulator. This makes one phone AVD render at tablet dimensions and
density, and Android's `smallestWidth` resource buckets react to it. It is an
**approximation**: the system UI, hardware-keyed features and the reported
model name stay those of the phone. For a real tablet, create a tablet AVD
(needs Android SDK `cmdline-tools`, see README). `reset` restores the
defaults. iOS has no equivalent, so boot a different simulator model instead.

## 3. Worker protocol (WebSocket `/ws/worker`)

Transport: JSON text frames. Every frame is validated with zod on both sides
(`packages/shared/src/protocol.ts` is the single source of truth).

### 3.1 Enrollment and session tokens

1. `POST /api/workers/register` with `{ name, os, enrollmentSecret, capabilities }`
   → `{ workerId, token, expiresAt }`. The token is an HMAC-SHA256-signed
   `{ workerId, exp }` with a 15-minute lifetime. A worker re-registering under
   the same `name` keeps its `workerId`.
2. The worker opens `ws://server/ws/worker` with `Authorization: Bearer <token>`.
3. The worker sends `token.refresh` every 10 minutes and the server answers
   `token.refreshed`. When the token expires the server closes the socket with
   code **4001**, and the worker re-enrolls.

The enrollment secret never travels in a WebSocket frame or a URL.

### 3.2 Frames

Worker → server

| type | payload | when |
|---|---|---|
| `hello` | `{ workerId, version, os, capabilities: ('ios'\|'android'\|'maestro')[] }` | right after connect |
| `heartbeat` | `{ at, load: { cpus, freeMemMb } }` | every 10 s |
| `devices.report` | `{ devices: DeviceReport[] }` | after `hello`, after any boot/shutdown, every 30 s |
| `command.event` | `{ commandId, level, message }` | streamed while a command runs (Maestro output lines) |
| `command.result` | `{ commandId, ok, data?, error?: { code, message } }` | exactly once per command |
| `token.refresh` | `{}` | every 10 min |

Server → worker

| type | payload |
|---|---|
| `command` | `{ commandId, name, deviceKey?, platform?, args, timeoutMs }` |
| `token.refreshed` | `{ token, expiresAt }` |

`DeviceReport = { platform, deviceKey, serial?, name, model, osVersion, state: 'booted'|'shutdown'|'booting'|'unknown', screen?: { width, height, density } }`

### 3.3 Commands

| name | args | result `data` |
|---|---|---|
| `device.discover` | – | `{ devices: DeviceReport[] }` |
| `device.boot` | – | `{ serial? }` (waits for full boot) |
| `device.shutdown` | – | – |
| `device.restart` | – | `{ serial? }` |
| `device.install` | `{ buildId, sha256 }` | – (worker downloads `GET /api/builds/:id/file`, checks sha256, caches) |
| `device.uninstall` | `{ appId }` | – |
| `device.launch` / `device.terminate` | `{ appId }` | – |
| `device.screenshot` | `{ taskId? }` | `{ artifactId }` (PNG uploaded to `POST /api/artifacts`) |
| `device.logs` | `{ lines?: number }` | `{ text }` (last N lines; secrets are never added by the lab) |
| `device.screenProfile` | `{ profile: 'phone'\|'tablet-7'\|'tablet-10'\|'reset' }` | `{ width, height, density }` |
| `device.frame` | `{ maxSize }` | – (worker screenshots, downsizes to JPEG with `sips` on macOS, POSTs to `/api/live/frames`) |
| `maestro.run` | `{ taskId, flowYaml, appId, env }` | `{ exitCode, durationMs, artifactIds }` |

Error codes: `TIMEOUT`, `NOT_FOUND`, `UNSUPPORTED_PLATFORM`, `TOOL_MISSING`,
`CHECKSUM_MISMATCH`, `EXEC_FAILED`, `BAD_ARGS`.

Every external tool is started with `execFile`/`spawn` and an **argument
array**. No shell string is ever built from user input. Device keys,
app ids and AVD names are checked against allow-list regexes before use.

## 4. REST API (dashboard and CLI)

All routes need `Authorization: Bearer <LAB_DASHBOARD_TOKEN>`, except the
two worker routes that take a worker session token.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/health` | – (no auth) | `{ ok, version }` |
| GET | `/api/overview` | – | counts of workers/devices/runs by state |
| GET | `/api/workers` | – | `Worker[]` |
| POST | `/api/workers/register` | enrollment (see 3.1) | `{ workerId, token, expiresAt }` |
| GET | `/api/devices` | `?platform=&state=` | `Device[]` (with lease info) |
| POST | `/api/devices/:id/actions/:action` | `{ args }`, action ∈ boot, shutdown, restart, install, uninstall, launch, terminate, screenshot, logs, screen-profile | `{ ok, data }`. Refused with **409** while another holder leases the device (except screenshot/logs) |
| GET | `/api/builds` | – | `Build[]` |
| POST | `/api/builds` | raw body (APK or zipped `.app`), headers `x-build-name`, `x-platform`, `x-app-id`, `x-file-name` | `Build` |
| GET | `/api/builds/:id/file` | worker token | file stream |
| POST | `/api/builds/:id/distribute` | `{ deviceIds? }` (default: all compatible) | `{ results: { deviceId, ok, error? }[] }` |
| GET/POST | `/api/suites` | `{ name, flowYaml }` | `TestSuite` |
| POST | `/api/runs` | `{ suiteId, deviceIds, builds: { ios?, android? }, env? }` | `TestRun` |
| GET | `/api/runs` / `/api/runs/:id` | – | run + tasks + artifacts |
| POST | `/api/runs/:id/cancel` | – | `TestRun` |
| POST | `/api/artifacts` | worker token, raw body, headers `x-task-id`, `x-kind`, `x-file-name` | `{ artifactId }` |
| GET | `/api/artifacts/:id` | – | file stream |
| POST | `/api/live/watch` | `{ deviceIds }`; renew every few seconds, expires after 10 s | `{ intervalMs, watchTtlMs }` |
| GET | `/api/live/frames/:deviceId` | – | latest frame (`image/jpeg` or `image/png`), `x-frame-at`, `no-store` |
| POST | `/api/live/frames` | worker token, raw body, headers `x-device-key`, `x-platform`, `x-image-type` | `{ ok }`. The device id is derived from the token's worker, so a worker can't post frames for another worker's devices |

Dashboard live events (`/ws/dashboard`, first frame must be
`{type:'auth', token}` within 5 s, so no token ever goes in a URL):
`worker.updated`, `device.updated`, `run.updated`, `task.updated`,
`task.log`, `artifact.created`, `live.frame` (the dashboard then fetches that
device's frame; these bypass the generic page-refresh path).

### Live Wall

`LiveFrames` (server/src/live.ts) keeps **only the latest frame per device in
memory**. Every 250 ms it requests a frame from each device that is watched,
booted and online, at most once per 1.5 s and never with a capture already in
flight. A watch expires 10 s after the last renewal, and the frame is dropped
with it. Frames are screenshots, not video: good enough to follow a test, and
they work identically for simulators, emulators and USB devices.

## 5. Scheduling, leases and task states

```
queued ──► leasing ──► preparing ──► running ──► passed
   │          │            │            ├──────► failed     (Maestro exit ≠ 0)
   │          │            │            └──────► error      (infra: timeout, worker lost, lease expired)
   └──────────┴────────────┴──────────────────► cancelled
```

Allowed transitions are enforced in `packages/server/src/taskState.ts`, which
throws on anything else.

* **Lease = exclusive right to a device**, row in `device_leases`
  (`device_id` primary key, so two rows for one device are impossible). Acquire
  is one transaction: delete the expired lease for that device, then insert.
* The scheduler renews held leases every `LEASE_SECONDS/3`. A sweeper releases
  expired leases every 10 s and fails their tasks with `error: LEASE_EXPIRED`.
  That recovers devices whose worker or server crashed mid-task.
* **Concurrency:** at most `LAB_MAX_PARALLEL_TASKS` tasks hold leases at the
  same time. Each task is one device × one flow.
* **Task pipeline:** lease → `device.boot` (if not booted) →
  `device.install` (build matching platform; always reinstalled, because a
  simulator may have been erased or the app removed since the last run; the
  download itself is cached per worker by build id + sha256) → `maestro.run` →
  `device.screenshot` (a final screenshot, so every device produces at least
  one comparable image even if the flow takes none) → release.
* Worker disconnect: in-flight commands to that worker reject with
  `WORKER_LOST`, their tasks go to `error`, and their leases are released.

## 6. Database schema (migration `001_init.sql`)

| Table | Key columns | Notes |
|---|---|---|
| `projects` | id, name, created_at | one default project seeded |
| `workers` | id, name UNIQUE, os, capabilities (json), status, last_heartbeat_at | status: online/offline |
| `devices` | id, worker_id FK, platform, device_key, serial, name, model, os_version, screen_w/h/density, state, availability, last_seen_at | UNIQUE(worker_id, platform, device_key) |
| `device_leases` | device_id PK FK, holder, task_id, acquired_at, expires_at | exclusive lock |
| `builds` | id, project_id FK, name, platform, app_id, file_path, file_name, size_bytes, sha256, created_at | |
| `build_installs` | id, build_id FK, device_id FK, status, error, updated_at | install status per device |
| `test_suites` | id, project_id FK, name, flow_yaml, created_at | one Maestro flow per suite for now |
| `test_runs` | id, project_id FK, suite_id FK, status, mode ('shared'), created_at, finished_at | `mode='agent'` reserved for Phase 4 |
| `test_tasks` | id, run_id FK, device_id FK, build_id FK, status, attempt, error, started_at, finished_at, duration_ms | indexed by (run_id), (status) |
| `artifacts` | id, run_id FK, task_id FK, kind ('screenshot'\|'junit'\|'log'\|'maestro-output'), file_path, file_name, size_bytes, created_at | screenshots live here until Phase 5 adds `screenshots`/`visual_baselines` |
| `audit_log` | id, actor, action, target, detail (json), at | every device action, build upload, run start/cancel |

Reserved for later migrations (designed, not created yet): `agent_sessions`
(Phase 3), `visual_baselines`, `screenshots` with region metadata (Phase 5),
`issues`, `repair_attempts` (Phase 6).

## 7. Platform constraints

* **iOS Simulator only on macOS.** Each simulator costs about 1–2 GB RAM and
  several GB of disk the first time it boots. `simctl` can't change a
  simulator's screen size, so each screen size is its own device type.
* **iOS builds:** a simulator build is a `.app` *directory* (the CLI zips it
  with `ditto`). Device `.ipa` files don't install on simulators. Release
  simulator builds embed the JS bundle; Debug builds need Metro running.
* **Android emulator serials change per boot.** The worker pins the port.
  API 36 images need `-no-snapshot-load` for a cold, reliable boot.
* **Maestro:** one Maestro process per device. Maestro installs its own driver
  app on each device the first time (slow, about 30–60 s). Running several
  Maestro processes at once on one host has to be verified per host; see the
  README's verification table.
* **Windows:** `maestro` and Android SDK tools are `.bat`/`.exe`. Node refuses
  to `execFile` a `.bat` without `shell: true` (CVE-2024-27980), so the Windows
  path quotes and validates every argument. **The Windows worker is not yet
  verified on real hardware.**
* **Disk:** simulators and emulators are disk-hungry. A simulator's first boot
  writes ~0.7 GB, and an emulator killed without `-no-snapshot-save` writes a
  ~1 GB RAM snapshot. Boots run **one at a time per worker**, each after a
  fresh free-disk check (refused below 3 GB with `LOW_DISK`). Running them in
  parallel let four boots all pass the check and then fill the disk together
  (seen on the first real run: 6 GB → 0.2 GB).
* **iOS lock screen:** a freshly booted iOS 17.5 simulator stayed on the lock
  screen and Maestro's `launchApp` failed with "Unknown error" (the final
  screenshot shows it). Not yet handled; see ROADMAP.
* **Android downgrades:** `adb install -r` refuses an APK whose versionCode is
  lower than the installed one, or which is signed with another key. The
  driver reports both with an actionable message. It never uninstalls on its
  own, because that would wipe the app's data on the device.

## 8. Seams for later phases

* `Scheduler` takes a `TaskRunner` strategy. `MaestroTaskRunner` is the only
  one today. Phase 3/4 add an `AgentTaskRunner` that leases a device and hands
  it to a Claude session through Mobile MCP.
* `ArtifactStore` → S3. `Queue` → BullMQ. `Db` → Postgres. Each is one file.
* Phase 5's visual regression runs as a separate Python/OpenCV service that
  reads screenshot artifacts by id and writes `issues`.
