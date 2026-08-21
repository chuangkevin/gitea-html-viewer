import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderError,
  UPSTREAM_TIMEOUT_MS,
  withUpstreamSignal,
  mapUpstreamTimeout,
} from "./providers.js";
import { gitlab } from "./gitlab.js";
import { github } from "./github.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

function isTimeout504(err: unknown): boolean {
  return err instanceof ProviderError && err.status === 504 && /timeout/i.test(err.message);
}

describe("upstream fetch timeout", () => {
  it("GitLab maps TimeoutError to ProviderError 504 mentioning timeout", async () => {
    globalThis.fetch = async () => {
      throw timeoutError();
    };
    await assert.rejects(() => gitlab.getUser("tok"), isTimeout504);
  });

  it("GitHub maps TimeoutError to ProviderError 504 mentioning timeout", async () => {
    globalThis.fetch = async () => {
      throw timeoutError();
    };
    await assert.rejects(() => github.getUser("tok"), isTimeout504);
  });

  it("GitLab OAuth exchange maps TimeoutError to ProviderError 504", async () => {
    globalThis.fetch = async () => {
      throw timeoutError();
    };
    await assert.rejects(
      () => gitlab.exchangeCode("id", "secret", "code", "https://example/cb"),
      isTimeout504
    );
  });

  it("GitHub OAuth exchange maps TimeoutError to ProviderError 504", async () => {
    globalThis.fetch = async () => {
      throw timeoutError();
    };
    await assert.rejects(
      () => github.exchangeCode("id", "secret", "code", "https://example/cb"),
      isTimeout504
    );
  });

  it("GitHub readFileRaw maps TimeoutError to ProviderError 504", async () => {
    globalThis.fetch = async () => {
      throw timeoutError();
    };
    await assert.rejects(() => github.readFileRaw("tok", "owner/repo", "file.bin"), isTimeout504);
  });

  it("GitLab getUser still succeeds on a normal JSON response and fetch receives a signal", async () => {
    let received: AbortSignal | undefined;
    globalThis.fetch = async (_url, init) => {
      received = init?.signal ?? undefined;
      return jsonResponse({ username: "alice", avatar_url: "https://example/a.png" });
    };
    const user = await gitlab.getUser("tok");
    assert.equal(user.login, "alice");
    assert.ok(received, "fetch should receive an AbortSignal");
    assert.equal(received.aborted, false);
  });

  it("GitHub getUser still succeeds on a normal JSON response and fetch receives a signal", async () => {
    let received: AbortSignal | undefined;
    globalThis.fetch = async (_url, init) => {
      received = init?.signal ?? undefined;
      return jsonResponse({ login: "bob", avatar_url: "https://example/b.png" });
    };
    const user = await github.getUser("tok");
    assert.equal(user.login, "bob");
    assert.ok(received, "fetch should receive an AbortSignal");
    assert.equal(received.aborted, false);
  });
});

describe("withUpstreamSignal (caller-provided signal)", () => {
  it("uses a timeout signal when the caller did not pass one", () => {
    const signal = withUpstreamSignal();
    assert.equal(signal.aborted, false);
    assert.equal(withUpstreamSignal({}).aborted, false);
  });

  it("does not replace the caller signal: caller abort still aborts the merged signal", () => {
    const caller = new AbortController();
    const merged = withUpstreamSignal({ signal: caller.signal });
    // `init?.signal ?? timeout` would return the caller signal itself and drop the 10s timeout.
    assert.notEqual(merged, caller.signal);
    assert.equal(merged.aborted, false);
    caller.abort();
    assert.equal(merged.aborted, true);
  });

  it("still attaches a timeout when merging with a caller signal", () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    const origAny = AbortSignal.any.bind(AbortSignal);
    const dummyTimeout = origTimeout(60_000);
    let timeoutMs: number | undefined;
    let anySignals: AbortSignal[] | undefined;
    const caller = new AbortController();
    AbortSignal.timeout = ((ms: number) => {
      timeoutMs = ms;
      return dummyTimeout;
    }) as typeof AbortSignal.timeout;
    AbortSignal.any = ((signals: AbortSignal[]) => {
      anySignals = [...signals];
      return origAny(signals);
    }) as typeof AbortSignal.any;
    try {
      withUpstreamSignal({ signal: caller.signal });
      assert.equal(timeoutMs, UPSTREAM_TIMEOUT_MS);
      assert.equal(anySignals?.length, 2);
      assert.equal(anySignals?.[0], caller.signal);
      assert.equal(anySignals?.[1], dummyTimeout);
    } finally {
      AbortSignal.timeout = origTimeout;
      AbortSignal.any = origAny;
    }
  });
});

describe("mapUpstreamTimeout", () => {
  it("converts TimeoutError to ProviderError 504 with provider label and duration", () => {
    assert.throws(
      () => mapUpstreamTimeout(timeoutError(), "GitLab"),
      (err: unknown) =>
        err instanceof ProviderError &&
        err.status === 504 &&
        err.message === `GitLab upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`
    );
  });

  it("rethrows non-timeout errors unchanged, including caller AbortError", () => {
    const boom = new Error("network down");
    assert.throws(() => mapUpstreamTimeout(boom, "GitLab"), (err: unknown) => err === boom);
    const abort = new DOMException("aborted", "AbortError");
    assert.throws(() => mapUpstreamTimeout(abort, "GitHub"), (err: unknown) => err === abort);
  });
});
