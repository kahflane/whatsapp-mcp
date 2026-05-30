// Central runtime configuration, parsed once from the environment.
// Everything is overridable via env (see .env.example).

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

export const config = {
  // login
  pairingNumber: str("WA_PAIRING_NUMBER", "").replace(/[^0-9]/g, ""),

  // history
  syncFullHistory: bool("WA_SYNC_FULL_HISTORY", true),

  // anti-ban pacing
  minGapMs: num("WA_MIN_GAP_MS", 2000),
  maxGapMs: num("WA_MAX_GAP_MS", 5000),
  dailyCap: num("WA_DAILY_CAP", 100),

  // paths
  authDir: str("WA_AUTH_DIR", "./auth_info_baileys"),
  dataDir: str("WA_DATA_DIR", "./data"),
  dbPath: str("WA_DB_PATH", "./data/whatsapp.db"),
  mediaDir: str("WA_MEDIA_DIR", "./data/media"),

  // logging
  logLevel: str("WA_LOG_LEVEL", "warn"),

  // identity shown to WhatsApp
  clientName: "Claude-WA-MCP",
} as const;
