// Cross-runtime synchronous SQLite.
//
// The rest of the store speaks one tiny interface — query()/exec()/close() — and
// we bind it to whichever driver the host runtime ships:
//   • Bun  → bun:sqlite        (built in; what existing installs already use)
//   • Node → node-sqlite3-wasm (pure WASM; NO native build, no flags, any Node >= 18)
//
// node-sqlite3-wasm is a WASM SQLite — there is nothing to compile or prebuild, so
// `npx @kahflane/whatsapp-mcp` installs in seconds and can never hit a native-ABI
// mismatch or a node-gyp/prebuild-install failure (the old better-sqlite3 pain that
// made the first cold launch time out). It commits to disk synchronously, so the
// scheduler's claim-before-send survives a crash, but it does NOT support WAL —
// `PRAGMA journal_mode = WAL` silently degrades to the rollback journal there
// (harmless; Bun still gets WAL).
//
// Both drivers are synchronous + single-connection, which the scheduler's
// claim-before-send guard depends on. We load them through createRequire so the
// bundler keeps them external (a static `import "bun:sqlite"` would break Node, and
// vice-versa) and so opening the DB stays a normal synchronous call.
import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// Which driver this process bound — surfaced in the startup log so operators can
// see whether they're on the Bun or Node path.
export const sqliteDriver: "bun:sqlite" | "node-sqlite3-wasm" = isBun ? "bun:sqlite" : "node-sqlite3-wasm";

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

  // node-sqlite3-wasm compiles one statement per SQL string; cache them to mirror
  // bun:sqlite's query() cache (prepare once, reuse).
  const { Database } = requireModule("node-sqlite3-wasm");
  const raw = new Database(path);
  const cache = new Map<string, SqliteStatement>();
  // Two normalisations vs bun:sqlite, applied once per call:
  //  • node-sqlite3-wasm takes bind params as a SINGLE array (positional `?`),
  //    not spread varargs — passing varargs binds only the first and NULLs the
  //    rest. The store always calls with spread args, so collect them into `p`.
  //  • bun:sqlite binds `undefined` as NULL; node-sqlite3-wasm throws on it.
  //    Coerce so both runtimes behave identically for an absent value.
  const nn = (params: unknown[]): unknown[] => params.map((p) => (p === undefined ? null : p));
  return {
    query(sql: string): SqliteStatement {
      let stmt = cache.get(sql);
      if (!stmt) {
        const compiled = raw.prepare(sql);
        stmt = {
          get: (...p: unknown[]) => compiled.get(nn(p)),
          all: (...p: unknown[]) => compiled.all(nn(p)),
          run: (...p: unknown[]) => compiled.run(nn(p)),
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
