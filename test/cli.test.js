const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const localTempRoot = path.join(os.tmpdir(), "ck3-devkit-cli-test");

fs.mkdirSync(localTempRoot, { recursive: true });

function makeFixtureWorkspace() {
  const tempRoot = fs.mkdtempSync(path.join(localTempRoot, "ck3-devkit-cli-test-"));
  const modRoot = path.join(tempRoot, "mod_dev");
  const referenceRoot = path.join(tempRoot, "game");
  const eventsDir = path.join(modRoot, "events");
  const effectsDir = path.join(modRoot, "common", "scripted_effects");
  const modifiersDir = path.join(modRoot, "common", "modifiers");
  const traitsDir = path.join(modRoot, "common", "traits");
  const culturesDir = path.join(modRoot, "common", "culture", "cultures");
  const traditionsDir = path.join(modRoot, "common", "culture", "traditions");
  const pillarsDir = path.join(modRoot, "common", "culture", "pillars");
  const doctrinesDir = path.join(modRoot, "common", "religion", "doctrines");
  const religionsDir = path.join(modRoot, "common", "religion", "religions");
  const artifactTypesDir = path.join(modRoot, "common", "artifacts", "types");
  const artifactTemplatesDir = path.join(modRoot, "common", "artifacts", "templates");
  const artifactVisualsDir = path.join(modRoot, "common", "artifacts", "visuals");
  const guiDir = path.join(modRoot, "gui");
  const onActionDir = path.join(modRoot, "common", "on_action");
  const scriptValuesDir = path.join(referenceRoot, "common", "script_values");
  const locDir = path.join(modRoot, "localization", "english");

  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(effectsDir, { recursive: true });
  fs.mkdirSync(modifiersDir, { recursive: true });
  fs.mkdirSync(traitsDir, { recursive: true });
  fs.mkdirSync(culturesDir, { recursive: true });
  fs.mkdirSync(traditionsDir, { recursive: true });
  fs.mkdirSync(pillarsDir, { recursive: true });
  fs.mkdirSync(doctrinesDir, { recursive: true });
  fs.mkdirSync(religionsDir, { recursive: true });
  fs.mkdirSync(artifactTypesDir, { recursive: true });
  fs.mkdirSync(artifactTemplatesDir, { recursive: true });
  fs.mkdirSync(artifactVisualsDir, { recursive: true });
  fs.mkdirSync(guiDir, { recursive: true });
  fs.mkdirSync(onActionDir, { recursive: true });
  fs.mkdirSync(scriptValuesDir, { recursive: true });
  fs.mkdirSync(locDir, { recursive: true });
  fs.mkdirSync(referenceRoot, { recursive: true });

  fs.writeFileSync(
    path.join(scriptValuesDir, "00_basic_values.txt"),
    [
      "medium_prestige_value = 150",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(guiDir, "sample.gui"),
    [
      "text = missing.loc.key",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(onActionDir, "sample_on_actions.txt"),
    [
      "broken = yes",
      "",
    ].join("\n"),
    "utf8"
  );

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
    path.join(eventsDir, "broken_events.txt"),
    [
      "broken_event = {",
      "  title = \"not a loc key\"",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(eventsDir, "reference_events.txt"),
    [
      "namespace = sample_mod",
      "",
      "sample_mod.0002 = {",
      "  title = sample_mod.0001.t",
      "  trigger_event = {",
      "    id = sample_mod.0001",
      "  }",
      "  immediate = {",
      "    has_trait = brave",
      "    add_trait = brave",
      "    culture = sample_culture",
      "    has_cultural_tradition = tradition_example",
      "    has_cultural_pillar = heritage_example",
      "    faith = sample_faith",
      "    has_doctrine = doctrine_example",
      "    has_doctrine_parameter = example_parameter",
      "    doctrine:doctrine_example = { is_in_list = selected_doctrines }",
      "    culture_tradition:tradition_example = { is_in_list = traits }",
      "    add_character_modifier = {",
      "      modifier = sample_character_modifier",
      "    }",
      "    capital_county = {",
      "      add_county_modifier = {",
      "        modifier = sample_county_modifier",
      "      }",
      "    }",
      "    create_artifact = {",
      "      type = sample_artifact_type",
      "      template = sample_artifact_template",
      "      visuals = sample_artifact_visual",
      "      modifier = sample_artifact_modifier",
      "    }",
      "    sample_apply_bonus_effect = yes",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(eventsDir, "unresolved_reference_events.txt"),
    [
      "namespace = sample_mod",
      "",
      "sample_mod.0003 = {",
      "  title = missing.loc.key",
      "  trigger_event = {",
      "    id = sample_mod.9999",
      "  }",
      "  immediate = {",
      "    add_trait = missing_trait",
      "    culture = missing_culture",
      "    has_cultural_tradition = missing_tradition",
      "    has_cultural_pillar = missing_pillar",
      "    faith = missing_faith",
      "    has_doctrine = missing_doctrine",
      "    has_doctrine_parameter = missing_parameter",
      "    doctrine:missing_doctrine = { is_in_list = selected_doctrines }",
      "    culture_tradition:missing_tradition = { is_in_list = traits }",
      "    add_character_modifier = {",
      "      modifier = missing_character_modifier",
      "    }",
      "    capital_county = {",
      "      add_county_modifier = {",
      "        modifier = missing_county_modifier",
      "      }",
      "    }",
      "    create_artifact = {",
      "      type = missing_artifact_type",
      "      template = missing_artifact_template",
      "      visuals = missing_artifact_visual",
      "      modifier = missing_artifact_modifier",
      "    }",
      "    missing_bonus_effect = yes",
      "  }",
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
      "      traits = { virtues = { brave } }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(artifactTypesDir, "sample_artifact_types.txt"),
    [
      "sample_artifact_type = {",
      "  slot = miscellaneous",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(artifactTemplatesDir, "sample_artifact_templates.txt"),
    [
      "sample_artifact_template = {",
      "  type = sample_artifact_type",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(artifactVisualsDir, "sample_artifact_visuals.txt"),
    [
      "sample_artifact_visual = {",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(effectsDir, "sample_effects.txt"),
    [
      "sample_apply_bonus_effect = {",
      "  add_character_modifier = {",
      "    modifier = sample_character_modifier",
      "  }",
      "  capital_county = {",
      "    add_county_modifier = {",
      "      modifier = sample_county_modifier",
      "    }",
      "  }",
      "  create_artifact = {",
      "    modifier = sample_artifact_modifier",
      "  }",
      "  add_gold = 10",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    path.join(modifiersDir, "sample_modifiers.txt"),
    [
      "sample_character_modifier = {",
      "  monthly_prestige = 1",
      "}",
      "sample_county_modifier = {",
      "  county_opinion_add = 1",
      "}",
      "sample_artifact_modifier = {",
      "  monthly_prestige = 1",
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
    path.join(locDir, "sample_l_english.yml"),
    [
      "l_english:",
      " sample_mod.0001.t:0 \"Sample Title\"",
      " sample_existing_key:0 \"Existing\"",
      "",
    ].join("\n"),
    "utf8"
  );

  const errorLogFile = path.join(tempRoot, "error.log");
  fs.writeFileSync(
    errorLogFile,
    [
      "[10:10:06][E][pdx_gui_localize.cpp:207]: Unlocalized text 'missing.loc.key' at gui/sample.gui:12, either localize it or use the raw_text property instead of text",
      "[10:10:06][E][pdx_gui_localize.cpp:207]: Unlocalized text 'missing.loc.key' at gui/sample.gui:12, either localize it or use the raw_text property instead of text",
      "[10:10:27][E][pdx_persistent_reader.cpp:216]: Error: \"Unknown effect: random_events, near line: 57\" in file: \"common/on_action/sample_on_actions.txt\" near line: 65",
      "",
    ].join("\n"),
    "utf8"
  );

  return {
    tempRoot,
    modRoot,
    referenceRoot,
    errorLogFile,
    eventFile: path.join(eventsDir, "sample_events.txt"),
    brokenFile: path.join(eventsDir, "broken_events.txt"),
    referenceFile: path.join(eventsDir, "reference_events.txt"),
    unresolvedReferenceFile: path.join(eventsDir, "unresolved_reference_events.txt"),
  };
}

function runCli(scriptName, args, cwd = projectRoot) {
  const result = cp.spawnSync("node", [path.join(distRoot, scriptName), ...args], {
    cwd,
    encoding: "utf8",
  });

  let json = null;
  const stdout = result.stdout.trim();
  if (stdout) {
    json = JSON.parse(stdout);
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json,
  };
}

test("find-symbol returns code 0 and structured results for known symbols", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("find-symbol.js", ["sample_mod.0001", fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.query, "sample_mod.0001");
    assert.equal(result.json.results.length, 1);
    assert.equal(result.json.results[0].kind, "event");
    assert.match(result.json.results[0].path, /sample_events\.txt$/);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("find-symbol returns script values defined as scalars", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("find-symbol.js", ["medium_prestige_value", fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.query, "medium_prestige_value");
    assert.ok(result.json.results.some((entry) => entry.kind === "script_value"));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("find-symbol returns code 2 and empty results for unknown symbols", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("find-symbol.js", ["missing.symbol", fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.query, "missing.symbol");
    assert.deepEqual(result.json.results, []);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("find-references returns code 0 and usage locations", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("find-references.js", ["sample_mod.0001", fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.query, "sample_mod.0001");
    assert.ok(result.json.results.length >= 1);
    assert.ok(result.json.results.some((entry) => entry.kind === "event"));
    assert.ok(result.json.results.some((entry) => /reference_events\.txt$/.test(entry.path)));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("find-references preserves modifier context kinds", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const characterResult = runCli("find-references.js", ["sample_character_modifier", fixture.modRoot, fixture.referenceRoot]);
    const countyResult = runCli("find-references.js", ["sample_county_modifier", fixture.modRoot, fixture.referenceRoot]);
    const artifactResult = runCli("find-references.js", ["sample_artifact_modifier", fixture.modRoot, fixture.referenceRoot]);

    assert.equal(characterResult.status, 0);
    assert.ok(characterResult.json.results.some((entry) => entry.kind === "character_modifier"));

    assert.equal(countyResult.status, 0);
    assert.ok(countyResult.json.results.some((entry) => entry.kind === "county_modifier"));

    assert.equal(artifactResult.status, 0);
    assert.ok(artifactResult.json.results.some((entry) => entry.kind === "artifact_modifier"));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("find-references covers artifact and prefixed references", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const doctrineResult = runCli("find-references.js", ["doctrine_example", fixture.modRoot, fixture.referenceRoot]);
    const traditionResult = runCli("find-references.js", ["tradition_example", fixture.modRoot, fixture.referenceRoot]);
    const artifactTypeResult = runCli("find-references.js", ["sample_artifact_type", fixture.modRoot, fixture.referenceRoot]);
    const artifactTemplateResult = runCli("find-references.js", ["sample_artifact_template", fixture.modRoot, fixture.referenceRoot]);
    const artifactVisualResult = runCli("find-references.js", ["sample_artifact_visual", fixture.modRoot, fixture.referenceRoot]);

    assert.equal(doctrineResult.status, 0);
    assert.ok(doctrineResult.json.results.some((entry) => entry.kind === "doctrine"));

    assert.equal(traditionResult.status, 0);
    assert.ok(traditionResult.json.results.some((entry) => entry.kind === "cultural_tradition"));

    assert.equal(artifactTypeResult.status, 0);
    assert.ok(artifactTypeResult.json.results.some((entry) => entry.kind === "artifact_type"));

    assert.equal(artifactTemplateResult.status, 0);
    assert.ok(artifactTemplateResult.json.results.some((entry) => entry.kind === "artifact_template"));

    assert.equal(artifactVisualResult.status, 0);
    assert.ok(artifactVisualResult.json.results.some((entry) => entry.kind === "artifact_visual"));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("find-references returns code 2 when no usages are found", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("find-references.js", ["missing.symbol", fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.deepEqual(result.json.results, []);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("cache-info reports cache state for each root", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("cache-info.js", [fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.caches.length, 2);
    assert.ok(result.json.caches.some((entry) => entry.root === fixture.modRoot));
    assert.ok(result.json.caches.some((entry) => entry.root === fixture.referenceRoot));
  } finally {
    fs.rmSync(path.join(projectRoot, ".cache"), { recursive: true, force: true });
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("rebuild-cache creates cache files for each root", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("rebuild-cache.js", [fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.caches.length, 2);
    assert.ok(result.json.caches.every((entry) => entry.exists === true));
    assert.ok(result.json.caches.every((entry) => entry.indexedFiles >= 0));
  } finally {
    fs.rmSync(path.join(projectRoot, ".cache"), { recursive: true, force: true });
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("analyze-error-log returns grouped mod-related findings", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("analyze-error-log.js", [fixture.errorLogFile, fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.summary.modRelatedFindings, 2);
    assert.ok(result.json.findings.some((entry) => entry.category === "localization" && entry.occurrences === 2));
    assert.ok(result.json.findings.some((entry) => entry.category === "script"));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("parse-file returns code 0 and script metadata", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("parse-file.js", [fixture.eventFile]);

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.kind, "script");
    assert.equal(result.json.entryCount, 2);
    assert.equal(result.json.entries[1].key, "sample_mod.0001");
    assert.equal(result.json.entries[1].valueKind, "object");
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("parse-file returns code 1 and error JSON for missing files", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const missingPath = path.join(fixture.modRoot, "events", "does_not_exist.txt");
    const result = runCli("parse-file.js", [missingPath]);

    assert.equal(result.status, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error, "Failed to parse file.");
    assert.equal(typeof result.json.details, "string");
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics returns code 0 with empty diagnostics for clean files", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("diagnostics.js", [fixture.eventFile]);

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.kind, "script");
    assert.deepEqual(result.json.diagnostics, []);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("diagnostics returns code 2 and JSON diagnostics for problematic files", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("diagnostics.js", [fixture.brokenFile]);

    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.diagnostics.length >= 1);
    assert.ok(result.json.diagnostics.some((diagnostic) => diagnostic.message.includes("Missing closing '}'")));
    assert.ok(result.json.diagnostics.some((diagnostic) => diagnostic.message.includes("should not contain spaces")));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("validate-references returns code 0 for resolved references", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("validate-references.js", [fixture.referenceFile, fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.deepEqual(result.json.diagnostics, []);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("validate-references returns code 2 and unresolved reference diagnostics", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("validate-references.js", [fixture.unresolvedReferenceFile, fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "localization" && entry.name === "missing.loc.key"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "event" && entry.name === "sample_mod.9999"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "trait" && entry.name === "missing_trait"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "culture" && entry.name === "missing_culture"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "cultural_tradition" && entry.name === "missing_tradition"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "cultural_pillar" && entry.name === "missing_pillar"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "faith" && entry.name === "missing_faith"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "doctrine" && entry.name === "missing_doctrine"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "doctrine_parameter" && entry.name === "missing_parameter"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "character_modifier" && entry.name === "missing_character_modifier"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "county_modifier" && entry.name === "missing_county_modifier"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "artifact_type" && entry.name === "missing_artifact_type"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "artifact_template" && entry.name === "missing_artifact_template"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "artifact_visual" && entry.name === "missing_artifact_visual"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "artifact_modifier" && entry.name === "missing_artifact_modifier"));
    assert.ok(result.json.diagnostics.some((entry) => entry.kind === "scripted_effect" && entry.name === "missing_bonus_effect"));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("validate-references supports validating the whole workspace", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("validate-references.js", [fixture.modRoot, fixture.referenceRoot]);

    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.diagnostics.some((entry) => entry.name === "missing.loc.key"));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("generate-skill creates a skill in the target workspace", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const result = runCli("generate-skill.js", [fixture.modRoot]);
    const skillPath = path.join(fixture.modRoot, ".codex", "skills", "ck3-devkit", "SKILL.md");
    const skillText = fs.readFileSync(skillPath, "utf8");

    assert.equal(result.status, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.skillName, "ck3-devkit");
    assert.equal(result.json.skillPath, skillPath);
    assert.match(skillText, /name: ck3-devkit/);
    assert.match(skillText, /node dist\/find-symbol\.js/);
    assert.match(skillText, new RegExp(fixture.modRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("generate-skill returns code 1 when the skill already exists without force", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const firstRun = runCli("generate-skill.js", [fixture.modRoot]);
    const secondRun = runCli("generate-skill.js", [fixture.modRoot]);

    assert.equal(firstRun.status, 0);
    assert.equal(secondRun.status, 1);
    assert.equal(secondRun.json.ok, false);
    assert.match(secondRun.json.error, /Skill already exists/);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("generate-skill supports custom names and force overwrite", () => {
  const fixture = makeFixtureWorkspace();

  try {
    const firstRun = runCli("generate-skill.js", [fixture.modRoot, "CK3 Helper"]);
    const secondRun = runCli("generate-skill.js", [fixture.modRoot, "CK3 Helper", "--force"]);
    const skillPath = path.join(fixture.modRoot, ".codex", "skills", "ck3-helper", "SKILL.md");
    const skillText = fs.readFileSync(skillPath, "utf8");

    assert.equal(firstRun.status, 0);
    assert.equal(secondRun.status, 0);
    assert.equal(secondRun.json.skillName, "ck3-helper");
    assert.match(skillText, /name: ck3-helper/);
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});
