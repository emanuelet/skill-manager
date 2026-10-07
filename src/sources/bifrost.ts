import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import {
  SM_BIFROST_STATE_FILE,
  SM_CONFLICTS_DIR,
  SM_SKILLS_DIR,
  skillDir,
  skillFile,
  skillMetaFile,
} from '../fs/paths.js';
import { listSlugs } from '../core/skill.js';
import { readMeta, writeMeta } from '../core/meta.js';
import { instructionHash } from '../core/dedup.js';
import { validateRemoteSkill } from '../core/security.js';
import { deploy } from '../deploy/engine.js';
import { getLinkRecords } from '../core/state.js';
import { BifrostHttpError, createBifrostClient, type BifrostClient } from './bifrost-client.js';
import { SourceError } from '../utils/errors.js';

interface RemoteSkill {
  id: string;
  name: string;
  latest_version: string;
  highest_version?: string;
  updated_at: string;
  description?: string;
}
interface RemoteFile {
  path: string;
  source_type?: string;
}
interface RemoteDetail extends RemoteSkill {
  skill_md_body: string;
  files?: RemoteFile[];
}
interface BifrostState {
  version: 1;
  url: string;
  lastVersion?: string;
  skills: Record<string, { id: string; remoteUpdatedAt: string; hash: string }>;
}
class BifrostAttachmentTooLargeError extends Error {
  constructor(readonly filePath: string) {
    super(`Bifrost attachment exceeds the upload limit: ${filePath}`);
  }
}

function portable(name: string): boolean {
  return name !== '.sm-meta.json' && name !== '.sm-history.json' && !name.startsWith('.sm-');
}
function syncableAttachment(filePath: string): boolean {
  return !filePath
    .split(/[\\/]/)
    .some((part) =>
      [
        '.cache',
        '.git',
        '.next',
        '.nuxt',
        '__pycache__',
        'build',
        'coverage',
        'dist',
        'node_modules',
        'target',
      ].includes(part),
    );
}
async function hashSkillBody(dir: string): Promise<string> {
  return instructionHash(await fs.readFile(skillFile(path.basename(dir)), 'utf8'));
}
async function localUpdatedAt(dir: string): Promise<number> {
  let latest = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!portable(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) latest = Math.max(latest, (await fs.stat(full)).mtimeMs);
    }
  };
  await walk(dir);
  return latest;
}
async function loadState(url: string): Promise<BifrostState> {
  try {
    const saved = (await fs.readJson(SM_BIFROST_STATE_FILE)) as BifrostState;
    if (saved.url === url) return saved;
  } catch {
    /* Missing or corrupt state starts a new endpoint snapshot. */
  }
  return { version: 1, url, skills: {} };
}
async function remoteDetails(client: BifrostClient, summary: RemoteSkill): Promise<RemoteDetail> {
  const data = await client.json<{ skill?: RemoteDetail } | RemoteDetail>(
    `/api/skills/${encodeURIComponent(summary.id)}`,
  );
  return 'skill' in data && data.skill ? data.skill : (data as RemoteDetail);
}
function unwrapRemote(response: { skill?: RemoteSkill } | RemoteSkill): RemoteSkill {
  return 'skill' in response && response.skill ? response.skill : (response as RemoteSkill);
}
function nextRemoteVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new SourceError(`Cannot update Bifrost skill with non-semver latest version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
function safeFilePath(filePath: string): boolean {
  return filePath !== 'SKILL.md' && !path.isAbsolute(filePath) && !filePath.split('/').includes('..');
}
function remoteFileUrl(slug: string, filePath: string): string {
  return `/api/skills/serve/${encodeURIComponent(slug)}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}
