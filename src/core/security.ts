import { SourceError } from '../utils/errors.js';

const MAX_SKILL_BYTES = 1_000_000;
const INJECTION_PATTERNS = [
  /^\s*(?:[-*>]\s*)?(?:(?:important|note|instruction)\s*:\s*)?(?:please\s+)?ignore\s+(all\s+)?previous\s+instructions\b/i,
  /^\s*(?:[-*>]\s*)?(?:(?:important|note|instruction)\s*:\s*)?you\s+are\s+now\b/i,
  /<\/?(system|assistant|developer)>/i,
  /^\s*(?:[-*>]\s*)?(?:(?:important|note|instruction)\s*:\s*)?do\s+not\s+follow\s+(the\s+)?(user|system)\b/i,
];

export function validateRemoteSkill(
  content: string,
  trustLevel: 'TRUSTED' | 'VERIFIED' | 'UNTRUSTED',
  approved = false,
): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES)
    throw new SourceError(`Skill exceeds ${MAX_SKILL_BYTES} byte import limit`);
  if (trustLevel !== 'UNTRUSTED' || approved) return;
  const finding = INJECTION_PATTERNS.find((pattern) => content.split(/\r?\n/).some((line) => pattern.test(line)));
  if (finding)
    throw new SourceError(
      `Untrusted skill blocked by instruction-override scan (${finding.source}). Re-run with --force only after review.`,
    );
}
