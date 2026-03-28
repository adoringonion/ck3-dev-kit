const test = require("node:test");
const assert = require("node:assert/strict");

const { BackendManager } = require("../dist/extension/backendManager");

test("BackendManager rebuilds the fallback index when no language client is active", async () => {
  let fallbackRebuilds = 0;
  let fallbackDisposals = 0;

  const manager = new BackendManager({
    createLanguageClient: async () => {
      throw new Error("not used");
    },
    registerFallbackProviders: () => ({
      dispose() {
        fallbackDisposals += 1;
      },
    }),
    rebuildFallbackIndex: async () => {
      fallbackRebuilds += 1;
    },
  });

  manager.enableFallback();
  const activeBackend = await manager.rebuild();

  assert.equal(activeBackend, "fallback");
  assert.equal(fallbackRebuilds, 1);

  await manager.deactivate();
  assert.equal(fallbackDisposals, 1);
});

test("BackendManager disposes fallback providers after language server recovery", async () => {
  let fallbackDisposals = 0;
  let stopCalls = 0;
  let notifyCalls = 0;

  const manager = new BackendManager({
    createLanguageClient: async () => ({
      async sendNotification() {
        notifyCalls += 1;
      },
      async sendRequest() {
        return null;
      },
      async stop() {
        stopCalls += 1;
      },
    }),
    registerFallbackProviders: () => ({
      dispose() {
        fallbackDisposals += 1;
      },
    }),
    rebuildFallbackIndex: async () => {},
  });

  manager.enableFallback();
  await manager.start();
  const activeBackend = await manager.rebuild();

  assert.equal(fallbackDisposals, 1);
  assert.equal(activeBackend, "lsp");
  assert.equal(notifyCalls, 1);

  await manager.deactivate();
  assert.equal(stopCalls, 1);
});
