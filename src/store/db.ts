// Durable store backed by a synchronous SQLite driver — bun:sqlite on Bun,
// better-sqlite3 on Node — behind the openDatabase() adapter (see ./sqlite).
//
// We deliberately do NOT use Baileys' makeInMemoryStore: with syncFullHistory
// turned on we can receive months of history, and the README itself warns that
// "storing someone's entire chat history in memory is a terrible waste of RAM".
// SQLite is our single source of truth for contacts, chats, and messages, and
// it also backs the socket's getMessage() callback (quote hydration + retries).
import { openDatabase, sqliteDriver, type SqliteDb } from "./sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";
import { logger } from "../logger";
import { decodeMessage } from "../whatsapp/serialize";

// Escape LIKE wildcards so user input is matched literally (paired with ESCAPE '\').
function likeEscape(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

export interface ContactRow {
  jid: string;
  name: string | null;
  notify: string | null;
  verified_name: string | null;
  phone: string | null;
}

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  last_ts: number | null;
  unread: number;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: number;
  type: string | null;
  text: string | null;
  ts: number | null;
  quoted_id: string | null;
  device: string | null;
  read: number;
  raw: string; // JSON of the full WAMessage (for getMessage + media download)
}

let db: SqliteDb;

export function initDb(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  mkdirSync(config.mediaDir, { recursive: true });

  db = openDatabase(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      jid           TEXT PRIMARY KEY,
      name          TEXT,
      notify        TEXT,
      verified_name TEXT,
      phone         TEXT
    );

    CREATE TABLE IF NOT EXISTS chats (
      jid      TEXT PRIMARY KEY,
      name     TEXT,
      is_group INTEGER NOT NULL DEFAULT 0,
      last_ts  INTEGER,
      unread   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT NOT NULL,
      chat_jid    TEXT NOT NULL,
      sender_jid  TEXT,
      sender_name TEXT,
      from_me     INTEGER NOT NULL DEFAULT 0,
      type        TEXT,
      text        TEXT,
      ts          INTEGER,
      quoted_id   TEXT,
      device      TEXT,
      read        INTEGER NOT NULL DEFAULT 0,
      raw         TEXT NOT NULL,
      PRIMARY KEY (chat_jid, id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, ts);
    CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages (ts);
    CREATE INDEX IF NOT EXISTS idx_messages_text    ON messages (text);

    CREATE TABLE IF NOT EXISTS scheduled (
      id             TEXT PRIMARY KEY,
      jid            TEXT NOT NULL,
      content        TEXT NOT NULL,   -- JSON AnyMessageContent
      scheduled_time INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      error          TEXT,
      message_id     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled (status, scheduled_time);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Decrypted poll votes captured live from messages.update (update.pollUpdates).
    -- One row per (poll, voter): a re-vote overwrites the prior selection.
    -- options = JSON array of base64 SHA256 option hashes (binary-safe).
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id   TEXT NOT NULL,
      chat_jid  TEXT NOT NULL,
      voter_jid TEXT NOT NULL,
      from_me   INTEGER NOT NULL DEFAULT 0,
      options   TEXT NOT NULL,
      ts        INTEGER,
      PRIMARY KEY (poll_id, voter_jid)
    );
  `);

  logger.info({ path: config.dbPath, driver: sqliteDriver }, "sqlite store ready");
}

// Checkpoint the WAL and close the handle cleanly on shutdown.
export function closeDb(): void {
  try {
    db?.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db?.close();
  } catch {
    /* ignore */
  }
}

// ---------- settings (key/value) ----------

export function getSetting(key: string): string | null {
  const row = db.query(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.query(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// ---------- contacts ----------

export function upsertContact(c: Partial<ContactRow> & { jid: string }): void {
  db.query(
    `INSERT INTO contacts (jid, name, notify, verified_name, phone)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name          = COALESCE(excluded.name, contacts.name),
       notify        = COALESCE(excluded.notify, contacts.notify),
       verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
       phone         = COALESCE(excluded.phone, contacts.phone)`,
  ).run(
    c.jid,
    c.name ?? null,
    c.notify ?? null,
    c.verified_name ?? null,
    c.phone ?? null,
  );
}

export function getContact(jid: string): ContactRow | null {
  return db.query(`SELECT * FROM contacts WHERE jid = ?`).get(jid) as ContactRow | null;
}

export function listContacts(query: string | undefined, limit: number): ContactRow[] {
  if (query) {
    const like = likeEscape(query);
    return db
      .query(
        `SELECT * FROM contacts
         WHERE jid LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR notify LIKE ? ESCAPE '\\' OR verified_name LIKE ? ESCAPE '\\'
         ORDER BY COALESCE(notify, name, jid) LIMIT ?`,
      )
      .all(like, like, like, like, limit) as ContactRow[];
  }
  return db
    .query(`SELECT * FROM contacts ORDER BY COALESCE(notify, name, jid) LIMIT ?`)
    .all(limit) as ContactRow[];
}

// ---------- chats ----------

export function upsertChat(c: Partial<ChatRow> & { jid: string }): void {
  db.query(
    `INSERT INTO chats (jid, name, is_group, last_ts, unread)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name     = COALESCE(excluded.name, chats.name),
       is_group = excluded.is_group,
       last_ts  = MAX(COALESCE(excluded.last_ts, 0), COALESCE(chats.last_ts, 0)),
       unread   = COALESCE(excluded.unread, chats.unread)`,
  ).run(
    c.jid,
    c.name ?? null,
    c.is_group ?? (c.jid.endsWith("@g.us") ? 1 : 0),
    c.last_ts ?? null,
    c.unread ?? 0,
  );
}

export function getChat(jid: string): ChatRow | null {
  return db.query(`SELECT * FROM chats WHERE jid = ?`).get(jid) as ChatRow | null;
}

export function listChats(
  query: string | undefined,
  type: "individual" | "group" | "all",
  limit: number,
): ChatRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (query) {
    where.push("(jid LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
    args.push(likeEscape(query), likeEscape(query));
  }
  if (type === "group") where.push("is_group = 1");
  if (type === "individual") where.push("is_group = 0");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  args.push(limit);
  return db
    .query(`SELECT * FROM chats ${clause} ORDER BY last_ts DESC NULLS LAST LIMIT ?`)
    .all(...args) as ChatRow[];
}

// ---------- messages ----------

export function upsertMessage(m: MessageRow): void {
  db.query(
    `INSERT INTO messages
       (id, chat_jid, sender_jid, sender_name, from_me, type, text, ts, quoted_id, device, read, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_jid, id) DO UPDATE SET
       sender_jid  = COALESCE(excluded.sender_jid, messages.sender_jid),
       sender_name = COALESCE(excluded.sender_name, messages.sender_name),
       type        = COALESCE(excluded.type, messages.type),
       text        = COALESCE(excluded.text, messages.text),
       ts          = COALESCE(excluded.ts, messages.ts),
       quoted_id   = COALESCE(excluded.quoted_id, messages.quoted_id),
       device      = COALESCE(excluded.device, messages.device),
       raw         = excluded.raw`,
  ).run(
    m.id,
    m.chat_jid,
    m.sender_jid,
    m.sender_name,
    m.from_me,
    m.type,
    m.text,
    m.ts,
    m.quoted_id,
    m.device,
    m.read,
    m.raw,
  );
}

export function getMessageRaw(chatJid: string, id: string): any | null {
  const row = db
    .query(`SELECT raw FROM messages WHERE chat_jid = ? AND id = ?`)
    .get(chatJid, id) as { raw: string } | null;
  if (!row) return null;
  try {
    return decodeMessage(row.raw);
  } catch {
    return null;
  }
}

// Look up a message by id across all chats (used by getMessage callback).
export function getMessageRawAnyChat(id: string): any | null {
  const row = db
    .query(`SELECT raw FROM messages WHERE id = ? ORDER BY ts DESC LIMIT 1`)
    .get(id) as { raw: string } | null;
  if (!row) return null;
  try {
    return decodeMessage(row.raw);
  } catch {
    return null;
  }
}

export function getMessages(chatJid: string, limit: number, beforeTs?: number): MessageRow[] {
  if (beforeTs != null) {
    return db
      .query(
        `SELECT * FROM messages WHERE chat_jid = ? AND ts < ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(chatJid, beforeTs, limit) as MessageRow[];
  }
  return db
    .query(`SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?`)
    .all(chatJid, limit) as MessageRow[];
}

