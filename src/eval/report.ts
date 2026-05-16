export interface MatrixJson {
  timestamp: string;
  providers: string[];
  scenarios: Array<{
    id: string;
    category: string;
    results: Record<string, "pass" | "partial" | "fail">;
  }>;
  passRates: Record<string, number>;
}

export function formatMatrix(
  matrix: Record<string, Record<string, string>>,
  scenarioCategories: Record<string, string>,
  providers: string[],
): { markdown: string; json: MatrixJson } {
  const scenarioIds = Object.keys(matrix).sort();
  const colWidth = Math.max(8, ...providers.map((p) => p.length)) + 2;
  const idWidth = Math.max(12, ...scenarioIds.map((id) => id.length)) + 2;

  const header =
    "| " +
    "Scenario".padEnd(idWidth) +
    " | " +
    providers.map((p) => p.padEnd(colWidth)).join(" | ") +
    " |";
  const sep =
    "|" +
    "-".repeat(idWidth + 2) +
    "|" +
    providers.map(() => "-".repeat(colWidth + 2)).join("|") +
    "|";

  const rows = scenarioIds.map((id) => {
    const cells = providers.map((p) => {
      const s = matrix[id]?.[p] ?? "-";
      const icon = s === "pass" ? "✓" : s === "partial" ? "~" : s === "fail" ? "✗" : "-";
      return `${icon} ${s}`.padEnd(colWidth);
    });
    return "| " + id.padEnd(idWidth) + " | " + cells.join(" | ") + " |";
  });

  const passRates: Record<string, number> = {};
  for (const p of providers) {
    const results = scenarioIds.map((id) => matrix[id]?.[p]);
    const passed = results.filter((r) => r === "pass").length;
    passRates[p] = scenarioIds.length > 0 ? passed / scenarioIds.length : 0;
  }

  const rateRow =
    "| " +
    "Pass rate".padEnd(idWidth) +
    " | " +
    providers.map((p) => `${Math.round(passRates[p] * 100)}%`.padEnd(colWidth)).join(" | ") +
    " |";

  let markdown = [header, sep, ...rows, sep, rateRow].join("\n");

  if (providers.length > 1) {
    const maxRate = Math.max(...Object.values(passRates));
    for (const [p, rate] of Object.entries(passRates)) {
      if (Math.round((maxRate - rate) * 100) > 15) {
        const leader = providers.find((x) => passRates[x] === maxRate) ?? "";
        markdown +=
          `\n\n⚠  ${p} pass rate (${Math.round(rate * 100)}%) is ` +
          `${Math.round((maxRate - rate) * 100)}pp below leading provider ` +
          `(${leader} ${Math.round(maxRate * 100)}%)`;
      }
    }
  }

  const json: MatrixJson = {
    timestamp: new Date().toISOString(),
    providers,
    scenarios: scenarioIds.map((id) => ({
      id,
      category: scenarioCategories[id] ?? "unknown",
      results: (matrix[id] ?? {}) as Record<string, "pass" | "partial" | "fail">,
    })),
    passRates,
  };

  return { markdown, json };
}
