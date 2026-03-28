import { createDocumentIndexRecord, createDocumentIndexRecordFromParsed } from "./indexer";
import { parseLocalization } from "./localization";
import {
  parseListItems,
  parseListItemsFromTokens,
  parseScript,
  parseScriptEntries,
  parseScriptEntriesFromTokens,
  parseScriptFromTokens,
  parseSingleAssignment,
  parseSingleAssignmentFromTokens,
  parseSingleValue,
  parseSingleValueFromTokens,
  scanTokens,
} from "./parser";
import { TextCursor } from "./text";
import {
  AssignmentNode,
  ListNode,
  ObjectNode,
  ParsedDocument,
  ParserError,
  Range,
  ScriptDocument,
  ScriptToken,
  ValueNode,
} from "./types";

const LIST_WRAPPER_PREFIX_LENGTH = "__list__ = [".length;
const VALUE_WRAPPER_PREFIX_LENGTH = "__value__ = ".length;

export function createIncrementalDocumentIndexRecord(
  filePath: string,
  text: string,
  source: "mod" | "reference",
  previous?: ParsedDocument,
): ReturnType<typeof createDocumentIndexRecord> {
  if (!previous || previous.text === text || previous.kind === "localization") {
    return createDocumentIndexRecord(filePath, text, source);
  }

  const parsed = incrementalParseScript(previous, text);
  return createDocumentIndexRecordFromParsed(filePath, parsed, source);
}

export function incrementalParseScript(previous: ParsedDocument, nextText: string): ParsedDocument {
  if (previous.kind !== "script") {
    return previous.kind === "localization"
      ? parseLocalization(nextText)
      : parseScript(nextText);
  }

  const change = changedRegion(previous.text, nextText);
  if (!change) {
    const cursor = new TextCursor(nextText);
    return {
      ...previous,
      text: nextText,
      range: cursor.range(0, nextText.length),
      tokens: previous.tokens,
    };
  }

  const tokenUpdate = incrementalScanTokens(previous.tokens, previous.text, nextText, change);
  const nextTokens = tokenUpdate.tokens;

  const nestedTarget = deepestAffectedValueTarget(previous.entries, change.start, change.oldEnd, []);
  if (nestedTarget && (nestedTarget.assignmentPath.length > 1 || nestedTarget.valuePath.length > 0)) {
    if (nestedTarget.value.kind === "object") {
      return applyNestedObjectUpdate(previous, nextText, nextTokens, nestedTarget as NestedValueTarget<ObjectNode>);
    }
    if (nestedTarget.value.kind === "list") {
      return applyNestedListUpdate(previous, nextText, nextTokens, nestedTarget as NestedValueTarget<ListNode>);
    }
    return applyNestedScalarUpdate(previous, nextText, nextTokens, nestedTarget);
  }

  let affected = affectedTopLevelEntries(previous, change.start, change.oldEnd);
  if (!affected) {
    const insertion = affectedInsertion(previous, change.start, change.oldEnd);
    if (insertion) {
      return applyInsertedTopLevelEntries(previous, nextText, nextTokens, insertion);
    }
    return parseScriptFromTokens(nextText, nextTokens);
  }

  const delta = nextText.length - previous.text.length;
  const nextCursor = new TextCursor(nextText);
  let fragmentBounds = expandToTokenBoundaries(nextTokens, affected.start, Math.max(affected.start, affected.end + delta), nextText.length);
  affected = extendAffectedAssignmentsForDeletion(previous.entries, affected, delta, fragmentBounds.end);
  fragmentBounds = expandToTokenBoundaries(nextTokens, affected.start, Math.max(affected.start, affected.end + delta), nextText.length);
  if (affected.firstIndex === affected.lastIndex) {
    const direct = tryPatchAssignmentValueOnly(
      previous.entries[affected.firstIndex],
      change.start,
      change.oldEnd,
      nextText,
      nextTokens,
      nextCursor,
      delta,
    );
    if (direct) {
      const entries = [
        ...previous.entries.slice(0, affected.firstIndex),
        direct.entry,
        ...previous.entries.slice(affected.lastIndex + 1).map((entry) => shiftAssignment(entry, delta, nextCursor)),
      ];
      const errors = [
        ...previous.errors.filter((error) => error.range.end.offset <= direct.previousValueRange.start.offset),
        ...direct.errors,
        ...previous.errors
          .filter((error) => error.range.start.offset >= direct.previousValueRange.end.offset)
          .map((error) => shiftError(error, delta, nextCursor)),
      ];
      return {
        kind: "script",
        entries,
        errors,
        text: nextText,
        range: nextCursor.range(0, nextText.length),
        tokens: nextTokens,
      };
    }
  }
  const fragment = nextText.slice(fragmentBounds.start, fragmentBounds.end);
  const fragmentTokens = sliceTokens(nextTokens, fragmentBounds.start, fragmentBounds.end);
  const useSingleAssignment = affected.firstIndex === affected.lastIndex && !fragmentContainsMultipleAssignments(fragmentTokens);
  const reparsed = useSingleAssignment
    ? parseSingleAssignmentFromTokens(fragment, normalizeTokens(fragmentTokens, fragmentBounds.start))
    : parseScriptEntriesFromTokens(fragment, normalizeTokens(fragmentTokens, fragmentBounds.start));
  const reparsedEntries = "entry" in reparsed
    ? (reparsed.entry ? [reparsed.entry] : [])
    : reparsed.entries;
  const shiftedEntries = reparsedEntries.map((entry) => shiftAssignment(entry, fragmentBounds.start, nextCursor));
  const shiftedErrors = reparsed.errors.map((error) => shiftError(error, fragmentBounds.start, nextCursor));

  const entries = [
    ...previous.entries.slice(0, affected.firstIndex),
    ...shiftedEntries,
    ...previous.entries.slice(affected.lastIndex + 1).map((entry) => shiftAssignment(entry, delta, nextCursor)),
  ];

  const errors = [
    ...previous.errors.filter((error) => error.range.end.offset <= fragmentBounds.start),
    ...shiftedErrors,
    ...previous.errors
      .filter((error) => error.range.start.offset >= affected.end)
      .map((error) => shiftError(error, delta, nextCursor)),
  ];

  return {
    kind: "script",
    entries,
    errors,
    text: nextText,
    range: nextCursor.range(0, nextText.length),
    tokens: nextTokens,
  };
}

