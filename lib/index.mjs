import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createAssistantMessageEventStream, createModels, createProvider } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId, attributionHeaders } from "@deepseek-ai/dsh-llm";
//#region src/codebuddy.ts
const PROVIDER_ID = "codebuddy";
const DEFAULT_SITE_ROOT = "https://www.codebuddy.ai";
const PATHS = {
	authState: "/v2/plugin/auth/state",
	authToken: "/v2/plugin/auth/token",
	refreshToken: "/v2/plugin/auth/token/refresh",
	loginAccount: "/v2/plugin/login/account",
	productConfig: "/v3/config",
	enterpriseModels: "/console/enterprises",
	apiBase: "/v2"
};
const BUSINESS_CODES = {
	retryFetchToken: 11217,
	retryFetchAccount: 12151,
	licenseSeatLimit: 12005,
	licenseExpired: 11212,
	trialExpired: 11216
};
const NETWORK_RETRY_DELAYS_MS = [250, 750];
/**
* Verified against the international auth/state endpoint on 2026-07-22.
* Override with PI_CODEBUDDY_PLATFORM if another deployment expects a
* different product platform value.
*/
const PLATFORM = process.env.PI_CODEBUDDY_PLATFORM?.trim() || "codebuddy";
/** Version of the CLI bundle used by the reverse-engineering reference. */
const PLUGIN_VERSION = "2.125.0";
const X_NO_HEADERS = {
	"X-No-Authorization": "true",
	"X-No-User-Id": "true",
	"X-No-Enterprise-Id": "true",
	"X-No-Department-Info": "true"
};
const X_STAINLESS_HEADERS = {
	"User-Agent": `CLI/${PLUGIN_VERSION} CodeBuddy/${PLUGIN_VERSION}`,
	"x-stainless-lang": "js",
	"x-stainless-package-version": "6.25.0",
	"x-stainless-os": "Windows",
	"x-stainless-arch": "x64",
	"x-stainless-runtime": "node",
	"x-stainless-runtime-version": `v${process.versions.node}`,
	"x-stainless-retry-count": "0",
	"Content-Type": "application/json",
	Accept: "application/json"
};
function envText(name) {
	const value = process.env[name]?.trim();
	return value ? value : void 0;
}
function envDisabled(value) {
	const normalized = value?.toLowerCase();
	return normalized === "off" || normalized === "0" || normalized === "false" || normalized === "no";
}
function envFlag(name, fallback) {
	const value = envText(name);
	if (value === void 0) return fallback;
	return !envDisabled(value);
}
const DIAGNOSTIC_BUILD = "authoritative-model-catalog-2026-07-23";
const DEBUG_STDERR = envFlag("PI_CODEBUDDY_DEBUG", false);
const DEBUG_LOG_PATH = envText("PI_CODEBUDDY_DEBUG_LOG") ?? (DEBUG_STDERR ? resolve(process.cwd(), "pi-codebuddy-debug.jsonl") : void 0);
function sanitizeDiagnosticText(value) {
	return value.replace(/(Bearer\s+)[^\s,;]+/gi, "$1<redacted>").replace(/\/enterprises\/[^/\s]+/gi, "/enterprises/<redacted>").replace(/([?&]repos(?:%5B%5D|\[\])?=)[^&\s]+/gi, "$1<redacted>").slice(0, 4e3);
}
function sanitizeDiagnosticValue(value, key = "") {
	const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
	if ([
		"access",
		"accesstoken",
		"refresh",
		"refreshtoken",
		"token",
		"secret",
		"authorization",
		"apikey"
	].includes(normalizedKey)) return "<redacted>";
	if (typeof value === "string") return sanitizeDiagnosticText(value);
	if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitizeDiagnosticValue(entry));
	const record = asRecord(value);
	if (record) return Object.fromEntries(Object.entries(record).map(([name, entry]) => [name, sanitizeDiagnosticValue(entry, name)]));
	return value;
}
function defaultDiagnosticSink(event, details) {
	if (!DEBUG_STDERR && !DEBUG_LOG_PATH) return;
	const entry = {
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		build: DIAGNOSTIC_BUILD,
		event,
		details: sanitizeDiagnosticValue(details)
	};
	const line = JSON.stringify(entry);
	if (DEBUG_STDERR) console.error(`[pi-codebuddy] ${line}`);
	if (DEBUG_LOG_PATH) try {
		appendFileSync(DEBUG_LOG_PATH, `${line}\n`, "utf8");
	} catch (error) {
		if (DEBUG_STDERR) console.error(`[pi-codebuddy] unable to write diagnostic log: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}`);
	}
}
function identifierFingerprint(value) {
	if (typeof value !== "string" || !value.trim()) return void 0;
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
function urlHostFingerprint(value) {
	if (typeof value !== "string") return void 0;
	try {
		return identifierFingerprint(new URL(value).host);
	} catch {
		return;
	}
}
function diagnosticValueShape(value, depth = 0) {
	if (depth >= 6) return { type: "max-depth" };
	if (Array.isArray(value)) return {
		type: "array",
		length: value.length,
		firstItem: value.length > 0 ? diagnosticValueShape(value[0], depth + 1) : void 0
	};
	const record = asRecord(value);
	if (record) {
		const keys = Object.keys(record).sort().slice(0, 100);
		return {
			type: "object",
			keys,
			fields: Object.fromEntries(keys.map((name) => [name, diagnosticValueShape(record[name], depth + 1)]))
		};
	}
	return { type: value === null ? "null" : typeof value };
}
function responseShape(payload) {
	const root = asRecord(payload);
	if (!root) return { type: Array.isArray(payload) ? "array" : typeof payload };
	const direct = root.data;
	const nested = asRecord(direct)?.data;
	const models = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : void 0;
	return {
		type: "object",
		keys: Object.keys(root).sort(),
		code: root.code,
		message: root.msg ?? root.message,
		dataType: Array.isArray(direct) ? "array" : direct === null ? "null" : typeof direct,
		dataKeys: asRecord(direct) ? Object.keys(asRecord(direct)).sort() : void 0,
		modelCount: models?.length,
		firstModelKeys: asRecord(models?.[0]) ? Object.keys(asRecord(models?.[0])).sort() : void 0,
		sampleModelIds: models?.slice(0, 20).map((entry) => optionalString(asRecord(entry)?.id)).filter((id) => id !== void 0),
		structure: diagnosticValueShape(payload)
	};
}
/** Envelope 默认配置，从环境变量派生；抓包实测值为默认。 */
const ENVELOPE = {
	enabled: envFlag("PI_CODEBUDDY_ENVELOPE", true),
	agentTag: (() => {
		const value = envText("PI_CODEBUDDY_AGENT_TAG");
		if (value === void 0) return "cli";
		return envDisabled(value) ? void 0 : value;
	})(),
	reasoningEffort: (() => {
		const value = envText("PI_CODEBUDDY_REASONING_EFFORT");
		if (value === void 0) return "high";
		return envDisabled(value) ? void 0 : value;
	})(),
	streamOptions: envFlag("PI_CODEBUDDY_STREAM_OPTIONS", true),
	temperature: (() => {
		const value = envText("PI_CODEBUDDY_TEMPERATURE");
		if (value === void 0) return 1;
		const lowered = value.toLowerCase();
		if (lowered === "off" || lowered === "false" || lowered === "no") return;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 1;
	})()
};
/**
* 额外 CLI 请求头开关（x-ide-、x-conversation-、x-product 等，抓包实测）。
* PI_CODEBUDDY_CLI_HEADERS=off 时回退到最简可用集
* （x-domain + x-agent-intent + x-user-id/企业头 + x-stainless 系列）。
*/
const SEND_CLI_HEADERS = envFlag("PI_CODEBUDDY_CLI_HEADERS", true);
const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MODEL_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsStrictMode: true,
	maxTokensField: "max_tokens"
};
/**
* Exact chat-model subset referenced by the `cli` agent in
* @tencent-ai/codebuddy-code@2.125.0 product.json (international SaaS).
* The package contains 22 models, but seven image/video/default-lite entries
* are not exposed by the CLI agent and therefore do not belong in pi's picker.
*/
const EXTERNAL_CLI_MODEL_CONFIGS = [
	{
		id: "default-model",
		name: "Default",
		maxInputTokens: 176e3,
		maxOutputTokens: 24e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini-3.1-Pro",
		maxInputTokens: 4e5,
		maxOutputTokens: 64e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "gemini-3.0-flash",
		name: "Gemini-3.0-Flash",
		maxInputTokens: 4e5,
		maxOutputTokens: 64e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini-3.5-Flash",
		maxInputTokens: 1e6,
		maxOutputTokens: 65536,
		supportsImages: true,
		supportsReasoning: true,
		onlyReasoning: true
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini-2.5-Pro",
		maxInputTokens: 4e5,
		maxOutputTokens: 64e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini-2.5-Flash",
		maxInputTokens: 4e5,
		maxOutputTokens: 64e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "gemini-3.1-flash-lite",
		name: "Gemini-3.1-flash-lite",
		maxInputTokens: 2e5,
		maxOutputTokens: 65536,
		supportsImages: true,
		supportsReasoning: true,
		onlyReasoning: true
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		maxInputTokens: 1e6,
		maxOutputTokens: 72e3,
		supportsImages: true,
		supportsReasoning: true,
		onlyReasoning: true
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		maxInputTokens: 272e3,
		maxOutputTokens: 128e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		maxInputTokens: 272e3,
		maxOutputTokens: 128e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "gpt-5.1-codex",
		name: "GPT-5.1-Codex",
		maxInputTokens: 272e3,
		maxOutputTokens: 128e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "gpt-5.1-codex-mini",
		name: "GPT-5.1-Codex-Mini",
		maxInputTokens: 272e3,
		maxOutputTokens: 128e3,
		supportsImages: true,
		supportsReasoning: true
	},
	{
		id: "deepseek-v3-2-volc",
		name: "DeepSeek-V3.2",
		maxInputTokens: 96e3,
		maxOutputTokens: 32e3,
		supportsImages: false,
		supportsReasoning: true,
		onlyReasoning: true
	},
	{
		id: "glm-5.0",
		name: "GLM-5.0",
		maxInputTokens: 2e5,
		maxOutputTokens: 48e3,
		supportsImages: false,
		supportsReasoning: true
	},
	{
		id: "kimi-k2.5",
		name: "Kimi-K2.5",
		maxInputTokens: 164e3,
		maxOutputTokens: 32e3,
		supportsImages: true,
		supportsReasoning: true,
		onlyReasoning: true
	}
];
const ENVIRONMENT_MODEL_DEFINITIONS = {
	internal: [
		[
			"glm-5.2",
			"GLM-5.2",
			1e6,
			48e3,
			false,
			true,
			true
		],
		[
			"glm-5.1",
			"GLM-5.1",
			2e5,
			48e3,
			false,
			true,
			true
		],
		[
			"glm-5v-turbo",
			"GLM-5v-Turbo",
			2e5,
			64e3,
			true,
			true,
			true
		],
		[
			"minimax-m3",
			"MiniMax-M3",
			512e3,
			128e3,
			true,
			true,
			true
		],
		[
			"minimax-m2.7",
			"MiniMax-M2.7",
			2e5,
			48e3,
			true,
			true,
			true
		],
		[
			"kimi-k2.7",
			"Kimi-K2.7-Code",
			256e3,
			32e3,
			true,
			true,
			true
		],
		[
			"kimi-k2.6",
			"Kimi-K2.6",
			256e3,
			32e3,
			true,
			true,
			true
		],
		[
			"hy3-preview",
			"Hy3 preview",
			192e3,
			64e3,
			true,
			true,
			true
		],
		[
			"deepseek-v4-pro",
			"Deepseek-V4-Pro",
			1e6,
			5e4,
			true,
			true,
			true
		],
		[
			"deepseek-v4-flash",
			"Deepseek-V4-Flash",
			1e6,
			5e4,
			true,
			true,
			true
		],
		[
			"deepseek-v3-2-volc",
			"DeepSeek-V3.2",
			96e3,
			32e3,
			false,
			true,
			true
		]
	],
	ioa: [
		[
			"claude-sonnet-5",
			"Claude-Sonnet-5",
			2e5,
			64e3,
			true,
			true
		],
		[
			"claude-sonnet-5-1m",
			"Claude-Sonnet-5-1M",
			1e6,
			128e3,
			true,
			true,
			false
		],
		[
			"claude-sonnet-4.6",
			"Claude-Sonnet-4.6",
			176e3,
			24e3,
			true,
			true
		],
		[
			"claude-sonnet-4.6-1m",
			"Claude-Sonnet-4.6-1M",
			1e6,
			24e3,
			true,
			true
		],
		[
			"claude-opus-4.8",
			"Claude-Opus-4.8",
			176e3,
			64e3,
			true,
			true
		],
		[
			"claude-opus-4.8-1m",
			"Claude-Opus-4.8-1M",
			1e6,
			128e3,
			true,
			true
		],
		[
			"claude-opus-4.7",
			"Claude-Opus-4.7",
			176e3,
			64e3,
			true,
			true
		],
		[
			"claude-opus-4.7-1m",
			"Claude-Opus-4.7-1M",
			1e6,
			128e3,
			true,
			true
		],
		[
			"claude-opus-4.6",
			"Claude-Opus-4.6",
			176e3,
			24e3,
			true,
			true
		],
		[
			"claude-opus-4.6-1m",
			"Claude-Opus-4.6-1M",
			1e6,
			64e3,
			true,
			true
		],
		[
			"claude-haiku-4.5",
			"Claude-Haiku-4.5",
			176e3,
			24e3,
			true,
			true
		],
		[
			"gemini-3.1-pro",
			"Gemini-3.1-Pro",
			4e5,
			64e3,
			true,
			true
		],
		[
			"gemini-3.5-flash",
			"Gemini-3.5-Flash",
			1e6,
			65536,
			true,
			true,
			true
		],
		[
			"gemini-2.5-pro",
			"Gemini-2.5-Pro",
			4e5,
			64e3,
			true,
			true
		],
		[
			"gpt-5.5",
			"GPT-5.5",
			1e6,
			128e3,
			true,
			true,
			true
		],
		[
			"gpt-5.4",
			"GPT-5.4",
			272e3,
			128e3,
			true,
			true
		],
		[
			"gpt-5.3-codex",
			"GPT-5.3-Codex",
			272e3,
			128e3,
			true,
			true
		],
		[
			"gpt-5.1-codex",
			"GPT-5.1-Codex",
			272e3,
			128e3,
			true,
			true
		],
		[
			"gpt-5.1-codex-mini",
			"GPT-5.1-Codex-Mini",
			272e3,
			128e3,
			true,
			true
		],
		[
			"glm-5.2-ioa",
			"GLM-5.2",
			1e6,
			48e3,
			false,
			true,
			true
		],
		[
			"glm-5v-turbo-ioa",
			"GLM-5v-Turbo",
			2e5,
			38e3,
			true,
			true,
			true
		],
		[
			"minimax-m3-ioa",
			"MiniMax-M3",
			512e3,
			48e3,
			true,
			true,
			true
		],
		[
			"minimax-m2.7-ioa",
			"MiniMax-M2.7",
			2e5,
			48e3,
			true,
			true,
			true
		],
		[
			"minimax-m2.5-ioa",
			"MiniMax-M2.5",
			2e5,
			48e3,
			false,
			true,
			true
		],
		[
			"kimi-k2.7-ioa",
			"Kimi-K2.7-Code",
			256e3,
			32e3,
			true,
			true,
			true
		],
		[
			"kimi-k2.6-ioa",
			"Kimi-K2.6",
			256e3,
			32e3,
			true,
			true,
			true
		],
		[
			"hy3-preview-agent-ioa",
			"Hy3 preview",
			192e3,
			64e3,
			true,
			true,
			true
		],
		[
			"echo",
			"Echo",
			238e3,
			24e3,
			false,
			false
		],
		[
			"deepseek-v3-2-volc-ioa",
			"DeepSeek-V3.2",
			96e3,
			32e3,
			false,
			true,
			true
		],
		[
			"deepseek-v4-flash-ioa",
			"Deepseek-V4-Flash",
			1e6,
			5e4,
			true,
			true,
			true
		],
		[
			"deepseek-v4-pro-ioa",
			"Deepseek-V4-Pro",
			1e6,
			5e4,
			true,
			true,
			true
		]
	],
	cloudhosted: [
		[
			"glm-4.7",
			"GLM-4.7",
			2e5,
			48e3,
			false,
			true
		],
		[
			"glm-4.6",
			"GLM-4.6",
			168e3,
			32e3,
			false,
			true
		],
		[
			"deepseek-v3-2-volc",
			"DeepSeek-V3.2",
			96e3,
			32e3,
			false,
			true,
			true
		],
		[
			"deepseek-v3.1",
			"DeepSeek-V3.1-Terminus",
			128e3,
			8192,
			false,
			false
		],
		[
			"deepseek-v3-0324",
			"DeepSeek-V3",
			128e3,
			8192,
			false,
			false
		]
	],
	selfhosted: [[
		"codewise-chat",
		"Codewise-Chat",
		128e3,
		8192,
		false,
		false
	]]
};
/**
* The Cloud-Hosted file contains a 24-entry global model pool but declares only
* five of them on the `cli` agent. CloudProductProvider overlays remote model
* entries on this full pool before AgentManager computes /model visibility.
*/
const CLOUDHOSTED_PRODUCT_MODEL_DEFINITIONS = [
	[
		"default",
		"Default",
		2e5,
		24e3,
		false,
		false
	],
	[
		"deepseek-v3-2-volc",
		"DeepSeek-V3.2",
		96e3,
		32e3,
		false,
		true,
		true
	],
	[
		"glm-4.7",
		"GLM-4.7",
		2e5,
		48e3,
		false,
		true
	],
	[
		"glm-4.6",
		"GLM-4.6",
		168e3,
		32e3,
		false,
		true
	],
	[
		"deepseek-v3.1",
		"DeepSeek-V3.1-Terminus",
		128e3,
		8192,
		false,
		false
	],
	[
		"hunyuan-chat",
		"Hunyuan-Turbos",
		2e5,
		8192,
		false,
		false
	],
	[
		"deepseek-v3-0324",
		"DeepSeek-V3",
		128e3,
		8192,
		false,
		false
	],
	[
		"kimi-k2-thinking",
		"Kimi-K2-Thinking",
		164e3,
		32e3,
		false,
		true,
		true
	],
	[
		"deepseek-v4-pro",
		"Deepseek-V4-Pro",
		1e6,
		5e4,
		true,
		true,
		true
	],
	[
		"deepseek-v4-flash",
		"Deepseek-V4-Flash",
		1e6,
		5e4,
		true,
		true,
		true
	],
	[
		"minimax-m2.5",
		"MiniMax-M2.5",
		2e5,
		48e3,
		false,
		true,
		true
	],
	[
		"minimax-m2.7",
		"MiniMax-M2.7",
		2e5,
		48e3,
		true,
		true,
		true
	],
	[
		"glm-5.1",
		"GLM-5.1",
		2e5,
		48e3,
		false,
		true,
		true
	],
	[
		"glm-5.0",
		"GLM-5.0",
		2e5,
		48e3,
		false,
		true
	],
	[
		"glm-5.0-turbo",
		"GLM-5.0-Turbo",
		2e5,
		48e3,
		false,
		true,
		true
	],
	[
		"glm-5v-turbo",
		"GLM-5v-Turbo",
		2e5,
		38e3,
		true,
		true,
		true
	],
	[
		"glm-4.6v",
		"GLM-4.6V",
		128e3,
		32e3,
		true,
		true
	],
	[
		"kimi-k2.6",
		"Kimi-K2.6",
		256e3,
		32e3,
		true,
		true,
		true
	],
	[
		"kimi-k2.5",
		"Kimi-K2.5",
		164e3,
		32e3,
		true,
		true,
		true
	],
	[
		"hy3-preview-agent",
		"Hy3 preview",
		192e3,
		64e3,
		true,
		true,
		true
	],
	[
		"auto",
		"Auto",
		168e3,
		32e3,
		true,
		false,
		false,
		["craft"]
	],
	[
		"deepseek-v4-pro-exclusive",
		"Deepseek-V4-Pro",
		1e6,
		5e4,
		true,
		true,
		true
	],
	[
		"hunyuan-2.0-instruct",
		"Hunyuan-2.0-Instruct",
		128e3,
		16e3,
		true,
		true,
		true
	],
	[
		"hunyuan-image-v3.0",
		"Hunyuan Image V3",
		void 0,
		void 0,
		void 0,
		void 0,
		void 0,
		["text-to-image"]
	]
];
const PRODUCT_DOMAIN_RULES = {
	internal: [
		"copilot.tencent.com",
		"staging-copilot.tencent.com",
		"www.codebuddy.cn",
		"staging.codebuddy.cn"
	],
	ioa: [
		"tencent.sso.copilot.tencent.com",
		"tencent.sso.copilot-staging.tencent.com",
		"tencent.sso.codebuddy.cn",
		"tencent.staging-sso.codebuddy.cn"
	],
	cloudhosted: [
		"*.sso.copilot.tencent.com",
		"*.sso.copilot-staging.tencent.com",
		"*.copilot.qq.com",
		"*.copilot-staging.qq.com",
		"*.sso.codebuddy.cn",
		"*.staging-sso.codebuddy.cn"
	],
	external: ["www.codebuddy.ai", "staging-codebuddy.tencent.com"]
};
function normalizedDomain(value) {
	const trimmed = value.trim().toLowerCase();
	try {
		return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
	} catch {
		return trimmed.split(":", 1)[0];
	}
}
function domainMatches(pattern, domain) {
	if (!pattern.startsWith("*.")) return pattern === domain;
	const suffix = pattern.slice(1);
	return domain.endsWith(suffix) && domain.length > suffix.length;
}
function resolveCodeBuddyProductEnvironment(domain) {
	const override = envText("PI_CODEBUDDY_PRODUCT_ENV")?.toLowerCase();
	if (override === "external" || override === "internal" || override === "ioa" || override === "cloudhosted" || override === "selfhosted") return override;
	const normalized = normalizedDomain(domain);
	for (const environment of [
		"internal",
		"ioa",
		"cloudhosted",
		"external"
	]) if (PRODUCT_DOMAIN_RULES[environment].some((pattern) => domainMatches(pattern, normalized))) return environment;
	return "selfhosted";
}
function productModelConfigsFor(environment) {
	if (environment === "external") return EXTERNAL_CLI_MODEL_CONFIGS;
	return productDefinitionsToConfigs(ENVIRONMENT_MODEL_DEFINITIONS[environment]);
}
function productModelPoolConfigsFor(environment) {
	if (environment === "cloudhosted") return productDefinitionsToConfigs(CLOUDHOSTED_PRODUCT_MODEL_DEFINITIONS);
	return productModelConfigsFor(environment);
}
function productDefinitionsToConfigs(definitions) {
	return definitions.map(([id, name, maxInputTokens, maxOutputTokens, supportsImages, supportsReasoning, onlyReasoning, tags]) => ({
		id,
		name,
		maxInputTokens,
		maxOutputTokens,
		supportsImages,
		supportsReasoning,
		...onlyReasoning === void 0 ? {} : { onlyReasoning },
		...tags === void 0 ? {} : { tags }
	}));
}
function productConfigFileName(environment) {
	return environment === "external" ? "product.json" : `product.${environment}.json`;
}
const BUILTIN_MODELS = productModelConfigsFor(resolveCodeBuddyProductEnvironment(new URL(DEFAULT_SITE_ROOT).host)).map((entry) => {
	const model = toPiModel(entry, DEFAULT_SITE_ROOT);
	if (!model) throw new Error(`Invalid built-in CodeBuddy model: ${entry.id}`);
	return model;
});
const defaultSleep = (milliseconds, signal) => new Promise((resolve, reject) => {
	throwIfAborted(signal);
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, milliseconds);
	const onAbort = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		reject(abortReason(signal));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
});
function makeRuntime(options = {}) {
	return {
		fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
		now: options.now ?? Date.now,
		sleep: options.sleep ?? defaultSleep,
		pollIntervalMs: options.pollIntervalMs ?? 1e3,
		pollTimeoutMs: options.pollTimeoutMs ?? 3e5,
		expiresSafetyMarginMs: options.expiresSafetyMarginMs ?? 3e5,
		platform: options.platform ?? PLATFORM,
		pluginVersion: options.pluginVersion ?? "2.125.0",
		conversationRequestId: options.conversationRequestId ?? randomUUID,
		sendCliHeaders: options.sendCliHeaders ?? SEND_CLI_HEADERS,
		debug: options.debug ?? (DEBUG_STDERR || DEBUG_LOG_PATH ? defaultDiagnosticSink : void 0),
		probeCloudConfig: options.probeCloudConfig ?? envFlag("PI_CODEBUDDY_PROBE_CLOUD_CONFIG", false),
		cloudConfigRepos: normalizeCloudConfigRepos(options.cloudConfigRepos ?? parseCloudConfigReposEnv())
	};
}
function parseCloudConfigReposEnv() {
	const value = envText("PI_CODEBUDDY_CONFIG_REPOS");
	if (!value) return [];
	if (value.startsWith("[")) try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter((entry) => typeof entry === "string");
	} catch {}
	return value.split(",");
}
function normalizeCloudConfigRepos(values) {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function emitDiagnostic(runtime, event, details) {
	try {
		runtime.debug?.(event, sanitizeDiagnosticValue(details));
	} catch {}
}
/** Normalize any supplied URL to its origin and join one absolute path. */
function joinUrl(root, path) {
	return `${new URL(root.trim()).origin}${path.startsWith("/") ? path : `/${path}`}`;
}
function normalizeSiteRoot(input) {
	const url = new URL(input.trim());
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("CodeBuddy 登录站点 URL 必须使用 http 或 https");
	return url.origin;
}
function withQuery(root, path, query) {
	const url = new URL(joinUrl(root, path));
	for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
	return url.toString();
}
function authUrlWithVersion(authUrl, root, version) {
	const url = new URL(authUrl, root);
	url.searchParams.set("version", version);
	return url.toString();
}
function abortReason(signal) {
	return signal?.reason ?? new DOMException("操作已取消", "AbortError");
}
function throwIfAborted(signal) {
	if (signal?.aborted) throw abortReason(signal);
}
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* Add the CodeBuddy CLI envelope while retaining OpenAI semantics.
* Every injected field only fills a gap the caller left undefined, and each
* is individually gated by `envelope` so a deployment/model can opt out.
*/
function prepareCodeBuddyPayload(payload, model, envelope = ENVELOPE) {
	const params = asRecord(payload);
	if (!params || !envelope.enabled) return payload;
	const result = { ...params };
	if (envelope.temperature !== void 0 && result.temperature === void 0) result.temperature = envelope.temperature;
	if (result.max_tokens === void 0 && result.max_completion_tokens === void 0) result.max_tokens = model.maxTokens;
	if (envelope.streamOptions && result.stream_options === void 0) result.stream_options = { include_usage: true };
	if (model.reasoning && envelope.reasoningEffort !== void 0 && result.reasoning_effort === void 0) result.reasoning_effort = envelope.reasoningEffort;
	if (envelope.agentTag !== void 0 && Array.isArray(params.messages)) {
		const tag = envelope.agentTag;
		result.messages = params.messages.map((message) => {
			const record = asRecord(message);
			if (!record || record.role !== "user") return message;
			return {
				...record,
				agent: tag,
				content: typeof record.content === "string" ? [{
					type: "text",
					text: record.content
				}] : record.content
			};
		});
	}
	return result;
}
function withCodeBuddyPayload(options, envelope = ENVELOPE) {
	const callerPayload = options?.onPayload;
	const callerResponse = options?.onResponse;
	return {
		...options ?? {},
		async onPayload(payload, model) {
			return prepareCodeBuddyPayload(await callerPayload?.(payload, model) ?? payload, model, envelope);
		},
		async onResponse(response, model) {
			await callerResponse?.(response, model);
			const contentType = response.headers["content-type"] ?? response.headers["Content-Type"];
			if (response.status === 200 && typeof contentType === "string" && contentType.toLowerCase().includes("application/json")) throw new Error("CodeBuddy 返回了 HTTP 200 JSON 业务错误；请检查许可与配额，许可失效时重新执行 /login codebuddy");
		}
	};
}
function mapCodeBuddyErrorMessage(message) {
	const detail = message?.trim() || "CodeBuddy 请求失败";
	if (/\b(?:401|11212|11216)\b/.test(detail)) return `CodeBuddy 登录或许可已失效，请重新执行 /login codebuddy（${detail}）`;
	return detail;
}
function wrapCodeBuddyEvents(source) {
	const target = createAssistantMessageEventStream();
	let latest;
	let sawContent = false;
	(async () => {
		for await (const event of source) {
			if ("partial" in event) latest = event.partial;
			if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta" || event.type === "toolcall_end") sawContent = true;
			if (event.type === "error") {
				latest = event.error;
				target.push({
					...event,
					error: {
						...event.error,
						errorMessage: mapCodeBuddyErrorMessage(event.error.errorMessage)
					}
				});
			} else if (event.type === "done" && !sawContent && event.message.content.length === 0) {
				latest = event.message;
				target.push({
					type: "error",
					reason: "error",
					error: {
						...event.message,
						stopReason: "error",
						errorMessage: "CodeBuddy 返回了空流；这通常表示业务错误，请检查许可/配额或重新执行 /login codebuddy"
					}
				});
			} else {
				if (event.type === "done") latest = event.message;
				target.push(event);
			}
		}
	})().catch((error) => {
		if (!latest) {
			target.end();
			return;
		}
		target.push({
			type: "error",
			reason: "error",
			error: {
				...latest,
				stopReason: "error",
				errorMessage: mapCodeBuddyErrorMessage(error instanceof Error ? error.message : String(error))
			}
		});
	});
	return target;
}
function codeBuddyCompletionsApi(envelope = ENVELOPE) {
	const delegate = openAICompletionsApi();
	return {
		stream(model, context, options) {
			return wrapCodeBuddyEvents(delegate.stream(model, context, withCodeBuddyPayload(options, envelope)));
		},
		streamSimple(model, context, options) {
			return wrapCodeBuddyEvents(delegate.streamSimple(model, context, withCodeBuddyPayload(options, envelope)));
		}
	};
}
function optionalString(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function optionalNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function compactRequestId(value) {
	return value.replaceAll("-", "");
}
function isOfficialSaaSRoot(root) {
	const host = new URL(root).hostname.toLowerCase();
	return host === "codebuddy.ai" || host === "www.codebuddy.ai" || host === "copilot.tencent.com";
}
function getBusinessError(payload) {
	const root = asRecord(payload);
	const error = asRecord(root?.error);
	const numericCode = Number(error?.code ?? root?.code);
	if (!Number.isFinite(numericCode) || numericCode === 0) return;
	return {
		code: numericCode,
		message: optionalString(error?.message) ?? optionalString(root?.message) ?? optionalString(root?.msg)
	};
}
function businessErrorMessage(error) {
	if (error.code === BUSINESS_CODES.licenseExpired || error.code === BUSINESS_CODES.trialExpired) return `CodeBuddy 许可已过期（业务码 ${error.code}），请重新执行 /login codebuddy`;
	return error.message ?? `CodeBuddy 请求失败（业务码 ${error.code}）`;
}
function throwBusinessError(payload) {
	const error = getBusinessError(payload);
	if (error) throw new Error(businessErrorMessage(error));
}
function extractData(payload) {
	const root = asRecord(payload);
	if (!root) throw new Error("CodeBuddy 返回了无法识别的响应");
	const first = asRecord(root.data);
	return asRecord(first?.data) ?? first ?? root;
}
async function fetchJson(runtime, url, init, networkRetries = 0, diagnosticScope) {
	let response;
	for (let attempt = 0; attempt <= networkRetries; attempt += 1) try {
		response = await runtime.fetch(url, init);
		break;
	} catch (error) {
		if (init.signal?.aborted) throw abortReason(init.signal);
		if (attempt < networkRetries) {
			const delay = NETWORK_RETRY_DELAYS_MS[Math.min(attempt, NETWORK_RETRY_DELAYS_MS.length - 1)];
			await runtime.sleep(delay, init.signal ?? void 0);
			continue;
		}
		const detail = error instanceof Error ? error.message : String(error);
		if (diagnosticScope) emitDiagnostic(runtime, `${diagnosticScope}.network_error`, {
			attempt: attempt + 1,
			attempts: networkRetries + 1,
			errorName: error instanceof Error ? error.name : typeof error,
			errorMessage: detail,
			errorCode: asRecord(error)?.code,
			causeCode: asRecord(asRecord(error)?.cause)?.code
		});
		throw new Error(`无法连接 CodeBuddy：${detail}`, { cause: error });
	}
	if (!response) throw new Error("无法连接 CodeBuddy：请求未返回响应");
	if (diagnosticScope) emitDiagnostic(runtime, `${diagnosticScope}.http_response`, {
		status: response.status,
		statusText: response.statusText,
		contentType: response.headers.get("content-type")
	});
	if (!response.ok && diagnosticScope) {
		let errorBody;
		let textPreview;
		try {
			const text = await response.clone().text();
			if (text) try {
				errorBody = JSON.parse(text);
			} catch {
				textPreview = text.slice(0, 1e3);
			}
		} catch {}
		emitDiagnostic(runtime, `${diagnosticScope}.error_response`, {
			...errorBody === void 0 ? {} : responseShape(errorBody),
			textPreview
		});
	}
	if (response.status === 401) throw new Error("CodeBuddy 登录已失效，请重新执行 /login codebuddy");
	if (!response.ok) throw new Error(`CodeBuddy 请求失败：HTTP ${response.status} ${response.statusText}`.trim());
	try {
		const payload = await response.json();
		if (diagnosticScope) emitDiagnostic(runtime, `${diagnosticScope}.response_body`, responseShape(payload));
		return payload;
	} catch (error) {
		if (diagnosticScope) emitDiagnostic(runtime, `${diagnosticScope}.invalid_json`, {
			errorName: error instanceof Error ? error.name : typeof error,
			errorMessage: error instanceof Error ? error.message : String(error)
		});
		throw new Error("CodeBuddy 返回了无效 JSON", { cause: error });
	}
}
function parseAuthData(payload) {
	const data = extractData(payload);
	const accessToken = optionalString(data.accessToken);
	const refreshToken = optionalString(data.refreshToken);
	if (!accessToken || !refreshToken) throw new Error("CodeBuddy 响应缺少 accessToken 或 refreshToken");
	return {
		accessToken,
		refreshToken,
		domain: optionalString(data.domain),
		expiresAt: optionalNumber(data.expiresAt),
		expiresIn: optionalNumber(data.expiresIn)
	};
}
function credentialExpires(auth, runtime) {
	const now = runtime.now();
	const absolute = auth.expiresAt && auth.expiresAt > 0 ? auth.expiresAt : auth.expiresIn && auth.expiresIn > 0 ? now + auth.expiresIn * 1e3 : void 0;
	if (!absolute) throw new Error("CodeBuddy 响应缺少有效的 expiresAt/expiresIn");
	return Math.max(0, absolute - runtime.expiresSafetyMarginMs);
}
async function fetchAuthState(root, runtime, signal) {
	const payload = await fetchJson(runtime, withQuery(root, PATHS.authState, { platform: runtime.platform }), {
		method: "POST",
		headers: {
			...X_NO_HEADERS,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({}),
		signal
	}, NETWORK_RETRY_DELAYS_MS.length);
	throwBusinessError(payload);
	const data = extractData(payload);
	const state = optionalString(data.state);
	const authUrl = optionalString(data.authUrl);
	if (!state || !authUrl) throw new Error("CodeBuddy 登录响应缺少 state 或 authUrl");
	return {
		state,
		authUrl
	};
}
async function loopGetToken(root, state, runtime, signal) {
	const startedAt = runtime.now();
	while (runtime.now() - startedAt < runtime.pollTimeoutMs) {
		throwIfAborted(signal);
		const payload = await fetchJson(runtime, withQuery(root, PATHS.authToken, { state }), {
			method: "GET",
			headers: X_NO_HEADERS,
			signal
		}, NETWORK_RETRY_DELAYS_MS.length);
		const businessError = getBusinessError(payload);
		if (!businessError) return parseAuthData(payload);
		if (businessError.code !== BUSINESS_CODES.retryFetchToken) throw new Error(businessErrorMessage(businessError));
		const elapsed = runtime.now() - startedAt;
		if (elapsed >= runtime.pollTimeoutMs) break;
		await runtime.sleep(Math.min(runtime.pollIntervalMs, runtime.pollTimeoutMs - elapsed), signal);
	}
	throw new Error("等待 CodeBuddy 浏览器授权超时（5 分钟），请重新登录");
}
async function fetchAccount(root, state, accessToken, runtime, signal) {
	const payload = await fetchJson(runtime, withQuery(root, PATHS.loginAccount, { state }), {
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
		signal
	}, 1);
	throwBusinessError(payload);
	const data = extractData(payload);
	return {
		uid: optionalString(data.uid),
		type: optionalString(data.type),
		enterpriseId: optionalString(data.enterpriseId),
		departmentFullName: optionalString(data.departmentFullName)
	};
}
function credentialString(credential, field) {
	const value = credential[field];
	if (typeof value !== "string" || !value.trim()) throw new Error(`CodeBuddy 凭据缺少 ${field}，请重新执行 /login codebuddy`);
	return value;
}
function createCodeBuddyOAuth(options = {}) {
	const runtime = makeRuntime(options);
	const login = async (interaction) => {
		throwIfAborted(interaction.signal);
		const baseUrl = normalizeSiteRoot(await interaction.prompt({
			type: "text",
			message: "CodeBuddy 登录站点 URL",
			placeholder: DEFAULT_SITE_ROOT
		}));
		const { state, authUrl } = await fetchAuthState(baseUrl, runtime, interaction.signal);
		interaction.notify({
			type: "auth_url",
			url: authUrlWithVersion(authUrl, baseUrl, runtime.pluginVersion)
		});
		interaction.notify({
			type: "progress",
			message: "等待浏览器授权…"
		});
		const auth = await loopGetToken(baseUrl, state, runtime, interaction.signal);
		let account = {};
		try {
			account = await fetchAccount(baseUrl, state, auth.accessToken, runtime, interaction.signal);
		} catch (error) {
			if (interaction.signal?.aborted) throw error;
		}
		return {
			type: "oauth",
			access: auth.accessToken,
			refresh: auth.refreshToken,
			expires: credentialExpires(auth, runtime),
			baseUrl,
			domain: auth.domain,
			uid: account.uid,
			enterpriseId: account.enterpriseId,
			departmentFullName: account.departmentFullName,
			accountType: account.type
		};
	};
	const refresh = async (credential, signal) => {
		throwIfAborted(signal);
		const baseUrl = normalizeSiteRoot(credentialString(credential, "baseUrl"));
		const currentRefresh = credentialString(credential, "refresh");
		const payload = await fetchJson(runtime, joinUrl(baseUrl, PATHS.refreshToken), {
			method: "POST",
			headers: {
				"X-Refresh-Token": currentRefresh,
				"X-Auth-Refresh-Source": "plugin",
				"Content-Type": "application/json"
			},
			body: JSON.stringify({}),
			signal
		});
		throwBusinessError(payload);
		const auth = parseAuthData(payload);
		return {
			...credential,
			type: "oauth",
			access: auth.accessToken,
			refresh: auth.refreshToken,
			expires: credentialExpires(auth, runtime),
			domain: auth.domain ?? credential.domain
		};
	};
	const toAuth = async (credential) => {
		const access = credentialString(credential, "access");
		const baseUrl = normalizeSiteRoot(credentialString(credential, "baseUrl"));
		const domain = optionalString(credential.domain) ?? new URL(baseUrl).host;
		const uid = optionalString(credential.uid);
		const enterpriseId = optionalString(credential.enterpriseId);
		const cliHeaders = runtime.sendCliHeaders ? (() => {
			const conversationId = runtime.conversationRequestId();
			const conversationRequestId = compactRequestId(runtime.conversationRequestId());
			const messageId = compactRequestId(runtime.conversationRequestId());
			return {
				"x-agent-purpose": "conversation",
				"x-requested-with": "XMLHttpRequest",
				"x-conversation-id": conversationId,
				"x-conversation-request-id": conversationRequestId,
				"x-request-id": messageId,
				"x-conversation-message-id": messageId,
				"x-ide-type": "CLI",
				"x-ide-name": "CLI",
				"x-ide-version": runtime.pluginVersion,
				"x-private-data": "false",
				"x-codebuddy-request": "1",
				...isOfficialSaaSRoot(baseUrl) ? { "x-product": "SaaS" } : {}
			};
		})() : {};
		return {
			apiKey: access,
			baseUrl: joinUrl(baseUrl, PATHS.apiBase),
			headers: {
				"x-domain": domain,
				"x-agent-intent": "craft",
				...cliHeaders,
				...uid ? { "x-user-id": uid } : {},
				...enterpriseId ? {
					"x-enterprise-id": enterpriseId,
					"x-tenant-id": enterpriseId
				} : {},
				...X_STAINLESS_HEADERS
			}
		};
	};
	return {
		name: "CodeBuddy",
		login,
		refresh,
		toAuth
	};
}
const defaultOAuth = createCodeBuddyOAuth();
defaultOAuth.login;
defaultOAuth.refresh;
defaultOAuth.toAuth;
/** Map one CodeBuddy product-model entry to a pi-ai model. */
function toPiModel(entry, siteRoot) {
	const record = asRecord(entry);
	const id = optionalString(record?.id);
	if (!record || !id) return void 0;
	const supportsImages = record.supportsImages === true;
	const reasoning = record.supportsReasoning === true || record.onlyReasoning === true || record.reasoning != null && record.reasoning !== false;
	const modelUrl = optionalString(record.url);
	const baseUrl = modelUrl ? new URL(modelUrl).origin + new URL(modelUrl).pathname.replace(/\/chat\/completions\/?$/, "") : joinUrl(siteRoot, PATHS.apiBase);
	return {
		id,
		name: optionalString(record.name) ?? id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl,
		reasoning,
		input: supportsImages ? ["text", "image"] : ["text"],
		cost: ZERO_COST,
		contextWindow: optionalNumber(record.maxInputTokens) ?? 176e3,
		maxTokens: optionalNumber(record.maxOutputTokens) ?? 24e3,
		compat: MODEL_COMPAT
	};
}
function configHeaders(credential, domain, runtime, productEnvironment) {
	const uid = optionalString(credential.uid);
	const enterpriseId = optionalString(credential.enterpriseId);
	return {
		Authorization: `Bearer ${credentialString(credential, "access")}`,
		"x-domain": domain,
		Connection: "close",
		...uid ? { "x-user-id": uid } : {},
		...enterpriseId ? {
			"x-enterprise-id": enterpriseId,
			"x-tenant-id": enterpriseId
		} : {},
		...X_STAINLESS_HEADERS,
		"x-product": productEnvironment === "cloudhosted" ? "Cloud-Hosted" : productEnvironment === "selfhosted" ? "Self-Hosted" : "SaaS",
		"User-Agent": `CLI/${runtime.pluginVersion} CodeBuddy/${runtime.pluginVersion}`
	};
}
function cloudConfigUrl(siteRoot, repos) {
	const url = new URL(joinUrl(siteRoot, PATHS.productConfig));
	for (const repo of repos) url.searchParams.append("repos[]", repo);
	return url.toString();
}
function extractCloudProductConfig(payload) {
	throwBusinessError(payload);
	const data = extractData(payload);
	const hasModels = Object.prototype.hasOwnProperty.call(data, "models");
	const hasAgents = Object.prototype.hasOwnProperty.call(data, "agents");
	if (hasModels && !Array.isArray(data.models)) throw new Error("CodeBuddy Cloud Product 响应的 models 不是数组");
	if (hasAgents && !Array.isArray(data.agents)) throw new Error("CodeBuddy Cloud Product 响应的 agents 不是数组");
	return {
		...hasModels ? { models: data.models } : {},
		...hasAgents ? { agents: data.agents } : {}
	};
}
function cloudConfigDiagnosticSummary(payload) {
	const data = extractData(payload);
	const models = Array.isArray(data.models) ? data.models : [];
	const agents = Array.isArray(data.agents) ? data.agents : [];
	return {
		dataKeys: Object.keys(data).sort(),
		modelCount: models.length,
		models: models.slice(0, 100).map((entry) => {
			const model = asRecord(entry);
			return {
				id: optionalString(model?.id),
				name: optionalString(model?.name),
				maxInputTokens: optionalNumber(model?.maxInputTokens),
				maxOutputTokens: optionalNumber(model?.maxOutputTokens),
				supportsImages: model?.supportsImages,
				supportsReasoning: model?.supportsReasoning,
				onlyReasoning: model?.onlyReasoning,
				tags: Array.isArray(model?.tags) ? model.tags : void 0,
				hasUrl: Boolean(optionalString(model?.url))
			};
		}),
		agentCount: agents.length,
		agents: agents.slice(0, 100).map((entry) => {
			const agent = asRecord(entry);
			return {
				name: optionalString(agent?.name),
				models: Array.isArray(agent?.models) ? agent.models : void 0,
				modelTags: Array.isArray(agent?.modelTags) ? agent.modelTags : void 0,
				tags: Array.isArray(agent?.tags) ? agent.tags : void 0
			};
		})
	};
}
function enterpriseModelsPath(enterpriseId) {
	return `${PATHS.enterpriseModels}/${encodeURIComponent(enterpriseId)}/config/models`;
}
/**
* Axios reads this endpoint as `response.data.data`: on the wire that normally
* means `{ data: Model[] }`. An empty array is valid and tells the official CLI
* to keep its static product.json catalog; a missing/non-array data field is a
* parse failure.
*/
function extractEnterpriseModels(payload) {
	throwBusinessError(payload);
	const root = asRecord(payload);
	if (!root) throw new Error("CodeBuddy 企业模型接口返回了无法识别的响应");
	const direct = root.data;
	const nested = asRecord(direct)?.data;
	const models = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : void 0;
	if (!models) throw new Error("CodeBuddy 企业模型接口响应缺少 data 数组");
	return models;
}
function modelsForSite(siteRoot, productEnvironment, cloudConfig = {}, enterpriseEntries = []) {
	if (cloudConfig.models === void 0 && cloudConfig.agents === void 0 && enterpriseEntries.length === 0 && productEnvironment === "external" && normalizeSiteRoot(siteRoot) === "https://www.codebuddy.ai") return {
		models: BUILTIN_MODELS,
		identifiedCloudCount: 0,
		identifiedEnterpriseCount: 0,
		appliedEnterpriseCount: 0
	};
	const staticCliConfigs = productModelConfigsFor(productEnvironment);
	const staticPool = productModelPoolConfigsFor(productEnvironment);
	const staticById = new Map(staticPool.map((entry) => [entry.id, entry]));
	let identifiedCloudCount = 0;
	let productEntries;
	if (cloudConfig.models === void 0) productEntries = staticPool.map((entry) => ({ ...entry }));
	else {
		productEntries = [];
		for (const entry of cloudConfig.models) {
			const record = asRecord(entry);
			const id = optionalString(record?.id);
			if (!record || !id) continue;
			identifiedCloudCount += 1;
			productEntries.push({
				...staticById.get(id) ?? {},
				...record,
				id
			});
		}
		if (cloudConfig.models.length > 0 && identifiedCloudCount === 0) throw new Error("CodeBuddy Cloud Product models 没有带 id 的条目");
	}
	let cliModelIds = staticCliConfigs.map((entry) => entry.id);
	const cloudAgents = cloudConfig.agents ?? [];
	const getAgentModels = (name) => {
		const agent = cloudAgents.map(asRecord).find((entry) => entry?.name === name);
		if (!agent || !Object.prototype.hasOwnProperty.call(agent, "models")) return;
		if (!Array.isArray(agent.models)) throw new Error(`CodeBuddy Cloud Product agent ${name} 的 models 不是数组`);
		return agent.models.filter((modelId) => typeof modelId === "string" && Boolean(modelId.trim()));
	};
	const remoteCliModels = getAgentModels("cli");
	if (remoteCliModels !== void 0) cliModelIds = [...remoteCliModels];
	const craftModels = getAgentModels("craft") ?? [];
	for (const id of craftModels) if (!cliModelIds.includes(id)) cliModelIds.push(id);
	const productIndexById = /* @__PURE__ */ new Map();
	productEntries.forEach((entry, index) => {
		const id = optionalString(entry.id);
		if (id) productIndexById.set(id, index);
	});
	let identifiedEnterpriseCount = 0;
	let appliedEnterpriseCount = 0;
	for (const entry of enterpriseEntries) {
		const record = asRecord(entry);
		const id = optionalString(record?.id);
		if (!record || !id) continue;
		identifiedEnterpriseCount += 1;
		const index = productIndexById.get(id);
		if (index === void 0) {
			productIndexById.set(id, productEntries.length);
			productEntries.push({
				...record,
				id
			});
		} else productEntries[index] = {
			...productEntries[index],
			...record,
			id
		};
		appliedEnterpriseCount += 1;
		if ((Array.isArray(record.tags) ? record.tags : []).includes("chat") && !cliModelIds.includes(id)) cliModelIds.unshift(id);
	}
	if (enterpriseEntries.length > 0 && identifiedEnterpriseCount === 0) throw new Error("CodeBuddy 企业模型接口没有带 id 的模型条目");
	const productById = /* @__PURE__ */ new Map();
	for (const entry of productEntries) {
		const id = optionalString(entry.id);
		if (id) productById.set(id, entry);
	}
	const visibleEntries = [];
	const visibleIds = /* @__PURE__ */ new Set();
	for (const id of cliModelIds) {
		const entry = productById.get(id);
		if (entry && !visibleIds.has(id)) {
			visibleEntries.push(entry);
			visibleIds.add(id);
		}
	}
	for (const entry of productEntries) {
		const id = optionalString(entry.id);
		const tags = Array.isArray(entry.tags) ? entry.tags : [];
		if (id && tags.includes("chat") && !visibleIds.has(id)) {
			visibleEntries.push(entry);
			visibleIds.add(id);
		}
	}
	const models = visibleEntries.map((entry) => toPiModel(entry, siteRoot)).filter((model) => model !== void 0);
	if (models.length === 0) throw new Error("CodeBuddy 合并后的 cli 模型清单为空");
	return {
		models,
		identifiedCloudCount,
		identifiedEnterpriseCount,
		appliedEnterpriseCount
	};
}
/**
* Reproduce CodeBuddy Code 2.125.0's model pipeline: bundled product catalog,
* CloudProductProvider `/v3/config`, and (for Enterprise Domain accounts) the
* dedicated `/console/enterprises/{enterpriseId}/config/models` overlay.
* Network/parse failures throw so pi-ai keeps the last successful catalog.
*/
async function fetchCodeBuddyModels(context, options = {}) {
	const runtime = makeRuntime(options);
	const credential = context.credential;
	const credentialMetadata = asRecord(credential);
	const metadataBaseUrl = optionalString(credentialMetadata?.baseUrl);
	let metadataDomain = optionalString(credentialMetadata?.domain);
	if (!metadataDomain && metadataBaseUrl) try {
		metadataDomain = new URL(metadataBaseUrl).host;
	} catch {}
	const productEnvironment = metadataDomain ? resolveCodeBuddyProductEnvironment(metadataDomain) : "external";
	emitDiagnostic(runtime, "models.refresh.start", {
		allowNetwork: context.allowNetwork,
		credentialType: credential?.type ?? "missing",
		accountType: optionalString(credentialMetadata?.accountType),
		hasEnterpriseId: Boolean(optionalString(credentialMetadata?.enterpriseId)),
		baseUrlHostFingerprint: urlHostFingerprint(optionalString(credentialMetadata?.baseUrl)),
		domainFingerprint: identifierFingerprint(optionalString(credentialMetadata?.domain)),
		uidFingerprint: identifierFingerprint(optionalString(credentialMetadata?.uid)),
		enterpriseIdFingerprint: identifierFingerprint(optionalString(credentialMetadata?.enterpriseId)),
		productEnvironment,
		productEnvironmentOverride: envText("PI_CODEBUDDY_PRODUCT_ENV")
	});
	if (!context.allowNetwork) {
		const models = credential?.type === "oauth" ? modelsForSite(normalizeSiteRoot(credentialString(credential, "baseUrl")), productEnvironment).models : BUILTIN_MODELS;
		emitDiagnostic(runtime, "models.refresh.baseline", {
			reason: "network_disabled",
			productEnvironment,
			modelCount: models.length
		});
		return models;
	}
	if (credential?.type !== "oauth") {
		emitDiagnostic(runtime, "models.refresh.baseline", {
			reason: credential ? "non_oauth_credential" : "missing_credential",
			modelCount: BUILTIN_MODELS.length
		});
		return BUILTIN_MODELS;
	}
	const siteRoot = normalizeSiteRoot(credentialString(credential, "baseUrl"));
	const domain = optionalString(credential.domain) ?? new URL(siteRoot).host;
	const enterpriseId = optionalString(credential.enterpriseId);
	const headers = configHeaders(credential, domain, runtime, productEnvironment);
	const cloudUrl = cloudConfigUrl(siteRoot, runtime.cloudConfigRepos);
	emitDiagnostic(runtime, "models.cloud_config.request", {
		method: "GET",
		path: PATHS.productConfig,
		productEnvironment,
		xProduct: headers["x-product"],
		headerNames: Object.keys(headers).sort(),
		automaticGitCollection: false,
		explicitReposCount: runtime.cloudConfigRepos.length,
		reposQueryOmitted: runtime.cloudConfigRepos.length === 0
	});
	let cloudConfig;
	try {
		const cloudPayload = await fetchJson(runtime, cloudUrl, {
			method: "GET",
			headers,
			signal: context.signal
		}, 0, "models.cloud_config");
		cloudConfig = extractCloudProductConfig(cloudPayload);
		if (runtime.probeCloudConfig) emitDiagnostic(runtime, "models.cloud_config.probe.summary", cloudConfigDiagnosticSummary(cloudPayload));
		emitDiagnostic(runtime, "models.cloud_config.success", {
			productEnvironment,
			hasModelsOverride: cloudConfig.models !== void 0,
			modelResponseCount: cloudConfig.models?.length ?? 0,
			hasAgentsOverride: cloudConfig.agents !== void 0,
			agentResponseCount: cloudConfig.agents?.length ?? 0
		});
	} catch (error) {
		emitDiagnostic(runtime, "models.cloud_config.error", {
			errorName: error instanceof Error ? error.name : typeof error,
			errorMessage: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
	if (!enterpriseId) {
		const { models, identifiedCloudCount } = modelsForSite(siteRoot, productEnvironment, cloudConfig);
		emitDiagnostic(runtime, "models.refresh.success", {
			accountType: "personal",
			productEnvironment,
			modelCount: models.length,
			identifiedCloudCount,
			source: cloudConfig.models === void 0 && cloudConfig.agents === void 0 ? productConfigFileName(productEnvironment) : `${productConfigFileName(productEnvironment)}+/v3/config`
		});
		return models;
	}
	const path = enterpriseModelsPath(enterpriseId);
	emitDiagnostic(runtime, "models.enterprise.request", {
		method: "GET",
		path: path.replace(encodeURIComponent(enterpriseId), "<redacted>"),
		siteHostFingerprint: urlHostFingerprint(siteRoot),
		domainMatchesSiteHost: domain === new URL(siteRoot).host,
		productEnvironment,
		xProduct: headers["x-product"],
		headerNames: Object.keys(headers).sort()
	});
	try {
		const enterpriseEntries = extractEnterpriseModels(await fetchJson(runtime, joinUrl(siteRoot, path), {
			method: "GET",
			headers,
			signal: context.signal
		}, 0, "models.enterprise"));
		const { models, identifiedCloudCount, identifiedEnterpriseCount, appliedEnterpriseCount } = modelsForSite(siteRoot, productEnvironment, cloudConfig, enterpriseEntries);
		if (enterpriseEntries.length === 0) emitDiagnostic(runtime, "models.enterprise.empty_fallback", {
			reason: cloudConfig.models === void 0 && cloudConfig.agents === void 0 ? "official_static_product_fallback" : "cloud_product_fallback",
			productEnvironment,
			modelCount: models.length
		});
		emitDiagnostic(runtime, "models.enterprise.success", {
			modelCount: models.length,
			cloudModelResponseCount: cloudConfig.models?.length ?? 0,
			cloudAgentResponseCount: cloudConfig.agents?.length ?? 0,
			identifiedCloudCount,
			enterpriseResponseCount: enterpriseEntries.length,
			identifiedEnterpriseCount,
			appliedEnterpriseCount,
			productEnvironment,
			source: [
				productConfigFileName(productEnvironment),
				cloudConfig.models !== void 0 || cloudConfig.agents !== void 0 ? "/v3/config" : void 0,
				enterpriseEntries.length > 0 ? "enterprise-smart-merge" : void 0
			].filter(Boolean).join("+"),
			models: models.slice(0, 50).map((model) => ({
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				input: model.input,
				reasoning: model.reasoning,
				baseUrlHostFingerprint: urlHostFingerprint(model.baseUrl)
			}))
		});
		return models;
	} catch (error) {
		emitDiagnostic(runtime, "models.enterprise.error", {
			errorName: error instanceof Error ? error.name : typeof error,
			errorMessage: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
}
function createCodeBuddyProvider(options = {}) {
	const oauth = createCodeBuddyOAuth(options);
	const provider = createProvider({
		id: PROVIDER_ID,
		name: "CodeBuddy",
		baseUrl: joinUrl(DEFAULT_SITE_ROOT, PATHS.apiBase),
		api: codeBuddyCompletionsApi(),
		models: [],
		fetchModels: (context) => fetchCodeBuddyModels(context, options),
		auth: { oauth: {
			name: "CodeBuddy",
			login: oauth.login,
			refresh: oauth.refresh,
			toAuth: oauth.toAuth
		} }
	});
	const getDiscoveredModels = provider.getModels;
	return {
		...provider,
		getModels: () => {
			const models = getDiscoveredModels();
			return models.length > 0 ? models : BUILTIN_MODELS;
		}
	};
}
//#endregion
//#region src/adapter.ts
const EFFORTS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
].map((level) => ({
	id: ReasoningEffortId(level),
	name: level === "off" ? "Off" : level[0].toUpperCase() + level.slice(1)
}));
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name,
		inputModalities: ["text"]
	};
}
function textFrom(blocks) {
	return blocks.flatMap((block) => {
		if (block.type === "text" || block.type === "reasoning") return [block.text];
		if (block.type === "tool-result") return [textFrom(block.content)];
		return [];
	}).join("\n");
}
function toPiContext(options) {
	const messages = [];
	const toolNames = /* @__PURE__ */ new Map();
	for (const message of options.messages) {
		if (message.role === "user") {
			for (const block of message.content) if (block.type === "tool-result") messages.push({
				role: "toolResult",
				toolCallId: String(block.toolCallId),
				toolName: toolNames.get(String(block.toolCallId)) ?? "",
				content: [{
					type: "text",
					text: textFrom(block.content)
				}],
				isError: block.isError ?? false,
				timestamp: Date.now()
			});
			const text = message.content.filter((block) => block.type !== "tool-result").flatMap((block) => block.type === "text" || block.type === "reasoning" ? [block.text] : []).join("\n");
			if (text.length > 0) messages.push({
				role: "user",
				content: text,
				timestamp: Date.now()
			});
			continue;
		}
		if (message.role === "assistant") {
			const content = [];
			for (const block of message.content) {
				if (block.type === "text") content.push({
					type: "text",
					text: block.text
				});
				if (block.type === "reasoning") content.push({
					type: "thinking",
					thinking: block.text
				});
				if (block.type === "tool-call") {
					let args = {};
					try {
						args = JSON.parse(block.arguments);
					} catch {}
					content.push({
						type: "toolCall",
						id: String(block.id),
						name: block.name,
						arguments: args
					});
					toolNames.set(String(block.id), block.name);
				}
			}
			messages.push({
				role: "assistant",
				content,
				api: "openai-completions",
				provider: "codebuddy",
				model: options.model,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0
					}
				},
				stopReason: "stop",
				timestamp: Date.now()
			});
		}
	}
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	return {
		systemPrompt: options.system,
		messages,
		tools
	};
}
function finishReason(reason) {
	if (reason === "length") return {
		type: "finish",
		reason: { kind: "max-tokens" }
	};
	if (reason === "toolUse") return {
		type: "finish",
		reason: { kind: "tool-calls" }
	};
	return {
		type: "finish",
		reason: { kind: "stop" }
	};
}
var CodeBuddyAdapter = class extends LlmAdapter {
	models;
	constructor(models) {
		super();
		this.models = models;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "CodeBuddy"
		};
	}
	async listModels(provider) {
		await this.models.refresh({ allowNetwork: true });
		return this.models.getModels("codebuddy").map((model) => modelInfo(provider, model));
	}
	async resolveModel(provider, id, signal) {
		await this.models.refresh({
			allowNetwork: true,
			signal
		});
		const model = this.models.getModel("codebuddy", id);
		if (model === void 0) return {
			provider,
			id,
			name: id,
			inputModalities: ["text"]
		};
		return {
			...modelInfo(provider, model),
			context: { contextWindow: model.contextWindow },
			defaultMaxTokens: model.maxTokens,
			...model.reasoning ? { reasoning: {
				efforts: EFFORTS,
				defaultEffort: ReasoningEffortId("high")
			} } : {}
		};
	}
	async *stream(options) {
		if (options.stop?.length) throw new LlmError("CodeBuddy adapter does not support stop sequences", "UNSUPPORTED");
		await this.models.refresh({
			allowNetwork: true,
			signal: options.signal
		});
		const model = this.models.getModel("codebuddy", options.model);
		if (model === void 0) throw new LlmError(`CodeBuddy model "${options.model}" is not available`, "MODEL_NOT_FOUND");
		const open = /* @__PURE__ */ new Map();
		const stream = this.models.streamSimple(model, toPiContext(options), {
			temperature: options.temperature,
			maxTokens: options.maxTokens,
			reasoning: options.reasoningEffort,
			signal: options.signal,
			sessionId: options.sessionId === void 0 ? void 0 : String(options.sessionId),
			headers: { "User-Agent": `CLI/2.125.0 CodeBuddy/2.125.0 ${attributionHeaders()["user-agent"]}` }
		});
		for await (const event of stream) if (event.type === "text_start") {
			open.set(event.contentIndex, {
				kind: "text",
				text: ""
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
		} else if (event.type === "text_delta") {
			const state = open.get(event.contentIndex);
			if (state) state.text += event.delta;
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
		} else if (event.type === "thinking_start") {
			open.set(event.contentIndex, {
				kind: "reasoning",
				text: ""
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
		} else if (event.type === "thinking_delta") {
			const state = open.get(event.contentIndex);
			if (state) state.text += event.delta;
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
		} else if (event.type === "toolcall_start") {
			open.set(event.contentIndex, {
				kind: "tool-call",
				text: ""
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
		} else if (event.type === "toolcall_delta") {
			const state = open.get(event.contentIndex);
			if (state) state.text += event.delta;
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id : "";
			const name = partial?.type === "toolCall" ? partial.name : void 0;
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: ToolCallId(id),
				name,
				argumentsDelta: event.delta
			};
		} else if (event.type === "text_end") yield {
			type: "block-end",
			index: event.contentIndex,
			block: {
				type: "text",
				text: event.content
			}
		};
		else if (event.type === "thinking_end") yield {
			type: "block-end",
			index: event.contentIndex,
			block: {
				type: "reasoning",
				text: event.content
			}
		};
		else if (event.type === "toolcall_end") yield {
			type: "block-end",
			index: event.contentIndex,
			block: {
				type: "tool-call",
				id: ToolCallId(event.toolCall.id),
				name: event.toolCall.name,
				arguments: JSON.stringify(event.toolCall.arguments)
			}
		};
		else if (event.type === "done") {
			if (event.reason === "deferred") throw new LlmError("CodeBuddy returned a deferred tool response, which DSH cannot consume", "UNSUPPORTED");
			yield {
				type: "usage",
				usage: {
					inputTokens: event.message.usage.input,
					outputTokens: event.message.usage.output,
					cacheReadTokens: event.message.usage.cacheRead,
					cacheWriteTokens: event.message.usage.cacheWrite,
					...event.message.usage.reasoning === void 0 ? {} : { reasoningTokens: event.message.usage.reasoning }
				}
			};
			yield finishReason(event.reason);
		} else if (event.type === "error") throw new LlmError(event.error.errorMessage ?? "CodeBuddy request failed", event.reason === "aborted" ? "ABORTED" : "PROVIDER_ERROR");
	}
};
//#endregion
//#region src/credential-store.ts
var DshCredentialStore = class {
	chain = Promise.resolve();
	credentials;
	ref;
	constructor(credentials, ref) {
		this.credentials = credentials;
		this.ref = ref;
	}
	async read(providerId) {
		if (providerId !== "codebuddy") return void 0;
		const found = await this.credentials.resolve(this.ref);
		if (found === void 0) return void 0;
		try {
			return JSON.parse(found.value);
		} catch (cause) {
			throw new Error(`CodeBuddy credential stored at ${this.ref} is invalid JSON; run /codebuddy-logout and log in again`, { cause });
		}
	}
	async list() {
		const credential = await this.read("codebuddy");
		return credential === void 0 ? [] : [{
			providerId: "codebuddy",
			type: credential.type
		}];
	}
	modify(providerId, fn) {
		if (providerId !== "codebuddy") return Promise.resolve(void 0);
		const operation = this.chain.then(async () => {
			const next = await fn(await this.read(providerId));
			if (next !== void 0) await this.credentials.set(this.ref, JSON.stringify(next));
			return next;
		});
		this.chain = operation.catch(() => void 0);
		return operation;
	}
	async delete(providerId) {
		if (providerId !== "codebuddy") return;
		const operation = this.chain.then(() => this.credentials.unset(this.ref));
		this.chain = operation.catch(() => void 0);
		await operation;
	}
};
//#endregion
//#region src/login.ts
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function abortError(signal) {
	if (signal.reason instanceof Error) return signal.reason;
	return /* @__PURE__ */ new Error("CodeBuddy 登录已取消");
}
function waitWithSignal(promise, signal) {
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(abortError(signal));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			cleanup();
			resolve(value);
		}, (error) => {
			cleanup();
			reject(error);
		});
	});
}
var CodeBuddyLoginManager = class {
	active;
	logger;
	models;
	provider;
	registration;
	constructor(models, registration, logger, provider) {
		this.models = models;
		this.registration = registration;
		this.logger = logger;
		this.provider = provider;
	}
	pending() {
		if (this.active === void 0) return void 0;
		return {
			authorizationUrl: this.active.authorizationUrl,
			site: this.active.site
		};
	}
	async start(site, signal) {
		const reused = this.active !== void 0;
		const active = this.active ?? this.create(site);
		try {
			return {
				authorizationUrl: active.authorizationUrl ?? await waitWithSignal(active.authorizationUrlPromise, signal),
				completion: active.completion,
				reused
			};
		} catch (error) {
			if (!reused && signal.aborted) await this.cancel();
			throw error;
		}
	}
	async cancel() {
		const active = this.active;
		if (active === void 0) return;
		active.controller.abort(/* @__PURE__ */ new Error("CodeBuddy 登录已取消"));
		await active.completion;
	}
	create(site) {
		const controller = new AbortController();
		let resolveAuthorizationUrl;
		let rejectAuthorizationUrl;
		const authorizationUrlPromise = new Promise((resolve, reject) => {
			resolveAuthorizationUrl = resolve;
			rejectAuthorizationUrl = reject;
		});
		authorizationUrlPromise.catch(() => {});
		const active = {
			authorizationUrlPromise,
			completion: Promise.resolve(),
			controller,
			rejectAuthorizationUrl,
			resolveAuthorizationUrl,
			site
		};
		this.active = active;
		const interaction = {
			signal: controller.signal,
			prompt: async () => site,
			notify: (event) => {
				if (event.type !== "auth_url" || active.authorizationUrl !== void 0) return;
				active.authorizationUrl = event.url;
				active.resolveAuthorizationUrl(event.url);
				this.logger.info("CodeBuddy authorization URL: %s", event.url);
			}
		};
		active.completion = this.complete(active, interaction);
		return active;
	}
	async complete(active, interaction) {
		try {
			const credential = await this.models.login(this.provider, "oauth", interaction);
			if (active.authorizationUrl === void 0) throw new Error("CodeBuddy 登录未返回授权 URL");
			const refreshError = (await this.models.refresh({
				allowNetwork: true,
				force: true,
				signal: active.controller.signal
			})).errors.get(this.provider);
			if (refreshError !== void 0) throw refreshError;
			this.registration.replace([this.provider]);
			const available = this.models.getModels(this.provider);
			const baseUrl = credential.type === "oauth" ? credential.baseUrl ?? active.site : active.site;
			this.logger.info("CodeBuddy login succeeded (%s); loaded %d models", String(baseUrl), available.length);
		} catch (error) {
			if (active.authorizationUrl === void 0) active.rejectAuthorizationUrl(error);
			if (active.controller.signal.aborted) this.logger.info("CodeBuddy login cancelled");
			else this.logger.error("CodeBuddy login failed: %s", errorMessage(error));
		} finally {
			if (this.active === active) this.active = void 0;
		}
	}
};
function authorizationUrlText(url, reused) {
	return `${reused ? "CodeBuddy 正在等待授权。" : "请点击下面的链接完成 CodeBuddy 授权："}\n${url}\n\n授权完成后会自动保存登录状态；可运行 /codebuddy-status 查看结果。`;
}
//#endregion
//#region src/index.ts
const name = "llm-codebuddy";
const inject = [
	"llm",
	"commands",
	"credentials"
];
const PROVIDER = "codebuddy";
const CREDENTIAL_REF = credentialRef("CODEBUDDY_OAUTH");
function normalizeSite(raw) {
	const site = raw.trim().toLowerCase();
	if (site === "" || site === "global" || site === "intl") return DEFAULT_SITE_ROOT;
	if (site === "cn" || site === "china") return "https://copilot.tencent.com";
	const url = new URL(raw.trim());
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("site must be cn, global, or an http(s) URL");
	return url.origin;
}
function apply(ctx) {
	const store = new DshCredentialStore(ctx.credentials, CREDENTIAL_REF);
	const models = createModels({ credentials: store });
	models.setProvider(createCodeBuddyProvider());
	const registration = ctx.llm.registerAdapter([PROVIDER], new CodeBuddyAdapter(models));
	const loginManager = new CodeBuddyLoginManager(models, registration, ctx.logger, PROVIDER);
	ctx.commands.register({
		name: "codebuddy-login",
		description: "登录 CodeBuddy 并加载可用模型",
		input: { hint: "[cn|global|site URL]" },
		handler: async ({ rawInput, signal }) => {
			const site = normalizeSite(rawInput);
			const login = await loginManager.start(site, signal);
			return {
				kind: "success",
				text: authorizationUrlText(login.authorizationUrl, login.reused)
			};
		}
	});
	ctx.commands.register({
		name: "codebuddy-status",
		description: "查看 CodeBuddy 登录状态和模型列表",
		handler: async ({ signal }) => {
			const pending = loginManager.pending();
			if (pending !== void 0) return {
				kind: "success",
				text: pending.authorizationUrl === void 0 ? "CodeBuddy 正在生成授权链接，请稍后再次查看。" : authorizationUrlText(pending.authorizationUrl, true)
			};
			if (await store.read("codebuddy") === void 0) return {
				kind: "success",
				text: "CodeBuddy 未登录。运行 /codebuddy-login cn 或 /codebuddy-login global。"
			};
			const error = (await models.refresh({
				allowNetwork: true,
				signal
			})).errors.get(PROVIDER);
			if (error !== void 0) return {
				kind: "error",
				text: error.message
			};
			const available = models.getModels(PROVIDER);
			return {
				kind: "success",
				text: `CodeBuddy 已登录，${available.length} 个模型可用：\n${available.map((model) => `- ${model.name} (${model.id})`).join("\n")}`
			};
		}
	});
	ctx.commands.register({
		name: "codebuddy-logout",
		description: "退出 CodeBuddy 并移除本地凭据",
		handler: async () => {
			await loginManager.cancel();
			await models.logout(PROVIDER);
			registration.replace([PROVIDER]);
			return {
				kind: "success",
				text: "CodeBuddy 已退出。"
			};
		}
	});
}
//#endregion
export { CREDENTIAL_REF, PROVIDER, apply, inject, name };
