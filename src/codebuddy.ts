import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Credential,
  type Model,
  type ModelAuth,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
  type ProviderStreams,
  type RefreshModelsContext,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

export const PROVIDER_ID = "codebuddy";
export const DEFAULT_SITE_ROOT = "https://www.codebuddy.ai";

export const PATHS = {
  authState: "/v2/plugin/auth/state",
  authToken: "/v2/plugin/auth/token",
  refreshToken: "/v2/plugin/auth/token/refresh",
  loginAccount: "/v2/plugin/login/account",
  productConfig: "/v3/config",
  enterpriseModels: "/console/enterprises",
  apiBase: "/v2",
} as const;

export const BUSINESS_CODES = {
  retryFetchToken: 11217,
  retryFetchAccount: 12151,
  licenseSeatLimit: 12005,
  licenseExpired: 11212,
  trialExpired: 11216,
} as const;

export const POLL_INTERVAL_MS = 1_000;
export const POLL_TIMEOUT_MS = 300_000;
export const EXPIRES_SAFETY_MARGIN_MS = 300_000;
export const NETWORK_RETRY_DELAYS_MS = [250, 750] as const;

/**
 * Verified against the international auth/state endpoint on 2026-07-22.
 * Override with PI_CODEBUDDY_PLATFORM if another deployment expects a
 * different product platform value.
 */
export const PLATFORM = process.env.PI_CODEBUDDY_PLATFORM?.trim() || "codebuddy";

/** Version of the CLI bundle used by the reverse-engineering reference. */
export const PLUGIN_VERSION = "2.125.0";

export const X_NO_HEADERS = {
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
} as const;

export const X_STAINLESS_HEADERS = {
  "User-Agent": `CLI/${PLUGIN_VERSION} CodeBuddy/${PLUGIN_VERSION}`,
  "x-stainless-lang": "js",
  "x-stainless-package-version": "6.25.0",
  "x-stainless-os": "Windows",
  "x-stainless-arch": "x64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": `v${process.versions.node}`,
  "x-stainless-retry-count": "0",
  "Content-Type": "application/json",
  Accept: "application/json",
} as const;

/**
 * CodeBuddy Code 2.125.0 的实测网关要求 OpenAI body 之外的 envelope 字段
 * （最简 OpenAI 请求会被 HTTP 400 拒绝，抓包会话 019f88d0/019f88fb）。
 * 默认对齐抓包值以保证真实网关可用，但每一项都可用环境变量覆盖或关闭，
 * 便于适配不同部署或不支持某字段的模型。
 */
export interface EnvelopeConfig {
  /** 总开关；false 时完全不加工 body（纯 OpenAI）。PI_CODEBUDDY_ENVELOPE=off */
  enabled: boolean;
  /** 逐条 user message 附加的 agent 标记（并把 string content 拍平为数组）；undefined 不加。PI_CODEBUDDY_AGENT_TAG=off */
  agentTag?: string;
  /** 默认注入的 reasoning_effort（仅 model.reasoning=true 且调用方未指定时）；undefined 不加。PI_CODEBUDDY_REASONING_EFFORT=off */
  reasoningEffort?: string;
  /** 是否注入 stream_options.include_usage。PI_CODEBUDDY_STREAM_OPTIONS=off */
  streamOptions: boolean;
  /** 默认注入的 temperature（调用方未指定时）；undefined 不加。PI_CODEBUDDY_TEMPERATURE=off 或数值 */
  temperature?: number;
}

function envText(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envDisabled(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return (
    normalized === "off" ||
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no"
  );
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = envText(name);
  if (value === undefined) return fallback;
  return !envDisabled(value);
}

type DiagnosticDetails = Record<string, unknown>;
export type CodeBuddyDiagnosticSink = (
  event: string,
  details: DiagnosticDetails,
) => void;

const DIAGNOSTIC_BUILD = "authoritative-model-catalog-2026-07-23";
const DEBUG_STDERR = envFlag("PI_CODEBUDDY_DEBUG", false);
const DEBUG_LOG_PATH =
  envText("PI_CODEBUDDY_DEBUG_LOG") ??
  (DEBUG_STDERR ? resolve(process.cwd(), "pi-codebuddy-debug.jsonl") : undefined);

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/\/enterprises\/[^/\s]+/gi, "/enterprises/<redacted>")
    .replace(
      /([?&]repos(?:%5B%5D|\[\])?=)[^&\s]+/gi,
      "$1<redacted>",
    )
    .slice(0, 4_000);
}

function sanitizeDiagnosticValue(value: unknown, key = ""): unknown {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (
    [
      "access",
      "accesstoken",
      "refresh",
      "refreshtoken",
      "token",
      "secret",
      "authorization",
      "apikey",
    ].includes(normalizedKey)
  ) {
    return "<redacted>";
  }
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeDiagnosticValue(entry));
  }
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.entries(record).map(([name, entry]) => [
        name,
        sanitizeDiagnosticValue(entry, name),
      ]),
    );
  }
  return value;
}

