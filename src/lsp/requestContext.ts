import {
  CancellationToken,
  WorkDoneProgressReporter,
  WorkDoneProgressServerReporter,
} from "vscode-languageserver/node";

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): { dispose(): void } | (() => void);
}

export class RequestCancelledError extends Error {
  constructor(message = "Request cancelled.") {
    super(message);
    this.name = "RequestCancelledError";
  }
}

export interface RequestContextOptions {
  label: string;
  token?: CancellationLike;
  progress?: WorkDoneProgressReporter | WorkDoneProgressServerReporter;
}

export class RequestContext {
  readonly label: string;
  readonly token?: CancellationLike;
  private readonly progress?: WorkDoneProgressReporter | WorkDoneProgressServerReporter;

  constructor(options: RequestContextOptions) {
    this.label = options.label;
    this.token = options.token;
    this.progress = options.progress;
  }

  throwIfCancelled(): void {
    if (this.token?.isCancellationRequested) {
      throw new RequestCancelledError(`${this.label} cancelled.`);
    }
  }

  checkpoint(message?: string): void {
    this.throwIfCancelled();
    if (message && this.progress) {
      this.progress.report(message);
    }
  }

  report(message: string): void {
    this.progress?.report(message);
  }
}

export function cancellationFromAbortSignal(signal: AbortSignal): CancellationLike {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(listener: () => void) {
      signal.addEventListener("abort", listener, { once: true });
      return () => signal.removeEventListener("abort", listener);
    },
  };
}
