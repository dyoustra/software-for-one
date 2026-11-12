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
  // A device code carries its device's name to the approval page, and the
  // token waits on it until the CLI collects it (then the row is deleted).
  `
  ALTER TABLE device_codes ADD COLUMN device_name TEXT NOT NULL DEFAULT 'a device';
  ALTER TABLE device_codes ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied'));
  ALTER TABLE device_codes ADD COLUMN token TEXT;
  `,
  // A GitHub connection in progress: started by a signed-in device, finished
  // in a browser that proves it is the same person; usable once.
  `
  CREATE TABLE github_flows (
    flow_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  `,
  // PKCE: the verifier never leaves the server, and GitHub redeems a code
  // only with the verifier for the challenge it was issued under. The return
  // address is fixed when the flow starts, not taken from whoever finishes it.
  `
  ALTER TABLE github_flows ADD COLUMN code_verifier TEXT NOT NULL DEFAULT '';
  ALTER TABLE github_flows ADD COLUMN redirect_uri TEXT NOT NULL DEFAULT '';
  `,
  // The person's preferences, held here so the app and every machine share them.
  `
  CREATE TABLE user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    preferences TEXT NOT NULL,
    sfo_md TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  // A push token belongs to the signed-in device that registered it: revoked
  // or signed out, the device is told nothing more.
  `
  ALTER TABLE push_tokens ADD COLUMN device_id TEXT REFERENCES devices(id);
  `,
  // A token is used only once the phone proves it receives on it: the server
  // pushes a one-time code to it, and the app sends the code back.
  `
  ALTER TABLE push_tokens ADD COLUMN code_hash TEXT;
  ALTER TABLE push_tokens ADD COLUMN verified_at TEXT;
  `,
  // An account is no longer an Apple id: each way of signing in is an
  // identity of it. users loses apple_sub, so the table is rebuilt (foreign
  // keys are off while migrations run, and checked after).
  `
  CREATE TABLE identities (
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL CHECK (provider IN ('apple', 'github')),
    subject TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  INSERT INTO identities (user_id, provider, subject, created_at) SELECT id, 'apple', apple_sub, created_at FROM users;
  CREATE TABLE users_rebuilt (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  INSERT INTO users_rebuilt (id, created_at) SELECT id, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_rebuilt RENAME TO users;
  `,
  // v9: a project is recorded before its setup starts, so the person can leave
  // while it runs; these say what it is and how setup is going.
  `
  ALTER TABLE projects ADD COLUMN idea TEXT;
  ALTER TABLE projects ADD COLUMN setup_step TEXT;
  ALTER TABLE projects ADD COLUMN setup_error TEXT;
  `,
];

export type Db = DatabaseSync;

/**
 * Opens the database at `file` (":memory:" for tests) and brings it up to
 * date, or only to `upTo`, for a test of a migration.
 */
export function openDb(file: string, upTo = MIGRATIONS.length): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL is what Litestream replicates; foreign keys are off in SQLite unless asked.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db, upTo);
  return db;
}

export function schemaVersion(db: Db): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function migrate(db: Db, upTo: number): void {
  // Off while migrating, since one rebuilds a table others refer to; on again
  // and checked after, so a migration that broke a reference fails here.
  db.exec("PRAGMA foreign_keys = OFF");
  for (let v = schemaVersion(db); v < upTo; v++) {
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
  db.exec("PRAGMA foreign_keys = ON");
  const broken = db.prepare("PRAGMA foreign_key_check").all();
  if (broken.length > 0) throw new Error(`migration left ${broken.length} broken references: ${JSON.stringify(broken.slice(0, 3))}`);
}