export function searchMessages(
  query: string,
  chatJid: string | undefined,
  limit: number,
): MessageRow[] {
  const like = likeEscape(query);
  if (chatJid) {
    return db
      .query(
        `SELECT * FROM messages WHERE chat_jid = ? AND text LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?`,
      )
      .all(chatJid, like, limit) as MessageRow[];
  }
  return db
    .query(`SELECT * FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?`)
    .all(like, limit) as MessageRow[];
}

export function getUnread(chatJid: string | undefined, limit: number): MessageRow[] {
  if (chatJid) {
    return db
      .query(
        `SELECT * FROM messages WHERE chat_jid = ? AND read = 0 AND from_me = 0 ORDER BY ts DESC LIMIT ?`,
      )
      .all(chatJid, limit) as MessageRow[];
  }
  return db
    .query(`SELECT * FROM messages WHERE read = 0 AND from_me = 0 ORDER BY ts DESC LIMIT ?`)
    .all(limit) as MessageRow[];
}

export function markRead(chatJid: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const res = db
    .query(`UPDATE messages SET read = 1 WHERE chat_jid = ? AND id IN (${placeholders})`)
    .run(chatJid, ...ids);
  return res.changes;
}

// Overwrite a stored message's text/type in place (used for edits + revokes).
export function updateMessageContent(chatJid: string, id: string, text: string, type: string): void {
  db.query(`UPDATE messages SET text = ?, type = ? WHERE chat_jid = ? AND id = ?`).run(
    text,
    type,
    chatJid,
    id,
  );
}

