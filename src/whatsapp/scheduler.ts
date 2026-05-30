// Message scheduler — OWN implementation (deliberately NOT the fork's
// createMessageScheduler).
//
// Why we don't use the fork: its processQueue runs on a 1-second setInterval but
// only marks an entry 'sent' / removes it from the queue AFTER `await
// sendMessage()` resolves. Our safeSend paces sends with multi-second jittered
// gaps, so a single due entry stayed 'pending' across several 1s ticks and was
// dispatched once PER tick — the same scheduled message was delivered ~5 times
// (one DB row, N real WhatsApp sends). For a tool that can get a number banned,
// duplicate sends are unacceptable.
//
// Our loop fixes it two ways: (1) it CLAIMS a due row (marks it 'sending' in
// SQLite) BEFORE awaiting the send, so the next tick can't see it; (2) ticks
// never overlap (a `ticking` guard), so a slow send can't stack dispatches.
// SQLite is the single source of truth, so scheduled messages also survive a
// restart automatically — the loop simply claims any now-due pending rows.
import type { AnyMessageContent } from "@innovatorssoft/baileys";
import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import * as db from "../store/db";
import { safeSend } from "./send";

const CHECK_INTERVAL_MS = 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

interface ScheduledEntry {
  id: string;
  jid: string;
  content: AnyMessageContent;
  scheduledTime: Date;
  status: string;
}

function newId(): string {
  return `sched_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function initScheduler(): void {
  const interrupted = db.failInterruptedSending();
  if (interrupted)
    logger.warn({ interrupted }, "marked interrupted 'sending' scheduled rows as failed (not resent)");
  if (!timer) timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

async function tick(): Promise<void> {
  if (ticking) return; // never overlap — a slow paced send must not stack dispatches
  ticking = true;
  try {
    const due = db.claimDueScheduled(Date.now()); // marks each 'sending' before we send
    for (const r of due) {
      try {
        const content = JSON.parse(r.content) as AnyMessageContent;
        const res = await safeSend(r.jid, content);
        if (res.ok) {
          db.updateScheduledStatus(r.id, "sent", null, res.messageId ?? null);
          logger.info({ id: r.id, jid: r.jid }, "scheduled message sent");
        } else {
          db.updateScheduledStatus(r.id, "failed", res.error);
          logger.warn({ id: r.id, error: res.error }, "scheduled message failed");
        }
      } catch (e: any) {
        db.updateScheduledStatus(r.id, "failed", e?.message ?? String(e));
        logger.warn({ id: r.id, e }, "scheduled message failed");
      }
    }
  } finally {
    ticking = false;
  }
}

export function scheduleAt(jid: string, content: AnyMessageContent, when: Date): ScheduledEntry {
  if (isNaN(when.getTime())) throw new Error("invalid date");
  if (when.getTime() <= Date.now()) throw new Error("Scheduled time must be in the future");
  const id = newId();
  db.insertScheduled({
    id,
    jid,
    content: JSON.stringify(content),
    scheduled_time: when.getTime(),
    created_at: Date.now(),
    status: "pending",
  });
  return { id, jid, content, scheduledTime: when, status: "pending" };
}

export function scheduleDelay(jid: string, content: AnyMessageContent, delayMs: number): ScheduledEntry {
  return scheduleAt(jid, content, new Date(Date.now() + delayMs));
}

export function cancel(id: string): boolean {
  return db.cancelScheduledById(id);
}

export function cancelForJid(jid: string): number {
  return db.cancelScheduledForJid(jid);
}

export function listPending(): ScheduledEntry[] {
  return db.listScheduled("pending").map((r) => ({
    id: r.id,
    jid: r.jid,
    content: JSON.parse(r.content) as AnyMessageContent,
    scheduledTime: new Date(r.scheduled_time),
    status: r.status,
  }));
}
