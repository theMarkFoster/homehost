// db-interface.js
//=====================
//== Database Interface (User Management)
//==
//== Default backend: SQLite (better-sqlite3) on local disk
//== API style: async methods (so swapping to Redis/Postgres later is painless)
//== Concurrency: serialized operations via Mutex (predictable + safe for concurrent callers)
//== Performance: WAL + prepared statements + transactions
//=====================

"use strict";

const path = require("path");

//=====================
//== Public Function Map
//==
//== const { createDb } = require("./db-interface");
//== const db = createDb({ filename: "./data/homehost.sqlite" });
//== await db.init();
//==
//== Core
//==   - db.init()
//==   - db.close()
//==   - db.healthcheck()
//==   - db.tx(fn)
//==
//== Users
//==   - db.users.create({ username, passwordHash, email?, displayName?, isActive? })
//==   - db.users.getById(userId)
//==   - db.users.getByUsername(username)
//==   - db.users.getByEmail(email)
//==   - db.users.list({ limit?, offset?, q? })
//==   - db.users.update(userId, { email?, displayName?, isActive? })
//==   - db.users.setPasswordHash(userId, passwordHash)
//==   - db.users.delete(userId)
//==
//== Locations
//==   - db.locations.create({ code, name })
//==   - db.locations.getById(locationId)
//==   - db.locations.getByCode(code)
//==   - db.locations.list()
//==   - db.locations.update(locationId, { code?, name? })
//==   - db.locations.delete(locationId)
//==
//== Roles
//==   - db.roles.create({ locationId, code, name })
//==   - db.roles.getById(roleId)
//==   - db.roles.getByLocationAndCode(locationId, code)
//==   - db.roles.listByLocation(locationId)
//==   - db.roles.update(roleId, { code?, name? })
//==   - db.roles.delete(roleId)
//==
//== Membership (joins)
//==   - db.membership.addUserToLocation(userId, locationId)     // idempotent
//==   - db.membership.removeUserFromLocation(userId, locationId)
//==   - db.membership.listUserLocations(userId)
//==   - db.membership.addUserRole(userId, roleId)              // idempotent
//==   - db.membership.removeUserRole(userId, roleId)
//==   - db.membership.listUserRoles(userId)
//==   - db.membership.getUserAccessSummary(userId)
//==
//== Seeding
//==   - db.seed.ensureSystemDefaults() // creates "system" location and "admin" role if missing
//=====================

//=====================
//== Dependency: better-sqlite3
//=====================

let BetterSqlite3;
try {
  BetterSqlite3 = require("better-sqlite3");
} catch {
  throw new Error("Missing dependency: better-sqlite3. Install with: npm i better-sqlite3");
}

//=====================
//== Simple Mutex (serialize async callers)
//==
//== Why:
//== - Node can call these DB methods concurrently (promises, routes, etc.)
//== - SQLite allows multiple readers but only one writer
//== - Serializing gives predictable behavior and avoids subtle interleavings
//=====================

class Mutex {
  constructor() {
    this._chain = Promise.resolve();
  }
  run(fn) {
    const next = this._chain.then(fn, fn);
    this._chain = next.catch(() => {});
    return next;
  }
}

//=====================
//== Errors (normalized)
//=====================

class DbError extends Error {
  constructor(code, message, meta) {
    super(message);
    this.name = "DbError";
    this.code = code;
    this.meta = meta;
  }
}

function mapSqliteError(err) {
  const msg = err?.message || String(err);

  if (msg.includes("UNIQUE constraint failed")) {
    return new DbError("CONFLICT", "Record already exists", { cause: msg });
  }
  if (msg.includes("FOREIGN KEY constraint failed")) {
    return new DbError("BAD_REFERENCE", "Invalid reference", { cause: msg });
  }
  return new DbError("DB_ERROR", "Database error", { cause: msg });
}

//=====================
//== Helpers
//=====================

function clampInt(n, min, max) {
  const x = (n | 0) || 0;
  return Math.max(min, Math.min(max, x));
}

function nowIso() {
  return new Date().toISOString();
}

// A readable ID generator (swap later for uuid if you prefer)
function newId(prefix) {
  const rnd = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString(
    "hex"
  );
  return `${prefix}_${rnd}`;
}

