import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openOpcDatabase} from './db.js';
import {seedOpc} from './seed.js';
import {createRunner} from './runner.js';
import {createActions} from './actions.js';
import {createWorkflows} from './workflows.js';
import {createOpcHttp} from './api.js';

const here = dirname(fileURLToPath(import.meta.url));

export function readRedcoreState(dbPath) {
  try {
    if (!existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'").get();
    if (!table) { db.close(); return null; }
    const row = db.prepare('SELECT value FROM app_state WHERE id=1').get();
    db.close();
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

export function createOpcApp({dataDir, projectDir = resolve(here, '..'), dbPath = null, filesRoot = null, redcoreState = null, publicDir = null, autoStart = false, modelClient = null} = {}) {
  const resolvedDataDir = dataDir || resolve(projectDir, '.data');
  const opcDbPath = dbPath || process.env.OPC_DB_PATH || resolve(resolvedDataDir, 'application.sqlite');
  const db = openOpcDatabase(opcDbPath);
  const root = filesRoot || resolve(resolvedDataDir, 'opc-files');
  mkdirSync(root, {recursive:true});
  const state = redcoreState || readRedcoreState(opcDbPath);
  const counts = seedOpc(db, {projectDir, dataDir:resolvedDataDir, filesRoot:root, redcoreState:state});
  const runner = createRunner({db, filesRoot:root, dataDir:resolvedDataDir, ...(modelClient ? {modelClient} : {})});
  const actions = createActions({db, filesRoot:root});
  const workflows = createWorkflows({db, runner, actions, filesRoot:root});
  const http = createOpcHttp({db, runner, actions, workflows, filesRoot:root, dataDir:resolvedDataDir,
    publicDir:publicDir || resolve(projectDir, 'public'), projectDir});
  if (autoStart) runner.start();
  return {
    db, runner, actions, workflows, http, counts, dbPath:opcDbPath, filesRoot:root,
    handle:http.handle, seed:counts,
    start:() => runner.start(),
    stop:() => runner.stop(),
    close:() => { runner.stop(); db.close(); },
  };
}
