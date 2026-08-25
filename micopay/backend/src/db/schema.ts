import pg from "pg";
const { Pool } = pg;
import { config } from "../config.js";
import { randomUUID } from "crypto";

// ── In-memory store (fallback when PostgreSQL is unavailable) ─────────────
const mem: Record<string, any[]> = {
  users: [],
  wallets: [],
  trades: [],
  secret_access_log: [],
  audit_log: [],
  processed_tx: [],
  disputes: [],
  merchant_configs: [],
  user_devices: [],
  platform_risk_events: [],
  trade_messages: [],
  trade_disputes: [],
  compliance_alerts: [],
  compliance_filings: [],
  device_keys: [],
  sign_requests: [],
  trade_claim_tokens: [],
};

function memNow() {
  return new Date().toISOString();
}

/** Resolve a value token: $N → params[N-1], NOW() → timestamp, NULL → null, 'str' → str */
function resolveVal(token: string, params: any[]): any {
  const t = token.trim();
  const pMatch = t.match(/^\$(\d+)$/);
  if (pMatch) return params[parseInt(pMatch[1]) - 1];
  if (t.toUpperCase() === "NOW()") return memNow();
  if (t.toUpperCase() === "NULL") return null;
  if (t.toLowerCase() === "true") return true;
  if (t.toLowerCase() === "false") return false;
  const strMatch = t.match(/^'(.*)'$/s);
  if (strMatch) return strMatch[1];
  if (!isNaN(Number(t))) return Number(t);
  return t;
}

function colName(token: string) {
  return token.includes(".") ? token.split(".").pop()! : token;
}

function hasMatchingOuterParentheses(sql: string): boolean {
  if (!sql.startsWith("(") || !sql.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < sql.length - 1; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0) return false;
  }
  return depth === 1 && sql[sql.length - 1] === ")";
}

function evalCondition(row: any, clause: string, params: any[]): boolean {
  // Remove matching outer parentheses
  let trimmed = clause.trim();
  while (hasMatchingOuterParentheses(trimmed)) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // Try OR split (lowest precedence)
  const orParts = splitByKeyword(trimmed, "OR");
  if (orParts.length > 1)
    return orParts.some((p) => evalCondition(row, p, params));

  // Try AND split
  const andParts = splitByKeyword(trimmed, "AND");
  if (andParts.length > 1)
    return andParts.every((p) => evalCondition(row, p, params));

  // IN clause
  const inMatch = trimmed.match(/^([\w.]+)\s+IN\s*\(([^)]+)\)$/i);
  if (inMatch) {
    const col = colName(inMatch[1]);
    const vals = inMatch[2]
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""));
    return vals.includes(String(row[col]));
  }

  // IS NULL / IS NOT NULL
  const nullMatch = trimmed.match(/^([\w.]+)\s+IS\s+(NOT\s+)?NULL$/i);
  if (nullMatch) {
    const col = colName(nullMatch[1]);
    const isNot = Boolean(nullMatch[2]);
    return isNot
      ? row[col] !== null && row[col] !== undefined
      : row[col] === null || row[col] === undefined;
  }

  // Equality
  const eqMatch = trimmed.match(/^([\w.]+)\s*=\s*(.+)$/i);
  if (eqMatch) {
    const col = colName(eqMatch[1]);
    return row[col] === resolveVal(eqMatch[2], params);
  }

  return true;
}