export function oldestMessage(chatJid: string): MessageRow | null {
  return db
    .query(`SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts ASC LIMIT 1`)
    .get(chatJid) as MessageRow | null;
}

// Newest stored message in a chat, decoded to a WAMessage (the protobuf-safe
// `raw`). Used by chatModify (archive/markRead/delete) which need a real
// `lastMessages` entry with a valid key + timestamp.
export function getLastMessage(chatJid: string): any | null {
  const row = db
    .query(`SELECT raw FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 1`)
    .get(chatJid) as { raw: string } | null;
  if (!row) return null;
  try {
    return decodeMessage(row.raw);
  } catch {
    return null;
  }
}

// ---------- poll votes ----------

export interface PollVoteRow {
  poll_id: string;
  chat_jid: string;
  voter_jid: string;
  from_me: number;
  options: string; // JSON array of base64 SHA256 option hashes
  ts: number | null;
}

// Upsert a voter's selection for a poll (latest vote wins per voter).
export function storePollVote(r: PollVoteRow): void {
  db.query(
    `INSERT INTO poll_votes (poll_id, chat_jid, voter_jid, from_me, options, ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(poll_id, voter_jid) DO UPDATE SET
       from_me = excluded.from_me,
       options = excluded.options,
       ts      = excluded.ts`,
  ).run(r.poll_id, r.chat_jid, r.voter_jid, r.from_me, r.options, r.ts);
}

export function getPollVotes(pollId: string): PollVoteRow[] {
  return db
    .query(`SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY ts ASC`)
    .all(pollId) as PollVoteRow[];
}

// ---------- stats ----------

