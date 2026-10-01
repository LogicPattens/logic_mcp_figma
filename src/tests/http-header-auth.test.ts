import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { startHttpServer, stopHttpServer, type HttpServerOptions } from "~/server.js";
import type { FigmaAuthOptions } from "~/services/figma.js";

const figmaFileResponse = {
  name: "Auth Test File",
  lastModified: "2026-01-01T00:00:00Z",
  thumbnailUrl: "",
  version: "1",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:1",
        name: "Page",
        type: "CANVAS",
        visible: true,
        children: [],
      },
    ],
  },
  components: {},
  componentSets: {},
  schemaVersion: 0,
  styles: {},
};

const emptyAuth = {
  figmaApiKey: "",
  figmaOAuthToken: "",
  useOAuth: false,
};

describe("HTTP header Figma API key authentication", () => {
  let client: Client;
  let httpServer: Server | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const realFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.figma.com")) {
        return Response.json(figmaFileResponse);
      }
      return realFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await client?.close();
    if (httpServer) {
      await stopHttpServer();
      httpServer = undefined;
    }
    vi.unstubAllGlobals();
  });

  async function connectClient(
    headers?: Record<string, string>,
    baseAuth: FigmaAuthOptions = emptyAuth,
    httpOptions: HttpServerOptions = {},
  ) {
    httpServer = await startHttpServer("127.0.0.1", 0, baseAuth, {}, httpOptions);
    const port = (httpServer.address() as AddressInfo).port;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: headers ? { headers } : undefined,
    });
    client = new Client({ name: "http-header-auth-test", version: "1.0.0" });
    await client.connect(transport);
  }

  function firstFigmaRequestHeaders(): Record<string, string> {
    const figmaCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("https://api.figma.com"),
    );
    const init = figmaCall?.[1] as RequestInit & { headers?: Record<string, string> };
    return init.headers ?? {};
  }

  function figmaRequestCount(): number {
    return fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("https://api.figma.com"),
    ).length;
  }

  it("uses X-Figma-Token from the HTTP request for get_figma_data", async () => {
    await connectClient({ "X-Figma-Token": "request-key" });

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    expect(firstFigmaRequestHeaders()).toMatchObject({ "X-Figma-Token": "request-key" });
  });

  it("uses X-Figma-Token from the HTTP request instead of the server API key", async () => {
    await connectClient(
      { "X-Figma-Token": "request-key" },
      { figmaApiKey: "server-key", figmaOAuthToken: "", useOAuth: false },
    );

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    expect(firstFigmaRequestHeaders()).toMatchObject({ "X-Figma-Token": "request-key" });
  });

  it("uses Authorization bearer tokens from the HTTP request for get_figma_data", async () => {
    await connectClient({ Authorization: "Bearer request-oauth-token" });

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    expect(firstFigmaRequestHeaders()).toMatchObject({
      Authorization: "Bearer request-oauth-token",
    });
  });

  it("uses HTTP Authorization bearer tokens instead of the server API key", async () => {
    await connectClient(
      { Authorization: "Bearer request-oauth-token" },
      { figmaApiKey: "server-key", figmaOAuthToken: "", useOAuth: false },
    );

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    expect(firstFigmaRequestHeaders()).toMatchObject({
      Authorization: "Bearer request-oauth-token",
    });
  });

  // Callers on a shared network may carry their own service JWT in
  // Authorization; X-Figma-Token must win so that JWT is never sent to Figma.
  it("prefers X-Figma-Token over an Authorization bearer token on the same request", async () => {
    await connectClient({
      "X-Figma-Token": "request-key",
      Authorization: "Bearer some-service-jwt",
    });

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    const headers = firstFigmaRequestHeaders();
    expect(headers).toMatchObject({ "X-Figma-Token": "request-key" });
    expect(headers).not.toHaveProperty("Authorization");
  });

  // With an internal token configured, Authorization is the caller's own
  // service auth. A request missing X-Figma-Token must fail, not leak it.
  it("never forwards an Authorization bearer token to Figma when an internal token is set", async () => {
    await connectClient(
      { "X-Internal-Auth": "s3cret", Authorization: "Bearer some-service-jwt" },
      emptyAuth,
      { internalToken: "s3cret" },
    );

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    // Only point at the channel this mode accepts: no Authorization hint, and
    // no FIGMA_API_KEY hint, since that would stop the server from starting.
    expect(result.content[0].type).toBe("text");
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toContain(
        "Send the tenant's Figma token in the X-Figma-Token",
      );
      expect(result.content[0].text).not.toContain("send X-Figma-Token / Authorization: Bearer");
      expect(result.content[0].text).not.toContain("Configure FIGMA_API_KEY");
    }
    const figmaCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("https://api.figma.com"),
    );
    expect(figmaCalls).toHaveLength(0);
  });

  it("still uses X-Figma-Token alongside a service JWT when an internal token is set", async () => {
    await connectClient(
      {
        "X-Internal-Auth": "s3cret",
        "X-Figma-Token": "request-key",
        Authorization: "Bearer some-service-jwt",
      },
      emptyAuth,
      { internalToken: "s3cret" },
    );

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    const headers = firstFigmaRequestHeaders();
    expect(headers).toMatchObject({ "X-Figma-Token": "request-key" });
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("returns a tool error when no server or request credentials are available", async () => {
    await connectClient();

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toContain(
        "send X-Figma-Token / Authorization: Bearer on the HTTP request",
      );
    }
    expect(figmaRequestCount()).toBe(0);
  });
});
