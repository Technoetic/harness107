import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function physicalWorkspace(root) {
  const path = resolve(root);
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error('Workspace must be a physical directory');
  return realpath(path);
}

export async function safePath(root, name, { createParents = false } = {}) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) throw new Error('Invalid relative evidence path');
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Evidence path escapes workspace');
  let current = root;
  const parts = name.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (i === parts.length - 1) break;
      if (!createParents) throw error;
      try { await mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) || (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1))) throw new Error('Evidence must use physical directories and an unaliased regular file');
    const canonical = await realpath(current);
    if ((process.platform === 'win32' ? canonical.toLowerCase() !== current.toLowerCase() : canonical !== current)) throw new Error('Evidence path has an alias');
  }
  return target;
}

export async function readSafe(root, name, limit = 8 * 1024 * 1024) {
  const path = await safePath(root, name);
  const before = await lstat(path, { bigint: true });
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit) || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('Evidence changed or exceeds size limit');
    const bytes = await handle.readFile();
    await safePath(root, name);
    const after = await lstat(path, { bigint: true });
    if (bytes.length !== Number(stat.size) || ['ino','dev','size','mtimeNs','ctimeNs'].some(k => stat[k] !== after[k])) throw new Error('Evidence changed during reading');
    return bytes;
  } finally { await handle.close(); }
}

export async function writeSafe(root, name, bytes) {
  const target = await safePath(root, name, { createParents: true });
  const tempName = `${name}.${randomUUID()}.tmp`;
  const temporary = await safePath(root, tempName);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await safePath(root, name); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => {}); }
}

// Generated evidence and tool dependencies are deliberately not source inputs.
const EXCLUDED = new Set(['.git', '.harness50-quality-tools', 'node_modules', 'step_archive', 'coverage', '.cache', 'test-results', 'playwright-report']);
export async function sourceFingerprint(root) {
  const hash = createHash('sha256');
  let files = 0, size = 0;
  async function visit(dir, prefix = '') {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name)) continue;
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Source fingerprint refuses linked inputs');
      if (entry.isDirectory()) await visit(join(dir, entry.name), `${name}/`);
      else if (entry.isFile()) {
        const bytes = await readSafe(root, name);
        size += bytes.length;
        if (++files > 10000 || size > 128 * 1024 * 1024) throw new Error('Source fingerprint limit exceeded');
        hash.update(JSON.stringify([name, sha256(bytes)]));
      } else throw new Error('Unsupported source input');
    }
  }
  await visit(root);
  return { sha256: hash.digest('hex'), files };
}
