import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import { SM_BIFROST_STATE_FILE, SM_CONFLICTS_DIR, SM_SKILLS_DIR, skillDir, skillFile, skillMetaFile } from '../fs/paths.js';
import { listSlugs } from '../core/skill.js';
import { readMeta, writeMeta } from '../core/meta.js';
import { instructionHash } from '../core/dedup.js';
import { validateRemoteSkill } from '../core/security.js';
import { deploy } from '../deploy/engine.js';
import { getLinkRecords } from '../core/state.js';

interface RemoteSkill { id: string; name: string; latest_version: string; updated_at: string; description?: string }
interface RemoteFile { path: string; source_type?: string }
interface RemoteDetail extends RemoteSkill { skill_md_body: string; files?: RemoteFile[] }
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
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function remoteDetails(url: string, summary: RemoteSkill): Promise<RemoteDetail> {
  const data = await fetchJson<{ skill?: RemoteDetail } | RemoteDetail>(`${url}/api/skills/${summary.id}`);
  return 'skill' in data && data.skill ? data.skill : data as RemoteDetail;
}
function unwrapRemote(response: { skill?: RemoteSkill } | RemoteSkill): RemoteSkill {
  return 'skill' in response && response.skill ? response.skill : response as RemoteSkill;
}
function safeFilePath(filePath: string): boolean {
  return filePath !== 'SKILL.md' && !path.isAbsolute(filePath) && !filePath.split('/').includes('..');
}
function remoteFileUrl(baseUrl: string, slug: string, filePath: string): string {
  return `${baseUrl}/api/skills/serve/${encodeURIComponent(slug)}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}
async function remoteFileContent(baseUrl: string, slug: string, filePath: string): Promise<Buffer> {
  const response = await fetch(remoteFileUrl(baseUrl, slug, filePath));
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}
async function localAttachments(slug: string): Promise<Array<{ path: string; content: Buffer }>> {
  const files: Array<{ path: string; content: Buffer }> = [];
  const root = skillDir(slug);
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!portable(entry.name) || entry.name === 'SKILL.md') continue;
      const relative = path.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) files.push({ path: relative.split(path.sep).join('/'), content: await fs.readFile(full) });
    }
  };
  await walk(root);
  return files;
}
async function uploadAttachments(baseUrl: string, slug: string): Promise<Record<string, unknown>[]> {
  const uploaded: Record<string, unknown>[] = [];
  for (const file of await localAttachments(slug)) {
    validateRemoteSkill(file.content.toString('utf8'), 'UNTRUSTED');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(file.content)]), path.basename(file.path));
    const result = await fetchJson<Record<string, unknown>>(`${baseUrl}/api/skills/files/upload`, { method: 'POST', body: form });
    uploaded.push({ ...result, path: file.path, source_type: 'upload' });
  }
  return uploaded;
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
async function writeRemote(baseUrl: string, slug: string, remote: RemoteDetail, updatedAt: string): Promise<void> {
  validateRemoteSkill(remote.skill_md_body, 'UNTRUSTED');
  const staging = path.join(SM_SKILLS_DIR, `.bifrost-${slug}-${crypto.randomUUID()}`);
  await fs.ensureDir(staging);
  const frontmatter = `---\nname: ${slug}\ndescription: ${JSON.stringify(remote.description ?? '')}\nversion: ${remote.latest_version}\n---\n\n`;
  await fs.writeFile(path.join(staging, 'SKILL.md'), frontmatter + remote.skill_md_body);
  for (const file of remote.files ?? []) {
    if (!safeFilePath(file.path)) continue;
    const content = await remoteFileContent(baseUrl, slug, file.path);
    validateRemoteSkill(content.toString('utf8'), 'UNTRUSTED');
    const destination = path.join(staging, file.path);
    if (!destination.startsWith(`${staging}${path.sep}`)) continue;
    await fs.ensureDir(path.dirname(destination)); await fs.writeFile(destination, content);
  }
  const target = skillDir(slug);
  const previous = `${target}.previous-${crypto.randomUUID()}`;
  if (await fs.pathExists(target)) await fs.rename(target, previous);
  try {
    await fs.rename(staging, target);
  } catch (error) {
    if (await fs.pathExists(previous) && !(await fs.pathExists(target))) {
      await fs.rename(previous, target);
    }
    await fs.remove(staging);
    throw error;
  }
  if (await fs.pathExists(previous)) await fs.remove(previous);
  const meta = await readMeta(slug).catch(() => null);
  await writeMeta(slug, meta ? { ...meta, source: { type: 'bifrost', repo: remote.id, sourceId: remote.id }, updatedAt } : {
    format: 'skill', source: { type: 'bifrost', repo: remote.id, sourceId: remote.id }, tags: [], deployAs: { cc: 'skill', agents: 'skill' }, createdAt: updatedAt, updatedAt, usageCount: 0,
  });
  const stamp = new Date(updatedAt); await fs.utimes(path.join(target, 'SKILL.md'), stamp, stamp);
}

async function pushLocal(baseUrl: string, slug: string, remote?: RemoteSkill): Promise<RemoteSkill> {
  const body = (await fs.readFile(skillFile(slug), 'utf8')).replace(/^---[\s\S]*?---\s*/, '');
  const payload = {
    name: slug,
    description: remote?.description ?? slug,
    skill_md_body: body,
    version: remote?.latest_version ?? '1.0.0',
    files: await uploadAttachments(baseUrl, slug),
  };
  const response = remote
    ? await fetchJson<{ skill?: RemoteSkill } | RemoteSkill>(`${baseUrl}/api/skills/${remote.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    : await fetchJson<{ skill?: RemoteSkill } | RemoteSkill>(`${baseUrl}/api/skills`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return unwrapRemote(response);
}

async function deployMissingBifrostTargets(slug: string): Promise<number> {
  if (!(await fs.pathExists(skillMetaFile(slug)))) return 0;
  const [meta, links] = await Promise.all([readMeta(slug), getLinkRecords(slug)]);
  let deployed = 0;
  for (const tool of ['cc', 'agents'] as const) {
    const format = meta.deployAs[tool];
    if (format === 'none' || links.some((link) => link.tool === tool && (link.scope ?? 'user') === 'user')) continue;
    if ((await deploy(slug, tool)).action === 'deployed') deployed++;
  }
  return deployed;
}

export async function syncBifrost(url = process.env.BIFROST_URL ?? 'http://localhost:8090'): Promise<{ pushed: number; pulled: number; deployed: number; skipped: number; conflicts: number }> {
  const baseUrl = url.replace(/\/$/, '');
  const state = await loadState(baseUrl);
  const version = await fetchJson<{ version?: string }>(`${baseUrl}/api/skills/all/version`);
  const remoteSkills = await listRemoteSkills(baseUrl);
  for (const skill of remoteSkills) assertSafeSlug(skill.name);
  const remoteBySlug = new Map(remoteSkills.map((skill) => [skill.name, skill]));
  let pushed = 0, pulled = 0, deployed = 0, skipped = 0, conflicts = 0;
  const slugs = new Set([...await listSlugs(), ...remoteBySlug.keys()]);
  for (const slug of [...slugs].sort()) {
    const remote = remoteBySlug.get(slug);
    const localDir = skillDir(slug);
    if (!remote) {
      let created: RemoteSkill;
      try {
        created = await pushLocal(baseUrl, slug);
      } catch (error) {
        if (error instanceof Error && error.message.includes('reserved name')) {
          console.warn(`Skipped reserved Bifrost skill name: ${slug}`);
          skipped++;
          continue;
        }
        throw error;
      }
      pushed++;
      state.skills[slug] = { id: created.id, remoteUpdatedAt: created.updated_at, hash: await hashSkillBody(localDir) };
      continue;
    }
    const detail = await remoteDetails(baseUrl, remote);
    const remoteHash = instructionHash(detail.skill_md_body);
    if (!(await fs.pathExists(localDir))) {
      await writeRemote(baseUrl, slug, detail, remote.updated_at);
      deployed += await deployMissingBifrostTargets(slug);
      pulled++;
      state.skills[slug] = { id: remote.id, remoteUpdatedAt: remote.updated_at, hash: remoteHash };
      continue;
    }
    const localHash = await hashSkillBody(localDir);
    if (localHash === remoteHash) {
      deployed += await deployMissingBifrostTargets(slug);
      state.skills[slug] = { id: remote.id, remoteUpdatedAt: remote.updated_at, hash: localHash };
      continue;
    }
    const localTime = await localUpdatedAt(localDir); const remoteTime = Date.parse(remote.updated_at);
    // Timestamp is the conflict authority. Equal times deliberately fall into
    // the pull branch so a deterministic Bifrost winner never silently loses.
    if (localTime > remoteTime) {
      await pushLocal(baseUrl, slug, remote);
      pushed++;
    } else {
      // Preserve the losing local revision for both remote-newer and tie cases.
      await snapshotLocal(slug);
      if (localTime === remoteTime) conflicts++;
      await writeRemote(baseUrl, slug, detail, remote.updated_at); pulled++;
    }
    state.skills[slug] = { id: remote.id, remoteUpdatedAt: remote.updated_at, hash: remoteHash };
  }
  state.lastVersion = version.version; await fs.ensureDir(path.dirname(SM_BIFROST_STATE_FILE)); await fs.writeJson(SM_BIFROST_STATE_FILE, state, { spaces: 2 });
  return { pushed, pulled, deployed, skipped, conflicts };
}
