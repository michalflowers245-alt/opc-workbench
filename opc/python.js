import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';

const candidates = [
  process.env.OPC_PYTHON,
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
  'python3',
].filter(Boolean);

const cache = new Map();

export function pythonFor(moduleName) {
  if (cache.has(moduleName)) return cache.get(moduleName);
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import ' + moduleName], {encoding: 'utf8', timeout: 8000});
    if (probe.status === 0) {
      cache.set(moduleName, candidate);
      return candidate;
    }
  }
  cache.set(moduleName, null);
  return null;
}

export function runPython(moduleName, script, args = [], options = {}) {
  const python = pythonFor(moduleName);
  if (!python) return {ok: false, error: '未找到可用的 Python 运行时（缺少 ' + moduleName + '），可在 OPC_PYTHON 指定。', stdout: '', stderr: ''};
  const result = spawnSync(python, ['-c', script, ...args], {
    encoding: 'utf8', timeout: options.timeout || 120000, maxBuffer: 16 * 1024 * 1024,
    cwd: options.cwd, env: {...process.env, PYTHONIOENCODING: 'utf-8'},
  });
  if (result.status !== 0) {
    return {ok: false, error: (result.stderr || result.stdout || 'Python 执行失败').slice(0, 2000), stdout: result.stdout || '', stderr: result.stderr || ''};
  }
  return {ok: true, stdout: result.stdout || '', stderr: result.stderr || ''};
}
