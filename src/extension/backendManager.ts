export interface LanguageClientLike {
  sendNotification(method: string): Promise<void>;
  sendRequest<TResult>(method: string, params?: unknown): Promise<TResult>;
  stop(): Promise<void>;
}

export interface DisposableLike {
  dispose(): void;
}

interface BackendManagerOptions<TClient extends LanguageClientLike> {
  createLanguageClient: () => Promise<TClient>;
  registerFallbackProviders: () => DisposableLike;
  rebuildFallbackIndex: () => Promise<void>;
}

export type ActiveBackend = "lsp" | "fallback" | "none";

export class BackendManager<TClient extends LanguageClientLike> {
  private languageClient: TClient | undefined;
  private fallbackProviders: DisposableLike | undefined;
  private usingFallback = false;

  constructor(private readonly options: BackendManagerOptions<TClient>) {}

  async start(): Promise<void> {
    const nextClient = await this.options.createLanguageClient();
    this.languageClient = nextClient;
    this.disableFallback();
  }

  async restart(): Promise<void> {
    await this.stopLanguageServer();
    await this.start();
  }

  enableFallback(): void {
    if (this.usingFallback) {
      return;
    }
    this.fallbackProviders = this.options.registerFallbackProviders();
    this.usingFallback = true;
  }

  disableFallback(): void {
    if (!this.usingFallback) {
      return;
    }
    this.fallbackProviders?.dispose();
    this.fallbackProviders = undefined;
    this.usingFallback = false;
  }

  async rebuild(): Promise<ActiveBackend> {
    if (this.languageClient) {
      await this.languageClient.sendNotification("ck3/rebuildIndex");
      return "lsp";
    }
    if (this.usingFallback) {
      await this.options.rebuildFallbackIndex();
      return "fallback";
    }
    return "none";
  }

  async deactivate(): Promise<void> {
    await this.stopLanguageServer();
    this.disableFallback();
  }

  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  hasLanguageClient(): boolean {
    return this.languageClient !== undefined;
  }

  getLanguageClient(): TClient | undefined {
    return this.languageClient;
  }

  private async stopLanguageServer(): Promise<void> {
    if (!this.languageClient) {
      return;
    }
    const client = this.languageClient;
    this.languageClient = undefined;
    await client.stop();
  }
}
