export interface CompletionContext {
  kinds: string[];
  query: string;
  prefix?: string;
}

const VALUE_KIND_PATTERNS: Array<{ pattern: RegExp; kinds: string[] }> = [
  { pattern: /(?:^|\s)(title|desc|name)\s*=\s*([\w.:-]*)$/, kinds: ["localization"] },
  { pattern: /(?:^|\s)(trigger_event|triggered_event)\s*=\s*([\w.:-]*)$/, kinds: ["event"] },
  { pattern: /(?:^|\s)(has_trait|add_trait|remove_trait)\s*=\s*([\w.:-]*)$/, kinds: ["trait"] },
  { pattern: /(?:^|\s)(has_character_modifier|remove_character_modifier)\s*=\s*([\w.:-]*)$/, kinds: ["character_modifier"] },
  { pattern: /(?:^|\s)(has_county_modifier|remove_county_modifier)\s*=\s*([\w.:-]*)$/, kinds: ["county_modifier"] },
  { pattern: /(?:^|\s)(has_province_modifier|remove_province_modifier)\s*=\s*([\w.:-]*)$/, kinds: ["province_modifier"] },
  { pattern: /(?:^|\s)(culture)\s*=\s*([\w.:-]*)$/, kinds: ["culture"] },
  { pattern: /(?:^|\s)(faith)\s*=\s*([\w.:-]*)$/, kinds: ["faith"] },
  { pattern: /(?:^|\s)(has_cultural_tradition)\s*=\s*([\w.:-]*)$/, kinds: ["cultural_tradition"] },
  { pattern: /(?:^|\s)(has_cultural_pillar|ethos|heritage|language|martial_custom)\s*=\s*([\w.:-]*)$/, kinds: ["cultural_pillar"] },
  { pattern: /(?:^|\s)(has_doctrine|doctrine)\s*=\s*([\w.:-]*)$/, kinds: ["doctrine"] },
  { pattern: /(?:^|\s)(has_doctrine_parameter)\s*=\s*([\w.:-]*)$/, kinds: ["doctrine_parameter"] },
  { pattern: /(?:^|\s)(type)\s*=\s*([\w.:-]*)$/, kinds: ["artifact_type"] },
  { pattern: /(?:^|\s)(template)\s*=\s*([\w.:-]*)$/, kinds: ["artifact_template"] },
  { pattern: /(?:^|\s)(visuals)\s*=\s*([\w.:-]*)$/, kinds: ["artifact_visual"] },
  { pattern: /(?:^|\s)(modifier)\s*=\s*([\w.:-]*)$/, kinds: ["modifier"] },
];

const PREFIX_KIND_MAP = new Map<string, string>([
  ["doctrine", "doctrine"],
  ["culture_tradition", "cultural_tradition"],
  ["culture_pillar", "cultural_pillar"],
  ["faith", "faith"],
  ["artifact", "artifact_template"],
]);

export function inferCompletionContext(linePrefix: string, recentText: string): CompletionContext | null {
  const trimmed = linePrefix.trimStart();

  const prefixed = trimmed.match(/([\w]+):([\w.]*)$/);
  if (prefixed) {
    const kind = PREFIX_KIND_MAP.get(prefixed[1]);
    if (kind) {
      return {
        kinds: [kind],
        prefix: `${prefixed[1]}:`,
        query: prefixed[2],
      };
    }
  }

  for (const { pattern, kinds } of VALUE_KIND_PATTERNS) {
    const match = linePrefix.match(pattern);
    if (match) {
      return { kinds, query: match[2] ?? "" };
    }
  }

  const eventIdMatch = linePrefix.match(/(?:^|\s)id\s*=\s*([\w.:-]*)$/);
  if (eventIdMatch && isTriggerEventContext(recentText)) {
    return { kinds: ["event"], query: eventIdMatch[1] ?? "" };
  }

  const bareWordMatch = trimmed.match(/([\w.]*)$/);
  if (bareWordMatch && !trimmed.includes("=") && isCallableContext(recentText)) {
    const query = bareWordMatch[1];
    if (/_effect$/.test(query)) {
      return { kinds: ["scripted_effect"], query };
    }
    if (/_trigger$/.test(query)) {
      return { kinds: ["scripted_trigger"], query };
    }
    return { kinds: ["scripted_effect", "scripted_trigger"], query };
  }

  return null;
}

function isTriggerEventContext(recentText: string): boolean {
  const triggerIndex = Math.max(
    recentText.lastIndexOf("trigger_event"),
    recentText.lastIndexOf("triggered_event")
  );
  if (triggerIndex < 0) {
    return false;
  }

  const tail = recentText.slice(triggerIndex);
  const openBraces = [...tail].filter((char) => char === "{").length;
  const closeBraces = [...tail].filter((char) => char === "}").length;
  return openBraces > closeBraces;
}

function isCallableContext(recentText: string): boolean {
  const lines = recentText.split("\n");
  const currentLine = lines[lines.length - 1] ?? "";
  if (!/^\s+[\w.]*$/.test(currentLine)) {
    return false;
  }

  const openBraces = [...recentText].filter((char) => char === "{").length;
  const closeBraces = [...recentText].filter((char) => char === "}").length;
  return openBraces > closeBraces;
}
