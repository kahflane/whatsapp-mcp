// Resolving JIDs -> human names, with a clear precedence chain.
//
// Sources (freshest first):
//   group jid      -> group subject (from chats table / live groupMetadata)
//   live pushName  -> sender's own current display name (only on messages.upsert)
//   pushName cache -> last pushName we saw for this sender
//   contact.notify -> contact's self-set WhatsApp name
//   verified_name  -> official business name
//   contact.name   -> name as saved in the address book
//   fallback       -> +phone (or raw jid / lid mapping)
import { getChat, getContact, upsertChat } from "../store/db";
import { conn } from "./connection";
import { getGroupMetadataCached } from "./groupcache";
import { isGroupJid, isLid, jidToDisplayPhone, normalize, USER_SERVER } from "./jid";
import { lidUserToPn, noteMapping } from "./lid";

// pushName is only present on messages.upsert, never on messages.update — so we
// cache it as we see it.
const pushNameCache = new Map<string, string>();

export function notePushName(senderJid: string | null | undefined, name: string | null | undefined): void {
  if (senderJid && name) pushNameCache.set(normalize(senderJid), name);
}

// kept for the lid-mapping.update event wiring; delegates to the lid module.
export function noteLidMapping(lid: string, pn: string): void {
  noteMapping(lid, pn);
}

export async function resolveName(jidRaw: string, msg?: { pushName?: string | null }): Promise<string> {
  const jid = normalize(jidRaw);

  if (isGroupJid(jid)) {
    const chat = getChat(jid);
    if (chat?.name) return chat.name;
    // lazily fetch (shared cache) + persist the subject
    try {
      const meta = await getGroupMetadataCached(jid);
      if (meta?.subject) {
        upsertChat({ jid, name: meta.subject, is_group: 1 });
        return meta.subject;
      }
    } catch {
      /* not connected / not a member */
    }
    return jid;
  }

  if (msg?.pushName) return msg.pushName;

  const cached = pushNameCache.get(jid);
  if (cached) return cached;

  const c = getContact(jid);
  if (c?.notify) return c.notify;
  if (c?.verified_name) return c.verified_name;
  if (c?.name) return c.name;

  if (isLid(jid)) {
    // resolve LID -> PN via the signal key store, then look up the PN contact
    const pnUser = await lidUserToPn(jid);
    if (pnUser) {
      const pnJid = `${pnUser}@${USER_SERVER}`;
      const pc = getContact(pnJid);
      if (pc?.notify) return pc.notify;
      if (pc?.verified_name) return pc.verified_name;
      if (pc?.name) return pc.name;
      return `+${pnUser}`;
    }
    // no mapping yet: return the raw lid (NOT a fake +<lid> phone number)
    return jid;
  }

  return jidToDisplayPhone(jid);
}

// "where did the name come from" — used by wa_resolve_name for transparency.
export async function resolveNameWithSource(
  jidRaw: string,
): Promise<{ jid: string; name: string; source: string }> {
  const jid = normalize(jidRaw);
  if (isGroupJid(jid)) {
    const name = await resolveName(jid);
    return { jid, name, source: "groupSubject" };
  }
  const cached = pushNameCache.get(jid);
  if (cached) return { jid, name: cached, source: "pushName" };
  const c = getContact(jid);
  if (c?.notify) return { jid, name: c.notify, source: "notify" };
  if (c?.verified_name) return { jid, name: c.verified_name, source: "verifiedName" };
  if (c?.name) return { jid, name: c.name, source: "name" };

  if (isLid(jid)) {
    const pnUser = await lidUserToPn(jid);
    if (pnUser) {
      const pnJid = `${pnUser}@${USER_SERVER}`;
      const pc = getContact(pnJid);
      if (pc?.notify) return { jid, name: pc.notify, source: "lid->notify" };
      if (pc?.verified_name) return { jid, name: pc.verified_name, source: "lid->verifiedName" };
      if (pc?.name) return { jid, name: pc.name, source: "lid->name" };
      return { jid, name: `+${pnUser}`, source: "lid->phone" };
    }
    return { jid, name: jid, source: "lid-unmapped" };
  }

  return { jid, name: jidToDisplayPhone(jid), source: "phone" };
}

export function isSelf(jid: string): boolean {
  return !!conn.me && normalize(jid) === normalize(conn.me.jid);
}
