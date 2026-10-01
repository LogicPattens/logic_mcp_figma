import { afterEach, describe, expect, it, vi } from "vitest";
import {
  envBool,
  envInt,
  envStr,
  MIN_INTERNAL_TOKEN_LENGTH,
  parseAllowedHosts,
  parseInternalToken,
  rejectGlobalCredentialsWithInternalToken,
  resolve,
  UsageError,
} from "~/config.js";

describe("resolve", () => {
  it("CLI flag wins over env and default", () => {
    const result = resolve("from-cli", "from-env", "fallback");
    expect(result).toEqual({ value: "from-cli", source: "cli" });
  });

  it("env wins over default when flag is undefined", () => {
    const result = resolve(undefined, "from-env", "fallback");
    expect(result).toEqual({ value: "from-env", source: "env" });
  });

  it("default is used when both flag and env are undefined", () => {
    const result = resolve(undefined, undefined, "fallback");
    expect(result).toEqual({ value: "fallback", source: "default" });
  });

  it("preserves falsy flag values (false, 0) instead of falling through", () => {
    expect(resolve(false, true, true)).toEqual({ value: false, source: "cli" });
    expect(resolve(0, 42, 99)).toEqual({ value: 0, source: "cli" });
  });
});

describe("envStr", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the env var value when set", () => {
    vi.stubEnv("TEST_STR", "hello");
    expect(envStr("TEST_STR")).toBe("hello");
  });

  it("returns undefined when env var is not set", () => {
    expect(envStr("TEST_STR_MISSING")).toBeUndefined();
  });

  it("returns undefined when env var is empty string", () => {
    vi.stubEnv("TEST_STR_EMPTY", "");
    expect(envStr("TEST_STR_EMPTY")).toBeUndefined();
  });
});

describe("envInt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns parsed integer when set", () => {
    vi.stubEnv("TEST_INT", "42");
    expect(envInt("TEST_INT")).toBe(42);
  });

  it("tries names in order and returns first match", () => {
    vi.stubEnv("TEST_INT_B", "99");
    expect(envInt("TEST_INT_A", "TEST_INT_B")).toBe(99);
  });

  it("returns undefined when none of the names are set", () => {
    expect(envInt("NOPE_A", "NOPE_B")).toBeUndefined();
  });
});

describe("envBool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true for "true"', () => {
    vi.stubEnv("TEST_BOOL", "true");
    expect(envBool("TEST_BOOL")).toBe(true);
  });

  it('returns false for "false"', () => {
    vi.stubEnv("TEST_BOOL", "false");
    expect(envBool("TEST_BOOL")).toBe(false);
  });

  it("returns undefined for any other value", () => {
    vi.stubEnv("TEST_BOOL", "yes");
    expect(envBool("TEST_BOOL")).toBeUndefined();
  });

  it("returns undefined when not set", () => {
    expect(envBool("TEST_BOOL_MISSING")).toBeUndefined();
  });
});

describe("rejectGlobalCredentialsWithInternalToken", () => {
  const noAuth = { figmaApiKey: "", figmaOAuthToken: "", useOAuth: false };

  it("rejects a global API key when an internal token is set", () => {
    expect(() =>
      rejectGlobalCredentialsWithInternalToken({ ...noAuth, figmaApiKey: "pat" }, "s3cret"),
    ).toThrow(UsageError);
  });

  it("rejects a global OAuth token when an internal token is set", () => {
    expect(() =>
      rejectGlobalCredentialsWithInternalToken(
        { ...noAuth, figmaOAuthToken: "oauth", useOAuth: true },
        "s3cret",
      ),
    ).toThrow(/MCP_INTERNAL_TOKEN/);
  });

  it("allows per-request credentials only when an internal token is set", () => {
    expect(() => rejectGlobalCredentialsWithInternalToken(noAuth, "s3cret")).not.toThrow();
  });

  it("allows global credentials when no internal token is set", () => {
    expect(() =>
      rejectGlobalCredentialsWithInternalToken({ ...noAuth, figmaApiKey: "pat" }, undefined),
    ).not.toThrow();
  });
});

describe("parseAllowedHosts", () => {
  it("lower-cases, trims and drops empty entries", () => {
    expect(parseAllowedHosts(" Figma-MCP , ,LOCALHOST,")).toEqual(["figma-mcp", "localhost"]);
  });

  it("returns undefined when unset or only separators", () => {
    expect(parseAllowedHosts(undefined)).toBeUndefined();
    expect(parseAllowedHosts(" , ")).toBeUndefined();
  });
});

describe("parseInternalToken", () => {
  const valid = "a".repeat(MIN_INTERNAL_TOKEN_LENGTH);

  it("returns undefined when unset", () => {
    expect(parseInternalToken(undefined)).toBeUndefined();
  });

  it("trims surrounding whitespace such as a trailing newline", () => {
    expect(parseInternalToken(`  ${valid}\n`)).toBe(valid);
  });

  it("rejects a token shorter than the minimum", () => {
    expect(() => parseInternalToken("a".repeat(MIN_INTERNAL_TOKEN_LENGTH - 1))).toThrow(UsageError);
  });

  it("rejects a set-but-blank token instead of leaving the endpoint open", () => {
    expect(() => parseInternalToken("   \n")).toThrow(/at least/);
  });
});
