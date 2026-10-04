import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Each entry moves the schema one version forward; `user_version` records how
 * far a database has come. Never edit one that has shipped: add another.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    apple_sub TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE device_codes (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    user_id TEXT REFERENCES users(id),
    device_id TEXT REFERENCES devices(id),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE credentials (
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('claude_token', 'anthropic_api_key', 'github_installation')),
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, kind)
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    sprite TEXT NOT NULL,
    repo TEXT,
    status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'destroyed')),
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX projects_by_user ON projects(user_id);
  CREATE TABLE worker_keys (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    token_hash TEXT NOT NULL UNIQUE
  );
  CREATE TABLE push_tokens (
    user_id TEXT NOT NULL REFERENCES users(id),
    expo_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, expo_token)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX events_by_project ON events(project_id, id);
  CREATE TABLE artifacts (
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL CHECK (kind IN ('draft', 'render')),
    path TEXT NOT NULL,
    object_key TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (project_id, kind, path)
  );
  `,
];

export type Db = DatabaseSync;

/** Opens the database at `file` (":memory:" for tests) and brings it up to date. */
export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL is what Litestream replicates; foreign keys are off in SQLite unless asked.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function migrate(db: Db): void {
  for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
