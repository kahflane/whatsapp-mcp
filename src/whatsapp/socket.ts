// Builds the WhatsApp socket, wires every event into our SQLite store + name
// resolver, and owns the connect / login / reconnect lifecycle.
import {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  jidNormalizedUser,
} from "@innovatorssoft/baileys";
import * as Baileys from "@innovatorssoft/baileys";
import type { AuthenticationState, WAMessage } from "@innovatorssoft/baileys";

// Baileys' default export is makeWASocket. Resolve it off the namespace instead
// of via a default import: when the bundle emits BOTH a namespace import and a
// default import of this CJS package, Node binds the default to the namespace
// object rather than the callable — so a plain default import is "not a function"
// under Node (it happens to work under Bun). Reading it from the namespace with
// an interop fallback is stable on both runtimes.
const baileysDefault = (Baileys as { default?: unknown }).default;
const makeWASocket = (typeof baileysDefault === "function"
  ? baileysDefault
  : (baileysDefault as { default?: unknown } | undefined)?.default) as typeof import("@innovatorssoft/baileys").default;
import { config } from "../config";
import { logger } from "../logger";
import {
  getMessageRawAnyChat,
  storePollVote,
  updateMessageContent,
  upsertChat,
  upsertContact,
  upsertMessage,
} from "../store/db";
import { conn } from "./connection";
import { getCachedGroupMetadata, refreshGroupMetadata } from "./groupcache";
import { handleIncoming } from "./autoreply";
import { setKeyStore, noteMapping } from "./lid";
import { extractText, normalizeMessage, toRow } from "./messages";
import { notePushName, resolveName } from "./names";

let saveCredsRef: (() => Promise<void>) | null = null;

export async function startSocket(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  saveCredsRef = saveCreds;
  createSocket(state);
}

function createSocket(state: AuthenticationState): void {
  // Tear down any previous socket FIRST so its event listeners stop firing
  // (otherwise old + new both ingest → duplicates/races) and the old ws closes.
  if (conn.sock) {
    try {
      // Baileys' typed emitter declares removeAllListeners(event); the underlying
      // Node emitter supports the no-arg "remove everything" form.
      (conn.sock.ev as any).removeAllListeners();
    } catch {
      /* ignore */
    }
    try {
      conn.sock.end(undefined);
    } catch {
      /* ignore */
    }
    conn.sock = null;
  }
  conn.reconnecting = false; // this (re)connect attempt is now running

  // give the LID resolver the RAW key store (not the cacheable wrapper) so it
  // can read the persisted "lid-mapping" entries for LID -> phone resolution.
  setKeyStore(state.keys);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      // cacheable key store = faster signal-key lookups under load
      keys: makeCacheableSignalKeyStore(state.keys, logger.child({ mod: "keys" }) as any),
    },
    // Desktop form-factor => WhatsApp ships full chat history.
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: config.syncFullHistory,
    // serve group metadata from our TTL cache to cut round-trips + rate limits
    cachedGroupMetadata: async (jid: string) => getCachedGroupMetadata(jid),
    // stdout is the JSON-RPC pipe — never let the QR touch it.
    printQRInTerminal: false,
    // let your phone keep getting notifications
    markOnlineOnConnect: false,
    // required so requestPairingCode doesn't time out on a headless host
    defaultQueryTimeoutMs: undefined,
    logger: logger.child({ mod: "baileys" }) as any,
    // hydrate quoted messages + improve retries / poll decryption from SQLite
    getMessage: async (key) => {
      const raw = getMessageRawAnyChat(key.id ?? "") as WAMessage | null;
      return raw?.message ?? undefined;
    },
  });

  conn.sock = sock;
  conn.state = "connecting";
  conn.qr = null;
  conn.pairingRequested = false;

  if (saveCredsRef) sock.ev.on("creds.update", saveCredsRef);

  sock.ev.on("connection.update", (update) => {
    void handleConnectionUpdate(update, state);
  });

  // ---- history backfill (bulk) ----
  // NOTE: the emitter key is "messaging-history.set" (the README's prose writes
  // it as "messaging.history-set").
  sock.ev.on("messaging-history.set", (arg: any) => {
    const { chats, contacts, messages } = arg ?? {};
    conn.historyChunks++;
    conn.lastHistoryAt = Date.now();
    for (const c of contacts ?? []) ingestContact(c);
    for (const ch of chats ?? []) ingestChat(ch);
    for (const m of messages ?? []) void ingestMessage(m);
    logger.info(
      { chunk: conn.historyChunks, chats: chats?.length, contacts: contacts?.length, messages: messages?.length },
      "history chunk",
    );
  });

  // ---- live messages ----
  sock.ev.on("messages.upsert", ({ messages }: any) => {
    for (const m of messages ?? []) {
      notePushName(m.key?.participant ?? m.key?.remoteJid, m.pushName);
      void ingestMessage(m);
      void handleIncoming(m); // auto-reply (no-op unless enabled)
    }
  });

  // edits + deletions (revokes) that arrive as updates — keep the store in sync
  sock.ev.on("messages.update", (updates: any[]) => {
    for (const u of updates ?? []) void ingestUpdate(u);
  });

  // ---- contacts ----
  sock.ev.on("contacts.upsert", (cs: any[]) => cs.forEach(ingestContact));
  sock.ev.on("contacts.update", (cs: any[]) => cs.forEach(ingestContact));

  // ---- chats ----
  sock.ev.on("chats.upsert", (cs: any[]) => cs.forEach(ingestChat));
  sock.ev.on("chats.update", (cs: any[]) => cs.forEach(ingestChat));

  // ---- groups ----
  sock.ev.on("groups.update", (gs: any[]) => {
    for (const g of gs) {
      if (g.id && g.subject) upsertChat({ jid: g.id, name: g.subject, is_group: 1 });
      if (g?.id) void refreshGroupMetadata(g.id); // keep cachedGroupMetadata fresh
    }
  });

  // participant add/remove/promote/demote -> refresh the cached metadata
  sock.ev.on("group-participants.update", (ev: any) => {
    if (ev?.id) void refreshGroupMetadata(ev.id);
  });

  // ---- LID <-> phone mapping (best-effort; event may not exist on all versions) ----
  try {
    (sock.ev as any).on("lid-mapping.update", (ms: any[]) => {
      for (const m of ms ?? []) if (m?.lid && m?.pn) noteMapping(m.lid, m.pn);
    });
  } catch {
    /* event not present in this version */
  }
}

