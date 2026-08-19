import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { getYDoc } from "@y/websocket-server/utils";
import { attachCollab, parseCookies, roomCount, snapshotIfEmptyForTest, type CollabOptions } from "./collab.js";

const SEED = "# 初始內容\n";

const allowAll: CollabOptions = {
  featureEnabled: () => true,
  enabled: () => true,
  authorize: async () => ({
    ok: true,
    user: { name: "tester", color: "#38bdf8" },
    readFile: async () => SEED,
  }),
};

function listen(opts: CollabOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer();
  attachCollab(server, opts);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

function waitUntil(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitSynced(provider: WebsocketProvider, timeoutMs = 5000): Promise<void> {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sync timeout")), timeoutMs);
    const onSync = (synced: boolean) => {
      if (!synced) return;
      clearTimeout(t);
      provider.off("sync", onSync);
      resolve();
    };
    provider.on("sync", onSync);
  });
}

function openProvider(port: number, docKey: string, ydoc: Y.Doc): WebsocketProvider {
  return new WebsocketProvider(`ws://127.0.0.1:${port}`, "collab", ydoc, {
    params: { doc: docKey },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
    maxBackoffTime: 200,
    shouldReconnect: () => false,
  });
}

describe("parseCookies", () => {
  it("returns {} for empty header", () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(""), {});
  });

  it("splits a=1; b=2 into two cookies", () => {
    assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  });

  it("decodeURIComponent on values", () => {
    assert.deepEqual(parseCookies("nb_guest=%E8%A8%AA%E5%AE%A2"), { nb_guest: "訪客" });
  });
});

