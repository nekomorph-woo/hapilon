# macOS 上创建 Apple Notes「真标签」的非 UI 方案

日期：2026-10-04  
验证环境：macOS 27.0.1（Build 26A434）

## 结论先说

目前能避开逐笔键盘模拟的路径是 **Shortcuts 包装 Notes 的原生 App Intent**：先 `Create Tag`，再 `Add Tags to Notes`，最后用 `shortcuts run` 执行一个已经安装的快捷指令。它会修改 Notes 的原生对象，不是把 `#tag` 写进正文。

这条路仍有三个边界：

1. 快捷指令必须先由用户导入并批准；后台首次运行还要在 Shortcuts.app 前台运行一次并选 **Always Allow**。
2. Shell 只能运行“已安装的快捷指令”，不能直接调用 `Notes.AddTagsToNotesIntent`。
3. 直接改 `NoteStore.sqlite` 没有受支持的写入接口。公开代码只展示了读取、备份副本上的派生字段写入，或后来放弃的私有 Core Data 写入尝试。

因此：**允许一次人工安装和授权时，Shortcuts 是当前最小可行的非 UI 写入方案；要求从干净机器、SSH 或 loginwindow 完全无人工准备时，没有受支持的方案。**

## 1. “真标签”到底写了什么

### 1.1 Apple 对用户公开的行为

Apple 的 Notes 用户指南要求在正文中输入 `#` 后再输入一个词，标签会出现在侧边栏 Tags 区域，也可以用于标签搜索和 Smart Folder。Apple 还说明，把标签转换为文本会使它失去标签行为。