async function handleConnectionUpdate(update: any, state: AuthenticationState): Promise<void> {
  const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

  if (qr) {
    conn.qr = qr;
    logger.info("QR code received — use wa_get_login_qr");
  }

  if (receivedPendingNotifications) conn.pendingDone = true;

  // headless pairing-code path
  if (
    connection === "connecting" &&
    config.pairingNumber &&
    !state.creds.registered &&
    !conn.pairingRequested
  ) {
    conn.pairingRequested = true;
    try {
      const code = await conn.sock!.requestPairingCode(config.pairingNumber);
      conn.pairingCode = code;
      logger.info({ code }, "pairing code generated — use wa_get_pairing_code");
    } catch (e: any) {
      logger.error({ e }, "requestPairingCode failed");
      conn.pairingRequested = false;
    }
  }

  if (connection === "open") {
    conn.state = "open";
    conn.reconnectAttempts = 0;
    conn.reconnecting = false;
    conn.qr = null;
    conn.pairingCode = null;
    const u = conn.sock?.user;
    let phone: string | undefined;
    try {
      const getSenderPn = (Baileys as any).getSenderPn as ((creds: any) => any) | undefined;
      const pn = getSenderPn?.(conn.sock?.authState?.creds);
      phone = typeof pn === "string" ? pn : pn?.pn ?? pn?.user ?? undefined;
    } catch {
      /* helper not present / shape differs */
    }
    if (u?.id) conn.me = { jid: jidNormalizedUser(u.id), name: u.name ?? undefined, phone };
    logger.info({ me: conn.me }, "connection open");
    return;
  }

  if (connection === "close") {
    const code = (lastDisconnect?.error as any)?.output?.statusCode;
    conn.lastError = (lastDisconnect?.error as any)?.message ?? String(code ?? "");

    if (conn.intentionalLogout) {
      conn.state = "logged_out";
      logger.info("intentional logout — not reconnecting");
      return;
    }

    if (code === DisconnectReason.loggedOut) {
      conn.state = "logged_out";
      logger.warn("logged out — need re-auth (QR / pairing)");
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      conn.state = "logged_out";
      logger.warn("connection replaced by another session — stopping");
      return;
    }
    if (code === DisconnectReason.restartRequired) {
      logger.info("restart required (normal post-pair handshake) — recreating socket");
      createSocket(state);
      return;
    }

    // transient: backoff + reconnect, guarded so a burst of close events can't
    // stack multiple pending reconnects.
    conn.state = "close";
    if (conn.reconnecting) {
      logger.warn("reconnect already pending — skipping");
      return;
    }
    conn.reconnecting = true;
    conn.reconnectAttempts++;
    const delay = Math.min(30_000, 1000 * 2 ** conn.reconnectAttempts) + Math.floor(Math.random() * 1000);
    logger.warn({ code, delay, attempt: conn.reconnectAttempts }, "disconnected — reconnecting");
    setTimeout(() => createSocket(state), delay);
  }
}

