const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseScript } = require("../dist/core/parser");
const {
  buildDocumentDiagnosticReport,
  buildHoverMarkdown,
  buildRenameWorkspaceEdit,
  buildSemanticTokens,
  createAddUtf8BomCodeAction,
  createConvertGuiTextToRawTextCodeAction,
  createMissingEventCodeAction,
  createMissingScriptDefinitionCodeAction,
  createMissingLocalizationCodeAction,
  SEMANTIC_TOKEN_TYPES,
} = require("../dist/lsp/features");
const {
  filterModRenameReferences,
  filterModRenameSymbols,
  resolveModRenameTarget,
} = require("../dist/lsp/rename");

const localTempRoot = path.join(os.tmpdir(), "ck3-devkit-lsp-test");
fs.mkdirSync(localTempRoot, { recursive: true });

test("buildSemanticTokens emits token data for script syntax", () => {
  const parsed = parseScript([
    "namespace = sample_mod",
    "sample_mod.0001 = {",
    "  value = 10",
    "  save_scope_as = scope:actor",
    "  change_variable = { name = var:test value = medium_prestige_value }",
    "}",
    "",
  ].join("\n"));

  const tokens = buildSemanticTokens(parsed);
  assert.ok(Array.isArray(tokens.data));
  assert.ok(tokens.data.length > 0);

  const typeIndexes = [];
  for (let index = 3; index < tokens.data.length; index += 5) {
    typeIndexes.push(tokens.data[index]);
  }
  assert.ok(typeIndexes.includes(SEMANTIC_TOKEN_TYPES.indexOf("event")));
  assert.ok(typeIndexes.includes(SEMANTIC_TOKEN_TYPES.indexOf("class")));
  assert.ok(typeIndexes.includes(SEMANTIC_TOKEN_TYPES.indexOf("variable")));
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

test("buildHoverMarkdown includes symbol metadata and snippet", () => {
  const markdown = buildHoverMarkdown(
    {
      name: "medium_prestige_value",
      kind: "script_value",
      path: "D:/game/common/script_values/00_basic_values.txt",
      range: {
        start: { line: 10, character: 0, offset: 100 },
        end: { line: 10, character: 21, offset: 121 },
      },
      containerName: "script_values",
      source: "reference",
    },
    12,
    2,
    "medium_prestige_value = 350"
  );

  assert.match(markdown, /\*\*medium_prestige_value\*\*/);
  assert.match(markdown, /Type: `script_value`/);
  assert.match(markdown, /Definitions: `2`/);
  assert.match(markdown, /References: `12`/);
  assert.match(markdown, /00_basic_values\.txt:11/);
  assert.match(markdown, /```ck3-script/);
});

test("buildHoverMarkdown includes localization text when present", () => {
  const markdown = buildHoverMarkdown(
    {
      name: "sample_key",
      kind: "localization",
      path: "D:/mod/localization/english/sample_l_english.yml",
      range: {
        start: { line: 2, character: 1, offset: 20 },
        end: { line: 2, character: 11, offset: 30 },
      },
      source: "mod",
    },
    3,
    1,
    "sample_key:0 \"Sample text\"",
    "Sample text",
    "l_english"
  );

  assert.match(markdown, /Text: "Sample text"/);
  assert.match(markdown, /Language: `l_english`/);
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

test("createMissingScriptDefinitionCodeAction creates a scripted effect stub", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-lsp-test-"));

  try {
    const effectFile = path.join(tempRoot, "zz_generated_effects.txt");
    const action = createMissingScriptDefinitionCodeAction(
      {
        range: {
          start: { line: 2, character: 10 },
          end: { line: 2, character: 30 },
        },
        message: "Unresolved scripted_effect reference: sample_missing_effect",
      },
      "sample_missing_effect",
      "scripted_effect",
      effectFile
    );

    assert.ok(action);
    assert.match(action.title, /sample_missing_effect/);
    assert.ok(action.edit.documentChanges);
    assert.equal(action.edit.documentChanges[0].kind, "create");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("createAddUtf8BomCodeAction inserts a BOM at the file start", () => {
  const action = createAddUtf8BomCodeAction(
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      message: "Localization files should be saved as UTF-8 with BOM.",
    },
    "file:///D:/mod/localization/english/sample_l_english.yml"
  );

  assert.equal(action.title, "Add UTF-8 BOM");
  assert.equal(action.edit.changes["file:///D:/mod/localization/english/sample_l_english.yml"][0].newText, "\uFEFF");
});

test("createConvertGuiTextToRawTextCodeAction rewrites text assignments", () => {
  const action = createConvertGuiTextToRawTextCodeAction(
    {
      range: {
        start: { line: 4, character: 2 },
        end: { line: 4, character: 18 },
      },
      message: "Unresolved localization reference: literal_text",
    },
    "file:///D:/mod/gui/sample.gui",
    "literal_text",
    4,
    2,
    6,
    9,
    21
  );

  assert.equal(action.edit.changes["file:///D:/mod/gui/sample.gui"].length, 2);
  assert.equal(action.edit.changes["file:///D:/mod/gui/sample.gui"][0].newText, "raw_text");
  assert.equal(action.edit.changes["file:///D:/mod/gui/sample.gui"][1].newText, "\"literal_text\"");
});

test("createMissingEventCodeAction creates an event stub", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-lsp-test-"));

  try {
    const eventFile = path.join(tempRoot, "sample_mod_events.txt");
    const action = createMissingEventCodeAction(
      {
        range: {
          start: { line: 1, character: 6 },
          end: { line: 1, character: 21 },
        },
        message: "Unresolved event reference: sample_mod.9001",
      },
      "sample_mod.9001",
      eventFile
    );

    assert.ok(action);
    assert.match(action.title, /sample_mod\.9001/);
    assert.ok(action.edit.documentChanges);
    assert.equal(action.edit.documentChanges[0].kind, "create");
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

test("resolveModRenameTarget rejects ambiguous mod definitions", () => {
  const target = resolveModRenameTarget(
    { kind: "scripted_effect", source: "mod" },
    [
      {
        name: "shared_name",
        kind: "scripted_effect",
        path: "D:/mod/common/scripted_effects/a.txt",
        range: {
          start: { line: 0, character: 0, offset: 0 },
          end: { line: 0, character: 11, offset: 11 },
        },
        source: "mod",
      },
      {
        name: "shared_name",
        kind: "scripted_effect",
        path: "D:/mod/common/scripted_effects/b.txt",
        range: {
          start: { line: 0, character: 0, offset: 0 },
          end: { line: 0, character: 11, offset: 11 },
        },
        source: "mod",
      },
    ]
  );

  assert.equal(target, null);
});

test("rename filtering stays inside mod files", () => {
  const target = resolveModRenameTarget(
    { kind: "localization", source: "mod" },
    [
      {
        name: "battle_key",
        kind: "localization",
        path: "D:/mod/localization/english/sample_l_english.yml",
        range: {
          start: { line: 1, character: 1, offset: 12 },
          end: { line: 1, character: 11, offset: 22 },
        },
        source: "mod",
      },
      {
        name: "battle_key",
        kind: "localization",
        path: "D:/game/localization/english/base_l_english.yml",
        range: {
          start: { line: 1, character: 1, offset: 12 },
          end: { line: 1, character: 11, offset: 22 },
        },
        source: "reference",
      },
    ]
  );

  assert.ok(target);
  const symbols = filterModRenameSymbols(
    [
      {
        name: "battle_key",
        kind: "localization",
        path: "D:/mod/localization/english/sample_l_english.yml",
        range: {
          start: { line: 1, character: 1, offset: 12 },
          end: { line: 1, character: 11, offset: 22 },
        },
        source: "mod",
      },
      {
        name: "battle_key",
        kind: "localization",
        path: "D:/game/localization/english/base_l_english.yml",
        range: {
          start: { line: 1, character: 1, offset: 12 },
          end: { line: 1, character: 11, offset: 22 },
        },
        source: "reference",
      },
    ],
    target
  );
  const references = filterModRenameReferences(
    [
      {
        name: "battle_key",
        kind: "localization",
        path: "D:/mod/events/sample.txt",
        range: {
          start: { line: 4, character: 10, offset: 42 },
          end: { line: 4, character: 20, offset: 52 },
        },
        source: "mod",
      },
      {
        name: "battle_key",
        kind: "localization",
        path: "D:/game/events/base.txt",
        range: {
          start: { line: 4, character: 10, offset: 42 },
          end: { line: 4, character: 20, offset: 52 },
        },
        source: "reference",
      },
    ],
    target
  );

  assert.equal(symbols.length, 1);
  assert.equal(references.length, 1);
  assert.match(symbols[0].path, /sample_l_english/);
  assert.match(references[0].path, /sample\.txt/);
});
