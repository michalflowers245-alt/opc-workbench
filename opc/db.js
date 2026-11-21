import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const newId = (prefix = 'id') => prefix + '_' + randomUUID();
export const json = (value) => JSON.stringify(value ?? null);
export const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function openOpcDatabase(dbPath) {
  mkdirSync(dirname(dbPath), {recursive: true});
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opc_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS opc_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS opc_operator (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, redcore_user_id TEXT, redcore_company_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_sessions (
      id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_projects (
      id TEXT PRIMARY KEY, seed_key TEXT UNIQUE, name TEXT NOT NULL, description TEXT, platform TEXT NOT NULL DEFAULT '拼多多',
      category TEXT, audience TEXT, price_min_cents INTEGER, price_max_cents INTEGER, budget_cents INTEGER,
      fulfillment TEXT, constraints TEXT, status TEXT NOT NULL DEFAULT 'active', is_demo INTEGER NOT NULL DEFAULT 0,
      redcore_company_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_stores (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL, shop_ref TEXT,
      authorization_status TEXT NOT NULL DEFAULT 'not_configured', facts_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_products (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, store_id TEXT, name TEXT NOT NULL, category TEXT,
      status TEXT NOT NULL DEFAULT 'candidate', platform TEXT NOT NULL DEFAULT '拼多多', description TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_skus (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, project_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
      specs_json TEXT, price_cents INTEGER NOT NULL, cost_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL DEFAULT 0,
      packaging_cents INTEGER NOT NULL DEFAULT 0, platform_fee_bps INTEGER NOT NULL DEFAULT 600,
      platform_fee_rounding TEXT NOT NULL DEFAULT '四舍五入到分', refund_cents INTEGER NOT NULL DEFAULT 0,
      ad_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0,
      stock INTEGER, supplier_id TEXT, quote_id TEXT, status TEXT NOT NULL DEFAULT 'draft', evidence_json TEXT,
      effective_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_suppliers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, shop_url TEXT, location TEXT, qualifications TEXT, moq INTEGER,
      lead_time_hours INTEGER, dropship INTEGER, rating TEXT, source TEXT, evidence_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_quotes (
      id TEXT PRIMARY KEY, supplier_id TEXT, product_id TEXT, sku_id TEXT, item_id TEXT, sku_ref TEXT, spec_text TEXT,
      qty_min INTEGER, qty_max INTEGER, unit_price_cents INTEGER, shipping_cents INTEGER, dropship INTEGER,
      retrieved_at TEXT, source TEXT, source_url TEXT, verification_status TEXT NOT NULL DEFAULT 'pending',
      raw_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_reports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, store_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
      period_start TEXT, period_end TEXT, channel TEXT, source_file_id TEXT, import_batch TEXT,
      status TEXT NOT NULL DEFAULT 'valid', metric_definitions_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_report_rows (
      id TEXT PRIMARY KEY, report_id TEXT NOT NULL, row_no INTEGER, date TEXT, plan TEXT, channel TEXT,
      impressions INTEGER, clicks INTEGER, orders INTEGER, revenue_cents INTEGER, ad_spend_cents INTEGER, visitors INTEGER,
      errors_json TEXT, warnings_json TEXT, status TEXT NOT NULL DEFAULT 'valid'
    );
    CREATE TABLE IF NOT EXISTS opc_knowledge (
      id TEXT PRIMARY KEY, project_id TEXT, sku_id TEXT, scope TEXT NOT NULL DEFAULT 'project', kind TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, source TEXT, source_url TEXT,
      verification_status TEXT NOT NULL DEFAULT 'pending', effective_from TEXT, effective_to TEXT,
      last_verified_at TEXT, created_by TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_tickets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sku_id TEXT, order_ref TEXT, type TEXT NOT NULL,
      severity TEXT, emotion TEXT, status TEXT NOT NULL DEFAULT 'open', owner_employee_id TEXT,
      original_message TEXT, evidence_json TEXT, pending_facts_json TEXT, reply_draft TEXT,
      resolution TEXT, receipt_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_employees (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, role_key TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT, color TEXT,
      description TEXT, mind_version TEXT NOT NULL, model_id TEXT, status TEXT NOT NULL DEFAULT 'active',
      context_rounds INTEGER NOT NULL DEFAULT 20, tool_limit INTEGER NOT NULL DEFAULT 8, timeout_ms INTEGER NOT NULL DEFAULT 180000,
      daily_token_limit INTEGER NOT NULL DEFAULT 200000, permissions_json TEXT, redcore_agent_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_employee_minds (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, version TEXT NOT NULL, runtime_text TEXT NOT NULL,
      source TEXT, source_text TEXT, created_at TEXT NOT NULL, created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS opc_skills (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT, version TEXT, source TEXT, source_url TEXT,
      package_path TEXT, install_status TEXT NOT NULL DEFAULT 'catalog_only', files_count INTEGER,
      manifest_json TEXT, verified_at TEXT, runtime_loaded INTEGER NOT NULL DEFAULT 0, last_trial_at TEXT,
      last_trial_status TEXT, origin TEXT, is_supplement INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_employee_skills (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, skill_id TEXT NOT NULL, binding_index INTEGER,
      label TEXT, relation TEXT NOT NULL DEFAULT 'initial', status TEXT NOT NULL DEFAULT 'registered',
      last_run_id TEXT, created_at TEXT NOT NULL, UNIQUE(employee_id, skill_id, relation)
    );
    CREATE TABLE IF NOT EXISTS opc_tool_grants (
      employee_id TEXT NOT NULL, tool_key TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'L1',
      enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(employee_id, tool_key)
    );
    CREATE TABLE IF NOT EXISTS opc_model_configs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT, model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, last_test_at TEXT,
      last_test_status TEXT, last_test_detail TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_connections (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'not_configured',
      config_json TEXT, last_test_at TEXT, last_test_status TEXT, last_test_detail TEXT, last_receipt_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, employee_id TEXT, sku_id TEXT, ticket_id TEXT,
      workflow_id TEXT, workflow_step_id TEXT, dedupe_key TEXT UNIQUE, mode TEXT NOT NULL DEFAULT 'employee',
      status TEXT NOT NULL DEFAULT 'queued', input_json TEXT, context_json TEXT, output_json TEXT,
      raw_model_output TEXT, error_code TEXT, error_message TEXT, model_id TEXT, provider TEXT, provider_model TEXT,
      mind_version TEXT, skills_json TEXT, tool_grants_json TEXT, upstream_json TEXT, tool_calls INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER, tokens_out INTEGER, first_token_ms INTEGER, duration_ms INTEGER, started_at TEXT,
      finished_at TEXT, lease_owner TEXT, lease_until INTEGER, heartbeat_at TEXT, attempt INTEGER NOT NULL DEFAULT 0,
      recoverable INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_run_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', input_json TEXT, output_json TEXT, error TEXT,
      started_at TEXT, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS opc_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_artifacts (
      id TEXT PRIMARY KEY, lineage_key TEXT NOT NULL, project_id TEXT NOT NULL, sku_id TEXT, run_id TEXT,
      kind TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      content_type TEXT NOT NULL DEFAULT 'text/markdown', content TEXT, file_id TEXT, evidence_json TEXT, created_at TEXT NOT NULL,
      UNIQUE(lineage_key, version)
    );
    CREATE TABLE IF NOT EXISTS opc_tool_receipts (
      id TEXT PRIMARY KEY, run_id TEXT, employee_id TEXT, tool_key TEXT NOT NULL, request_json TEXT, response_json TEXT,
      status TEXT NOT NULL, environment TEXT NOT NULL DEFAULT 'local', duration_ms INTEGER, receipt_id TEXT,
      error TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_actions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sku_id TEXT, run_id TEXT, kind TEXT NOT NULL,
      object_type TEXT, object_id TEXT, title TEXT NOT NULL, payload_json TEXT, amount_cents INTEGER,
      business_impact TEXT, evidence_json TEXT, version INTEGER NOT NULL DEFAULT 1, payload_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT, decision_note TEXT,
      expires_at TEXT, dedupe_key TEXT UNIQUE, receipt_json TEXT, executed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_audit (
      id TEXT PRIMARY KEY, project_id TEXT, actor TEXT, action TEXT NOT NULL, object_type TEXT, object_id TEXT,
      detail_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_files (
      id TEXT PRIMARY KEY, project_id TEXT, sku_id TEXT, run_id TEXT, name TEXT NOT NULL, mime TEXT, size INTEGER,
      sha256 TEXT, storage_path TEXT NOT NULL, access_scope TEXT NOT NULL DEFAULT 'project', source TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_handoffs (
      id TEXT PRIMARY KEY, workflow_id TEXT, from_run_id TEXT, to_run_id TEXT, from_employee_id TEXT, to_employee_id TEXT,
      handoff_key TEXT, payload_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_workflows (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', current_step INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_workflow_steps (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
      employee_id TEXT, status TEXT NOT NULL DEFAULT 'pending', run_id TEXT, depends_on TEXT, artifact_ref TEXT, note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workflow_id, key)
    );
    CREATE TABLE IF NOT EXISTS opc_daily_usage (
      employee_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(employee_id, day)
    );
    CREATE TABLE IF NOT EXISTS opc_import_batches (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, report_id TEXT, file_id TEXT, sha256 TEXT, mapping_json TEXT,
      rows_total INTEGER, rows_valid INTEGER, rows_invalid INTEGER, status TEXT NOT NULL DEFAULT 'preview', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_opc_runs_status ON opc_runs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_opc_runs_project ON opc_runs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_opc_events_run ON opc_run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_opc_artifacts_project ON opc_artifacts(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_opc_knowledge_project ON opc_knowledge(project_id, sku_id);
    CREATE INDEX IF NOT EXISTS idx_opc_tickets_project ON opc_tickets(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_opc_actions_project ON opc_actions(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_opc_files_project ON opc_files(project_id, created_at);
  `);
  const version = 'opc-schema-1';
  const existing = db.prepare('SELECT id FROM opc_migrations WHERE id=?').get(version);
  if (!existing) db.prepare('INSERT INTO opc_migrations(id, applied_at) VALUES(?,?)').run(version, nowIso());
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (failure) {
    try { db.exec('ROLLBACK'); } catch {}
    throw failure;
  }
}

export function insert(db, table, row) {
  const keys = Object.keys(row);
  const placeholders = keys.map(() => '?').join(',');
  const values = keys.map(key => row[key] === undefined ? null : row[key]);
  db.prepare('INSERT INTO ' + table + ' (' + keys.join(',') + ') VALUES (' + placeholders + ')').run(...values);
  return row;
}

export function insertIgnore(db, table, row) {
  const keys = Object.keys(row);
  const placeholders = keys.map(() => '?').join(',');
  const values = keys.map(key => row[key] === undefined ? null : row[key]);
  db.prepare('INSERT OR IGNORE INTO ' + table + ' (' + keys.join(',') + ') VALUES (' + placeholders + ')').run(...values);
  return row;
}

export function update(db, table, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const values = keys.map(key => patch[key] === undefined ? null : patch[key]);
  db.prepare('UPDATE ' + table + ' SET ' + keys.map(key => key + '=?').join(',') + ' WHERE id=?').run(...values, id);
}

export function one(db, sql, ...params) {
  return db.prepare(sql).get(...params) || null;
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function audit(db, {projectId = null, actor = '本机经营者', action, objectType = null, objectId = null, detail = null}) {
  insert(db, 'opc_audit', {
    id: newId('audit'), project_id: projectId, actor, action, object_type: objectType, object_id: objectId,
    detail_json: detail === null ? null : json(detail), created_at: nowIso(),
  });
}

export function logRunEvent(db, runId, type, payload = null) {
  const result = db.prepare('INSERT INTO opc_run_events(run_id,type,payload_json,created_at) VALUES(?,?,?,?)')
    .run(runId, type, payload === null ? null : json(payload), nowIso());
  return Number(result.lastInsertRowid);
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO opc_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, typeof value === 'string' ? value : json(value));
}

export function getMeta(db, key, fallback = null) {
  const row = one(db, 'SELECT value FROM opc_meta WHERE key=?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