async function remoteFileContent(client: BifrostClient, slug: string, filePath: string): Promise<Buffer> {
  const response = await client.request(remoteFileUrl(slug, filePath));
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
      if (entry.isDirectory() && syncableAttachment(relative)) await walk(full, relative);
      else if (entry.isFile() && syncableAttachment(relative))
        files.push({ path: relative.split(path.sep).join('/'), content: await fs.readFile(full) });
    }
  };
  await walk(root);
  return files;
}
async function uploadAttachments(client: BifrostClient, slug: string): Promise<Record<string, unknown>[]> {
  const uploaded: Record<string, unknown>[] = [];
  for (const file of await localAttachments(slug)) {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(file.content)]), path.basename(file.path));
    let result: Record<string, unknown>;
    try {
      result = await client.json<Record<string, unknown>>('/api/skills/files/upload', {
        method: 'POST',
        body: form,
      });
    } catch (error) {
      if (error instanceof BifrostHttpError && error.status === 413)
        throw new BifrostAttachmentTooLargeError(file.path);
      throw error;
    }
    uploaded.push({ ...result, path: file.path, source_type: 'upload' });
  }
  return uploaded;
}
async function listRemoteSkills(client: BifrostClient): Promise<RemoteSkill[]> {
  const all: RemoteSkill[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.json<{ skills: RemoteSkill[]; total: number }>(`/api/skills?limit=100&offset=${offset}`);
    all.push(...page.skills);
    if (offset + page.skills.length >= page.total || page.skills.length === 0) return all;
  }
}

