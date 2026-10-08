# dsh-codebuddy

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 CodeBuddy 插件：提供 OAuth 登录、账号动态模型目录、流式请求以及推理等级选择。

本分支面向 **DSH 0.2.0 系列**，已验收的准确版本为 **0.2.0-rc.2**，SDK 依赖固定到该版本。正式 `0.2.0` 发布后需要复验；本分支不承诺兼容 `0.1.x`。插件从 `0.1.4` 起包含本次设置与接入改造。

## 功能

- “设置 → CodeBuddy”中登录、取消或退出账号，刷新目录，保存 DSH 默认模型及推理等级。
- 默认站点通过 DSH 配置持久化；默认模型统一使用宿主 `agentDefaultModel`。
- `/codebuddy-login [site]` 登录国内版、国际版或自定义 CodeBuddy 站点。
- 在 dsh 模型选择器中显示独立的 `CodeBuddy` 分类。
- 登录后动态加载当前账号可用的模型。
- 支持 `Off / Minimal / Low / Medium / High / Xhigh / Max` 推理等级。
- OAuth 凭据通过 dsh Credential Store 持久化，重启后自动恢复模型目录。
- 提供 `/codebuddy-status` 和 `/codebuddy-logout`。

## 前置要求

- DeepSeek Harness `0.1.6-alpha.2`
- Node.js `22.19+` 或 `24+`

## 从 GitHub 安装

将插件安装到实际运行 Web 应用的同一个 profile：

```sh
dsh plugin --profile web add github:Lbryany/dsh-codebuddy
dsh web
```

如果 Web 应用使用自定义 profile，请将 `web` 换成该 profile 名称，并使用 `dsh --profile <name>` 启动。

### DSH 0.2.0-rc.2 的 pnpm 安全策略

`@earendil-works/pi-ai` 的传递依赖包含两个安装脚本，但 CodeBuddy 的 OpenAI 兼容路径不需要运行它们。若安装时出现 `ERR_PNPM_IGNORED_BUILDS`，请在 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 中把 DSH 自动生成的占位值改为：

```yaml
allowBuilds:
  '@google/genai': false
  protobufjs: false
```

如果文件里已有 `allowBuilds`，请合并这两项而不是重复该键。首次失败的安装可能已经写入依赖但尚未激活 bundle；修改后先移除再重新安装：

```sh
dsh plugin --profile web remove @lbryany/dsh-codebuddy
dsh plugin --profile web add github:Lbryany/dsh-codebuddy
```

在 dsh 输入框执行：

```text
/codebuddy-login cn
```

站点参数：

- `cn` / `china`：`https://copilot.tencent.com`
- `global` / `intl`：`https://www.codebuddy.ai`；留空使用设置页保存的默认站点（初始为国际站）。
- 也可以传入完整的 `http(s)` 站点 URL

命令会直接显示授权 URL；请点击该 URL（或复制到本地浏览器）完成授权。这个流程不依赖服务器上的 Chrome，因此也适用于无头或远程环境。授权成功后，模型选择器会出现 `CodeBuddy` 分类、当前账号的模型列表和可选推理等级。

## 从源码构建安装

```sh
git clone https://github.com/Lbryany/dsh-codebuddy.git
cd dsh-codebuddy
npm ci
npm run check
npm pack --ignore-scripts
dsh plugin --profile web add ./lbryany-dsh-codebuddy-0.1.4.tgz
dsh web
```

## 更新与卸载

重新安装最新 GitHub 版本：

```sh
dsh plugin --profile web add github:Lbryany/dsh-codebuddy
```

卸载：

```sh
dsh plugin --profile web remove @lbryany/dsh-codebuddy
```

## 命令

- `/codebuddy-login [cn|global|site URL]`
- `/codebuddy-status`
- `/codebuddy-logout`

OAuth 凭据存储在 dsh 凭据引用 `CODEBUDDY_OAUTH` 中。插件不会把 access token 或 refresh token 写入日志。

## 设置页

打开“设置 → CodeBuddy”：

1. 在“账号与连接”选择中国站、国际站或自定义 URL，按需保存默认站点，然后登录并打开授权页面。
2. 页面显示授权等待、成功、失败或取消状态；“已保存登录凭据”不代表模型目录一定可用。
3. 在“模型与运行”刷新目录，选择模型和推理等级，保存为 DSH 默认模型。保存只影响后续采用默认模型的会话。

刷新失败时保留账号凭据和上次成功目录，缓存目录不能用于新的默认模型保存。非推理模型隐藏推理选项；七档推理强度是适配器映射，不表示已对每个模型验证所有档位。只读配置会明确显示不可保存。

退出登录会取消旧账号请求并移除凭据。命令与设置页共用账号管理服务，原有 `CODEBUDDY_OAUTH` 凭据格式不变。

## 开发

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`lib/` 会提交到仓库，以便 dsh 可以直接通过 GitHub 安装；CI 会验证提交的 bundle 与源码构建结果一致。

### 隔离宿主验收

以下命令只创建仓库下 `.tmp/` 的测试宿主与 profile，不修改全局 DSH。浏览器测试默认使用本机 Edge 的无界面模式，CodeBuddy 网络由本地模拟服务提供。

```sh
npm install --prefix .tmp/host-020 --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.0-rc.2 playwright@1.56.1
npm run check
npm pack --ignore-scripts --pack-destination .tmp
node scripts/verify-dsh.mjs --version 0.2.0-rc.2 --mode web --mock-provider
node scripts/verify-dsh.mjs --version 0.2.0-rc.2 --mode commands --mock-provider
```

脚本从发布安装包创建独立 profile；依赖脚本配置也只作用于该测试 profile。测试日志和页面截图保存在 `.tmp/verification-artifacts/`。详细范围与未验证项见 [验收记录](docs/verification-0.2.0.md)。

## License

[MIT](./LICENSE)