function applyNestedObjectUpdate(
  previous: ScriptDocument,
  nextText: string,
  nextTokens: ScriptToken[],
  target: NestedValueTarget<ObjectNode>,
): ScriptDocument {
  if (target.value.kind !== "object") {
    return parseScript(nextText);
  }

  const nextCursor = new TextCursor(nextText);
  const previousBodyStart = target.value.range.start.offset + 1;
  const previousBodyEnd = Math.max(previousBodyStart, target.value.range.end.offset - 1);
  const delta = nextText.length - previous.text.length;
  const bodyUpdate = rebuildNestedObjectEntries(
    previous.text,
    target.value.entries,
    previousBodyStart,
    previousBodyEnd,
    nextText,
    nextTokens,
    nextCursor,
  );
  const shiftedEntries = bodyUpdate.entries;
  const shiftedErrors = bodyUpdate.errors;

  const nextEntries = replaceValueAtTarget(
    previous.entries,
    target,
    nextCursor,
    delta,
    (value) => ({
      kind: "object",
      entries: shiftedEntries,
      range: nextCursor.range(value.range.start.offset, value.range.end.offset + delta),
    }),
  );

  const keptErrors = previous.errors
    .filter((error) =>
      error.range.end.offset <= target.value.range.start.offset
      || error.range.start.offset >= target.value.range.end.offset)
    .map((error) => {
      if (error.range.start.offset >= target.value.range.end.offset) {
        return shiftError(error, delta, nextCursor);
      }
      return error;
    });

  return {
    kind: "script",
    entries: nextEntries,
    errors: [...keptErrors, ...shiftedErrors],
    text: nextText,
    range: nextCursor.range(0, nextText.length),
    tokens: nextTokens,
  };
}

function applyNestedListUpdate(
  previous: ScriptDocument,
  nextText: string,
  nextTokens: ScriptToken[],
  target: NestedValueTarget<ListNode>,
): ScriptDocument {
  if (target.value.kind !== "list") {
    return parseScript(nextText);
  }

  const nextCursor = new TextCursor(nextText);
  const previousBodyStart = target.value.range.start.offset + 1;
  const previousBodyEnd = Math.max(previousBodyStart, target.value.range.end.offset - 1);
  const delta = nextText.length - previous.text.length;
  const bodyUpdate = rebuildNestedListItems(
    previous.text,
    target.value.items,
    previousBodyStart,
    previousBodyEnd,
    nextText,
    nextTokens,
    nextCursor,
  );

  const nextEntries = replaceValueAtTarget(
    previous.entries,
    target,
    nextCursor,
    delta,
    (value) => ({
      kind: "list",
      items: bodyUpdate.items,
      range: nextCursor.range(value.range.start.offset, value.range.end.offset + delta),
    }),
  );

  const keptErrors = previous.errors
    .filter((error) =>
      error.range.end.offset <= target.value.range.start.offset
      || error.range.start.offset >= target.value.range.end.offset)
    .map((error) => {
      if (error.range.start.offset >= target.value.range.end.offset) {
        return shiftError(error, delta, nextCursor);
      }
      return error;
    });

  return {
    kind: "script",
    entries: nextEntries,
    errors: [...keptErrors, ...bodyUpdate.errors],
    text: nextText,
    range: nextCursor.range(0, nextText.length),
    tokens: nextTokens,
  };
}

