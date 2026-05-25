"use strict";

const PROVIDER_MODELS = {
  cc: [
    { id: "claude-opus-4-7" },
    { id: "claude-sonnet-4-6" },
    { id: "claude-haiku-4-5-20251001" },
    { id: "claude-opus-4-5-20251101" },
    { id: "claude-sonnet-4-5-20250929" }
  ],
  cx: [
    { id: "gpt-5.2-codex" },
    { id: "gpt-5.2" },
    { id: "gpt-5.1-codex-max" },
    { id: "gpt-5.1-codex" },
    { id: "gpt-5.1-codex-mini" },
    { id: "gpt-5.1" },
    { id: "gpt-5-codex" },
    { id: "gpt-5-codex-mini" }
  ],
  gc: [
    { id: "gemini-3.5-flash" },
    { id: "gemini-3.1-pro-preview" },
    { id: "gemini-3.1-pro-preview-customtools" },
    { id: "gemini-3.1-flash-lite" },
    { id: "gemini-3-flash-preview" },
    { id: "gemini-2.5-pro" },
    { id: "gemini-2.5-flash" },
    { id: "gemini-2.5-flash-lite" }
  ],
  qw: [{ id: "qwen3-coder-plus" }, { id: "qwen3-coder-flash" }, { id: "vision-model" }],
  if: [
    { id: "qwen3-coder-plus" },
    { id: "kimi-k2.6" },
    { id: "kimi-k2.5" },
    { id: "kimi-k2" },
    { id: "kimi-k2-thinking" },
    { id: "deepseek-v4-pro" },
    { id: "deepseek-v4-flash" },
    { id: "deepseek-r1" },
    { id: "deepseek-v3.2-chat" },
    { id: "deepseek-v3.2-reasoner" },
    { id: "minimax-m2.7" },
    { id: "minimax-m2" },
    { id: "glm-4.7" }
  ],
  ag: [
    { id: "gemini-3.5-flash" },
    { id: "gemini-3.1-pro-low" },
    { id: "gemini-3.1-pro-high" },
    { id: "gemini-3-flash" },
    { id: "gemini-2.5-flash" },
    { id: "claude-sonnet-4-6" },
    { id: "claude-sonnet-4-5" },
    { id: "claude-sonnet-4-5-thinking" },
    { id: "claude-opus-4-5-thinking" }
  ],
  gh: [
    { id: "gpt-5" },
    { id: "gpt-5-mini" },
    { id: "gpt-5.1-codex" },
    { id: "gpt-5.1-codex-max" },
    { id: "gpt-4.1" },
    { id: "claude-4.5-sonnet" },
    { id: "claude-4.5-opus" },
    { id: "claude-4.5-haiku" },
    { id: "gemini-3-pro" },
    { id: "gemini-3-flash" },
    { id: "gemini-2.5-pro" },
    { id: "grok-code-fast-1" }
  ],
  kr: [{ id: "claude-sonnet-4.6" }, { id: "claude-sonnet-4.5" }, { id: "claude-haiku-4.5" }],
  cursor: [{ id: "cursor-agent" }],
  gl: [{ id: "gitlab-duo" }],
  kc: [{ id: "free-model" }],
  kmc: [{ id: "kimi-coding" }],
  cb: [{ id: "codebuddy" }],
  openai: [
    { id: "gpt-5.2" },
    { id: "gpt-5.2-pro" },
    { id: "gpt-5.2-codex" },
    { id: "gpt-5-mini" },
    { id: "gpt-5-nano" },
    { id: "gpt-4.1" },
    { id: "gpt-4o" },
    { id: "gpt-4o-mini" }
  ],
  anthropic: [
    { id: "claude-opus-4-7" },
    { id: "claude-sonnet-4-6" },
    { id: "claude-haiku-4-5-20251001" },
    { id: "claude-sonnet-4-20250514" },
    { id: "claude-opus-4-20250514" }
  ],
  gemini: [
    { id: "gemini-3.5-flash" },
    { id: "gemini-3.1-pro-preview" },
    { id: "gemini-3.1-flash-lite" },
    { id: "gemini-3-flash-preview" },
    { id: "gemini-2.5-pro" },
    { id: "gemini-2.5-flash" },
    { id: "gemini-2.5-flash-lite" }
  ],
  openrouter: [{ id: "auto" }],
  glm: [{ id: "glm-4.7" }, { id: "glm-4.6v" }],
  kimi: [{ id: "kimi-k2.6" }, { id: "kimi-k2.5" }, { id: "kimi-k2-thinking" }],
  minimax: [{ id: "MiniMax-M2.7" }, { id: "MiniMax-M2.7-highspeed" }, { id: "MiniMax-M2.5" }],
  deepseek: [
    { id: "deepseek-v4-pro" },
    { id: "deepseek-v4-flash" },
    { id: "deepseek-chat" },
    { id: "deepseek-reasoner" }
  ]
};

