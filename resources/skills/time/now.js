#!/usr/bin/env node
// 输出一行当前系统时间：毫秒精度 ISO 格式 + UTC 偏移 + IANA 时区名
const d = new Date();
const pad = (n, w = 2) => String(n).padStart(w, "0");
const off = -d.getTimezoneOffset();
const sign = off >= 0 ? "+" : "-";
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
	`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
	`.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.abs(off) / 60)}:${pad(Math.abs(off) % 60)} ${tz}`,
);
