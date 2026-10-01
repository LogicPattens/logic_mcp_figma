import { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "http";
import { timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProxyAgent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { Logger } from "./utils/logger.js";
import { hasProxyEnv, setProxyMode } from "./utils/proxy-env.js";
import { createServer, type CreateServerOptions } from "./mcp/index.js";
import { requireGlobalCredentials, type ServerConfig } from "./config.js";
import type { FigmaAuthOptions } from "./services/figma.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as telemetry from "./telemetry/index.js";

let httpServer: Server | null = null;

type ActiveConnection = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};
const activeConnections = new Set<ActiveConnection>();

/**
 * Start the MCP server in either stdio or HTTP mode.
 */
export async function startServer(config: ServerConfig): Promise<void> {
  // Stdio has no per-request credential channel, so the server is unusable
  // without something resolved at startup. Fail fast BEFORE any side effects
  // (proxy install, telemetry init) — preserves the pre-PR behavior where
  // resolveAuth() exited early during config resolution.
  if (config.isStdioMode) {
    requireGlobalCredentials(config.auth);
  }

  // Three outcomes: explicit proxy URL → ProxyAgent; no proxy but env vars set
  // → EnvHttpProxyAgent; otherwise Node's default (includes `--proxy=none`,
  // which lets users opt out of system-level proxy vars misbehaving for
  // api.figma.com — see issue #358).
  //
  // We deliberately do NOT install EnvHttpProxyAgent when no proxy vars are
  // present, so a stale or incidental var in the user's shell (VPN client,
  // old dev setup) can't silently route Figma traffic through an intermediary
  // that may return 403.
  if (config.proxy && config.proxy !== "none") {
    setGlobalDispatcher(new ProxyAgent(config.proxy));
    setProxyMode("explicit");
  } else if (!config.proxy && hasProxyEnv()) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    setProxyMode("env");
  }

  const telemetryEnabled = telemetry.initTelemetry({
    optOut: config.noTelemetry,
    redactFromErrors: [
      config.auth.figmaApiKey,
      config.auth.figmaOAuthToken,
      config.internalToken ?? "",
    ],
  });

  if (telemetryEnabled) {
    // stderr (not Logger.log) because in HTTP mode Logger.log writes to stdout,
    // and in stdio mode stdout is reserved for MCP protocol messages. stderr
    // is safe in both modes.
    process.stderr.write(
      "Usage telemetry enabled. Disable: FRAMELINK_TELEMETRY=off or DO_NOT_TRACK=1\n",
    );
  }

  const serverOptions = {
    transport: config.isStdioMode ? ("stdio" as const) : ("http" as const),
    outputFormat: config.outputFormat,
    skipImageDownloads: config.skipImageDownloads,
    imageDir: config.imageDir,
  };

  if (config.isStdioMode) {
    // MCP clients spawn stdio servers with whatever cwd they were started in,
    // which is rarely the user's project root. Warn so a missing --image-dir
    // doesn't silently send images to e.g. the client's install directory.
    // Gated on !skipImageDownloads — without the download tool the warning
    // is misleading.
    if (config.configSources.imageDir === "default" && !config.skipImageDownloads) {
      process.stderr.write(
        `Warning: --image-dir not set; download_figma_images will save under the server's cwd (${config.imageDir}). ` +
          `MCP clients often launch the server outside your project root — set IMAGE_DIR or pass --image-dir to make this explicit.\n`,
      );
    }
    const server = createServer(config.auth, serverOptions);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    registerShutdownHandlers(async () => {});
  } else {
    console.log(`Initializing Figma MCP Server in HTTP mode on ${config.host}:${config.port}...`);
    await startHttpServer(config.host, config.port, config.auth, serverOptions, {
      allowedHosts: config.allowedHosts,
      internalToken: config.internalToken,
    });

    registerShutdownHandlers(async () => {
      Logger.log("Shutting down server...");
      await stopHttpServer();
      Logger.log("Server shutdown complete");
    });
  }
}

/**
 * Register SIGINT + SIGTERM handlers that run mode-specific cleanup and then
 * flush telemetry before exiting. MCP hosts commonly send SIGTERM, so both
 * signals must be handled in both transport modes.
 *
 * Idempotent: if both signals fire (or a signal fires twice) the second
 * invocation is ignored so we never double-shutdown.
 */
function registerShutdownHandlers(onShutdown: () => Promise<void>): void {
  let shuttingDown = false;
  const handle = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // onShutdown may throw (e.g. stopHttpServer failures); telemetry.shutdown
    // swallows its own errors (see src/telemetry/client.ts). Use try/finally
    // so process.exit(0) always runs regardless of onShutdown failure.
    try {
      await onShutdown();
    } finally {
      await telemetry.shutdown();
      process.exit(0);
    }
  };
  process.on("SIGINT", handle);
  process.on("SIGTERM", handle);
}