function defaultDiagnosticSink(
  event: string,
  details: DiagnosticDetails,
): void {
  if (!DEBUG_STDERR && !DEBUG_LOG_PATH) return;
  const entry = {
    timestamp: new Date().toISOString(),
    build: DIAGNOSTIC_BUILD,
    event,
    details: sanitizeDiagnosticValue(details),
  };
  const line = JSON.stringify(entry);
  if (DEBUG_STDERR) console.error(`[pi-codebuddy] ${line}`);
  if (DEBUG_LOG_PATH) {
    try {
      appendFileSync(DEBUG_LOG_PATH, `${line}\n`, "utf8");
    } catch (error) {
      if (DEBUG_STDERR) {
        console.error(
          `[pi-codebuddy] unable to write diagnostic log: ${sanitizeDiagnosticText(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      }
    }
  }
}

function identifierFingerprint(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function urlHostFingerprint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return identifierFingerprint(new URL(value).host);
  } catch {
    return undefined;
  }
}

function diagnosticValueShape(value: unknown, depth = 0): unknown {
  if (depth >= 6) return { type: "max-depth" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      firstItem:
        value.length > 0
          ? diagnosticValueShape(value[0], depth + 1)
          : undefined,
    };
  }
  const record = asRecord(value);
  if (record) {
    const keys = Object.keys(record).sort().slice(0, 100);
    return {
      type: "object",
      keys,
      fields: Object.fromEntries(
        keys.map((name) => [
          name,
          diagnosticValueShape(record[name], depth + 1),
        ]),
      ),
    };
  }
  return { type: value === null ? "null" : typeof value };
}

function responseShape(payload: unknown): DiagnosticDetails {
  const root = asRecord(payload);
  if (!root) {
    return { type: Array.isArray(payload) ? "array" : typeof payload };
  }
  const direct = root.data;
  const nested = asRecord(direct)?.data;
  const models = Array.isArray(direct)
    ? direct
    : Array.isArray(nested)
      ? nested
      : undefined;
  return {
    type: "object",
    keys: Object.keys(root).sort(),
    code: root.code,
    message: root.msg ?? root.message,
    dataType: Array.isArray(direct)
      ? "array"
      : direct === null
        ? "null"
        : typeof direct,
    dataKeys: asRecord(direct) ? Object.keys(asRecord(direct)!).sort() : undefined,
    modelCount: models?.length,
    firstModelKeys: asRecord(models?.[0])
      ? Object.keys(asRecord(models?.[0])!).sort()
      : undefined,
    sampleModelIds: models
      ?.slice(0, 20)
      .map((entry) => optionalString(asRecord(entry)?.id))
      .filter((id): id is string => id !== undefined),
    structure: diagnosticValueShape(payload),
  };
}
/** Envelope 默认配置，从环境变量派生；抓包实测值为默认。 */
export const ENVELOPE: EnvelopeConfig = {
  enabled: envFlag("PI_CODEBUDDY_ENVELOPE", true),
  agentTag: (() => {
    const value = envText("PI_CODEBUDDY_AGENT_TAG");
    if (value === undefined) return "cli";
    return envDisabled(value) ? undefined : value;
  })(),
  reasoningEffort: (() => {
    const value = envText("PI_CODEBUDDY_REASONING_EFFORT");
    if (value === undefined) return "high";
    return envDisabled(value) ? undefined : value;
  })(),
  streamOptions: envFlag("PI_CODEBUDDY_STREAM_OPTIONS", true),
  temperature: (() => {
    const value = envText("PI_CODEBUDDY_TEMPERATURE");
    if (value === undefined) return 1;
    // Only the word forms disable it — "0" is a valid temperature, not "off".
    const lowered = value.toLowerCase();
    if (lowered === "off" || lowered === "false" || lowered === "no") {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 1;
  })(),
};

/**
 * 额外 CLI 请求头开关（x-ide-、x-conversation-、x-product 等，抓包实测）。
 * PI_CODEBUDDY_CLI_HEADERS=off 时回退到最简可用集
 * （x-domain + x-agent-intent + x-user-id/企业头 + x-stainless 系列）。
 */
export const SEND_CLI_HEADERS = envFlag("PI_CODEBUDDY_CLI_HEADERS", true);

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const MODEL_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  supportsStrictMode: true,
  maxTokensField: "max_tokens",
} as const;

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
    maxInputTokens: 176_000,
    maxOutputTokens: 24_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini-3.1-Pro",
    maxInputTokens: 400_000,
    maxOutputTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "gemini-3.0-flash",
    name: "Gemini-3.0-Flash",
    maxInputTokens: 400_000,
    maxOutputTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini-3.5-Flash",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
    supportsImages: true,
    supportsReasoning: true,
    onlyReasoning: true,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini-2.5-Pro",
    maxInputTokens: 400_000,
    maxOutputTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini-2.5-Flash",
    maxInputTokens: 400_000,
    maxOutputTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini-3.1-flash-lite",
    maxInputTokens: 200_000,
    maxOutputTokens: 65_536,
    supportsImages: true,
    supportsReasoning: true,
    onlyReasoning: true,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 72_000,
    supportsImages: true,
    supportsReasoning: true,
    onlyReasoning: true,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    maxInputTokens: 272_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3-Codex",
    maxInputTokens: 272_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "gpt-5.1-codex",
    name: "GPT-5.1-Codex",
    maxInputTokens: 272_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1-Codex-Mini",
    maxInputTokens: 272_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsReasoning: true,
  },
  {
    id: "deepseek-v3-2-volc",
    name: "DeepSeek-V3.2",
    maxInputTokens: 96_000,
    maxOutputTokens: 32_000,
    supportsImages: false,
    supportsReasoning: true,
    onlyReasoning: true,
  },
  {
    id: "glm-5.0",
    name: "GLM-5.0",
    maxInputTokens: 200_000,
    maxOutputTokens: 48_000,
    supportsImages: false,
    supportsReasoning: true,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi-K2.5",
    maxInputTokens: 164_000,
    maxOutputTokens: 32_000,
    supportsImages: true,
    supportsReasoning: true,
    onlyReasoning: true,
  },
] as const;

export type CodeBuddyProductEnvironment =
  | "external"
  | "internal"
  | "ioa"
  | "cloudhosted"
  | "selfhosted";

type ProductModelDefinition = readonly [
  id: string,
  name: string,
  maxInputTokens: number | undefined,
  maxOutputTokens: number | undefined,
  supportsImages: boolean | undefined,
  supportsReasoning: boolean | undefined,
  onlyReasoning?: boolean,
  tags?: readonly string[],
];

type ProductModelConfig = Record<string, unknown> & { id: string };

const ENVIRONMENT_MODEL_DEFINITIONS: Record<
  Exclude<CodeBuddyProductEnvironment, "external">,
  readonly ProductModelDefinition[]
> = {
  internal: [
    ["glm-5.2", "GLM-5.2", 1_000_000, 48_000, false, true, true],
    ["glm-5.1", "GLM-5.1", 200_000, 48_000, false, true, true],
    ["glm-5v-turbo", "GLM-5v-Turbo", 200_000, 64_000, true, true, true],
    ["minimax-m3", "MiniMax-M3", 512_000, 128_000, true, true, true],
    ["minimax-m2.7", "MiniMax-M2.7", 200_000, 48_000, true, true, true],
    ["kimi-k2.7", "Kimi-K2.7-Code", 256_000, 32_000, true, true, true],
    ["kimi-k2.6", "Kimi-K2.6", 256_000, 32_000, true, true, true],
    ["hy3-preview", "Hy3 preview", 192_000, 64_000, true, true, true],
    ["deepseek-v4-pro", "Deepseek-V4-Pro", 1_000_000, 50_000, true, true, true],
    ["deepseek-v4-flash", "Deepseek-V4-Flash", 1_000_000, 50_000, true, true, true],
    ["deepseek-v3-2-volc", "DeepSeek-V3.2", 96_000, 32_000, false, true, true],
  ],
  ioa: [
    ["claude-sonnet-5", "Claude-Sonnet-5", 200_000, 64_000, true, true],
    ["claude-sonnet-5-1m", "Claude-Sonnet-5-1M", 1_000_000, 128_000, true, true, false],
    ["claude-sonnet-4.6", "Claude-Sonnet-4.6", 176_000, 24_000, true, true],
    ["claude-sonnet-4.6-1m", "Claude-Sonnet-4.6-1M", 1_000_000, 24_000, true, true],
    ["claude-opus-4.8", "Claude-Opus-4.8", 176_000, 64_000, true, true],
    ["claude-opus-4.8-1m", "Claude-Opus-4.8-1M", 1_000_000, 128_000, true, true],
    ["claude-opus-4.7", "Claude-Opus-4.7", 176_000, 64_000, true, true],
    ["claude-opus-4.7-1m", "Claude-Opus-4.7-1M", 1_000_000, 128_000, true, true],
    ["claude-opus-4.6", "Claude-Opus-4.6", 176_000, 24_000, true, true],
    ["claude-opus-4.6-1m", "Claude-Opus-4.6-1M", 1_000_000, 64_000, true, true],
    ["claude-haiku-4.5", "Claude-Haiku-4.5", 176_000, 24_000, true, true],
    ["gemini-3.1-pro", "Gemini-3.1-Pro", 400_000, 64_000, true, true],
    ["gemini-3.5-flash", "Gemini-3.5-Flash", 1_000_000, 65_536, true, true, true],
    ["gemini-2.5-pro", "Gemini-2.5-Pro", 400_000, 64_000, true, true],
    ["gpt-5.5", "GPT-5.5", 1_000_000, 128_000, true, true, true],
    ["gpt-5.4", "GPT-5.4", 272_000, 128_000, true, true],
    ["gpt-5.3-codex", "GPT-5.3-Codex", 272_000, 128_000, true, true],
    ["gpt-5.1-codex", "GPT-5.1-Codex", 272_000, 128_000, true, true],
    ["gpt-5.1-codex-mini", "GPT-5.1-Codex-Mini", 272_000, 128_000, true, true],
    ["glm-5.2-ioa", "GLM-5.2", 1_000_000, 48_000, false, true, true],
    ["glm-5v-turbo-ioa", "GLM-5v-Turbo", 200_000, 38_000, true, true, true],
    ["minimax-m3-ioa", "MiniMax-M3", 512_000, 48_000, true, true, true],
    ["minimax-m2.7-ioa", "MiniMax-M2.7", 200_000, 48_000, true, true, true],
    ["minimax-m2.5-ioa", "MiniMax-M2.5", 200_000, 48_000, false, true, true],
    ["kimi-k2.7-ioa", "Kimi-K2.7-Code", 256_000, 32_000, true, true, true],
    ["kimi-k2.6-ioa", "Kimi-K2.6", 256_000, 32_000, true, true, true],
    ["hy3-preview-agent-ioa", "Hy3 preview", 192_000, 64_000, true, true, true],
    ["echo", "Echo", 238_000, 24_000, false, false],
    ["deepseek-v3-2-volc-ioa", "DeepSeek-V3.2", 96_000, 32_000, false, true, true],
    ["deepseek-v4-flash-ioa", "Deepseek-V4-Flash", 1_000_000, 50_000, true, true, true],
    ["deepseek-v4-pro-ioa", "Deepseek-V4-Pro", 1_000_000, 50_000, true, true, true],
  ],
  cloudhosted: [
    ["glm-4.7", "GLM-4.7", 200_000, 48_000, false, true],
    ["glm-4.6", "GLM-4.6", 168_000, 32_000, false, true],
    ["deepseek-v3-2-volc", "DeepSeek-V3.2", 96_000, 32_000, false, true, true],
    ["deepseek-v3.1", "DeepSeek-V3.1-Terminus", 128_000, 8_192, false, false],
    ["deepseek-v3-0324", "DeepSeek-V3", 128_000, 8_192, false, false],
  ],
  selfhosted: [
    ["codewise-chat", "Codewise-Chat", 128_000, 8_192, false, false],
  ],
};

/**
 * The Cloud-Hosted file contains a 24-entry global model pool but declares only
 * five of them on the `cli` agent. CloudProductProvider overlays remote model
 * entries on this full pool before AgentManager computes /model visibility.
 */
const CLOUDHOSTED_PRODUCT_MODEL_DEFINITIONS: readonly ProductModelDefinition[] = [
  ["default", "Default", 200_000, 24_000, false, false],
  ["deepseek-v3-2-volc", "DeepSeek-V3.2", 96_000, 32_000, false, true, true],
  ["glm-4.7", "GLM-4.7", 200_000, 48_000, false, true],
  ["glm-4.6", "GLM-4.6", 168_000, 32_000, false, true],
  ["deepseek-v3.1", "DeepSeek-V3.1-Terminus", 128_000, 8_192, false, false],
  ["hunyuan-chat", "Hunyuan-Turbos", 200_000, 8_192, false, false],
  ["deepseek-v3-0324", "DeepSeek-V3", 128_000, 8_192, false, false],
  ["kimi-k2-thinking", "Kimi-K2-Thinking", 164_000, 32_000, false, true, true],
  ["deepseek-v4-pro", "Deepseek-V4-Pro", 1_000_000, 50_000, true, true, true],
  ["deepseek-v4-flash", "Deepseek-V4-Flash", 1_000_000, 50_000, true, true, true],
  ["minimax-m2.5", "MiniMax-M2.5", 200_000, 48_000, false, true, true],
  ["minimax-m2.7", "MiniMax-M2.7", 200_000, 48_000, true, true, true],
  ["glm-5.1", "GLM-5.1", 200_000, 48_000, false, true, true],
  ["glm-5.0", "GLM-5.0", 200_000, 48_000, false, true],
  ["glm-5.0-turbo", "GLM-5.0-Turbo", 200_000, 48_000, false, true, true],
  ["glm-5v-turbo", "GLM-5v-Turbo", 200_000, 38_000, true, true, true],
  ["glm-4.6v", "GLM-4.6V", 128_000, 32_000, true, true],
  ["kimi-k2.6", "Kimi-K2.6", 256_000, 32_000, true, true, true],
  ["kimi-k2.5", "Kimi-K2.5", 164_000, 32_000, true, true, true],
  ["hy3-preview-agent", "Hy3 preview", 192_000, 64_000, true, true, true],
  ["auto", "Auto", 168_000, 32_000, true, false, false, ["craft"]],
  ["deepseek-v4-pro-exclusive", "Deepseek-V4-Pro", 1_000_000, 50_000, true, true, true],
  ["hunyuan-2.0-instruct", "Hunyuan-2.0-Instruct", 128_000, 16_000, true, true, true],
  ["hunyuan-image-v3.0", "Hunyuan Image V3", undefined, undefined, undefined, undefined, undefined, ["text-to-image"]],
];

const PRODUCT_DOMAIN_RULES: Record<
  Exclude<CodeBuddyProductEnvironment, "selfhosted">,
  readonly string[]
> = {
  internal: [
    "copilot.tencent.com",
    "staging-copilot.tencent.com",
    "www.codebuddy.cn",
    "staging.codebuddy.cn",
  ],
  ioa: [
    "tencent.sso.copilot.tencent.com",
    "tencent.sso.copilot-staging.tencent.com",
    "tencent.sso.codebuddy.cn",
    "tencent.staging-sso.codebuddy.cn",
  ],
  cloudhosted: [
    "*.sso.copilot.tencent.com",
    "*.sso.copilot-staging.tencent.com",
    "*.copilot.qq.com",
    "*.copilot-staging.qq.com",
    "*.sso.codebuddy.cn",
    "*.staging-sso.codebuddy.cn",
  ],
  external: ["www.codebuddy.ai", "staging-codebuddy.tencent.com"],
};

function normalizedDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
      .hostname;
  } catch {
    return trimmed.split(":", 1)[0];
  }
}

function domainMatches(pattern: string, domain: string): boolean {
  if (!pattern.startsWith("*.")) return pattern === domain;
  const suffix = pattern.slice(1);
  return domain.endsWith(suffix) && domain.length > suffix.length;
}

export function resolveCodeBuddyProductEnvironment(
  domain: string,
): CodeBuddyProductEnvironment {
  const override = envText("PI_CODEBUDDY_PRODUCT_ENV")?.toLowerCase();
  if (
    override === "external" ||
    override === "internal" ||
    override === "ioa" ||
    override === "cloudhosted" ||
    override === "selfhosted"
  ) {
    return override;
  }

  const normalized = normalizedDomain(domain);
  // Match the official CLI's order: exact iOA domains precede cloud wildcards.
  for (const environment of [
    "internal",
    "ioa",
    "cloudhosted",
    "external",
  ] as const) {
    if (
      PRODUCT_DOMAIN_RULES[environment].some((pattern) =>
        domainMatches(pattern, normalized),
      )
    ) {
      return environment;
    }
  }
  return "selfhosted";
}

function productModelConfigsFor(
  environment: CodeBuddyProductEnvironment,
): readonly ProductModelConfig[] {
  if (environment === "external") return EXTERNAL_CLI_MODEL_CONFIGS;
  return productDefinitionsToConfigs(ENVIRONMENT_MODEL_DEFINITIONS[environment]);
}

function productModelPoolConfigsFor(
  environment: CodeBuddyProductEnvironment,
): readonly ProductModelConfig[] {
  if (environment === "cloudhosted") {
    return productDefinitionsToConfigs(CLOUDHOSTED_PRODUCT_MODEL_DEFINITIONS);
  }
  return productModelConfigsFor(environment);
}

function productDefinitionsToConfigs(
  definitions: readonly ProductModelDefinition[],
): readonly ProductModelConfig[] {
  return definitions.map(
    ([
      id,
      name,
      maxInputTokens,
      maxOutputTokens,
      supportsImages,
      supportsReasoning,
      onlyReasoning,
      tags,
    ]) => ({
      id,
      name,
      maxInputTokens,
      maxOutputTokens,
      supportsImages,
      supportsReasoning,
      ...(onlyReasoning === undefined ? {} : { onlyReasoning }),
      ...(tags === undefined ? {} : { tags }),
    }),
  );
}

function productConfigFileName(
  environment: CodeBuddyProductEnvironment,
): string {
  return environment === "external"
    ? "product.json"
    : `product.${environment}.json`;
}

const DEFAULT_PRODUCT_ENVIRONMENT = resolveCodeBuddyProductEnvironment(
  new URL(DEFAULT_SITE_ROOT).host,
);

export const BUILTIN_MODELS: readonly Model<"openai-completions">[] =
  productModelConfigsFor(DEFAULT_PRODUCT_ENVIRONMENT).map((entry) => {
    const model = toPiModel(entry, DEFAULT_SITE_ROOT);
    if (!model) throw new Error(`Invalid built-in CodeBuddy model: ${entry.id}`);
    return model;
  });

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface CodeBuddyRuntimeOptions {
  /** Receives the actual source of a successfully discovered catalog. */
  onCatalogSource?: (source: string) => void;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: Sleep;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  expiresSafetyMarginMs?: number;
  platform?: string;
  pluginVersion?: string;
  conversationRequestId?: () => string;
  /** Send the extra CLI request headers (defaults to SEND_CLI_HEADERS). */
  sendCliHeaders?: boolean;
  /** Optional local diagnostic sink. Values are sanitized before the default sink writes them. */
  debug?: CodeBuddyDiagnosticSink;
  /** Emit the detailed /v3/config response summary used by the diagnostic logger. */
  probeCloudConfig?: boolean;
  /**
   * Explicit repository URLs for CodeBuddy's optional /v3/config `repos[]`
   * query. The extension never reads git; callers must opt in and supply these.
   */
  cloudConfigRepos?: readonly string[];
}

interface Runtime {
  onCatalogSource?: (source: string) => void;
  fetch: FetchLike;
  now: () => number;
  sleep: Sleep;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  expiresSafetyMarginMs: number;
  platform: string;
  pluginVersion: string;
  conversationRequestId: () => string;
  sendCliHeaders: boolean;
  debug?: CodeBuddyDiagnosticSink;
  probeCloudConfig: boolean;
  cloudConfigRepos: readonly string[];
}

interface AuthData {
  accessToken: string;
  refreshToken: string;
  domain?: string;
  expiresAt?: number;
  expiresIn?: number;
}

interface AccountData {
  uid?: string;
  type?: string;
  enterpriseId?: string;
  departmentFullName?: string;
}

interface BusinessError {
  code: number;
  message?: string;
}

const defaultSleep: Sleep = (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
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

function makeRuntime(options: CodeBuddyRuntimeOptions = {}): Runtime {
  return {
    onCatalogSource: options.onCatalogSource,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now: options.now ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
    pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
    pollTimeoutMs: options.pollTimeoutMs ?? POLL_TIMEOUT_MS,
    expiresSafetyMarginMs:
      options.expiresSafetyMarginMs ?? EXPIRES_SAFETY_MARGIN_MS,
    platform: options.platform ?? PLATFORM,
    pluginVersion: options.pluginVersion ?? PLUGIN_VERSION,
    conversationRequestId: options.conversationRequestId ?? randomUUID,
    sendCliHeaders: options.sendCliHeaders ?? SEND_CLI_HEADERS,
    debug:
      options.debug ??
      (DEBUG_STDERR || DEBUG_LOG_PATH ? defaultDiagnosticSink : undefined),
    probeCloudConfig:
      options.probeCloudConfig ??
      envFlag("PI_CODEBUDDY_PROBE_CLOUD_CONFIG", false),
    cloudConfigRepos: normalizeCloudConfigRepos(
      options.cloudConfigRepos ?? parseCloudConfigReposEnv(),
    ),
  };
}

function parseCloudConfigReposEnv(): readonly string[] {
  const value = envText("PI_CODEBUDDY_CONFIG_REPOS");
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      // Fall through to the comma-separated form for a friendly local override.
    }
  }
  return value.split(",");
}

function normalizeCloudConfigRepos(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function emitDiagnostic(
  runtime: Runtime,
  event: string,
  details: DiagnosticDetails,
): void {
  if ((event === "models.refresh.success" || event === "models.enterprise.success") && typeof details.source === "string") {
    runtime.onCatalogSource?.(details.source);
  }
  try {
    runtime.debug?.(event, sanitizeDiagnosticValue(details) as DiagnosticDetails);
  } catch {
    // Diagnostics must never alter login, refresh, or model discovery behavior.
  }
}

/** Normalize any supplied URL to its origin and join one absolute path. */
export function joinUrl(root: string, path: string): string {
  const base = new URL(root.trim()).origin;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function normalizeSiteRoot(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("CodeBuddy 登录站点 URL 必须使用 http 或 https");
  }
  return url.origin;
}

function withQuery(
  root: string,
  path: string,
  query: Record<string, string>,
): string {
  const url = new URL(joinUrl(root, path));
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function authUrlWithVersion(authUrl: string, root: string, version: string): string {
  const url = new URL(authUrl, root);
  url.searchParams.set("version", version);
  return url.toString();
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("操作已取消", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Add the CodeBuddy CLI envelope while retaining OpenAI semantics.
 * Every injected field only fills a gap the caller left undefined, and each
 * is individually gated by `envelope` so a deployment/model can opt out.
 */
export function prepareCodeBuddyPayload(
  payload: unknown,
  model: Model<Api>,
  envelope: EnvelopeConfig = ENVELOPE,
): unknown {
  const params = asRecord(payload);
  if (!params || !envelope.enabled) return payload;

  const result: Record<string, unknown> = { ...params };
  if (envelope.temperature !== undefined && result.temperature === undefined) {
    result.temperature = envelope.temperature;
  }
  if (
    result.max_tokens === undefined &&
    result.max_completion_tokens === undefined
  ) {
    result.max_tokens = model.maxTokens;
  }
  if (envelope.streamOptions && result.stream_options === undefined) {
    result.stream_options = { include_usage: true };
  }
  // Only when the model actually reasons and the caller did not set an effort:
  // never force reasoning onto a non-reasoning model.
  if (
    model.reasoning &&
    envelope.reasoningEffort !== undefined &&
    result.reasoning_effort === undefined
  ) {
    result.reasoning_effort = envelope.reasoningEffort;
  }

  if (envelope.agentTag !== undefined && Array.isArray(params.messages)) {
    const tag = envelope.agentTag;
    result.messages = params.messages.map((message) => {
      const record = asRecord(message);
      if (!record || record.role !== "user") return message;
      return {
        ...record,
        agent: tag,
        content:
          typeof record.content === "string"
            ? [{ type: "text", text: record.content }]
            : record.content,
      };
    });
  }

  return result;
}

function withCodeBuddyPayload<T extends StreamOptions>(
  options: T | undefined,
  envelope: EnvelopeConfig = ENVELOPE,
): T & StreamOptions {
  const callerPayload = options?.onPayload;
  const callerResponse = options?.onResponse;
  return {
    ...(options ?? ({} as T)),
    async onPayload(payload, model) {
      const replacement = await callerPayload?.(payload, model);
      return prepareCodeBuddyPayload(replacement ?? payload, model, envelope);
    },
    async onResponse(response, model) {
      await callerResponse?.(response, model);
      const contentType =
        response.headers["content-type"] ?? response.headers["Content-Type"];
      if (
        response.status === 200 &&
        typeof contentType === "string" &&
        contentType.toLowerCase().includes("application/json")
      ) {
        throw new Error(
          "CodeBuddy 返回了 HTTP 200 JSON 业务错误；请检查许可与配额，许可失效时重新执行 /login codebuddy",
        );
      }
    },
  };
}

export function mapCodeBuddyErrorMessage(message: string | undefined): string {
  const detail = message?.trim() || "CodeBuddy 请求失败";
  if (/\b(?:401|11212|11216)\b/.test(detail)) {
    return `CodeBuddy 登录或许可已失效，请重新执行 /login codebuddy（${detail}）`;
  }
  return detail;
}

function wrapCodeBuddyEvents(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  let latest: AssistantMessage | undefined;
  let sawContent = false;

  void (async () => {
    for await (const event of source) {
      if ("partial" in event) latest = event.partial;
      if (
        event.type === "text_delta" ||
        event.type === "thinking_delta" ||
        event.type === "toolcall_delta" ||
        event.type === "toolcall_end"
      ) {
        sawContent = true;
      }

      if (event.type === "error") {
        latest = event.error;
        target.push({
          ...event,
          error: {
            ...event.error,
            errorMessage: mapCodeBuddyErrorMessage(event.error.errorMessage),
          },
        });
      } else if (
        event.type === "done" &&
        !sawContent &&
        event.message.content.length === 0
      ) {
        latest = event.message;
        target.push({
          type: "error",
          reason: "error",
          error: {
            ...event.message,
            stopReason: "error",
            errorMessage:
              "CodeBuddy 返回了空流；这通常表示业务错误，请检查许可/配额或重新执行 /login codebuddy",
          },
        });
      } else {
        if (event.type === "done") latest = event.message;
        target.push(event);
      }
    }
  })().catch((error: unknown) => {
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
        errorMessage: mapCodeBuddyErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
      },
    });
  });

  return target;
}

function codeBuddyCompletionsApi(
  envelope: EnvelopeConfig = ENVELOPE,
): ProviderStreams {
  const delegate = openAICompletionsApi();
  return {
    stream(model, context, options) {
      return wrapCodeBuddyEvents(
        delegate.stream(model, context, withCodeBuddyPayload(options, envelope)),
      );
    },
    streamSimple(model, context, options) {
      return wrapCodeBuddyEvents(
        delegate.streamSimple(
          model,
          context,
          withCodeBuddyPayload(options, envelope),
        ),
      );
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactRequestId(value: string): string {
  return value.replaceAll("-", "");
}

function isOfficialSaaSRoot(root: string): boolean {
  const host = new URL(root).hostname.toLowerCase();
  return host === "codebuddy.ai" ||
    host === "www.codebuddy.ai" ||
    host === "copilot.tencent.com";
}

function getBusinessError(payload: unknown): BusinessError | undefined {
  const root = asRecord(payload);
  const error = asRecord(root?.error);
  // Real CodeBuddy v2 endpoints currently use { code, msg, data }, while some
  // compatible deployments use { error: { code, message, data } }.
  const numericCode = Number(error?.code ?? root?.code);
  if (!Number.isFinite(numericCode) || numericCode === 0) {
    return undefined;
  }
  return {
    code: numericCode,
    message:
      optionalString(error?.message) ??
      optionalString(root?.message) ??
      optionalString(root?.msg),
  };
}

function businessErrorMessage(error: BusinessError): string {
  if (
    error.code === BUSINESS_CODES.licenseExpired ||
    error.code === BUSINESS_CODES.trialExpired
  ) {
    return `CodeBuddy 许可已过期（业务码 ${error.code}），请重新执行 /login codebuddy`;
  }
  return error.message ?? `CodeBuddy 请求失败（业务码 ${error.code}）`;
}

function throwBusinessError(payload: unknown): void {
  const error = getBusinessError(payload);
  if (error) {
    throw new Error(businessErrorMessage(error));
  }
}

function extractData(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root) {
    throw new Error("CodeBuddy 返回了无法识别的响应");
  }

  const first = asRecord(root.data);
  const nested = asRecord(first?.data);
  return nested ?? first ?? root;
}

async function fetchJson(
  runtime: Runtime,
  url: string,
  init: RequestInit,
  networkRetries = 0,
  diagnosticScope?: string,
): Promise<unknown> {
  let response: Response | undefined;
  for (let attempt = 0; attempt <= networkRetries; attempt += 1) {
    try {
      response = await runtime.fetch(url, init);
      break;
    } catch (error) {
      if (init.signal?.aborted) {
        throw abortReason(init.signal);
      }
      if (attempt < networkRetries) {
        const delay =
          NETWORK_RETRY_DELAYS_MS[
            Math.min(attempt, NETWORK_RETRY_DELAYS_MS.length - 1)
          ];
        await runtime.sleep(delay, init.signal ?? undefined);
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      if (diagnosticScope) {
        emitDiagnostic(runtime, `${diagnosticScope}.network_error`, {
          attempt: attempt + 1,
          attempts: networkRetries + 1,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: detail,
          errorCode: asRecord(error)?.code,
          causeCode: asRecord(asRecord(error)?.cause)?.code,
        });
      }
      throw new Error(`无法连接 CodeBuddy：${detail}`, { cause: error });
    }
  }

  if (!response) throw new Error("无法连接 CodeBuddy：请求未返回响应");

  if (diagnosticScope) {
    emitDiagnostic(runtime, `${diagnosticScope}.http_response`, {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
    });
  }

  if (!response.ok && diagnosticScope) {
    let errorBody: unknown;
    let textPreview: string | undefined;
    try {
      const text = await response.clone().text();
      if (text) {
        try {
          errorBody = JSON.parse(text) as unknown;
        } catch {
          textPreview = text.slice(0, 1_000);
        }
      }
    } catch {
      // The status and headers above are still useful if a body cannot be read.
    }
    emitDiagnostic(runtime, `${diagnosticScope}.error_response`, {
      ...(errorBody === undefined ? {} : responseShape(errorBody)),
      textPreview,
    });
  }

  if (response.status === 401) {
    throw new Error("CodeBuddy 登录已失效，请重新执行 /login codebuddy");
  }

  if (!response.ok) {
    throw new Error(
      `CodeBuddy 请求失败：HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }

  try {
    const payload = await response.json();
    if (diagnosticScope) {
      emitDiagnostic(
        runtime,
        `${diagnosticScope}.response_body`,
        responseShape(payload),
      );
    }
    return payload;
  } catch (error) {
    if (diagnosticScope) {
      emitDiagnostic(runtime, `${diagnosticScope}.invalid_json`, {
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    throw new Error("CodeBuddy 返回了无效 JSON", { cause: error });
  }
}

function parseAuthData(payload: unknown): AuthData {
  const data = extractData(payload);
  const accessToken = optionalString(data.accessToken);
  const refreshToken = optionalString(data.refreshToken);
  if (!accessToken || !refreshToken) {
    throw new Error("CodeBuddy 响应缺少 accessToken 或 refreshToken");
  }

  return {
    accessToken,
    refreshToken,
    domain: optionalString(data.domain),
    expiresAt: optionalNumber(data.expiresAt),
    expiresIn: optionalNumber(data.expiresIn),
  };
}

function credentialExpires(auth: AuthData, runtime: Runtime): number {
  const now = runtime.now();
  const absolute =
    auth.expiresAt && auth.expiresAt > 0
      ? auth.expiresAt
      : auth.expiresIn && auth.expiresIn > 0
        ? now + auth.expiresIn * 1_000
        : undefined;

  if (!absolute) {
    throw new Error("CodeBuddy 响应缺少有效的 expiresAt/expiresIn");
  }

  return Math.max(0, absolute - runtime.expiresSafetyMarginMs);
}

async function fetchAuthState(root: string, runtime: Runtime, signal?: AbortSignal) {
  const payload = await fetchJson(
    runtime,
    withQuery(root, PATHS.authState, { platform: runtime.platform }),
    {
      method: "POST",
      headers: {
        ...X_NO_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal,
    },
    NETWORK_RETRY_DELAYS_MS.length,
  );
  throwBusinessError(payload);

  const data = extractData(payload);
  const state = optionalString(data.state);
  const authUrl = optionalString(data.authUrl);
  if (!state || !authUrl) {
    throw new Error("CodeBuddy 登录响应缺少 state 或 authUrl");
  }
  return { state, authUrl };
}

async function loopGetToken(
  root: string,
  state: string,
  runtime: Runtime,
  signal?: AbortSignal,
): Promise<AuthData> {
  const startedAt = runtime.now();

  while (runtime.now() - startedAt < runtime.pollTimeoutMs) {
    throwIfAborted(signal);
    const payload = await fetchJson(
      runtime,
      withQuery(root, PATHS.authToken, { state }),
      {
        method: "GET",
        headers: X_NO_HEADERS,
        signal,
      },
      NETWORK_RETRY_DELAYS_MS.length,
    );

    const businessError = getBusinessError(payload);
    if (!businessError) {
      return parseAuthData(payload);
    }
    if (businessError.code !== BUSINESS_CODES.retryFetchToken) {
      throw new Error(businessErrorMessage(businessError));
    }

    const elapsed = runtime.now() - startedAt;
    if (elapsed >= runtime.pollTimeoutMs) {
      break;
    }
    await runtime.sleep(
      Math.min(runtime.pollIntervalMs, runtime.pollTimeoutMs - elapsed),
      signal,
    );
  }

  throw new Error("等待 CodeBuddy 浏览器授权超时（5 分钟），请重新登录");
}

async function fetchAccount(
  root: string,
  state: string,
  accessToken: string,
  runtime: Runtime,
  signal?: AbortSignal,
): Promise<AccountData> {
  const payload = await fetchJson(
    runtime,
    withQuery(root, PATHS.loginAccount, { state }),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    },
    1,
  );
  throwBusinessError(payload);

  const data = extractData(payload);
  return {
    uid: optionalString(data.uid),
    type: optionalString(data.type),
    enterpriseId: optionalString(data.enterpriseId),
    departmentFullName: optionalString(data.departmentFullName),
  };
}

function credentialString(
  credential: OAuthCredential,
  field: "access" | "refresh" | "baseUrl",
): string {
  const value = credential[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`CodeBuddy 凭据缺少 ${field}，请重新执行 /login codebuddy`);
  }
  return value;
}

export function createCodeBuddyOAuth(
  options: CodeBuddyRuntimeOptions = {},
): OAuthAuth {
  const runtime = makeRuntime(options);

  const login = async (
    interaction: ProviderAuthInteraction,
  ): Promise<OAuthCredential> => {
    throwIfAborted(interaction.signal);
    const input = await interaction.prompt({
      type: "text",
      message: "CodeBuddy 登录站点 URL",
      placeholder: DEFAULT_SITE_ROOT,
    });
    const baseUrl = normalizeSiteRoot(input);

    const { state, authUrl } = await fetchAuthState(
      baseUrl,
      runtime,
      interaction.signal,
    );
    interaction.notify({
      type: "auth_url",
      url: authUrlWithVersion(authUrl, baseUrl, runtime.pluginVersion),
    });
    interaction.notify({ type: "progress", message: "等待浏览器授权…" });

    const auth = await loopGetToken(
      baseUrl,
      state,
      runtime,
      interaction.signal,
    );

    let account: AccountData = {};
    try {
      account = await fetchAccount(
        baseUrl,
        state,
        auth.accessToken,
        runtime,
        interaction.signal,
      );
    } catch (error) {
      if (interaction.signal?.aborted) {
        throw error;
      }
      // Account enrichment is optional; token login remains valid without it.
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
      accountType: account.type,
    };
  };

  const refresh = async (
    credential: OAuthCredential,
    signal: AbortSignal,
  ): Promise<OAuthCredential> => {
    throwIfAborted(signal);
    const baseUrl = normalizeSiteRoot(credentialString(credential, "baseUrl"));
    const currentRefresh = credentialString(credential, "refresh");
    const payload = await fetchJson(
      runtime,
      joinUrl(baseUrl, PATHS.refreshToken),
      {
        method: "POST",
        headers: {
          "X-Refresh-Token": currentRefresh,
          "X-Auth-Refresh-Source": "plugin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal,
      },
    );
    throwBusinessError(payload);
    const auth = parseAuthData(payload);

    return {
      ...credential,
      type: "oauth",
      access: auth.accessToken,
      refresh: auth.refreshToken,
      expires: credentialExpires(auth, runtime),
      domain: auth.domain ?? credential.domain,
    };
  };

  const toAuth = async (credential: OAuthCredential): Promise<ModelAuth> => {
    const access = credentialString(credential, "access");
    const baseUrl = normalizeSiteRoot(credentialString(credential, "baseUrl"));
    const domain = optionalString(credential.domain) ?? new URL(baseUrl).host;
    const uid = optionalString(credential.uid);
    const enterpriseId = optionalString(credential.enterpriseId);

    // Extra CLI headers (x-ide-*/x-conversation-*/x-product) are from real
    // 2.125.0 captures; gate them so a deployment can fall back to the minimal
    // header set that the reverse-engineering reference验证过可用.
    const cliHeaders = runtime.sendCliHeaders
      ? (() => {
          const conversationId = runtime.conversationRequestId();
          const conversationRequestId = compactRequestId(
            runtime.conversationRequestId(),
          );
          // x-request-id and x-conversation-message-id share one message id.
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
            ...(isOfficialSaaSRoot(baseUrl) ? { "x-product": "SaaS" } : {}),
          };
        })()
      : {};

    return {
      apiKey: access,
      baseUrl: joinUrl(baseUrl, PATHS.apiBase),
      headers: {
        "x-domain": domain,
        "x-agent-intent": "craft",
        ...cliHeaders,
        ...(uid ? { "x-user-id": uid } : {}),
        ...(enterpriseId
          ? {
              "x-enterprise-id": enterpriseId,
              "x-tenant-id": enterpriseId,
            }
          : {}),
        ...X_STAINLESS_HEADERS,
      },
    };
  };

  return { name: "CodeBuddy", login, refresh, toAuth };
}

const defaultOAuth = createCodeBuddyOAuth();

export const login = defaultOAuth.login;
export const refresh = defaultOAuth.refresh;
export const toAuth = defaultOAuth.toAuth;

/** Map one CodeBuddy product-model entry to a pi-ai model. */
export function toPiModel(
  entry: unknown,
  siteRoot: string,
): Model<"openai-completions"> | undefined {
  const record = asRecord(entry);
  const id = optionalString(record?.id);
  if (!record || !id) return undefined;

  const supportsImages = record.supportsImages === true;
  const reasoning =
    record.supportsReasoning === true ||
    record.onlyReasoning === true ||
    (record.reasoning != null && record.reasoning !== false);
  // A per-model url overrides the gateway; otherwise all models share <root>/v2.
  const modelUrl = optionalString(record.url);
  const baseUrl = modelUrl
    ? new URL(modelUrl).origin + new URL(modelUrl).pathname.replace(/\/chat\/completions\/?$/, "")
    : joinUrl(siteRoot, PATHS.apiBase);

  return {
    id,
    name: optionalString(record.name) ?? id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: ZERO_COST,
    contextWindow: optionalNumber(record.maxInputTokens) ?? 176_000,
    maxTokens: optionalNumber(record.maxOutputTokens) ?? 24_000,
    compat: MODEL_COMPAT,
  };
}

function configHeaders(
  credential: OAuthCredential,
  domain: string,
  runtime: Runtime,
  productEnvironment: CodeBuddyProductEnvironment,
): Record<string, string> {
  const uid = optionalString(credential.uid);
  const enterpriseId = optionalString(credential.enterpriseId);
  return {
    Authorization: `Bearer ${credentialString(credential, "access")}`,
    "x-domain": domain,
    Connection: "close",
    ...(uid ? { "x-user-id": uid } : {}),
    ...(enterpriseId
      ? { "x-enterprise-id": enterpriseId, "x-tenant-id": enterpriseId }
      : {}),
    ...X_STAINLESS_HEADERS,
    // ClientInternetEnviromentProductProvider explicitly injects these two
    // deployment types; ProductEndpointHttpInterceptor uses SaaS only when the
    // merged product configuration has no deploymentType.
    "x-product":
      productEnvironment === "cloudhosted"
        ? "Cloud-Hosted"
        : productEnvironment === "selfhosted"
          ? "Self-Hosted"
          : "SaaS",
    "User-Agent": `CLI/${runtime.pluginVersion} CodeBuddy/${runtime.pluginVersion}`,
  };
}

interface CloudProductConfig {
  /** Undefined means the server did not override the bundled global pool. */
  models?: readonly unknown[];
  /** Undefined means the server did not override bundled agent relations. */
  agents?: readonly unknown[];
}

function cloudConfigUrl(siteRoot: string, repos: readonly string[]): string {
  const url = new URL(joinUrl(siteRoot, PATHS.productConfig));
  // Axios 1.x's default flat-array encoding used by CodeBuddy is `repos[]=`.
  // With no explicitly supplied repositories the query is omitted, matching
  // the official client when its collector returns an empty array.
  for (const repo of repos) url.searchParams.append("repos[]", repo);
  return url.toString();
}

function extractCloudProductConfig(payload: unknown): CloudProductConfig {
  throwBusinessError(payload);
  const data = extractData(payload);
  const hasModels = Object.prototype.hasOwnProperty.call(data, "models");
  const hasAgents = Object.prototype.hasOwnProperty.call(data, "agents");
  if (hasModels && !Array.isArray(data.models)) {
    throw new Error("CodeBuddy Cloud Product 响应的 models 不是数组");
  }
  if (hasAgents && !Array.isArray(data.agents)) {
    throw new Error("CodeBuddy Cloud Product 响应的 agents 不是数组");
  }
  return {
    ...(hasModels ? { models: data.models as unknown[] } : {}),
    ...(hasAgents ? { agents: data.agents as unknown[] } : {}),
  };
}

function cloudConfigDiagnosticSummary(payload: unknown): DiagnosticDetails {
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
        tags: Array.isArray(model?.tags) ? model.tags : undefined,
        hasUrl: Boolean(optionalString(model?.url)),
      };
    }),
    agentCount: agents.length,
    agents: agents.slice(0, 100).map((entry) => {
      const agent = asRecord(entry);
      return {
        name: optionalString(agent?.name),
        models: Array.isArray(agent?.models) ? agent.models : undefined,
        modelTags: Array.isArray(agent?.modelTags)
          ? agent.modelTags
          : undefined,
        tags: Array.isArray(agent?.tags) ? agent.tags : undefined,
      };
    }),
  };
}

function enterpriseModelsPath(enterpriseId: string): string {
  return `${PATHS.enterpriseModels}/${encodeURIComponent(enterpriseId)}/config/models`;
}

/**
 * Axios reads this endpoint as `response.data.data`: on the wire that normally
 * means `{ data: Model[] }`. An empty array is valid and tells the official CLI
 * to keep its static product.json catalog; a missing/non-array data field is a
 * parse failure.
 */
function extractEnterpriseModels(payload: unknown): unknown[] {
  throwBusinessError(payload);
  const root = asRecord(payload);
  if (!root) {
    throw new Error("CodeBuddy 企业模型接口返回了无法识别的响应");
  }

  const direct = root.data;
  const nested = asRecord(direct)?.data;
  const models = Array.isArray(direct)
    ? direct
    : Array.isArray(nested)
      ? nested
      : undefined;
  if (!models) {
    throw new Error("CodeBuddy 企业模型接口响应缺少 data 数组");
  }
  return models;
}

function modelsForSite(
  siteRoot: string,
  productEnvironment: CodeBuddyProductEnvironment,
  cloudConfig: CloudProductConfig = {},
  enterpriseEntries: readonly unknown[] = [],
): {
  models: readonly Model<"openai-completions">[];
  identifiedCloudCount: number;
  identifiedEnterpriseCount: number;
  appliedEnterpriseCount: number;
} {
  if (
    cloudConfig.models === undefined &&
    cloudConfig.agents === undefined &&
    enterpriseEntries.length === 0 &&
    productEnvironment === "external" &&
    normalizeSiteRoot(siteRoot) === DEFAULT_SITE_ROOT
  ) {
    return {
      models: BUILTIN_MODELS,
      identifiedCloudCount: 0,
      identifiedEnterpriseCount: 0,
      appliedEnterpriseCount: 0,
    };
  }

  const staticCliConfigs = productModelConfigsFor(productEnvironment);
  const staticPool = productModelPoolConfigsFor(productEnvironment);
  const staticById = new Map(staticPool.map((entry) => [entry.id, entry]));
  let identifiedCloudCount = 0;
  let productEntries: Record<string, unknown>[];
  if (cloudConfig.models === undefined) {
    productEntries = staticPool.map((entry) => ({ ...entry }));
  } else {
    productEntries = [];
    for (const entry of cloudConfig.models) {
      const record = asRecord(entry);
      const id = optionalString(record?.id);
      if (!record || !id) continue;
      identifiedCloudCount += 1;
      productEntries.push({ ...(staticById.get(id) ?? {}), ...record, id });
    }
    if (cloudConfig.models.length > 0 && identifiedCloudCount === 0) {
      throw new Error("CodeBuddy Cloud Product models 没有带 id 的条目");
    }
  }

  let cliModelIds = staticCliConfigs.map((entry) => entry.id);
  const cloudAgents = cloudConfig.agents ?? [];
  const getAgentModels = (name: string): readonly string[] | undefined => {
    const agent = cloudAgents.map(asRecord).find((entry) => entry?.name === name);
    if (!agent || !Object.prototype.hasOwnProperty.call(agent, "models")) {
      return undefined;
    }
    if (!Array.isArray(agent.models)) {
      throw new Error(`CodeBuddy Cloud Product agent ${name} 的 models 不是数组`);
    }
    return agent.models.filter(
      (modelId): modelId is string => typeof modelId === "string" && Boolean(modelId.trim()),
    );
  };
  // CloudAgentsSmartMerge preserves the static cli agent unless the remote cli
  // explicitly supplies models. CraftToCliSync then appends craft relations.
  const remoteCliModels = getAgentModels("cli");
  if (remoteCliModels !== undefined) cliModelIds = [...remoteCliModels];
  const craftModels = getAgentModels("craft") ?? [];
  for (const id of craftModels) {
    if (!cliModelIds.includes(id)) cliModelIds.push(id);
  }

  const productIndexById = new Map<string, number>();
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
    if (index === undefined) {
      productIndexById.set(id, productEntries.length);
      productEntries.push({ ...record, id });
    } else {
      productEntries[index] = { ...productEntries[index], ...record, id };
    }
    appliedEnterpriseCount += 1;
    const tags = Array.isArray(record.tags) ? record.tags : [];
    if (tags.includes("chat") && !cliModelIds.includes(id)) cliModelIds.unshift(id);
  }

  if (enterpriseEntries.length > 0 && identifiedEnterpriseCount === 0) {
    throw new Error("CodeBuddy 企业模型接口没有带 id 的模型条目");
  }

  const productById = new Map<string, Record<string, unknown>>();
  for (const entry of productEntries) {
    const id = optionalString(entry.id);
    if (id) productById.set(id, entry);
  }
  const visibleEntries: Record<string, unknown>[] = [];
  const visibleIds = new Set<string>();
  for (const id of cliModelIds) {
    const entry = productById.get(id);
    if (entry && !visibleIds.has(id)) {
      visibleEntries.push(entry);
      visibleIds.add(id);
    }
  }
  // AgentManager.computeModels appends every model tagged `chat`, even when an
  // agent did not explicitly declare it.
  for (const entry of productEntries) {
    const id = optionalString(entry.id);
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (id && tags.includes("chat") && !visibleIds.has(id)) {
      visibleEntries.push(entry);
      visibleIds.add(id);
    }
  }

  const models = visibleEntries
    .map((entry) => toPiModel(entry, siteRoot))
    .filter(
      (model): model is Model<"openai-completions"> => model !== undefined,
    );
  if (models.length === 0) {
    throw new Error("CodeBuddy 合并后的 cli 模型清单为空");
  }
  return {
    models,
    identifiedCloudCount,
    identifiedEnterpriseCount,
    appliedEnterpriseCount,
  };
}

