// Public-data clients used by the scorer: npm registry, PyPI JSON API, OSV.dev, e18e module-replacements.
// Nothing here imports package-guidance code. Results are cached in memory and can be persisted
// to a "registry snapshot" file so a scoring pass can be reproduced later.
import fs from 'node:fs';
import { fetchRetry, pool, readJSON, writeJSON } from './util.mjs';

const NPM = process.env.EVAL_NPM_REGISTRY || 'https://registry.npmjs.org';
const PYPI = process.env.EVAL_PYPI || 'https://pypi.org/pypi';
const OSV = process.env.EVAL_OSV || 'https://api.osv.dev';

export class PublicData {
  /** load=false: always fetch live, but still write the snapshot for later audit/re-scoring. */
  constructor({ snapshotPath = null, offline = false, load = false } = {}) {
    this.snapshotPath = snapshotPath;
    this.offline = offline;
    const snap = load && snapshotPath && fs.existsSync(snapshotPath) ? readJSON(snapshotPath, {}) : {};
    this.pkgs = new Map(Object.entries(snap.packages || {}));
    this.vulns = new Map(Object.entries(snap.vulns || {}));
    this.osvQueries = new Map(Object.entries(snap.osvQueries || {}));
    this.e18e = snap.e18e || null;
    this.fetchedAt = snap.fetchedAt || null;
  }
  save() {
    if (!this.snapshotPath) return;
    writeJSON(this.snapshotPath, {
      fetchedAt: this.fetchedAt || new Date().toISOString(),
      note: 'Compact copy of public registry/OSV data used for scoring. Re-score offline with --registry-snapshot <this file> --offline.',
      packages: Object.fromEntries(this.pkgs), vulns: Object.fromEntries(this.vulns), osvQueries: Object.fromEntries(this.osvQueries), e18e: this.e18e,
    });
  }

  /**
   * Compact package record:
   * { ecosystem, name, status: 'ok'|'not-found'|'error', latest, created, versions: {v: {t: ms, d?: string, y?: true}}, inactive? }
   */
  async pkg(ecosystem, name) {
    const key = `${ecosystem}:${name}`;
    if (this.pkgs.has(key)) return this.pkgs.get(key);
    if (this.offline) return { ecosystem, name, status: 'error', error: 'offline and not in snapshot' };
    if (!this.fetchedAt) this.fetchedAt = new Date().toISOString();
    let rec;
    try { rec = ecosystem === 'npm' ? await fetchNpm(name) : await fetchPypi(name); }
    catch (e) { rec = { ecosystem, name, status: 'error', error: String(e.message || e) }; }
    this.pkgs.set(key, rec);
    return rec;
  }

  async prefetch(list, concurrency = 8) {
    await pool(list, concurrency, ({ ecosystem, name }) => this.pkg(ecosystem, name));
  }

  /** OSV querybatch for [{ecosystem, name, version}] -> Map("eco:name@ver" -> [vulnDetail]) */
  async advisories(queries) {
    const keyOf = (q) => `${q.ecosystem}:${q.name}@${q.version}`;
    const todo = [...new Map(queries.map((q) => [keyOf(q), q])).values()].filter((q) => !this.osvQueries.has(keyOf(q)));
    if (todo.length && this.offline) throw new Error(`offline: ${todo.length} OSV queries missing from snapshot`);
    for (let i = 0; i < todo.length; i += 500) {
      const chunk = todo.slice(i, i + 500);
      const ids = await osvBatch(chunk);
      chunk.forEach((q, j) => this.osvQueries.set(keyOf(q), ids[j]));
    }
    const allIds = new Set();
    for (const q of queries) for (const id of this.osvQueries.get(keyOf(q)) || []) allIds.add(id);
    await pool([...allIds].filter((id) => !this.vulns.has(id)), 8, async (id) => this.vulns.set(id, await this.vulnDetail(id)));
    const out = new Map();
    for (const q of queries) out.set(keyOf(q), (this.osvQueries.get(keyOf(q)) || []).map((id) => this.vulns.get(id)).filter((v) => v && !v.withdrawn));
    return out;
  }

