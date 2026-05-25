import { AI_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider } from "./providers.js";

const FALLBACK_PROVIDER_MODELS = {
  cc: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929"
  ],
  cx: ["gpt-5.2-codex", "gpt-5.2", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1"],
  gc: [
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash"
  ],
  gh: ["gpt-5", "gpt-5-mini", "gpt-5.1-codex", "claude-4.5-sonnet", "gemini-3-pro"],
  ag: ["gemini-3.5-flash", "gemini-3.1-pro-low", "gemini-3.1-pro-high", "gemini-3-flash"],
  if: [
    "qwen3-coder-plus",
    "kimi-k2.6",
    "kimi-k2.5",
    "kimi-k2",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-r1",
    "minimax-m2.7",
    "glm-4.7"
  ],
  qw: ["qwen3-coder-plus", "qwen3-coder-flash"],
  kr: ["claude-sonnet-4.6", "claude-haiku-4.5", "claude-sonnet-4.5"],
  openrouter: ["auto"],
  openai: ["gpt-5.2", "gpt-5.2-pro", "gpt-5.2-codex", "gpt-5-mini", "gpt-5-nano", "gpt-4.1"],
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  kimi: ["kimi-k2.6", "kimi-k2.5", "kimi-k2-thinking"],
  glm: ["glm-4.7", "glm-4.6v"],
  minimax: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.1"]
};

function normalizeModels(models = []) {
  return models
    .map((model) =>
      typeof model === "string" ? { id: model, name: model } : { ...model, name: model.name || model.id }
    )
    .filter((model) => model.id);
}

export const PROVIDER_MODELS = Object.entries(AI_PROVIDERS).reduce((acc, [id, provider]) => {
  const alias = provider.alias || id;
  const models = normalizeModels(
    provider.models || FALLBACK_PROVIDER_MODELS[alias] || FALLBACK_PROVIDER_MODELS[id] || []
  );
  acc[alias] = models;
  acc[id] = models;
  return acc;
}, {});

for (const [alias, models] of Object.entries(FALLBACK_PROVIDER_MODELS)) {
  if (!PROVIDER_MODELS[alias]) PROVIDER_MODELS[alias] = normalizeModels(models);
}

export const PROVIDER_ID_TO_ALIAS = Object.entries(AI_PROVIDERS).reduce((acc, [id, provider]) => {
  acc[id] = provider.alias || id;
  return acc;
}, {});

export function getProviderModels(aliasOrId) {
  return PROVIDER_MODELS[aliasOrId] || PROVIDER_MODELS[getProviderAlias(aliasOrId)] || [];
}

export function getModelsByProviderId(providerId) {
  if (isOpenAICompatibleProvider(providerId)) return [];
  return getProviderModels(providerId);
}

export function getDefaultModel(aliasOrId) {
  return getProviderModels(aliasOrId)[0]?.id || "";
}

export function isValidModel(aliasOrId, modelId) {
  const models = getProviderModels(aliasOrId);
  if (!models.length) return true;
  return models.some((model) => model.id === modelId);
}

export function findModelName(aliasOrId, modelId) {
  return getProviderModels(aliasOrId).find((model) => model.id === modelId)?.name || modelId;
}

export function getModelTargetFormat() {
  return "openai";
}

export function getModelStrip(modelId) {
  return modelId;
}

export function getModelUpstreamId(modelId) {
  return modelId;
}

export function getModelQuotaFamily(aliasOrId, modelId) {
  return `${aliasOrId}:${modelId}`;
}

export const AI_MODELS = Object.entries(PROVIDER_MODELS).flatMap(([alias, models]) =>
  models.map((model) => ({ provider: alias, model: model.id, name: model.name || model.id }))
);