export function stats(): { contacts: number; chats: number; messages: number } {
  const c = db.query(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number };
  const ch = db.query(`SELECT COUNT(*) AS n FROM chats`).get() as { n: number };
  const m = db.query(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
  return { contacts: c.n, chats: ch.n, messages: m.n };
}

export function perChatHistory(chatJid: string): { count: number; oldestTs: number | null; newestTs: number | null } {
  const row = db
    .query(
      `SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM messages WHERE chat_jid = ?`,
    )
    .get(chatJid) as { n: number; oldest: number | null; newest: number | null };
  return { count: row.n, oldestTs: row.oldest, newestTs: row.newest };
}

// ---------- scheduled messages ----------

export interface ScheduledRow {
  id: string;
  jid: string;
  content: string; // JSON
  scheduled_time: number;
  created_at: number;
  status: string;
  error: string | null;
  message_id: string | null;
}

export function insertScheduled(
  r: Omit<ScheduledRow, "error" | "message_id"> & { error?: string | null; message_id?: string | null },
): void {
  db.query(
    `INSERT OR REPLACE INTO scheduled
       (id, jid, content, scheduled_time, created_at, status, error, message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.jid,
    r.content,
    r.scheduled_time,
    r.created_at,
    r.status,
    r.error ?? null,
    r.message_id ?? null,
  );
}

export function updateScheduledStatus(
  id: string,
  status: string,
  error?: string | null,
  messageId?: string | null,
): void {
  // error is set directly (so it clears on success/reschedule); message_id is
  // preserved unless a new one is supplied.
  db.query(
    `UPDATE scheduled SET status = ?, error = ?, message_id = COALESCE(?, message_id) WHERE id = ?`,
  ).run(status, error ?? null, messageId ?? null, id);
}

export function relinkScheduled(oldId: string, newId: string): void {
  db.query(`UPDATE scheduled SET id = ? WHERE id = ?`).run(newId, oldId);
}

// Atomically CLAIM all due 'pending' rows: mark each 'sending' and return them.
// This is the anti-duplicate guard — once claimed, a row is no longer 'pending',
// so a subsequent tick (or any other caller) won't pick it up again. Both SQLite
// drivers are synchronous + single-connection, and the scheduler never runs
// overlapping ticks, so the SELECT→UPDATE window cannot interleave with another claim.
export function claimDueScheduled(now: number): ScheduledRow[] {
  const rows = db
    .query(`SELECT * FROM scheduled WHERE status = 'pending' AND scheduled_time <= ? ORDER BY scheduled_time ASC`)
    .all(now) as ScheduledRow[];
  if (rows.length) {
    const mark = db.query(`UPDATE scheduled SET status = 'sending' WHERE id = ? AND status = 'pending'`);
    for (const r of rows) mark.run(r.id);
  }
  return rows;
}

// A row left in 'sending' means a previous process died mid-send. We can't know
// whether it actually went out, so we mark it failed rather than resend it —
// losing a scheduled message is safer than a duplicate send (ban risk).
export function failInterruptedSending(): number {
  const res = db
    .query(`UPDATE scheduled SET status = 'failed', error = 'interrupted (process restart)' WHERE status = 'sending'`)
    .run();
  return res.changes;
}

// Cancel one entry by id, but only if still pending. Returns true if it cancelled.
export function cancelScheduledById(id: string): boolean {
  const res = db
    .query(`UPDATE scheduled SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
    .run(id);
  return res.changes > 0;
}

// Only mark failed if still pending — prevents a late onFailed from clobbering a
// 'cancelled' or 'sent' status (race with cancel()).
export function failScheduledIfPending(id: string, error: string): void {
  db.query(`UPDATE scheduled SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'`).run(
    error,
    id,
  );
}

export function cancelScheduledForJid(jid: string): number {
  const res = db
    .query(`UPDATE scheduled SET status = 'cancelled' WHERE jid = ? AND status = 'pending'`)
    .run(jid);
  return res.changes;
}

export function listScheduled(status: string | undefined, limit = 200): ScheduledRow[] {
  if (status) {
    return db
      .query(`SELECT * FROM scheduled WHERE status = ? ORDER BY scheduled_time ASC LIMIT ?`)
      .all(status, limit) as ScheduledRow[];
  }
  return db
    .query(`SELECT * FROM scheduled ORDER BY scheduled_time ASC LIMIT ?`)
    .all(limit) as ScheduledRow[];
}

export function pendingScheduled(): ScheduledRow[] {
  return db
    .query(`SELECT * FROM scheduled WHERE status = 'pending' ORDER BY scheduled_time ASC`)
    .all() as ScheduledRow[];
}
