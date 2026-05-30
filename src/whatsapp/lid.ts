// LID (Linked ID) <-> phone-number (PN) resolution.
//
// WhatsApp now assigns each account a LID (…@lid) as a privacy-preserving
// identity; many message keys / participants arrive as @lid instead of the
// phone-number jid (…@s.whatsapp.net). To show a real number/name we must map
// LID -> PN.
//
// The fork's plotJid() is a PURE string function with no store access, so it
// can't do this alone. The real mapping lives in the signal key store, which
// Baileys persists (verified in auth_info_baileys/lid-mapping-*.json):
//
//   keys.get("lid-mapping", ["<lidUser>_reverse"]) -> { "<lidUser>_reverse": "<pnUser>" }   (LID -> PN)
//   keys.get("lid-mapping", ["<pnUser>"])          -> { "<pnUser>": "<lidUser>" }            (PN -> LID)
//
// We read that store directly, with an in-memory cache (also fed by the
// lid-mapping.update event) in front for speed.
import { parseJid, USER_SERVER } from "./jid";

// the raw multi-file SignalKeyStore (NOT the cacheable wrapper); set at startup
let keyStore: any = null;

const lidToPnCache = new Map<string, string>(); // lidUser -> pnUser
const pnToLidCache = new Map<string, string>(); // pnUser -> lidUser

export function setKeyStore(keys: any): void {
  keyStore = keys;
}

function userOf(jidOrUser: string): string {
  return jidOrUser.includes("@") ? parseJid(jidOrUser).user : jidOrUser;
}

// Record a mapping (accepts jids or bare users). Fed by lid-mapping.update.
export function noteMapping(lid: string | null | undefined, pn: string | null | undefined): void {
  if (!lid || !pn) return;
  const lu = userOf(lid);
  const pu = userOf(pn);
  if (lu && pu) {
    lidToPnCache.set(lu, pu);
    pnToLidCache.set(pu, lu);
  }
}

// LID jid/user -> PN user string (digits only), or null if no mapping yet.
export async function lidUserToPn(lidJidOrUser: string): Promise<string | null> {
  const lidUser = userOf(lidJidOrUser);
  if (!lidUser) return null;

  const cached = lidToPnCache.get(lidUser);
  if (cached) return cached;

  if (!keyStore) return null;
  try {
    const id = `${lidUser}_reverse`;
    const res = await keyStore.get("lid-mapping", [id]);
    const pn = res?.[id];
    if (typeof pn === "string" && pn) {
      noteMapping(lidUser, pn);
      return pn;
    }
  } catch {
    /* store miss / unsupported */
  }
  return null;
}

// PN jid/user -> LID user string, or null.
export async function pnUserToLid(pnJidOrUser: string): Promise<string | null> {
  const pnUser = userOf(pnJidOrUser);
  if (!pnUser) return null;

  const cached = pnToLidCache.get(pnUser);
  if (cached) return cached;

  if (!keyStore) return null;
  try {
    const res = await keyStore.get("lid-mapping", [pnUser]);
    const lid = res?.[pnUser];
    if (typeof lid === "string" && lid) {
      noteMapping(lid, pnUser);
      return lid;
    }
  } catch {
    /* store miss / unsupported */
  }
  return null;
}

// Convert a @lid jid to its PN @s.whatsapp.net jid when a mapping exists;
// otherwise return the input unchanged.
export async function toPnJid(jid: string): Promise<string> {
  if (!jid.endsWith("@lid")) return jid;
  const pn = await lidUserToPn(jid);
  return pn ? `${pn}@${USER_SERVER}` : jid;
}
