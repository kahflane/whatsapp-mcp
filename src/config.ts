// Central runtime configuration, parsed once from the environment.
// Everything is overridable via env (see .env.example).
import { homedir } from "node:os";
import { join } from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw === "" ? fallback : raw;
}

// One stable home for auth + history so an npx/bunx launch keeps the same login
// no matter which folder it starts from — and never writes into the user's
// project. auth/db/media all default under here; set WA_DATA_DIR to relocate the
// whole lot, or any single WA_* path var to split them.
const dataDir = str("WA_DATA_DIR", join(homedir(), ".whatsapp-mcp"));

export const config = {
  // login
  pairingNumber: str("WA_PAIRING_NUMBER", "").replace(/[^0-9]/g, ""),

  // history
  syncFullHistory: bool("WA_SYNC_FULL_HISTORY", true),

  // anti-ban pacing
  minGapMs: num("WA_MIN_GAP_MS", 2000),
  maxGapMs: num("WA_MAX_GAP_MS", 5000),
  dailyCap: num("WA_DAILY_CAP", 100),

  // paths — all default under dataDir (see above)
  dataDir,
  authDir: str("WA_AUTH_DIR", join(dataDir, "auth")),
  dbPath: str("WA_DB_PATH", join(dataDir, "whatsapp.db")),
  mediaDir: str("WA_MEDIA_DIR", join(dataDir, "media")),

  // logging
  logLevel: str("WA_LOG_LEVEL", "warn"),

  // identity shown to WhatsApp
  clientName: "Claude-WA-MCP",
} as const;
