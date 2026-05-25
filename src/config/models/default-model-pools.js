"use strict";

const COMMANDER_MODEL_OPTIONS = [{ id: "gpt5.5", name: "gpt5.5" }];

const DEFAULT_COMMANDER_MODELS = COMMANDER_MODEL_OPTIONS.map((model) => model.id);

const DEFAULT_MODEL_POOLS = {
  commander: DEFAULT_COMMANDER_MODELS,
  strong: [
    "openrouter/anthropic/claude-sonnet-4.5",
    "openrouter/google/gemini-2.5-pro",
    "openrouter/deepseek/deepseek-r1-0528",
    "openrouter/qwen/qwen3-235b-a22b",
    "openrouter/moonshotai/kimi-k2"
  ],
  coding: [
    "openrouter/qwen/qwen3-coder:free",
    "openrouter/deepseek/deepseek-r1-0528:free",
    "openrouter/deepseek/deepseek-chat-v3.1:free",
    "openrouter/qwen/qwen3-32b:free",
    "openrouter/mistralai/mistral-small-3.2-24b-instruct:free"
  ],
  free: [
    "gc/gemini-3-flash-preview",
    "gemini/gemini-3-flash-preview",
    "gemini/gemini-3.1-flash-lite-preview",
    "gemini/gemma-4-31b-it",
    "gemini/gemini-2.5-flash",
    "gemini/gemini-2.5-flash-lite",
    "openrouter/z-ai/glm-4.5-air:free",
    "openrouter/openai/gpt-oss-120b:free",
    "openrouter/qwen/qwen3-next-80b-a3b-instruct:free",
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    "openrouter/nousresearch/hermes-3-llama-3.1-405b:free",
    "openrouter/deepseek/deepseek-v4-flash:free",
    "openrouter/minimax/minimax-m2.5:free",
    "openrouter/google/gemma-4-31b-it:free",
    "openrouter/google/gemma-4-26b-a4b-it:free",
    "openrouter/arcee-ai/trinity-large-thinking:free",
    "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
    "openrouter/openai/gpt-oss-20b:free",
    "openrouter/poolside/laguna-m.1:free",
    "openrouter/poolside/laguna-xs.2:free",
    "openrouter/baidu/cobuddy:free",
    "openrouter/liquid/lfm-2.5-1.2b-thinking:free",
    "openrouter/liquid/lfm-2.5-1.2b-instruct:free",
    "openrouter/moonshotai/kimi-k2:free",
    "openrouter/tngtech/deepseek-r1t2-chimera:free",
    "openrouter/nousresearch/deephermes-3-llama-3-8b-preview:free",
    "openrouter/microsoft/mai-ds-r1:free",
    "oc/kimi-k2.6",
    "oc/kimi-k2.5",
    "oc/qwen3.6-plus",
    "oc/minimax-m2.7",
    "oc/glm-5.1"
  ],
  "codex-cli": ["codex-cli"]
};

module.exports = {
  COMMANDER_MODEL_OPTIONS,
  DEFAULT_COMMANDER_MODELS,
  DEFAULT_MODEL_POOLS
};
