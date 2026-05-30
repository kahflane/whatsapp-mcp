// On-demand history paging. With syncFullHistory the bulk arrives via
// messaging-history.set on first login; this lets us request OLDER messages
// beyond that, 50 at a time (WhatsApp's hard cap per query).
//
// Known limitation: WhatsApp sometimes does not relay on-demand history to
// companion (linked) devices, so a request can succeed yet return nothing.
import type { WAMessage } from "@innovatorssoft/baileys";
import { getMessageRaw, oldestMessage } from "../store/db";
import { getSock, notReady } from "./connection";

const MAX_PER_QUERY = 50;

export async function fetchOlderHistory(
  chatJid: string,
  count: number,
): Promise<{ ok: true; requested: number } | { ok: false; error: string }> {
  const blocked = notReady();
  if (blocked) return { ok: false, error: blocked };

  const oldest = oldestMessage(chatJid);
  if (!oldest) {
    return { ok: false, error: "no messages stored for this chat yet — open it on your phone or wait for sync" };
  }

  const raw = getMessageRaw(chatJid, oldest.id) as WAMessage | null;
  if (!raw?.key) return { ok: false, error: "could not load oldest message key" };

  const requested = Math.min(Math.max(1, count), MAX_PER_QUERY);
  // messageTimestamp may be a number, a Long, or absent — coerce to seconds.
  const ts: number =
    typeof raw.messageTimestamp === "number"
      ? raw.messageTimestamp
      : (raw.messageTimestamp as any)?.toNumber?.() ?? Math.floor((oldest.ts ?? 0) / 1000);
  try {
    // Results stream back in via messaging-history.set and get written to SQLite.
    await getSock().fetchMessageHistory(requested, raw.key, ts);
    return { ok: true, requested };
  } catch (e: any) {
    return { ok: false, error: `fetchMessageHistory failed: ${e?.message ?? e}` };
  }
}
