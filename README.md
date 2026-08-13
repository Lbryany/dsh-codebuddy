# dsh-codebuddy

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 CodeBuddy 插件：提供 OAuth 登录、账号动态模型目录、流式请求以及推理等级选择。

## 功能

- `/codebuddy-login [site]` 登录国内版、国际版或自定义 CodeBuddy 站点。
- 在 dsh 模型选择器中显示独立的 `CodeBuddy` 分类。
- 登录后动态加载当前账号可用的模型。
- 支持 `Off / Minimal / Low / Medium / High / Xhigh / Max` 推理等级。
- OAuth 凭据通过 dsh Credential Store 持久化，重启后自动恢复模型目录。
- 提供 `/codebuddy-status` 和 `/codebuddy-logout`。

## 前置要求

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `22.19+` 或 `24+`

## 从 GitHub 安装

将插件安装到实际运行 Web 应用的同一个 profile：

```sh
dsh plugin --profile web add github:Lbryany/dsh-codebuddy
dsh web
```

如果 Web 应用使用自定义 profile，请将 `web` 换成该 profile 名称，并使用 `dsh --profile <name>` 启动。

在 dsh 输入框执行：

```text
/codebuddy-login cn
```

站点参数：

- `cn` / `china`：`https://copilot.tencent.com`
- `global` / `intl` 或留空：`https://www.codebuddy.ai`
- 也可以传入完整的 `http(s)` 站点 URL

浏览器授权成功后，模型选择器会出现 `CodeBuddy` 分类、当前账号的模型列表和可选推理等级。

## 从源码构建安装

```sh
git clone https://github.com/Lbryany/dsh-codebuddy.git
cd dsh-codebuddy
npm ci
npm run check
npm pack --ignore-scripts
dsh plugin --profile web add ./lbryany-dsh-codebuddy-0.1.1.tgz
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

## 开发

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`lib/` 会提交到仓库，以便 dsh 可以直接通过 GitHub 安装；CI 会验证提交的 bundle 与源码构建结果一致。

## License

[MIT](./LICENSE)
