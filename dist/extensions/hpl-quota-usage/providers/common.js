import { Effect } from "effect";
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
export function fetchJsonEffect(endpoint, auth, headers = {}) {
    return Effect.tryPromise({
        try: async () => {
            const response = await fetch(endpoint, {
                method: "GET",
                headers: { ...buildAuthHeaders(auth), ...headers },
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return await response.json();
        },
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
    });
}
