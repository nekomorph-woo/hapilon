# 敏感文件读取确认

## 子功能

安全门在 Bash 工具运行前判断操作是否会把受保护的文件内容交给模型。只列属性、命令正文中的测试字符串、或能确认只在程序内部使用内容的操作，不应弹窗。路径作为程序参数时，验收区分可分析的文本、二进制和不可读程序。确知会披露内容，或无法确认用途时，应弹窗。

## 用户怎么进入

在 hapi 主会话里让模型使用 Bash 工具。启用 `/gate-auto-mode on` 后，安全门会尝试分析可读的本地程序。模型返回 `allow` 时免确认；其余判断、超时或无法分析时仍弹窗。分析复用 Auto 模型，超时为 5 分钟或 `gateAuto.timeoutMs`，取较大值。本验收使用本机模型替身，不建立会话或项目级信任。

## 用 Pi RPC 验收

从仓库根目录运行：

```sh
.hapilon/agents/skills/verify-hapilon/sensitive-file-confirmation.mjs --doctor
.hapilon/agents/skills/verify-hapilon/sensitive-file-confirmation.mjs
```

| 用例 | 用户可观察的预期 |
| --- | --- |
| `listing-control` | `ls` 输出文件名，无确认。 |
| `inline-data` | Node 的标准输入中包含路径字符串，输出 `INLINE_OK`，无确认。 |
| `metadata` | `stat` 只输出属性，无确认。 |
| `text-no-disclosure` | 模型返回 `allow`，文本脚本输出 `TEXT_OK`，无确认。 |
| `binary-no-disclosure` | 模型返回 `allow`，二进制输出 `BINARY_OK`，无确认。 |
| `binary-unsure` | 对同一二进制返回 `unsure`，应确认。 |
| `text-disclosure` | 脚本会把夹具内容输出到工具结果，应确认；拒绝后模型收到工具错误。 |
| `unreadable` | 运行账号不可读脚本，无法分析，应确认。 |
| `direct-read` | 直接读取内容，应确认；拒绝后模型收到工具错误。 |

每条用例检查模型端点收到的请求。结果不能含有假凭证标记。`judge-input` 记录用途分析收到的证据，`model-input` 记录会话模型收到的工具结果。确认请求和断言也写入 `events.jsonl`。

## 易错点

- 文件名取样来自现有读保护规则的覆盖范围。脚本会检查夹具仍命中规则，不复制规则清单。
- 验收拒绝所有确认请求，不把未执行的命令算作已验证输出。
- 二进制用例验证安全门如何执行模型裁决。模型替身的返回值是预设的，不验证真实模型能否从符号判断数据流。
- 证据只覆盖本机模型替身、固定命令和 Bash 工具。不要把结果外推到终端渲染、未知程序或已保存信任的会话。
