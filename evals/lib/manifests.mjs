// Extract direct dependencies + lockfile-resolved versions from a repo snapshot.
// Supports: package.json + package-lock.json / npm-shrinkwrap.json / pnpm-lock.yaml / yarn.lock / bun.lock
//           pyproject.toml (PEP 621, dependency-groups, poetry) / requirements*.txt + uv.lock / poetry.lock
import fs from 'node:fs';
import path from 'node:path';
import { walk, readText, SKIP_DIRS } from './util.mjs';

export const SNAPSHOT_FILES = [
  /^package\.json$/, /^package-lock\.json$/, /^npm-shrinkwrap\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/,
  /^yarn\.lock$/, /^bun\.lockb?$/, /^\.npmrc$/, /^\.yarnrc\.yml$/, /^bunfig\.toml$/,
  /^pyproject\.toml$/, /^requirements[\w.-]*\.(txt|in)$/, /^uv\.lock$/, /^poetry\.lock$/, /^Pipfile(\.lock)?$/, /^setup\.cfg$/, /^uv\.toml$/, /^pip\.conf$/,
];
export const isSnapshotFile = (rel) => SNAPSHOT_FILES.some((re) => re.test(path.basename(rel)));

export const normPy = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * @returns {{deps: Dep[], lockfiles: string[], manifests: string[], localNames: Set<string>}}
 * Dep = {ecosystem, name, spec, dev, manifest, lockVersion, nonRegistry}
 */
export function extractDeps(root) {
  const files = [...walk(root, { maxDepth: 6 })].filter(isSnapshotFile);
  const deps = [];
  const lockfiles = files.filter((f) => /(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock)$/.test(f));
  const manifests = [];
  const localNames = new Set();
  const npmLocks = new Map(); // dir -> resolver(name, spec, manifestRelDir)
  const pyLocks = new Map(); // dir -> Map(normName -> version)

  for (const f of lockfiles) {
    const dir = path.dirname(f);
    const text = readText(path.join(root, f));
    if (text === null) continue;
    const b = path.basename(f);
    try {
      if (b === 'package-lock.json' || b === 'npm-shrinkwrap.json') npmLocks.set(dir, npmLockResolver(JSON.parse(text)));
      else if (b === 'pnpm-lock.yaml') npmLocks.set(dir, pnpmResolver(text));
      else if (b === 'yarn.lock') npmLocks.set(dir, yarnResolver(text));
      else if (b === 'bun.lock') npmLocks.set(dir, bunResolver(text));
      else if (b === 'uv.lock' || b === 'poetry.lock') pyLocks.set(dir, tomlPackages(text));
      else if (b === 'Pipfile.lock') {
        const j = JSON.parse(text); const m = new Map();
        for (const sec of ['default', 'develop']) for (const [n, v] of Object.entries(j[sec] || {})) if (v.version) m.set(normPy(n), v.version.replace(/^==/, ''));
        pyLocks.set(dir, m);
      }
    } catch { /* unparsable lockfile: ignore, deps fall back to manifest */ }
  }
  const nearest = (locks, dir) => {
    let d = dir;
    for (;;) {
      if (locks.has(d)) return { dir: d, lock: locks.get(d) };
      if (d === '.' || d === '' || d === path.dirname(d)) return null;
      d = path.dirname(d);
    }
  };

  for (const f of files) {
    const b = path.basename(f);
    const dir = path.dirname(f);
    const full = path.join(root, f);
    if (b === 'package.json') {
      let pj;
      try { pj = JSON.parse(readText(full)); } catch { continue; }
      manifests.push(f);
      if (pj.name) localNames.add(pj.name);
      const lk = nearest(npmLocks, dir);
      for (const [field, dev] of [['dependencies', false], ['devDependencies', true], ['optionalDependencies', false]]) {
        for (let [name, spec] of Object.entries(pj[field] || {})) {
          spec = String(spec);
          let regName = name;
          const alias = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.*))?$/.exec(spec);
          if (alias) { regName = alias[1]; spec = alias[2] || 'latest'; }
          const nonRegistry = /^(file:|link:|workspace:|portal:|git|github:|gitlab:|bitbucket:|https?:|\.{0,2}\/)/.test(spec) || (/\//.test(spec) && !spec.startsWith('@') && !/\s/.test(spec) && /^[\w-]+\/[\w.-]+/.test(spec));
          let lockVersion = null;
          if (lk && !nonRegistry) {
            const rel = path.relative(lk.dir === '.' ? '' : lk.dir, dir === '.' ? '' : dir) || '.';
            try { lockVersion = lk.lock(name, String(pj[field][name]), rel) || null; } catch { lockVersion = null; }
          }
          deps.push({ ecosystem: 'npm', name: regName, declaredAs: name, spec, dev, manifest: f, lockVersion, nonRegistry });
        }
      }
    } else if (b === 'pyproject.toml') {
      const reqs = pyprojectDeps(readText(full) || '');
      if (reqs.projectName) localNames.add(normPy(reqs.projectName));
      if (reqs.items.length || reqs.projectName) manifests.push(f);
      const lk = nearest(pyLocks, dir);
      for (const r of reqs.items) deps.push(pyDep(r, f, lk));
    } else if (/^requirements[\w.-]*\.(txt|in)$/.test(b)) {
      manifests.push(f);
      const lk = nearest(pyLocks, dir);
      const dev = /dev|test|lint/i.test(b);
      for (const line of (readText(full) || '').split(/\r?\n/)) {
        const r = parseRequirement(line);
        if (r) deps.push(pyDep({ ...r, dev }, f, lk));
      }
    }
  }
  // Drop deps on sibling workspace packages
  // A dependency on a package defined inside the project is a workspace link (npm and yarn link a
  // local package for any version range it satisfies, e.g. "@repo/lib": "1.0.0"), not a registry install.
  const filtered = deps.filter((d) => !(d.ecosystem === 'npm' && d.name === d.declaredAs && localNames.has(d.name)) && !(d.ecosystem === 'pypi' && localNames.has(normPy(d.name))));
  return { deps: filtered, lockfiles, manifests, localNames };
}

