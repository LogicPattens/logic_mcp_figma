import { afterEach, describe, expect, it } from "vitest";
import { request } from "http";
import type { AddressInfo } from "net";
import { startHttpServer, stopHttpServer, type HttpServerOptions } from "~/server.js";

const emptyAuth = { figmaApiKey: "", figmaOAuthToken: "", useOAuth: false };

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "access-control-test", version: "1.0.0" },
  },
  id: 1,
});

// node:http rather than fetch because fetch won't let us override Host.
function send(
  port: number,
  opts: { method: "GET" | "POST"; path: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method,
        path: opts.path,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.method === "POST") req.write(initializeBody);
    req.end();
  });
}

describe("HTTP access control", () => {
  afterEach(async () => {
    await stopHttpServer();
  });

  async function start(httpOptions: HttpServerOptions): Promise<number> {
    const server = await startHttpServer("127.0.0.1", 0, emptyAuth, {}, httpOptions);
    return (server.address() as AddressInfo).port;
  }

  it("rejects MCP requests with a missing or wrong X-Internal-Auth when a token is set", async () => {
    const port = await start({ internalToken: "s3cret" });

    const missing = await send(port, { method: "POST", path: "/mcp" });
    const wrong = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: { "X-Internal-Auth": "s3creX" },
    });
    const wrongOnSse = await send(port, {
      method: "POST",
      path: "/sse",
      headers: { "X-Internal-Auth": "nope" },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrongOnSse.status).toBe(401);
  });

  it("accepts MCP requests with the correct X-Internal-Auth", async () => {
    const port = await start({ internalToken: "s3cret" });

    const res = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: { "X-Internal-Auth": "s3cret" },
    });

    expect(res.status).toBe(200);
  });

  it("leaves MCP routes open when no internal token is configured", async () => {
    const port = await start({});

    const res = await send(port, { method: "POST", path: "/mcp" });

    expect(res.status).toBe(200);
  });

  it("rejects requests whose Host is not on the allow-list", async () => {
    const port = await start({ allowedHosts: ["figma-mcp", "localhost"] });

    const rejected = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: { Host: `evil.example:${port}` },
    });
    const allowed = await send(port, {
      method: "POST",
      path: "/mcp",
      headers: { Host: `figma-mcp:${port}` },
    });

    expect(rejected.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it("serves /healthz without the internal token but still enforces Host", async () => {
    const port = await start({ internalToken: "s3cret", allowedHosts: ["localhost"] });

    const ok = await send(port, {
      method: "GET",
      path: "/healthz",
      headers: { Host: `localhost:${port}` },
    });
    const badHost = await send(port, {
      method: "GET",
      path: "/healthz",
      headers: { Host: `evil.example:${port}` },
    });

    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ status: "ok" });
    expect(badHost.status).toBe(403);
  });
});