function assertSafeSlug(slug: string): void {
  if (!slug || path.isAbsolute(slug) || slug.includes('/') || slug.includes('\\') || slug === '.' || slug === '..') {
    throw new Error(`Unsafe Bifrost skill name: ${JSON.stringify(slug)}`);
  }
}
function validBifrostSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
async function snapshotLocal(slug: string): Promise<void> {
  const source = skillDir(slug);
  if (!(await fs.pathExists(source))) return;
  const target = path.join(SM_CONFLICTS_DIR, 'bifrost', slug, new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.ensureDir(path.dirname(target));
  await fs.copy(source, target, { filter: (entry) => portable(path.basename(entry)) });
}
async function writeRemote(
  client: BifrostClient,
  slug: string,
  remote: RemoteDetail,
  updatedAt: string,
  approved = false,
): Promise<void> {
  validateRemoteSkill(remote.skill_md_body, 'UNTRUSTED', approved);
  const staging = path.join(SM_SKILLS_DIR, `.bifrost-${slug}-${crypto.randomUUID()}`);
  await fs.ensureDir(staging);
  const frontmatter = `---\nname: ${slug}\ndescription: ${JSON.stringify(remote.description ?? '')}\nversion: ${remote.latest_version}\n---\n\n`;
  await fs.writeFile(path.join(staging, 'SKILL.md'), frontmatter + remote.skill_md_body);
  for (const file of remote.files ?? []) {
    if (!safeFilePath(file.path) || !syncableAttachment(file.path)) continue;
    const content = await remoteFileContent(client, slug, file.path);
    validateRemoteSkill(content.toString('utf8'), 'UNTRUSTED', approved);
    const destination = path.join(staging, file.path);
    if (!destination.startsWith(`${staging}${path.sep}`)) continue;
    await fs.ensureDir(path.dirname(destination));
    await fs.writeFile(destination, content);
  }
  const target = skillDir(slug);
  const previous = `${target}.previous-${crypto.randomUUID()}`;
  if (await fs.pathExists(target)) await fs.rename(target, previous);
  try {
    await fs.rename(staging, target);
  } catch (error) {
    if ((await fs.pathExists(previous)) && !(await fs.pathExists(target))) {
      await fs.rename(previous, target);
    }
    await fs.remove(staging);
    throw error;
  }
  if (await fs.pathExists(previous)) await fs.remove(previous);
  const meta = await readMeta(slug).catch(() => null);
  await writeMeta(
    slug,
    meta
      ? { ...meta, source: { type: 'bifrost', repo: remote.id, sourceId: remote.id }, updatedAt }
      : {
          format: 'skill',
          source: { type: 'bifrost', repo: remote.id, sourceId: remote.id },
          tags: [],
          deployAs: { cc: 'skill', agents: 'skill' },
          createdAt: updatedAt,
          updatedAt,
          usageCount: 0,
        },
  );
  const stamp = new Date(updatedAt);
  await fs.utimes(path.join(target, 'SKILL.md'), stamp, stamp);
}

async function pushLocal(client: BifrostClient, slug: string, remote?: RemoteSkill): Promise<RemoteSkill> {
  const body = (await fs.readFile(skillFile(slug), 'utf8')).replace(/^---[\s\S]*?---\s*/, '');
  const payload = {
    name: slug,
    description: remote?.description ?? slug,
    skill_md_body: body,
    version: remote ? nextRemoteVersion(remote.highest_version ?? remote.latest_version) : '1.0.0',
    files: await uploadAttachments(client, slug),
  };
  const response = remote
    ? await client.json<{ skill?: RemoteSkill } | RemoteSkill>(`/api/skills/${encodeURIComponent(remote.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    : await client.json<{ skill?: RemoteSkill } | RemoteSkill>('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
  return unwrapRemote(response);
}
function skipPushError(error: unknown, slug: string): boolean {
  if (error instanceof BifrostHttpError && error.reservedName) {
    console.warn(`Skipped reserved Bifrost skill name: ${slug}`);
    return true;
  }
  if (error instanceof BifrostAttachmentTooLargeError) {
    console.warn(`Skipped Bifrost skill ${slug}: attachment ${error.filePath} exceeds the server upload limit.`);
    return true;
  }
  return false;
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

export async function syncBifrost(
  url?: string,
  trustedSlugs: ReadonlySet<string> = new Set(),
): Promise<{ pushed: number; pulled: number; deployed: number; skipped: number; conflicts: number }> {
  const client = await createBifrostClient(url);
  const baseUrl = client.baseUrl;
  const state = await loadState(baseUrl);
  const version = await client.json<{ version?: string }>('/api/skills/all/version');
  const remoteSkills = await listRemoteSkills(client);
  for (const skill of remoteSkills) assertSafeSlug(skill.name);
  const remoteBySlug = new Map(remoteSkills.map((skill) => [skill.name, skill]));
  let pushed = 0,
    pulled = 0,
    deployed = 0,
    skipped = 0,
    conflicts = 0;
  const slugs = new Set([...(await listSlugs()), ...remoteBySlug.keys()]);
  for (const slug of [...slugs].sort()) {
    const remote = remoteBySlug.get(slug);
    const localDir = skillDir(slug);
    if (!remote) {
      if (!validBifrostSlug(slug)) {
        console.warn(`Skipped Bifrost-incompatible skill name: ${slug}`);
        skipped++;
        continue;
      }
      let created: RemoteSkill;
      try {
        created = await pushLocal(client, slug);
      } catch (error) {
        if (skipPushError(error, slug)) {
          skipped++;
          continue;
        }
        throw error;
      }
      pushed++;
      state.skills[slug] = { id: created.id, remoteUpdatedAt: created.updated_at, hash: await hashSkillBody(localDir) };
      continue;
    }
    const detail = await remoteDetails(client, remote);
    const remoteHash = instructionHash(detail.skill_md_body);
    if (!(await fs.pathExists(localDir))) {
      await writeRemote(client, slug, detail, remote.updated_at, trustedSlugs.has(slug));
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
    const localTime = await localUpdatedAt(localDir);
    const remoteTime = Date.parse(remote.updated_at);
    // Timestamp is the conflict authority. Equal times deliberately fall into
    // the pull branch so a deterministic Bifrost winner never silently loses.
    if (localTime > remoteTime) {
      try {
        await pushLocal(client, slug, detail);
        pushed++;
      } catch (error) {
        if (skipPushError(error, slug)) {
          skipped++;
          continue;
        }
        throw error;
      }
    } else {
      // Preserve the losing local revision for both remote-newer and tie cases.
      await snapshotLocal(slug);
      if (localTime === remoteTime) conflicts++;
      await writeRemote(client, slug, detail, remote.updated_at, trustedSlugs.has(slug));
      pulled++;
    }
    state.skills[slug] = { id: remote.id, remoteUpdatedAt: remote.updated_at, hash: remoteHash };
  }
  state.lastVersion = version.version;
  await fs.ensureDir(path.dirname(SM_BIFROST_STATE_FILE));
  await fs.writeJson(SM_BIFROST_STATE_FILE, state, { spaces: 2 });
  return { pushed, pulled, deployed, skipped, conflicts };
}
