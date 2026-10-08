# Implementation checkpoints

- 2026-10-08 Step 1: pinned DSH 0.2.0-rc.2, Cordis 4.0.4 and pi-ai 0.87.1; migrated tool-role results and guarded prepared calls across account changes. Typecheck/build, original 35 tests and 3 host contract tests pass. Clean dependency resolution required regenerating the lockfile outside the old dependency tree. No global DSH changes.
- 2026-10-08 Step 2: shared service now owns login/catalog state; terminal login outcomes survive task completion, catalog failures preserve credentials, account changes invalidate old work, and delayed refreshes cannot recreate a logged-out credential. Typecheck/build and 43 tests pass.

### Step 3 — 2026-10-08
- 接入 0.2.0 volatile Config/defaultSite 与可选 settings/connection 服务；命令默认站点共享持久配置。
- RPC 使用宿主 /api JSON envelope，字段白名单与错误脱敏；只读/未实际落盘不报告成功。
- npm run check：类型检查、46 项测试、构建通过。认证载体及真实持久化待第六步隔离宿主验证。