const OAUTH_PROVIDERS = {
  claude: { id: "claude", alias: "cc", name: "Claude Code" },
  codex: { id: "codex", alias: "cx", name: "OpenAI Codex" },
  "gemini-cli": { id: "gemini-cli", alias: "gc", name: "Gemini CLI" },
  github: { id: "github", alias: "gh", name: "GitHub Copilot" },
  antigravity: { id: "antigravity", alias: "ag", name: "Antigravity" },
  iflow: { id: "iflow", alias: "if", name: "iFlow AI" },
  qwen: { id: "qwen", alias: "qw", name: "Qwen Code" },
  kiro: { id: "kiro", alias: "kr", name: "Kiro AI" },
  cursor: { id: "cursor", alias: "cursor", name: "Cursor IDE" },
  gitlab: { id: "gitlab", alias: "gl", name: "GitLab Duo" },
  kilocode: { id: "kilocode", alias: "kc", name: "Kilo Code" },
  "kimi-coding": { id: "kimi-coding", alias: "kmc", name: "Kimi Coding" },
  codebuddy: { id: "codebuddy", alias: "cb", name: "CodeBuddy" }
};

const APIKEY_PROVIDERS = {
  openrouter: { id: "openrouter", name: "OpenRouter" },
  glm: { id: "glm", name: "GLM Coding" },
  minimax: { id: "minimax", name: "Minimax Coding" },
  kimi: { id: "kimi", name: "Kimi Coding" },
  deepseek: { id: "deepseek", name: "DeepSeek" },
  openai: { id: "openai", name: "OpenAI" },
  anthropic: { id: "anthropic", name: "Anthropic" },
  gemini: { id: "gemini", name: "Gemini" }
};

const PROVIDER_ALIAS_TO_ID = {
  cc: "claude",
  cx: "codex",
  gc: "gemini-cli",
  gh: "github",
  ag: "antigravity",
  if: "iflow",
  qw: "qwen",
  kr: "kiro",
  cursor: "cursor",
  cu: "cursor",
  gl: "gitlab",
  kc: "kilocode",
  kmc: "kimi-coding",
  cb: "codebuddy",
  bigmodel: "glm",
  zhipu: "glm",
  moonshot: "kimi"
};

function modelsForProvider(provider) {
  const record = OAUTH_PROVIDERS[provider] || APIKEY_PROVIDERS[provider] || {};
  const key = record.alias || provider;
  return (PROVIDER_MODELS[key] || []).map((model) => ({ ...model }));
}

function catalogProvider(provider, authType, extra = {}) {
  const alias = provider.alias || provider.id;
  const models = modelsForProvider(provider.id);
  return {
    id: provider.id,
    label: provider.name,
    name: provider.name,
    alias,
    authType,
    category: authType === "oauth" ? "oauth" : "apikey",
    modelPrefixes: [alias].filter(Boolean),
    models,
    sampleModels: models.slice(0, 5).map((model) => `${alias}/${model.id}`),
    ...extra
  };
}

function providerCatalog({ proxyTargets = {} } = {}) {
  const oauthProviders = Object.values(OAUTH_PROVIDERS).map((provider) =>
    catalogProvider(provider, "oauth", {
      proxySupported: provider.id === "codex",
      oauthSupported: true
    })
  );
  const apiKeyProviders = Object.values(APIKEY_PROVIDERS).map((provider) =>
    catalogProvider(provider, "apikey", {
      proxySupported: Boolean(proxyTargets[provider.id]),
      defaultUrl: proxyTargets[provider.id] && proxyTargets[provider.id].url
    })
  );
  return {
    oauthProviders,
    apiKeyProviders,
    providers: [...oauthProviders, ...apiKeyProviders],
    providerModels: PROVIDER_MODELS
  };
}

function normalizeCatalogProvider(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return PROVIDER_ALIAS_TO_ID[raw] || raw;
}

function knownProvider(provider) {
  const id = normalizeCatalogProvider(provider);
  return OAUTH_PROVIDERS[id] || APIKEY_PROVIDERS[id] || null;
}

function providerAuthType(provider) {
  const id = normalizeCatalogProvider(provider);
  if (OAUTH_PROVIDERS[id]) return "oauth";
  if (APIKEY_PROVIDERS[id]) return "apikey";
  return "";
}

module.exports = {
  APIKEY_PROVIDERS,
  OAUTH_PROVIDERS,
  PROVIDER_ALIAS_TO_ID,
  PROVIDER_MODELS,
  knownProvider,
  modelsForProvider,
  normalizeCatalogProvider,
  providerAuthType,
  providerCatalog
};
