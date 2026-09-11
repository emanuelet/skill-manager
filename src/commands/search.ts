import chalk from 'chalk';
import { searchSkills } from '../core/search.js';
import { getLinkRecords } from '../core/state.js';

export async function searchCommand(query: string): Promise<void> {
  const matches = await searchSkills(query);

  if (matches.length === 0) {
    console.log(chalk.yellow(`No skills matching "${query}".`));
    return;
  }

  const links = await getLinkRecords();

  console.log(chalk.bold(`\nFound ${matches.length} skill(s) matching "${query}":\n`));

  for (const skill of matches) {
    const skillLinks = links.filter((l) => l.slug === skill.slug);
    const deployed = skillLinks.map((l) => l.tool).join(', ') || chalk.dim('not deployed');
    const tags = skill.tags.length > 0 ? chalk.dim(` [${skill.tags.join(', ')}]`) : '';

    console.log(`  ${chalk.green(skill.slug)}${tags}`);
    if (skill.description) {
      console.log(`    ${skill.description}`);
    }
    console.log(`    Deployed: ${deployed}`);
    console.log();
  }
}
