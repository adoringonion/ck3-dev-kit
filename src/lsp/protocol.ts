import { ErrorLogAnalysisResult } from "../core/errorLog";

export const REBUILD_INDEX_NOTIFICATION = "ck3/rebuildIndex";
export const INDEX_STATUS_NOTIFICATION = "ck3/indexStatus";
export const ANALYZE_ERROR_LOG_REQUEST = "ck3/analyzeErrorLog";

export type IndexPhase = "started" | "completed" | "failed" | "busy";

export interface IndexStatusPayload {
  phase: IndexPhase;
  reason: string;
  message?: string;
}

export interface AnalyzeErrorLogParams {
  logPath?: string;
}

export interface AnalyzeErrorLogResponse extends ErrorLogAnalysisResult {}
