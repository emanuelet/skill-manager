import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import { duplicateBaseSlug, instructionHash } from '../core/dedup.js';
import { buildDepGraph, getDependents } from '../core/deps.js';
import { deleteSkill, listSlugs, skillExists } from '../core/skill.js';
import { readMeta, writeMeta } from '../core/meta.js';
import { getLinkRecords } from '../core/state.js';
import { deploy, deployToProject } from '../deploy/engine.js';
import { skillFile } from '../fs/paths.js';

interface ReconcileOptions {
  apply?: boolean;
  preferAgents?: boolean;
}

/** Merge numbered canonical copies only when their instruction bodies match. */
export async function reconcileDuplicatesCommand(opts: ReconcileOptions): Promise<void> {
  const graph = await buildDepGraph();
  const slugs = await listSlugs();
  let merged = 0;
  let skipped = 0;

  for (const duplicate of slugs) {
    const base = duplicateBaseSlug(duplicate);
    if (!base || !(await skillExists(base))) continue;

    const [baseContent, duplicateContent] = await Promise.all([
      fs.readFile(skillFile(base), 'utf-8'),
      fs.readFile(skillFile(duplicate), 'utf-8'),
    ]);
    const contentDiffers = instructionHash(baseContent) !== instructionHash(duplicateContent);
    if (contentDiffers && !opts.preferAgents) {
      console.log(chalk.yellow(`– ${duplicate}: instruction bodies differ`));
      skipped++;
      continue;
    }

    const dependents = getDependents(duplicate, graph);
    if (dependents.length > 0) {
      console.log(chalk.yellow(`– ${duplicate}: required by ${dependents.join(', ')}`));
      skipped++;
      continue;
    }

    const [baseLinks, duplicateLinks] = await Promise.all([getLinkRecords(base), getLinkRecords(duplicate)]);
    const links = [...baseLinks, ...duplicateLinks];
    const action = contentDiffers
      ? `replace ${base} with agents version from ${duplicate}`
      : `merge ${duplicate} into ${base}`;
    if (!opts.apply) {
      console.log(`${action} (${links.length} deployment${links.length === 1 ? '' : 's'})`);
      merged++;
      continue;
    }

    if (contentDiffers) {
      const [baseMeta, duplicateMeta] = await Promise.all([readMeta(base), readMeta(duplicate)]);
      await fs.emptyDir(path.dirname(skillFile(base)));
      await fs.copy(path.dirname(skillFile(duplicate)), path.dirname(skillFile(base)));
      duplicateMeta.deployAs.cc = baseMeta.deployAs.cc;
      await writeMeta(base, duplicateMeta);
    }
    await deleteSkill(duplicate);
    for (const link of links) {
      if (link.scope === 'project' && link.projectRoot) {
        await deployToProject(base, link.tool, link.projectRoot);
      } else {
        await deploy(base, link.tool, link.format);
      }
    }
    console.log(chalk.green(`✓ ${action}`));
    merged++;
  }

  console.log(opts.apply
    ? `\nReconciled ${merged} duplicate${merged === 1 ? '' : 's'}; skipped ${skipped}.`
    : `\nWould reconcile ${merged} duplicate${merged === 1 ? '' : 's'}; skipped ${skipped}. Run with --apply to proceed.`);
}
