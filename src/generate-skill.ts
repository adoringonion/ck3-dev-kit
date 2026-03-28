import * as fs from "fs";
import * as path from "path";
import { writeError, writeJson } from "./cli-shared";

interface GenerateSkillOptions {
  workspaceRoot: string;
  skillName: string;
  force: boolean;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    writeError("Usage: node dist/generate-skill.js <workspaceRoot> [skillName] [--force]", 1);
  }

  const workspaceRoot = path.resolve(process.cwd(), options.workspaceRoot);
  const toolRoot = path.resolve(__dirname, "..");
  const skillDir = path.join(workspaceRoot, ".codex", "skills", options.skillName);
  const skillPath = path.join(skillDir, "SKILL.md");

  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    writeError("Workspace root does not exist or is not a directory.", 1, workspaceRoot);
  }

  if (fs.existsSync(skillPath) && !options.force) {
    writeError("Skill already exists. Re-run with --force to overwrite.", 1, skillPath);
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, buildSkillMarkdown({
    skillName: options.skillName,
    workspaceRoot,
    toolRoot,
  }), "utf8");

  writeJson({
    ok: true,
    workspaceRoot,
    toolRoot,
    skillName: options.skillName,
    skillPath,
  });
}

function parseArgs(args: string[]): GenerateSkillOptions | null {
  const force = args.includes("--force");
  const positional = args.filter((arg) => arg !== "--force");
  const workspaceRoot = positional[0];
  const skillName = normalizeSkillName(positional[1] ?? "ck3-devkit");

  if (!workspaceRoot) {
    return null;
  }

  return {
    workspaceRoot,
    skillName,
    force,
  };
}

function normalizeSkillName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "ck3-devkit";
}

function buildSkillMarkdown(input: { skillName: string; workspaceRoot: string; toolRoot: string }): string {
  const { skillName, workspaceRoot, toolRoot } = input;
  return `---
name: ${skillName}
description: Use when working on Crusader Kings III mods in this workspace and you need to parse CK3 script files, inspect symbols, or run diagnostics with the local ck3-devkit CLI.
---

# CK3 DevKit

Use this skill when the task is about Crusader Kings III mod files in \`${workspaceRoot}\` and you want machine-readable parser results before editing or reviewing files.

## Workspace

- Mod workspace root: \`${workspaceRoot}\`
- CK3 DevKit root: \`${toolRoot}\`

## Use These Commands

Run commands from \`${toolRoot}\`. For machine-readable output, prefer \`node dist/*.js\` over \`npm run\`, because it avoids npm's extra header lines.

\`\`\`bash
npm run build
node dist/find-symbol.js <symbol> "${workspaceRoot}" "${path.join(workspaceRoot, "../game")}"
node dist/find-references.js <symbol> "${workspaceRoot}" "${path.join(workspaceRoot, "../game")}"
node dist/parse-file.js <file>
node dist/diagnostics.js <file>
node dist/validate-references.js <file> "${workspaceRoot}" "${path.join(workspaceRoot, "../game")}"
node dist/validate-references.js "${workspaceRoot}" "${path.join(workspaceRoot, "../game")}"
\`\`\`

## Workflow

1. For a symbol lookup, run \`node dist/find-symbol.js\`.
2. For usages, run \`node dist/find-references.js\`.
3. For AST-like file inspection, run \`node dist/parse-file.js\`.
4. Before or after edits, run \`node dist/diagnostics.js\` and \`node dist/validate-references.js\`.
5. Treat the JSON output as the source of truth for paths, line numbers, and exit status.

## Exit Codes

- \`0\`: success
- \`1\`: command or file error
- \`2\`: not found or diagnostics present

## Notes

- Prefer this tool over ad-hoc regex when you need consistent CK3-aware parsing.
- The CLI emits JSON to stdout, so parse the output instead of relying on terminal formatting.
`;
}

main();
