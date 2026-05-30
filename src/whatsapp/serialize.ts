// Durable (de)serialization of a WAMessage for the `raw` column.
//
// We MUST NOT use JSON for this: a WAMessage carries binary fields (mediaKey,
// fileEncSha256, …) as Uint8Array and 64-bit ints as Long. JSON.stringify turns
// a Uint8Array into a plain object ({"0":..,"1":..}) and a Long into {low,high},
// which silently corrupts media decryption and getMessage hydration. The proto
// codec round-trips both correctly (verified). We tag the payload so a future
// format change (or a legacy JSON row) can still be read.
import { proto } from "@innovatorssoft/baileys";
import type { WAMessage } from "@innovatorssoft/baileys";
import { logger } from "../logger";

const PROTO = "P:";
const JSON_ = "J:";

export function encodeMessage(msg: WAMessage): string {
  try {
    const bytes = proto.WebMessageInfo.encode(msg as any).finish();
    return PROTO + Buffer.from(bytes).toString("base64");
  } catch (e) {
    // last-resort fallback so a message is never lost; binary fields may be lossy
    logger.warn({ e }, "proto encode failed; falling back to JSON");
    return JSON_ + JSON.stringify(msg, jsonSafeReplacer());
  }
}

export function decodeMessage(stored: string): WAMessage | null {
  try {
    if (stored.startsWith(PROTO)) {
      const buf = Buffer.from(stored.slice(PROTO.length), "base64");
      return proto.WebMessageInfo.decode(buf) as unknown as WAMessage;
    }
    if (stored.startsWith(JSON_)) return JSON.parse(stored.slice(JSON_.length)) as WAMessage;
    // untagged legacy row → assume JSON
    return JSON.parse(stored) as WAMessage;
  } catch (e) {
    logger.warn({ e }, "decodeMessage failed");
    return null;
  }
}

// circular-safe replacer for the JSON fallback path only
function jsonSafeReplacer() {
  const seen = new WeakSet();
  return (_key: string, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return undefined;
      seen.add(value as object);
    }
    return value;
  };
}
