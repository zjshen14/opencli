# Architecture Design - Gemini Agent CLI

## Overview

A general-purpose AI agent CLI powered by Google Gemini, similar to Claude Code and Gemini CLI. The agent can assist with software development tasks through natural language interaction with tool execution capabilities.

## Design Principles

1. **Developer-First UX**: Fast, intuitive command-line interface with streaming responses
2. **Safety**: Confirmations for dangerous operations, sandboxed execution where possible
3. **Extensibility**: Plugin architecture for custom tools and capabilities
4. **Performance**: Efficient context management, parallel tool execution
5. **Simplicity**: Start simple, add complexity only when needed
6. **Stay at the Frontier**: This is an exploratory project — always use the latest GenAI and agent models, preview models are acceptable

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                            │
│  - Command parsing                                           │
│  - Terminal UI (prompts, markdown rendering)                 │
│  - User interaction (questions, confirmations)               │
│  - Skill invocation (/slash commands, preprocessing)         │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                     Agent Core                               │
│  - Main agent loop (request → LLM → tools → response)       │
│  - Conversation state management                             │
│  - Context window management                                 │
│  - Streaming handler                                         │
│  - Skill catalog injection + activation dispatch             │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        │              │              │              │
┌───────▼──────┐ ┌────▼────────┐ ┌──▼──────────┐ ┌▼─────────────┐
│ Model Layer  │ │ Tool System │ │ State Mgmt  │ │ Skill System │
│              │ │             │ │             │ │              │
│ - Gemini API │ │ - File ops  │ │ - Session   │ │ - Registry   │
│ - Function   │ │ - Bash exec │ │ - History   │ │ - SKILL.md   │
│   calling    │ │ - Search    │ │ - Config    │ │   loader     │
│ - Streaming  │ │ - Web       │ │ - Cache     │ │ - Built-ins  │
└──────────────┘ └─────────────┘ └─────────────┘ └──────────────┘
```

## Core Components

### 1. CLI Layer

**Responsibilities:**
- Parse command-line arguments and flags
- Initialize and manage terminal UI
- Handle user input/output
- Render markdown and code syntax highlighting
- Display progress indicators

**Tech Stack:**
- `commander` or `yargs` - CLI argument parsing
- `@clack/prompts` - Interactive prompts
- `chalk` - Terminal colors
- `marked` + `marked-terminal` - Markdown rendering
- `ora` - Spinners and progress

**Skill Invocation (CLI Layer responsibilities):**
- Intercept input starting with `/` before forwarding to Agent Core
- Parse `/<skill-name> [args]`, look up skill in registry
- Run `!{cmd}` shell preprocessors and substitute `$ARGUMENTS`
- Inject the resulting content into Agent Core as a context event
- Provide tab-completion for skill names

**Key Files:**
```
src/cli/
  ├── index.ts           # CLI entry point
  ├── commands/          # Command handlers
  ├── ui/                # UI components (prompts, rendering)
  └── renderer.ts        # Markdown/code rendering
```

### 2. Agent Core

**Responsibilities:**
- Main agent loop: user input → LLM → tool execution → response
- Manage conversation context and history
- Handle streaming responses from Gemini
- Coordinate tool execution (parallel/sequential)
- Error handling and recovery

**Agent Loop Flow:**
```
1. User Input
   ↓
2. Build Context (history + tool results + system prompt)
   ↓
3. Call Gemini API
   ↓
4. Stream Response
   ├─→ Text chunks → Display to user
   └─→ Function calls → Execute tools
       ↓
5. If function calls:
   ├─→ Execute tools (parallel where possible)
   ├─→ Collect results
   └─→ Feed back to LLM (goto step 2)

6. If final response:
   └─→ Display to user
```

**Skill responsibilities in Agent Core:**
- At session start: call `SkillRegistry.discover()`, inject skill catalog (name + description only, ~50–100 tokens/skill) into the system prompt so Gemini knows which skills are available
- On user-explicit activation (`/skill-name`): receive pre-processed skill content from CLI Layer, inject into conversation context as a system event
- On model-driven activation: handle `activate_skill` function calls from Gemini, load and inject the full `SKILL.md` body as a tool result
- Protect activated skill content from context pruning (tag with `<skill_content name="...">`)
- Deduplicate: skip re-injection if a skill is already active in the session

**Key Files:**
```
src/agent/
  ├── core.ts            # Main agent loop
  ├── context.ts         # Context management
  ├── streaming.ts       # Stream handling
  └── executor.ts        # Tool execution coordinator