function applyNestedScalarUpdate(
  previous: ScriptDocument,
  nextText: string,
  nextTokens: ScriptToken[],
  target: NestedValueTarget<ValueNode>,
): ScriptDocument {
  const nextCursor = new TextCursor(nextText);
  const delta = nextText.length - previous.text.length;
  const fragmentStart = target.value.range.start.offset;
  const fragmentEnd = Math.max(fragmentStart, target.value.range.end.offset + delta);
  const fragment = nextText.slice(fragmentStart, fragmentEnd);
  const fragmentTokens = normalizeTokens(sliceTokens(nextTokens, fragmentStart, fragmentEnd), fragmentStart);
  const reparsed = parseSingleValueFromTokens(fragment, fragmentTokens);
  if (!reparsed.value) {
    return parseScript(nextText);
  }

  const nextEntries = replaceValueAtTarget(
    previous.entries,
    target,
    nextCursor,
    delta,
    () => shiftValue(reparsed.value as ValueNode, fragmentStart - VALUE_WRAPPER_PREFIX_LENGTH, nextCursor),
  );

  const keptErrors = previous.errors
    .filter((error) =>
      error.range.end.offset <= target.value.range.start.offset
      || error.range.start.offset >= target.value.range.end.offset)
    .map((error) => {
      if (error.range.start.offset >= target.value.range.end.offset) {
        return shiftError(error, delta, nextCursor);
      }
      return error;
    });

  return {
    kind: "script",
    entries: nextEntries,
    errors: [
      ...keptErrors,
      ...reparsed.errors.map((error) => shiftError(error, fragmentStart - VALUE_WRAPPER_PREFIX_LENGTH, nextCursor)),
    ],
    text: nextText,
    range: nextCursor.range(0, nextText.length),
    tokens: nextTokens,
  };
}

function rebuildNestedObjectEntries(
  previousText: string,
  previousEntries: AssignmentNode[],
  previousBodyStart: number,
  previousBodyEnd: number,
  nextText: string,
  nextTokens: ScriptToken[],
  nextCursor: TextCursor,
): { entries: AssignmentNode[]; errors: ParserError[] } {
  const delta = nextText.length - previousText.length;
  const nextBodyLength = previousBodyEnd - previousBodyStart + delta;
  const nextBodyText = nextText.slice(previousBodyStart, Math.max(previousBodyStart, previousBodyStart + nextBodyLength));
  const localChange = changedRegion(
    previousText.slice(previousBodyStart, previousBodyEnd),
    nextBodyText,
  );

  if (!localChange) {
    return {
      entries: previousEntries,
      errors: [],
    };
  }

  let affected = affectedEntries(previousEntries, previousBodyStart + localChange.start, previousBodyStart + localChange.oldEnd);
  if (!affected) {
    const insertion = affectedInsertionInEntries(previousEntries, previousBodyStart + localChange.start, previousBodyStart + localChange.oldEnd);
    if (!insertion) {
      const bodyTokens = normalizeTokens(sliceTokens(nextTokens, previousBodyStart, previousBodyStart + nextBodyLength), previousBodyStart);
      const reparsedBody = parseScriptEntriesFromTokens(nextBodyText, bodyTokens);
      return {
        entries: reparsedBody.entries.map((entry) => shiftAssignment(entry, previousBodyStart, nextCursor)),
        errors: reparsedBody.errors.map((error) => shiftError(error, previousBodyStart, nextCursor)),
      };
    }

    const fragmentBounds = expandToTokenBoundaries(nextTokens, insertion.start, insertion.end + delta, nextText.length);
    const fragment = nextText.slice(fragmentBounds.start, fragmentBounds.end);
    const fragmentTokens = sliceTokens(nextTokens, fragmentBounds.start, fragmentBounds.end);
    const reparsed = parseScriptEntriesFromTokens(fragment, normalizeTokens(fragmentTokens, fragmentBounds.start));
    return {
      entries: [
        ...previousEntries.slice(0, insertion.insertIndex),
        ...reparsed.entries.map((entry) => shiftAssignment(entry, fragmentBounds.start, nextCursor)),
        ...previousEntries.slice(insertion.insertIndex).map((entry) => shiftAssignment(entry, delta, nextCursor)),
      ],
      errors: reparsed.errors.map((error) => shiftError(error, fragmentBounds.start, nextCursor)),
    };
  }

  let fragmentBounds = expandToTokenBoundaries(nextTokens, affected.start, Math.max(affected.start, affected.end + delta), nextText.length);
  affected = extendAffectedAssignmentsForDeletion(previousEntries, affected, delta, fragmentBounds.end);
  fragmentBounds = expandToTokenBoundaries(nextTokens, affected.start, Math.max(affected.start, affected.end + delta), nextText.length);
  const fragment = nextText.slice(fragmentBounds.start, fragmentBounds.end);
  const fragmentTokens = sliceTokens(nextTokens, fragmentBounds.start, fragmentBounds.end);
  if (affected.firstIndex === affected.lastIndex) {
    const direct = tryPatchAssignmentValueOnly(
      previousEntries[affected.firstIndex],
      previousBodyStart + localChange.start,
      previousBodyStart + localChange.oldEnd,
      nextText,
      nextTokens,
      nextCursor,
      delta,
    );
    if (direct) {
      return {
        entries: [
          ...previousEntries.slice(0, affected.firstIndex),
          direct.entry,
          ...previousEntries.slice(affected.lastIndex + 1).map((entry) => shiftAssignment(entry, delta, nextCursor)),
        ],
        errors: direct.errors,
      };
    }
  }
  const useSingleAssignment = affected.firstIndex === affected.lastIndex && !fragmentContainsMultipleAssignments(fragmentTokens);
  const reparsed = useSingleAssignment
    ? parseSingleAssignmentFromTokens(fragment, normalizeTokens(fragmentTokens, fragmentBounds.start))
    : parseScriptEntriesFromTokens(fragment, normalizeTokens(fragmentTokens, fragmentBounds.start));
  const reparsedEntries = "entry" in reparsed
    ? (reparsed.entry ? [reparsed.entry] : [])
    : reparsed.entries;
  return {
    entries: [
      ...previousEntries.slice(0, affected.firstIndex),
      ...reparsedEntries.map((entry) => shiftAssignment(entry, fragmentBounds.start, nextCursor)),
      ...previousEntries.slice(affected.lastIndex + 1).map((entry) => shiftAssignment(entry, delta, nextCursor)),
    ],
    errors: reparsed.errors.map((error) => shiftError(error, fragmentBounds.start, nextCursor)),
  };
}

