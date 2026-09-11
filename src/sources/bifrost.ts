import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import { SM_BIFROST_STATE_FILE, SM_CONFLICTS_DIR, SM_SKILLS_DIR, skillDir, skillFile } from '../fs/paths.js';
import { listSlugs } from '../core/skill.js';
import { readMeta, writeMeta } from '../core/meta.js';
import { instructionHash } from '../core/dedup.js';

interface RemoteSkill { id: string; name: string; latest_version: string; updated_at: string; description?: string }
interface RemoteDetail extends RemoteSkill { skill_md_body: string; files?: Array<{ path: string; content?: string }> }
interface BifrostState { version: 1; url: string; lastVersion?: string; skills: Record<string, { id: string; remoteUpdatedAt: string; hash: string }> }

function portable(name: string): boolean { return name !== '.sm-meta.json' && name !== '.sm-history.json' && !name.startsWith('.sm-'); }
async function hashSkillBody(dir: string): Promise<string> {
  return instructionHash(await fs.readFile(skillFile(path.basename(dir)), 'utf8'));
}
async function localUpdatedAt(dir: string): Promise<number> {
  let latest = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!portable(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full); else if (entry.isFile()) latest = Math.max(latest, (await fs.stat(full)).mtimeMs);
    }
  };
  await walk(dir); return latest;
}
async function loadState(url: string): Promise<BifrostState> {
  try { return { ...(await fs.readJson(SM_BIFROST_STATE_FILE)), url }; } catch { return { version: 1, url, skills: {} }; }
}
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}
async function remoteDetails(url: string, summary: RemoteSkill): Promise<RemoteDetail> {
  const data = await fetchJson<{ skill?: RemoteDetail } | RemoteDetail>(`${url}/api/skills/${summary.id}`);
  return 'skill' in data && data.skill ? data.skill : data as RemoteDetail;
}
async function listRemoteSkills(url: string): Promise<RemoteSkill[]> {
  const all: RemoteSkill[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await fetchJson<{ skills: RemoteSkill[]; total: number }>(`${url}/api/skills?limit=100&offset=${offset}`);
    all.push(...page.skills);
    if (offset + page.skills.length >= page.total || page.skills.length === 0) return all;
  }
}

function assertSafeSlug(slug: string): void {
  if (!slug || path.isAbsolute(slug) || slug.includes('/') || slug.includes('\\') || slug === '.' || slug === '..') {
    throw new Error(`Unsafe Bifrost skill name: ${JSON.stringify(slug)}`);
  }
}
async function snapshotLocal(slug: string): Promise<void> {
  const source = skillDir(slug);
  if (!(await fs.pathExists(source))) return;
  const target = path.join(SM_CONFLICTS_DIR, 'bifrost', slug, new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.ensureDir(path.dirname(target));
  await fs.copy(source, target, { filter: (entry) => portable(path.basename(entry)) });
}
async function writeRemote(slug: string, remote: RemoteDetail, updatedAt: string): Promise<void> {
  const staging = path.join(SM_SKILLS_DIR, `.bifrost-${slug}-${crypto.randomUUID()}`);
  await fs.ensureDir(staging);
  const frontmatter = `---\nname: ${slug}\ndescription: ${JSON.stringify(remote.description ?? '')}\nversion: ${remote.latest_version}\n---\n\n`;
  await fs.writeFile(path.join(staging, 'SKILL.md'), frontmatter + remote.skill_md_body);
  for (const file of remote.files ?? []) {
    if (!file.content || file.path === 'SKILL.md' || path.isAbsolute(file.path) || file.path.split('/').includes('..')) continue;
    const destination = path.join(staging, file.path);
    if (!destination.startsWith(`${staging}${path.sep}`)) continue;
    await fs.ensureDir(path.dirname(destination)); await fs.writeFile(destination, file.content);
  }
  const target = skillDir(slug);
  const previous = `${target}.previous-${crypto.randomUUID()}`;
  if (await fs.pathExists(target)) await fs.rename(target, previous);
  await fs.rename(staging, target);
  if (await fs.pathExists(previous)) await fs.remove(previous);
  const meta = await readMeta(slug).catch(() => null);
  await writeMeta(slug, meta ? { ...meta, source: { type: 'bifrost', repo: remote.id, sourceId: remote.id }, updatedAt } : {
    format: 'skill', source: { type: 'bifrost', repo: remote.id, sourceId: remote.id }, tags: [], deployAs: { cc: 'skill', codex: 'skill' }, createdAt: updatedAt, updatedAt, usageCount: 0,
  });
  const stamp = new Date(updatedAt); await fs.utimes(path.join(target, 'SKILL.md'), stamp, stamp);
}

export async function syncBifrost(url = process.env.BIFROST_URL ?? 'http://localhost:8090'): Promise<{ pushed: number; pulled: number; conflicts: number }> {
  const baseUrl = url.replace(/\/$/, '');
  const state = await loadState(baseUrl);
  const version = await fetchJson<{ version?: string }>(`${baseUrl}/api/skills/all/version`);
  const remoteSkills = await listRemoteSkills(baseUrl);
  for (const skill of remoteSkills) assertSafeSlug(skill.name);
  const remoteBySlug = new Map(remoteSkills.map((skill) => [skill.name, skill]));
  let pushed = 0, pulled = 0, conflicts = 0;
  const slugs = new Set([...await listSlugs(), ...remoteBySlug.keys()]);
  for (const slug of [...slugs].sort()) {
    const remote = remoteBySlug.get(slug);
    const localDir = skillDir(slug);
    if (!remote) continue; // Bifrost does not delete local skills implicitly.
    const detail = await remoteDetails(baseUrl, remote);
    const remoteHash = instructionHash(detail.skill_md_body);
    if (!(await fs.pathExists(localDir))) { await writeRemote(slug, detail, remote.updated_at); pulled++; state.skills[slug] = { id: remote.id, remoteUpdatedAt: remote.updated_at, hash: remoteHash }; continue; }
    const localHash = await hashSkillBody(localDir);
    if (localHash === remoteHash) { state.skills[slug] = { id: remote.id, remoteUpdatedAt: remote.updated_at, hash: localHash }; continue; }
    const localTime = await localUpdatedAt(localDir); const remoteTime = Date.parse(remote.updated_at);
    // Timestamp is the conflict authority. Equal times deliberately fall into
    // the pull branch so a deterministic Bifrost winner never silently loses.
    if (localTime > remoteTime) {
      const body = await fs.readFile(path.join(localDir, 'SKILL.md'), 'utf8');
      await fetchJson(`${baseUrl}/api/skills/${remote.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: remote.description ?? slug, skill_md_body: body.replace(/^---[\s\S]*?---\s*/, ''), version: remote.latest_version }) });
      pushed++;
    } else {
      // Preserve the losing local revision for both remote-newer and tie cases.
      await snapshotLocal(slug);
      if (localTime === remoteTime) conflicts++;
      await writeRemote(slug, detail, remote.updated_at); pulled++;
    }
    state.skills[slug] = { id: remote.id, remoteUpdatedAt: remote.updated_at, hash: remoteHash };
  }
  state.lastVersion = version.version; await fs.ensureDir(path.dirname(SM_BIFROST_STATE_FILE)); await fs.writeJson(SM_BIFROST_STATE_FILE, state, { spaces: 2 });
  return { pushed, pulled, conflicts };
}
