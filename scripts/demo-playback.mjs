#!/usr/bin/env node
// Deterministic playback of a real OpenCLI agentic session, used to record
// docs/assets/demo.gif via VHS (see demo.tape). No API calls — every line is
// hand-authored to mirror the actual REPL renderer (src/cli/renderer.ts):
//   · green "› " prompt           · compact tool lines  ○ running → ✓ done
//   · rounded yellow/magenta boxes for edit / bash   · colored unified diffs
//   · cyan plan-approval select with "›" cursor      · streamed final answer
// Keeping it dependency-free (raw ANSI) means `node scripts/demo-playback.mjs`
// runs anywhere with zero install.

const w = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- ANSI helpers (mirror chalk defaults the renderer uses) ---
const E = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = E(2);
const bold = E(1);
const green = E(32);
const cyan = E(36);
const magenta = E(35);
const yellow = E(33);
const red = E(31);
const gray = E(90);
const boldYellow = (s) => `\x1b[1;33m${s}\x1b[0m`;
const boldMagenta = (s) => `\x1b[1;35m${s}\x1b[0m`;

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const UP1 = "\x1b[1A";
const CLR = "\x1b[2K\r"; // clear whole line, return to col 0

// Animate the user typing into the prompt.
async function typePrompt(text, perChar = 42) {
  w(green("› "));
  for (const ch of text) {
    w(ch);
    await sleep(perChar);
  }
  await sleep(320);
  w("\n");
}

// Braille spinner shown while the model "thinks".
async function think(label, ms = 1300) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < ms) {
    w(CLR + dim(`  ${frames[i++ % frames.length]} ${label}`));
    await sleep(80);
  }
  w(CLR); // erase spinner; caller prints what comes next
}

// Compact read-only tool: print the "○ running" line, then overwrite with "✓".
async function compactTool(name, arg, resultSummary, hold = 520) {
  w(dim(`  ○ ${name.padEnd(6)}${arg}`) + "\n");
  await sleep(hold);
  w(UP1 + CLR + dim(`  ✓ ${name.padEnd(6)}${resultSummary}`) + "\n");
  await sleep(260);
}

// Rounded box matching boxen{ borderStyle: "round", dimBorder: true }.
function box(titlePlain, titleColored, contentPlain, contentColored) {
  const W = Math.max(40, titlePlain.length + 8, contentPlain.length + 4);
  const topDashes = "─".repeat(W - (titlePlain.length + 3));
  const top = dim("╭─ ") + titleColored + dim(" " + topDashes + "╮");
  const pad = " ".repeat(W - 1 - contentPlain.length);
  const mid = dim("│") + " " + contentColored + pad + dim("│");
  const bottom = dim("╰" + "─".repeat(W) + "╯");
  return `${top}\n${mid}\n${bottom}\n`;
}

// Color a unified-diff block the way printEditDiff does.
function diff(lines) {
  return (
    lines
      .map((l) => {
        if (l.startsWith("@@")) return cyan(l);
        if (l.startsWith("+")) return green(l);
        if (l.startsWith("-")) return red(l);
        return dim(l);
      })
      .join("\n") + "\n"
  );
}

// Stream a final markdown answer word-by-word.
async function stream(text, perWord = 26) {
  for (const word of text.split(/(\s+)/)) {
    w(word);
    if (word.trim()) await sleep(perWord);
  }
  w("\n");
}

