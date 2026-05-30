// Master send kill-switch. When the restriction is ON, EVERY outbound path
// (text, media, templates, buttons, scheduled, reactions, edits, deletes,
// status posts, auto-reply) refuses to send. The flag is persisted in the
// `settings` table so it survives restarts — a fresh server process comes up
// still locked until it is explicitly lifted.
//
// Every outbound site funnels through sendBlocked() (mirrors connection.notReady):
// it returns an error string when sending is disabled, or null when allowed.
import { getSetting, setSetting } from "../store/db";
import { logger } from "../logger";

const KEY_ENABLED = "send_restricted";
const KEY_REASON = "send_restricted_reason";
const KEY_AT = "send_restricted_at";

export interface RestrictionState {
  restricted: boolean;
  reason: string | null;
  since: number | null;
}

// In-memory mirror of the persisted flag so the hot send path never hits SQLite.
let state: RestrictionState = { restricted: false, reason: null, since: null };

// Load the persisted restriction at startup (call AFTER initDb()).
export function initSendGuard(): void {
  const at = getSetting(KEY_AT);
  state = {
    restricted: getSetting(KEY_ENABLED) === "1",
    reason: getSetting(KEY_REASON) || null,
    since: at ? Number(at) : null,
  };
  if (state.restricted)
    logger.warn(
      { reason: state.reason, since: state.since },
      "outbound sending is RESTRICTED (persisted) — no messages will be sent until lifted",
    );
}

// Returns an error string if sending is blocked, else null.
export function sendBlocked(): string | null {
  if (!state.restricted) return null;
  const why = state.reason ? ` (${state.reason})` : "";
  return `Sending is restricted${why}. All outbound is disabled. Lift it with wa_restrict_sending { enabled: false }.`;
}

export function getRestriction(): RestrictionState {
  return { ...state };
}

export function setSendRestricted(enabled: boolean, reason?: string | null): RestrictionState {
  state = {
    restricted: enabled,
    reason: enabled ? reason ?? null : null,
    since: enabled ? Date.now() : null,
  };
  setSetting(KEY_ENABLED, enabled ? "1" : "0");
  setSetting(KEY_REASON, state.reason ?? "");
  setSetting(KEY_AT, state.since ? String(state.since) : "");
  logger.warn({ restricted: enabled, reason: state.reason }, "send restriction updated");
  return { ...state };
}
