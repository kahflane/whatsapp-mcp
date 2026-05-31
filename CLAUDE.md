# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A WhatsApp MCP (Model Context Protocol) server. One process — Node or Bun — is simultaneously the MCP stdio server *and* a live WhatsApp client (via the `@innovatorssoft/baileys` fork). It exposes ~87 tools (`wa_*`) for reading, searching, sending, scheduling, templating, auto-replying, and posting status. State persists to SQLite via a cross-runtime adapter (`src/store/sqlite.ts`): node-sqlite3-wasm (pure WASM, no native build) on Node, bun:sqlite on Bun.

> Account-ban risk: Baileys is unofficial automation that violates WhatsApp ToS. Use a burner number. `WA_DAILY_CAP` + jittered send pacing are mitigations, not guarantees.

## Commands

```bash
bun install            # deps
bun run start          # run the MCP server (stdio)
bun run dev            # run with --watch (auto-restart on file change)
bun run typecheck      # tsc --noEmit — type gate (must exit 0)
bun run build          # tsup -> dist/index.js — the single bundle the npm package ships
```

There is **no test runner and no lint config**. The verification gates are `bun run typecheck` and `bun run build` (both must exit 0). Pair it with a runtime smoke test: spawn `src/index.ts`, speak JSON-RPC over stdin (`initialize` → `notifications/initialized` → `tools/list` / `tools/call`), and assert stdout is pure JSON-RPC. Use an absolute `bun` path (e.g. `~/.bun/bin/bun`) in spawned scripts; `bun` may not be on PATH in spawned envs.

Logic that only needs the DB or pure functions can be tested by importing modules directly under `bun -e '...'` with `WA_DB_PATH`/`WA_MEDIA_DIR` pointed at `/tmp`. Note: zsh globs like `rm /tmp/x*` fail with "no matches" when absent — list exact filenames.

## Running as an MCP server

`.mcp.json` (project-scoped; committed variant is `.mcp.json.example`) registers the server with **absolute paths** to both `bun` and `src/index.ts`, and sets all `WA_*` env vars to absolute project paths. After editing source, the user must **restart Claude Code** to respawn the server — there is no hot reload through the MCP client.

Critical operational gotcha: **only one server process may run at a time.** Multiple processes share one auth dir + one SQLite file and cause split-brain — `wa_status` reports `connecting` while a *different* process is the one actually logged in and writing to the DB. If status looks wrong, `pkill -f "src/index.ts"` and restart Claude Code so exactly one spawns.

## Architecture

Startup order in `src/index.ts` is load-bearing: `initDb()` → `startSocket()` (wires events, does **not** block on login) → `initScheduler()` → `initAutoReply()` → `server.connect(StdioServerTransport)`. The transport connects *before* WhatsApp is authenticated so Claude can drive login interactively (`wa_status` → `wa_get_login_qr`/`wa_get_pairing_code`).

