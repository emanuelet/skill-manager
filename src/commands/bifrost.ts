import chalk from 'chalk';
import { syncBifrost } from '../sources/bifrost.js';

export async function bifrostSyncCommand(opts: { url?: string }): Promise<void> {
  const result = await syncBifrost(opts.url);
  console.log(chalk.green(`Bifrost sync: ${result.pushed} pushed, ${result.pulled} pulled, ${result.conflicts} equal-time conflicts resolved to Bifrost.`));
}
