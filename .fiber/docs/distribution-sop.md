# hapilon 分发 SOP（安装 · 发版 · 升级）

> 适用于：在其他电脑上安装 hapilon、在开发机上发布新版本、在任意电脑上升级。
> 版本语义：0.x 阶段——patch（`0.x.y`）= 修复与小调整；minor（`0.x`）= 一批新能力收敛；1.0 之前不定稳定承诺。

## 全景

```
开发机                                    其他电脑
──────                                   ─────────
改 version → build+test 绿
→ tag v<X.Y.Z> → push tag
→ npm pack 出 tarball
→ gh release create 附 tarball    ──►    npm install -g <tarball-url>
（Release 页面 = 分发柜台）                hapilon setup（首次）
                                          npm install -g <新tarball-url>（升级）
```

分发走 **tarball**，不走 `npm install -g github:...`。原因（实测）：
1. npm 对 git 依赖的 `prepare` 是强沙箱——无 devDeps、无 npx 重入、无嵌套 install（code 127/254/235），目标机无法构建 dist
2. git 依赖实时解析在 pi-mcp-adapter → express 5 嵌套依赖树上触发 npm reify bug（negotiator/content-type ENOENT）

tarball 是构建完成的完整快照，两条坑都绕开。

---

## SOP-1 发版（开发机，每次发布跑一遍）

前置：源码改动已全部合入 main；`dist/` 与 `src/` 一致（改过源码必须先 `npm run build` 并提交 dist——dist 已入库）。

### 步骤

```bash
# 1. 升版本号（package.json 的 version 字段）
#    0.x 阶段：新能力批次 → 升 minor（0.2.0 → 0.3.0）；仅修复 → 升 patch（0.2.0 → 0.2.1）
#    tarball 文件名由 version 决定，后续命令必须同步替换

# 2. 构建并全量测试
npm run build
npm test                      # 必须全绿再往下走

# 3. 提交版本变更（dist 一并提交）
git add package.json package-lock.json dist/
git commit -m "chore(release): v<X.Y.Z>——<一句话内容>"

# 4. 打附注 tag 并推送（HTTPS 通就用 origin，LibreSSL 问题走 ssh）
git tag -a v<X.Y.Z> -m "v<X.Y.Z>
<本批能力/修复清单，带 issue 号>
<已知限制（如有）>"
git push origin v<X.Y.Z>
#   ↑ HTTPS 推送失败（SSL_ERROR_SYSCALL）时改用：
git push git@github.com:nekomorph-woo/hapilon.git v<X.Y.Z>

# 5. 打 tarball
npm pack --pack-destination /tmp
#   → /tmp/hapilon-<版本>.tgz

# 6. 建 Release 并附 tarball
gh release create v<X.Y.Z> /tmp/hapilon-<版本>.tgz \
  --title "v<X.Y.Z>" --generate-notes

# 7.（可选）发布前沙箱验证——不动开发机环境
#    见 SOP-3

# 8. 清理
rm /tmp/hapilon-<版本>.tgz
```

### 完成标准

- `git tag -l` 有 `v<X.Y.Z>`；GitHub Releases 页面出现对应版本且附件含 tgz
- tarball 文件名的版本号与 package.json 一致

### 异常处理

| 症状 | 处置 |
|---|---|
| `npm pack` 名字与预期不符 | 检查 package.json 的 version 是否真的改了 |
| HTTPS push 报 `SSL_ERROR_SYSCALL` | 代理与 LibreSSL 的兼容问题；curl/gh 正常说明网络没断，改用 `git push git@github.com:...` |
| 测试不绿 | 停止发版，先修；发版不得跳过测试 |

---

## SOP-2 安装（新电脑，一次性）

前置：Node.js ≥ 22.19（`node --version` 检查；版本不符先装/升 Node）。