describe("collab websocket", { concurrency: false }, () => {
  it("seeds once and syncs an insert between two clients", async () => {
    const { port, close } = await listen(allowAll);
    const docKey = `sync-${Date.now()}`;
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const providerA = openProvider(port, docKey, docA);
    const providerB = openProvider(port, docKey, docB);
    try {
      await Promise.all([waitSynced(providerA), waitSynced(providerB)]);
      const textA = docA.getText("content");
      const textB = docB.getText("content");
      assert.equal(textA.toString(), SEED);
      assert.equal(textB.toString(), SEED);

      const extra = "hello from A";
      textA.insert(textA.length, extra);
      await waitUntil(() => textB.toString().includes(extra), "client B to see A's insert");
      assert.equal(textB.toString(), SEED + extra);
    } finally {
      providerA.destroy();
      providerB.destroy();
      await close();
    }
  });

  it("rejects connections when enabled returns false", async () => {
    const { port, close } = await listen({
      featureEnabled: () => true,
      enabled: () => false,
      authorize: async () => ({
        ok: true,
        user: { name: "tester", color: "#38bdf8" },
        readFile: async () => SEED,
      }),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/collab?doc=blocked`);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("timeout: connection was not rejected"));
        }, 3000);
        let settled = false;
        const done = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        };
        ws.on("open", () => {
          ws.close();
          done(new Error("should not have connected"));
        });
        ws.on("unexpected-response", (_req, res) => {
          res.resume();
          try {
            assert.equal(res.statusCode, 403);
            done();
          } catch (e) {
            done(e instanceof Error ? e : new Error(String(e)));
          }
        });
        ws.on("close", () => done());
        ws.on("error", () => {
          // expected when the upgrade is refused
        });
      });
    } finally {
      await close();
    }
  });

  it("counts one room for two clients on the same docKey", async () => {
    const { port, close } = await listen(allowAll);
    const docKey = `room-${Date.now()}`;
    const before = roomCount();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const providerA = openProvider(port, docKey, docA);
    const providerB = openProvider(port, docKey, docB);
    try {
      await Promise.all([waitSynced(providerA), waitSynced(providerB)]);
      assert.equal(roomCount(), before + 1);
    } finally {
      providerA.destroy();
      providerB.destroy();
      await close();
    }
  });

  it("does not attach an upgrade listener when featureEnabled is false", () => {
    const server = http.createServer();
    attachCollab(server, {
      featureEnabled: () => false,
      enabled: () => true,
      authorize: async () => ({ ok: false }),
    });
    assert.equal(server.listenerCount("upgrade"), 0);
    server.close();
  });

  it("destroys the socket for upgrades that are not /collab", async () => {
    const { port, close } = await listen({
      featureEnabled: () => true,
      enabled: () => true,
      authorize: async () => ({ ok: false }),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/something-else`);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("timeout: non-/collab upgrade was not closed"));
        }, 3000);
        let settled = false;
        const done = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        };
        ws.on("open", () => {
          ws.close();
          done(new Error("should not have connected"));
        });
        ws.on("close", () => done());
        ws.on("error", () => done());
      });
    } finally {
      await close();
    }
  });

  it("snapshots once after the last client disconnects", async () => {
    const saved: string[] = [];
    const { port, close } = await listen({
      featureEnabled: () => true,
      enabled: () => true,
      authorize: async () => ({
        ok: true,
        user: { name: "tester", color: "#38bdf8" },
        readFile: async () => SEED,
        saveFile: async (content: string) => {
          saved.push(content);
        },
      }),
    });
    const docKey = `snap-last-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const providerA = openProvider(port, docKey, docA);
    const providerB = openProvider(port, docKey, docB);
    try {
      await Promise.all([waitSynced(providerA), waitSynced(providerB)]);
      const extra = "snapshot-me";
      const textA = docA.getText("content");
      textA.insert(textA.length, extra);
      await waitUntil(() => docB.getText("content").toString().includes(extra), "client B to see insert");
      const serverDoc = getYDoc(docKey);
      providerA.destroy();
      providerB.destroy();
      await waitUntil(() => serverDoc.conns.size === 0, "all conns closed");
      await snapshotIfEmptyForTest(docKey);
      assert.equal(saved.length, 1);
      assert.ok(saved[0].includes(extra), `expected snapshot to include ${JSON.stringify(extra)}, got ${JSON.stringify(saved[0])}`);
    } finally {
      providerA.destroy();
      providerB.destroy();
      await close();
    }
  });

  it("does not snapshot while another client is still connected", async () => {
    const saved: string[] = [];
    const { port, close } = await listen({
      featureEnabled: () => true,
      enabled: () => true,
      authorize: async () => ({
        ok: true,
        user: { name: "tester", color: "#38bdf8" },
        readFile: async () => SEED,
        saveFile: async (content: string) => {
          saved.push(content);
        },
      }),
    });
    const docKey = `snap-stay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const providerA = openProvider(port, docKey, docA);
    const providerB = openProvider(port, docKey, docB);
    try {
      await Promise.all([waitSynced(providerA), waitSynced(providerB)]);
      const serverDoc = getYDoc(docKey);
      providerA.destroy();
      await waitUntil(() => serverDoc.conns.size === 1, "one conn left");
      await snapshotIfEmptyForTest(docKey);
      assert.equal(saved.length, 0);
    } finally {
      providerA.destroy();
      providerB.destroy();
      await close();
    }
  });

  it("releases the room after snapshot so the next client re-seeds", async () => {
    const saved: string[] = [];
    let reads = 0;
    const { port, close } = await listen({
      featureEnabled: () => true,
      enabled: () => true,
      authorize: async () => ({
        ok: true,
        user: { name: "tester", color: "#38bdf8" },
        readFile: async () => {
          reads += 1;
          return SEED;
        },
        saveFile: async (content: string) => {
          saved.push(content);
        },
      }),
    });
    const docKey = `snap-release-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const docA = new Y.Doc();
    const providerA = openProvider(port, docKey, docA);
    try {
      await waitSynced(providerA);
      const extra = "should-not-survive-reroom";
      const textA = docA.getText("content");
      textA.insert(textA.length, extra);
      const serverDoc = getYDoc(docKey);
      const readsAfterFirst = reads;
      assert.ok(readsAfterFirst >= 1);
      providerA.destroy();
      await waitUntil(() => serverDoc.conns.size === 0, "all conns closed");
      await snapshotIfEmptyForTest(docKey);
      assert.equal(roomCount(), 0);

      const docB = new Y.Doc();
      const providerB = openProvider(port, docKey, docB);
      try {
        await waitSynced(providerB);
        assert.ok(reads > readsAfterFirst, "readFile should run again after the room is released");
        assert.equal(docB.getText("content").toString(), SEED);
      } finally {
        providerB.destroy();
      }
    } finally {
      providerA.destroy();
      await close();
    }
  });

  it("releases the room when saveFile rejects", async () => {
    const { port, close } = await listen({
      featureEnabled: () => true,
      enabled: () => true,
      authorize: async () => ({
        ok: true,
        user: { name: "tester", color: "#38bdf8" },
        readFile: async () => SEED,
        saveFile: async () => {
          throw new Error("snapshot boom");
        },
      }),
    });
    const docKey = `snap-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const docA = new Y.Doc();
    const providerA = openProvider(port, docKey, docA);
    try {
      await waitSynced(providerA);
      const serverDoc = getYDoc(docKey);
      providerA.destroy();
      await waitUntil(() => serverDoc.conns.size === 0, "all conns closed");
      await snapshotIfEmptyForTest(docKey);
      assert.equal(roomCount(), 0);
    } finally {
      providerA.destroy();
      await close();
    }
  });
});
