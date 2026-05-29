// Model API provider definitions.

export const MODEL_API_PROVIDERS = {
  openai: {
    id: "openai",
    alias: "openai",
    name: "OpenAI",
    icon: "api",
    color: "#0EA5E9",
    protocol: "openai",
    modelPrefixes: ["openai/"],
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.5", "gpt-5.2", "gpt-5-mini"],
    serviceKinds: ["llm"]
  },
  claude: {
    id: "claude",
    alias: "claude",
    name: "Claude",
    icon: "smart_toy",
    color: "#D97706",
    protocol: "anthropic",
    modelPrefixes: ["claude/", "anthropic/"],
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
    serviceKinds: ["llm"]
  },
  gemini: {
    id: "gemini",
    alias: "gemini",
    name: "Gemini",
    icon: "auto_awesome",
    color: "#4285F4",
    protocol: "openai",
    modelPrefixes: ["gemini/", "gc/"],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
    serviceKinds: ["llm"]
  },
  grok: {
    id: "grok",
    alias: "grok",
    name: "Grok",
    icon: "bolt",
    color: "#111827",
    protocol: "openai",
    modelPrefixes: ["grok/", "xai/"],
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4", "grok-3", "grok-code-fast-1"],
    serviceKinds: ["llm"]
  },
  deepseek: {
    id: "deepseek",
    alias: "deepseek",
    name: "DeepSeek",
    icon: "travel_explore",
    color: "#2563EB",
    protocol: "openai",
    modelPrefixes: ["deepseek/"],
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    serviceKinds: ["llm"]
  },
  qwen: {
    id: "qwen",
    alias: "qwen",
    name: "Qwen",
    icon: "psychology",
    color: "#10B981",
    protocol: "openai",
    modelPrefixes: ["qwen/", "qw/"],
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max", "qwen3-coder-plus"],
    serviceKinds: ["llm"]
  },
  glm: {
    id: "glm",
    alias: "glm",
    name: "GLM",
    icon: "neurology",
    color: "#7C3AED",
    protocol: "openai",
    modelPrefixes: ["glm/", "zhipu/", "bigmodel/"],
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.1", "glm-4.7", "glm-4.5"],
    serviceKinds: ["llm"]
  },
  kimi: {
    id: "kimi",
    alias: "kimi",
    name: "Kimi",
    icon: "dark_mode",
    color: "#1E3A8A",
    protocol: "openai",
    modelPrefixes: ["kimi/", "moonshot/"],
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2.5", "kimi-k2-thinking", "moonshot-v1-128k"],
    serviceKinds: ["llm"]
  }
};

export const FREE_PROVIDERS = {};
export const FREE_TIER_PROVIDERS = {};
export const OAUTH_PROVIDERS = {};
export const APIKEY_PROVIDERS = MODEL_API_PROVIDERS;
export const WEB_COOKIE_PROVIDERS = {};
export const AI_PROVIDERS = MODEL_API_PROVIDERS;

export const AUTH_METHODS = {
  apikey: { id: "apikey", name: "API Key", icon: "key" }
};

export function getProviderByAlias(alias) {
  for (const provider of Object.values(AI_PROVIDERS)) {
    if (provider.alias === alias || provider.id === alias) return provider;
    if (provider.modelPrefixes?.some((prefix) => prefix.replace(/\/$/, "") === alias)) return provider;
  }
  return null;
}

export function resolveProviderId(aliasOrId) {
  return getProviderByAlias(aliasOrId)?.id || aliasOrId;
}

export function getProviderAlias(providerId) {
  return AI_PROVIDERS[providerId]?.alias || providerId;
}

export const ALIAS_TO_ID = Object.values(AI_PROVIDERS).reduce((acc, provider) => {
  acc[provider.alias] = provider.id;
  return acc;
}, {});

export const ID_TO_ALIAS = Object.values(AI_PROVIDERS).reduce((acc, provider) => {
  acc[provider.id] = provider.alias;
  return acc;
}, {});

export function isOpenAICompatibleProvider(providerId) {
  const id = resolveProviderId(providerId);
  return AI_PROVIDERS[id]?.protocol === "openai";
}

export function isAnthropicCompatibleProvider(providerId) {
  const id = resolveProviderId(providerId);
  return AI_PROVIDERS[id]?.protocol === "anthropic";
}

export function isCustomProvider() {
  return false;
}

export function isCustomEmbeddingProvider() {
  return false;
}

export function getProvidersByKind(kind) {
  return Object.values(AI_PROVIDERS).filter((provider) => (provider.serviceKinds || ["llm"]).includes(kind));
}

export const USAGE_SUPPORTED_PROVIDERS = Object.keys(AI_PROVIDERS);
export const USAGE_APIKEY_PROVIDERS = Object.keys(AI_PROVIDERS);
