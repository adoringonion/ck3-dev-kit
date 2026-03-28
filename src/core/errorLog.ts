import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WorkspaceIndex } from "./indexer";

export interface ErrorLogAnalysisOptions {
  logPath: string;
  modRoots: string[];
  referenceRoots: string[];
  index?: WorkspaceIndex;
}

export interface ErrorLogFinding {
  severity: "error" | "warning" | "info";
  category: "localization" | "encoding" | "script" | "descriptor" | "other";
  source: string;
  message: string;
  occurrences: number;
  logLine: number;
  gamePath: string | null;
  absolutePath: string | null;
  fileLine: number | null;
  symbol: string | null;
  modRelated: boolean;
  suggestion: string | null;
  raw: string;
}

export interface ErrorLogAnalysisResult {
  ok: boolean;
  file: string;
  totalLines: number;
  parsedLines: number;
  findings: ErrorLogFinding[];
  summary: {
    totalFindings: number;
    modRelatedFindings: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
}

interface ParsedLogEntry {
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
  logLine: number;
  raw: string;
}

interface PathMatch {
  gamePath: string | null;
  fileLine: number | null;
}

export function analyzeErrorLogFile(options: ErrorLogAnalysisOptions): ErrorLogAnalysisResult {
  const resolvedLogPath = path.resolve(options.logPath);
  const text = fs.readFileSync(resolvedLogPath, "utf8");
  return analyzeErrorLogText(text, {
    ...options,
    logPath: resolvedLogPath,
  });
}

export function analyzeErrorLogText(text: string, options: ErrorLogAnalysisOptions): ErrorLogAnalysisResult {
  const lines = text.split(/\r?\n/);
  const findings = new Map<string, ErrorLogFinding>();
  let parsedLines = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) {
      continue;
    }
    const parsed = parseLogLine(raw, index + 1);
    if (!parsed) {
      continue;
    }
    parsedLines += 1;

    const pathMatch = extractPathMatch(parsed.message);
    const resolved = resolveGamePath(pathMatch.gamePath, options.modRoots, options.referenceRoots);
    const category = inferCategory(parsed.source, parsed.message);
    const symbol = extractSymbol(parsed.message, category);
    const modRelated = resolved.source === "mod" || Boolean(pathMatch.gamePath?.startsWith("mod/"));
    const suggestion = buildSuggestion(category, symbol, modRelated, resolved.absolutePath, options.index);
    const key = [
      category,
      parsed.source,
      normalizeDedup(parsed.message),
      pathMatch.gamePath ?? "",
      pathMatch.fileLine ?? "",
      symbol ?? "",
      modRelated ? "mod" : "other",
    ].join("|");

    const existing = findings.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }

    findings.set(key, {
      severity: parsed.severity,
      category,
      source: parsed.source,
      message: parsed.message,
      occurrences: 1,
      logLine: parsed.logLine,
      gamePath: pathMatch.gamePath,
      absolutePath: resolved.absolutePath,
      fileLine: pathMatch.fileLine,
      symbol,
      modRelated,
      suggestion,
      raw: parsed.raw,
    });
  }

  const findingList = Array.from(findings.values()).sort(compareFindings);
  const errorCount = findingList.filter((entry) => entry.severity === "error").length;
  const warningCount = findingList.filter((entry) => entry.severity === "warning").length;
  const infoCount = findingList.filter((entry) => entry.severity === "info").length;
  const modRelatedFindings = findingList.filter((entry) => entry.modRelated).length;

  return {
    ok: modRelatedFindings === 0,
    file: path.resolve(options.logPath),
    totalLines: lines.length,
    parsedLines,
    findings: findingList,
    summary: {
      totalFindings: findingList.length,
      modRelatedFindings,
      errorCount,
      warningCount,
      infoCount,
    },
  };
}

export function defaultCk3ErrorLogPath(): string {
  return path.join(os.homedir(), "Documents", "Paradox Interactive", "Crusader Kings III", "logs", "error.log");
}

function parseLogLine(raw: string, logLine: number): ParsedLogEntry | null {
  const match = raw.match(/^\[[^\]]+\]\[([EWI])\]\[([^\]]+)\]:\s*(.*)$/);
  if (!match) {
    return null;
  }
  return {
    severity: match[1] === "E" ? "error" : match[1] === "W" ? "warning" : "info",
    source: match[2],
    message: match[3],
    logLine,
    raw,
  };
}

