const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildCachedWorkspaceIndex } = require("../dist/cli-shared");
const { parseScript } = require("../dist/core/parser");
const { parseLocalization } = require("../dist/core/localization");
const { collectDocumentDiagnostics } = require("../dist/core/diagnostics");
const { createWorkspaceIndex } = require("../dist/core/indexer");
const { analyzeErrorLogText } = require("../dist/core/errorLog");
const { validateParsedDocumentAgainstIndex } = require("../dist/core/references");
const { inferCompletionContext } = require("../dist/extension/completion");
const { getDynamicReferenceHelp, getScriptSyntaxHelp } = require("../dist/extension/dynamicReferenceHelp");
const { resolveConfiguredSource } = require("../dist/extension/sourceResolution");
const localTempRoot = path.join(os.tmpdir(), "ck3-devkit-test");

fs.mkdirSync(localTempRoot, { recursive: true });

test("parseScript reads namespace and event blocks", () => {
  const parsed = parseScript(`
namespace = sample_mod

sample_mod.0001 = {
  type = character_event
  title = sample_mod.0001.t
}
`);

  assert.equal(parsed.kind, "script");
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].key, "namespace");
  assert.equal(parsed.entries[1].key, "sample_mod.0001");
  assert.equal(parsed.entries[1].value.kind, "object");
});

test("parseScript reports unclosed blocks", () => {
  const parsed = parseScript(`
broken_event = {
  title = broken_event.t
`);

  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].message, /Missing closing '\}'/);
});

test("parseLocalization extracts language and entries", () => {
  const parsed = parseLocalization(`
l_english:
 sample.key:0 "Hello"
 sample.other:0 "World"
`);

  assert.equal(parsed.language, "l_english");
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.key),
    ["sample.key", "sample.other"]
  );
});

test("collectDocumentDiagnostics flags suspicious localization references", () => {
  const parsed = parseScript(`
sample_event = {
  title = "not a loc key"
}
`);

  const diagnostics = collectDocumentDiagnostics(parsed);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "info");
  assert.match(diagnostics[0].message, /should not contain spaces/);
});

