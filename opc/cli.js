import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, rmSync, statSync} from 'node:fs';
import {resolve, dirname, basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openOpcDatabase, all, one, nowIso} from './db.js';
import {seedOpc} from './seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function usage() {
  console.log('OPC 工作台维护 CLI');
  console.log('  node opc/cli.js verify [dataDir]');
  console.log('  node opc/cli.js backup <outputDir> [dataDir]');
  console.log('  node opc/cli.js restore <backupDir> --data-dir <newDataDir> [--force]');
  console.log('  node opc/cli.js seed [dataDir]');
  console.log('  node opc/cli.js status [dataDir]');
}

function dataDirOf(value) { return value ? resolve(value) : resolve(projectDir, '.data'); }

function counts(db) {
  return {
    projects: one(db, 'SELECT COUNT(*) AS n FROM opc_projects')?.n || 0,
    employees: one(db, 'SELECT COUNT(*) AS n FROM opc_employees')?.n || 0,
    bindings: one(db, "SELECT COUNT(*) AS n FROM opc_employee_skills WHERE relation='initial'")?.n || 0,
    skills: one(db, 'SELECT COUNT(*) AS n FROM opc_skills')?.n || 0,
    runs: one(db, 'SELECT COUNT(*) AS n FROM opc_runs')?.n || 0,
    artifacts: one(db, 'SELECT COUNT(*) AS n FROM opc_artifacts')?.n || 0,
    files: one(db, 'SELECT COUNT(*) AS n FROM opc_files')?.n || 0,
    actions: one(db, 'SELECT COUNT(*) AS n FROM opc_actions')?.n || 0,
  };
}

function verify(dataDir) {
  const dbPath = resolve(dataDir, 'application.sqlite');
  if (!existsSync(dbPath)) return {ok:false, error:'数据库不存在：' + dbPath};
  const db = new DatabaseSync(dbPath);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='opc_employees'").get();
  if (!table) { db.close(); return {ok:false, error:'缺少 OPC 表，尚未初始化'}; }
  const result = {ok: integrity?.integrity_check === 'ok', database:dbPath, schema:one(db, 'SELECT id,applied_at FROM opc_migrations ORDER BY applied_at DESC LIMIT 1'),
    counts:counts(db), demo:one(db, 'SELECT id,name,is_demo FROM opc_projects WHERE is_demo=1') || null,
    employeeSlugs:all(db, 'SELECT slug,mind_version,model_id FROM opc_employees ORDER BY created_at').map(row => row.slug),
    fileRoot:existsSync(resolve(dataDir, 'opc-files'))};
  db.close();
  return result;
}

function backup(outputDir, dataDir) {
  const dbPath = resolve(dataDir, 'application.sqlite');
  if (!existsSync(dbPath)) throw new Error('数据库不存在：' + dbPath);
  mkdirSync(outputDir, {recursive:true});
  const id = 'opc-backup-' + stamp();
  const targetDir = resolve(outputDir, id);
  mkdirSync(targetDir, {recursive:true});
  const targetDb = resolve(targetDir, 'application.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("VACUUM INTO '" + targetDb.replace(/'/g, "''") + "'");
  const countsBefore = counts(db);
  db.close();
  const filesRoot = resolve(dataDir, 'opc-files');
  if (existsSync(filesRoot)) cpSync(filesRoot, resolve(targetDir, 'opc-files'), {recursive:true});
  const manifest = {id, createdAt:nowIso(), database:'application.sqlite', databaseSha256:sha(targetDb),
    counts:countsBefore, files:existsSync(resolve(targetDir, 'opc-files')), source:dataDir};
  writeFileSync(resolve(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return {ok:true, backupDir:targetDir, manifest};
}

function restore(backupDir, targetDataDir, force = false) {
  const manifest = JSON.parse(readFileSync(resolve(backupDir, 'manifest.json'), 'utf8'));
  const sourceDb = resolve(backupDir, 'application.sqlite');
  if (!existsSync(sourceDb)) throw new Error('备份缺少数据库');
  if (sha(sourceDb) !== manifest.databaseSha256) throw new Error('备份数据库校验值不一致');
  const targetDb = resolve(targetDataDir, 'application.sqlite');
  if (existsSync(targetDb) && !force) throw new Error('目标数据库已存在；使用 --force 覆盖');
  mkdirSync(targetDataDir, {recursive:true});
  copyFileSync(sourceDb, targetDb);
  const sourceFiles = resolve(backupDir, 'opc-files');
  if (existsSync(sourceFiles)) cpSync(sourceFiles, resolve(targetDataDir, 'opc-files'), {recursive:true, force:true});
  const db = new DatabaseSync(targetDb);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  db.close();
  return {ok:integrity?.integrity_check === 'ok', targetDataDir, manifest, verify:verify(targetDataDir)};
}

const args = process.argv.slice(2);
const command = args[0];
try {
  if (!command || command === 'help') usage();
  else if (command === 'verify') console.log(JSON.stringify(verify(dataDirOf(args[1])), null, 2));
  else if (command === 'status') {
    const dataDir = dataDirOf(args[1]);
    const db = openOpcDatabase(resolve(dataDir, 'application.sqlite'));
    console.log(JSON.stringify({dataDir, counts:counts(db), demo:one(db, 'SELECT id,name FROM opc_projects WHERE is_demo=1'), running:one(db, "SELECT COUNT(*) AS n FROM opc_runs WHERE status IN ('queued','running')")?.n || 0}, null, 2));
    db.close();
  } else if (command === 'seed') {
    const dataDir = dataDirOf(args[1]);
    const db = openOpcDatabase(resolve(dataDir, 'application.sqlite'));
    const countsSeed = seedOpc(db, {projectDir, dataDir, filesRoot:resolve(dataDir, 'opc-files'), redcoreState:null});
    console.log(JSON.stringify({ok:true, counts:countsSeed}, null, 2));
    db.close();
  } else if (command === 'backup') {
    if (!args[1]) throw new Error('请提供备份输出目录');
    const result = backup(resolve(args[1]), dataDirOf(args[2]));
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'restore') {
    if (!args[1]) throw new Error('请提供备份目录');
    const index = args.indexOf('--data-dir');
    if (index < 0 || !args[index + 1]) throw new Error('请提供 --data-dir <新数据目录>');
    const result = restore(resolve(args[1]), resolve(args[index + 1]), args.includes('--force'));
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'selftest') {
    const temp = resolve(projectDir, '.data', 'opc-selftest-' + stamp());
    const source = resolve(temp, 'source');
    const target = resolve(temp, 'restore');
    mkdirSync(source, {recursive:true});
    const db = openOpcDatabase(resolve(source, 'application.sqlite'));
    seedOpc(db, {projectDir, dataDir:source, filesRoot:resolve(source, 'opc-files'), redcoreState:null});
    const before = counts(db);
    db.close();
    const backupResult = backup(resolve(temp, 'backups'), source);
    const restoreResult = restore(backupResult.backupDir, target, true);
    const result = {ok:restoreResult.ok && JSON.stringify(before) === JSON.stringify(restoreResult.verify.counts), before, restored:restoreResult.verify.counts, backupDir:backupResult.backupDir, target};
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (failure) {
  console.error(JSON.stringify({ok:false, error:failure.message}, null, 2));
  process.exitCode = 1;
}
