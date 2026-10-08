window.__ModuleLoader__.load({
	id: "@lbryany/dsh-codebuddy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client-state.ts
		/** One mounted settings page owns requests and polling; a connection change discards all old replies. */
		function createClientState(transport) {
			let state = { busy: false };
			let lifetime = new AbortController();
			let version = 0;
			let disposed = false;
			let timer;
			const listeners = /* @__PURE__ */ new Set();
			const publish = (next) => {
				state = next;
				for (const fn of listeners) fn();
			};
			const call = async (endpoint, payload, signal) => {
				const response = await transport.call("/api", `codebuddy/${endpoint}`, payload, signal);
				if (!response.ok) throw new Error(response.error.message);
				return response.value;
			};
			const schedule = () => {
				clearTimeout(timer);
				const status = state.status;
				if (!disposed && (["starting", "waiting_browser"].includes(status?.login.phase ?? "") || status?.catalog.status === "refreshing")) timer = setTimeout(() => {
					load();
				}, 1500);
			};
			async function load() {
				if (disposed || state.busy) return;
				const revision = version;
				const signal = lifetime.signal;
				try {
					const [status, preferences, defaultModel] = await Promise.all([
						call("status", {}, signal),
						call("preferences/status", {}, signal),
						call("default-model/status", {}, signal)
					]);
					if (disposed || revision !== version || signal.aborted) return;
					publish({
						status,
						preferences,
						defaultModel,
						busy: false
					});
					schedule();
				} catch (error) {
					if (disposed || revision !== version || signal.aborted) return;
					publish({
						...state,
						error: error instanceof Error ? error.message : "无法读取 CodeBuddy 状态。"
					});
					schedule();
				}
			}
			return {
				getSnapshot: () => state,
				subscribe(fn) {
					listeners.add(fn);
					return () => {
						listeners.delete(fn);
					};
				},
				load,
				async action(endpoint, payload = {}) {
					if (disposed || state.busy) return;
					clearTimeout(timer);
					const revision = ++version;
					const signal = lifetime.signal;
					publish({
						...state,
						busy: true,
						error: void 0
					});
					let failure;
					try {
						await call(endpoint, payload, signal);
					} catch (error) {
						failure = error instanceof Error ? error.message : "CodeBuddy 操作失败。";
					}
					if (disposed || revision !== version || signal.aborted) return;
					publish({
						...state,
						busy: false
					});
					await load();
					if (failure && !disposed && revision === version) publish({
						...state,
						error: failure
					});
				},
				reset(connected = true) {
					lifetime.abort();
					lifetime = new AbortController();
					version++;
					clearTimeout(timer);
					publish({
						busy: false,
						error: connected ? void 0 : "DSH 连接已断开，正在等待重连。"
					});
					if (connected) load();
				},
				dispose() {
					disposed = true;
					version++;
					lifetime.abort();
					clearTimeout(timer);
					listeners.clear();
				}
			};
		}
		//#endregion
		//#region src/contract.ts
		const DEFAULT_SITE = "https://www.codebuddy.ai";
		const REASONING_LEVELS = [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		];
		//#endregion
		//#region src/client.tsx
		const inject = ["slots", "connection"];
		const styles = `.codebuddy-settings{display:grid;gap:18px;max-width:760px;color:inherit;padding:8px 4px}
.codebuddy-settings h2,.codebuddy-settings h3,.codebuddy-settings p{margin:0}
.codebuddy-settings .cb-card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;padding:18px;display:grid;gap:12px}
.codebuddy-settings .cb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.codebuddy-settings button,.codebuddy-settings select,.codebuddy-settings input{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:7px;padding:8px 12px}
.codebuddy-settings select option{color:CanvasText;background:Canvas}
.codebuddy-settings button{cursor:pointer}.codebuddy-settings button:disabled{opacity:.45;cursor:default}
.codebuddy-settings button[aria-pressed=true]{background:color-mix(in srgb,currentColor 12%,transparent)}
.codebuddy-settings input{min-width:240px;flex:1}.codebuddy-settings .cb-muted{opacity:.7;font-size:13px}
.codebuddy-settings [role=alert]{border-left:3px solid #d58b36;padding-left:12px}
.codebuddy-settings a{color:inherit;text-decoration:underline;overflow-wrap:anywhere}
.codebuddy-settings :focus-visible{outline:2px solid currentColor;outline-offset:3px}`;
		function CodeBuddySection({ connection }) {
			const [controller] = (0, react.useState)(() => createClientState(connection.rpc));
			const state = (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot);
			const [tab, setTab] = (0, react.useState)("account");
			(0, react.useEffect)(() => {
				controller.load();
				const unsubscribe = connection.generation.subscribe(() => controller.reset(Boolean(connection.generation.getSnapshot())));
				return () => {
					unsubscribe();
					controller.dispose();
				};
			}, [connection, controller]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "codebuddy-settings",
				"aria-label": "CodeBuddy 设置",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "CodeBuddy" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cb-muted",
						children: "连接账号，并为 DSH 设置默认模型。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("nav", {
						className: "cb-row",
						"aria-label": "CodeBuddy 设置分页",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							"aria-pressed": tab === "account",
							onClick: () => setTab("account"),
							children: "账号与连接"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							"aria-pressed": tab === "models",
							onClick: () => setTab("models"),
							children: "模型与运行"
						})]
					}),
					state.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: state.error
					}),
					!state.status ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						role: "status",
						children: ["正在读取状态… ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							onClick: () => void controller.load(),
							children: "重试"
						})]
					}) : tab === "account" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountPanel, { controller }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelsPanel, { controller })
				]
			});
		}
		function AccountPanel({ controller }) {
			const { status, preferences, busy } = (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot);
			const [site, setSite] = (0, react.useState)(preferences?.defaultSite ?? "https://www.codebuddy.ai");
			const [copied, setCopied] = (0, react.useState)(false);
			const [copyError, setCopyError] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (preferences) setSite(preferences.defaultSite);
			}, [preferences?.defaultSite]);
			if (!status) return null;
			const pending = ["starting", "waiting_browser"].includes(status.login.phase);
			const known = [DEFAULT_SITE, "https://copilot.tencent.com"];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cb-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "连接站点" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["站点 ", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						value: known.includes(site) ? site : "custom",
						disabled: busy || pending,
						onChange: (event) => setSite(event.target.value === "custom" ? "" : event.target.value),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: DEFAULT_SITE,
								children: "国际站"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "https://copilot.tencent.com",
								children: "中国站"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "custom",
								children: "自定义站点"
							})
						]
					})] }),
					!known.includes(site) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["站点 URL ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						"aria-label": "站点 URL",
						value: site,
						placeholder: "https://your-site.example",
						disabled: busy || pending,
						onChange: (event) => setSite(event.target.value)
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cb-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							disabled: busy || !preferences?.writable || !site,
							onClick: () => void controller.action("preferences/update", { defaultSite: site }),
							children: "保存默认站点"
						}), !preferences?.writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cb-muted",
							children: "当前 DSH 配置只读"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cb-muted",
						children: "默认站点用于下次登录；保存不会切换当前账号。"
					})
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cb-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "账号状态" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: status.account.hasCredential ? "已保存登录凭据" : "尚未登录" }),
					status.account.site && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cb-muted",
						children: ["当前账号站点：", status.account.site]
					}),
					status.account.expiresAt && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cb-muted",
						children: [
							"访问凭据到期时间：",
							new Date(status.account.expiresAt).toLocaleString(),
							"（使用时自动刷新）"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "status",
						children: {
							idle: "",
							starting: "正在生成授权链接…",
							waiting_browser: "等待浏览器授权",
							authenticated: "登录成功",
							failed: "登录失败，请重试。",
							cancelled: "登录已取消"
						}[status.login.phase]
					}),
					status.login.warning && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: "登录凭据已保存，但模型刷新失败。请到“模型与运行”重试。"
					}),
					pending && status.login.authorizationUrl && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cb-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: status.login.authorizationUrl,
								target: "_blank",
								rel: "noopener noreferrer",
								children: "打开授权页面"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => {
									navigator.clipboard.writeText(status.login.authorizationUrl).then(() => {
										setCopied(true);
										setCopyError(false);
									}, () => setCopyError(true));
								},
								children: copied ? "已复制" : "复制授权链接"
							}),
							copyError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								role: "alert",
								children: "复制失败，请使用“打开授权页面”。"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cb-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								disabled: busy || pending || !site,
								onClick: () => void controller.action("login/start", { site }),
								children: status.account.hasCredential ? "重新登录" : "登录 CodeBuddy"
							}),
							pending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								disabled: busy,
								onClick: () => void controller.action("login/cancel", { loginId: status.login.loginId }),
								children: "取消登录"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								disabled: busy || !status.account.hasCredential && !pending,
								onClick: () => void controller.action("logout"),
								children: "退出登录"
							})
						]
					})
				]
			})] });
		}
		function ModelsPanel({ controller }) {
			const state = (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot);
			const catalog = state.status.catalog;
			const saved = state.defaultModel;
			const [selected, setSelected] = (0, react.useState)(saved?.provider === "codebuddy" ? saved.model ?? "" : "");
			const [effort, setEffort] = (0, react.useState)(saved?.provider === "codebuddy" ? saved.reasoningEffort ?? "high" : "high");
			(0, react.useEffect)(() => {
				setSelected(saved?.provider === "codebuddy" ? saved.model ?? "" : "");
				setEffort(saved?.provider === "codebuddy" ? saved.reasoningEffort ?? "high" : "high");
			}, [
				saved?.provider,
				saved?.model,
				saved?.reasoningEffort
			]);
			const model = catalog.models.find((model) => model.id === selected);
			const canSave = state.status.account.hasCredential && catalog.status === "ready" && !catalog.cached && saved?.available && model;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cb-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "模型目录" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						disabled: state.busy || !state.status?.account.hasCredential,
						onClick: () => void controller.action("models/refresh"),
						children: "刷新模型"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
						catalog.models.length,
						" 个模型 · ",
						{
							idle: "尚未刷新",
							refreshing: "刷新中",
							ready: "可用",
							error: "刷新失败"
						}[catalog.status]
					] }),
					!state.status?.account.hasCredential && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cb-muted",
						children: "请先在“账号与连接”登录。"
					}),
					catalog.source && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cb-muted",
						children: ["目录来源：", catalog.source]
					}),
					catalog.updatedAt && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cb-muted",
						children: ["上次成功刷新：", new Date(catalog.updatedAt).toLocaleString()]
					}),
					catalog.error && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						role: "alert",
						children: [
							"模型刷新失败",
							catalog.cached ? "，正在显示上次成功的目录" : "",
							"。"
						]
					})
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cb-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "默认模型与推理等级" }),
					saved?.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cb-muted",
						children: [
							"DSH 当前默认：",
							saved.provider,
							" / ",
							saved.model,
							saved.reasoningEffort ? ` · ${saved.reasoningEffort}` : ""
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: "当前宿主未提供默认模型设置服务。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["模型 ", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						"aria-label": "默认模型",
						value: selected,
						disabled: state.busy || catalog.status !== "ready" || catalog.cached,
						onChange: (event) => {
							setSelected(event.target.value);
							setEffort(catalog.models.find((model) => model.id === event.target.value)?.reasoning ? "high" : "off");
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "请选择模型"
							}),
							selected && !model && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: selected,
								children: [selected, "（不在当前目录）"]
							}),
							catalog.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: model.id,
								children: [
									model.name,
									" · ",
									model.id
								]
							}, model.id))
						]
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["推理等级 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						"aria-label": "推理等级",
						value: model?.reasoning ? effort : "off",
						disabled: state.busy || !model?.reasoning,
						onChange: (event) => setEffort(event.target.value),
						children: (model?.reasoning ? REASONING_LEVELS : ["off"]).map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: level,
							children: level
						}, level))
					})] }),
					model && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "cb-muted",
						children: [
							"上下文窗口：",
							model.contextWindow.toLocaleString(),
							" tokens。",
							model.reasoning ? "推理等级由适配器统一映射，实际效果取决于模型。" : "此模型不启用推理。"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						disabled: state.busy || !canSave,
						onClick: () => void controller.action("default-model/select", {
							model: selected,
							reasoningEffort: model?.reasoning ? effort : "off"
						}),
						children: "保存为 DSH 默认模型"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cb-muted",
						children: "用于后续采用默认模型的新会话；已有会话保持自己的模型选择。"
					})
				]
			})] });
		}
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = styles;
				document.head.append(style);
				return () => style.remove();
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "codebuddy",
				order: 16,
				label: () => "CodeBuddy",
				inject: () => ({ connection: ctx.get("connection") })
			}, CodeBuddySection));
		}
		//#endregion
		exports.CodeBuddySection = CodeBuddySection;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