test("createWorkspaceIndex classifies event and scripted effect symbols", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-test-"));

  try {
    const modRoot = path.join(tempRoot, "mod_dev");
    const eventsDir = path.join(modRoot, "events");
    const effectsDir = path.join(modRoot, "common", "scripted_effects");
    const opinionModifiersDir = path.join(modRoot, "common", "opinion_modifiers");
    const traitsDir = path.join(modRoot, "common", "traits");
    const culturesDir = path.join(modRoot, "common", "culture", "cultures");
    const traditionsDir = path.join(modRoot, "common", "culture", "traditions");
    const pillarsDir = path.join(modRoot, "common", "culture", "pillars");
    const doctrinesDir = path.join(modRoot, "common", "religion", "doctrines");
    const religionsDir = path.join(modRoot, "common", "religion", "religions");
    const scriptValuesDir = path.join(modRoot, "common", "script_values");
    const locDir = path.join(modRoot, "localization", "english");
    const nestedLocDir = path.join(modRoot, "localization", "english", "dlc", "ce1");

    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(effectsDir, { recursive: true });
    fs.mkdirSync(opinionModifiersDir, { recursive: true });
    fs.mkdirSync(traitsDir, { recursive: true });
    fs.mkdirSync(culturesDir, { recursive: true });
    fs.mkdirSync(traditionsDir, { recursive: true });
    fs.mkdirSync(pillarsDir, { recursive: true });
    fs.mkdirSync(doctrinesDir, { recursive: true });
    fs.mkdirSync(religionsDir, { recursive: true });
    fs.mkdirSync(scriptValuesDir, { recursive: true });
    fs.mkdirSync(locDir, { recursive: true });
    fs.mkdirSync(nestedLocDir, { recursive: true });

    fs.writeFileSync(
      path.join(eventsDir, "sample_events.txt"),
      [
        "namespace = sample_mod",
        "",
        "sample_mod.0001 = {",
        "  title = sample_mod.0001.t",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(effectsDir, "sample_effects.txt"),
      [
        "sample_apply_bonus_effect = {",
        "  add_gold = 10",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(opinionModifiersDir, "sample_opinions.txt"),
      [
        "contributed_in_war = {",
        "  opinion = 10",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(traitsDir, "sample_traits.txt"),
      [
        "brave = {",
        "  desc = brave_desc",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(culturesDir, "sample_culture.txt"),
      [
        "sample_culture = {",
        "  ethos = ethos_bellicose",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(traditionsDir, "sample_traditions.txt"),
      [
        "tradition_example = {",
        "  category = societal",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(pillarsDir, "sample_pillars.txt"),
      [
        "heritage_example = {",
        "  type = heritage",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(doctrinesDir, "sample_doctrines.txt"),
      [
        "doctrine_group_example = {",
        "  group = \"example\"",
        "  doctrine_example = {",
        "    piety_cost = { value = 1 }",
        "    parameters = {",
        "      example_parameter = yes",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(religionsDir, "sample_religion.txt"),
      [
        "sample_religion = {",
        "  faiths = {",
        "    sample_faith = {",
        "      doctrine = doctrine_example",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(scriptValuesDir, "sample_values.txt"),
      [
        "medium_prestige_value = 150",
        "major_prestige_value = {",
        "  value = 350",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(locDir, "sample_l_english.yml"),
      [
        "l_english:",
        " sample_mod.0001.t:0 \"Sample Title\"",
        "",
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(nestedLocDir, "sample_legends_l_english.yml"),
      [
        "l_english:",
        " heroic_legend_seed_drop.t:0 \"New legend seed available\"",
        "",
      ].join("\n"),
      "utf8"
    );

    const index = createWorkspaceIndex({
      modRoots: [modRoot],
      referenceRoots: [],
      maxFiles: 100,
    });

    const eventSymbol = index.symbols.get("sample_mod.0001");
    const effectSymbol = index.symbols.get("sample_apply_bonus_effect");
    const locSymbol = index.symbols.get("sample_mod.0001.t");
    const traitSymbol = index.symbols.get("brave");
    const cultureSymbol = index.symbols.get("sample_culture");
    const traditionSymbol = index.symbols.get("tradition_example");
    const pillarSymbol = index.symbols.get("heritage_example");
    const doctrineSymbol = index.symbols.get("doctrine_example");
    const doctrineParameterSymbol = index.symbols.get("example_parameter");
    const faithSymbol = index.symbols.get("sample_faith");
    const opinionModifierSymbol = index.symbols.get("contributed_in_war");
    const scriptValueSymbol = index.symbols.get("medium_prestige_value");
    const nestedLocSymbol = index.symbols.get("heroic_legend_seed_drop.t");

    assert.ok(eventSymbol);
    assert.equal(eventSymbol[0].kind, "event");
    assert.equal(eventSymbol[0].containerName, "events");

    assert.ok(effectSymbol);
    assert.equal(effectSymbol[0].kind, "scripted_effect");
    assert.equal(effectSymbol[0].containerName, "scripted_effects");

    assert.ok(locSymbol);
    assert.ok(locSymbol.some((entry) => entry.kind === "localization"));

    assert.ok(traitSymbol);
    assert.equal(traitSymbol[0].kind, "trait");

    assert.ok(cultureSymbol);
    assert.equal(cultureSymbol[0].kind, "culture");

    assert.ok(traditionSymbol);
    assert.equal(traditionSymbol[0].kind, "cultural_tradition");

    assert.ok(pillarSymbol);
    assert.equal(pillarSymbol[0].kind, "cultural_pillar");

    assert.ok(doctrineSymbol);
    assert.equal(doctrineSymbol[0].kind, "doctrine");

    assert.ok(doctrineParameterSymbol);
    assert.equal(doctrineParameterSymbol[0].kind, "doctrine_parameter");

    assert.ok(faithSymbol);
    assert.equal(faithSymbol[0].kind, "faith");

    assert.ok(opinionModifierSymbol);
    assert.equal(opinionModifierSymbol[0].kind, "modifier");

    assert.ok(scriptValueSymbol);
    assert.equal(scriptValueSymbol[0].kind, "script_value");

    assert.ok(nestedLocSymbol);
    assert.ok(nestedLocSymbol.some((entry) => entry.kind === "localization"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("createWorkspaceIndex discovers CK3 content inside a mod workspace root", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-workspace-test-"));

  try {
    const workspaceRoot = path.join(tempRoot, "mod_dev");
    const modRoot = path.join(workspaceRoot, "example_mod");
    const effectsDir = path.join(modRoot, "common", "scripted_effects");

    fs.mkdirSync(effectsDir, { recursive: true });
    fs.writeFileSync(path.join(modRoot, "descriptor.mod"), 'name="Example Mod"\n', "utf8");
    fs.writeFileSync(
      path.join(effectsDir, "sample_effects.txt"),
      [
        "sample_apply_bonus_effect = {",
        "  add_gold = 10",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    const index = createWorkspaceIndex({
      modRoots: [workspaceRoot],
      referenceRoots: [],
      maxFiles: 100,
    });

    const effectSymbol = index.symbols.get("sample_apply_bonus_effect");
    assert.ok(effectSymbol);
    assert.equal(effectSymbol[0].kind, "scripted_effect");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validateParsedDocumentAgainstIndex ignores variable-style name keys", () => {
  const parsed = parseScript(`
sample_effect = {
  set_variable = {
    name = mod_dev_ancient_superweapon_holder
    value = yes
  }
  option = {
    name = sample_effect.0001.a
  }
}
`);

  const index = {
    symbols: new Map([
      ["sample_effect.0001.a", [{ kind: "localization", name: "sample_effect.0001.a", path: "<test>", range: parsed.range, source: "mod" }]],
    ]),
    references: new Map(),
    documents: new Map(),
    files: [],
  };

  const diagnostics = validateParsedDocumentAgainstIndex(parsed, index);
  assert.equal(diagnostics.length, 0);
});

test("validateParsedDocumentAgainstIndex accepts modifier definitions indexed generically", () => {
  const parsed = parseScript(`
sample_effect = {
  opinion = {
    modifier = contributed_in_war
  }
}
`);

  const index = {
    symbols: new Map([
      ["contributed_in_war", [{ kind: "definition", name: "contributed_in_war", path: "<test>", range: parsed.range, source: "reference" }]],
    ]),
    references: new Map(),
    documents: new Map(),
    files: [],
  };

  const diagnostics = validateParsedDocumentAgainstIndex(parsed, index);
  assert.equal(diagnostics.length, 0);
});

test("validateParsedDocumentAgainstIndex ignores dynamic variable and scope references", () => {
  const parsed = parseScript(`
sample_effect = {
  culture = var:dynamic_culture
  faith = global_var:dynamic_faith
  heritage = scope:culture_pillar
  has_doctrine = event_target:chosen_doctrine
  has_doctrine_parameter = named_script_value:chosen_parameter
}
`);

  const index = {
    symbols: new Map(),
    references: new Map(),
    documents: new Map(),
    files: [],
  };

  const diagnostics = validateParsedDocumentAgainstIndex(parsed, index);
  assert.equal(diagnostics.length, 0);
});

test("validateParsedDocumentAgainstIndex ignores dotted runtime scope references", () => {
  const parsed = parseScript(`
sample_effect = {
  culture = root.culture
  faith = prev.faith
  heritage = this.culture
}
`);

  const diagnostics = validateParsedDocumentAgainstIndex(parsed, {
    symbols: new Map(),
    references: new Map(),
    documents: new Map(),
    files: [],
  });

  assert.equal(diagnostics.length, 0);
});

test("getDynamicReferenceHelp explains dynamic reference prefixes", () => {
  const variableHelp = getDynamicReferenceHelp("var:selected_culture");
  const scopeHelp = getDynamicReferenceHelp("scope:actor");
  const staticHelp = getDynamicReferenceHelp("doctrine:pluralism");

  assert.equal(variableHelp.id, "var");
  assert.match(variableHelp.summary, /スクリプト変数/);
  assert.equal(scopeHelp.id, "scope");
  assert.match(scopeHelp.title, /Scope Reference/);
  assert.equal(staticHelp, null);
});

test("getScriptSyntaxHelp explains surrounding variable syntax", () => {
  const setVariableHelp = getScriptSyntaxHelp("set_variable", { isKey: true, parents: [] });
  const saveScopeHelp = getScriptSyntaxHelp("save_scope_as", { isKey: true, parents: [] });
  const existsHelp = getScriptSyntaxHelp("exists", { isKey: true, parents: [] });

  assert.equal(setVariableHelp.id, "set_variable");
  assert.match(setVariableHelp.summary, /変数/);
  assert.equal(saveScopeHelp.id, "save_scope_as");
  assert.match(saveScopeHelp.summary, /スコープ/);
  assert.equal(existsHelp.id, "exists");
  assert.match(existsHelp.summary, /存在/);
});

test("getScriptSyntaxHelp limits generic key help to relevant parents", () => {
  const genericNameHelp = getScriptSyntaxHelp("name", { isKey: true, parents: [] });
  const variableNameHelp = getScriptSyntaxHelp("name", { isKey: true, parents: ["set_variable"] });
  const valueAsScalarHelp = getScriptSyntaxHelp("value", { isKey: false, parents: ["set_variable"] });

  assert.equal(genericNameHelp, null);
  assert.equal(variableNameHelp.id, "name");
  assert.equal(valueAsScalarHelp, null);
});

test("resolveConfiguredSource uses configured roots instead of path heuristics", () => {
  const config = {
    modRoots: ["D:/mods/example_gameplay"],
    referenceRoots: ["D:/reference/ck3-base"],
    maxFiles: 100,
    errorLogPath: "D:/Users/example/Documents/Paradox Interactive/Crusader Kings III/logs/error.log",
  };

  assert.equal(resolveConfiguredSource("D:/mods/example_gameplay/events/test.txt", config), "mod");
  assert.equal(resolveConfiguredSource("D:/reference/ck3-base/events/test.txt", config), "reference");
  assert.equal(resolveConfiguredSource("D:/mods/gameplay_tool/events/test.txt", config), null);
});

test("analyzeErrorLogText groups mod-related findings and suggests fixes", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-test-"));

  try {
    const modRoot = path.join(tempRoot, "mod_dev");
    const referenceRoot = path.join(tempRoot, "game");
    const guiDir = path.join(modRoot, "gui");
    const locDir = path.join(modRoot, "localization", "english");
    const onActionDir = path.join(modRoot, "common", "on_action");

    fs.mkdirSync(guiDir, { recursive: true });
    fs.mkdirSync(locDir, { recursive: true });
    fs.mkdirSync(onActionDir, { recursive: true });

    fs.writeFileSync(path.join(guiDir, "sample.gui"), "text = sample_missing_key\n", "utf8");
    fs.writeFileSync(path.join(locDir, "sample_l_english.yml"), "l_english:\n sample_existing_key:0 \"Hello\"\n", "utf8");
    fs.writeFileSync(path.join(onActionDir, "sample_on_actions.txt"), "broken = yes\n", "utf8");

    const index = createWorkspaceIndex({
      modRoots: [modRoot],
      referenceRoots: [referenceRoot],
    });

    const analysis = analyzeErrorLogText(
      [
        "[10:10:06][E][pdx_gui_localize.cpp:207]: Unlocalized text 'sample_missing_key' at gui/sample.gui:12, either localize it or use the raw_text property instead of text",
        "[10:10:06][E][pdx_gui_localize.cpp:207]: Unlocalized text 'sample_missing_key' at gui/sample.gui:12, either localize it or use the raw_text property instead of text",
        "[10:10:27][E][pdx_persistent_reader.cpp:216]: Error: \"Unknown effect: random_events, near line: 57\" in file: \"common/on_action/sample_on_actions.txt\" near line: 65",
      ].join("\n"),
      {
        logPath: path.join(tempRoot, "error.log"),
        modRoots: [modRoot],
        referenceRoots: [referenceRoot],
        index,
      }
    );

    assert.equal(analysis.ok, false);
    assert.equal(analysis.summary.modRelatedFindings, 2);
    assert.equal(analysis.findings[0].occurrences, 2);
    assert.equal(analysis.findings[0].category, "localization");
    assert.match(analysis.findings[0].suggestion, /localization key/);
    assert.equal(analysis.findings[1].category, "script");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inferCompletionContext resolves right-hand completion kinds", () => {
  const locContext = inferCompletionContext("  title = sample_mod.", "sample_mod.0001 = {\n  title = sample_mod.");
  const eventContext = inferCompletionContext("    id = sample_mod.", "  trigger_event = {\n    id = sample_mod.");
  const traitContext = inferCompletionContext("    add_trait = bra", "  immediate = {\n    add_trait = bra");

  assert.deepEqual(locContext, { kinds: ["localization"], query: "sample_mod." });
  assert.deepEqual(eventContext, { kinds: ["event"], query: "sample_mod." });
  assert.deepEqual(traitContext, { kinds: ["trait"], query: "bra" });
});

test("inferCompletionContext handles prefixed and scripted callable completions", () => {
  const doctrineContext = inferCompletionContext("    doctrine:doc", "  immediate = {\n    doctrine:doc");
  const effectContext = inferCompletionContext("    sample_apply_bonus_effect", "  immediate = {\n    sample_apply_bonus_effect");
  const partialCallableContext = inferCompletionContext("    sample_app", "  immediate = {\n    sample_app");

  assert.deepEqual(doctrineContext, {
    kinds: ["doctrine"],
    prefix: "doctrine:",
    query: "doc",
  });
  assert.deepEqual(effectContext, {
    kinds: ["scripted_effect"],
    query: "sample_apply_bonus_effect",
  });
  assert.deepEqual(partialCallableContext, {
    kinds: ["scripted_effect", "scripted_trigger"],
    query: "sample_app",
  });
});

test("buildCachedWorkspaceIndex refreshes reference roots when files change", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-cache-test-"));
  const modRoot = path.join(tempRoot, "mod");
  const referenceRoot = path.join(tempRoot, "game");
  const referenceEventsDir = path.join(referenceRoot, "events");

  fs.mkdirSync(modRoot, { recursive: true });
  fs.mkdirSync(referenceEventsDir, { recursive: true });

  try {
    const referenceFile = path.join(referenceEventsDir, "reference_events.txt");
    fs.writeFileSync(referenceFile, "namespace = sample_mod\nsample_mod.0001 = { }\n", "utf8");

    const firstIndex = buildCachedWorkspaceIndex({
      modRoots: [modRoot],
      referenceRoots: [referenceRoot],
      maxFiles: 100,
    });

    assert.ok(firstIndex.symbols.get("sample_mod.0001"));

    fs.writeFileSync(referenceFile, "namespace = sample_mod\nsample_mod.0002 = { }\n", "utf8");

    const secondIndex = buildCachedWorkspaceIndex({
      modRoots: [modRoot],
      referenceRoots: [referenceRoot],
      maxFiles: 100,
    });

    assert.equal(secondIndex.symbols.has("sample_mod.0001"), false);
    assert.ok(secondIndex.symbols.get("sample_mod.0002"));
  } finally {
    fs.rmSync(path.join(process.cwd(), ".cache"), { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildCachedWorkspaceIndex can trust reference caches for fast startup", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-trusted-ref-cache-test-"));
  const modRoot = path.join(tempRoot, "mod");
  const referenceRoot = path.join(tempRoot, "game");
  const referenceEventsDir = path.join(referenceRoot, "events");

  fs.mkdirSync(modRoot, { recursive: true });
  fs.mkdirSync(referenceEventsDir, { recursive: true });

  try {
    const referenceFile = path.join(referenceEventsDir, "reference_events.txt");
    fs.writeFileSync(referenceFile, "namespace = sample_mod\nsample_mod.0001 = { }\n", "utf8");

    buildCachedWorkspaceIndex({
      modRoots: [modRoot],
      referenceRoots: [referenceRoot],
      maxFiles: 100,
    });

    fs.writeFileSync(referenceFile, "namespace = sample_mod\nsample_mod.0002 = { }\n", "utf8");

    const trustedIndex = buildCachedWorkspaceIndex({
      modRoots: [modRoot],
      referenceRoots: [referenceRoot],
      maxFiles: 100,
      trustReferenceCaches: true,
    });

    assert.ok(trustedIndex.symbols.has("sample_mod.0001"));
    assert.ok(!trustedIndex.symbols.has("sample_mod.0002"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), ".cache"), { recursive: true, force: true });
  }
});

test("buildCachedWorkspaceIndex preserves parsed documents through cache hydration", () => {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-doc-cache-test-"));
  const modRoot = path.join(tempRoot, "mod");
  const eventsDir = path.join(modRoot, "events");

  fs.mkdirSync(eventsDir, { recursive: true });

  try {
    const eventFile = path.join(eventsDir, "sample_events.txt");
    fs.writeFileSync(eventFile, "namespace = sample_mod\nsample_mod.0001 = { }\n", "utf8");

    buildCachedWorkspaceIndex({
      modRoots: [modRoot],
      referenceRoots: [],
      maxFiles: 100,
    });

    const hydratedIndex = buildCachedWorkspaceIndex({
      modRoots: [modRoot],
      referenceRoots: [],
      maxFiles: 100,
    });

    assert.ok(hydratedIndex.documents.has(eventFile));
    assert.equal(hydratedIndex.documents.get(eventFile).kind, "script");
  } finally {
    fs.rmSync(path.join(process.cwd(), ".cache"), { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
