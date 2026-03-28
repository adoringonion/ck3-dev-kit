import { flattenEntries, scalarValue } from "./parser";
import { ParsedDocument, Range } from "./types";

export interface DiagnosticRecord {
  severity: "error" | "warning" | "info";
  message: string;
  range: Range;
}

export function collectDocumentDiagnostics(parsed: ParsedDocument): DiagnosticRecord[] {
  const diagnostics: DiagnosticRecord[] = parsed.errors.map((error) => ({
    severity: "warning",
    message: error.message,
    range: error.range,
  }));

  if (parsed.kind === "script") {
    for (const entry of flattenEntries(parsed.entries)) {
      if ((entry.key === "title" || entry.key === "desc" || entry.key === "name") && scalarValue(entry.value)?.includes(" ")) {
        diagnostics.push({
          severity: "info",
          message: "Localization references usually should not contain spaces. Check whether this should be a quoted string or a loc key.",
          range: entry.value.range,
        });
      }
    }
  }

  return diagnostics;
}