function pyDep(r, manifest, lk) {
  const lockVersion = lk ? lk.lock.get(normPy(r.name)) || null : null;
  return { ecosystem: 'pypi', name: normPy(r.name), declaredAs: r.name, spec: r.spec, dev: !!r.dev, manifest, lockVersion, nonRegistry: !!r.nonRegistry };
}

/** PEP 508 requirement line -> {name, spec, nonRegistry} | null */
export function parseRequirement(line) {
  line = line.replace(/\s+#.*$/, '').trim();
  if (!line || line.startsWith('#') || line.startsWith('-') || line.startsWith('--')) return null;
  if (/^(https?|git\+|file:)/.test(line) || line.startsWith('.') || line.startsWith('/')) return null;
  const at = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*@\s*(\S+)/.exec(line);
  if (at) return { name: at[1], spec: at[3], nonRegistry: true };
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*\(?([^;]*?)\)?\s*(;.*)?$/.exec(line);
  if (!m) return null;
  return { name: m[1], spec: m[3].replace(/\s+/g, '') };
}

// ---------------- pyproject (TOML subset) ----------------
export function pyprojectDeps(text) {
  const items = [];
  let projectName = null;
  let table = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\s+#.*$/, '');
    const h = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
    if (h) { table = h[1].replace(/["']/g, ''); continue; }
    const kv = /^\s*("?[A-Za-z0-9_.-]+"?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    let val = kv[2].trim();
    // gather multi-line arrays / inline tables
    if ((val.startsWith('[') && !balanced(val, '[', ']')) || (val.startsWith('{') && !balanced(val, '{', '}'))) {
      while (i + 1 < lines.length) { i++; val += ' ' + lines[i].replace(/\s+#.*$/, '').trim(); if (balanced(val, val[0], val[0] === '[' ? ']' : '}')) break; }
    }
    const strings = () => [...val.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    if (table === 'project' && key === 'name') projectName = strings()[0] || null;
    if (table === 'tool.poetry' && key === 'name' && !projectName) projectName = strings()[0] || null;
    if (table === 'project' && key === 'dependencies') {
      for (const s of strings()) { const r = parseRequirement(s); if (r) items.push(r); }
    } else if (table === 'project.optional-dependencies' || table === 'dependency-groups' || (table === 'tool.uv' && key === 'dev-dependencies')) {
      for (const s of strings()) { const r = parseRequirement(s); if (r) items.push({ ...r, dev: true }); }
    } else if (/^tool\.poetry\.((group\.[^.]+\.)?dependencies|dev-dependencies)$/.test(table)) {
      if (key.toLowerCase() === 'python') continue;
      const dev = table !== 'tool.poetry.dependencies';
      if (val.startsWith('{')) {
        if (/\b(git|path|url)\s*=/.test(val)) { items.push({ name: key, spec: '', dev, nonRegistry: true }); continue; }
        const vm = /version\s*=\s*["']([^"']*)["']/.exec(val);
        items.push({ name: key, spec: vm ? vm[1] : '', dev });
      } else items.push({ name: key, spec: strings()[0] ?? '', dev });
    }
  }
  return { items, projectName };
}
function balanced(s, o, c) {
  let d = 0, q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === o) d++;
    else if (ch === c) d--;
  }
  return d <= 0;
}

/** uv.lock / poetry.lock: [[package]] name/version pairs. */
export function tomlPackages(text) {
  const m = new Map();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const n = /^name\s*=\s*"([^"]+)"/m.exec(block);
    const v = /^version\s*=\s*"([^"]+)"/m.exec(block);
    if (/^source\s*=\s*\{\s*(editable|virtual)\s*=/m.test(block)) continue;
    if (n && v && !m.has(normPy(n[1]))) m.set(normPy(n[1]), v[1]);
  }
  return m;
}

// ---------------- npm lockfiles ----------------
function npmLockResolver(j) {
  return (name, _spec, rel) => {
    if (j.packages) {
      const keys = rel && rel !== '.' ? [`${rel}/node_modules/${name}`, `node_modules/${name}`] : [`node_modules/${name}`];
      for (const k of keys) if (j.packages[k]?.version) return j.packages[k].version;
    }
    return j.dependencies?.[name]?.version || null;
  };
}

function pnpmResolver(text) {
  // importer -> name -> version
  const importers = new Map();
  const lines = text.split(/\r?\n/);
  let base = -1, imp = null, inDeps = false, cur = null;
  const hasImporters = lines.some((l) => /^importers:\s*$/.test(l));
  if (!hasImporters) { base = -2; imp = '.'; importers.set('.', new Map()); }
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const ind = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (hasImporters) {
      if (ind === 0) { base = /^importers:/.test(line) ? 0 : -1; imp = null; continue; }
      if (base < 0) continue;
      if (ind === 2) { imp = line.replace(/:$/, '').replace(/^['"]|['"]$/g, ''); importers.set(imp, new Map()); inDeps = false; continue; }
      if (ind === 4) { inDeps = /^(dependencies|devDependencies|optionalDependencies):/.test(line); continue; }
      if (!inDeps || !imp) continue;
      if (ind === 6) { cur = line.replace(/:\s*.*$/, '').replace(/^['"]|['"]$/g, ''); const inl = /:\s*(\S+)$/.exec(line); if (inl) importers.get(imp).set(cur, inl[1]); continue; }
      if (ind === 8 && cur && line.startsWith('version:')) importers.get(imp).set(cur, line.slice(8).trim().replace(/^['"]|['"]$/g, ''));
    } else {
      // lockfile v5/v6 single project: top-level dependencies/devDependencies sections
      if (ind === 0) { inDeps = /^(dependencies|devDependencies|optionalDependencies):/.test(line); continue; }
      if (!inDeps) continue;
      if (ind === 2) { cur = line.replace(/:\s*.*$/, '').replace(/^['"]|['"]$/g, ''); const inl = /:\s*(\S+)$/.exec(line); if (inl) importers.get('.').set(cur, inl[1]); continue; }
      if (ind === 4 && cur && line.startsWith('version:')) importers.get('.').set(cur, line.slice(8).trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  return (name, _spec, rel) => {
    const v = importers.get(rel || '.')?.get(name) ?? importers.get('.')?.get(name);
    if (!v) return null;
    const clean = v.replace(/\(.*$/, '').replace(/^.*@(?=\d)/, '');
    return /^\d/.test(clean) ? clean : null;
  };
}

function yarnResolver(text) {
  const map = new Map(); // descriptor -> version
  let descs = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    if (!raw.startsWith(' ')) {
      descs = raw.replace(/:\s*$/, '').split(/,\s*/).map((d) => d.replace(/^"|"$/g, '').trim());
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(raw);
    if (m && descs) { for (const d of descs) map.set(d, m[1]); descs = null; }
  }
  return (name, spec) => map.get(`${name}@${spec}`) || map.get(`${name}@npm:${spec}`) || null;
}

function bunResolver(text) {
  const j = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  return (name) => {
    const e = j.packages?.[name];
    if (!Array.isArray(e) || typeof e[0] !== 'string') return null;
    const at = e[0].lastIndexOf('@');
    return at > 0 ? e[0].slice(at + 1) : null;
  };
}

// Agent-config dirs hold the installed guidance in guided arms; never snapshot them.
const SNAPSHOT_SKIP = new Set([...SKIP_DIRS, '.claude', '.agents', '.codex', '.cursor']);
export function copySnapshot(srcRoot, dstRoot) {
  const copied = [];
  for (const rel of walk(srcRoot, { maxDepth: 6, skip: SNAPSHOT_SKIP })) {
    if (!isSnapshotFile(rel)) continue;
    const dst = path.join(dstRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(srcRoot, rel), dst);
    copied.push(rel);
  }
  return copied;
}