// ---- ingest helpers ----

function ingestContact(c: any): void {
  if (!c?.id) return;
  upsertContact({
    jid: c.id,
    name: c.name ?? null,
    notify: c.notify ?? null,
    verified_name: c.verifiedName ?? null,
    phone: c.id.endsWith("@s.whatsapp.net") ? c.id.split("@")[0] : null,
  });
}

function ingestChat(c: any): void {
  if (!c?.id) return;
  upsertChat({
    jid: c.id,
    name: c.name ?? c.subject ?? null,
    is_group: c.id.endsWith("@g.us") ? 1 : 0,
    last_ts: c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined,
    unread: typeof c.unreadCount === "number" ? c.unreadCount : undefined,
  });
}

async function ingestMessage(m: WAMessage): Promise<void> {
  try {
    if (!m?.message || !m.key?.remoteJid) return;

    // edits/deletions carried as a protocolMessage update the ORIGINAL row
    // (referenced by protocolMessage.key.id) instead of storing an envelope.
    const pm: any = (m.message as any).protocolMessage;
    if (pm?.key?.id) {
      if (pm.type === 0 /* REVOKE */) {
        updateMessageContent(m.key.remoteJid, pm.key.id, "[message deleted]", "deleted");
        return;
      }
      if (pm.type === 14 /* MESSAGE_EDIT */ && pm.editedMessage) {
        const { type, text } = extractText(pm.editedMessage);
        updateMessageContent(m.key.remoteJid, pm.key.id, text, type);
        return;
      }
    }

    const n = await normalizeMessage(m);
    if (!n.id) return;
    upsertMessage(toRow(n, m));
    // keep the chat row fresh
    upsertChat({
      jid: n.chatJid,
      is_group: n.chatJid.endsWith("@g.us") ? 1 : 0,
      last_ts: n.timestamp,
      name: n.chatJid.endsWith("@g.us") ? undefined : await maybeContactName(n.chatJid),
    });
  } catch (e) {
    logger.warn({ e }, "ingestMessage failed");
  }
}

async function maybeContactName(jid: string): Promise<string | undefined> {
  const name = await resolveName(jid);
  return name.startsWith("+") ? undefined : name;
}

// Handle messages.update: edits carry new content; revokes typically null the
// message. Keep the stored row in sync either way.
async function ingestUpdate(u: any): Promise<void> {
  try {
    const key = u?.key;
    if (!key?.id || !key?.remoteJid) return;
    const upd = u.update ?? {};

    // Poll votes: Baileys decrypts these into update.pollUpdates (it uses our
    // getMessage to fetch the original poll). Persist each voter's selection so
    // wa_get_poll_votes can aggregate them later. The update's own key points at
    // the poll-creation message being voted on.
    if (Array.isArray(upd.pollUpdates) && upd.pollUpdates.length) {
      for (const pu of upd.pollUpdates) {
        const vk = pu?.pollUpdateMessageKey ?? {};
        const voter: string | undefined = vk.participant ?? vk.remoteJid ?? undefined;
        if (!voter) continue;
        const options: string[] = (pu?.vote?.selectedOptions ?? []).map((o: any) =>
          Buffer.from(o).toString("base64"),
        );
        storePollVote({
          poll_id: key.id,
          chat_jid: key.remoteJid,
          voter_jid: voter,
          from_me: vk.fromMe ? 1 : 0,
          options: JSON.stringify(options),
          ts: pu?.senderTimestampMs != null ? Number(pu.senderTimestampMs) : Date.now(),
        });
      }
      return;
    }

    if (upd.message === null) {
      updateMessageContent(key.remoteJid, key.id, "[message deleted]", "deleted");
      return;
    }
    if (upd.message) {
      const { type, text } = extractText(upd.message);
      updateMessageContent(key.remoteJid, key.id, text, type);
    }
  } catch (e) {
    logger.warn({ e }, "ingestUpdate failed");
  }
}
