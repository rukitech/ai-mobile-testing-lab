# Security

## Threat model (Phase 1)

The server controls machines that run simulators, install arbitrary app
builds and (from Phase 3) host AI agents. The main risks are: an attacker
posing as a worker, a worker or dashboard user getting command execution on
another machine, build or artifact tampering, and secrets leaking into logs
or agent context.

## Controls in place

| Area | Control | Where |
|---|---|---|
| Dashboard/CLI auth | Bearer token, constant-time compare; every `/api/*` route except health and the two worker file routes | `server/src/app.ts` |
| Worker enrollment | Long-lived enrollment secret used **once** per session to get a 15-min HMAC-SHA256 token; 10 failed attempts/min/IP → 429; failures audited | `auth.ts`, `app.ts` |
| Worker sessions | Token in the `Authorization` header (never a URL); expiry checked on every frame → close 4001; refresh every 10 min | `workerHub.ts` |
| Dashboard socket | Token sent as the first frame within 5 s, never in a URL | `app.ts` |
| Command execution | Tools run with argv arrays, no shell. Device keys, serials, app ids and env keys/values are allow-listed by regex (first character alphanumeric, so nothing reads as a flag). Windows `.bat` (needs a shell) gets an extra cmd-metacharacter check | `shared/protocol.ts`, `worker/src/exec.ts` |
| No remote shell | The protocol has a fixed command list; there is no "run this" frame | `protocol.ts` |
| Build integrity | sha256 computed on upload, verified by the worker after download | `store.ts`, `transfer.ts` |
| File handling | Upload names reduced to safe basenames; every stored path is resolved under the data root; size limits (builds 2 GB, artifacts 200 MB) | `store.ts` |
| Artifact ownership | A worker may attach artifacts only to tasks running on its own devices (403 otherwise) | `app.ts` |
| Device exclusivity | One lease per device enforced by a primary key; mutating manual actions get 409 while a task holds it | `leases.ts` |
| Live Wall | Frames held in memory only (latest per device, dropped when no one watches), 15 MB cap per frame, dashboard token to read, worker token to write; a worker can only publish frames for its own devices | `live.ts`, `app.ts` |
| Platform honesty | The server rejects an iOS capability from a non-macOS worker | `app.ts` |
| Logging | Fastify redacts `authorization` and `enrollmentSecret`; `.env` is git-ignored and created with mode 600 | `app.ts` |
| Audit | Device actions, uploads, distributions, run create/cancel, enrollments → `audit_log` | `db.ts` |
| Network default | Server binds 127.0.0.1; warns when bound wider without TLS | `index.ts` |

## Known gaps (to close before multi-user or LAN use)

1. **No TLS in-process.** Before a Windows worker connects over the network,
   put the server behind a TLS reverse proxy (Caddy/nginx). Tokens are bearer
   credentials.
2. **One shared dashboard token**, no per-user identity. `audit_log.actor` is
   `dashboard` for everyone. Per-user auth (OIDC) is planned with Phase 3.
3. **The dashboard token lives in `localStorage`.** Acceptable for a local tool
   that loads no third-party scripts. Move to an httpOnly cookie when per-user
   auth lands.
4. **Workers trust the server.** A compromised server can install any build
   and run any Maestro flow on worker devices. Run workers as an unprivileged
   user, and keep production credentials off worker machines.
5. **Maestro flows are code.** `runScript`/`evalScript` steps run JavaScript
   inside Maestro. Only trusted users should be able to save suites.
6. **Live Wall shows whatever is on screen**, including test credentials typed
   into the app. Anyone with the dashboard token can see it.
7. **No revocation list.** Disabling a worker today means rotating the
   enrollment secret and waiting ≤15 min for tokens to expire.

## Rules for the AI phases (3–6)

* Agents get a device lease and Mobile MCP. They do **not** get worker shell
  access, the enrollment secret, `.env`, or production credentials.
* The repair agent works only in a throwaway git worktree, can run only the
  allow-listed build/test commands, and **never pushes or merges**.
* Every agent action and repair attempt is written to the audit log. Original
  screenshots and logs are immutable artifacts.
