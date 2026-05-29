"use strict";

const COMMANDER_MODEL_OPTIONS = [{ id: "gpt5.5", name: "gpt5.5" }];

const DEFAULT_COMMANDER_MODELS = COMMANDER_MODEL_OPTIONS.map((model) => model.id);

const DEFAULT_MODEL_POOLS = {
  commander: DEFAULT_COMMANDER_MODELS,
  strong: [
    "openai/gpt-5.5",
    "claude/claude-sonnet-4-5",
    "gemini/gemini-2.5-pro",
    "deepseek/deepseek-v4-pro",
    "glm/glm-5.1",
    "qwen/qwen-plus",
    "grok/grok-4",
    "kimi/kimi-k2.5"
  ],
  coding: [
    "gemini/gemini-2.5-flash",
    "deepseek/deepseek-v4-flash",
    "glm/glm-4.7",
    "qwen/qwen3-coder-plus",
    "kimi/kimi-k2.5"
  ],
  free: [
    "gemini/gemini-2.5-flash",
    "gemini/gemini-2.5-flash-lite",
    "deepseek/deepseek-v4-flash",
    "glm/glm-4.5",
    "qwen/qwen-plus",
    "kimi/moonshot-v1-128k"
  ],
  "codex-cli": ["codex-cli"]
};

module.exports = {
  COMMANDER_MODEL_OPTIONS,
  DEFAULT_COMMANDER_MODELS,
  DEFAULT_MODEL_POOLS
};
