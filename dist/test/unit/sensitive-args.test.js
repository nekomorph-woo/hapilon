import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPathArgs, hasSensitiveReadArg, splitCommandSegments, } from "../../extensions/hpl-safety-gate/sensitive-args.js";
describe("splitCommandSegments()", () => {
    it("按管道/分号/&&/|| 切分复合命令", () => {
        const segs = splitCommandSegments("cat .env | grep SECRET && echo done");
        assert.deepEqual(segs, ["cat .env ", " grep SECRET ", " echo done"]);
    });
    it("无操作符时返回单段", () => {
        assert.deepEqual(splitCommandSegments("cat package.json"), ["cat package.json"]);
    });
});
describe("extractPathArgs()", () => {
    it("提取普通文件参数，跳过 flag", () => {
        const args = extractPathArgs("cat -n src/config.ts", "/proj");
        assert.deepEqual(args, ["src/config.ts"]);
    });
    it("跳过命令自身与已知 flag（-n / --color）", () => {
        const args = extractPathArgs("grep -n --color=auto SECRET .env", "/proj");
        assert.deepEqual(args, [".env"]);
    });
    it("忽略重定向方向符与 /dev/null", () => {
        const args = extractPathArgs("echo x > /dev/null", "/proj");
        assert.deepEqual(args, ["x"]);
    });
    it("剥掉引号", () => {
        const args = extractPathArgs('cat ".env"', "/proj");
        assert.deepEqual(args, [".env"]);
    });
});
describe("hasSensitiveReadArg()", () => {
    const cases = [
        ["cat .env", true, "env 相对路径"],
        ["cat /proj/.env.local", true, "env 变体绝对路径"],
        ["head -20 ~/.npmrc", true, "npm token"],
        ["cat ~/.ssh/id_rsa", true, "SSH key"],
        ["cat ~/.aws/credentials", true, "AWS 凭证"],
        ["cat .env.example", false, "env 模板白名单"],
        ["cat .env.sample", false, "env sample 白名单"],
        ["cat package.json", false, "普通文件"],
        ["echo SECRET=1 > .env", false, "写操作不在此判定（写路径另查）"],
        ["grep SECRET .env.example", false, "grep 模板文件"],
        ["cat", false, "无参数"],
        ["", false, "空命令"],
    ];
    for (const [cmd, want, why] of cases) {
        it(`${cmd || "(空)"} → ${want}（${why}）`, () => {
            assert.equal(hasSensitiveReadArg(cmd, "/proj"), want);
        });
    }
    it("复合命令：cat 正常文件 | xargs cat .env 仍命中", () => {
        assert.equal(hasSensitiveReadArg("cat list.txt | xargs cat .env", "/proj"), true);
    });
});
