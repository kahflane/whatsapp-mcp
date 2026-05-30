// Group-metadata cache — a SINGLE shared TTL cache used by both the Baileys send
// path (via `cachedGroupMetadata` in the socket config) and our read paths
// (`wa_get_group_members`, `wa_group_metadata`, and `resolveName`). Previously
// each read path did its own live `sock.groupMetadata()` round-trip and ignored
// the send-path cache entirely — `resolveName` worst of all, since it runs on
// every ingested group message. Routing them all through `getGroupMetadataCached`
// collapses that to one cached fetch per group per TTL window.
//
// Storage is an in-memory Map, NOT SQLite, on purpose. This is a hot, perishable
// PERF cache, not state of record (WhatsApp's servers are the truth). Persisting
// it across restarts would risk serving a stale participant roster, and because
// Baileys' `cachedGroupMetadata` hook is read-through/trusted — a value that is
// present is NOT re-verified — stale here means encrypting to the wrong member
// set (new members silently miss messages). A cold cache after restart is the
// SAFE failure mode: an empty result makes Baileys fetch a guaranteed-current
// roster. So we keep it in RAM with a 5-min TTL, matching the fork README's
// `NodeCache({ stdTTL: 5*60, useClones: false })` recommendation (a Map + lazy
// TTL is behaviorally equivalent for this read-through use and drops the dep).
import { conn } from "./connection";

const GROUP_META_TTL_MS = 5 * 60 * 1000;
const groupMetaCache = new Map<string, { meta: any; exp: number }>();

// Lazy-TTL read: undefined on miss/expiry (evicting the expired entry). Never
// returns a stale entry — the `exp` check runs on every read.
export function getCachedGroupMetadata(jid: string): any | undefined {
  const hit = groupMetaCache.get(jid);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    groupMetaCache.delete(jid);
    return undefined;
  }
  return hit.meta;
}

export function setCachedGroupMetadata(jid: string, meta: any): void {
  groupMetaCache.set(jid, { meta, exp: Date.now() + GROUP_META_TTL_MS });
}

// Re-fetch a group's metadata and refresh the cache (best-effort, never throws).
// Wired to `groups.update` / `group-participants.update` so the cache self-heals
// when a subject or the membership changes.
export async function refreshGroupMetadata(jid: string): Promise<void> {
  if (!jid || !conn.sock) return;
  try {
    const meta = await conn.sock.groupMetadata(jid);
    setCachedGroupMetadata(jid, meta);
  } catch {
    /* group gone / not a member / transient — drop the stale entry */
    groupMetaCache.delete(jid);
  }
}

// Read-through accessor for the READ paths (tools + `resolveName`). Serves the
// cached value when fresh; on a miss does ONE live fetch, populates the cache,
// and returns it. Throws if there is no socket or the fetch fails — callers
// already wrap group reads in try/catch. A cached hit never throws.
export async function getGroupMetadataCached(jid: string): Promise<any> {
  const hit = getCachedGroupMetadata(jid);
  if (hit) return hit;
  if (!conn.sock) throw new Error("not connected");
  const meta = await conn.sock.groupMetadata(jid);
  setCachedGroupMetadata(jid, meta);
  return meta;
}
