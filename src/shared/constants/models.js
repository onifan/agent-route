import { AI_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider } from "./providers.js";

function normalizeModels(models = []) {
  return models
    .map((model) =>
      typeof model === "string" ? { id: model, name: model } : { ...model, name: model.name || model.id }
    )
    .filter((model) => model.id);
}

export const PROVIDER_MODELS = Object.entries(AI_PROVIDERS).reduce((acc, [id, provider]) => {
  const alias = provider.alias || id;
  const models = normalizeModels(provider.models || []);
  acc[alias] = models;
  acc[id] = models;
  return acc;
}, {});

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
