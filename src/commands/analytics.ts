import chalk from 'chalk';
import { getAnalyticsSnapshot, getScopeRecommendations } from '../core/analytics-snapshot.js';
import { formatTable, type Column } from '../utils/table.js';
import { getSearchUsage } from '../core/usage-store.js';

interface AnalyticsOptions {
  json?: boolean;
  recommend?: boolean;
  searches?: boolean;
}

export async function analyticsCommand(opts: AnalyticsOptions): Promise<void> {
  if (opts.searches) {
    const searches = await getSearchUsage();
    if (opts.json) process.stdout.write(JSON.stringify(searches, null, 2) + '\n');
    else {
      console.log(chalk.bold('\nMCP Search Outcomes\n'));
      console.log(
        `  ${searches.searches} searches; ${searches.empty} empty; ${searches.selected} selected; ${searches.unselected} with no observed selection`,
      );
      for (const search of searches.recent)
        console.log(
          `  ${search.query} → ${search.selectedSlug ?? (search.results.length ? 'no observed selection' : 'no results')}`,
        );
      console.log('\n  Selection means a returned skill was loaded, not that the task succeeded.\n');
    }
    return;
  }
  const { stats, unused, sources, collectors } = await getAnalyticsSnapshot();
  const scopeRecommendations = opts.recommend ? await getScopeRecommendations() : undefined;

  if (opts.json) {
    process.stdout.write(JSON.stringify(opts.recommend ? { stats, scopeRecommendations } : stats, null, 2) + '\n');
    return;
  }

  console.log(chalk.bold('\nSkill Usage Analytics\n'));

  if (stats.length === 0) {
    console.log(chalk.dim('  No skills found.'));
    console.log();
    return;
  }

  const columns: Column[] = [
    { header: 'Skill', key: 'slug', width: 30 },
    { header: 'Uses', key: 'usageCount', width: 6, align: 'right' },
    {
      header: 'Last Used',
      key: 'lastUsed',
      width: 12,
      format: (v) => (v ? formatDate(v as string) : chalk.dim('never')),
    },
    {
      header: 'Last Deployed',
      key: 'lastDeployed',
      width: 14,
      format: (v) => (v ? formatDate(v as string) : chalk.dim('never')),
    },
  ];

  const rows = stats.map((s) => ({ ...s }));
  console.log(formatTable(rows, columns));
  if (sources.length) {
    console.log(chalk.bold('\n  Observed usage sources'));
    for (const source of sources)
      console.log(
        `    ${source.source} (${source.kind}${source.client ? ` / ${source.client}` : ''}): ${source.calls} loads`,
      );
  }
  for (const collector of collectors) {
    if (collector.status === 'error') console.log(chalk.yellow(`    ${collector.source}: ${collector.error}`));
  }

  // Show unused skills section
  if (unused.length > 0) {
    console.log(chalk.bold('\n  Unused skills (not used in 30+ days)'));
    for (const slug of unused) {
      console.log(chalk.yellow(`    ${slug}`));
    }
  }

  if (scopeRecommendations) {
    console.log(chalk.bold('\n  Scope recommendations'));
    if (!scopeRecommendations.available) {
      console.log(chalk.dim('    Unavailable: no native or MCP usage evidence.'));
    } else if (scopeRecommendations.recommendations.length === 0) {
      console.log(chalk.dim('    No scope changes recommended.'));
    } else {
      for (const recommendation of scopeRecommendations.recommendations) {
        console.log(`    ${recommendation.action}: ${recommendation.slug} (${recommendation.reason})`);
      }
    }
  }

  console.log();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