function rebuildNestedListItems(
  previousText: string,
  previousItems: ValueNode[],
  previousBodyStart: number,
  previousBodyEnd: number,
  nextText: string,
  nextTokens: ScriptToken[],
  nextCursor: TextCursor,
): { items: ValueNode[]; errors: ParserError[] } {
  const delta = nextText.length - previousText.length;
  const nextBodyLength = previousBodyEnd - previousBodyStart + delta;
  const nextBodyText = nextText.slice(previousBodyStart, Math.max(previousBodyStart, previousBodyStart + nextBodyLength));
  const localChange = changedRegion(
    previousText.slice(previousBodyStart, previousBodyEnd),
    nextBodyText,
  );

  if (!localChange) {
    return {
      items: previousItems,
      errors: [],
    };
  }

  const affected = affectedValues(previousItems, previousBodyStart + localChange.start, previousBodyStart + localChange.oldEnd);
  if (!affected) {
    const insertion = affectedInsertionInValues(previousItems, previousBodyStart + localChange.start, previousBodyStart + localChange.oldEnd);
    if (!insertion) {
      const bodyTokens = normalizeTokens(sliceTokens(nextTokens, previousBodyStart, previousBodyStart + nextBodyLength), previousBodyStart);
      const reparsedBody = parseListItemsFromTokens(nextBodyText, bodyTokens);
      return {
        items: reparsedBody.items.map((item) => shiftValue(item, previousBodyStart - LIST_WRAPPER_PREFIX_LENGTH, nextCursor)),
        errors: reparsedBody.errors.map((error) => shiftError(error, previousBodyStart - LIST_WRAPPER_PREFIX_LENGTH, nextCursor)),
      };
    }

    const fragmentBounds = expandToTokenBoundaries(nextTokens, insertion.start, insertion.end + delta, nextText.length);
    const fragment = nextText.slice(fragmentBounds.start, fragmentBounds.end);
    const fragmentTokens = normalizeTokens(sliceTokens(nextTokens, fragmentBounds.start, fragmentBounds.end), fragmentBounds.start);
    const reparsed = parseListItemsFromTokens(fragment, fragmentTokens);
    return {
      items: [
        ...previousItems.slice(0, insertion.insertIndex),
        ...reparsed.items.map((item) => shiftValue(item, fragmentBounds.start - LIST_WRAPPER_PREFIX_LENGTH, nextCursor)),
        ...previousItems.slice(insertion.insertIndex).map((item) => shiftValue(item, delta, nextCursor)),
      ],
      errors: reparsed.errors.map((error) => shiftError(error, fragmentBounds.start - LIST_WRAPPER_PREFIX_LENGTH, nextCursor)),
    };
  }

  const fragmentBounds = expandToTokenBoundaries(nextTokens, affected.start, Math.max(affected.start, affected.end + delta), nextText.length);
  const fragment = nextText.slice(fragmentBounds.start, fragmentBounds.end);
  const fragmentTokens = normalizeTokens(sliceTokens(nextTokens, fragmentBounds.start, fragmentBounds.end), fragmentBounds.start);
  const reparsed = parseListItemsFromTokens(fragment, fragmentTokens);
  return {
    items: [
      ...previousItems.slice(0, affected.firstIndex),
      ...reparsed.items.map((item) => shiftValue(item, fragmentBounds.start - LIST_WRAPPER_PREFIX_LENGTH, nextCursor)),
      ...previousItems.slice(affected.lastIndex + 1).map((item) => shiftValue(item, delta, nextCursor)),
    ],
    errors: reparsed.errors.map((error) => shiftError(error, fragmentBounds.start - LIST_WRAPPER_PREFIX_LENGTH, nextCursor)),
  };
}

