// Download + decrypt media for a stored message and write it to disk.
import { downloadMediaMessage } from "@innovatorssoft/baileys";
import type { WAMessage } from "@innovatorssoft/baileys";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { logger } from "../logger";
import { getMessageRaw } from "../store/db";
import { getSock } from "./connection";
import { getContentType } from "@innovatorssoft/baileys";

const EXT: Record<string, string> = {
  imageMessage: "jpg",
  videoMessage: "mp4",
  audioMessage: "ogg",
  documentMessage: "bin",
  stickerMessage: "webp",
};

export async function downloadMedia(
  chatJid: string,
  msgId: string,
): Promise<{ path: string; mimetype?: string; bytes: number }> {
  const msg = getMessageRaw(chatJid, msgId) as WAMessage | null;
  if (!msg?.message) throw new Error("message not found in store");

  const type = String(getContentType(msg.message) ?? "documentMessage");
  const sock = getSock();

  const DL_TIMEOUT_MS = 60_000;
  const buffer = (await Promise.race([
    downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        logger,
        // If WhatsApp purged the media, ask the sender's device to re-upload.
        reuploadRequest: sock.updateMediaMessage,
      },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("media download timed out")), DL_TIMEOUT_MS),
    ),
  ])) as Buffer;

  const ext = EXT[type] ?? "bin";
  const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join(config.mediaDir, `${safeId}.${ext}`);
  writeFileSync(path, buffer);

  const mimetype = (msg.message as any)?.[type]?.mimetype;
  return { path, mimetype, bytes: buffer.length };
}
