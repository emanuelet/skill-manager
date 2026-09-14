import chalk from 'chalk';
import { marked, Renderer, type Tokens } from 'marked';

function createTerminalRenderer(): Renderer {
  const renderer = new Renderer();
  const inline = (tokens: Tokens.Generic[]) => renderer.parser.parseInline(tokens);

  renderer.heading = ({ tokens, depth }) => {
    const text = inline(tokens);
    const style = depth === 1 ? chalk.bold.underline : chalk.bold;
    return `\n${style(text)}\n\n`;
  };
  renderer.paragraph = ({ tokens }) => `${inline(tokens)}\n\n`;
  renderer.text = (token) => ('tokens' in token && token.tokens ? inline(token.tokens) : token.text);
  renderer.strong = ({ tokens }) => chalk.bold(inline(tokens));
  renderer.em = ({ tokens }) => chalk.italic(inline(tokens));
  renderer.codespan = ({ text }) => chalk.cyan(`\`${text}\``);
  renderer.code = ({ text }) => `\n${chalk.dim(text)}\n\n`;
  renderer.table = ({ header, rows }) => {
    const line = (cells: Tokens.TableCell[]) => `| ${cells.map((cell) => inline(cell.tokens)).join(' | ')} |`;
    const separator = `| ${header.map(() => '---').join(' | ')} |`;
    return `\n${line(header)}\n${separator}\n${rows.map(line).join('\n')}\n\n`;
  };
  renderer.link = ({ href, tokens }) => chalk.underline(`${inline(tokens)} (${href})`);
  renderer.image = ({ href, text }) => `${text} (${href})`;
  renderer.br = () => '\n';
  renderer.hr = () => `${chalk.dim('─'.repeat(Math.max(20, process.stdout.columns || 80)))}\n`;
  renderer.blockquote = ({ tokens }) =>
    renderer.parser
      .parse(tokens)
      .trimEnd()
      .split('\n')
      .map((line) => `${chalk.dim('│')} ${line}`)
      .join('\n') + '\n\n';
  renderer.list = ({ items, ordered, start }) => {
    const first = typeof start === 'number' ? start : 1;
    const content = items
      .map((item, index) => {
        const prefix = ordered ? `${first + index}. ` : '• ';
        return `${prefix}${renderer.parser.parse(item.tokens).trim().replace(/\n/g, '\n  ')}`;
      })
      .join('\n');
    return `${content}\n\n`;
  };
  renderer.html = ({ text }) => text.replace(/<[^>]*>/g, '');

  return renderer;
}

/**
 * Render markdown to ANSI-styled terminal output with Marked.
 * Strips sm:begin/sm:end managed block markers for clean display.
 */
export function renderMarkdownToTerminal(md: string): string {
  const cleaned = md.replace(/^<!-- sm:begin \S+ -->\n?/gm, '').replace(/^<!-- sm:end \S+ -->\n?/gm, '');
  return marked.parse(cleaned, { renderer: createTerminalRenderer() }) as string;
}