function applyInsertedTopLevelEntries(
  previous: ScriptDocument,
  nextText: string,
  nextTokens: ScriptToken[],
  insertion: { insertIndex: number; start: number; end: number },
): ScriptDocument {
  const nextCursor = new TextCursor(nextText);
  const delta = nextText.length - previous.text.length;
  const fragment = nextText.slice(insertion.start, insertion.end + delta);
  const fragmentTokens = sliceTokens(nextTokens, insertion.start, insertion.end + delta);
  const reparsed = parseScriptEntriesFromTokens(fragment, normalizeTokens(fragmentTokens, insertion.start));
  const shiftedEntries = reparsed.entries.map((entry) => shiftAssignment(entry, insertion.start, nextCursor));
  const shiftedErrors = reparsed.errors.map((error) => shiftError(error, insertion.start, nextCursor));

  const entries = [
    ...previous.entries.slice(0, insertion.insertIndex),
    ...shiftedEntries,
    ...previous.entries.slice(insertion.insertIndex).map((entry) => shiftAssignment(entry, delta, nextCursor)),
  ];

  const errors = [
    ...previous.errors.filter((error) => error.range.end.offset <= insertion.start),
    ...shiftedErrors,
    ...previous.errors
      .filter((error) => error.range.start.offset >= insertion.end)
      .map((error) => shiftError(error, delta, nextCursor)),
  ];

  return {
    kind: "script",
    entries,
    errors,
    text: nextText,
    range: nextCursor.range(0, nextText.length),
    tokens: nextTokens,
  };
}

function tryPatchAssignmentValueOnly(
  assignment: AssignmentNode,
  changeStart: number,
  changeOldEnd: number,
  nextText: string,
  nextTokens: ScriptToken[],
  nextCursor: TextCursor,
  delta: number,
): { entry: AssignmentNode; errors: ParserError[]; previousValueRange: Range } | null {
  if (changeStart < assignment.value.range.start.offset || changeOldEnd > assignment.value.range.end.offset) {
    return null;
  }
  const fragmentStart = assignment.value.range.start.offset;
  const fragmentEnd = Math.max(fragmentStart, assignment.value.range.end.offset + delta);
  const fragment = nextText.slice(fragmentStart, fragmentEnd);
  const fragmentTokens = normalizeTokens(sliceTokens(nextTokens, fragmentStart, fragmentEnd), fragmentStart);
  const reparsed = parseSingleValueFromTokens(fragment, fragmentTokens);
  if (!reparsed.value) {
    return null;
  }
  return {
    entry: {
      ...assignment,
      value: shiftValue(reparsed.value, fragmentStart - VALUE_WRAPPER_PREFIX_LENGTH, nextCursor),
      range: nextCursor.range(assignment.range.start.offset, assignment.range.end.offset + delta),
    },
    errors: reparsed.errors.map((error) => shiftError(error, fragmentStart - VALUE_WRAPPER_PREFIX_LENGTH, nextCursor)),
    previousValueRange: assignment.value.range,
  };
}

function changedRegion(previousText: string, nextText: string): { start: number; oldEnd: number } | null {
  let start = 0;
  while (
    start < previousText.length &&
    start < nextText.length &&
    previousText[start] === nextText[start]
  ) {
    start += 1;
  }

  if (start === previousText.length && start === nextText.length) {
    return null;
  }

  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    oldEnd: previousEnd,
  };
}

function affectedTopLevelEntries(previous: ScriptDocument, start: number, oldEnd: number): {
  firstIndex: number;
  lastIndex: number;
  start: number;
  end: number;
} | null {
  if (previous.entries.length === 0) {
    return { firstIndex: 0, lastIndex: -1, start: 0, end: 0 };
  }

  let firstIndex = -1;
  let lastIndex = -1;
  for (let i = 0; i < previous.entries.length; i += 1) {
    const entry = previous.entries[i];
    if (entry.range.end.offset < start) {
      continue;
    }
    if (entry.range.start.offset > oldEnd) {
      break;
    }
    if (firstIndex === -1) {
      firstIndex = i;
    }
    lastIndex = i;
  }

  if (firstIndex === -1) {
    return null;
  }

  return {
    firstIndex,
    lastIndex,
    start: previous.entries[firstIndex].range.start.offset,
    end: previous.entries[lastIndex].range.end.offset,
  };
}