**Three layers:**
- `src/whatsapp/*` — the Baileys integration (socket lifecycle, event ingestion, name/LID resolution, sending, media, history, scheduler, auto-reply).
- `src/store/db.ts` — the single source of truth (opened via the `src/store/sqlite.ts` cross-runtime adapter — node-sqlite3-wasm on Node, bun:sqlite on Bun): tables `contacts`, `chats`, `messages`, `scheduled`, `poll_votes`, and `settings` (a generic key/value table; this is where the send kill-switch persists). Baileys ships no persistent store and `syncFullHistory` can deliver months of history, so it goes to disk, not RAM. (WAL mode on Bun; the WASM driver doesn't support WAL so `PRAGMA journal_mode = WAL` silently degrades to the rollback journal there — still durable, commits land on disk synchronously.)
- `src/tools/*` + `src/server.ts` — one `registerTool` group per file; `buildServer()` wires them. `src/tools/util.ts` shapes results (`textResult`/`noteResult`/`errorResult`).

**Connection state** lives in a module-level singleton `src/whatsapp/connection.ts` (`conn`): the shared `sock`, the state machine (`connecting`/`open`/`close`/`logged_out`), QR/pairing buffers, and reconnect/logout guard flags. Tools read `getSock()` / `notReady()` from here — they never create their own socket. `connection.update` handling: `loggedOut`(401)/`connectionReplaced`(440) → stop; `restartRequired`(515) → recreate now; transient → backoff reconnect (guarded by `conn.reconnecting`). `wa_logout` sets `conn.intentionalLogout` so the close handler won't reconnect.

**Event ingestion** (`src/whatsapp/socket.ts`): `messaging-history.set` (bulk backfill) and `messages.upsert` (live) both flow through `normalizeMessage` → `upsertMessage`. `messages.update` and `protocolMessage` REVOKE/EDIT update the original row in place via `updateMessageContent` (deletes/edits don't create new rows). On reconnect, `createSocket` tears down the old socket's listeners first (`removeAllListeners()` + `end()`) to prevent duplicate-ingest leaks.

### Two non-obvious mechanisms

**Message serialization (`src/whatsapp/serialize.ts`)** — the `messages.raw` column does **NOT** store JSON. `JSON.stringify` corrupts a WAMessage's binary fields (`mediaKey` Uint8Array → plain object, `Long` timestamps → `{low,high}`), silently breaking media download and the `getMessage` callback. Instead we protobuf-encode (`proto.WebMessageInfo.encode`) to base64 with a `P:`/`J:` tag prefix (`J:` is a circular-safe JSON fallback; untagged legacy rows assumed JSON). Always round-trip `raw` through `encodeMessage`/`decodeMessage`.

**LID → phone resolution (`src/whatsapp/lid.ts`)** — WhatsApp identities now arrive as `@lid` (Linked ID), not phone JIDs. The fork's `plotJid` is a pure string fn and **cannot** map them. The real mapping is in the signal key store: `keys.get("lid-mapping", ["<lidUser>_reverse"])` → phone digits (persisted as `auth_info_baileys/lid-mapping-*.json`). `setKeyStore(state.keys)` is called in `createSocket` with the **raw** key store (not the cacheable wrapper) so `lidUserToPn`/`toPnJid` can read it. `resolveName` (`src/whatsapp/names.ts`) is the precedence chain everything funnels through: group subject → live `pushName` → cached pushName → contact notify/verifiedName/name → LID→phone→contact → `+digits`. Never render a `@lid`'s user as a phone number — it is not one.

### Sending

All outbound goes through `safeSend` (`src/whatsapp/send.ts`): connection guard → target validation (`onWhatsApp` for non-group; rejects sub-5-digit junk) → single-flight queue with Gaussian-jittered gaps (`WA_MIN/MAX_GAP_MS`) + daily cap (`WA_DAILY_CAP`) → `sock.sendMessage`. The scheduler (`src/whatsapp/scheduler.ts`) mirrors the in-memory `createMessageScheduler` into the `scheduled` table and restores pending entries on startup; its sends also route through `safeSend`.

**Send kill-switch (`src/whatsapp/sendguard.ts`).** A master restriction persisted in the `settings` table (so it survives restarts — a fresh process comes up still locked). Every outbound site — text, media, templates, buttons, scheduled, reactions, edits, deletes, status posts, auto-reply — must call `sendBlocked()` and bail on a non-null result, exactly the way it calls `notReady()`. When you add a new send path, wire **both** guards or the kill-switch leaks.

**Group-metadata cache (`src/whatsapp/groupcache.ts`).** One shared in-memory TTL cache (`getGroupMetadataCached`) feeds both the Baileys send path (`cachedGroupMetadata` socket hook) and the read paths (`wa_get_group_members`, `wa_group_metadata`, and `resolveName`, which runs on every ingested group message). Always go through it — never call `sock.groupMetadata()` directly. It is deliberately RAM-only, not SQLite: a perishable perf cache, not state of record.

## Hard constraints

- **stdout is the JSON-RPC pipe.** A single `console.log` to stdout (or a noisy dep) corrupts the stream. All logging goes to **stderr** via `src/logger.ts` (`pino.destination(2)`). Never write to stdout.
- **Tools never throw for recoverable problems** — return `errorResult(...)` (`isError: true`). Throwing crashes the tool handler.
- `auth_info_baileys/` (full account access) and `data/` are gitignored — never commit them.
- The fork ships rich utilities used here: `parseJid`, `normalizePhoneToJid`, `getSenderPn`, `getDevice`, `makeCacheableSignalKeyStore`, `getContentType`, `normalizeMessageContent`, plus `proto`. Prefer these over hand-rolling, but guard optional ones (`(Baileys as any).x`) since the fork's exports drift across versions.

## Config

All runtime config is env-driven via `src/config.ts` (see `.env.example`): `WA_PAIRING_NUMBER` (empty = QR login), `WA_SYNC_FULL_HISTORY` (default true), `WA_MIN/MAX_GAP_MS`, `WA_DAILY_CAP`, `WA_AUTH_DIR`, `WA_DATA_DIR`, `WA_DB_PATH`, `WA_MEDIA_DIR`, `WA_LOG_LEVEL`.