来源：[Apple Support — Use tags in Notes on Mac](https://support.apple.com/guide/notes/use-tags-apdc88ed7f1d/mac)（页面版本为 macOS 27，访问于 2026-10-04）。

这页没有公开存储格式，但已经能排除“正文里有 `#tag` 就算注册”的判断：正文文本和 Tags 区域是两个状态。

### 1.2 当前系统暴露的原生动作

本机 Notes 的 App Intents 元数据位于：

```text
/System/Applications/Notes.app/Contents/Resources/Metadata.appintents/extract.actionsdata
```

该文件是 JSON。`python3` 读取后得到下列与标签直接相关的动作：

| action identifier | Swift 类型 | 参数 | 系统描述 |
|---|---|---|---|
| `CreateTagLinkAction` | `Notes.CreateTagIntent` | 可选 `name: String` | Creates a tag that can be used in notes. |
| `AddTagsToNotesLinkAction` | `Notes.AddTagsToNotesIntent` | 必填 `notes: NoteEntity[]`、`tags: TagEntity[]` | Adds tags to notes. |
| `RemoveTagsFromNotesLinkAction` | `Notes.RemoveTagsFromNotesIntent` | 必填 `notes: NoteEntity[]`、`tags: TagEntity[]` | Removes tags from notes. |
| `DeleteTagsLinkAction` | `Notes.DeleteTagsIntent` | 必填 `entities: TagEntity[]` | Delete tags from Notes. |

同一份元数据还声明：

- `NoteEntity` 有 `tags: TagEntity[]` 属性；
- `TagEntity` 有必填 `name: String`；
- 标签查询为 `Notes.VisibleTagsQuery`；
- `AddTagsToNotesLinkAction` 和 `CreateTagLinkAction` 的 `openAppWhenRun` 为 `false`，说明动作本身不要求把 Notes 窗口带到前台。

这比 AppleScript 字典更接近真实能力，但它是随系统安装的运行时元数据，不是给第三方直接链接的公开 Notes API。

本机证据：

- macOS：`sw_vers` → `27.0.1 / 26A434`；
- 元数据版本：`Metadata.appintents/version.json` → `version: 3.0`、`toolsVersion: 27A200c`；
- `extract.actionsdata` SHA-256：`cc3a2b31da7ef9b878479865d93f475798ea9e1c5c14b9cf37f74b506a21fbfc`。

### 1.3 NoteStore 中的两层对象

Apple 没有公开 NoteStore schema。下面是当前第三方读取器对本地库的共同观察，可信度低于 Apple 文档，但足以解释为什么写正文无效：

- 全局标签定义是 `ICHashtag` 对象；
- 每次标签出现在某条笔记中，都有一个 `ICInlineAttachment` 对象；
- 该对象的 `ZTYPEUTI1` 是 `com.apple.notes.inlinetextattachment.hashtag`；
- `ZNOTE1` 指向笔记；
- `ZALTTEXT` 保存类似 `#tag` 的显示文本；
- 压缩的正文 protobuf/CRDT 还要通过属性运行（attribute run）引用这个 inline 对象的 `ZIDENTIFIER`。只插入一行数据库记录，正文没有引用时不会形成可见标签。

`threeplanetssoftware/apple_cloud_notes_parser` 的固定版本把这类对象建模为 `AppleNotesEmbeddedInlineHashtag`，并明确读取 `ZTYPEUTI1`、`ZALTTEXT`、`ZTOKENCONTENTIDENTIFIER`：

- [AppleNotesEmbeddedInlineHashtag.rb](https://github.com/threeplanetssoftware/apple_cloud_notes_parser/blob/4754a2b62686570cca46690d101079e80cf6ae66/lib/AppleNotesEmbeddedInlineHashtag.rb)；
- commit：`4754a2b62686570cca46690d101079e80cf6ae66`。

另一个当前实现 `sweetrb/apple-notes-mcp` 的只读查询同时查 `ICHashtag` 行、inline hashtag 使用记录和正文引用，代码把孤立对象排除在有效标签之外：

- [noteListings.ts](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/src/utils/noteListings.ts#L294-L369)；
- [TECHNICAL_NOTES.md](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/TECHNICAL_NOTES.md#L154-L183)；
- commit：`ae27e7bfdc7ea120732b01242c683e3d1f45703f`。

**判断：**“标签注册”至少包含全局 `ICHashtag` 和笔记正文引用的 inline object 两部分。真正安全的写入还要让 Notes 更新 Core Data、正文 CRDT、修改版本和 iCloud 同步状态；SQL 表面上看见的字段不是完整写入协议。

## 2. AppleScript 与 JXA

### 2.1 AppleScript 字典没有标签属性

本机 Notes scripting dictionary：

```text
/System/Applications/Notes.app/Contents/Resources/Notes.sdef
```

`note` 类只有 `name`、只读 `id`、只读 `container`、`body`、只读 `plaintext`、日期、锁定和共享状态等属性，没有 `tags` 属性，也没有 tag element 或添加标签命令。

本机文件 SHA-256：`2485c3e87dbfa0baf09fcfa6d2f6b2c16e4eccc1371db01a2ab8c3d35ef4e65d`。

所以：

```applescript
set body of someNote to "标题\n正文 #travel"
```

最多写入普通正文。它不会调用 Notes 编辑器的输入解析器，也不会自动生成 `ICHashtag`/inline tag 对象。

实现者的实测与此一致：

- `RhetTbull/macnotesapp` 的 README 说，现有标签可以读，但通过该 AppleScript/ScriptingBridge 接口添加 `#tag` 只会得到纯文本；
- [README.md](https://github.com/RhetTbull/macnotesapp/blob/a8f9e2759da52907478dfca4c2f554349eb5974d/README.md#L244-L251)；
- commit：`a8f9e2759da52907478dfca4c2f554349eb5974d`。

### 2.2 JXA 没有额外能力

Apple 的 JXA 文档把 JavaScript for Automation 定义为跨应用通信方式：[JavaScript for Automation Release Notes](https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/Articles/Introduction.html)。JXA 通过同一套 Apple Event terminology 访问 Notes，因此看到的仍是上面的 `Notes.sdef`，不会凭空获得 App Intents 的 `TagEntity` 或 `AddTagsToNotesIntent`。

JXA 可以做两件事：

- 用 `Application("Notes")` 读写 `body`，结果与 AppleScript 相同；
- 用 `Application("Shortcuts")` 的 `run` 命令，或执行 `shortcuts run`，触发一个已经安装的快捷指令。

第二种只是调用 Shortcuts 包装层，不是从 JXA 直接执行 Notes 的 `perform()`。JXA 也可以通过 System Events 发键盘事件，但那属于 UI 自动化，不在本调研的目标内。

## 3. Shortcuts 与 App Intents

### 3.1 App Intent 不能被 Shell/JXA 直接调用

Apple 的公开 App Intents 文档只定义“应用向系统表达动作”的接口：

- [App Intents](https://developer.apple.com/documentation/appintents)：让内容和动作被 Apple Intelligence、Siri、Spotlight、Shortcuts 等系统体验发现；
- [AppIntent](https://developer.apple.com/documentation/appintents/appintent)：应用定义动作并让它们对系统可用。

文档没有提供第三方进程直接取得另一应用的 `AppIntent` 实例、传入参数并调用 `perform()` 的公开 API。当前系统的可用调用边界由 Shortcuts 提供：把原生动作放进一个快捷指令，再运行这个快捷指令。

本机的 Shortcuts scripting dictionary 也只暴露“运行快捷指令”：

```xml
<command name="run" ...>
  <direct-parameter ... type="shortcut" .../>
  <parameter name="with input" ... type="any" .../>
</command>
```

它没有“运行 App Intent”命令。

本机文件：`/System/Applications/Shortcuts.app/Contents/Resources/Shortcuts.sdef`  ；SHA-256：`19f923a74eb00f25c9a1dc202a7e5164161a9d2289cf5a3dca133875db3665c3`。

### 3.2 命令行能做什么

Apple 的 macOS Shortcuts 用户指南明确给出：

```sh
shortcuts run "Combine Images"
shortcuts run "Combine Images" -i input.json -o output.txt
shortcuts list
shortcuts view "Shortcut Name"
shortcuts sign --mode anyone --input in.shortcut --output out.shortcut
```

来源：[Apple Support — Run shortcuts from the command line](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac)。该页还明确说，命令行运行的是一个命名的快捷指令；`shortcuts list` 用于列出可运行的快捷指令。

本机复核：

```text
$ shortcuts help run
USAGE: shortcuts run <shortcut-name-or-identifier> [--input-path ...]

$ shortcuts run com.apple.Notes.AddTagsToNotesLinkAction
Error: 未能完成该操作。找不到快捷指令
exit=1
```

当前账户没有已安装的标签快捷指令。把 App Intent identifier 当成快捷指令 identifier 运行会得到“找不到快捷指令”，不是执行 Notes 动作。

Apple 的分享文档还要求接收者点击 **Get Shortcut** 才会把共享快捷指令加入集合：[Share shortcuts on Mac](https://support.apple.com/guide/shortcuts-mac/share-shortcuts-apdf01f8c054/mac)。因此“导入”不是可由 `shortcuts run` 静默完成的运行时步骤。

### 3.3 已实现的原生标签桥

`sweetrb/apple-notes-mcp` 提供了可审计的快捷指令构建脚本：

1. `Find Notes` 按标题和正文中的独特短语找目标；
2. 检查结果数必须是 1；
3. 对每个标签执行 `com.apple.Notes.CreateTagLinkAction`；
4. 把生成的 `TagEntity` 交给 `com.apple.Notes.AddTagsToNotesLinkAction`；
5. 返回成功文本，服务端再用精确 Core Data ID 读回标签、正文、链接和其它原生对象。

源码：[build-native-tags-shortcut.py](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/scripts/build-native-tags-shortcut.py#L39-L94)。脚本的动作表没有 System Events、键盘、鼠标、AppleScript 或网络动作；第三方测试还断言 Notes 原生动作的 `ShowWhenRun` 为 `False`：[test-native-operations-shortcut.py](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/scripts/test-native-operations-shortcut.py#L28-L58)。

运行时调用：

```sh
shortcuts run "Apple Notes MCP - Native Tags" --input-path request.json
```

源码会先用 `shortcuts list --show-identifiers` 找到唯一快捷指令，再传入临时 JSON 文件：[nativeTags.ts](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/src/services/nativeTags.ts#L111-L164)。这是真正的“非逐笔 UI”路径，但它不是完全无人值守路径：

- 导入签名文件仍要用户确认；
- 首次运行 Notes/Shortcuts 权限仍要前台处理；
- 运行需要已登录的图形会话；
- 快捷指令内部按标题+正文短语找 NoteEntity，不是直接接收任意 Core Data ID；
- 目标笔记可能在执行前发生同步变化，所以服务端做 revision、唯一性和读回校验。

该项目的文档明确记录：后台首次运行遇到未回答的 consent prompt 时会一直等到超时；安装后要在 Shortcuts.app 前台运行每个 bridge，并选择 **Always Allow**：[shortcuts/README.md](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/shortcuts/README.md#L14-L28)。

### 3.4 版本判断

Apple 没有在公开的 Notes 文档中给出这些标签动作的 macOS 版本表。当前本机 macOS 27 已确认存在。一个二进制差异项目在 macOS 15.3.2 与 15.4 的 `LinkMetadata` 差异中列出 `AddTagsToNotesLinkAction`、`CreateTagLinkAction`、`DeleteTagsLinkAction` 等符号：

- [blacktop/ipsw-diffs — macOS 15.3.2 vs 15.4](https://github.com/blacktop/ipsw-diffs/blob/f20983f28231f3fa9d1c370befebf55be79d0e37/macOS/15_3_2_24D81__vs_15_4_24E248/DYLIBS/LinkMetadata.md#L984-L1012)；
- 这是逆向差异，不是 Apple API 承诺。

实现应在运行时检查动作/快捷指令是否可用，不能只根据 `sw_vers` 硬编码版本门槛。

## 4. 直接改 NoteStore.sqlite：找到的案例与风险

### 4.1 数据库位置和读取边界

常见路径：

```text
~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite-shm
~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite-wal
```

`-wal` 在 Notes.app 运行时可能含有尚未合并到主文件的变化。`apple-notes-mcp` 的技术记录要求复制三个文件后只读打开；其生产查询统一使用 `sqlite3 -readonly`，没有生产写入分支：[TECHNICAL_NOTES.md](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/TECHNICAL_NOTES.md#L21-L43) 和 [noteStoreSql.ts](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/src/utils/noteStoreSql.ts#L1-L20)。

本机尝试只读探测也被 TCC 拒绝：

```text
sqlite3 -readonly "$HOME/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite" 'SELECT 1;'
Error: unable to open database ... authorization denied
```

所以本次没有读取本机真实 tag 行，也没有对本机数据库做任何写入。

### 4.2 找到的“直接写数据库”并不是标签写入

`threeplanetssoftware/apple_cloud_notes_parser` 有 `ALTER TABLE` 和 `UPDATE`，但用途是把解压出的明文和解压数据加到**解析副本**，不是创建 `ICHashtag` 或修改笔记正文 CRDT：

- [AppleNoteStore.rb](https://github.com/threeplanetssoftware/apple_cloud_notes_parser/blob/4754a2b62686570cca46690d101079e80cf6ae66/lib/AppleNoteStore.rb)；
- README 明确它处理的是复制出来的 `NoteStore.sqlite`，并将派生字段写到输出库：[README.md](https://github.com/threeplanetssoftware/apple_cloud_notes_parser/blob/4754a2b62686570cca46690d101079e80cf6ae66/README.md#L20-L35)。

其它代表性工具也没有找到原生标签 SQL writer：

- `sirmews/apple-notes-mcp` 用 SQLite `SELECT` 做搜索/读取，README 虽写“read and write”，源码没有 `INSERT`/`UPDATE` 标签路径：[notes_database.py](https://github.com/sirmews/apple-notes-mcp/blob/d4cfb110b8141bf16d7db08b8573e54192cf4873/src/apple_notes_mcp/notes_database.py)；
- Raycast 官方 Apple Notes 扩展用 SQL 读 `com.apple.notes.inlinetextattachment.hashtag`，创建/更新仍调用 AppleScript 的 `body`：[getNotes.ts](https://github.com/raycast/extensions/blob/697b0f442e197a2969a43da7736fdf0494fadc72/extensions/apple-notes/src/api/getNotes.ts)、[applescript.ts](https://github.com/raycast/extensions/blob/697b0f442e197a2969a43da7736fdf0494fadc72/extensions/apple-notes/src/api/applescript.ts)；
- Go 工具 `harperreed/notes-mcp` 的 `--tags` 参数只放进返回的 `Note` 结构，源码注释明确说不会传给 AppleScript：[services/notes.go](https://github.com/harperreed/notes-mcp/blob/fdbebaf3a2b1702f49b4daf3614214a92a05c5ff/services/notes.go#L154-L192)。

在本次查到的公开项目中，没有找到“直接插入 `ICHashtag`、inline attachment、protobuf/CRDT 引用并证明 iCloud 正常同步”的可复现实现。这个结论是公开代码检索结果，不是 Apple 对私有 schema 的否定。

### 4.3 私有 Core Data 写入也没有形成可用替代品

`sweetrb/apple-notes-mcp` 的私有 `NotesShared` helper 曾尝试通过 `ICTTMergeableString`、`saveNoteData` 和版本校验写正文，但合并前删掉了写入动作。维护者记录了三个未解决问题：Notes.app 同时写同一个 store 时的并发行为、私有 CRDT replica identity，以及 iCloud 上传滞后。一次实测中本地版本已经增加，13 分钟内仍未上传，直到 Notes.app 自己再次保存该笔记才触发上传：

- [TECHNICAL_NOTES.md — Why writes were deferred](https://github.com/sweetrb/apple-notes-mcp/blob/ae27e7bfdc7ea120732b01242c683e3d1f45703f/TECHNICAL_NOTES.md#L932-L956)；
- 对应合并请求：[PR #204](https://github.com/sweetrb/apple-notes-mcp/pull/204)。

这不是标签写入的正面案例，却是目前能找到的最接近“绕过 Notes UI 直接写内部模型”的公开失败边界。

**工程判断：**不要对正在使用的 live store 发送 `INSERT`/`UPDATE`，也不要只改 `ZALTTEXT`。这会绕过 Core Data/CloudKit 的变更记录和正文引用，最好的结果是本机暂时显示，最坏的结果是对象孤立、同步冲突或库损坏。即使先退出 Notes，Apple 也没有给第三方提供兼容版本迁移和同步身份的写入契约。

## 5. 第三方工具路径对照

| 项目 | 实际路径 | 是否满足“非 UI 真标签” |
|---|---|---|
| [sweetrb/apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp/tree/ae27e7bfdc7ea120732b01242c683e3d1f45703f) | Shortcuts 原生 `CreateTag` + `AddTagsToNotes`；CLI 运行已安装 bridge；只读数据库做校验 | **满足运行阶段**；安装和首次授权仍需人工 UI |
| [kenshinice-ai/apple-notes-tagger](https://github.com/kenshinice-ai/apple-notes-tagger/tree/d98b0accaa77bc92e9aafb8c217e4984fb461262) | System Events/AX 把光标放到 `#tag` 后敲空格，再退格；新增标签走剪贴板+空格 | **不满足**；这是 UI 自动化，但实测覆盖中文、日文、韩文等 |
| [RhetTbull/macnotesapp](https://github.com/RhetTbull/macnotesapp/tree/a8f9e2759da52907478dfca4c2f554349eb5974d) | ScriptingBridge/AppleScript 读写正文；数据库解析器只读 | **不满足**；README 明说写 `#tag` 仍是纯文本 |
| [raycast/extensions Apple Notes](https://github.com/raycast/extensions/tree/697b0f442e197a2969a43da7736fdf0494fadc72/extensions/apple-notes) | SQLite 读取原生 tag；AppleScript `body` 创建/更新 | **不满足**；有读无写 |
| [harperreed/notes-mcp](https://github.com/harperreed/notes-mcp/tree/fdbebaf3a2b1702f49b4daf3614214a92a05c5ff) | AppleScript 创建正文；`--tags` 仅保存在应用返回结构 | **不满足** |
| [threeplanetssoftware/apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser/tree/4754a2b62686570cca46690d101079e80cf6ae66) | 解析 inline hashtag 和 protobuf；可在复制库加派生列 | **不满足**；取证/导出，不是 live tag writer |

`kenshinice` 的实测很有用，但不能拿来回答非 UI 方案：它自己写明从不读写 `NoteStore.sqlite`，必须让 Notes 保持前台并授予 Accessibility。它证明了 Notes 编辑器解析器能把已有 `#tag` 转为 inline object，不证明 AppleScript/JXA 可以调用这个解析器。

来源：[README.md](https://github.com/kenshinice-ai/apple-notes-tagger/blob/d98b0accaa77bc92e9aafb8c217e4984fb461262/README.md)、[ARCHITECTURE.md](https://github.com/kenshinice-ai/apple-notes-tagger/blob/d98b0accaa77bc92e9aafb8c217e4984fb461262/docs/ARCHITECTURE.md)。

## 6. 推荐落地方式

### 允许一次人工准备

选 Shortcuts bridge：

1. 生成或导入含 `CreateTag`、`AddTagsToNotes` 的快捷指令；
2. 用户确认导入，并在 Shortcuts.app 前台运行一次，批准 Notes/Automation；
3. 脚本写入临时 JSON，执行 `shortcuts run <name-or-uuid> --input-path request.json`；
4. 写入前用标题+正文独特短语确认只有一个候选；
5. 写入后读回原生 tag object、正文和链接，失败就停止，不自动重试。

`sweetrb/apple-notes-mcp` 已经把这套护栏实现出来。若只需要一个小脚本，复用它的快捷指令结构比自己碰数据库更短。

### 要求完全 headless

Shortcuts 的导入、首次授权和图形会话约束会使它不满足“从 loginwindow/SSH 启动即可”。AppleScript/JXA 没有 tag API，数据库写入又没有同步契约；当前没有可接受的公开方案。

### 只需要可搜索的文本

直接写 `#tag` 可以满足正文搜索，但不要把它称为真标签：它不会自动进入 Notes 的 Tags 区域，也不会驱动 Smart Folder。API 的返回值应把 `textual hashtag` 和 `native tag` 分开。

## 7. 本次验证没有做的事

- 没有导入第三方快捷指令，也没有改变本机 Notes 数据；当前 `shortcuts list` 没有标签 bridge。
- 没有读取本机 `NoteStore.sqlite`：`sqlite3 -readonly` 被 Full Disk Access 拒绝。
- 没有声称 Shortcuts bridge 已在本机 macOS 27.0.1 成功写入；该结论来自本机 App Intents 元数据、命令行行为和第三方固定 commit 的源码/文档，端到端运行证据仍需在有测试笔记的账户上另行做。

## 来源与证据等级

- **[官方]** Apple Support Notes 标签页、Apple Developer App Intents/JXA 文档、Apple Support Shortcuts 命令行/分享页。
- **[本机系统]** macOS 27.0.1 的 `Notes.sdef`、`Shortcuts.sdef`、`Metadata.appintents`，含路径、版本和 SHA-256。
- **[实现者代码]** 固定 commit 的 Shortcuts bridge、数据库读取器和 AppleScript 工具；能证明这些项目实际选择的路径，不能替代 Apple 对私有格式的承诺。
- **[逆向/实测]** `blacktop/ipsw-diffs` 和第三方在特定 macOS 版本上的现场记录；只用于版本线索和风险边界。
