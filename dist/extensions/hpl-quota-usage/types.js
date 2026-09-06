export const UNKNOWN = "unknown";
export function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
export function valueText(value) {
    if (value === null || value === undefined || value === "")
        return UNKNOWN;
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    return UNKNOWN;
}
export function field(label, value, tone) {
    const text = valueText(value);
    return { label, value: text, ...(tone ? { tone } : {}) };
}
export function unknownField(label) {
    return field(label, UNKNOWN, "warning");
}
export function firstValue(record, keys) {
    if (!record)
        return undefined;
    for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null)
            return record[key];
    }
    return undefined;
}
