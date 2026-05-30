// Turning a raw WAMessage into a normalized, human-readable record + the text
// extraction that covers all the message variants.
import { getContentType, getDevice, normalizeMessageContent } from "@innovatorssoft/baileys";
import type { WAMessage } from "@innovatorssoft/baileys";
import type { MessageRow } from "../store/db";
import { resolveName } from "./names";
import { encodeMessage } from "./serialize";

export interface NormalizedMessage {
  id: string;
  chatJid: string;
  senderJid: string | null;
  senderName: string | null;
  fromMe: boolean;
  type: string;
  text: string;
  timestamp: number; // epoch ms
  quotedId: string | null;
  device: string | null; // android | ios | web | desktop | unknown (from getDevice)
  media: { type: string; mimetype?: string; caption?: string; fileLength?: number } | null;
}

// Pull readable text out of any message content. `content` is msg.message.
export function extractText(content: any): { type: string; text: string } {
  if (!content) return { type: "unknown", text: "" };

  // unwrap ephemeral / viewOnce / edited wrappers
  const c = normalizeMessageContent(content) ?? content;
  const type = String(getContentType(c) ?? "unknown");

  switch (type) {
    case "conversation":
      return { type, text: c.conversation ?? "" };
    case "extendedTextMessage":
      return { type, text: c.extendedTextMessage?.text ?? "" };
    case "imageMessage":
      return { type, text: c.imageMessage?.caption ?? "[image]" };
    case "videoMessage":
      return { type, text: c.videoMessage?.caption ?? (c.videoMessage?.gifPlayback ? "[gif]" : "[video]") };
    case "documentMessage":
      return { type, text: c.documentMessage?.caption ?? `[document: ${c.documentMessage?.fileName ?? "file"}]` };
    case "documentWithCaptionMessage": {
      const inner = c.documentWithCaptionMessage?.message?.documentMessage;
      return { type, text: inner?.caption ?? `[document: ${inner?.fileName ?? "file"}]` };
    }
    case "audioMessage":
      return { type, text: c.audioMessage?.ptt ? "[voice message]" : "[audio]" };
    case "stickerMessage":
      return { type, text: "[sticker]" };
    case "contactMessage":
      return { type, text: `[contact: ${c.contactMessage?.displayName ?? ""}]` };
    case "contactsArrayMessage":
      return { type, text: `[contacts: ${c.contactsArrayMessage?.contacts?.length ?? 0}]` };
    case "locationMessage":
      return {
        type,
        text: `[location: ${c.locationMessage?.degreesLatitude}, ${c.locationMessage?.degreesLongitude}]`,
      };
    case "liveLocationMessage":
      return { type, text: "[live location]" };
    case "reactionMessage":
      return { type, text: `[reaction: ${c.reactionMessage?.text ?? ""}]` };
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3":
      return { type, text: `[poll: ${c.pollCreationMessage?.name ?? c.pollCreationMessageV3?.name ?? ""}]` };
    case "protocolMessage": {
      const pt = c.protocolMessage?.type;
      if (pt === 0 /* REVOKE */) return { type, text: "[message deleted]" };
      if (pt === 14 /* MESSAGE_EDIT */) {
        const edited = c.protocolMessage?.editedMessage;
        return { type, text: edited ? extractText(edited).text : "[message edited]" };
      }
      return { type, text: "[protocol message]" };
    }
    default:
      return { type, text: `[${type}]` };
  }
}

function getQuotedId(content: any): string | null {
  const c = normalizeMessageContent(content) ?? content;
  const type = getContentType(c);
  const ci = type ? c[type]?.contextInfo : undefined;
  return ci?.stanzaId ?? null;
}

export async function normalizeMessage(msg: WAMessage): Promise<NormalizedMessage> {
  const chatJid = msg.key.remoteJid ?? "";
  const fromMe = !!msg.key.fromMe;
  // In groups the sender is key.participant; in 1:1 it's the remoteJid.
  const senderJid = fromMe ? null : msg.key.participant ?? msg.key.remoteJid ?? null;
  const { type, text } = extractText(msg.message);
  const tsRaw = Number(msg.messageTimestamp ?? 0);
  const senderName = senderJid ? await resolveName(senderJid, { pushName: msg.pushName }) : "me";

  let device: string | null = null;
  try {
    device = msg.key.id ? (getDevice(msg.key.id) as string) : null;
  } catch {
    /* unknown id format */
  }

  let media: NormalizedMessage["media"] = null;
  const c = normalizeMessageContent(msg.message) ?? msg.message ?? {};
  const m: any =
    c.imageMessage || c.videoMessage || c.audioMessage || c.documentMessage ||
    c.documentWithCaptionMessage?.message?.documentMessage || c.stickerMessage;
  if (m) {
    media = {
      type,
      mimetype: m.mimetype ?? undefined,
      caption: m.caption ?? undefined,
      fileLength: m.fileLength ? Number(m.fileLength) : undefined,
    };
  }

  return {
    id: msg.key.id ?? "",
    chatJid,
    senderJid,
    senderName,
    fromMe,
    type,
    text,
    timestamp: tsRaw * 1000, // Baileys gives UNIX seconds
    quotedId: getQuotedId(msg.message),
    device,
    media,
  };
}

export function toRow(n: NormalizedMessage, msg: WAMessage): MessageRow {
  return {
    id: n.id,
    chat_jid: n.chatJid,
    sender_jid: n.senderJid,
    sender_name: n.senderName,
    from_me: n.fromMe ? 1 : 0,
    type: n.type,
    text: n.text,
    ts: n.timestamp,
    quoted_id: n.quotedId,
    device: n.device,
    read: n.fromMe ? 1 : 0,
    raw: encodeMessage(msg),
  };
}
