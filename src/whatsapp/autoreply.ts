// Keyword/pattern auto-reply, built on the fork's createAutoReply (with built-in
// typing simulation + per-JID cooldown). DISABLED by default — turn it on with
// the wa_autoreply_enable tool so the server never replies unexpectedly.
//
// The send/presence functions read getSock() lazily so the auto-replier keeps
// working across reconnects (the socket instance changes, the wiring doesn't).
import { createAutoReply } from "@innovatorssoft/baileys";
import type { WAMessage } from "@innovatorssoft/baileys";
import { logger } from "../logger";
import { getSock } from "./connection";

let autoReply: any = null;
let enabled = false;

export interface RuleInput {
  keywords?: string[];
  pattern?: string; // regex source, applied case-insensitively
  exactMatch?: string;
  responseText: string;
  quoted?: boolean;
  groupsOnly?: boolean;
  privateOnly?: boolean;
  cooldown?: number;
  priority?: number;
  allowedJids?: string[];
}

export function initAutoReply(): void {
  autoReply = createAutoReply(
    (jid: string, content: any, opts: any) => getSock().sendMessage(jid, content, opts),
    (jid: string, presence: any) => getSock().sendPresenceUpdate(presence, jid),
    {
      simulateTyping: true,
      typingDuration: 1500,
      globalCooldown: 2000,
      onReply: (rule: any) => logger.info({ rule: rule?.id }, "auto-replied"),
      onError: (err: any, rule: any) => logger.warn({ rule: rule?.id, err: err?.message }, "autoreply rule failed"),
    },
  );
}

export function setEnabled(v: boolean): void {
  enabled = v;
}
export function isEnabled(): boolean {
  return enabled;
}

export async function handleIncoming(msg: WAMessage): Promise<void> {
  if (!enabled || !autoReply || msg.key.fromMe) return;
  try {
    await autoReply.processMessage(msg);
  } catch (e) {
    logger.warn({ e }, "autoreply.processMessage failed");
  }
}

export function addRule(input: RuleInput): any {
  const rule: any = { response: { text: input.responseText } };
  if (input.keywords) rule.keywords = input.keywords;
  if (input.pattern) {
    // Cap length to blunt catastrophic-backtracking (ReDoS) patterns. This is a
    // mitigation, not a guarantee — patterns run in the message event loop.
    if (input.pattern.length > 200) throw new Error("regex pattern too long (max 200 chars)");
    rule.pattern = new RegExp(input.pattern, "i");
  }
  if (input.exactMatch) rule.exactMatch = input.exactMatch;
  if (input.quoted != null) rule.quoted = input.quoted;
  if (input.groupsOnly != null) rule.groupsOnly = input.groupsOnly;
  if (input.privateOnly != null) rule.privateOnly = input.privateOnly;
  if (input.cooldown != null) rule.cooldown = input.cooldown;
  if (input.priority != null) rule.priority = input.priority;
  if (input.allowedJids) rule.allowedJids = input.allowedJids;
  return autoReply.addRule(rule);
}

export function listRules(): any[] {
  try {
    return autoReply?.getRules?.() ?? [];
  } catch {
    return [];
  }
}

export function removeRule(id: string): boolean {
  try {
    return !!autoReply?.removeRule?.(id);
  } catch {
    return false;
  }
}

export function setRuleActive(id: string, active: boolean): boolean {
  try {
    autoReply?.setRuleActive?.(id, active);
    return true;
  } catch {
    return false;
  }
}

export function clearRules(): void {
  try {
    autoReply?.clearRules?.();
  } catch {
    /* ignore */
  }
}