function affectedEntries(entries: AssignmentNode[], start: number, oldEnd: number): {
  firstIndex: number;
  lastIndex: number;
  start: number;
  end: number;
} | null {
  if (entries.length === 0) {
    return { firstIndex: 0, lastIndex: -1, start: start, end: start };
  }

  let firstIndex = -1;
  let lastIndex = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.range.end.offset < start) {
      continue;
    }
    if (entry.range.start.offset > oldEnd) {
      break;
    }
    if (firstIndex === -1) {
      firstIndex = i;
    }
    lastIndex = i;
  }

  if (firstIndex === -1) {
    return null;
  }

  return {
    firstIndex,
    lastIndex,
    start: entries[firstIndex].range.start.offset,
    end: entries[lastIndex].range.end.offset,
  };
}

function extendAffectedAssignmentsForDeletion(
  entries: AssignmentNode[],
  affected: { firstIndex: number; lastIndex: number; start: number; end: number },
  delta: number,
  fragmentEnd: number,
): { firstIndex: number; lastIndex: number; start: number; end: number } {
  if (delta >= 0) {
    return affected;
  }

  let lastIndex = affected.lastIndex;
  while (lastIndex + 1 < entries.length) {
    const shiftedStart = entries[lastIndex + 1].range.start.offset + delta;
    if (shiftedStart >= fragmentEnd) {
      break;
    }
    lastIndex += 1;
  }

  if (lastIndex === affected.lastIndex) {
    return affected;
  }

  return {
    firstIndex: affected.firstIndex,
    lastIndex,
    start: affected.start,
    end: entries[lastIndex].range.end.offset,
  };
}

function affectedInsertion(previous: ScriptDocument, start: number, oldEnd: number): {
  insertIndex: number;
  start: number;
  end: number;
} | null {
  if (start !== oldEnd) {
    return null;
  }
  if (previous.entries.length === 0) {
    return { insertIndex: 0, start: 0, end: 0 };
  }

  for (let index = 0; index <= previous.entries.length; index += 1) {
    const previousEnd = index === 0 ? 0 : previous.entries[index - 1].range.end.offset;
    const nextStart = index === previous.entries.length ? previous.text.length : previous.entries[index].range.start.offset;
    if (start >= previousEnd && start <= nextStart) {
      return {
        insertIndex: index,
        start,
        end: start,
      };
    }
  }

  return null;
}

function affectedInsertionInEntries(entries: AssignmentNode[], start: number, oldEnd: number): {
  insertIndex: number;
  start: number;
  end: number;
} | null {
  if (start !== oldEnd) {
    return null;
  }
  if (entries.length === 0) {
    return { insertIndex: 0, start, end: start };
  }

  for (let index = 0; index <= entries.length; index += 1) {
    const previousEnd = index === 0 ? start : entries[index - 1].range.end.offset;
    const nextStart = index === entries.length ? start : entries[index].range.start.offset;
    if (start >= previousEnd && start <= nextStart) {
      return {
        insertIndex: index,
        start,
        end: start,
      };
    }
  }

  return null;
}

interface ValuePathSegment {
  kind: "object" | "list";
  index: number;
}

interface NestedValueTarget<T extends ValueNode> {
  assignmentPath: number[];
  valuePath: ValuePathSegment[];
  value: T;
}

function deepestAffectedValueTarget(
  entries: AssignmentNode[],
  start: number,
  oldEnd: number,
  assignmentPath: number[],
): NestedValueTarget<ValueNode> | null {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.range.start.offset > oldEnd || entry.range.end.offset < start) {
      continue;
    }
    const nested = deepestAffectedValue(entry.value, start, oldEnd, [...assignmentPath, index], []);
    if (nested) {
      return nested;
    }
    if (entry.value.kind === "object" || entry.value.kind === "list") {
      return { assignmentPath: [...assignmentPath, index], valuePath: [], value: entry.value };
    }
  }
  return null;
}

function deepestAffectedValue(
  value: ValueNode,
  start: number,
  oldEnd: number,
  assignmentPath: number[],
  valuePath: ValuePathSegment[],
): NestedValueTarget<ValueNode> | null {
  if (value.range.start.offset > oldEnd || value.range.end.offset < start) {
    return null;
  }
  if (value.kind === "object") {
    for (let index = 0; index < value.entries.length; index += 1) {
      const nested = deepestAffectedValue(
        value.entries[index].value,
        start,
        oldEnd,
        assignmentPath,
        [...valuePath, { kind: "object", index }],
      );
      if (nested) {
        return nested;
      }
    }
    return { assignmentPath, valuePath, value };
  }
  if (value.kind === "list") {
    for (let index = 0; index < value.items.length; index += 1) {
      const nested = deepestAffectedValue(
        value.items[index],
        start,
        oldEnd,
        assignmentPath,
        [...valuePath, { kind: "list", index }],
      );
      if (nested) {
        return nested;
      }
    }
    return { assignmentPath, valuePath, value };
  }
  if (start < value.range.start.offset || oldEnd > value.range.end.offset) {
    return null;
  }
  if (start === oldEnd && (start <= value.range.start.offset || start >= value.range.end.offset)) {
    return null;
  }
  return { assignmentPath, valuePath, value };
}