  async vulnDetail(id) {
    if (this.offline) return { id, severity: 'UNKNOWN' };
    try {
      const r = await fetchRetry(`${OSV}/v1/vulns/${encodeURIComponent(id)}`);
      if (!r.ok) return { id, severity: 'UNKNOWN' };
      const v = await r.json();
      let severity = String(v.database_specific?.severity || '').toUpperCase() || null;
      if (id.startsWith('MAL-')) severity = 'CRITICAL';
      if (!severity) {
        // PYSEC/other records often lack a label; borrow it from a GHSA alias.
        const gh = (v.aliases || []).find((a) => a.startsWith('GHSA-'));
        if (gh) {
          const r2 = await fetchRetry(`${OSV}/v1/vulns/${gh}`).catch(() => null);
          if (r2?.ok) severity = String((await r2.json()).database_specific?.severity || '').toUpperCase() || null;
        }
      }
      if (severity === 'MODERATE') severity = 'MEDIUM';
      return { id, aliases: v.aliases || [], summary: (v.summary || '').slice(0, 200), severity: severity || 'UNKNOWN', withdrawn: !!v.withdrawn, published: v.published };
    } catch { return { id, severity: 'UNKNOWN' }; }
  }

  /** e18e module-replacements: Map(name -> {type, replacements}) — secondary metric only. */
  async e18eMap() {
    if (this.e18e) return new Map(Object.entries(this.e18e));
    const out = {};
    if (!this.offline) {
      for (const f of ['native', 'micro-utilities', 'preferred']) {
        try {
          const r = await fetchRetry(`https://cdn.jsdelivr.net/npm/module-replacements@3/manifests/${f}.json`);
          if (!r.ok) continue;
          const j = await r.json();
          for (const [name, m] of Object.entries(j.mappings || {})) out[name] = { manifest: f, replacements: m.replacements || [] };
          for (const m of j.moduleReplacements || []) out[m.moduleName] = { manifest: f, replacements: [m.replacement || m.type].filter(Boolean) };
        } catch { /* optional */ }
      }
    }
    this.e18e = out;
    return new Map(Object.entries(out));
  }
}

async function fetchNpm(name) {
  const url = `${NPM}/${name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;
  const r = await fetchRetry(url, { headers: { accept: 'application/json' } });
  if (r.status === 404) return { ecosystem: 'npm', name, status: 'not-found' };
  if (!r.ok) return { ecosystem: 'npm', name, status: 'error', error: `HTTP ${r.status}` };
  const j = await r.json();
  if (!j.versions) return { ecosystem: 'npm', name, status: 'not-found', unpublished: !!j.time?.unpublished };
  const versions = {};
  for (const [v, meta] of Object.entries(j.versions)) {
    const e = { t: Date.parse(j.time?.[v]) || null };
    if (meta.deprecated) e.d = String(meta.deprecated).slice(0, 200);
    versions[v] = e;
  }
  return { ecosystem: 'npm', name, status: 'ok', latest: j['dist-tags']?.latest || null, created: Date.parse(j.time?.created) || null, versions };
}

async function fetchPypi(name) {
  const r = await fetchRetry(`${PYPI}/${encodeURIComponent(name)}/json`);
  if (r.status === 404) return { ecosystem: 'pypi', name, status: 'not-found' };
  if (!r.ok) return { ecosystem: 'pypi', name, status: 'error', error: `HTTP ${r.status}` };
  const j = await r.json();
  const versions = {};
  let created = null;
  for (const [v, files] of Object.entries(j.releases || {})) {
    if (!files.length) continue;
    const t = Math.min(...files.map((f) => Date.parse(f.upload_time_iso_8601 || f.upload_time)).filter(Number.isFinite));
    const e = { t: Number.isFinite(t) ? t : null };
    if (files.every((f) => f.yanked)) { e.y = true; e.d = `yanked${files[0].yanked_reason ? ': ' + files[0].yanked_reason : ''}`.slice(0, 200); }
    versions[v] = e;
    if (e.t && (!created || e.t < created)) created = e.t;
  }
  const inactive = (j.info?.classifiers || []).includes('Development Status :: 7 - Inactive');
  return { ecosystem: 'pypi', name, status: 'ok', latest: j.info?.version || null, created, versions, inactive };
}

async function osvBatch(queries) {
  const body = { queries: queries.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem === 'npm' ? 'npm' : 'PyPI' }, version: q.version })) };
  const r = await fetchRetry(`${OSV}/v1/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { timeoutMs: 60000 });
  if (!r.ok) throw new Error(`OSV querybatch HTTP ${r.status}`);
  const j = await r.json();
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const res = j.results?.[i] || {};
    const ids = (res.vulns || []).map((v) => v.id);
    let token = res.next_page_token;
    while (token) {
      const r2 = await fetchRetry(`${OSV}/v1/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: [{ ...body.queries[i], page_token: token }] }) });
      const j2 = await r2.json();
      ids.push(...(j2.results?.[0]?.vulns || []).map((v) => v.id));
      token = j2.results?.[0]?.next_page_token;
    }
    out.push(ids);
  }
  return out;
}