```

### 3. Model Layer (Gemini Integration)

**Responsibilities:**
- Gemini API client wrapper
- Function calling schema generation
- Request/response formatting
- Streaming support
- Error handling and retries
- Rate limiting

**Gemini API Features to Use:**
- Model: `gemini-3-flash-preview` (fast) or `gemini-3.1-pro-preview` (capable/agentic)
- Function calling for tool execution
- System instructions for agent behavior
- Large context window (1M+ tokens)
- Multi-turn conversations

**Function Calling vs Tools:**

Function calling is the JSON wire protocol between the app and Gemini — distinct from the tool implementations themselves. The Model Layer owns both directions of the translation:

1. **Outbound** (`schema.ts`): translates `Tool` definitions into Gemini's `function_declarations` format before sending the API request.
2. **Inbound** (`gemini.ts`): parses `functionCall` objects out of Gemini's streaming response and surfaces them to the Agent Core.

The Tool System owns execution and knows nothing about Gemini. The Model Layer owns the protocol and never touches the filesystem or runs commands. This boundary means swapping Gemini for another LLM only requires changes to the Model Layer.

Example — the same `read` tool as seen from each layer:

```typescript
// Tool System: the implementation (src/tools/file/read.ts)
const readTool: Tool = {
  name: "read",
  description: "Read file contents",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset:    { type: "number" }
    },
    required: ["file_path"]
  },
  execute: async ({ file_path, offset }) => {
    const content = await fs.readFile(file_path, "utf8");
    return { success: true, output: content };
  }
};

// Model Layer: translated to Gemini's function declaration format (src/model/schema.ts)
{
  function_declarations: [{
    name: "read",
    description: "Read file contents",
    parameters: {
      type: "OBJECT",
      properties: {
        file_path: { type: "STRING" },
        offset:    { type: "NUMBER" }
      },
      required: ["file_path"]
    }
  }]
}

// Gemini response — parsed by Model Layer, dispatched by Agent Core
{
  "functionCall": {
    "name": "read",
    "args": { "file_path": "package.json" }
  }
}
```

**Skill-related function declaration:**

The Model Layer exposes `activate_skill` as a Gemini function declaration alongside tool declarations, enabling model-driven skill activation:

```typescript
{
  name: "activate_skill",
  description: "Activate a skill to load its instructions into context",
  parameters: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "Skill name to activate" }
    },
    required: ["name"]
  }
}
```

**Key Files:**
```
src/model/
  ├── gemini.ts          # Gemini client
  ├── schema.ts          # Function calling schemas
  ├── types.ts           # Type definitions
  └── config.ts          # Model configuration
```

### 4. Tool System

**Tool Categories:**

**File Operations:**
- `read` - Read file contents (with line range support)
- `write` - Write/create files
- `edit` - Edit files (find/replace)
- `glob` - Find files by pattern
- `grep` - Search file contents

**Execution:**
- `bash` - Execute shell commands
- `bash_background` - Background execution
- `kill_process` - Kill background processes

**Code Intelligence:**
- `parse_code` - AST parsing for understanding code structure
- `find_symbol` - Find function/class definitions

**Web:**
- `web_fetch` - Fetch web content
- `web_search` - Search the web

**Task Management:**
- `todo_write` - Manage task lists
- `ask_user` - Ask clarifying questions

**Tool Interface:**
```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute: (params: unknown) => Promise<ToolResult>;
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}
```

**Key Files:**
```
src/tools/
  ├── registry.ts        # Tool registration and lookup
  ├── base.ts            # Base tool interface
  ├── file/              # File operation tools
  ├── exec/              # Execution tools
  ├── search/            # Search tools
  └── web/               # Web tools
```

### 5. Skill System

Skills are prompt-level capabilities — packaged `SKILL.md` instructions that get injected into the agent's context. Unlike tools (which execute code), skills deliver Markdown instructions for the model to follow using existing tools.

**Standard:** Aligned with the [Agent Skills open standard](https://agentskills.io), which is adopted by Claude Code, the official Gemini CLI, Cursor, GitHub Copilot, and others. This enables skill sharing across the ecosystem.

**Skill format** (`SKILL.md`):
```yaml
---
name: review                        # becomes /review slash command
description: Review code for correctness, style, and security issues.
                                    # model uses this to auto-activate
