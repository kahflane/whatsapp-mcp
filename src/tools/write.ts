// Sending / modifying tools. Everything routes through safeSend (guard +
// target validation + anti-ban pacing) except react/edit/delete which need the
// stored message key.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnyMessageContent, WAMessage } from "@innovatorssoft/baileys";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { getMessageRaw, getMessageRawAnyChat } from "../store/db";
import { getSock, notReady } from "../whatsapp/connection";
import { phoneToJid } from "../whatsapp/jid";
import { safeSend } from "../whatsapp/send";
import { sendBlocked } from "../whatsapp/sendguard";
import { errorResult, noteResult, textResult } from "./util";

function source(src: string): { url: string } | Buffer {
  if (/^https?:\/\//i.test(src)) return { url: src };
  return readFileSync(src); // local path -> buffer
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "wa_send_text",
    {
      title: "Send text",
      description: "Send a text message (optionally with mentions / as a reply). Validates the target first.",
      inputSchema: {
        target: z.string().describe("Phone number or JID."),
        text: z.string().min(1).describe("Message body."),
        mentions: z.array(z.string()).optional().describe("JIDs to mention (also put @number in text)."),
        quotedId: z.string().optional().describe("Message id to reply to."),
        simulateTyping: z.boolean().optional().describe("Show 'typing…' before sending."),
      },
    },
    async ({ target, text, mentions, quotedId, simulateTyping }) => {
      const content: AnyMessageContent = { text, ...(mentions ? { mentions } : {}) };
      const quoted = quotedId ? (getMessageRawAnyChat(quotedId) as WAMessage | null) : null;
      const res = await safeSend(target, content, {
        ...(quoted ? { quoted } : {}),
        simulateTyping,
      });
      return res.ok ? textResult(res, "Sent.") : errorResult(res.error);
    },
  );

  server.registerTool(
    "wa_send_media",
    {
      title: "Send media",
      description: "Send image / video / audio / document / sticker by URL or local file path.",
      inputSchema: {
        target: z.string().describe("Phone number or JID."),
        kind: z.enum(["image", "video", "audio", "document", "sticker"]),
        source: z.string().describe("An http(s) URL or a local file path."),
        caption: z.string().optional(),
        ptt: z.boolean().optional().describe("Audio only: send as a voice note (requires ogg/opus)."),
        fileName: z.string().optional().describe("Document only."),
        mimetype: z.string().optional(),
        quotedId: z.string().optional(),
      },
    },
    async ({ target, kind, source: src, caption, ptt, fileName, mimetype, quotedId }) => {
      let data: { url: string } | Buffer;
      try {
        data = source(src);
      } catch (e: any) {
        return errorResult(`could not read source "${src}": ${e?.message ?? e}`);
      }
      let content: any;
      switch (kind) {
        case "image":
          content = { image: data as any, caption, mimetype };
          break;
        case "video":
          content = { video: data as any, caption, mimetype };
          break;
        case "audio":
          content = {
            audio: data as any,
            ptt: ptt ?? false,
            mimetype: mimetype ?? "audio/ogg; codecs=opus",
          };
          break;
        case "document":
          content = { document: data as any, fileName: fileName ?? "file", caption, mimetype };
          break;
        case "sticker":
          content = { sticker: data as any };
          break;
      }
      const quoted = quotedId ? (getMessageRawAnyChat(quotedId) as WAMessage | null) : null;
      const res = await safeSend(target, content!, quoted ? { quoted } : undefined);
      return res.ok ? textResult(res, "Sent.") : errorResult(res.error);
    },
  );

  server.registerTool(
    "wa_react",
    {
      title: "React",
      description: "Add or remove an emoji reaction on a message (empty emoji removes).",
      inputSchema: {
        chatJid: z.string().describe("The chat JID."),
        msgId: z.string().describe("The target message id."),
        emoji: z.string().describe("Emoji, or empty string to remove."),
      },
    },
    async ({ chatJid, msgId, emoji }) => {
      const restricted = sendBlocked();
      if (restricted) return errorResult(restricted);
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const msg = getMessageRaw(chatJid, msgId) as WAMessage | null;
      if (!msg?.key) return errorResult("message not found in store");
      try {
        await getSock().sendMessage(chatJid, { react: { text: emoji, key: msg.key } });
        return noteResult(emoji ? `Reacted ${emoji}.` : "Reaction removed.");
      } catch (e: any) {
        return errorResult(`react failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_edit_message",
    {
      title: "Edit message",
      description: "Edit a message you sent (~15 minute window).",
      inputSchema: {
        chatJid: z.string().describe("The chat JID."),
        msgId: z.string().describe("Your message id to edit."),
        newText: z.string().min(1),
      },
    },
    async ({ chatJid, msgId, newText }) => {
      const restricted = sendBlocked();
      if (restricted) return errorResult(restricted);
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const msg = getMessageRaw(chatJid, msgId) as WAMessage | null;
      if (!msg?.key) return errorResult("message not found in store");
      if (!msg.key.fromMe) return errorResult("can only edit your own messages");
      try {
        await getSock().sendMessage(chatJid, { text: newText, edit: msg.key });
        return noteResult("Edited.");
      } catch (e: any) {
        return errorResult(`edit failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_delete_message",
    {
      title: "Delete message",
      description: "Delete/revoke a message for everyone (~48 hour window).",
      inputSchema: {
        chatJid: z.string().describe("The chat JID."),
        msgId: z.string().describe("The message id to delete."),
      },
    },
    async ({ chatJid, msgId }) => {
      const restricted = sendBlocked();
      if (restricted) return errorResult(restricted);
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const msg = getMessageRaw(chatJid, msgId) as WAMessage | null;
      if (!msg?.key) return errorResult("message not found in store");
      try {
        await getSock().sendMessage(chatJid, { delete: msg.key });
        return noteResult("Deleted for everyone.");
      } catch (e: any) {
        return errorResult(`delete failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_forward_message",
    {
      title: "Forward a message",
      description: "Forward a stored message to another chat. Routes through anti-ban pacing + the kill-switch.",
      inputSchema: {
        sourceChatJid: z.string().describe("The chat the message currently lives in."),
        msgId: z.string().describe("The message id to forward."),
        target: z.string().describe("Destination phone or JID."),
      },
    },
    async ({ sourceChatJid, msgId, target }) => {
      const msg = getMessageRaw(sourceChatJid, msgId) as WAMessage | null;
      if (!msg?.message) return errorResult("message not found in store");
      const res = await safeSend(target, { forward: msg } as any);
      return res.ok ? textResult(res, "Forwarded.") : errorResult(res.error);
    },
  );

  server.registerTool(
    "wa_pin_message",
    {
      title: "Pin / unpin a message",
      description: "Pin a message in its chat for a duration (24h=86400, 7d=604800, 30d=2592000), or unpin it.",
      inputSchema: {
        chatJid: z.string().describe("The chat JID."),
        msgId: z.string().describe("The target message id."),
        pin: z.boolean().describe("true = pin, false = unpin."),
        seconds: z.number().int().optional().describe("Pin duration in seconds (default 604800 = 7d)."),
      },
    },
    async ({ chatJid, msgId, pin, seconds }) => {
      const restricted = sendBlocked();
      if (restricted) return errorResult(restricted);
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const msg = getMessageRaw(chatJid, msgId) as WAMessage | null;
      if (!msg?.key) return errorResult("message not found in store");
      try {
        await getSock().sendMessage(chatJid, {
          pin: { type: pin ? 1 : 2, time: seconds ?? 604800, key: msg.key },
        } as any);
        return noteResult(pin ? "Message pinned." : "Message unpinned.");
      } catch (e: any) {
        return errorResult(`pin failed: ${e?.message ?? e}`);
      }
    },
  );
}
