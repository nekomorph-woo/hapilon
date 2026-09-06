import { Effect } from "effect";
import { fetchJsonEffect } from "./common.js";
import { asRecord, field, UNKNOWN, unknownField, valueText, type QuotaAuth, type QuotaField } from "../types.js";

export const DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";

export function fetchQuotaEffect(auth: QuotaAuth): Effect.Effect<unknown, Error> {
  return fetchJsonEffect(DEEPSEEK_BALANCE_ENDPOINT, auth);
}

export function parseQuotaLines(payload: unknown): QuotaField[] {
  const root = asRecord(payload);
  const fields: QuotaField[] = [field("类型", "余额（非用量窗口）")];
  fields.push(field("可用", root?.is_available, root?.is_available === false ? "warning" : undefined));

  const balances = Array.isArray(root?.balance_infos) ? root.balance_infos : [];
  if (balances.length === 0) {
    fields.push(unknownField("余额"));
    return fields;
  }

  for (const item of balances) {
    const balance = asRecord(item);
    const currency = valueText(balance?.currency);
    fields.push(field(`${currency} 总余额`, balance?.total_balance));
    fields.push(field(`${currency} 赠送余额`, balance?.granted_balance));
    fields.push(field(`${currency} 充值余额`, balance?.topped_up_balance));
  }
  return fields;
}

export const parseDeepSeekQuota = parseQuotaLines;