function extractPathMatch(message: string): PathMatch {
  const patterns: RegExp[] = [
    /(?:^| )at ([^:"]+\.[A-Za-z0-9_]+):(\d+)/,
    /file:\s+"([^"]+)"\s+near line:\s+(\d+)/,
    /file:\s+([^"\s]+)\s+line:\s+(\d+)/,
    /Near file:\s+([^"\s]+)\s+line:\s+(\d+)/,
    /File '([^']+)'/,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) {
      continue;
    }
    return {
      gamePath: normalizeGamePath(match[1]),
      fileLine: match[2] ? Number(match[2]) : null,
    };
  }

  return {
    gamePath: null,
    fileLine: null,
  };
}

function normalizeGamePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function resolveGamePath(
  gamePath: string | null,
  modRoots: string[],
  referenceRoots: string[]
): { source: "mod" | "reference" | null; absolutePath: string | null } {
  if (!gamePath) {
    return { source: null, absolutePath: null };
  }

  for (const root of modRoots) {
    const candidate = path.join(root, ...gamePath.split("/"));
    if (fs.existsSync(candidate)) {
      return { source: "mod", absolutePath: candidate };
    }
  }

  for (const root of referenceRoots) {
    const candidate = path.join(root, ...gamePath.split("/"));
    if (fs.existsSync(candidate)) {
      return { source: "reference", absolutePath: candidate };
    }
  }

  return { source: null, absolutePath: null };
}

function inferCategory(source: string, message: string): ErrorLogFinding["category"] {
  if (source.includes("localize") || message.includes("Unlocalized text") || message.includes("Unrecognized loc key")) {
    return "localization";
  }
  if (message.includes("utf8-bom encoding")) {
    return "encoding";
  }
  if (source.includes("persistent_reader") || message.includes("Unknown effect:") || message.includes("Unexpected token:")) {
    return "script";
  }
  if (source.includes("dlc_descriptor")) {
    return "descriptor";
  }
  return "other";
}

function extractSymbol(message: string, category: ErrorLogFinding["category"]): string | null {
  if (category !== "localization") {
    return null;
  }
  const quoted = message.match(/'(.*?)'/);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const unquoted = message.match(/Unrecognized loc key ([^. ]+)/);
  return unquoted?.[1] ?? null;
}

function buildSuggestion(
  category: ErrorLogFinding["category"],
  symbol: string | null,
  modRelated: boolean,
  absolutePath: string | null,
  index?: WorkspaceIndex
): string | null {
  if (category === "localization") {
    if (symbol && !hasLocalizationSymbol(index, symbol)) {
      return "対応する localization key が見つかりません。mod の localization/*.yml に追加してください。";
    }
    if (modRelated && absolutePath?.toLowerCase().endsWith(".gui")) {
      return "GUI text に loc key を使う場合は localization 定義を追加し、固定文字列なら raw_text を検討してください。";
    }
    if (modRelated) {
      return "参照している loc key が mod 側で定義されているか確認してください。";
    }
    return null;
  }

  if (category === "encoding" && modRelated) {
    return "このファイルを UTF-8 with BOM で保存してください。";
  }

  if (category === "script" && modRelated) {
    return "構文か effect 名が壊れています。該当行周辺の braces と key 名を見直してください。";
  }

  if (category === "descriptor" && modRelated) {
    return "descriptor.mod / .mod の supported_version を現在の CK3 バージョンに合わせてください。";
  }

  return null;
}

function hasLocalizationSymbol(index: WorkspaceIndex | undefined, symbol: string): boolean {
  if (!index) {
    return false;
  }
  return (index.symbols.get(symbol) ?? []).some((entry) => entry.kind === "localization");
}

function normalizeDedup(message: string): string {
  return message.replace(/\[args#[0-9]+\]/g, "[args]").trim();
}

function compareFindings(left: ErrorLogFinding, right: ErrorLogFinding): number {
  const severityRank = rankSeverity(left.severity) - rankSeverity(right.severity);
  if (severityRank !== 0) {
    return severityRank;
  }
  if (left.modRelated !== right.modRelated) {
    return left.modRelated ? -1 : 1;
  }
  if (left.occurrences !== right.occurrences) {
    return right.occurrences - left.occurrences;
  }
  return left.logLine - right.logLine;
}

function rankSeverity(severity: ErrorLogFinding["severity"]): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    default:
      return 2;
  }
}
