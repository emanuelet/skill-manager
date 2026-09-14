import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { createScorer, search } from 'rapidfuzz-js';
import { SM_HOME, SM_SEARCH_DB } from '../fs/paths.js';
import { listSkills, type Skill } from './skill.js';
import { usageBySlug } from './usage.js';
import fs from 'fs-extra';

const RRF_K = 60;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const FUZZY_SCORER = createScorer(similarity, { direction: 'similarity', bounds: [0, 100], symmetric: true });

export interface SearchHit {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  score: number;
}

interface IndexedSkill {
  skill: Skill;
  text: string;
}

function similarity(left: string | ArrayLike<unknown> | null | undefined, right: string | ArrayLike<unknown> | null | undefined): number {
  const a = String(left ?? '').toLowerCase();
  const b = String(right ?? '').toLowerCase();
  if (!a || !b) return 0;
  const matrix = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = matrix[0];
    matrix[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = matrix[j];
      matrix[j] = Math.min(matrix[j] + 1, matrix[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return Math.max(0, 100 * (1 - matrix[b.length] / Math.max(a.length, b.length)));
}

function tokens(query: string): string[] {
  return query.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

async function openDb(): Promise<Database> {
  await fs.ensureDir(SM_HOME);
  const db = new DatabaseSync(SM_SEARCH_DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
      slug UNINDEXED, name, description, tags, aliases, intents, content,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  return db;
}

export async function rebuildSearchIndex(): Promise<void> {
  const skills = await listSkills();
  const db = await openDb();
  try {
    db.exec('BEGIN IMMEDIATE; DELETE FROM skills_fts;');
    const insert = db.prepare('INSERT INTO skills_fts (slug, name, description, tags, aliases, intents, content) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const skill of skills) {
      const frontmatter = skill.content.frontmatter;
      insert.run(skill.slug, skill.name, skill.description, skill.tags.join(' '), (frontmatter.aliases ?? []).join(' '), (frontmatter.intents ?? []).join(' '), skill.content.content);
    }
    db.exec("INSERT OR REPLACE INTO search_meta VALUES ('indexed_at', datetime('now')); COMMIT;");
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.close();
  }
}

export async function searchSkills(query: string, limit = 20): Promise<SearchHit[]> {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return [];
  await rebuildSearchIndex();
  const skills = await listSkills();
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
  const db = await openDb();
  const ranks = new Map<string, number>();
  try {
    const expression = queryTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' OR ');
    const lexical = db.prepare('SELECT slug FROM skills_fts WHERE skills_fts MATCH ? ORDER BY bm25(skills_fts, 8, 4, 2, 2, 2, 1) LIMIT 100').all(expression) as Array<{ slug: string }>;
    lexical.forEach((row, index) => ranks.set(row.slug, 1 / (RRF_K + index + 1)));
  } finally {
    db.close();
  }
  const indexed: IndexedSkill[] = skills.map((skill) => ({ skill, text: `${skill.slug} ${skill.name} ${skill.tags.join(' ')} ${skill.description}` }));
  const fuzzyCandidates = indexed.flatMap((row) => row.text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((text) => ({ slug: row.skill.slug, text })));
  const fuzzy = search(query, fuzzyCandidates.map((row) => row.text), { scorer: FUZZY_SCORER, threshold: 55, limit: 100 });
  const fuzzySlugs = new Set<string>();
  for (let index = 0; index < fuzzy.length; index++) {
    const slug = fuzzyCandidates[fuzzy[index].key as number]?.slug;
    if (slug && !fuzzySlugs.has(slug)) {
      fuzzySlugs.add(slug);
      ranks.set(slug, (ranks.get(slug) ?? 0) + 1 / (RRF_K + index + 1));
    }
  }
  const usage = await usageBySlug();
  return [...ranks.entries()]
    .map(([slug, score]) => ({ skill: bySlug.get(slug)!, score: score * usageMultiplier(usage.get(slug)) }))
    .filter((row) => row.skill)
    .sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug))
    .slice(0, Math.min(Math.max(limit, 1), 100))
    .map(({ skill, score }) => ({ slug: skill.slug, name: skill.name, description: skill.description, tags: skill.tags, score }));
}

function usageMultiplier(usage: { useCount: number; lastUsed?: string } | undefined): number {
  if (!usage) return 1;
  const frequency = 1 + Math.log1p(Math.max(0, usage.useCount)) / 10;
  const ageDays = usage.lastUsed ? Math.max(0, (Date.now() - Date.parse(usage.lastUsed)) / 86_400_000) : 365;
  return frequency * (0.9 + 0.1 * Math.exp(-ageDays / 90));
}
