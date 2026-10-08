# Implementation checkpoints

- 2026-10-08 Step 1: pinned DSH 0.2.0-rc.2, Cordis 4.0.4 and pi-ai 0.87.1; migrated tool-role results and guarded prepared calls across account changes. Typecheck/build, original 35 tests and 3 host contract tests pass. Clean dependency resolution required regenerating the lockfile outside the old dependency tree. No global DSH changes.
- 2026-10-08 Step 2: shared service now owns login/catalog state; terminal login outcomes survive task completion, catalog failures preserve credentials, account changes invalidate old work, and delayed refreshes cannot recreate a logged-out credential. Typecheck/build and 43 tests pass.

### Step 3 — 2026-10-08
- 接入 0.2.0 volatile Config/defaultSite 与可选 settings/connection 服务；命令默认站点共享持久配置。
- RPC 使用宿主 /api JSON envelope，字段白名单与错误脱敏；只读/未实际落盘不报告成功。
- npm run check：类型检查、46 项测试、构建通过。认证载体及真实持久化待第六步隔离宿主验证。

### Steps 4–5 — 2026-10-08
- 原生设置页含账号与连接、模型与运行；浏览器模块单独构建，仅通过 DSH Connection RPC 通信。
- 连接代变更/卸载使请求和轮询失效；登录取消/失败、缓存目录、只读和保存失败分别可见。
- 默认模型只写宿主 agentDefaultModel；校验目录、推理档位并读回核对。
- 额外补齐 0.2.0 首条 system 消息转换；50 项测试、类型检查及双入口构建通过。
- 原生界面与打包安装将在隔离 0.2.0-rc.2 宿主验证。

### Review corrections — 2026-10-08
- Standards：共享推理档位；Spec：修复凭据队列取消/写中取消回滚、统一模型刷新、防止授权前目录跨账号复用、生成URL时取消被串行锁阻塞。
- 复用登录调用者取消不再提前恢复账号请求；默认模型写入与账号变更串行协调。
- 原生 Button/Input、主题继承、zh/en locale；非推理模型隐藏推理下拉。
- 实际宿主发现 settings namespace 使用 entry.options.id，已修复并通过持久化验收。
- npm run check：55 项测试、类型检查与双入口构建通过。

### Step 6 — 2026-10-08
- npm pack 本地产物经官方 DSH 0.2.0-rc.2 plugin add 安装到隔离 profile。scripts/verify-dsh.mjs 提供 web/commands 两种可复现入口。
- Web：原生zh/en设置页、默认站点保存、模拟OAuth成功/取消、目录失败缓存、默认模型和max档保存、进程重启后配置/凭据恢复、退出、401/403认证来源校验通过。
- Commands：独立DSH_HOME、无Connection/Web服务，真实Commands/Agents/Llm运行登录/状态/退出和本地模拟流式completion通过。
- 截图已目视检查，生成日志位于.tmp/verification-artifacts。真实账号和Windows原生桌面客户端未实测；正式0.2.0需复验。
- 未更新用户全局DSH，未改用户原有profile；未推送或发布。详见docs/verification-0.2.0.md。
