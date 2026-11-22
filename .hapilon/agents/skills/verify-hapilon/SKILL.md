---
name: verify-hapilon
description: 运行本仓库构建的 hapi，通过命令行或 Pi RPC 验证用户可见行为并保留证据。改动安全确认、CLI 或扩展运行行为后使用；只改内部逻辑且单测能覆盖时不用，发版走 hapilon-release。
---

# 验证 hapi

## Launch

从仓库根目录运行 `npm run build`。每次验收由脚本启动 `node dist/cli.js --mode rpc`，不连接当前 pane。脚本创建独立的家目录、hapi 数据目录和工作区，在本机回环地址启动模型替身。它不读现有登录配置，也不连接远端模型。RPC 是 Pi 的远程过程调用接口，这里通过子进程标准输入和输出使用。

需要非 root 的 POSIX 账号、项目依赖和 C 编译器 `cc`。不可读用例依赖文件权限，二进制用例依赖 `cc`。启动成功须同时满足 Doctor 的检查。脚本退出时按 Cleanup 收尾。

## Doctor

```sh
.hapilon/agents/skills/verify-hapilon/sensitive-file-confirmation.mjs --doctor
```

核对仓库版本与 `dist/cli.js --version`，再通过 RPC `get_state` 检查启动状态、模型与本地端点。通过 `get_commands` 检查安全门已注册 `/gate-auto-mode`。Doctor 只读产品状态，不派发命令或改用户配置。失败时查本次 `events.jsonl` 的 `harness-error` 和 `stderr`，不要改用当前会话补跑。

## Drive

从[功能地图](features/README.md)选择用户入口。安全门验收用固定命令，逐例开启新会话；它不会接受外部传入的命令或文件路径。

```sh
.hapilon/agents/skills/verify-hapilon/sensitive-file-confirmation.mjs
```

脚本收到确认请求一律拒绝。它不会为消除红灯而批准命令或放宽用例。退出码 `0` 表示行为符合预期，`1` 表示行为不符，`2` 表示验收环境或协议失败。

## Evidence

脚本打印证据路径 `.hapilon/verify/<用例>-<随机后缀>/events.jsonl`。核对 `case`、`rpc`、`model-input` 和 `verdict`，分别看发出的命令、确认请求与工具结果、模型实际收到的工具结果和断言。测试文件只能放假凭证。不得用真实敏感文件录制证据。

RPC 能证明 hapi 发出确认请求及下一次模型请求包含什么，不能证明终端弹窗的布局或焦点。涉及这些行为时，必须在验证终端里另外观察，不能用 RPC 结果代替读屏。

## Cleanup

脚本退出时关闭它启动的 hapi 和本地端点，只删除本次临时目录。证据目录不清理。检查最后一条 `cleaned` 和证据文件是否可读。若脚本被强制终止，用这次 `ready` 记录的进程号辨认实例；不按进程名批量结束进程。

## Helpers

[敏感文件读取确认](sensitive-file-confirmation.mjs)是首个验收脚本。[RPC 验收环境](rpc-verification.mjs)负责启动、就绪检查、事件记录和清理；功能脚本负责夹具、模型替身回复和断言。直接用 hapi 或 `hc` 就能验证的功能，不需要另写脚本。地图落后于真实入口时，用 `/skill:maintain-verification-skill` 更新。