export type HttpServerOptions = {
  /**
   * Host-header allow-list. The SDK only enables DNS-rebinding protection on
   * its own for loopback binds, so a container bound to 0.0.0.0 accepts any
   * Host unless this is set.
   */
  allowedHosts?: string[];
  /**
   * Shared secret required in `X-Internal-Auth` on MCP routes. A dedicated
   * header is used because `Authorization: Bearer` is already claimed as a
   * Figma OAuth token and would be forwarded to api.figma.com.
   */
  internalToken?: string;
};

export async function startHttpServer(
  host: string,
  port: number,
  baseAuth: FigmaAuthOptions,
  serverOptions: Omit<CreateServerOptions, "transport">,
  httpOptions: HttpServerOptions = {},
): Promise<Server> {
  if (httpServer) {
    throw new Error("HTTP server is already running");
  }

  const app = createMcpExpressApp({ host, allowedHosts: httpOptions.allowedHosts });

  // Registered after host validation (so probes must send an allowed Host)
  // but deliberately outside the internal-token check so orchestrators can
  // probe without holding the secret.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", version: process.env.NPM_PACKAGE_VERSION ?? "unknown" });
  });

  const handlePost = async (req: Request, res: Response) => {
    Logger.log("Received StreamableHTTP request");
    const requestKey = getRequestApiKey(req);
    const requestBearerToken = getRequestBearerToken(req);
    const auth = resolveRequestAuth(baseAuth, requestKey, requestBearerToken);
    const requestSecrets = [requestKey, requestBearerToken].filter(
      (secret): secret is string => !!secret,
    );

    // Request-level credentials are not known to telemetry's init-time
    // redaction list, so make them available only for this request scope.
    await telemetry.withRequestSecrets(requestSecrets, async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = createServer(auth, { ...serverOptions, transport: "http" });
      const conn: ActiveConnection = { transport, server: mcpServer };
      activeConnections.add(conn);
      res.on("close", () => {
        activeConnections.delete(conn);
        transport.close();
        mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      Logger.log("StreamableHTTP request handled");
    });
  };

  const handleMethodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  };

  const auth = requireInternalToken(httpOptions.internalToken);

  // Mount stateless StreamableHTTP on both /mcp and /sse.
  // Serving StreamableHTTP at /sse lets existing client configs keep working —
  // modern MCP clients probe with a POST before falling back to SSE.
  for (const path of ["/mcp", "/sse"]) {
    app.post(path, auth, handlePost);
    app.get(path, handleMethodNotAllowed);
    app.delete(path, handleMethodNotAllowed);
  }

  // Express 5 forwards rejected promises from async handlers here.
  // Return a JSON-RPC error instead of Express's default HTML 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    Logger.log("Unhandled error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: ErrorCode.InternalError, message: "Internal server error" },
        id: null,
      });
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      Logger.log(`HTTP server listening on port ${port}`);
      Logger.log(`StreamableHTTP endpoint available at http://${host}:${port}/mcp`);
      Logger.log(
        `StreamableHTTP endpoint available at http://${host}:${port}/sse (backward compat)`,
      );
      resolve(server);
    });
    server.once("error", (err) => {
      httpServer = null;
      reject(err);
    });
    httpServer = server;
  });
}

function requireInternalToken(expected: string | undefined) {
  const expectedBuf = expected ? Buffer.from(expected) : undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    // Unset means open — the upstream default, and what local dev relies on.
    if (!expectedBuf) return next();
    const raw = req.headers["x-internal-auth"];
    const provided = Buffer.from((Array.isArray(raw) ? raw[0] : raw) ?? "");
    // timingSafeEqual throws on length mismatch, so compare lengths first;
    // that leaks only the secret's length, not its content.
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: ErrorCode.InvalidRequest, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    next();
  };
}

function resolveRequestAuth(
  baseAuth: FigmaAuthOptions,
  requestKey: string | undefined,
  requestBearerToken: string | undefined,
): FigmaAuthOptions {
  if (requestKey) {
    return {
      figmaApiKey: requestKey,
      figmaOAuthToken: "",
      useOAuth: false,
    };
  }

  if (requestBearerToken) {
    return {
      figmaApiKey: "",
      figmaOAuthToken: requestBearerToken,
      useOAuth: true,
    };
  }

  return baseAuth;
}

function getRequestApiKey(req: Request): string | undefined {
  const value = req.headers["x-figma-token"];
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.trim() || undefined;
}

function getRequestBearerToken(req: Request): string | undefined {
  const value = req.headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export async function stopHttpServer(): Promise<void> {
  if (!httpServer) {
    throw new Error("HTTP server is not running");
  }

  // Gracefully close all active MCP connections before tearing down the server
  for (const conn of activeConnections) {
    await conn.transport.close();
    await conn.server.close();
  }
  activeConnections.clear();

  return new Promise((resolve, reject) => {
    httpServer!.close((err) => {
      httpServer = null;
      if (err) reject(err);
      else resolve();
    });
    httpServer!.closeAllConnections();
  });
}
