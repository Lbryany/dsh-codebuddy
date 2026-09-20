import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  AuthEvent,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
  BUSINESS_CODES,
  BUILTIN_MODELS,
  createCodeBuddyProvider,
  createCodeBuddyOAuth,
  fetchCodeBuddyModels,
  joinUrl,
  mapCodeBuddyErrorMessage,
  PATHS,
  prepareCodeBuddyPayload,
  resolveCodeBuddyProductEnvironment,
} from "../src/codebuddy.ts";

interface RequestCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function interactionFor(
  answer: string,
  events: AuthEvent[] = [],
  signal: AbortSignal = new AbortController().signal,
): ProviderAuthInteraction {
  return {
    signal,
    async prompt() {
      return answer;
    },
    notify(event) {
      events.push(event);
    },
  };
}

test("joinUrl normalizes site roots and never duplicates /v2", () => {
  const cases = [
    ["https://www.codebuddy.ai", "/v2", "https://www.codebuddy.ai/v2"],
    ["https://www.codebuddy.ai/", "v2", "https://www.codebuddy.ai/v2"],
    ["https://www.codebuddy.ai/v2", "/v2", "https://www.codebuddy.ai/v2"],
    ["https://copilot.tencent.com/v2/", PATHS.authState, "https://copilot.tencent.com/v2/plugin/auth/state"],
  ] as const;

  for (const [root, path, expected] of cases) {
    assert.equal(joinUrl(root, path), expected);
    assert.equal(joinUrl(root, path).includes("/v2/v2"), false);
  }
});

