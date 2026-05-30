// Chat management via sock.chatModify (archive/mute/pin/star/mark-read/delete/
// clear) plus per-chat disappearing messages. Mutations here change chat *state*
// on your account, not message content — they are gated by notReady() and, for
// the disappearing toggle (which sends a protocol message), by the send
// kill-switch. WhatsApp can log you out if a chatModify payload is malformed, so
// we keep payloads minimal and surface errors verbatim.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WAMessage } from "@innovatorssoft/baileys";
import { z } from "zod";
import { getSock, notReady } from "../whatsapp/connection";
import { sendBlocked } from "../whatsapp/sendguard";
import { getLastMessage } from "../store/db";
import { isGroupJid, phoneToJid } from "../whatsapp/jid";
import { errorResult, noteResult } from "./util";

function chatJidOf(input: string): string {
  return isGroupJid(input) || input.includes("@") ? input : phoneToJid(input);
}

// Build the `lastMessages` entry chatModify needs (archive/markRead/delete).
function lastMessageStub(chatJid: string): { key: any; messageTimestamp: number } | null {
  const last = getLastMessage(chatJid) as WAMessage | null;
  if (!last?.key) return null;
  return { key: last.key, messageTimestamp: Number(last.messageTimestamp ?? 0) };
}

export function registerChatMgmtTools(server: McpServer): void {
  // ---- archive / unarchive ----
  server.registerTool(
    "wa_archive_chat",
    {
      title: "Archive / unarchive a chat",
      description: "Archive or unarchive a chat. Needs at least one stored message in the chat.",
      inputSchema: { target: z.string().describe("Phone or JID."), archive: z.boolean() },
    },
    async ({ target, archive }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = chatJidOf(target);
      const last = lastMessageStub(jid);
      if (!last) return errorResult("no stored messages for this chat — cannot archive");
      try {
        await getSock().chatModify({ archive, lastMessages: [last as any] }, jid);
        return noteResult(archive ? "Chat archived." : "Chat unarchived.");
      } catch (e: any) {
        return errorResult(`archive failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- mute / unmute ----
  server.registerTool(
    "wa_mute_chat",
    {
      title: "Mute / unmute a chat",
      description: "Mute a chat for a duration in ms (8h = 28800000, 7d = 604800000), or pass 0/omit to unmute.",
      inputSchema: { target: z.string(), durationMs: z.number().int().min(0).optional().describe("0 or omit = unmute.") },
    },
    async ({ target, durationMs }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = chatJidOf(target);
      const mute = durationMs && durationMs > 0 ? durationMs : null;
      try {
        await getSock().chatModify({ mute }, jid);
        return noteResult(mute ? `Muted for ${mute}ms.` : "Unmuted.");
      } catch (e: any) {
        return errorResult(`mute failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- pin / unpin chat ----
  server.registerTool(
    "wa_pin_chat",
    {
      title: "Pin / unpin a chat",
      description: "Pin or unpin a chat to the top of the list.",
      inputSchema: { target: z.string(), pin: z.boolean() },
    },
    async ({ target, pin }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = chatJidOf(target);
      try {
        await getSock().chatModify({ pin } as any, jid);
        return noteResult(pin ? "Chat pinned." : "Chat unpinned.");
      } catch (e: any) {
        return errorResult(`pin failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- star / unstar a message ----
  server.registerTool(
    "wa_star_message",
    {
      title: "Star / unstar a message",
      description: "Star or unstar a specific message in a chat.",
      inputSchema: {
        target: z.string(),
        msgId: z.string().describe("The message id."),
        fromMe: z.boolean().describe("Whether you sent the message."),
        star: z.boolean(),
      },
    },
    async ({ target, msgId, fromMe, star }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = chatJidOf(target);
      try {
        await getSock().chatModify({ star: { messages: [{ id: msgId, fromMe }], star } } as any, jid);
        return noteResult(star ? "Message starred." : "Message unstarred.");
      } catch (e: any) {
        return errorResult(`star failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- mark read / unread ----
  server.registerTool(
    "wa_mark_chat_read",
    {
      title: "Mark chat read / unread",
      description: "Mark a whole chat read or unread. Needs at least one stored message in the chat.",
      inputSchema: { target: z.string(), read: z.boolean().describe("true = read, false = unread.") },
    },
    async ({ target, read }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = chatJidOf(target);
      const last = lastMessageStub(jid);
      if (!last) return errorResult("no stored messages for this chat — cannot mark");
      try {
        await getSock().chatModify({ markRead: read, lastMessages: [last as any] }, jid);
        return noteResult(read ? "Marked read." : "Marked unread.");
      } catch (e: any) {
        return errorResult(`mark read failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- delete chat ----
  server.registerTool(
    "wa_delete_chat",
    {
      title: "Delete a chat (for me)",
      description: "Delete an entire chat from your device. Needs at least one stored message in the chat.",
      inputSchema: { target: z.string(), confirm: z.boolean().describe("Must be true to proceed.") },
    },
    async ({ target, confirm }) => {
      if (!confirm) return errorResult("set confirm:true to delete the chat");
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = chatJidOf(target);
      const last = lastMessageStub(jid);
      if (!last) return errorResult("no stored messages for this chat — cannot delete");
      try {
        await getSock().chatModify(
          { delete: true, lastMessages: [{ key: last.key, messageTimestamp: last.messageTimestamp }] } as any,
          jid,
        );
        return noteResult("Chat deleted (for me).");
      } catch (e: any) {
        return errorResult(`delete chat failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- delete a single message for me ----
  server.registerTool(
    "wa_delete_message_for_me",
    {
      title: "Delete a message (for me only)",
      description: "Remove one message from your own device (does not delete for others — use wa_delete_message for that).",
      inputSchema: {
        target: z.string(),
        msgId: z.string(),
        fromMe: z.boolean(),
        timestamp: z.number().int().describe("The message's unix-seconds timestamp."),
      },
    },
    async ({ target, msgId, fromMe, timestamp }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = chatJidOf(target);
      try {
        await getSock().chatModify(
          { clear: { messages: [{ id: msgId, fromMe, timestamp: String(timestamp) }] } } as any,
          jid,
        );
        return noteResult("Message removed from this device.");
      } catch (e: any) {
        return errorResult(`delete-for-me failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- per-chat disappearing messages ----
  server.registerTool(
    "wa_disappearing_chat",
    {
      title: "Toggle disappearing messages (per chat)",
      description: "Turn disappearing messages on (seconds: 86400=24h, 604800=7d, 7776000=90d) or off (0) for a chat.",
      inputSchema: { target: z.string(), seconds: z.number().int().min(0) },
    },
    async ({ target, seconds }) => {
      const restricted = sendBlocked();
      if (restricted) return errorResult(restricted);
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = chatJidOf(target);
      try {
        await getSock().sendMessage(jid, { disappearingMessagesInChat: seconds || false } as any);
        return noteResult(seconds ? `Disappearing on (${seconds}s).` : "Disappearing off.");
      } catch (e: any) {
        return errorResult(`disappearing toggle failed: ${e?.message ?? e}`);
      }
    },
  );
}