/**
 * Reproduce CodeBuddy Code 2.125.0's model pipeline: bundled product catalog,
 * CloudProductProvider `/v3/config`, and (for Enterprise Domain accounts) the
 * dedicated `/console/enterprises/{enterpriseId}/config/models` overlay.
 * Network/parse failures throw so pi-ai keeps the last successful catalog.
 */
export async function fetchCodeBuddyModels(
  context: RefreshModelsContext,
  options: CodeBuddyRuntimeOptions = {},
): Promise<readonly Model<"openai-completions">[]> {
  const runtime = makeRuntime(options);
  const credential = context.credential;
  const credentialMetadata = asRecord(credential);
  const metadataBaseUrl = optionalString(credentialMetadata?.baseUrl);
  let metadataDomain = optionalString(credentialMetadata?.domain);
  if (!metadataDomain && metadataBaseUrl) {
    try {
      metadataDomain = new URL(metadataBaseUrl).host;
    } catch {
      // A malformed OAuth base URL will be rejected below after credential narrowing.
    }
  }
  const productEnvironment = metadataDomain
    ? resolveCodeBuddyProductEnvironment(metadataDomain)
    : "external";
  emitDiagnostic(runtime, "models.refresh.start", {
    allowNetwork: context.allowNetwork,
    credentialType: credential?.type ?? "missing",
    accountType: optionalString(credentialMetadata?.accountType),
    hasEnterpriseId: Boolean(
      optionalString(credentialMetadata?.enterpriseId),
    ),
    baseUrlHostFingerprint: urlHostFingerprint(
      optionalString(credentialMetadata?.baseUrl),
    ),
    domainFingerprint: identifierFingerprint(
      optionalString(credentialMetadata?.domain),
    ),
    uidFingerprint: identifierFingerprint(
      optionalString(credentialMetadata?.uid),
    ),
    enterpriseIdFingerprint: identifierFingerprint(
      optionalString(credentialMetadata?.enterpriseId),
    ),
    productEnvironment,
    productEnvironmentOverride: envText("PI_CODEBUDDY_PRODUCT_ENV"),
  });

  if (!context.allowNetwork) {
    const models =
      credential?.type === "oauth"
        ? modelsForSite(
            normalizeSiteRoot(credentialString(credential, "baseUrl")),
            productEnvironment,
          ).models
        : BUILTIN_MODELS;
    emitDiagnostic(runtime, "models.refresh.baseline", {
      reason: "network_disabled",
      productEnvironment,
      modelCount: models.length,
    });
    return models;
  }
  if (credential?.type !== "oauth") {
    emitDiagnostic(runtime, "models.refresh.baseline", {
      reason: credential ? "non_oauth_credential" : "missing_credential",
      modelCount: BUILTIN_MODELS.length,
    });
    return BUILTIN_MODELS;
  }

  const siteRoot = normalizeSiteRoot(credentialString(credential, "baseUrl"));
  const domain = optionalString(credential.domain) ?? new URL(siteRoot).host;
  const enterpriseId = optionalString(credential.enterpriseId);
  const headers = configHeaders(
    credential,
    domain,
    runtime,
    productEnvironment,
  );
  const cloudUrl = cloudConfigUrl(siteRoot, runtime.cloudConfigRepos);
  emitDiagnostic(runtime, "models.cloud_config.request", {
    method: "GET",
    path: PATHS.productConfig,
    productEnvironment,
    xProduct: headers["x-product"],
    headerNames: Object.keys(headers).sort(),
    automaticGitCollection: false,
    explicitReposCount: runtime.cloudConfigRepos.length,
    reposQueryOmitted: runtime.cloudConfigRepos.length === 0,
  });
  let cloudConfig: CloudProductConfig;
  try {
    const cloudPayload = await fetchJson(
      runtime,
      cloudUrl,
      {
        method: "GET",
        headers,
        signal: context.signal,
      },
      0,
      "models.cloud_config",
    );
    cloudConfig = extractCloudProductConfig(cloudPayload);
    if (runtime.probeCloudConfig) {
      emitDiagnostic(
        runtime,
        "models.cloud_config.probe.summary",
        cloudConfigDiagnosticSummary(cloudPayload),
      );
    }
    emitDiagnostic(runtime, "models.cloud_config.success", {
      productEnvironment,
      hasModelsOverride: cloudConfig.models !== undefined,
      modelResponseCount: cloudConfig.models?.length ?? 0,
      hasAgentsOverride: cloudConfig.agents !== undefined,
      agentResponseCount: cloudConfig.agents?.length ?? 0,
    });
  } catch (error) {
    emitDiagnostic(runtime, "models.cloud_config.error", {
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!enterpriseId) {
    const { models, identifiedCloudCount } = modelsForSite(
      siteRoot,
      productEnvironment,
      cloudConfig,
    );
    emitDiagnostic(runtime, "models.refresh.success", {
      accountType: "personal",
      productEnvironment,
      modelCount: models.length,
      identifiedCloudCount,
      source:
        cloudConfig.models === undefined && cloudConfig.agents === undefined
          ? productConfigFileName(productEnvironment)
          : `${productConfigFileName(productEnvironment)}+/v3/config`,
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
    headerNames: Object.keys(headers).sort(),
  });

  try {
    const payload = await fetchJson(
      runtime,
      joinUrl(siteRoot, path),
      {
        method: "GET",
        headers,
        signal: context.signal,
      },
      0,
      "models.enterprise",
    );
    const enterpriseEntries = extractEnterpriseModels(payload);
    const {
      models,
      identifiedCloudCount,
      identifiedEnterpriseCount,
      appliedEnterpriseCount,
    } = modelsForSite(
      siteRoot,
      productEnvironment,
      cloudConfig,
      enterpriseEntries,
    );
    if (enterpriseEntries.length === 0) {
      emitDiagnostic(runtime, "models.enterprise.empty_fallback", {
        reason:
          cloudConfig.models === undefined && cloudConfig.agents === undefined
            ? "official_static_product_fallback"
            : "cloud_product_fallback",
        productEnvironment,
        modelCount: models.length,
      });
    }
    emitDiagnostic(runtime, "models.enterprise.success", {
      modelCount: models.length,
      cloudModelResponseCount: cloudConfig.models?.length ?? 0,
      cloudAgentResponseCount: cloudConfig.agents?.length ?? 0,
      identifiedCloudCount,
      enterpriseResponseCount: enterpriseEntries.length,
      identifiedEnterpriseCount,
      appliedEnterpriseCount,
      productEnvironment,
      source:
        [
          productConfigFileName(productEnvironment),
          cloudConfig.models !== undefined || cloudConfig.agents !== undefined
            ? "/v3/config"
            : undefined,
          enterpriseEntries.length > 0 ? "enterprise-smart-merge" : undefined,
        ]
          .filter(Boolean)
          .join("+"),
      models: models.slice(0, 50).map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        reasoning: model.reasoning,
        baseUrlHostFingerprint: urlHostFingerprint(model.baseUrl),
      })),
    });
    return models;
  } catch (error) {
    emitDiagnostic(runtime, "models.enterprise.error", {
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function createCodeBuddyProvider(
  options: CodeBuddyRuntimeOptions = {},
): Provider<"openai-completions"> {
  const oauth = createCodeBuddyOAuth(options);
  // createProvider treats `models` as a permanent baseline and fetchModels as
  // an overlay. CodeBuddy's discovered catalog is already the complete,
  // environment-aware result (static product fallback + Cloud/Enterprise
  // merges), so using the international catalog as that baseline leaks models
  // such as Gemini into Cloud-Hosted accounts. Keep the internal baseline empty
  // and expose BUILTIN_MODELS only while no stored/refreshed catalog exists.
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "CodeBuddy",
    baseUrl: joinUrl(DEFAULT_SITE_ROOT, PATHS.apiBase),
    api: codeBuddyCompletionsApi(),
    models: [],
    fetchModels: (context) => fetchCodeBuddyModels(context, options),
    auth: {
      oauth: {
        name: "CodeBuddy",
        login: oauth.login,
        refresh: oauth.refresh,
        toAuth: oauth.toAuth,
      },
    },
  });
  const getDiscoveredModels = provider.getModels;
  return {
    ...provider,
    getModels: () => {
      const models = getDiscoveredModels();
      return models.length > 0 ? models : BUILTIN_MODELS;
    },
  };
}
