import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJSON } from "~/utils/fetch-json.js";
import { getErrorMeta } from "~/utils/error-meta.js";

describe("fetchJSON timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("aborts after FIGMA_TIMEOUT_MS and explains how to narrow the request", async () => {
    vi.stubEnv("FIGMA_TIMEOUT_MS", "20");
    // A Figma API that never answers, but honors the abort signal like real fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );

    const error = await fetchJSON("https://api.figma.com/v1/files/abc").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("did not respond within 0.02s");
    expect(getErrorMeta(error)).toMatchObject({ category: "network", is_retryable: true });
  });
});