allowed-tools: Read Grep            # pre-approved, no confirmation needed
disable-agent-invocation: true      # true = user-only (e.g. deploy, commit)
---

Review the following code: $ARGUMENTS

Check for:
- Correctness and logic errors
- Security vulnerabilities
- Code style

Current branch info:
!{git log --oneline -5}             # shell preprocessing — output injected before sending to model
```

**Directory structure (scoped, earlier takes precedence):**
```
~/.gemini-agent/skills/<name>/SKILL.md      # user-global
<project>/.gemini-agent/skills/<name>/SKILL.md  # project-scoped
<project>/.agents/skills/<name>/SKILL.md    # cross-client convention (agentskills.io)
```

**Three-tier loading (progressive disclosure):**

| Tier | Content | When loaded | Token cost |
|------|---------|-------------|------------|
| 1. Catalog | name + description only | Session start | ~50–100/skill |
| 2. Instructions | Full `SKILL.md` body | On activation | <5000 recommended |
| 3. Resources | Scripts, reference files | When referenced | On demand |

**Invocation paths:**
1. **User-explicit**: `/review src/auth.ts` — CLI Layer intercepts, preprocesses, injects
2. **Model-driven**: Gemini calls `activate_skill("review")` when it matches the catalog description — Agent Core loads and injects

**Built-in skills** (shipped with the CLI):
- `/review` — Code review for correctness, style, security
- `/commit` — Draft and create a git commit
- `/explain` — Explain selected code or a concept
- `/debug` — Diagnose and fix a reported error
- `/test` — Write tests for a given function or module

**Key Files:**
```
src/skills/
  ├── registry.ts        # Discover, parse, and catalog SKILL.md files
  ├── loader.ts          # Load skill body, run !{} preprocessors, substitute $ARGUMENTS
  └── builtin/           # Built-in skill SKILL.md files
      ├── review/
      ├── commit/
      ├── explain/
      ├── debug/
      └── test/
```

### 6. State Management

**Responsibilities:**
- Conversation history persistence
- Session management
- Configuration storage
- Caching (API responses, tool results)

**State Components:**
- **Conversation History**: Store messages and tool results
- **Session**: Current working directory, environment
- **Config**: User preferences, API keys, model settings
- **Cache**: Reduce redundant API calls

**Storage:**
- Local files in `~/.gemini-agent/`
- SQLite for structured data (optional)
- JSON for simple config

**Key Files:**
```
src/state/
  ├── session.ts         # Session management
  ├── history.ts         # Conversation history
  ├── config.ts          # Configuration
  └── cache.ts           # Caching layer
```

## Data Flow

### Typical Interaction:

1. **User**: "Read the package.json file and update the version to 2.0.0"

2. **CLI Layer**: Parse input, send to Agent Core

3. **Agent Core**:
   - Build context with conversation history
   - Send to Gemini with available tools

4. **Gemini Response 1** (streaming):
   ```
   Text: "I'll read the package.json file first"
   Function Call: read({ file_path: "package.json" })
   ```

5. **Tool Execution**:
   - Execute `read` tool
   - Return file contents

6. **Agent Core**: Send tool result back to Gemini

7. **Gemini Response 2**:
   ```
   Text: "I can see the current version is 1.5.0. I'll update it to 2.0.0"
   Function Call: edit({
     file_path: "package.json",
     old_string: '"version": "1.5.0"',
     new_string: '"version": "2.0.0"'
   })
   ```

8. **Tool Execution**:
   - Execute `edit` tool
   - Return success

9. **Gemini Response 3**:
   ```
   Text: "Updated package.json version to 2.0.0"
   ```

10. **CLI Layer**: Display final response to user

### Skill Invocation Flow:

1. **User**: "/review src/auth.ts"

2. **CLI Layer**:
   - Detects `/` prefix, looks up "review" in SkillRegistry
   - Reads `SKILL.md` body
   - Runs `!{git log --oneline -5}` preprocessor, substitutes output
   - Substitutes `$ARGUMENTS` → "src/auth.ts"
   - Sends processed content to Agent Core as a context event

3. **Agent Core**:
   - Injects skill content into conversation context tagged as `<skill_content name="review">`
   - Continues normal agent loop with enriched context

4. **Gemini**: Receives skill instructions + user message, uses `read` and `grep` tools to execute the review

5. **CLI Layer**: Streams and renders the review response

## Tool Execution Model

### Parallel Execution
When tools are independent (no data dependencies), execute in parallel:

```typescript
// Gemini requests: read("file1.ts"), read("file2.ts")
const results = await Promise.all([
  tools.execute("read", { file_path: "file1.ts" }),
  tools.execute("read", { file_path: "file2.ts" })
]);
```

### Sequential Execution
When tools depend on each other, execute sequentially:

```typescript
// Tool 1: read file
const content = await tools.execute("read", { file_path: "config.json" });