//=====================
//== Factory: createDb()
//=====================

/**
 * @typedef {Object} DbOptions
 * @property {string} [filename]        SQLite file path (default: ./data/app.sqlite)
 * @property {boolean} [readOnly]       Open DB read-only
 * @property {number} [busyTimeoutMs]   SQLite busy timeout (default 5000)
 * @property {boolean} [verbose]        Log SQL statements (dev only)
 */

function createDb(options = {}) {
  //=====================
  //== Config
  //=====================

  const opts = {
    filename: options.filename || path.resolve(process.cwd(), "data", "app.sqlite"),
    readOnly: !!options.readOnly,
    busyTimeoutMs: options.busyTimeoutMs ?? 5000,
    verbose: !!options.verbose,
  };

  const mutex = new Mutex();

  /** @type {import("better-sqlite3").Database | null} */
  let db = null;

  //=====================
  //== Prepared Statement Cache
  //=====================

  const stmts = new Map();

  function stmt(sql) {
    let s = stmts.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  }

  //=====================
  //== Connection Lifecycle
  //=====================

  function open() {
    if (db) return;

    db = new BetterSqlite3(opts.filename, {
      readonly: opts.readOnly,
      verbose: opts.verbose ? console.log : undefined,
    });

    // Good local defaults
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma(`busy_timeout = ${Math.max(0, opts.busyTimeoutMs | 0)}`);
    db.pragma("temp_store = MEMORY");
    db.pragma("cache_size = -20000"); // ~20MB page cache
  }

  function close() {
    if (!db) return;
    stmts.clear();
    db.close();
    db = null;
  }

  //=====================
  //== Schema / Migrations
  //=====================

  function ensureVersionTable() {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='__schema_version'`)
      .get();

    if (!exists) {
      db.prepare(
        `CREATE TABLE __schema_version (
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )`
      ).run();
      db.prepare(`INSERT INTO __schema_version(version, updated_at) VALUES(0, ?)`).run(nowIso());
    }
  }

  function getSchemaVersion() {
    const row = db.prepare(`SELECT version FROM __schema_version`).get();
    return row?.version ?? 0;
  }

  function setSchemaVersion(v) {
    db.prepare(`UPDATE __schema_version SET version=?, updated_at=?`).run(v, nowIso());
  }

  function migrate() {
    ensureVersionTable();

    let v = getSchemaVersion();

    //=====================
    //== Migration v1: core tables
    //=====================

    if (v < 1) {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          email TEXT UNIQUE,
          display_name TEXT,
          password_hash TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE locations (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE roles (
          id TEXT PRIMARY KEY,
          location_id TEXT NOT NULL,
          code TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(location_id, code),
          FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE CASCADE
        );

        CREATE TABLE user_locations (
          user_id TEXT NOT NULL,
          location_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(user_id, location_id),
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE CASCADE
        );

        CREATE TABLE user_roles (
          user_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(user_id, role_id),
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_users_username ON users(username);
        CREATE INDEX idx_users_email ON users(email);
        CREATE INDEX idx_roles_location_id ON roles(location_id);
        CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
        CREATE INDEX idx_user_roles_role_id ON user_roles(role_id);
        CREATE INDEX idx_user_locations_user_id ON user_locations(user_id);
        CREATE INDEX idx_user_locations_location_id ON user_locations(location_id);
      `);

      v = 1;
      setSchemaVersion(v);
    }
  }

  //=====================
  //== Seed helpers (safe to call repeatedly)
//=====================

  async function ensureSystemDefaults() {
    return mutex.run(async () => {
      open();

      const ts = nowIso();

      // "system" location
      const system = stmt(`SELECT id FROM locations WHERE code = ?`).get("system");
      let systemId = system?.id;

      if (!systemId) {
        systemId = newId("loc");
        stmt(
          `INSERT INTO locations(id, code, name, created_at, updated_at) VALUES(?,?,?,?,?)`
        ).run(systemId, "system", "System", ts, ts);
      }

      // "admin" role under "system"
      const admin = stmt(
        `SELECT id FROM roles WHERE location_id = ? AND code = ?`
      ).get(systemId, "admin");

      if (!admin?.id) {
        const adminId = newId("role");
        stmt(
          `INSERT INTO roles(id, location_id, code, name, created_at, updated_at) VALUES(?,?,?,?,?,?)`
        ).run(adminId, systemId, "admin", "Administrator", ts, ts);
      }

      return true;
    });
  }

  //=====================
  //== Public API (async + serialized)
