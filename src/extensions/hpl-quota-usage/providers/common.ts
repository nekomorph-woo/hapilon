import { Effect } from "effect";
import type { QuotaAuth } from "../types.js";

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

export function buildAuthHeaders(auth: QuotaAuth): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string" && value.length > 0) headers[key] = value;
  }
  if (auth.apiKey && !hasHeader(headers, "authorization")) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  return headers;
}

/**
 * chatgpt.com 等境外端点直连常超时；Node fetch 不读系统代理，
 * 需显式 dispatcher。按优先级探测：HTTPS(S)_PROXY env → macOS 系统代理。
 * undici 是 Node 内置依赖，ProxyAgent 失败（老 Node）→ 返回 undefined 走直连。
 */
async function proxyDispatcher(url: string): Promise<unknown | undefined> {
  const target = new URL(url);
  if (target.hostname !== "chatgpt.com") return undefined;

  const envProxy =
    process.env["HTTPS_PROXY"] ??
    process.env["https_proxy"] ??
    process.env["HTTP_PROXY"] ??
    process.env["http_proxy"];
  if (envProxy) return await createProxyAgent(envProxy);

  const systemProxy = await macosSystemHttpsProxy();
  if (systemProxy) return await createProxyAgent(systemProxy);

  return undefined;
}

async function createProxyAgent(proxyUrl: string): Promise<unknown | undefined> {
  try {
    const undici = await import("undici");
    return new undici.ProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

let cachedMacosProxy: string | undefined | null = null;

async function macosSystemHttpsProxy(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  if (cachedMacosProxy !== null) return cachedMacosProxy;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("scutil", ["--proxy"], { timeout: 3000 });
    const enabled = /HTTPSEnable\s*:\s*1/.test(stdout);
    const host = stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    cachedMacosProxy = enabled && host && port ? `http://${host}:${port}` : undefined;
  } catch {
    cachedMacosProxy = undefined;
  }
  return cachedMacosProxy;
}

export async function fetchJson(
  endpoint: string,
  auth: QuotaAuth,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const init: RequestInit = {
    method: "GET",
    headers: { ...buildAuthHeaders(auth), ...headers },
    signal: AbortSignal.timeout(10_000),
  };
  const dispatcher = await proxyDispatcher(endpoint);
  if (dispatcher) {
    (init as RequestInit & { dispatcher?: unknown }).dispatcher = dispatcher;
  }
  const response = await fetch(endpoint, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as unknown;
}

export function fetchJsonEffect(
  endpoint: string,
  auth: QuotaAuth,
  headers: Record<string, string> = {},
): Effect.Effect<unknown, Error> {
  return Effect.tryPromise({
    try: () => fetchJson(endpoint, auth, headers),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
}