```bash
# 1. 安装（URL 来自 Release 页面对应版本的附件链接）
npm install -g https://github.com/nekomorph-woo/hapilon/releases/download/v<X.Y.Z>/hapilon-<版本>.tgz

# 2. 初始化
hapilon setup     # 交互式配 provider（API key、模型）

# 3. 体检
hapilon doctor    # 逐项 ✅ 即就绪

# 4. 开用
hapilon           # 或 hapi —— 同一程序的双入口
```

### 完成标准

- `hapilon --version` 输出版本号
- `hapilon doctor` 全部 ✅
- `~/.hapilon/` 目录已创建（本机配置落位）

### 说明

- 用户数据（密钥、sessions、扩展配置）全部在本机 `~/.hapilon/`，与安装目录分离——多台机器各自独立，**不需要也不应该在机器间同步这个目录**
- `hapilon` 与 `hapi` 是同一 `dist/cli.js` 的两个 bin 别名，npm 全局安装时自动创建，行为完全一致

---

## SOP-3 升级（任意已安装的电脑）

```bash
# 方式一：写死版本 URL（最直接）
npm install -g https://github.com/nekomorph-woo/hapilon/releases/download/v<新版本>/hapilon-<新版本号>.tgz

# 方式二：自动取最新 Release 的附件（需要本机装了 gh）
npm install -g "https://github.com/nekomorph-woo/hapilon/releases/latest/download/$( \
  gh release view --repo nekomorph-woo/hapilon --json assets --jq '.assets[0].name' )"
```

### 完成标准

- `hapilon --version` 输出新版本号
- `~/.hapilon/` 配置原样保留（升级只换程序本体）

### 说明

- 覆盖安装，无需先卸载
- 升级不触碰 `~/.hapilon/`——密钥、历史 session、扩展设置全部保留

---

## SOP-4 沙箱验证（开发机，可选——发布前自测安装链路）

目的：在不动开发机 npm 全局环境的前提下，完整验证一次「tarball → 安装 → 运行」。

```bash
ISOL=~/.hapilon-install-sandbox
rm -rf $ISOL && mkdir -p $ISOL/prefix $ISOL/cache

# 重定向 npm 的全局目录与缓存到沙箱
env NPM_CONFIG_PREFIX=$ISOL/prefix NPM_CONFIG_CACHE=$ISOL/cache \
  npm install -g /tmp/hapilon-<版本>.tgz

# 验证（node 用开发机的即可，包体在沙箱里）
ls $ISOL/prefix/bin/                                     # 应见 hapilon 与 hapi
node $ISOL/prefix/lib/node_modules/hapilon/dist/cli.js --version
node $ISOL/prefix/lib/node_modules/hapilon/dist/cli.js doctor

# 清理
rm -rf $ISOL
```

### 完成标准

- 双 bin（hapilon/hapi）都在沙箱 prefix/bin 下
- `--version` 与 `doctor` 正常输出

### 注意

- 跑 `doctor` 会写沙箱外的 `~/.hapilon/` 时，用 `env HOME=$ISOL/fakehome` 包一层再跑（该命令会创建用户数据目录）
- 验证完必须清理沙箱目录（200MB 级缓存残留）

---

## 速查

| 场景 | 一句话 |
|---|---|
| 发版 | version↑ → build+test 绿 → tag → pack → release create |
| 新机安装 | `npm i -g <tarball-url>` → `hapilon setup` → `doctor` |
| 升级 | `npm i -g <新tarball-url>`（覆盖装，配置不动） |
| 发版前自测 | SOP-4 沙箱重定向 prefix+cache |
| HTTPS push 挂 | `git push git@github.com:nekomorph-woo/hapilon.git ...` |

## 关联

- README.md「发版打包流程」章节（同内容的用户视角版本）
- tag `v0.2.0` 是首个里程碑版本（MCP 桥 / hpl-econ / 代码风格三层 / 分发链路）
- git 依赖 prepare 不可行的完整实测记录：commit `84d14cf` / `32d43dc` / `c92d711` 的失败链