async function main() {
  w(CURSOR_HIDE);

  // --- startup banner (mirrors repl.ts printInfo) ---
  w(gray("OpenCLI — type /help for commands, Ctrl+C to exit") + "\n");
  w(dim("  model: claude-sonnet-4-6  ·  sandbox: auto  ·  ~/dev/opencli") + "\n\n");
  await sleep(550);

  // --- user asks for a feature in plan mode ---
  await typePrompt("/plan add a --json flag to `run` so output can be piped into jq");
  w("\n");

  await think("planning", 1400);

  // --- the plan (read-only pass) ---
  w(bold("  Here's my plan:") + "\n\n");
  const planSteps = [
    ["1. ", "Add a ", "--json", " option to the ", "run", " command in ", "src/cli/index.ts"],
    ["2. ", "Thread the flag through ", "runAgentTurn", " and capture the final text"],
    ["3. ", "Emit ", "{ result, model, turns }", " as JSON when ", "--json", " is set"],
    ["4. ", "Add a test in ", "runner.test.ts", " and run the suite"],
  ];
  for (const parts of planSteps) {
    let line = "  " + bold(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      line += i % 2 === 0 ? cyan(parts[i]) : parts[i];
    }
    w(line + "\n");
    await sleep(260);
  }
  await sleep(450);
  w("\n");

  // --- plan-approval select (mirrors selectKey in input.ts) ---
  w(cyan("  Plan ready — what next?") + "\n\n");
  w(bold("    › Approve & execute  [a]") + "\n");
  w(dim("      Edit in $EDITOR first  [e]") + "\n");
  w(dim("      Cancel  [c]") + "\n");
  await sleep(1300);
  // collapse the menu to just the chosen action
  w(UP1 + CLR + UP1 + CLR + UP1 + CLR + UP1 + CLR + UP1 + CLR);
  w(green("  ✓ approved — executing") + "\n\n");
  await sleep(450);

  // --- react execution: real tool sequence ---
  await compactTool("grep", dim('"run command"'), dim("3 matches"));
  await compactTool("read", dim("src/cli/index.ts"), dim("src/cli/index.ts  (210 lines)"));

  await sleep(150);
  w(box("edit", boldYellow("edit"), "✎ src/cli/index.ts", yellow("✎ ") + dim("src/cli/index.ts")));
  await sleep(350);
  w(
    diff([
      "@@ run command @@",
      '   .option("--yes", "Auto-approve all tool confirmations")',
      '+  .option("--json", "Emit the final response as JSON (for piping)")',
      '   .option("--debug", "Emit structured observability events")',
    ]),
  );
  await sleep(650);

  w(
    box("edit", boldYellow("edit"), "✎ src/cli/runner.ts", yellow("✎ ") + dim("src/cli/runner.ts")),
  );
  await sleep(350);
  w(
    diff([
      "@@ runAgentTurn @@",
      "-  process.stdout.write(renderMarkdown(final));",
      "+  if (opts.json) {",
      '+    process.stdout.write(JSON.stringify({ result: final, model, turns }) + "\\n");',
      "+  } else {",
      "+    process.stdout.write(renderMarkdown(final));",
      "+  }",
    ]),
  );
  await sleep(700);

  // --- run the tests (bash box + expanded result) ---
  w(box("bash", boldMagenta("bash"), "❯ npm test", magenta("❯ ") + dim("npm test")));
  await sleep(900);
  w(dim("  ✓ bash   (6 lines)") + "\n");
  for (const line of [
    "> vitest run",
    "✓ src/cli/index.test.ts  (9 tests)",
    "✓ src/cli/runner.test.ts (15 tests)",
    "Test Files  18 passed (18)",
    green("Tests  142 passed (142)"),
    "Duration  3.21s",
  ]) {
    w(dim(`     ${line}`) + "\n");
    await sleep(150);
  }
  await sleep(650);
  w("\n");

  // --- final streamed answer ---
  await think("", 700);
  await stream(
    `Done. ${cyan("opencli run --json")} now prints a single JSON object ` +
      `${dim("{ result, model, turns }")} instead of streamed markdown — pipe it straight into ` +
      `${cyan("jq")}. The streamed view is unchanged without the flag. All ${green("142 tests pass")}.`,
  );
  w("\n");

  w(green("› ") + dim("▏"));
  await sleep(1200);
  w("\n" + CURSOR_SHOW);
}

main();
