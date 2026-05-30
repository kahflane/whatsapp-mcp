// JID helpers. We prefer the innovatorssoft fork's advanced JID utilities
// (parseJid / normalizePhoneToJid / plotJid) and fall back to hand-rolled logic
// if a future version drops them — so the scaffold can't hard-break on an import.
import * as Baileys from "@innovatorssoft/baileys";
import { jidDecode, jidNormalizedUser } from "@innovatorssoft/baileys";

const _parseJid = (Baileys as any).parseJid as ((jid: string) => ParsedJid) | undefined;
const _normalizePhoneToJid = (Baileys as any).normalizePhoneToJid as ((p: string) => string) | undefined;
const _plotJid = (Baileys as any).plotJid as ((jid: string) => string) | undefined;

export const USER_SERVER = "s.whatsapp.net";
export const GROUP_SERVER = "g.us";

export interface ParsedJid {
  server: string;
  user: string;
  isLid: boolean;
  isGroup: boolean;
  isBroadcast: boolean;
  isUser: boolean;
  raw: string;
}

export function parseJid(jid: string): ParsedJid {
  if (_parseJid) {
    try {
      // The fork's parseJid is typed `(jid) => JidInfo | null` and returns NULL
      // for a bare phone with no "@" (e.g. "+601114737548"). Only trust a result
      // that actually has the fields our callers read — otherwise fall through to
      // the hand-rolled parser below (which never returns null). Without this
      // guard, isGroupJid/isLid/jidUser/etc. crash on `null.isGroup`.
      const r = _parseJid(jid) as Partial<ParsedJid> | null;
      if (r && typeof r.server === "string" && typeof r.user === "string") {
        return r as ParsedJid;
      }
    } catch {
      /* fall through */
    }
  }
  const at = jid.indexOf("@");
  const user = at >= 0 ? jid.slice(0, at) : jid;
  const server = at >= 0 ? jid.slice(at + 1) : "";
  return {
    server,
    user,
    isLid: server === "lid",
    isGroup: server === GROUP_SERVER,
    isBroadcast: server.includes("broadcast"),
    isUser: server === USER_SERVER || server === "c.us",
    raw: jid,
  };
}

export function isGroupJid(jid: string): boolean {
  return parseJid(jid).isGroup;
}

export function isUserJid(jid: string): boolean {
  return parseJid(jid).isUser;
}

export function isLid(jid: string): boolean {
  return parseJid(jid).isLid;
}

// Raw phone number (any formatting) -> user JID, via the fork's normalizer.
export function phoneToJid(input: string): string {
  if (input.includes("@")) return normalize(input);
  if (_normalizePhoneToJid) {
    try {
      const out = _normalizePhoneToJid(input);
      if (out) return out;
    } catch {
      /* fall through */
    }
  }
  const digits = input.replace(/[^0-9]/g, "");
  return `${digits}@${USER_SERVER}`;
}

export function normalize(jid: string): string {
  try {
    return jidNormalizedUser(jid) || jid;
  } catch {
    return jid;
  }
}

// Convert between PN <-> LID using the fork's plotter (only works when WhatsApp
// has given us the mapping; otherwise returns the input unchanged).
export function plot(jid: string): string {
  if (_plotJid) {
    try {
      return _plotJid(jid) || jid;
    } catch {
      /* fall through */
    }
  }
  return jid;
}

// If `jid` is a @lid, try to resolve its phone-number JID. Returns null if no
// mapping is available yet.
export function lidToPnJid(jid: string): string | null {
  if (!isLid(jid)) return null;
  const p = plot(jid);
  return p && !p.endsWith("@lid") ? p : null;
}

// Human-friendly "+number", or the raw jid when we can't decode a real number.
// IMPORTANT: a @lid's user is NOT a phone number — never render it as "+<lid>".
// LID -> phone resolution requires the key store (see lid.ts / resolveName).
export function jidToDisplayPhone(jid: string): string {
  const info = parseJid(jid);
  if (info.isLid) return jid; // can't derive a phone number from a lid synchronously
  if (info.user && /^[0-9]+$/.test(info.user)) return `+${info.user}`;
  const dec = jidDecode(jid);
  if (dec?.user && /^[0-9]+$/.test(dec.user)) return `+${dec.user}`;
  return jid;
}

export function jidUser(jid: string): string | null {
  return parseJid(jid).user || jidDecode(jid)?.user || null;
}
