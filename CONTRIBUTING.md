# Contributing to Skill Manager

## Development Setup

```bash
git clone https://github.com/omrikais/skill-manager.git
cd skill-manager
pnpm install
pnpm build
pnpm link --global # makes `sm` available globally
```

Requires Node.js 24+ and pnpm 12.9.0 (pinned in `package.json` and `mise.toml`).
Run `mise install` to install the project tools, then use `pnpm dev` for watch mode.

Type checking uses TypeScript 7 via the `@typescript/native` alias (`tsc`).
The `typescript` dependency aliases `@typescript/typescript6` to provide the
TypeScript 6 API required by build tooling (`tsc6`). Keep both aliases
when updating dependencies; TypeScript 7 does not provide the compatible API.

## Project Structure

```
bin/sm.ts          CLI entry point (Commander.js)
src/core/          Business logic (skill, meta, state, config, deploy resolution)
src/fs/            Filesystem operations (symlinks, scanner, backup, path constants)
src/deploy/        Deploy engine and format strategies
src/commands/      CLI command handlers
src/tui/           Ink v6 TUI (screens, hooks, components)
src/mcp/           MCP server (tools, resources, setup)
src/utils/         Errors, logger, slug, table formatting
tests/             Vitest test suite (unit, fs, deploy)
```

## Running Tests

```bash
pnpm test                         # all tests
npx vitest run tests/unit/        # unit tests (pure functions, no I/O)
npx vitest run tests/fs/          # filesystem tests (isolated tmpdirs)
npx vitest run tests/deploy/      # deploy engine integration tests
pnpm test:watch                   # watch mode
```

**Test isolation**: FS and deploy tests use `tests/helpers/tmpdir.ts`, which creates a temporary `~/.skill-manager` directory under `os.tmpdir()` via the `SM_HOME` and `SM_TEST_HOME` environment variables. Each test gets a fresh directory and cleans up after itself. Tests use `vi.resetModules()` with dynamic imports so path constants are re-evaluated against the temp environment.

## Code Style

- **ESM-only** — all imports use `.js` extensions (`import { foo } from './bar.js'`)
- **Zod schemas** for config, state, and manifest validation
- **Errors** extend `SmError` with a `.code` property (see `src/utils/errors.ts`)
- **Logging** goes to stderr via `src/utils/logger.ts`; CLI output goes to stdout
- **JSX** uses React 19 automatic runtime (`react-jsx` transform)
- Type-check with `pnpm lint` (`tsc --noEmit`)
- Lint with `pnpm lint:oxlint`; rules are configured in `.oxlintrc.json`

## Pull Request Process

1. Run `pnpm lint` and `pnpm test` before submitting — both must pass
2. Keep PRs focused: one feature or fix per PR
3. Describe what changed and why in the PR description
4. Add tests for new functionality (unit tests for pure logic, FS tests for anything touching disk)
5. Follow existing patterns — check nearby code for conventions before introducing new ones
