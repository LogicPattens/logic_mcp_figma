import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import { startHttpServer, stopHttpServer } from "~/server.js";

const emptyAuth = { figmaApiKey: "", figmaOAuthToken: "", useOAuth: false };
const RENDER_URL = "https://figma-renders.test/1-2.png";
// Smallest valid PNG (1x1), so image processing can read real dimensions.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("per-tenant image downloads", () => {
  let imageDir: string;
  let client: Client | undefined;

  beforeEach(() => {
    imageDir = mkdtempSync(join(tmpdir(), "figma-tenants-"));
    // Figma is the system boundary: mock the render API and the render URL.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.figma.com/v1/images/")) {
          return Response.json({ images: { "1:2": RENDER_URL } });
        }
        if (url === RENDER_URL) return new Response(PNG_1X1);
        return realFetch(input, init);
      }),
    );
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await stopHttpServer();
    vi.unstubAllGlobals();
    rmSync(imageDir, { recursive: true, force: true });
  });

  async function downloadAs(tenantId: string, localPath: string) {
    const server = await startHttpServer(
      "127.0.0.1",
      0,
      emptyAuth,
      { imageDir },
      { internalToken: "s3cret" },
    );
    const port = (server.address() as AddressInfo).port;
    client = new Client({ name: "tenant-downloads-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: {
          headers: {
            "X-Internal-Auth": "s3cret",
            "X-Tenant-ID": tenantId,
            "X-Figma-Token": "tenant-key",
          },
        },
      }),
    );
    return client.request(
      {
        method: "tools/call",
        params: {
          name: "download_figma_images",
          arguments: {
            fileKey: "abc123",
            nodes: [{ nodeId: "1:2", fileName: "card.png" }],
            localPath,
          },
        },
      },
      CallToolResultSchema,
    );
  }

  it("saves a package under IMAGE_DIR/<tenant>/<localPath>", async () => {
    const result = await downloadAs("acme", "Todo-Card");

    expect(result.isError).toBeUndefined();
    const packageDir = join(imageDir, "acme", "Todo-Card");
    expect(readdirSync(packageDir)).toEqual(["card.png"]);
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toContain(packageDir);
    }
  });

  // Absolute and inside IMAGE_DIR, so only the per-tenant scoping stops it;
  // a "../" path would be rejected even without tenants.
  it("cannot write into another tenant's folder", async () => {
    const result = await downloadAs("acme", join(imageDir, "globex", "Todo-Card"));

    expect(result.isError).toBe(true);
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toContain("resolves outside the allowed image directory");
    }
    expect(existsSync(join(imageDir, "globex"))).toBe(false);
  });
});
