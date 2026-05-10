# Contributing to OpenCLI

Thank you for your interest in contributing to OpenCLI! This guide will help you get started.

## Quick Links

- [Issues](https://github.com/zjshen14/opencli/issues) — Bug reports & feature requests
- [Architecture](docs/architecture.md) — Five-layer design overview
- [Engineering Practices](docs/engineering-practices.md) — Code style, testing, and workflow conventions

## Getting Started

### Prerequisites

- **Node.js** ≥ 20.6
- **npm** (comes with Node)
- A Gemini or Anthropic API key for testing

### Setup

```bash
# Clone the repo
git clone https://github.com/zjshen14/opencli.git
cd opencli

# Install dependencies
npm install

# Set up your API key
echo "GEMINI_API_KEY=your-key-here" > .env
# or
echo "ANTHROPIC_API_KEY=your-key-here" > .env

# Run in development mode
npm run dev
```

### Verify Everything Works

```bash
npm run typecheck    # TypeScript type check
npm run lint         # ESLint
npm run format:check # Prettier check
npm test             # Vitest
```

## Development Workflow

### 1. Find an Issue

- Look for issues labeled [`good first issue`](https://github.com/zjshen14/opencli/labels/good%20first%20issue) if you're new
- Check [`help wanted`](https://github.com/zjshen14/opencli/labels/help%20wanted) for more involved tasks
- Comment on an issue to let others know you're working on it

### 2. Create a Branch

```bash
git checkout -b feature/issue-123  # or fix/issue-123
```

### 3. Make Your Changes

- Follow the existing code style (Prettier + ESLint enforce this)
- Colocate tests next to source files (`context.ts` → `context.test.ts`)
- Respect the layer boundaries:
  - `cli/` — Thin adapter; reads config/env, wires dependencies
  - `core/` — Pure library; no `process.env`, no CLI imports
  - `providers/` — LLM clients; no filesystem, no CLI imports
  - `tools/` — Tool implementations; no provider SDK imports
  - `skills/` — Skill discovery and loading
  - `state/` — Config and session management

### 4. Before Submitting

Run the full check suite:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

Format your code if needed:

```bash
npm run format
```

### 5. Submit a Pull Request

- Reference the issue number (e.g., "Closes #123")
- Describe what changed and why
- Include screenshots or terminal output for UI changes

## Project Structure

```
src/
  cli/        # CLI adapter — REPL, renderer, input handling
  core/       # Agent loop, executor, context, prompt
  providers/  # LLM clients (Gemini, Anthropic)
  tools/      # Built-in tools (read, write, edit, bash, etc.)
  skills/     # Skill system (discovery, loading, built-ins)
  state/      # Config and session management
docs/         # Architecture, roadmap, design specs
```

## Adding a New Tool

1. Create a file in `src/tools/` (or a subdirectory)
2. Implement the `Tool` interface from `src/tools/base.ts`
3. Register it in `src/tools/index.ts`
4. Add tests alongside the implementation

## Adding a New Skill

1. Create a directory in `src/skills/builtin/your-skill/`
2. Add a `SKILL.md` file with YAML frontmatter
3. Update `docs/skills.md` (built-in table)
4. Update `docs/architecture.md` (skill list + file tree)
5. Update `CLAUDE.md` and `AGENTS.md` (builtin/ comment)

See [`docs/skills.md`](docs/skills.md) for the full authoring guide.

## Code Style

- **Prettier**: `printWidth: 100`, double quotes, trailing commas
- **ESLint**: `@typescript-eslint/recommended`, no unused vars (underscore prefix to suppress)
- **Testing**: Vitest, mock at system boundaries only

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/) style:

```
feat: add new glob patterns to file tool
fix: handle empty response from Gemini API
docs: update architecture diagram
test: add regression test for retry loop
```

## Questions?

Open a [Discussion](https://github.com/zjshen14/opencli/discussions) or comment on the relevant issue. We're happy to help!
