// Cross-runtime synchronous SQLite.
//
// The rest of the store speaks one tiny interface — query()/exec()/close() — and
// we bind it to whichever driver the host runtime ships:
//   • Bun  → bun:sqlite      (built in; what existing installs already use)
//   • Node → better-sqlite3  (prebuilt native addon; no flags, Node >= 18)
//
// Both are synchronous + single-connection, which the scheduler's claim-before-send
// guard depends on. We load them through createRequire so the bundler keeps them
// external (a static `import "bun:sqlite"` would break Node, and vice-versa) and so
// opening the DB stays a normal synchronous call.
import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// Which driver this process bound — surfaced in the startup log so operators can
// see whether they're on the Bun or Node path.
export const sqliteDriver: "bun:sqlite" | "better-sqlite3" = isBun ? "bun:sqlite" : "better-sqlite3";

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteDb {
  query(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export function openDatabase(path: string): SqliteDb {
  if (isBun) {
    // bun:sqlite's Database already matches SqliteDb (query/exec/close, run().changes).
    const { Database } = requireModule("bun:sqlite");
    return new Database(path, { create: true }) as SqliteDb;
  }

  // better-sqlite3 compiles one statement per SQL string; cache them to mirror
  // bun:sqlite's query() cache (prepare once, reuse).
  const BetterSqlite3 = requireModule("better-sqlite3");
  const raw = new BetterSqlite3(path);
  const cache = new Map<string, SqliteStatement>();
  // bun:sqlite binds `undefined` as NULL; better-sqlite3 throws on it. Coerce so
  // both runtimes behave identically for callers that pass an absent value.
  const nn = (params: unknown[]): unknown[] => params.map((p) => (p === undefined ? null : p));
  return {
    query(sql: string): SqliteStatement {
      let stmt = cache.get(sql);
      if (!stmt) {
        const compiled = raw.prepare(sql);
        stmt = {
          get: (...p: unknown[]) => compiled.get(...nn(p)),
          all: (...p: unknown[]) => compiled.all(...nn(p)),
          run: (...p: unknown[]) => compiled.run(...nn(p)),
        };
        cache.set(sql, stmt);
      }
      return stmt;
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    close(): void {
      raw.close();
    },
  };
}
