# AI Mobile Testing Lab

Test your app on many screens from one place: iPhones, iPads, Android phones
and (emulated) tablets. Pick devices, install a build on all of them, run the
same [Maestro](https://github.com/mobile-dev-inc/Maestro) flow in parallel, and
compare the screenshots side by side.

> **One simulator can't show every device.** iOS screens only exist in the
> iOS Simulator (macOS only), Android screens only in the Android Emulator.
> This lab is the single control point *for* many simulators. On Android it
> can also make one emulator act as a phone, a 7" tablet or a 10" tablet
> (screen profiles, see ARCHITECTURE.md §2).

**Live Wall:** one dashboard page shows every booted device side by side,
refreshing every 1.5–3 s, including devices running a test right now. Frames
are small JPEG screenshots relayed through server memory (not video, never
written to disk), and only devices someone is watching get captured.

Status: **Phase 1 + the core of Phase 2**. Claude agents, visual regression
and auto-repair are designed but not built yet (ROADMAP.md).

```
packages/
  shared/     wire protocol (zod) + screen profiles, used by everything
  server/     Fastify API, WebSockets, SQLite, leases, scheduler
  worker/     runs on each macOS / Windows machine: simctl, adb, emulator, Maestro
  cli/        `npm run lab -- …`
  dashboard/  React UI (served by the server after `npm run build:dashboard`)
flows/        example Maestro flows, loaded as suites on first start
```

## macOS setup (iOS + Android worker)

Requirements: Node ≥ 22.13, Xcode with at least one iOS simulator runtime,
Maestro CLI (`curl -fsSL "https://get.maestro.mobile.dev" | bash`), Java 17.
Optional for Android: Android Studio (SDK + emulator + an AVD).

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in the three secrets in `.env`; each should be random:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the server, then a worker on the same Mac (two terminals):

```bash
npm run server
```

```bash
npm run worker
```

Dashboard (served by the server once built; enter `LAB_DASHBOARD_TOKEN` on first visit):

```bash
npm run build:dashboard
```

Then open http://localhost:4300. For hot-reload development use `npm run dashboard` (port 5173).

## Windows setup (Android worker) — not yet verified on real hardware

1. Install Node ≥ 22.13, Android Studio (SDK, emulator, one AVD), Java 17 and Maestro for Windows.
2. Clone this repo, `npm install`, copy `.env.example` to `.env`.
3. Set `LAB_SERVER_URL` to the macOS (or other) machine running the server, plus
   the same `LAB_WORKER_ENROLLMENT_SECRET`. Set `ANDROID_HOME` if the SDK isn't
   in `%LOCALAPPDATA%\Android\Sdk`, and `LAB_MAESTRO_BIN` if `maestro.bat` isn't on PATH.
4. On the server machine set `LAB_HOST=0.0.0.0` and put a TLS reverse proxy in front (SECURITY.md).
5. `npm run worker`. The worker reports only the Android capability. The server
   refuses an iOS capability from a non-mac worker.

The Windows path is code-complete but **untested**, because no Windows
machine was available. Expect to fix paths or quoting on the first run.

## Everyday use (CLI)

```bash
npm run lab -- devices
```

```bash
npm run lab -- build add ~/Library/Developer/Xcode/DerivedData/<App>/Build/Products/Debug-iphonesimulator/App.app
```

```bash
npm run lab -- build add android/app/build/outputs/apk/release/app-release.apk
```

```bash
npm run lab -- run smoke-launch --devices "iPhone 16e@26.2,iPad (A16)@26.2,Pixel 6" --ios-build <id> --android-build <id>
```

```bash
npm run lab -- action "Pixel 6" screen-profile tablet-10
```

`name@version` picks a runtime when the same simulator exists on several iOS
versions. Flows use `appId: ${APP_ID}`; the lab fills it in per platform from
the build.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

34 tests: lease exclusivity/expiry/renewal, task state machine, worker token
signing/forgery, path traversal, argument-injection allow-lists, tool-output
parsers (simctl, adb, AVD config, `wm`), Maestro argv, and an end-to-end run
over the real HTTP + WebSocket protocol with a scripted fake worker (mixed
pass/fail, boot-if-needed, artifact ownership, 409 on leased devices,
worker loss mid-task), and the Live Wall (only watched + booted devices are
polled, one capture in flight per device, watches expire, frames can't be
spoofed by another worker, nothing hits disk).

## What has been verified on real devices (macOS, 2026-11-23)

| Workflow | Result |
|---|---|
| Worker enrollment, heartbeat, WebSocket session | ✅ |
| Discovery: 50+ iOS simulators (iOS 15–26) with screen size/scale from device-type profiles; 2 Android AVDs with screen from config.ini | ✅ |
| Boot iOS simulators (3 in parallel) and an Android emulator (Android 16 / API 36) | ✅ |
| Build upload with app-id auto-detection (`plutil` / `aapt2`), worker download + sha256 check + unzip | ✅ |
| iOS install on simulators (iOS 17.5, 26.2) | ✅ |
| Maestro run per device with `--device`, artifacts (step screenshots, JUnit, log) uploaded and shown per device | ✅ pipeline works. The flow itself failed: the iOS 17.5 simulator sat on the lock screen (see ROADMAP) |
| Android install | ❌ correctly refused: the APK on disk (versionCode 61) is older than the installed app (64). The error message was improved after this |
| Several Maestro processes at once on one Mac | ⚠️ not proven: two runs overlapped for only ~4 s before the run was stopped |
| Live Wall on a running iOS 26.2 simulator: a new frame every 1.5–3 s, ~47 KB JPEG each, no files left behind | ✅ |
| Screen profiles (`wm size/density`), Windows worker, dashboard device actions against live devices | ⏳ not run yet. The first run was stopped because **disk dropped to ~0.2 GB free** |

The run was stopped on purpose to protect the disk. Free at least 20–30 GB
before running more than one device. See "Disk" in ARCHITECTURE.md §7.

## License

MIT, see [LICENSE](LICENSE).