function replaceValueAtTarget(
  entries: AssignmentNode[],
  target: NestedValueTarget<ValueNode>,
  cursor: TextCursor,
  delta: number,
  update: (value: ValueNode) => ValueNode,
): AssignmentNode[] {
  const [head, ...rest] = target.assignmentPath;
  return entries.map((entry, index) => {
    if (index < head) {
      return entry;
    }
    if (index > head) {
      return shiftAssignment(entry, delta, cursor);
    }
    if (rest.length === 0) {
      return {
        ...entry,
        value: replaceValueAtPath(entry.value, target.valuePath, cursor, delta, update),
        range: cursor.range(entry.range.start.offset, entry.range.end.offset + delta),
      };
    }
    if (entry.value.kind !== "object") {
      return entry;
    }
    return {
      ...entry,
      value: {
        ...entry.value,
        entries: replaceValueAtTarget(
          entry.value.entries,
          {
            assignmentPath: rest,
            valuePath: target.valuePath,
            value: target.value,
          },
          cursor,
          delta,
          update,
        ),
        range: cursor.range(entry.value.range.start.offset, entry.value.range.end.offset + delta),
      },
      range: cursor.range(entry.range.start.offset, entry.range.end.offset + delta),
    };
  });
}

function replaceValueAtPath(
  value: ValueNode,
  path: ValuePathSegment[],
  cursor: TextCursor,
  delta: number,
  update: (value: ValueNode) => ValueNode,
): ValueNode {
  if (path.length === 0) {
    return update(value);
  }
  const [head, ...rest] = path;
  if (head.kind === "object") {
    if (value.kind !== "object") {
      return value;
    }
    return {
      ...value,
      entries: value.entries.map((entry, index) => {
        if (index < head.index) {
          return entry;
        }
        if (index > head.index) {
          return shiftAssignment(entry, delta, cursor);
        }
        return {
          ...entry,
          value: replaceValueAtPath(entry.value, rest, cursor, delta, update),
          range: cursor.range(entry.range.start.offset, entry.range.end.offset + delta),
        };
      }),
      range: cursor.range(value.range.start.offset, value.range.end.offset + delta),
    };
  }
  if (value.kind !== "list") {
    return value;
  }
  return {
    ...value,
    items: value.items.map((item, index) => {
      if (index < head.index) {
        return item;
      }
      if (index > head.index) {
        return shiftValue(item, delta, cursor);
      }
      return replaceValueAtPath(item, rest, cursor, delta, update);
    }),
    range: cursor.range(value.range.start.offset, value.range.end.offset + delta),
  };
}

function affectedValues(items: ValueNode[], start: number, oldEnd: number): {
  firstIndex: number;
  lastIndex: number;
  start: number;
  end: number;
} | null {
  if (items.length === 0) {
    return { firstIndex: 0, lastIndex: -1, start, end: start };
  }

  let firstIndex = -1;
  let lastIndex = -1;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.range.end.offset < start) {
      continue;
    }
    if (item.range.start.offset > oldEnd) {
      break;
    }
    if (firstIndex === -1) {
      firstIndex = i;
    }
    lastIndex = i;
  }

  if (firstIndex === -1) {
    return null;
  }

  return {
    firstIndex,
    lastIndex,
    start: items[firstIndex].range.start.offset,
    end: items[lastIndex].range.end.offset,
  };
}

function affectedInsertionInValues(items: ValueNode[], start: number, oldEnd: number): {
  insertIndex: number;
  start: number;
  end: number;
} | null {
  if (start !== oldEnd) {
    return null;
  }
  if (items.length === 0) {
    return { insertIndex: 0, start, end: start };
  }
  for (let index = 0; index <= items.length; index += 1) {
    const previousEnd = index === 0 ? start : items[index - 1].range.end.offset;
    const nextStart = index === items.length ? start : items[index].range.start.offset;
    if (start >= previousEnd && start <= nextStart) {
      return {
        insertIndex: index,
        start,
        end: start,
      };
    }
  }
  return null;
}

