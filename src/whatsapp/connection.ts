// The connection singleton: the one live WhatsApp socket shared by every MCP
// tool handler, plus the state machine that drives login + reconnect.
import type { WASocket } from "@innovatorssoft/baileys";

export type ConnState = "connecting" | "open" | "close" | "logged_out";

class ConnectionManager {
  sock: WASocket | null = null;
  state: ConnState = "close";

  // login bootstrap
  qr: string | null = null;
  pairingCode: string | null = null;
  pairingRequested = false;

  // health
  pendingDone = false; // received all queued notifications after connect
  reconnectAttempts = 0;
  lastError: string | null = null;
  reconnecting = false; // guards against overlapping socket re-creation
  intentionalLogout = false; // set by wa_logout so close handler won't reconnect

  // identity
  me: { jid: string; name?: string; phone?: string } | null = null;

  // history sync progress
  historyChunks = 0;
  lastHistoryAt: number | null = null;
}

export const conn = new ConnectionManager();

export function getSock(): WASocket {
  if (!conn.sock) throw new Error("WhatsApp socket is not initialised yet");
  return conn.sock;
}

// Soft guard used by tools: returns an error string if we can't act yet,
// otherwise null. Tools turn this into an isError result (never a throw).
export function notReady(): string | null {
  if (conn.state === "logged_out")
    return "Logged out. Re-authenticate with wa_get_login_qr or wa_get_pairing_code.";
  if (conn.state !== "open")
    return `WhatsApp not connected (state: ${conn.state}). Check wa_status.`;
  return null;
}