// Tool 2: edit based on content
const result = await tools.execute("edit", {
  file_path: "config.json",
  old_string: extracted_from_content,
  new_string: new_value
});
```

### Safety Checks
- Confirm dangerous operations (file deletion, force push)
- Sandbox bash execution when possible
- Validate file paths (prevent path traversal)
- Rate limit API calls

## Context Management

**Challenge**: Gemini has a large context window (1M+ tokens), but we still need to manage it efficiently.

**Strategy**:
1. **Sliding Window**: Keep last N messages + tool results
2. **Summarization**: Summarize old conversations to reduce tokens
3. **Smart Pruning**: Remove redundant tool results
4. **Caching**: Use Gemini's context caching for repeated content

**Context Structure**:
```typescript
interface Context {
  systemInstructions: string;      // Agent behavior, tool descriptions
  conversationHistory: Message[];  // User messages + assistant responses
  toolResults: ToolResult[];       // Recent tool execution results
  workingDirectory: string;        // Current context
}
```

## Configuration

**User Configuration** (`~/.gemini-agent/config.json`):
```json
{
  "apiKey": "...",
  "model": "gemini-3.1-flash-lite-preview",
  "maxTokens": 8192,
  "temperature": 0.7,
  "autoExecute": false,  // Auto-execute tools or ask first
  "theme": "dark",
  "historySize": 50
}
```

**Environment Variables**:
- `GEMINI_API_KEY` - API key
- `GEMINI_MODEL` - Model to use
- `GEMINI_AGENT_CONFIG` - Custom config path

## Security Considerations

1. **API Key Protection**
   - Store in config file with proper permissions
   - Never log API keys
   - Support environment variables

2. **Command Execution**
   - Warn before destructive operations
   - Sandbox execution where possible
   - Validate all inputs

3. **File Access**
   - Validate file paths
   - Prevent path traversal attacks
   - Respect .gitignore patterns

4. **Network Requests**
   - Validate URLs
   - Timeout protection
   - Rate limiting

## Performance Optimizations

1. **Streaming**: Always stream responses for better UX
2. **Parallel Tools**: Execute independent tools in parallel
3. **Caching**: Cache API responses when appropriate
4. **Lazy Loading**: Load tools on-demand
5. **Smart Context**: Only include relevant context

## Error Handling

**Strategy**:
- Graceful degradation
- User-friendly error messages
- Automatic retry with exponential backoff
- Detailed logging for debugging

**Error Categories**:
- API errors (rate limits, timeouts)
- Tool execution errors
- User input errors
- System errors

## Testing Strategy

1. **Unit Tests**: Individual tools and utilities
2. **Integration Tests**: Agent loop with mocked Gemini
3. **E2E Tests**: Full scenarios with real API (CI only)
4. **Manual Testing**: Interactive testing checklist

## Deployment & Distribution

**Installation**:
```bash
npm install -g gemini-agent
# or
npx gemini-agent
```

**Build**:
- Bundle with `tsup` or `unbuild`
- Single executable with `pkg` (optional)
- Cross-platform support

## Future Enhancements

**Phase 2**:
- Multi-file editing (refactoring)
- Git integration (commits, PRs)
- Code intelligence (LSP integration)
- Custom tool plugins
- Skill subagent isolation (`context: fork` — run skill in isolated subagent context)

**Phase 3**:
- Sub-agents for complex tasks
- Multi-agent collaboration
- MCP server support
- Web UI companion

## References

- [Gemini API Documentation](https://ai.google.dev/docs)
- [Claude Code Architecture](https://github.com/anthropics/claude-code)
- [Function Calling Guide](https://ai.google.dev/docs/function_calling)
- [Agent Skills Open Standard](https://agentskills.io/specification)
- [Agent Skills Client Implementation Guide](https://agentskills.io/client-implementation/adding-skills-support)