/** Split SQL by keyword (AND/OR) respecting parentheses */
function splitByKeyword(sql: string, kw: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    start = 0;
  const re = new RegExp(`\\b${kw}\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const before = sql.slice(start, m.index);
    for (const ch of before) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth === 0) {
      parts.push(before.trim());
      start = m.index + kw.length;
    }
  }
  parts.push(sql.slice(start).trim());
  return parts.length > 1 ? parts : [sql.trim()];
}

function memQuery(sql: string, params: any[] = []): any[] {
  const s = sql.trim().replace(/\s+/g, " ");
  const upper = s.toUpperCase();

  // ── SELECT ──────────────────────────────────────────────────────────────
  if (upper.startsWith("SELECT")) {
    const fromMatch = s.match(/\bFROM\s+([\w]+)(?:\s+\w+)?/i);
    if (!fromMatch) return [];
    const tableName = fromMatch[1].toLowerCase();
    let rows = [...(mem[tableName] ?? [])];

    // LEFT JOIN (only handles wallets join for users)
    const joinMatch = s.match(
      /LEFT JOIN\s+(\w+)\s+(\w+)\s+ON\s+([\w.]+)\s*=\s*([\w.]+)/i,
    );
    if (joinMatch) {
      const joinTable = joinMatch[1].toLowerCase();
      const onLeft = colName(joinMatch[3]);
      const onRight = colName(joinMatch[4]);
      rows = rows.map((row) => {
        const jRow = (mem[joinTable] ?? []).find(
          (j) => j[onLeft] === row[onRight] || j[onRight] === row[onLeft],
        );
        return { ...row, wallet_type: jRow?.wallet_type ?? null };
      });
    }

    // WHERE
    const whereMatch = s.match(
      /\bWHERE\b\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i,
    );
    if (whereMatch) {
      rows = rows.filter((row) => evalCondition(row, whereMatch[1], params));
    }

    // ORDER BY
    const orderMatch = s.match(/ORDER BY\s+([\w.]+)\s+(ASC|DESC)/i);
    if (orderMatch) {
      const col = colName(orderMatch[1]);
      const dir = orderMatch[2].toUpperCase() === "DESC" ? -1 : 1;
      rows.sort((a, b) => (a[col] < b[col] ? -dir : a[col] > b[col] ? dir : 0));
    }

    // LIMIT
    const limitMatch = s.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1]));

    return rows;
  }

  // ── INSERT ───────────────────────────────────────────────────────────────
  if (upper.startsWith("INSERT INTO")) {
    const tableMatch = s.match(
      /INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
    );
    if (!tableMatch) return [];
    const tableName = tableMatch[1].toLowerCase();
    const cols = tableMatch[2].split(",").map((c) => c.trim());
    const vals = tableMatch[3].split(",").map((v) => v.trim());

    const newRow: any = { id: randomUUID(), created_at: memNow() };
    cols.forEach((col, i) => {
      newRow[col] = resolveVal(vals[i], params);
    });

    if (!mem[tableName]) mem[tableName] = [];
    mem[tableName].push(newRow);

    // RETURNING
    const retMatch = s.match(/RETURNING\s+(.+)$/i);
    if (retMatch) {
      const spec = retMatch[1].trim();
      if (spec === "*") return [newRow];
      const retCols = spec.split(",").map((c) => c.trim());
      const partial: any = {};
      retCols.forEach((c) => {
        partial[c] = newRow[c];
      });
      return [partial];
    }
    return [];
  }

  // ── UPDATE ───────────────────────────────────────────────────────────────
  if (upper.startsWith("UPDATE")) {
    const tableMatch = s.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
    if (!tableMatch) return [];
    const tableName = tableMatch[1].toLowerCase();

    if (["platform_risk_events", "compliance_alerts", "compliance_filings"].includes(tableName)) {
      throw new Error("Updates and deletions are not allowed on this table (append-only compliance data).");
    }
    const setStr = tableMatch[2];
    const whereStr = tableMatch[3];

    const updates: Record<string, any> = {};
    const setPairs = setStr.split(/,\s*(?=\w+\s*=)/);
    for (const pair of setPairs) {
      const m = pair.trim().match(/^(\w+)\s*=\s*(.+)$/i);
      if (m) updates[m[1].trim()] = resolveVal(m[2].trim(), params);
    }

    const rows = (mem[tableName] ?? []).filter((row) =>
      evalCondition(row, whereStr, params),
    );
    rows.forEach((row) => Object.assign(row, updates));
    return [];
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (upper.startsWith("DELETE")) {
    const tableMatch = s.match(/DELETE FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
    if (!tableMatch) return [];
    const tableName = tableMatch[1].toLowerCase();

    if (["platform_risk_events", "compliance_alerts", "compliance_filings"].includes(tableName)) {
      throw new Error("Updates and deletions are not allowed on this table (append-only compliance data).");
    }
    const whereStr = tableMatch[2];

    if (!whereStr) {
      mem[tableName] = [];
    } else {
      mem[tableName] = (mem[tableName] ?? []).filter(
        (row) => !evalCondition(row, whereStr, params)
      );
    }
    return [];
  }

  return [];
}

// ── Try PostgreSQL; fall back to in-memory ────────────────────────────────
let pgPool: InstanceType<typeof Pool> | null = null;
let pgAvailable = false;

async function initPg() {
  // Render's managed Postgres (and most managed providers) can take several
  // seconds for the first TLS+auth handshake after the service boots. A short
  // 2s timeout spuriously fails that first connect and drops us to the
  // in-memory store. Use a production-grade timeout and retry the initial
  // connection a few times with backoff before giving up.
  const CONNECT_TIMEOUT_MS = 15_000;
  const MAX_ATTEMPTS = 5;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let p: InstanceType<typeof Pool> | null = null;
    try {
      p = new Pool({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        // Keep idle TCP connections alive so a sleeping NAT/proxy doesn't drop them.
        keepAlive: true,
        max: 10,
      });
      await p.query("SELECT 1");

      // Don't let an async pool error (idle disconnect, DB restart) crash the
      // process — log it and let the next query re-establish a connection.
      p.on("error", (err) => {
        console.error("⚠️  PostgreSQL pool error (will reconnect on next query):", err.message);
      });

      pgPool = p;
      pgAvailable = true;
      console.log(`✅ PostgreSQL connected (attempt ${attempt}/${MAX_ATTEMPTS})`);
      return;
    } catch (err) {
      lastErr = err;
      if (p) await p.end().catch(() => {});
      console.warn(
        `⏳ PostgreSQL connect attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err instanceof Error ? err.message : err}`,
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt * 2000)); // 2s, 4s, 6s, 8s
      }
    }
  }

  // B-3: never fall back to the ephemeral in-memory store in production
  // unless explicitly opted in. A silent fallback would serve/lose real
  // user data on a volatile store, so fail fast instead.
  if (config.isProduction && !config.allowInMemoryDb) {
    console.error(
      "❌ PostgreSQL unavailable in production after retries and ALLOW_IN_MEMORY_DB is not set — " +
        "refusing to start on an ephemeral in-memory store. Exiting.",
      lastErr instanceof Error ? lastErr.message : lastErr,
    );
    process.exit(1);
  }
  pgAvailable = false;
  console.warn(
    "⚠️  PostgreSQL unavailable — using in-memory store (data resets on restart)",
  );
}

await initPg();

export const pool = pgPool;

/**
 * B-7: live readiness check. Returns true only when a real PostgreSQL
 * round-trip (`SELECT 1`) succeeds. Returns false on the in-memory fallback
 * or when the pool has gone away — so it can back a real readiness probe.
 */
export async function pingDb(): Promise<boolean> {
  if (!pgAvailable || !pgPool) return false;
  try {
    await pgPool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function query(text: string, params?: any[]) {
  if (pgAvailable && pgPool) return pgPool.query(text, params);
  return { rows: memQuery(text, params ?? []) };
}

export async function getOne<T = any>(
  text: string,
  params?: any[],
): Promise<T | null> {
  if (pgAvailable && pgPool) {
    const r = await pgPool.query(text, params);
    return r.rows[0] ?? null;
  }
  return (memQuery(text, params ?? [])[0] as T) ?? null;
}

export async function getMany<T = any>(
  text: string,
  params?: any[],
): Promise<T[]> {
  if (pgAvailable && pgPool) {
    const r = await pgPool.query(text, params);
    return r.rows;
  }
  return memQuery(text, params ?? []) as T[];
}

export async function execute(text: string, params?: any[]) {
  if (pgAvailable && pgPool) return pgPool.query(text, params);
  memQuery(text, params ?? []);
  return { rows: [] };
}

/**
 * INSERT a row only if the PK does not already exist.
 *
 * For PostgreSQL: wraps the caller's SQL in ON CONFLICT (pk_col) DO NOTHING
 * and returns the first RETURNING row, or null if the row already existed.
 *
 * For the in-memory fallback: checks the pk_col value in the store first;
 * if a matching row already exists the insert is skipped and null is returned.
 *
 * @param text   INSERT … RETURNING * statement (no ON CONFLICT clause needed)
 * @param params Positional parameters
 * @param pkCol  Primary-key column name (used to detect duplicates, default 'tx_hash')
 */
export async function insertUnique<T = any>(
  text: string,
  params: any[],
  pkCol = 'tx_hash',
): Promise<T | null> {
  if (pgAvailable && pgPool) {
    // Inject ON CONFLICT … DO NOTHING before the RETURNING clause
    const conflictSql = text.replace(
      /(\s+RETURNING)/i,
      ` ON CONFLICT (${pkCol}) DO NOTHING$1`,
    );
    const r = await pgPool.query(conflictSql, params);
    return (r.rows[0] as T) ?? null;
  }

  // In-memory path: derive table name and check for existing pk value
  const tableMatch = text.match(/INSERT INTO\s+(\w+)\s*\(/i);
  if (!tableMatch) return null;
  const tableName = tableMatch[1].toLowerCase();

  // Find which positional param corresponds to the pk column
  const colsMatch = text.match(/INSERT INTO\s+\w+\s*\(([^)]+)\)/i);
  if (!colsMatch) return null;
  const cols = colsMatch[1].split(',').map((c) => c.trim());
  const valsMatch = text.match(/VALUES\s*\(([^)]+)\)/i);
  if (!valsMatch) return null;
  const vals = valsMatch[1].split(',').map((v) => v.trim());

  const pkIdx = cols.indexOf(pkCol);
  if (pkIdx === -1) return null;
  const pkValue = resolveVal(vals[pkIdx], params);

  // Conflict check
  if ((mem[tableName] ?? []).some((r) => r[pkCol] === pkValue)) return null;

  // No conflict — perform the normal insert
  const rows = memQuery(text, params);
  return (rows[0] as T) ?? null;
}

export default { pool, query, getOne, getMany, execute, insertUnique, pingDb };
