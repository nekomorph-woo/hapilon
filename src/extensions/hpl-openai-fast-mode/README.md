# hpl-openai-fast-mode

`/fast` 打开设置菜单，查看全局开关、当前模型和白名单，并管理模型、`service_tier`。快捷命令 `/fast on`、`/fast off` 切换全局开关，`/fast tier <fast|priority|standard|flex>` 设置请求值。设置写入 `$HAPILON_HOME/agent/settings.json` 的 `hplFastMode`；`HAPILON_HOME` 是 hapi 的配置目录变量，同一路径下的会话和 pane 都会读取设置。

Fast 模式默认关闭，模型白名单默认空；菜单可按 `provider/id` 精确添加当前或其他模型。旧设置中的通配符条目会保留，可从「移除白名单条目」菜单删除。Fast 模式只作用于 `openai`、`openai-codex` 服务提供方；扩展在发送请求前读取设置并改写请求体，不改动模型的 thinking 档位。

`hplFastMode.serviceTier` 保留用户选择的值。对 `openai-codex`，请求值 `fast` 映射为 `priority`，`standard`、`flex`、`priority` 原样发送；`openai` 服务提供方的设置值始终原样发送。ChatGPT 订阅后端可能静默降级到默认档，因此响应回显 `default` 不能证明请求未携带 `priority`。

风险提示：`openai-codex`（订阅后端）的 `standard` 和 `flex` 尚未验证；目前只确认后端接受 `priority`（设置为 `fast` 时扩展会映射为 `priority` 发出）。在 Codex 模型上选择这两档后若遇到 `Unsupported service_tier`，属于预期限制，请使用默认 `fast`。

pi 0.87.1 对响应回显的 `service_tier: "fast"` 按 1× 显示；这只影响 pi 的成本显示，OpenAI 仍按 Fast mode 实际价格计费。
