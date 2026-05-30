# whatsapp-mcp

A WhatsApp MCP server built on the [innovatorssoft Baileys fork](https://github.com/innovatorssoft/Baileys) and the [Anthropic Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk). Runs on **Bun**, stores everything in **bun:sqlite**.

> ⚠️ **Account-ban risk.** Baileys is unofficial WhatsApp automation and violates WhatsApp's ToS. Use a **dedicated/burner number you can afford to lose** — never your primary line. New numbers should warm up slowly (~20 msgs/day for the first week).

## How it works

One Bun process is *both* the MCP server and the WhatsApp client: a single long-lived Baileys WebSocket lives inside the MCP process and is shared by every tool handler.

```
Claude  ──stdio (JSON-RPC)──►  bun run src/index.ts
                                   ├─ McpServer + StdioServerTransport   (tools)
                                   ├─ Baileys WASocket                   (sock.ev.on…)
                                   └─ bun:sqlite                         (contacts / chats / messages)
```

- **Auth** lives in `./auth_info_baileys/` via `useMultiFileAuthState` (gitignored — it's full account access).
- **Data** lives in `./data/whatsapp.db` (gitignored). We use SQLite rather than Baileys' in-memory store because `syncFullHistory` can pull months of messages.
- **Logging goes to stderr only** — stdout is the JSON-RPC pipe.

## Install

Published to **GitHub Packages** as `@kahflane/whatsapp-mcp`.

### Option A — install the package (recommended)

GitHub Packages requires authentication even for public packages. Create a GitHub **Personal Access Token (classic)** with the `read:packages` scope, then point the `@kahflane` scope at GitHub's registry:

```bash
# ~/.npmrc  (or a project-local .npmrc)
@kahflane:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Then install with Bun (or npm):

```bash
bun add @kahflane/whatsapp-mcp        # or: npm i @kahflane/whatsapp-mcp
```

This is a runnable MCP server, not a library — it exposes a `whatsapp-mcp` bin that runs under Bun. Point your MCP client at the installed entry (see **Register with Claude Code**).

### Option B — clone the repo

```bash
git clone https://github.com/kahflane/whatsapp-mcp.git
cd whatsapp-mcp
bun install
```

## Setup

```bash
cp .env.example .env   # optional: pairing-code login, caps, paths
```

All config is environment-driven (see `.env.example`): `WA_PAIRING_NUMBER` (empty = QR login), `WA_SYNC_FULL_HISTORY`, `WA_MIN_GAP_MS`/`WA_MAX_GAP_MS`, `WA_DAILY_CAP`, `WA_AUTH_DIR`, `WA_DATA_DIR`, `WA_DB_PATH`, `WA_MEDIA_DIR`, `WA_LOG_LEVEL`.

## Run + log in

```bash
bun run start          # or: bun run dev  (watch mode)
```

The process starts but won't be logged in yet. From your MCP client:

1. `wa_status` — see the connection state.
2. **QR login** (default): `wa_get_login_qr` → scan with WhatsApp ▸ Linked Devices.
   **Pairing-code login**: set `WA_PAIRING_NUMBER` in `.env`, then `wa_get_pairing_code` → enter in WhatsApp ▸ Linked Devices ▸ Link with phone number.
3. `wa_status` again — should read `open`. History begins syncing into SQLite.

Auth persists, so you only do this once.

## Register with Claude Code

**Cloned repo:**

```bash
claude mcp add whatsapp -- bun run /ABSOLUTE/PATH/TO/whatsapp/src/index.ts
```

**Installed package** (resolve the entry inside `node_modules`):

```bash
claude mcp add whatsapp -- bun run ./node_modules/@kahflane/whatsapp-mcp/src/index.ts
```

…or copy `.mcp.json.example` to `.mcp.json` (project-scoped) / your `claude_desktop_config.json` and set the absolute path + `WA_*` env vars. Example:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "bun",
      "args": ["run", "/ABSOLUTE/PATH/TO/src/index.ts"],
      "env": { "WA_PAIRING_NUMBER": "", "WA_SYNC_FULL_HISTORY": "true", "WA_DAILY_CAP": "100" }
    }
  }
}
```

> After editing source or config, **restart your MCP client** to respawn the server — there's no hot reload, and only one server process may run at a time (shared auth dir + SQLite file).

## Tools

**87 tools** (`wa_*`), grouped below. Every outbound tool honors the send kill-switch (`wa_restrict_sending`) and the connection guard, and returns a structured error instead of throwing.

### Connection & login
| Tool | What it does |
|---|---|
| `wa_status` | connection + login + store stats + send counters |
| `wa_get_login_qr` / `wa_get_pairing_code` | first-time login |
| `wa_logout` | log out + wipe local auth |
| `wa_restrict_sending` | kill-switch: block/allow all outbound sends |

### Reading & search (works offline from the local store)
| Tool | What it does |
|---|---|
| `wa_list_chats` | list chats (newest first) |
| `wa_list_contacts` / `wa_resolve_name` | contacts + name resolution (PN↔LID) |
| `wa_get_messages` | read a chat's messages (full content) |
| `wa_search_messages` | full-text search the store |
| `wa_get_unread` / `wa_mark_read` | unread tracking + read receipts |
| `wa_fetch_history` | request OLDER history (50/call) |
| `wa_history_status` | sync progress |
| `wa_download_media` | download + decrypt media to a file |

### Sending
| Tool | What it does |
|---|---|
| `wa_check_number` | verify numbers on WhatsApp (anti-ban precheck) |
| `wa_send_text` | send text (mentions / reply / typing) |
| `wa_send_media` | send image/video/audio/document/sticker |
| `wa_send_location` / `wa_send_contact` | location pin · vCard contact card(s) |
| `wa_send_poll` / `wa_get_poll_votes` | send a poll · read decrypted vote tallies |
| `wa_send_event` | send an event card |
| `wa_send_buttons` / `wa_send_list` | interactive buttons + list messages |
| `wa_react` / `wa_edit_message` / `wa_delete_message` | modify messages |
| `wa_forward_message` / `wa_pin_message` | forward · pin a message in-chat |
| `wa_send_broadcast` / `wa_broadcast_info` | broadcast to a recipient list · query a list |
| `wa_send_product` / `wa_send_order` | commerce: product + order messages (Business) |

### Status / Story
| Tool | What it does |
|---|---|
| `wa_post_status` | post a status/story mentioning up to 5 JIDs |
| `wa_post_status_to` | post to a chosen audience (contacts **and** groups) — text (rich backgrounds + fonts), image, video, gif, voiceNote, audio |

### Chat management
| Tool | What it does |
|---|---|
| `wa_archive_chat` / `wa_pin_chat` / `wa_mute_chat` | archive · pin · mute (un-* too) |
| `wa_mark_chat_read` / `wa_star_message` | mark chat read/unread · star a message |
| `wa_delete_chat` / `wa_delete_message_for_me` | delete a chat · clear a message locally |
| `wa_disappearing_chat` | set per-chat disappearing-message timer |

### Groups
| Tool | What it does |
|---|---|
| `wa_create_group` / `wa_groups_list` / `wa_group_metadata` | create · list all · full metadata (cached) |
| `wa_get_group_members` | participants with resolved names + admin flags |
| `wa_group_participants` | add / remove / promote / demote |
| `wa_group_update_subject` / `wa_group_update_description` | rename · set description |
| `wa_group_setting` / `wa_group_add_mode` / `wa_group_ephemeral` | announce-lock · who-can-add · disappearing |
| `wa_group_invite_code` / `wa_group_join` / `wa_group_info_by_code` | get/revoke link · join · preview by code |
| `wa_group_join_requests` / `wa_group_join_decision` | list · approve/reject join requests |
| `wa_group_member_label` / `wa_group_leave` | label a member · leave (confirm required) |

### Profile, privacy & users
| Tool | What it does |
|---|---|
| `wa_set_name` / `wa_set_status` / `wa_set_picture` / `wa_remove_picture` | own profile (picture supports panoramic) |
| `wa_block` / `wa_blocklist` | block/unblock · list blocked |
| `wa_get_privacy` / `wa_set_privacy` / `wa_default_disappearing` | read/set privacy · default disappearing timer |
| `wa_get_status` / `wa_get_picture_url` / `wa_get_business_profile` | someone's about-text · avatar URL · business profile |
| `wa_subscribe_presence` / `wa_send_presence` | subscribe to · broadcast presence (typing/online…) |

### Calls
| Tool | What it does |
|---|---|
| `wa_reject_call` | reject an incoming call |

### Scheduling, templates & auto-reply
| Tool | What it does |
|---|---|
| `wa_schedule_message` / `wa_list_scheduled` / `wa_cancel_scheduled` | schedule sends (persisted in SQLite, restored on restart, fires exactly once) |
| `wa_list_templates` / `wa_render_template` / `wa_create_template` / `wa_send_template` | message templates (presets + custom) |
| `wa_autoreply_set` / `wa_autoreply_add_rule` / `wa_autoreply_list_rules` / `wa_autoreply_remove_rule` | keyword/pattern auto-replies (off by default) |

## Notes & limits

- **History** comes in chunks after login via `messaging-history.set`; `wa_fetch_history` pages older messages 50 at a time. WhatsApp occasionally won't relay on-demand history to linked devices, so a fetch can return nothing.
- **`@lid` senders** in groups can't always be mapped to a phone number client-side; names fall back to the lid/number. `wa_resolve_name` accepts a bare phone, a JID, or a `@lid`.
- **Pacing**: outbound sends pass through a single-flight queue with jittered gaps (`WA_MIN_GAP_MS`/`WA_MAX_GAP_MS`) and a `WA_DAILY_CAP`. This reduces — does not eliminate — ban risk.
- **Send kill-switch**: `wa_restrict_sending` blocks every outbound path at once (persisted in SQLite) — useful while testing reads against a live account.
- **Group metadata** is served from a shared 5-minute in-memory cache (`src/whatsapp/groupcache.ts`), refreshed on `groups.update` / `group-participants.update`, and wired into the socket's `cachedGroupMetadata` so group sends and reads avoid extra round-trips/rate-limits.
- **Scheduled messages** are persisted to SQLite and restored on startup; the scheduler claims each due row before sending (so a slow paced send can't double-fire) and never resends a row left mid-send by a crash.
- **Poll votes** are captured live from `messages.update` into a `poll_votes` table; `wa_get_poll_votes` aggregates them (only votes seen while connected — not backfilled).
- **Status to groups**: `wa_post_status_to` can target group JIDs directly (via the fork's `StatusHelper`), with named text backgrounds (`solid.purple`, `gradient.sunset`) and fonts (`DANCING`, `SERIF`, …).
- **Commerce / status read APIs**: this fork ships send-side product/order + `StatusHelper` but no catalog/collection/order *read* APIs, and no newsletters/channels, communities, or label management — those tools aren't exposed.
- **Auto-reply** is OFF by default and rules are in-memory (reset on restart). Enable with `wa_autoreply_set`.
- **Single process only**: one server shares the auth dir + SQLite file; running two causes split-brain. After editing source, restart the MCP client to respawn (no hot reload).
- **Version drift**: pin `@innovatorssoft/baileys`; a fork update can change the protocol/API. Optional fork exports are called defensively.
- Uses the fork's `makeCacheableSignalKeyStore` (faster key lookups), `getSenderPn` (own number), `StatusHelper` (rich statuses), and the `parseJid`/`plotJid`/`normalizePhoneToJid` utilities for PN↔LID handling. `markOnlineOnConnect: false` keeps notifications flowing to your phone; auth is restored via `useMultiFileAuthState` (scan the QR once).
