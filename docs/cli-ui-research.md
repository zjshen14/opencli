# CLI UI Research: Visual Design and Interaction Patterns

Research into how Gemini CLI and Claude Code implement their rich terminal UI, and what's achievable for this project.

---

## The Core Framework Question: Ink vs readline

Both Gemini CLI and Claude Code are built on **Ink** (React for terminals). This is the fundamental architectural difference from the current readline-based REPL.

### What Ink provides that readline cannot

- **Flexbox layout** (via Facebook's Yoga engine): `<Box flexDirection="column">`, `<Box flexGrow={1}>` — the same CSS Flexbox model, but for terminal cells. No layout model exists in raw stdout.
- **Declarative re-rendering**: State changes trigger targeted repaints via ANSI cursor moves. Only changed cells are redrawn — no full-screen flicker.
- **`<Static>` component**: Items rendered in `<Static>` are printed once and never re-rendered. Gemini CLI uses this for conversation history — the history scrolls up naturally while the input area at the bottom re-renders freely.
- **Hooks**: `useStdout()`, `useTerminalSize()`, `useKeypress()`, `useApp()` — all wired automatically.

### Tradeoffs of Ink

- Requires React 19+ as a peer dependency. Adds ~3MB to bundle and ~100–200ms to cold start.
- You must commit to the React mental model. Mixing Ink with readline is awkward — they fight over stdin.
- Gemini CLI uses a patched fork: `@jrichman/ink@6.6.7`.

### Lighter alternatives evaluated

| Library | What it is | Verdict |
|---|---|---|
| `@clack/prompts` (installed) | Single-prompt-at-a-time with ANSI cursor manipulation | Good for single-shot prompts; not persistent UIs |
| `blessed` / `neo-blessed` | ncurses-style: absolute positioning, scrollable boxes, mouse | Powerful but largely unmaintained (last commit 2019) |
| `terminal-kit` | Similar to blessed, more active | Imperative/callback style, no TypeScript types |
| `@inquirer/prompts` | Single interactive prompts with nice styling | Same niche as `@clack/prompts` |

**Conclusion**: For a persistent chat UI with sticky footer + scrolling history + autocomplete popup, Ink is the only well-maintained path. `@clack/prompts` covers individual prompts only.

---

## Slash Command Autocomplete Popup

### How Gemini CLI implements it

Entirely Ink-based, split across three files:

- **`useSlashCompletion.ts`**: Logic hook. Detects when input starts with `/`, parses the command path (supports nested sub-commands), and runs fuzzy search using the **`fzf`** npm package (`AsyncFzf`). The `AsyncFzf` instance is cached in a `WeakMap` keyed on the command array reference for zero-cost re-use across keystrokes.
- **`SuggestionsDisplay.tsx`**: Ink render component. Two-column layout (command name left, description right), section headers between groups, `▲`/`▼` scroll indicators when list exceeds 8 items, highlighted match characters.
- **`InputPrompt.tsx`**: Renders `<SuggestionsDisplay>` either above or below the input box depending on whether alternate-buffer mode is active.

**Interaction flow:**
1. User types `/` → `isSlashCommand(input)` activates `useSlashCompletion`
2. Each keystroke → `AsyncFzf.find(partial)` with `AbortController` cancels stale searches
3. Results → `SuggestionsDisplay` re-renders
4. Arrow keys update `activeIndex`, Tab/Enter insert completion, Escape dismisses

### Implementing without Ink (raw mode approach)

Feasible with ~150 lines. The pattern:
1. `readline.emitKeypressEvents(stdin)` + `stdin.setRawMode(true)`
2. On each keypress, if input starts with `/`, filter commands, then:
   - Print N popup lines below the prompt
   - On next keystroke: move cursor up N+1 lines (`\x1b[${n}A`), erase to end (`\x1b[J`), reprint updated popup
3. On Enter/Escape: erase popup, restore normal flow

This is exactly what `@clack/prompts` does internally for its `select` prompt. The `sisteransi` package (already a transitive dep) provides `cursor.up(n)`, `erase.down(n)`, `cursor.hide/show`.

**Tab-only alternative (no popup)**: readline's built-in `completer` callback — triggered on Tab, shows completions inline. Simpler but no per-keystroke filtering or visual popup.

---

## Output Beautification

### Bordered boxes

**`boxen`** (npm, ~13KB): `boxen('text', { padding: 1, borderStyle: 'round', borderColor: 'cyan' })`. Uses `cli-boxes` for box-drawing characters (`single`, `double`, `round`, `bold`, `classic`). Returns a plain string — works with any `process.stdout.write`. No Ink required.

Gemini CLI uses Ink's `<Box borderStyle="..." borderColor="...">` instead, which participates in layout. Visually identical.

### Syntax highlighting

Gemini CLI uses **`lowlight`** (v3.x) — a virtual syntax highlighter that produces a HAST tree. Their `CodeColorizer.tsx` traverses the tree and maps highlight.js CSS class names to Ink `<Text color="...">` elements.

**Without Ink**: use **`cli-highlight`** which wraps highlight.js and outputs ANSI escape codes directly:

```ts
import { highlight } from 'cli-highlight';
process.stdout.write(highlight(code, { language: 'typescript', ignoreIllegals: true }));
```

`cli-highlight` is the simplest path — no HAST parsing, just ANSI strings.

### Diff rendering for file edits

Gemini CLI's `DiffRenderer.tsx`:
1. Uses the **`diff`** npm package to compute the patch text
2. Parses into typed `DiffLine[]` objects (`add`/`del`/`context`/`hunk`)
3. Renders with Ink `<Text backgroundColor={...}>` — green background for additions, red for deletions, gutter with line numbers

**Without Ink**: use the `diff` package + chalk:

```ts
import * as Diff from 'diff';
const patch = Diff.createPatch(filename, oldStr, newStr);
for (const line of patch.split('\n')) {
  if (line.startsWith('+')) process.stdout.write(chalk.green(line) + '\n');
  else if (line.startsWith('-')) process.stdout.write(chalk.red(line) + '\n');
  else process.stdout.write(chalk.dim(line) + '\n');
}
```

---

## Streaming Output

### The Ink approach (Gemini CLI)

Accumulates streaming tokens into a single `text` string in React state. Ink re-renders `GeminiMessage` on each state update but only repaints changed terminal rows via virtual DOM diffing. The markdown parser runs synchronously on the full accumulated string on each render.

Key pattern: `isPending: boolean` prop is passed to `MarkdownDisplay` — when `true`, it suppresses rendering incomplete code blocks at the tail of the stream (avoids an unclosed code fence mid-stream).

### Without Ink (practical approaches)

**Option A — Stream raw, render on completion** (simplest, most stable):
Show `ora` spinner → buffer all tokens → on `done` event, run `marked-terminal` on the full string and print at once. Avoids all partial-markdown rendering issues.

**Option B — Line-buffered rendering**:
Only run the markdown renderer when a complete line is available. Detect newlines in the stream, render up to the last `\n`, buffer the partial tail line. Flicker-free because complete blocks never need re-rendering.

**Option C — Current-line overwrite**:
Use `\r\x1b[K` to overwrite only the current (last) line. Scrolled-past output is permanent and correct.

---

## Spinners and Progress

### `ora` integration (already installed)

```ts
const spinner = ora({ text: 'Thinking…', stream: process.stderr }).start();
// First token arrives:
spinner.stop();  // erases spinner line cleanly
// stream tokens normally
```

`spinner.stop()` moves cursor up and erases the line. `spinner.succeed()` persists with a green checkmark. Note: `ora` sets `discardStdin: true` by default — blocks stdin during spinning.

### Two-spinner pattern (Gemini CLI's approach)

- **Model thinking**: spinner shown from request start until first text token arrives
- **Tool execution**: separate spinner per tool call, shown while the tool runs, transitions to ✓ or ✗

Without Ink, implement as: one `ora` instance started before `gemini.stream()`, stopped on first `text` event; separate `ora` instances created per tool call in `executor.ts`.

### `@clack/prompts` spinner (already installed)

```ts
const s = spinner();
s.start('Running tool...');
// ... await tool execution
s.stop('Done');
```

Integrated with clack's visual style (box-drawing characters). Works well for tool execution display since tool calls are discrete await operations.

---

## Layout: Sticky Footer

### In Ink (Gemini CLI's `DefaultAppLayout.tsx`)

```tsx
<Box flexDirection="column" height={terminalHeight}>
  <MainContent flexGrow={1} />     {/* scrolling history */}
  <Box flexShrink={0}>             {/* footer — always gets its space first */}
    <Notifications />
    <Composer />                   {/* input + autocomplete popup + status bar */}
  </Box>
</Box>
```

When `height={terminalHeight}` is set, the column is clamped to terminal height. The footer always renders at the bottom regardless of how much content is above.

### Without Ink

Three approaches, all painful:

1. **Save/restore cursor**: `\x1b[s` save, `\x1b[${rows};0H` move to last line, write status, `\x1b[u` restore. Must refresh on every `SIGWINCH`. Breaks when output scrolls past terminal height.

2. **Alternate screen buffer**: `\x1b[?1049h` enters alternate buffer (like vim). Your app owns the full screen, positioned with absolute ANSI coordinates. Exit with `\x1b[?1049l`. This is what Gemini CLI's "alternate buffer mode" does — and why it makes Ink nearly mandatory.

3. **Accept no sticky footer**: Print model name and token count inline. Pragmatic choice for a readline-based CLI.

---

## Feasibility Summary

### Achievable today without Ink (add small deps)

| Feature | Library needed | Effort |
|---|---|---|
| Bordered tool call blocks | `boxen` | Trivial |
| Syntax highlighted code | `cli-highlight` | Small |
| Spinner while thinking | `ora` (installed) | Small — wire to first token event |
| Spinner per tool call | `ora` or `@clack/prompts spinner` (installed) | Small |
| Colored diff for `edit` tool | `diff` + chalk (installed) | Small |
| Structured log output | `@clack/prompts log.*` (installed) | Trivial |
| Tab-triggered autocomplete | readline `completer` callback | Small |

### Achievable without Ink but requires raw mode (~150 lines)

| Feature | Approach |
|---|---|
| Per-keystroke slash popup | Raw mode + `sisteransi` (transitive dep) + render-erase loop |
| Streaming current-line update | `\r\x1b[K` + partial line buffer |

### Requires Ink

| Feature | Why |
|---|---|
| Sticky footer | Yoga Flexbox with `height={terminalHeight}` |
| Autocomplete popup positioned relative to input | `<Box>` layout |
| Multi-column layouts (diff gutter + code) | Flexbox `<Box flexDirection="row">` |
| Flicker-free streaming with layout | Virtual DOM diffing |

---

## Recommended Migration Path

### Phase 1 — Polish the current readline stack (no Ink)

- Wire `ora` spinner: start before `gemini.stream()`, stop on first `text` event
- Add `boxen` for tool call blocks (border + tool name header)
- Add `cli-highlight` for code blocks in markdown output
- Render colored diff for `edit` tool results using `diff` + chalk
- Use `@clack/prompts log.*` for non-streaming output (skill activated, errors, info)
- Tab autocomplete via readline `completer`

Estimated: ~4–6 hours, no architecture change.

### Phase 2 — Slash popup without Ink

- Switch stdin to raw mode
- Implement per-keystroke popup using `sisteransi` cursor manipulation
- Wire to existing slash command registry

Estimated: ~1 day.

### Phase 3 — Full Ink migration

Reference: Gemini CLI `packages/cli/src/interactiveCli.tsx` as the bootstrap, `DefaultAppLayout.tsx` for the layout skeleton (~50 lines TSX), `InputPrompt.tsx` + `useSlashCompletion.ts` for the input component.

The main investment: convert `agent/core.ts`'s async generator streaming into React state, and build the `InputPrompt` component. The agent and tool layers are unaffected.

Estimated: ~3–5 days for a production-quality result.
