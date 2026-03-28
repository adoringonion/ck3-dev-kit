const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseScript } = require("../dist/core/parser");
const {
  buildDocumentDiagnosticReport,
  buildRenameWorkspaceEdit,
  buildSemanticTokens,
  createMissingLocalizationCodeAction,
} = require("../dist/lsp/features");

const localTempRoot = path.join(os.tmpdir(), "ck3-devkit-lsp-test");
fs.mkdirSync(localTempRoot, { recursive: true });

test("buildSemanticTokens emits token data for script syntax", () => {
  const parsed = parseScript([
    "namespace = sample_mod",
    "sample_mod.0001 = {",
    "  value = 10",
    "}",
    "",
  ].join("\n"));

  const tokens = buildSemanticTokens(parsed);
  assert.ok(Array.isArray(tokens.data));
  assert.ok(tokens.data.length > 0);
});

test("buildRenameWorkspaceEdit rewrites symbols and references", () => {
  const edit = buildRenameWorkspaceEdit(
    "new_key",
    [
      {
        name: "old_key",
        kind: "localization",
        path: "D:/mod/localization/english/sample_l_english.yml",
        range: {
          start: { line: 1, character: 1, offset: 12 },
          end: { line: 1, character: 8, offset: 19 },
        },
        source: "mod",
      },
    ],
    [
      {
        path: "D:/mod/events/sample.txt",
        range: {
          start: { line: 4, character: 10, offset: 42 },
          end: { line: 4, character: 17, offset: 49 },
        },
      },
    ]
  );

  assert.equal(Object.keys(edit.changes).length, 2);
});

test("createMissingLocalizationCodeAction inserts a loc stub", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-lsp-test-"));

  try {
    const locFile = path.join(tempRoot, "sample_l_english.yml");
    fs.writeFileSync(locFile, "l_english:\n", "utf8");
    const action = createMissingLocalizationCodeAction(
      {
        range: {
          start: { line: 2, character: 10 },
          end: { line: 2, character: 21 },
        },
        message: "Unresolved localization reference: missing_key",
      },
      "missing_key",
      locFile
    );

    assert.ok(action);
    assert.match(action.title, /missing_key/);
    assert.equal(Object.keys(action.edit.changes).length, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildDocumentDiagnosticReport wraps diagnostics as full report", () => {
  const report = buildDocumentDiagnosticReport([
    {
      severity: 2,
      message: "Example",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    },
  ]);

  assert.equal(report.kind, "full");
  assert.equal(report.items.length, 1);
});