//=====================

  const api = {
    //=====================
    //== Core
    //=====================

    async init() {
      return mutex.run(async () => {
        open();
        migrate();
      });
    },

    async close() {
      return mutex.run(async () => {
        close();
      });
    },

    async healthcheck() {
      return mutex.run(async () => {
        open();
        try {
          const row = db.prepare(`SELECT 1 as ok`).get();
          return row?.ok === 1;
        } catch (e) {
          return false;
        }
      });
    },

    async tx(fn) {
      return mutex.run(async () => {
        open();
        const wrapped = db.transaction(() => fn(api));
        try {
          return wrapped();
        } catch (e) {
          throw mapSqliteError(e);
        }
      });
    },

    seed: {
      ensureSystemDefaults,
    },

    //=====================
    //== Users
    //=====================

    users: {
      async create(input) {
        return mutex.run(async () => {
          open();
          const id = newId("usr");
          const ts = nowIso();

          try {
            stmt(
              `INSERT INTO users(id, username, email, display_name, password_hash, is_active, created_at, updated_at)
               VALUES(@id, @username, @email, @display_name, @password_hash, @is_active, @created_at, @updated_at)`
            ).run({
              id,
              username: input.username,
              email: input.email ?? null,
              display_name: input.displayName ?? null,
              password_hash: input.passwordHash,
              is_active: input.isActive === false ? 0 : 1,
              created_at: ts,
              updated_at: ts,
            });

            return api.users.getById(id);
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async getById(userId) {
        return mutex.run(async () => {
          open();

          const row = stmt(
            `SELECT id, username, email,
                    display_name as displayName,
                    password_hash as passwordHash,
                    is_active as isActive,
                    created_at as createdAt,
                    updated_at as updatedAt
             FROM users WHERE id = ?`
          ).get(userId);

          if (!row) return null;
          row.isActive = !!row.isActive;
          return row;
        });
      },

      async getByUsername(username) {
        return mutex.run(async () => {
          open();

          const row = stmt(
            `SELECT id, username, email,
                    display_name as displayName,
                    password_hash as passwordHash,
                    is_active as isActive,
                    created_at as createdAt,
                    updated_at as updatedAt
             FROM users WHERE username = ?`
          ).get(username);

          if (!row) return null;
          row.isActive = !!row.isActive;
          return row;
        });
      },

      async getByEmail(email) {
        return mutex.run(async () => {
          open();

          const row = stmt(
            `SELECT id, username, email,
                    display_name as displayName,
                    password_hash as passwordHash,
                    is_active as isActive,
                    created_at as createdAt,
                    updated_at as updatedAt
             FROM users WHERE email = ?`
          ).get(email);

          if (!row) return null;
          row.isActive = !!row.isActive;
          return row;
        });
      },

      async list(opts = {}) {
        return mutex.run(async () => {
          open();

          const limit = clampInt(opts.limit ?? 50, 1, 500);
          const offset = Math.max(0, (opts.offset ?? 0) | 0);

          // Optional simple search across username/email/display name
          if (opts.q && String(opts.q).trim()) {
            const q = `%${String(opts.q).trim()}%`;
            const rows = stmt(
              `SELECT id, username, email,
                      display_name as displayName,
                      is_active as isActive,
                      created_at as createdAt,
                      updated_at as updatedAt
               FROM users
               WHERE username LIKE ? OR email LIKE ? OR display_name LIKE ?
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?`
            ).all(q, q, q, limit, offset);

            for (const r of rows) r.isActive = !!r.isActive;
            return rows;
          }

          const rows = stmt(
            `SELECT id, username, email,
                    display_name as displayName,
                    is_active as isActive,
                    created_at as createdAt,
                    updated_at as updatedAt
             FROM users
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`
          ).all(limit, offset);

          for (const r of rows) r.isActive = !!r.isActive;
          return rows;
        });
      },

      async update(userId, patch) {
        return mutex.run(async () => {
          open();
          const ts = nowIso();

          try {
            const sets = [];
            const params = { userId, updated_at: ts };

            if ("email" in patch) {
              sets.push("email = @email");
              params.email = patch.email ?? null;
            }
            if ("displayName" in patch) {
              sets.push("display_name = @display_name");
              params.display_name = patch.displayName ?? null;
            }
            if ("isActive" in patch) {
              sets.push("is_active = @is_active");
              params.is_active = patch.isActive ? 1 : 0;
            }

            if (sets.length === 0) return api.users.getById(userId);

            const sql = `UPDATE users
                         SET ${sets.join(", ")}, updated_at = @updated_at
                         WHERE id = @userId`;

            stmt(sql).run(params);

            return api.users.getById(userId);
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async setPasswordHash(userId, passwordHash) {
        return mutex.run(async () => {
          open();
          const ts = nowIso();

          try {
            stmt(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(
              passwordHash,
              ts,
              userId
            );
            return true;
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async delete(userId) {
        return mutex.run(async () => {
          open();
          try {
            const info = stmt(`DELETE FROM users WHERE id = ?`).run(userId);
            return info.changes > 0;
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },
    },

    //=====================
    //== Locations
    //=====================

    locations: {
      async create(input) {
        return mutex.run(async () => {
          open();
          const id = newId("loc");
          const ts = nowIso();

          try {
            stmt(
              `INSERT INTO locations(id, code, name, created_at, updated_at)
               VALUES(?,?,?,?,?)`
            ).run(id, input.code, input.name, ts, ts);

            return api.locations.getById(id);
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async getById(locationId) {
        return mutex.run(async () => {
          open();
          return (
            stmt(
              `SELECT id, code, name,
                      created_at as createdAt,
                      updated_at as updatedAt
               FROM locations WHERE id = ?`
            ).get(locationId) || null
          );
        });
      },

      async getByCode(code) {
        return mutex.run(async () => {
          open();
          return (
            stmt(
              `SELECT id, code, name,
                      created_at as createdAt,
                      updated_at as updatedAt
               FROM locations WHERE code = ?`
            ).get(code) || null
          );
        });
      },

      async list() {
        return mutex.run(async () => {
          open();
          return stmt(
            `SELECT id, code, name,
                    created_at as createdAt,
                    updated_at as updatedAt
             FROM locations
             ORDER BY code ASC`
          ).all();
        });
      },

      async update(locationId, patch) {
        return mutex.run(async () => {
          open();
          const ts = nowIso();

          try {
            const sets = [];
            const params = { locationId, updated_at: ts };

            if ("code" in patch) {
              sets.push("code = @code");
              params.code = patch.code;
            }
            if ("name" in patch) {
              sets.push("name = @name");
              params.name = patch.name;
            }

            if (sets.length === 0) return api.locations.getById(locationId);

            const sql = `UPDATE locations
                         SET ${sets.join(", ")}, updated_at = @updated_at
                         WHERE id = @locationId`;

            stmt(sql).run(params);

            return api.locations.getById(locationId);
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async delete(locationId) {
        return mutex.run(async () => {
          open();
          try {
            const info = stmt(`DELETE FROM locations WHERE id = ?`).run(locationId);
            return info.changes > 0;
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },
    },

    //=====================
    //== Roles
    //=====================

    roles: {
      async create(input) {
        return mutex.run(async () => {
          open();
          const id = newId("role");
          const ts = nowIso();

          try {
            stmt(
              `INSERT INTO roles(id, location_id, code, name, created_at, updated_at)
               VALUES(?,?,?,?,?,?)`
            ).run(id, input.locationId, input.code, input.name, ts, ts);

            return api.roles.getById(id);
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async getById(roleId) {
        return mutex.run(async () => {
          open();
          return (
            stmt(
              `SELECT id,
                      location_id as locationId,
                      code, name,
                      created_at as createdAt,
                      updated_at as updatedAt
               FROM roles WHERE id = ?`
            ).get(roleId) || null
          );
        });
      },

      async getByLocationAndCode(locationId, code) {
        return mutex.run(async () => {
          open();
          return (
            stmt(
              `SELECT id,
                      location_id as locationId,
                      code, name,
                      created_at as createdAt,
                      updated_at as updatedAt
               FROM roles
               WHERE location_id = ? AND code = ?`
            ).get(locationId, code) || null
          );
        });
      },

      async listByLocation(locationId) {
        return mutex.run(async () => {
          open();
          return stmt(
            `SELECT id,
                    location_id as locationId,
                    code, name,
                    created_at as createdAt,
                    updated_at as updatedAt
             FROM roles
             WHERE location_id = ?
             ORDER BY code ASC`
          ).all(locationId);
        });
      },

      async update(roleId, patch) {
        return mutex.run(async () => {
          open();
          const ts = nowIso();

          try {
            const sets = [];
            const params = { roleId, updated_at: ts };

            if ("code" in patch) {
              sets.push("code = @code");
              params.code = patch.code;
            }
            if ("name" in patch) {
              sets.push("name = @name");
              params.name = patch.name;
            }

            if (sets.length === 0) return api.roles.getById(roleId);

            const sql = `UPDATE roles
                         SET ${sets.join(", ")}, updated_at = @updated_at
                         WHERE id = @roleId`;

            stmt(sql).run(params);

            return api.roles.getById(roleId);
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async delete(roleId) {
        return mutex.run(async () => {
          open();
          try {
            const info = stmt(`DELETE FROM roles WHERE id = ?`).run(roleId);
            return info.changes > 0;
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },
    },

    //=====================
    //== Membership (joins)
    //=====================

    membership: {
      async addUserToLocation(userId, locationId) {
        return api.tx(async () => {
          open();
          const ts = nowIso();

          try {
            stmt(
              `INSERT OR IGNORE INTO user_locations(user_id, location_id, created_at)
               VALUES(?,?,?)`
            ).run(userId, locationId, ts);

            return true;
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async removeUserFromLocation(userId, locationId) {
        return mutex.run(async () => {
          open();
          try {
            const info = stmt(
              `DELETE FROM user_locations WHERE user_id = ? AND location_id = ?`
            ).run(userId, locationId);

            return info.changes > 0;
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async listUserLocations(userId) {
        return mutex.run(async () => {
          open();
          return stmt(
            `SELECT l.id, l.code, l.name
             FROM user_locations ul
             JOIN locations l ON l.id = ul.location_id
             WHERE ul.user_id = ?
             ORDER BY l.code ASC`
          ).all(userId);
        });
      },

      async addUserRole(userId, roleId) {
        return api.tx(async () => {
          open();
          const ts = nowIso();

          try {
            stmt(
              `INSERT OR IGNORE INTO user_roles(user_id, role_id, created_at)
               VALUES(?,?,?)`
            ).run(userId, roleId, ts);

            return true;
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async removeUserRole(userId, roleId) {
        return mutex.run(async () => {
          open();
          try {
            const info = stmt(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`).run(
              userId,
              roleId
            );
            return info.changes > 0;
          } catch (e) {
            throw mapSqliteError(e);
          }
        });
      },

      async listUserRoles(userId) {
        return mutex.run(async () => {
          open();
          return stmt(
            `SELECT r.id, r.code, r.name, r.location_id as locationId
             FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = ?
             ORDER BY r.location_id ASC, r.code ASC`
          ).all(userId);
        });
      },

      async getUserAccessSummary(userId) {
        return mutex.run(async () => {
          open();

          const locations = await api.membership.listUserLocations(userId);
          const roles = await api.membership.listUserRoles(userId);

          const byLoc = new Map();
          for (const loc of locations) byLoc.set(loc.id, { ...loc, roles: [] });

          for (const role of roles) {
            if (!byLoc.has(role.locationId)) {
              byLoc.set(role.locationId, {
                id: role.locationId,
                code: null,
                name: null,
                roles: [],
              });
            }
            byLoc.get(role.locationId).roles.push({
              id: role.id,
              code: role.code,
              name: role.name,
            });
          }

          return Array.from(byLoc.values());
        });
      },
    },
  };

  return api;
}

//=====================
//== Module Exports
//=====================
const userDb = createDb( path.join(homehost.data, 'user-management.sqlite') )
module.exports = userDb;

