import { SourceError } from '../utils/errors.js';

const MAX_SKILL_BYTES = 1_000_000;
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s+prompt/i,
  /you\s+are\s+now/i,
  /<\/?(system|assistant|developer)>/i,
  /do\s+not\s+follow\s+(the\s+)?(user|system)/i,
];

export function validateRemoteSkill(content: string, trustLevel: 'TRUSTED' | 'VERIFIED' | 'UNTRUSTED', approved = false): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) throw new SourceError(`Skill exceeds ${MAX_SKILL_BYTES} byte import limit`);
  if (trustLevel !== 'UNTRUSTED' || approved) return;
  const finding = INJECTION_PATTERNS.find((pattern) => pattern.test(content));
  if (finding) throw new SourceError(`Untrusted skill blocked by instruction-override scan (${finding.source}). Re-run with --force only after review.`);
}