function shiftAssignment(node: AssignmentNode, delta: number, cursor: TextCursor): AssignmentNode {
  return {
    ...node,
    keyRange: shiftRange(node.keyRange, delta, cursor),
    operatorRange: shiftRange(node.operatorRange, delta, cursor),
    value: shiftValue(node.value, delta, cursor),
    range: shiftRange(node.range, delta, cursor),
  };
}

function shiftValue(node: ValueNode, delta: number, cursor: TextCursor): ValueNode {
  if (node.kind === "object") {
    return {
      ...node,
      entries: node.entries.map((entry) => shiftAssignment(entry, delta, cursor)),
      range: shiftRange(node.range, delta, cursor),
    };
  }
  if (node.kind === "list") {
    return {
      ...node,
      items: node.items.map((item) => shiftValue(item, delta, cursor)),
      range: shiftRange(node.range, delta, cursor),
    };
  }
  return {
    ...node,
    range: shiftRange(node.range, delta, cursor),
  };
}

function shiftError(error: ParserError, delta: number, cursor: TextCursor): ParserError {
  return {
    ...error,
    range: shiftRange(error.range, delta, cursor),
  };
}

function shiftRange(range: Range, delta: number, cursor: TextCursor): Range {
  return cursor.range(range.start.offset + delta, range.end.offset + delta);
}

function fragmentContainsMultipleAssignments(tokens: ScriptToken[]): boolean {
  let depth = 0;
  let assignments = 0;
  let sawKey = false;

  for (const token of tokens) {
    if (token.kind === "brace" || token.kind === "bracket") {
      if (token.value === "{" || token.value === "[") {
        depth += 1;
      } else {
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (depth > 0) {
      continue;
    }
    if (!sawKey && (token.kind === "identifier" || token.kind === "number" || token.kind === "string")) {
      sawKey = true;
      continue;
    }
    if (sawKey && token.kind === "operator" && token.value === "=") {
      assignments += 1;
      if (assignments > 1) {
        return true;
      }
      sawKey = false;
      continue;
    }
    if (token.kind !== "identifier" && token.kind !== "number" && token.kind !== "string") {
      sawKey = false;
    }
  }

  return false;
}

function sliceTokens(tokens: ScriptToken[], start: number, end: number): ScriptToken[] {
  return tokens.filter((token) => token.end > start && token.start < end);
}

function normalizeTokens(tokens: ScriptToken[], offset: number): ScriptToken[] {
  return tokens.map((token) => ({
    ...token,
    start: token.start - offset,
    end: token.end - offset,
  }));
}

function expandToTokenBoundaries(tokens: ScriptToken[], start: number, end: number, textLength: number): { start: number; end: number } {
  if (tokens.length === 0) {
    return { start, end };
  }

  let expandedStart = start;
  for (const token of tokens) {
    if (token.end > start) {
      expandedStart = token.start;
      break;
    }
  }

  let expandedEnd = end;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.start < end) {
      expandedEnd = token.end;
      break;
    }
  }

  return {
    start: Math.max(0, Math.min(expandedStart, textLength)),
    end: Math.max(Math.max(0, expandedStart), Math.min(expandedEnd, textLength)),
  };
}

function incrementalScanTokens(
  previousTokens: ScriptToken[],
  previousText: string,
  nextText: string,
  change: { start: number; oldEnd: number },
): { tokens: ScriptToken[]; fragmentStart: number; fragmentEnd: number } {
  const delta = nextText.length - previousText.length;
  const startIndex = findFirstOverlappingTokenIndex(previousTokens, change.start);
  const endIndex = findLastOverlappingTokenIndex(previousTokens, change.oldEnd);
  const fragmentStart = startIndex >= 0 ? previousTokens[startIndex].start : change.start;
  const fragmentOldEnd = endIndex >= 0 ? previousTokens[endIndex].end : change.oldEnd;
  const fragmentNewEnd = Math.max(fragmentStart, fragmentOldEnd + delta);
  const fragmentTokens = scanTokens(nextText.slice(fragmentStart, fragmentNewEnd)).map((token) => ({
    ...token,
    start: token.start + fragmentStart,
    end: token.end + fragmentStart,
  }));

  const before = startIndex >= 0
    ? previousTokens.slice(0, startIndex)
    : previousTokens.filter((token) => token.end <= change.start);
  const afterStart = endIndex >= 0 ? endIndex + 1 : before.length;
  const after = previousTokens.slice(afterStart).map((token) => ({
    ...token,
    start: token.start + delta,
    end: token.end + delta,
  }));

  return {
    tokens: [...before, ...fragmentTokens, ...after],
    fragmentStart,
    fragmentEnd: fragmentNewEnd,
  };
}

function findFirstOverlappingTokenIndex(tokens: ScriptToken[], offset: number): number {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].end > offset) {
      return index;
    }
  }
  return -1;
}

function findLastOverlappingTokenIndex(tokens: ScriptToken[], offset: number): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].start < offset) {
      return index;
    }
  }
  return -1;
}
