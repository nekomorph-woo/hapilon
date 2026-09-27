// argumentCompletions 纯函数单测：fuzzy 多 token 匹配、整段替换语义、null 约定。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { argumentCompletions } from "../../shared/argument-completion.js";
function values(items) {
    return items.map((i) => i.value);
}
const FLAGS = [
    { value: "ponytail", label: "ponytail", description: "会话级体量与形状对照" },
    { value: "ponytail --group-by ", label: "--group-by", description: "按档位分组", searchText: "ponytail --group-by 按档位分组" },
    { value: "ponytail --since ", label: "--since", description: "只看该日期之后的会话", searchText: "ponytail --since 只看日期" },
    { value: "ponytail --json ", label: "--json", description: "输出 JSON", searchText: "ponytail --json 输出 JSON" },
];
describe("argumentCompletions", () => {
    it("空 query 返回全量候选", () => {
        assert.equal(argumentCompletions(FLAGS, "")?.length, 4);
    });
    it("多 token 子序列匹配：子命令 + flag 前缀命中对应 flag，value 为整段替换文本", () => {
        const hits = values(argumentCompletions(FLAGS, "ponytail --g") ?? []);
        assert.deepEqual(hits, ["ponytail --group-by "], "选中后整段替换成合法命令");
    });
    it("token 不命中返回 null（pi 约定 null = 无补全，而非空数组）", () => {
        assert.equal(argumentCompletions(FLAGS, "ponytail --nonexistent"), null);
    });
    it("大小写不敏感、query 首尾空白被容忍；命中子命令时其 flags 一并浮出", () => {
        assert.deepEqual(values(argumentCompletions(FLAGS, "  PONYTAIL  ") ?? []), ["ponytail", "ponytail --group-by ", "ponytail --since ", "ponytail --json "], "子命令排首，其参数候选跟出——提示可用后续");
    });
    it("searchText 缺省时用 value + description 参与匹配", () => {
        const cands = [
            { value: "on", label: "on", description: "开启自适应选模" },
            { value: "off", label: "off" },
        ];
        assert.deepEqual(values(argumentCompletions(cands, "on") ?? []), ["on"]);
        // description 里的「开」参与匹配；off 无 description，token "开" 不命中
        assert.deepEqual(values(argumentCompletions(cands, "开") ?? []), ["on"]);
    });
});