test("login polls through 11217 and returns normalized OAuth credentials", async () => {
  const calls: RequestCall[] = [];
  const events: AuthEvent[] = [];
  const sleeps: number[] = [];
  let tokenAttempts = 0;
  const now = 1_000_000;

  const oauth = createCodeBuddyOAuth({
    now: () => now,
    platform: "test-platform",
    pluginVersion: "9.9.9",
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    fetch: async (input, init = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      const url = new URL(call.url);

      if (url.pathname === PATHS.authState) {
        return jsonResponse({
          error: { code: 0 },
          data: {
            state: "state-1",
            authUrl: "https://auth.example/sign-in?source=pi",
          },
        });
      }
      if (url.pathname === PATHS.authToken) {
        tokenAttempts += 1;
        if (tokenAttempts === 1) {
          return jsonResponse({
            code: BUSINESS_CODES.retryFetchToken,
            msg: "not ready",
            requestId: "request-1",
          });
        }
        return jsonResponse({
          error: { code: 0 },
          data: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresIn: 3_600,
            domain: "account.example",
          },
        });
      }
      if (url.pathname === PATHS.loginAccount) {
        assert.equal(
          new Headers(init.headers).get("Authorization"),
          "Bearer access-1",
        );
        return jsonResponse({
          error: { code: 0 },
          data: {
            uid: "user-1",
            type: "enterprise",
            enterpriseId: "enterprise-1",
            departmentFullName: "研发部",
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const credential = await oauth.login(
    interactionFor("https://www.codebuddy.ai/v2/", events),
  );

  assert.deepEqual(credential, {
    type: "oauth",
    access: "access-1",
    refresh: "refresh-1",
    expires: now + 3_600_000 - 300_000,
    baseUrl: "https://www.codebuddy.ai",
    domain: "account.example",
    uid: "user-1",
    enterpriseId: "enterprise-1",
    departmentFullName: "研发部",
    accountType: "enterprise",
  });
  assert.equal(tokenAttempts, 2);
  assert.deepEqual(sleeps, [1_000]);

  const stateCall = calls[0];
  assert.equal(
    stateCall.url,
    "https://www.codebuddy.ai/v2/plugin/auth/state?platform=test-platform",
  );
  assert.equal(stateCall.init.method, "POST");
  assert.equal(stateCall.init.body, "{}");
  const stateHeaders = new Headers(stateCall.init.headers);
  assert.equal(stateHeaders.get("X-No-Authorization"), "true");
  assert.equal(stateHeaders.get("X-No-User-Id"), "true");
  assert.equal(stateHeaders.get("X-No-Enterprise-Id"), "true");
  assert.equal(stateHeaders.get("X-No-Department-Info"), "true");

  assert.deepEqual(events, [
    {
      type: "auth_url",
      url: "https://auth.example/sign-in?source=pi&version=9.9.9",
    },
    { type: "progress", message: "等待浏览器授权…" },
  ]);
});

test("login retries transient network failures on idempotent auth requests", async () => {
  let stateAttempts = 0;
  const sleeps: number[] = [];
  const oauth = createCodeBuddyOAuth({
    now: () => 1_000_000,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === PATHS.authState) {
        stateAttempts += 1;
        if (stateAttempts === 1) throw new TypeError("fetch failed");
        return jsonResponse({
          data: { state: "state-retry", authUrl: "https://auth.example" },
        });
      }
      if (path === PATHS.authToken) {
        return jsonResponse({
          data: {
            accessToken: "access-retry",
            refreshToken: "refresh-retry",
            expiresIn: 3_600,
          },
        });
      }
      if (path === PATHS.loginAccount) {
        return jsonResponse({ code: BUSINESS_CODES.retryFetchAccount });
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  const credential = await oauth.login(
    interactionFor("https://www.codebuddy.ai"),
  );

  assert.equal(stateAttempts, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(credential.access, "access-retry");
});

test("login times out when token polling only returns 11217", async () => {
  let clock = 0;
  let tokenAttempts = 0;
  const oauth = createCodeBuddyOAuth({
    now: () => clock,
    pollIntervalMs: 100,
    pollTimeoutMs: 300,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === PATHS.authState) {
        return jsonResponse({
          data: { state: "state-timeout", authUrl: "https://auth.example" },
        });
      }
      if (path === PATHS.authToken) {
        tokenAttempts += 1;
        return jsonResponse({
          error: { code: BUSINESS_CODES.retryFetchToken, message: "wait" },
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  await assert.rejects(
    oauth.login(interactionFor("https://www.codebuddy.ai")),
    /授权超时/,
  );
  assert.equal(tokenAttempts, 3);
});

test("login succeeds without uid when account enrichment returns 12151", async () => {
  const oauth = createCodeBuddyOAuth({
    now: () => 10_000,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === PATHS.authState) {
        return jsonResponse({
          data: { state: "state-account", authUrl: "https://auth.example" },
        });
      }
      if (path === PATHS.authToken) {
        return jsonResponse({
          data: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 4_000_000,
          },
        });
      }
      if (path === PATHS.loginAccount) {
        return jsonResponse({
          code: BUSINESS_CODES.retryFetchAccount,
          msg: "account not ready",
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  const credential = await oauth.login(
    interactionFor("https://copilot.tencent.com"),
  );
  assert.equal(credential.type, "oauth");
  assert.equal(credential.baseUrl, "https://copilot.tencent.com");
  assert.equal(credential.uid, undefined);
  assert.equal(credential.enterpriseId, undefined);
});

test("refresh uses refresh headers, no enterprise headers, and preserves account fields", async () => {
  let refreshCall: RequestCall | undefined;
  const oauth = createCodeBuddyOAuth({
    now: () => 2_000_000,
    fetch: async (input, init = {}) => {
      refreshCall = { url: String(input), init };
      return jsonResponse({
        error: { code: 0 },
        data: {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: 9_000_000,
          domain: "new-domain.example",
        },
      });
    },
  });
  const original: OAuthCredential = {
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: 1,
    baseUrl: "https://copilot.tencent.com/v2/",
    domain: "old-domain.example",
    uid: "user-1",
    enterpriseId: "enterprise-1",
    departmentFullName: "研发部",
    accountType: "enterprise",
  };

  const refreshed = await oauth.refresh(original, new AbortController().signal);

  assert.ok(refreshCall);
  assert.equal(
    refreshCall.url,
    "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
  );
  assert.equal(refreshCall.init.method, "POST");
  assert.equal(refreshCall.init.body, "{}");
  const headers = new Headers(refreshCall.init.headers);
  assert.equal(headers.get("X-Refresh-Token"), "old-refresh");
  assert.equal(headers.get("X-Auth-Refresh-Source"), "plugin");
  assert.equal(headers.has("X-Enterprise-Id"), false);
  assert.equal(headers.has("X-Tenant-Id"), false);
  assert.equal(headers.has("X-Department-Info"), false);

  assert.deepEqual(refreshed, {
    ...original,
    access: "new-access",
    refresh: "new-refresh",
    expires: 9_000_000 - 300_000,
    domain: "new-domain.example",
  });
});

test("toAuth derives personal request auth without enterprise headers", async () => {
  const oauth = createCodeBuddyOAuth({
    conversationRequestId: () => "conversation-1",
  });
  const auth = await oauth.toAuth({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 1,
    baseUrl: "https://www.codebuddy.ai/v2/",
    uid: "user-1",
  });

  assert.equal(auth.apiKey, "access");
  assert.equal(auth.baseUrl, "https://www.codebuddy.ai/v2");
  assert.equal(auth.baseUrl?.includes("chat/completions"), false);
  assert.equal(auth.headers?.["x-domain"], "www.codebuddy.ai");
  assert.equal(auth.headers?.["x-agent-intent"], "craft");
  assert.equal(auth.headers?.["x-user-id"], "user-1");
  assert.equal(auth.headers?.["x-conversation-request-id"], "conversation1");
  assert.equal(auth.headers?.["x-conversation-id"], "conversation-1");
  assert.equal(auth.headers?.["x-request-id"], "conversation1");
  assert.equal(auth.headers?.["x-conversation-message-id"], "conversation1");
  assert.equal(auth.headers?.["x-agent-purpose"], "conversation");
  assert.equal(auth.headers?.["x-codebuddy-request"], "1");
  assert.equal(auth.headers?.["x-ide-version"], "2.125.0");
  assert.equal(auth.headers?.["x-stainless-lang"], "js");
  assert.equal(auth.headers?.["x-enterprise-id"], undefined);
  assert.equal(auth.headers?.["x-tenant-id"], undefined);
  assert.equal(auth.headers?.Authorization, undefined);
});

test("toAuth adds both required enterprise headers and omits department info", async () => {
  const oauth = createCodeBuddyOAuth({
    conversationRequestId: () => "conversation-2",
  });
  const auth = await oauth.toAuth({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 1,
    baseUrl: "https://copilot.tencent.com",
    domain: "tenant.example",
    enterpriseId: "enterprise-1",
    departmentFullName: "研发部",
  });

  assert.equal(auth.headers?.["x-enterprise-id"], "enterprise-1");
  assert.equal(auth.headers?.["x-tenant-id"], "enterprise-1");
  assert.equal(auth.headers?.["x-department-info"], undefined);
});

test("CodeBuddy payload envelope matches the current CLI protocol", () => {
  const payload = prepareCodeBuddyPayload(
    {
      model: "default-model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
      stream: true,
      tools: [],
    },
    BUILTIN_MODELS[0],
  ) as {
    temperature: number;
    max_tokens: number;
    stream_options: { include_usage: boolean };
    reasoning_effort: string;
    messages: Array<Record<string, unknown>>;
  };

  assert.equal(payload.temperature, 1);
  assert.equal(payload.max_tokens, 24_000);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal(payload.reasoning_effort, "high");
  assert.equal(payload.messages[0]?.agent, undefined);
  assert.equal(payload.messages[1]?.agent, "cli");
  assert.deepEqual(payload.messages[1]?.content, [
    { type: "text", text: "hello" },
  ]);
});

test("CodeBuddy auth and license errors point back to login", () => {
  assert.match(mapCodeBuddyErrorMessage("401 status code"), /login codebuddy/);
  assert.match(mapCodeBuddyErrorMessage("business code 11216"), /login codebuddy/);
  assert.equal(
    mapCodeBuddyErrorMessage("rate limit"),
    "rate limit",
  );
});

test("provider factory exposes one concrete CodeBuddy provider", () => {
  const provider = createCodeBuddyProvider() as {
    id: string;
    name: string;
    getModels(): readonly { id: string; provider: string }[];
  };
  assert.equal(provider.id, "codebuddy");
  assert.equal(provider.name, "CodeBuddy");
  assert.deepEqual(
    provider.getModels().map(({ id, provider: owner }) => [owner, id]),
    BUILTIN_MODELS.map(({ id }) => ["codebuddy", id]),
  );
});

test("a successful enterprise refresh replaces the international provider fallback", async () => {
  const provider = createCodeBuddyProvider({
    fetch: async (input) => {
      if (String(input).endsWith("/v3/config")) {
        return jsonResponse({
          code: 0,
          data: { productFeatures: { CodeAdoptionRate: true } },
        });
      }
      return jsonResponse({
        code: 0,
        data: [
          {
            id: "company-chat",
            name: "Company Chat",
            tags: ["chat"],
            maxInputTokens: 128_000,
            maxOutputTokens: 16_000,
          },
        ],
      });
    },
  });
  let stored: unknown;
  const signal = new AbortController().signal;

  assert.ok(provider.getModels().some(({ id }) => id.startsWith("gemini-")));
  await provider.refreshModels?.({
    credential: {
      ...OAUTH_CREDENTIAL,
      baseUrl: "https://acme.sso.codebuddy.cn",
      domain: "acme.sso.codebuddy.cn",
    },
    allowNetwork: true,
    signal,
    publish: async (publication) => {
      stored = publication.persist;
      publication.update?.();
      return true;
    },
  });

  const refreshed = provider.getModels();
  assert.ok(stored);
  assert.ok(refreshed.some(({ id }) => id === "company-chat"));
  assert.equal(refreshed.some(({ id }) => id.startsWith("gemini-")), false);
});

test("built-in catalog matches CodeBuddy Code 2.125.0 international CLI models", () => {
  assert.deepEqual(
    BUILTIN_MODELS.map(({ id }) => id),
    [
      "default-model",
      "gemini-3.1-pro",
      "gemini-3.0-flash",
      "gemini-3.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.1-flash-lite",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "deepseek-v3-2-volc",
      "glm-5.0",
      "kimi-k2.5",
    ],
  );
  assert.deepEqual(
    BUILTIN_MODELS.map(
      ({ id, contextWindow, maxTokens, input, reasoning }) => ({
        id,
        contextWindow,
        maxTokens,
        input,
        reasoning,
      }),
    ),
    [
      { id: "default-model", contextWindow: 176_000, maxTokens: 24_000, input: ["text", "image"], reasoning: true },
      { id: "gemini-3.1-pro", contextWindow: 400_000, maxTokens: 64_000, input: ["text", "image"], reasoning: true },
      { id: "gemini-3.0-flash", contextWindow: 400_000, maxTokens: 64_000, input: ["text", "image"], reasoning: true },
      { id: "gemini-3.5-flash", contextWindow: 1_000_000, maxTokens: 65_536, input: ["text", "image"], reasoning: true },
      { id: "gemini-2.5-pro", contextWindow: 400_000, maxTokens: 64_000, input: ["text", "image"], reasoning: true },
      { id: "gemini-2.5-flash", contextWindow: 400_000, maxTokens: 64_000, input: ["text", "image"], reasoning: true },
      { id: "gemini-3.1-flash-lite", contextWindow: 200_000, maxTokens: 65_536, input: ["text", "image"], reasoning: true },
      { id: "gpt-5.5", contextWindow: 1_000_000, maxTokens: 72_000, input: ["text", "image"], reasoning: true },
      { id: "gpt-5.4", contextWindow: 272_000, maxTokens: 128_000, input: ["text", "image"], reasoning: true },
      { id: "gpt-5.3-codex", contextWindow: 272_000, maxTokens: 128_000, input: ["text", "image"], reasoning: true },
      { id: "gpt-5.1-codex", contextWindow: 272_000, maxTokens: 128_000, input: ["text", "image"], reasoning: true },
      { id: "gpt-5.1-codex-mini", contextWindow: 272_000, maxTokens: 128_000, input: ["text", "image"], reasoning: true },
      { id: "deepseek-v3-2-volc", contextWindow: 96_000, maxTokens: 32_000, input: ["text"], reasoning: true },
      { id: "glm-5.0", contextWindow: 200_000, maxTokens: 48_000, input: ["text"], reasoning: true },
      { id: "kimi-k2.5", contextWindow: 164_000, maxTokens: 32_000, input: ["text", "image"], reasoning: true },
    ],
  );
});

test("product environment resolution matches CodeBuddy Code 2.125.0 domain rules", () => {
  assert.equal(
    resolveCodeBuddyProductEnvironment("www.codebuddy.ai"),
    "external",
  );
  assert.equal(
    resolveCodeBuddyProductEnvironment("www.codebuddy.cn"),
    "internal",
  );
  assert.equal(
    resolveCodeBuddyProductEnvironment("tencent.sso.codebuddy.cn"),
    "ioa",
  );
  assert.equal(
    resolveCodeBuddyProductEnvironment("acme.sso.codebuddy.cn"),
    "cloudhosted",
  );
  assert.equal(
    resolveCodeBuddyProductEnvironment("codebuddy.corp.example"),
    "selfhosted",
  );
});

test("source does not use compatibility-generation auth callback identifiers", async () => {
  const source = await readFile(
    new URL("../src/codebuddy.ts", import.meta.url),
    "utf8",
  );
  const forbidden = [
    "getApiKey",
    "onAuth",
    "onPrompt",
    "onSelect",
    "onDeviceCode",
    "OAuthLoginCallbacks",
  ];
  for (const identifier of forbidden) {
    assert.equal(source.includes(identifier), false, identifier);
  }
});

const OAUTH_CREDENTIAL: OAuthCredential = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: 9_000_000,
  baseUrl: "https://www.codebuddy.ai",
  domain: "www.codebuddy.ai",
  uid: "user-9",
  enterpriseId: "ent-9",
};

function refreshContext(
  overrides: Partial<Parameters<typeof fetchCodeBuddyModels>[0]> = {},
) {
  return {
    credential: OAUTH_CREDENTIAL,
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  } as Parameters<typeof fetchCodeBuddyModels>[0];
}

test("fetchCodeBuddyModels discovers enterprise models with the official response envelope", async () => {
  let call: RequestCall | undefined;
  const diagnostics: Array<{
    event: string;
    details: Record<string, unknown>;
  }> = [];
  const models = await fetchCodeBuddyModels(refreshContext(), {
    pluginVersion: "2.125.0-test",
    debug: (event, details) => diagnostics.push({ event, details }),
    fetch: async (input, init = {}) => {
      call = { url: String(input), init };
      return jsonResponse({
        code: 0,
        msg: "OK",
        requestId: "request-models-1",
        data: [
          {
            id: "glm-5.2",
            name: "GLM-5.2",
            maxInputTokens: 200_000,
            maxOutputTokens: 48_000,
            supportsImages: false,
            supportsToolCall: true,
            supportsReasoning: true,
            tags: ["chat"],
          },
          { name: "no-id-skipped" },
        ],
      });
    },
  });

  assert.ok(call);
  assert.equal(
    call.url,
    "https://www.codebuddy.ai/console/enterprises/ent-9/config/models",
  );
  assert.equal(call.init.method, "GET");
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("Authorization"), "Bearer access-token");
  assert.equal(headers.get("x-domain"), "www.codebuddy.ai");
  assert.equal(headers.get("x-user-id"), "user-9");
  assert.equal(headers.get("x-enterprise-id"), "ent-9");
  assert.equal(headers.get("x-tenant-id"), "ent-9");
  assert.equal(headers.get("x-product"), "SaaS");
  assert.equal(
    headers.get("User-Agent"),
    "CLI/2.125.0-test CodeBuddy/2.125.0-test",
  );

  assert.equal(models.length, 16);
  const model = models.find(({ id }) => id === "glm-5.2");
  assert.ok(model);
  assert.equal(model.id, "glm-5.2");
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 48_000);
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.reasoning, true);
  assert.equal(model.baseUrl, "https://www.codebuddy.ai/v2");

  assert.deepEqual(
    diagnostics.map(({ event }) => event),
    [
      "models.refresh.start",
      "models.cloud_config.request",
      "models.cloud_config.http_response",
      "models.cloud_config.response_body",
      "models.cloud_config.success",
      "models.enterprise.request",
      "models.enterprise.http_response",
      "models.enterprise.response_body",
      "models.enterprise.success",
    ],
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "models.enterprise.http_response")
      ?.details.status,
    200,
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "models.enterprise.response_body")
      ?.details.modelCount,
    2,
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "models.enterprise.success")
      ?.details.modelCount,
    16,
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "models.enterprise.success")
      ?.details.source,
    "product.json+enterprise-smart-merge",
  );
  const diagnosticText = JSON.stringify(diagnostics);
  assert.equal(diagnosticText.includes("access-token"), false);
  assert.equal(diagnosticText.includes("refresh-token"), false);
  assert.equal(diagnosticText.includes("ent-9"), false);
  assert.equal(diagnosticText.includes("www.codebuddy.ai"), false);
});

test("fetchCodeBuddyModels falls back offline/unauthenticated and refreshes personal Cloud Product", async () => {
  const offline = await fetchCodeBuddyModels(
    refreshContext({ allowNetwork: false }),
    { fetch: async () => jsonResponse({}) },
  );
  assert.equal(offline, BUILTIN_MODELS);

  const anonymous = await fetchCodeBuddyModels(
    refreshContext({ credential: undefined }),
    { fetch: async () => jsonResponse({}) },
  );
  assert.equal(anonymous, BUILTIN_MODELS);

  let personalCalled = false;
  const personal = await fetchCodeBuddyModels(
    refreshContext({
      credential: { ...OAUTH_CREDENTIAL, enterpriseId: undefined },
    }),
    {
      fetch: async () => {
        personalCalled = true;
        return jsonResponse({});
      },
    },
  );
  assert.equal(personal, BUILTIN_MODELS);
  assert.equal(personalCalled, true);
});

test("fetchCodeBuddyModels selects the official static catalog by credential domain", async () => {
  const cases = [
    {
      domain: "www.codebuddy.cn",
      expectedCount: 11,
      expectedFirst: "glm-5.2",
      expectedLast: "deepseek-v3-2-volc",
    },
    {
      domain: "tencent.sso.codebuddy.cn",
      expectedCount: 31,
      expectedFirst: "claude-sonnet-5",
      expectedLast: "deepseek-v4-pro-ioa",
    },
    {
      domain: "acme.sso.codebuddy.cn",
      expectedCount: 5,
      expectedFirst: "glm-4.7",
      expectedLast: "deepseek-v3-0324",
    },
    {
      domain: "codebuddy.corp.example",
      expectedCount: 1,
      expectedFirst: "codewise-chat",
      expectedLast: "codewise-chat",
    },
  ] as const;

  for (const testCase of cases) {
    const models = await fetchCodeBuddyModels(
      refreshContext({
        credential: {
          ...OAUTH_CREDENTIAL,
          baseUrl: `https://${testCase.domain}`,
          domain: testCase.domain,
          enterpriseId: undefined,
        },
      }),
      {
        fetch: async () =>
          jsonResponse({ code: 0, data: { productFeatures: {} } }),
      },
    );
    assert.equal(models.length, testCase.expectedCount, testCase.domain);
    assert.equal(models[0]?.id, testCase.expectedFirst, testCase.domain);
    assert.equal(models.at(-1)?.id, testCase.expectedLast, testCase.domain);
  }
});

test("empty cloud-hosted enterprise response keeps the cloud-hosted catalog", async () => {
  const diagnostics: Array<{
    event: string;
    details: Record<string, unknown>;
  }> = [];
  let call: RequestCall | undefined;
  const models = await fetchCodeBuddyModels(
    refreshContext({
      credential: {
        ...OAUTH_CREDENTIAL,
        baseUrl: "https://acme.sso.codebuddy.cn",
        domain: "acme.sso.codebuddy.cn",
      },
    }),
    {
      debug: (event, details) => diagnostics.push({ event, details }),
      fetch: async (input, init = {}) => {
        call = { url: String(input), init };
        return jsonResponse({ code: 0, data: [] });
      },
    },
  );

  assert.deepEqual(
    models.map(({ id }) => id),
    [
      "glm-4.7",
      "glm-4.6",
      "deepseek-v3-2-volc",
      "deepseek-v3.1",
      "deepseek-v3-0324",
    ],
  );
  const success = diagnostics.find(
    ({ event }) => event === "models.enterprise.success",
  );
  assert.equal(success?.details.productEnvironment, "cloudhosted");
  assert.equal(success?.details.source, "product.cloudhosted.json");
  assert.ok(call);
  assert.equal(
    new Headers(call.init.headers).get("x-product"),
    "Cloud-Hosted",
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "models.cloud_config.request")
      ?.details.xProduct,
    "Cloud-Hosted",
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "models.enterprise.request")
      ?.details.xProduct,
    "Cloud-Hosted",
  );
});

test("cloud config drives /model through remote models and craft relations without collecting git", async () => {
  const calls: RequestCall[] = [];
  const diagnostics: Array<{
    event: string;
    details: Record<string, unknown>;
  }> = [];
  const models = await fetchCodeBuddyModels(
    refreshContext({
      credential: {
        ...OAUTH_CREDENTIAL,
        baseUrl: "https://acme.sso.codebuddy.cn",
        domain: "acme.sso.codebuddy.cn",
      },
    }),
    {
      probeCloudConfig: true,
      debug: (event, details) => diagnostics.push({ event, details }),
      fetch: async (input, init = {}) => {
        const call = { url: String(input), init };
        calls.push(call);
        if (call.url.endsWith("/v3/config")) {
          return jsonResponse({
            code: 0,
            data: {
              models: [
                {
                  id: "glm-5.2",
                  name: "GLM-5.2",
                  maxInputTokens: 1_000_000,
                  maxOutputTokens: 48_000,
                  url: "https://model-gateway.internal/v2/chat/completions",
                },
              ],
              agents: [
                {
                  name: "craft",
                  models: ["glm-5.2"],
                  tags: ["model:craft"],
                },
              ],
            },
          });
        }
        return jsonResponse({ code: 0, data: [] });
      },
    },
  );

  assert.deepEqual(models.map(({ id }) => id), ["glm-5.2"]);
  assert.equal(models[0]?.contextWindow, 1_000_000);
  assert.equal(models[0]?.baseUrl, "https://model-gateway.internal/v2");
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    ["/v3/config", "/console/enterprises/ent-9/config/models"],
  );
  assert.equal(calls[0]?.url.includes("repos"), false);
  const summary = diagnostics.find(
    ({ event }) => event === "models.cloud_config.probe.summary",
  );
  assert.equal(summary?.details.modelCount, 1);
  assert.equal(summary?.details.agentCount, 1);
  assert.equal(JSON.stringify(summary).includes("model-gateway.internal"), false);
});

test("cloud config reproduces cli + craft + chat visibility and accepts only explicit repos", async () => {
  const calls: RequestCall[] = [];
  const diagnostics: Array<{
    event: string;
    details: Record<string, unknown>;
  }> = [];
  const repo = "https://git.example.test/acme/project.git";
  const models = await fetchCodeBuddyModels(
    refreshContext({
      credential: {
        ...OAUTH_CREDENTIAL,
        baseUrl: "https://acme.sso.codebuddy.cn",
        domain: "acme.sso.codebuddy.cn",
      },
    }),
    {
      cloudConfigRepos: [repo],
      debug: (event, details) => diagnostics.push({ event, details }),
      fetch: async (input, init = {}) => {
        const call = { url: String(input), init };
        calls.push(call);
        if (new URL(call.url).pathname === "/v3/config") {
          return jsonResponse({
            code: 0,
            data: {
              models: [
                { id: "glm-4.7", name: "Remote GLM" },
                { id: "glm-5.1" },
                { id: "deepseek-v4-pro", tags: ["chat"] },
              ],
              agents: [
                { name: "cli", models: ["glm-4.7"] },
                { name: "craft", models: ["glm-5.1"] },
              ],
            },
          });
        }
        return jsonResponse({
          code: 0,
          data: [
            {
              id: "enterprise-chat",
              name: "Enterprise Chat",
              maxInputTokens: 300_000,
              maxOutputTokens: 40_000,
              tags: ["chat"],
            },
          ],
        });
      },
    },
  );

  assert.deepEqual(models.map(({ id }) => id), [
    "enterprise-chat",
    "glm-4.7",
    "glm-5.1",
    "deepseek-v4-pro",
  ]);
  assert.equal(models.find(({ id }) => id === "glm-4.7")?.name, "Remote GLM");
  assert.equal(models.find(({ id }) => id === "glm-5.1")?.contextWindow, 200_000);
  assert.deepEqual(new URL(calls[0]?.url ?? "").searchParams.getAll("repos[]"), [repo]);
  assert.equal(JSON.stringify(diagnostics).includes(repo), false);
  assert.equal(
    diagnostics.find(({ event }) => event === "models.cloud_config.request")
      ?.details.explicitReposCount,
    1,
  );
});

test("fetchCodeBuddyModels uses the official static fallback for an empty enterprise catalog", async () => {
  const diagnostics: Array<{
    event: string;
    details: Record<string, unknown>;
  }> = [];
  const models = await fetchCodeBuddyModels(refreshContext(), {
    debug: (event, details) => diagnostics.push({ event, details }),
    fetch: async () => jsonResponse({ code: 0, data: [] }),
  });

  assert.equal(models, BUILTIN_MODELS);
  assert.equal(models.length, 15);
  assert.equal(
    diagnostics.find(
      ({ event }) => event === "models.enterprise.empty_fallback",
    )?.details.modelCount,
    15,
  );
  assert.equal(
    diagnostics.find(({ event }) => event === "models.enterprise.success")
      ?.details.source,
    "product.json",
  );
});

test("fetchCodeBuddyModels smart-merges enterprise overrides by model id", async () => {
  const models = await fetchCodeBuddyModels(refreshContext(), {
    fetch: async () =>
      jsonResponse({
        code: 0,
        data: [
          {
            id: "glm-5.0",
            name: "Enterprise GLM",
            maxOutputTokens: 64_000,
          },
          {
            id: "image-only-enterprise-model",
            name: "Image only",
            tags: ["image"],
          },
        ],
      }),
  });

  assert.equal(models.length, 15);
  const overridden = models.find(({ id }) => id === "glm-5.0");
  assert.ok(overridden);
  assert.equal(overridden.name, "Enterprise GLM");
  assert.equal(overridden.contextWindow, 200_000);
  assert.equal(overridden.maxTokens, 64_000);
  assert.equal(
    models.some(({ id }) => id === "image-only-enterprise-model"),
    false,
  );
});

test("fetchCodeBuddyModels records a sanitized HTTP error response", async () => {
  const diagnostics: Array<{
    event: string;
    details: Record<string, unknown>;
  }> = [];
  await assert.rejects(
    fetchCodeBuddyModels(refreshContext(), {
      debug: (event, details) => diagnostics.push({ event, details }),
      fetch: async (input) => {
        if (String(input).endsWith("/v3/config")) {
          return jsonResponse({ code: 0, data: { productFeatures: {} } });
        }
        return jsonResponse(
          {
            code: 14_016,
            msg: "enterprise is not activated",
            accessToken: "must-not-be-logged",
          },
          403,
        );
      },
    }),
    /HTTP 403/,
  );

  const errorResponse = diagnostics.find(
    ({ event }) => event === "models.enterprise.error_response",
  );
  assert.equal(errorResponse?.details.code, 14_016);
  assert.equal(
    errorResponse?.details.message,
    "enterprise is not activated",
  );
  assert.equal(JSON.stringify(diagnostics).includes("must-not-be-logged"), false);
  assert.equal(
    diagnostics.at(-1)?.event,
    "models.enterprise.error",
  );
});

test("fetchCodeBuddyModels rethrows on network failure so pi keeps the last catalog", async () => {
  // pi-ai keeps the previously discovered catalog when fetchModels throws;
  // returning the placeholder baseline here would clobber it on a blip.
  await assert.rejects(
    fetchCodeBuddyModels(refreshContext(), {
      fetch: async () => {
        throw new Error("network down");
      },
    }),
    /无法连接 CodeBuddy/,
  );
});

test("prepareCodeBuddyPayload never adds reasoning_effort to a non-reasoning model", () => {
  const nonReasoning = { ...BUILTIN_MODELS[0], reasoning: false };
  const out = prepareCodeBuddyPayload(
    { messages: [{ role: "user", content: "hi" }] },
    nonReasoning,
  ) as Record<string, unknown>;
  assert.equal("reasoning_effort" in out, false);

  const reasoningModel = { ...BUILTIN_MODELS[0], reasoning: true };
  const withEffort = prepareCodeBuddyPayload(
    { messages: [{ role: "user", content: "hi" }] },
    reasoningModel,
  ) as Record<string, unknown>;
  assert.equal(withEffort.reasoning_effort, "high");
});
