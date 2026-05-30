// Reading / searching / history tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MessageRow } from "../store/db";
import {
  getMessageRaw,
  getMessages,
  getUnread,
  markRead as dbMarkRead,
  perChatHistory,
  searchMessages,
} from "../store/db";
import { conn, getSock, notReady } from "../whatsapp/connection";
import { fetchOlderHistory } from "../whatsapp/history";
import { downloadMedia } from "../whatsapp/media";
import { errorResult, noteResult, textResult } from "./util";

function view(rows: MessageRow[]) {
  return rows.map((m) => ({
    id: m.id,
    chatJid: m.chat_jid,
    senderJid: m.sender_jid,
    senderName: m.sender_name,
    fromMe: !!m.from_me,
    type: m.type,
    text: m.text,
    timestamp: m.ts,
    quotedId: m.quoted_id,
    device: m.device,
    unread: m.read === 0,
  }));
}

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "wa_get_messages",
    {
      title: "Get messages",
      description: "Read recent messages from a chat (full extracted content), newest first.",
      inputSchema: {
        chatJid: z.string().describe("The chat JID (…@s.whatsapp.net or …@g.us)."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 20."),
        beforeTs: z.number().optional().describe("Only messages older than this epoch-ms (for paging)."),
      },
    },
    async ({ chatJid, limit, beforeTs }) => {
      const rows = getMessages(chatJid, limit ?? 20, beforeTs);
      return textResult(view(rows), `${rows.length} message(s) from ${chatJid}.`);
    },
  );

  server.registerTool(
    "wa_search_messages",
    {
      title: "Search messages",
      description: "Full-text search over stored message text, optionally scoped to one chat.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for."),
        chatJid: z.string().optional().describe("Limit to this chat."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
      },
    },
    async ({ query, chatJid, limit }) => {
      const rows = searchMessages(query, chatJid, limit ?? 30);
      return textResult(view(rows), `${rows.length} match(es) for "${query}".`);
    },
  );

  server.registerTool(
    "wa_get_unread",
    {
      title: "Get unread",
      description: "List unread incoming messages (own read-tracking), newest first.",
      inputSchema: {
        chatJid: z.string().optional().describe("Limit to this chat."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
      },
    },
    async ({ chatJid, limit }) => {
      const rows = getUnread(chatJid, limit ?? 50);
      return textResult(view(rows), `${rows.length} unread message(s).`);
    },
  );

  server.registerTool(
    "wa_mark_read",
    {
      title: "Mark read",
      description: "Mark specific messages as read (sends read receipts + updates local state).",
      inputSchema: {
        chatJid: z.string().describe("The chat JID."),
        msgIds: z.array(z.string()).min(1).describe("Message ids to mark read."),
      },
    },
    async ({ chatJid, msgIds }) => {
      const blocked = notReady();
      if (!blocked) {
        // group read receipts REQUIRE the original sender as `participant`; pull
        // it from the stored message key. 1:1 chats leave it undefined.
        const isGroup = chatJid.endsWith("@g.us");
        try {
          const keys = msgIds.map((id) => {
            let participant: string | undefined;
            if (isGroup) {
              const raw = getMessageRaw(chatJid, id) as any;
              participant = raw?.key?.participant ?? undefined;
            }
            return { remoteJid: chatJid, id, participant };
          });
          await getSock().readMessages(keys);
        } catch {
          /* best effort */
        }
      }
      const n = dbMarkRead(chatJid, msgIds);
      return noteResult(`Marked ${n} message(s) read.`);
    },
  );

  server.registerTool(
    "wa_download_media",
    {
      title: "Download media",
      description: "Download + decrypt a media message to a local file and return the path.",
      inputSchema: {
        chatJid: z.string().describe("The chat JID."),
        msgId: z.string().describe("The message id."),
      },
    },
    async ({ chatJid, msgId }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        const res = await downloadMedia(chatJid, msgId);
        return textResult(res, `Saved to ${res.path} (${res.bytes} bytes).`);
      } catch (e: any) {
        return errorResult(`download failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_fetch_history",
    {
      title: "Fetch older history",
      description:
        "Request OLDER messages for a chat beyond what's already synced (WhatsApp cap: 50/call). Results arrive asynchronously and land in the store — re-run wa_get_messages after a few seconds.",
      inputSchema: {
        chatJid: z.string().describe("The chat JID."),
        count: z.number().int().min(1).max(50).optional().describe("How many to request (max 50, default 50)."),
      },
    },
    async ({ chatJid, count }) => {
      const res = await fetchOlderHistory(chatJid, count ?? 50);
      if (!res.ok) return errorResult(res.error);
      const before = perChatHistory(chatJid);
      return noteResult(
        `Requested ${res.requested} older message(s) for ${chatJid}. ` +
          `Currently stored: ${before.count}. They arrive asynchronously — wait a few seconds then call wa_get_messages. ` +
          `(Note: WhatsApp sometimes does not relay on-demand history to linked devices, so this can return nothing.)`,
      );
    },
  );

  server.registerTool(
    "wa_history_status",
    {
      title: "History status",
      description: "Report how much history is stored overall, or for one chat.",
      inputSchema: { chatJid: z.string().optional().describe("Optional: stats for one chat.") },
    },
    async ({ chatJid }) => {
      if (chatJid) {
        const h = perChatHistory(chatJid);
        return textResult({ chatJid, ...h }, `${h.count} message(s) stored for ${chatJid}.`);
      }
      return textResult({
        historyChunksReceived: conn.historyChunks,
        lastHistoryAt: conn.lastHistoryAt,
        pendingNotificationsDone: conn.pendingDone,
      });
    },
  );
}
