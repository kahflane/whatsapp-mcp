// One funnel for every outbound action: connection guard -> target validation
// -> anti-ban pacing (single-flight queue + jitter + daily cap) -> sendMessage.
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from "@innovatorssoft/baileys";
import { config } from "../config";
import { logger } from "../logger";
import { upsertMessage } from "../store/db";
import { conn, getSock, notReady } from "./connection";
import { sendBlocked } from "./sendguard";
import { isGroupJid, phoneToJid } from "./jid";
import { normalizeMessage, toRow } from "./messages";

export type SendResult =
  | { ok: true; messageId: string; chatJid: string; timestamp: number }
  | { ok: false; error: string };

// ---- anti-ban pacing ----
let queue: Promise<unknown> = Promise.resolve();
let sentToday = 0;
let dayKey = "";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function jitterMs(): number {
  const lo = Math.min(config.minGapMs, config.maxGapMs);
  const hi = Math.max(config.minGapMs, config.maxGapMs);
  return lo + Math.floor(Math.random() * Math.max(1, hi - lo));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Run a job through the single-flight queue so concurrent MCP tool calls can't
// bypass the pacing.
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  // keep the chain alive regardless of individual job outcome
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Resolve a target (phone or jid) to a sendable, verified jid.
export async function resolveTarget(target: string): Promise<{ ok: true; jid: string } | { ok: false; error: string }> {
  if (isGroupJid(target)) return { ok: true, jid: target };

  // reject empty / junk before building a malformed "@s.whatsapp.net" jid
  if (!target.includes("@") && target.replace(/[^0-9]/g, "").length < 5) {
    return { ok: false, error: `invalid phone number: "${target}"` };
  }

  const jid = phoneToJid(target);
  try {
    const res = await (getSock() as any).onWhatsApp(jid);
    const hit = res?.[0];
    if (!hit?.exists) return { ok: false, error: `${target} is not on WhatsApp` };
    return { ok: true, jid: hit.jid }; // canonical jid (may be @lid)
  } catch (e: any) {
    return { ok: false, error: `could not verify target: ${e?.message ?? e}` };
  }
}

export async function safeSend(
  target: string,
  content: AnyMessageContent,
  options?: MiscMessageGenerationOptions & { simulateTyping?: boolean },
): Promise<SendResult> {
  const restricted = sendBlocked();
  if (restricted) return { ok: false, error: restricted };

  const blocked = notReady();
  if (blocked) return { ok: false, error: blocked };

  const resolved = await resolveTarget(target);
  if (!resolved.ok) return resolved;
  const jid = resolved.jid;

  return enqueue(async (): Promise<SendResult> => {
    // daily cap
    const k = todayKey();
    if (k !== dayKey) {
      dayKey = k;
      sentToday = 0;
    }
    if (sentToday >= config.dailyCap) {
      return { ok: false, error: `daily send cap (${config.dailyCap}) reached — refusing to send (anti-ban)` };
    }

    const sock = getSock();
    try {
      if (options?.simulateTyping) {
        await sock.sendPresenceUpdate("composing", jid);
        await sleep(Math.min(jitterMs(), 3000));
        await sock.sendPresenceUpdate("paused", jid);
      }

      const { simulateTyping, ...sendOpts } = options ?? {};
      const sent = (await sock.sendMessage(jid, content, sendOpts)) as WAMessage | undefined;
      if (!sent?.key?.id) return { ok: false, error: "send returned no message id" };

      sentToday++;
      // persist our own outbound message
      try {
        const n = await normalizeMessage(sent);
        upsertMessage(toRow(n, sent));
      } catch (e) {
        logger.warn({ e }, "failed to persist sent message");
      }

      // space out the next send
      await sleep(jitterMs());

      return {
        ok: true,
        messageId: sent.key.id,
        chatJid: jid,
        timestamp: Number(sent.messageTimestamp ?? 0) * 1000,
      };
    } catch (e: any) {
      return { ok: false, error: `send failed: ${e?.message ?? e}` };
    }
  });
}

export function sendStats(): { sentToday: number; cap: number } {
  if (todayKey() !== dayKey) return { sentToday: 0, cap: config.dailyCap };
  return { sentToday, cap: config.dailyCap };
}

// raw key getter for react/edit/delete (they need the full WAMessageKey)
export { conn };
