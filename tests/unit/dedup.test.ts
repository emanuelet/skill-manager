import { describe, it, expect } from 'vitest';
import { deduplicateFiles, buildScannedFile, duplicateBaseSlug, instructionHash } from '../../src/core/dedup.js';

describe('deduplicateFiles', () => {
  it('groups files with the same hash', () => {
    const files = [
      buildScannedFile('/a/foo.md', 'cc-commands', 'foo', 'content A'),
      buildScannedFile('/b/foo.md', 'codex-prompts', 'foo', 'content A'),
    ];

    const groups = deduplicateFiles(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].slug).toBe('foo');
    expect(groups[0].files).toHaveLength(2);
  });

  it('disambiguates same slug with different hash using suffix', () => {
    const files = [
      buildScannedFile('/a/foo.md', 'cc-commands', 'foo', 'version 1'),
      buildScannedFile('/b/foo.md', 'codex-prompts', 'foo', 'version 2'),
    ];

    const groups = deduplicateFiles(files);
    expect(groups).toHaveLength(2);
    const slugs = groups.map((g) => g.slug).sort();
    expect(slugs[0]).toBe('foo');
    // Second slug has hash suffix
    expect(slugs[1]).toMatch(/^foo-[a-f0-9]{8}$/);
  });

  it('merges metadata-only variants from different tools', () => {
    const files = [
      buildScannedFile('/a/xurl.md', 'cc-commands', 'xurl', '---\nname: xurl\nmetadata: full\n---\n# Xurl'),
      buildScannedFile('/b/xurl.md', 'codex-prompts', 'xurl', '---\nname: xurl\n---\n# Xurl'),
    ];
    expect(deduplicateFiles(files)).toHaveLength(1);
  });

  it('picks canonical based on source priority', () => {
    const files = [
      buildScannedFile('/a/foo.md', 'codex-prompts', 'foo', 'same content'),
      buildScannedFile('/b/foo.md', 'cc-commands', 'foo', 'same content'),
      buildScannedFile('/c/foo.md', 'codex-skills', 'foo', 'same content'),
    ];

    const groups = deduplicateFiles(files);
    expect(groups).toHaveLength(1);
    // codex-skills has highest priority (0)
    expect(groups[0].canonical.source).toBe('codex-skills');
  });

  it('returns empty array for empty input', () => {
    const groups = deduplicateFiles([]);
    expect(groups).toHaveLength(0);
  });

  it('handles single file', () => {
    const files = [buildScannedFile('/a/bar.md', 'cc-commands', 'bar', 'hello')];
    const groups = deduplicateFiles(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].slug).toBe('bar');
    expect(groups[0].canonical.source).toBe('cc-commands');
  });

  it('identifies numbered duplicates by their canonical base slug', () => {
    expect(duplicateBaseSlug('xurl-2')).toBe('xurl');
    expect(duplicateBaseSlug('xurl')).toBeNull();
  });

  it('uses the instruction body as the identity hash', () => {
    expect(instructionHash('---\nname: xurl\n---\n# Xurl')).toBe(
      instructionHash('---\nname: xurl\ndescription: different\n---\n# Xurl'),
    );
  });
});
