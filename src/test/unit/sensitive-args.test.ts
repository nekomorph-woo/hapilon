import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPathArgs,
  hasSensitiveReadArg,
  splitCommandSegments,
} from "../../extensions/hpl-safety-gate/sensitive-args.js";

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
  const cases: Array<[string, boolean, string]> = [
    ["ls -la .env", false, "列文件属性"],
    ["ls -ld -- './.env.local'", false, "列字面路径属性"],
    ["ls -lh .env", false, "只改变属性的显示格式"],
    ["stat .env", false, "只查询文件属性"],
    ["ls -l ~/.npmrc", false, "列出家目录文件属性"],
    ["ls --unknown .env", true, "未识别的选项保留确认"],
    ["cat < .env", true, "标准输入来自受保护文件"],
    ["cat <.env", true, "紧贴重定向符的文件名也受保护"],
    ["wc -l .env", true, "计数也读取内容"],
    ["docker compose --env-file .env up", true, "应用读取配置"],
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

  it("内嵌 Node 程序只输出字面数据的派生值，不视为文件读取", () => {
    const command = [
      "node --input-type=module <<'JS'",
      "const names = [ '.env', 'demo.kubeconfig' ];",
      "console.log(names.length === 2 ? 'OK' : 'BAD');",
      "JS",
    ].join("\n");
    assert.equal(hasSensitiveReadArg(command, "/proj"), false);
    assert.equal(hasSensitiveReadArg(`${command}\ncat .env`, "/proj"), true);
  });

  it("不能判明内嵌 Node 程序用途时保留路径检查", () => {
    const command = ["node --input-type=module <<'JS'", "await inspect( '.env' );", "JS"].join("\n");
    assert.equal(hasSensitiveReadArg(command, "/proj"), true);
  });

  it("复合命令：cat 正常文件 | xargs cat .env 仍命中", () => {
    assert.equal(hasSensitiveReadArg("cat list.txt | xargs cat .env", "/proj"), true);
  });
});
