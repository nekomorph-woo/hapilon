import { Effect } from "effect";
/** HTTP 状态错误是确定性失败，与传输层失败（连接/超时/解析）区分开，不触发直连重试 */
class HttpError extends Error {
    status;
    constructor(status) {
        super(`HTTP ${status}`);
        this.status = status;
        this.name = "HttpError";
    }
}
const hasHeader = (headers, name) => Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
export function buildAuthHeaders(auth) {
    const headers = { Accept: "application/json" };
    for (const [key, value] of Object.entries(auth.headers ?? {})) {
        if (typeof value === "string" && value.length > 0)
            headers[key] = value;
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
async function proxyDispatcher(url) {
    const target = new URL(url);
    if (target.hostname !== "chatgpt.com")
        return undefined;
    const envProxy = process.env["HTTPS_PROXY"] ??
        process.env["https_proxy"] ??
        process.env["HTTP_PROXY"] ??
        process.env["http_proxy"];
    if (envProxy)
        return await createProxyAgent(envProxy);
    const systemProxy = await macosSystemHttpsProxy();
    if (systemProxy)
        return await createProxyAgent(systemProxy);
    return undefined;
}
async function createProxyAgent(proxyUrl) {
    try {
        const undici = await import("undici");
        return new undici.ProxyAgent(proxyUrl);
    }
    catch {
        return undefined;
    }
}
let cachedMacosProxy = null;
async function macosSystemHttpsProxy() {
    if (process.platform !== "darwin")
        return undefined;
    if (cachedMacosProxy !== null)
        return cachedMacosProxy;
    try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const { stdout } = await promisify(execFile)("scutil", ["--proxy"], { timeout: 3000 });
        const enabled = /HTTPSEnable\s*:\s*1/.test(stdout);
        const host = stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
        const port = stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
        cachedMacosProxy = enabled && host && port ? `http://${host}:${port}` : undefined;
    }
    catch {
        cachedMacosProxy = undefined;
    }
    return cachedMacosProxy;
}
/**
 * dispatcher 必须配同一份 undici 的 fetch：npm undici 的 ProxyAgent 塞进
 * Node 内置 fetch（自带另一份 undici）会因 dispatcher 协议版本不匹配直接抛
 * "invalid onRequestStart method"，与代理健康与否无关。
 */
async function requestJson(endpoint, headers, signal, dispatcher) {
    if (dispatcher === undefined) {
        const response = await fetch(endpoint, { method: "GET", headers, signal });
        if (!response.ok)
            throw new HttpError(response.status);
        return await response.json();
    }
    const undici = await import("undici");
    const response = await undici.fetch(endpoint, { method: "GET", headers, signal, dispatcher });
    if (!response.ok)
        throw new HttpError(response.status);
    return await response.json();
}
export async function fetchJson(endpoint, auth, headers = {}) {
    const requestHeaders = { ...buildAuthHeaders(auth), ...headers };
    const dispatcher = await proxyDispatcher(endpoint);
    try {
        return await requestJson(endpoint, requestHeaders, AbortSignal.timeout(10_000), dispatcher);
    }
    catch (error) {
        if (dispatcher === undefined)
            throw error;
        // 系统代理常开但进程不可用（或代理黑洞）时直连兑底；直连仍失败才向调用方抛错。
        // HTTP 4xx/5xx 是服务端确定性回答，重试直连注定同样失败，直接透传
        if (error instanceof HttpError)
            throw error;
        return await requestJson(endpoint, requestHeaders, AbortSignal.timeout(10_000), undefined);
    }
}
export function fetchJsonEffect(endpoint, auth, headers = {}) {
    return Effect.tryPromise({
        try: () => fetchJson(endpoint, auth, headers),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
    });
}
