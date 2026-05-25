"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const checks = [];

function abs(file) {
  return path.join(root, file);
}

function ok(name, detail = "") {
  checks.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? `: ${detail}` : ""}`);
}

function fail(name, detail = "") {
  checks.push({ name, ok: false, detail });
  throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

function requireFile(file, label = file) {
  if (!fs.existsSync(abs(file)) || !fs.statSync(abs(file)).isFile()) {
    fail(`Missing ${label}`, file);
  }
  ok(`Found ${label}`, file);
}

function requireDir(dir, label = dir) {
  if (!fs.existsSync(abs(dir)) || !fs.statSync(abs(dir)).isDirectory()) {
    fail(`Missing ${label}`, dir);
  }
  ok(`Found ${label}`, dir);
}

function requireText(file, pattern, label) {
  const text = fs.readFileSync(abs(file), "utf8");
  if (!pattern.test(text)) fail(label, file);
  ok(label, file);
}

function copyDir(source, target, label) {
  const from = abs(source);
  const to = abs(target);
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
    fail(`Missing source for ${label}`, source);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  ok(`Synced ${label}`, `${source} -> ${target}`);
}

function syncStandaloneAssets() {
  copyDir(
    ".next-cli-build/static",
    ".next-cli-build/standalone/.next-cli-build/static",
    "standalone Next static assets"
  );
  copyDir("public", ".next-cli-build/standalone/public", "standalone public assets");
}

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ["--check", abs(file)], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`Syntax check failed for ${file}`, message);
  }
  ok(`Syntax check ${file}`);
}

function writeReport() {
  const outDir = abs(".cache");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "build-report.json"),
    JSON.stringify(
      {
        version: 1,
        builtAt: new Date().toISOString(),
        mode: "packaged-standalone-validation",
        checks
      },
      null,
      2
    )
  );
}

function main() {
  console.log("AgentRoute Studio build validation");
  syncStandaloneAssets();
  requireDir(".next-cli-build", "Next standalone build output");
  requireFile(".next-cli-build/BUILD_ID", "Next build id");
  requireDir(".next-cli-build/static", "Next static assets");
  requireDir(".next-cli-build/standalone/.next-cli-build/static", "Standalone Next static assets");
  requireDir(".next-cli-build/standalone/public", "Standalone public assets");
  requireFile(".next-cli-build/server/app/api/agent-route/run/route.js", "Agent Route API route bundle");
  requireFile(".next-cli-build/server/app/agent-route/page.js", "AgentRoute Studio page bundle");
  requireFile(".next-cli-build/server/app/page.js", "AgentRoute Studio root page bundle");
  requireFile(".next-cli-build/server/app/dashboard/page.js", "Legacy dashboard redirect bundle");
  requireFile(".next-cli-build/server/app/dashboard/providers/page.js", "Provider dashboard page bundle");
  requireFile(".next-cli-build/server/app/dashboard/providers/new/page.js", "Provider creation page bundle");
  requireFile(".next-cli-build/server/app/dashboard/providers/[id]/page.js", "Provider detail page bundle");
  requireFile(".next-cli-build/server/app/callback/page.js", "OAuth callback page bundle");
  requireFile(".next-cli-build/server/app/api/providers/route.js", "Provider API route bundle");
  requireFile(".next-cli-build/server/app/api/provider-nodes/route.js", "Provider node API route bundle");
  requireFile(
    ".next-cli-build/server/app/dashboard/agent-route/page.js",
    "Legacy dashboard AgentRoute redirect bundle"
  );
  requireFile(".next-cli-build/server/app/login/page.js", "Legacy login redirect bundle");
  requireFile("node_modules/next/dist/bin/next", "Next CLI");
  requireDir("node_modules/@next", "Next native packages");
  requireFile("app/agent-route/page.js", "AgentRoute Studio route source");
  requireFile("app/agent-route/studio.js", "AgentRoute Studio client source");
  requireFile("app/dashboard/page.js", "Legacy dashboard redirect source");
  requireFile("app/dashboard/providers/page.js", "Provider dashboard page source");
  requireFile("app/dashboard/providers/new/page.js", "Provider creation page source");
  requireFile("app/dashboard/providers/[id]/page.js", "Provider detail page source");
  requireFile("app/callback/page.js", "OAuth callback page source");
  requireFile("app/api/providers/route.js", "Provider API source");
  requireFile("app/api/provider-nodes/route.js", "Provider node API source");
  requireFile("app/dashboard/agent-route/page.js", "Legacy dashboard AgentRoute redirect source");
  requireFile("app/login/page.js", "Legacy login redirect source");
  requireFile("app/api/agent-route/run/route.js", "AgentRoute Studio API source");
  requireText(
    "app/agent-route/studio.js",
    /function TaskGraphPanel/,
    "AgentRoute Studio includes execution graph view"
  );
  requireText("app/agent-route/studio.js", /function TaskCard/, "AgentRoute Studio includes task lifecycle view");
  requireText("app/agent-route/studio.js", /loadMemories/, "AgentRoute Studio includes Memory view");
  requireText(
    "app/agent-route/studio.js",
    /function RecoveryPanel/,
    "AgentRoute Studio includes recovery monitor view"
  );
  requireFile("src/agent-route.js", "Agent Route runtime");
  requireFile("src/agent-route-task-runtime.js", "Task runtime");
  requireFile("src/agent-route-memory-runtime.js", "Memory runtime");
  requireFile("src/agent-route-risk-engine.js", "Risk engine runtime");
  requireFile("src/agent-route-verification-engine.js", "Verification engine runtime");
  requireFile("src/agent-route-worker-evidence.js", "Worker evidence runtime");
  requireFile("src/agent-route-budget-governor.js", "Budget governor runtime");
  requireFile("src/agent-route-strategy-engine.js", "Strategy engine runtime");
  requireFile("src/agent-route-dependency-engine.js", "Dependency engine runtime");
  requireDir("src/core/router", "Core router module");
  requireDir("src/agent/orchestrator", "Agent orchestrator module");
  requireDir("src/agent/tasks", "Agent tasks module");
  requireDir("src/agent/risk", "Agent risk module");
  requireDir("src/agent/verification", "Agent verification module");
  requireDir("src/agent/corrective", "Agent corrective module");
  requireDir("src/agent/action-decision", "Agent action decision module");
  requireDir("src/agent/action-learning", "Agent action learning module");
  requireDir("src/agent/decision-attribution", "Agent decision attribution module");
  requireDir("src/agent/budget", "Agent budget module");
  requireDir("src/agent/graph", "Agent graph module");
  requireDir("src/agent/observability", "Agent observability module");
  requireDir("src/agent/evidence", "Agent evidence module");
  requireDir("src/agent/recovery", "Agent recovery module");
  requireDir("src/config/prompts", "Prompt config module");
  requireDir("src/config/models", "Model config module");
  requireDir("src/config/policies", "Policy config module");
  requireDir("src/config/loader", "Config loader module");
  requireDir("src/storage/repositories", "Storage repositories module");
  requireDir("src/security", "Security helper module");

  [
    "src/agent-route.js",
    "src/agent-route-task-runtime.js",
    "src/agent-route-memory-runtime.js",
    "src/agent-route-risk-engine.js",
    "src/agent-route-verification-engine.js",
    "src/agent-route-worker-evidence.js",
    "src/agent-route-budget-governor.js",
    "src/agent-route-strategy-engine.js",
    "src/agent-route-dependency-engine.js",
    "src/agent/tasks/runtime.js",
    "src/agent/memory/runtime.js",
    "src/agent/risk/engine.js",
    "src/agent/verification/engine.js",
    "src/agent/verification/evidence.js",
    "src/agent/verification/authenticity/authenticity-engine.js",
    "src/agent/verification/authenticity/authenticity-normalizer.js",
    "src/agent/verification/authenticity/authenticity-rules.js",
    "src/agent/verification/authenticity/authenticity-score.js",
    "src/agent/verification/authenticity/index.js",
    "src/agent/verification/file-intent/file-intent-detector.js",
    "src/agent/verification/file-intent/file-patterns.js",
    "src/agent/verification/file-intent/index.js",
    "src/agent/verification/file-intent/intent-normalizer.js",
    "src/agent/corrective/corrective-actions.js",
    "src/agent/corrective/corrective-engine.js",
    "src/agent/corrective/corrective-normalizer.js",
    "src/agent/corrective/corrective-rules.js",
    "src/agent/corrective/index.js",
    "src/agent/action-decision/decision-engine.js",
    "src/agent/action-decision/decision-normalizer.js",
    "src/agent/action-decision/decision-rules.js",
    "src/agent/action-decision/decision-score.js",
    "src/agent/action-decision/index.js",
    "src/agent/action-learning/learning-engine.js",
    "src/agent/action-learning/learning-metrics.js",
    "src/agent/action-learning/learning-normalizer.js",
    "src/agent/action-learning/learning-store.js",
    "src/agent/action-learning/index.js",
    "src/agent/decision-attribution/attribution-engine.js",
    "src/agent/decision-attribution/attribution-normalizer.js",
    "src/agent/decision-attribution/attribution-rules.js",
    "src/agent/decision-attribution/attribution-store.js",
    "src/agent/decision-attribution/index.js",
    "src/agent/budget/governor.js",
    "src/agent/strategies/engine.js",
    "src/agent/graph/dependency-engine.js",
    "src/agent/observability/runtime.js",
    "src/agent/evidence/browser-evidence-normalizer.js",
    "src/agent/evidence/evidence-sanitizer.js",
    "src/agent/evidence/evidence-types.js",
    "src/agent/evidence/index.js",
    "src/agent/evidence/worker-evidence-normalizer.js",
    "src/agent/recovery/index.js",
    "src/agent/recovery/recovery-events.js",
    "src/agent/recovery/recovery-rules.js",
    "src/agent/recovery/recovery-summary.js",
    "src/agent/recovery/runtime-recovery.js",
    "src/core/router/runtime.js",
    "src/core/router/index.js",
    "src/core/providers/provider-catalog.js",
    "src/core/providers/provider-settings-store.js",
    "src/core/providers/oauth-runtime.js",
    "src/core/providers/index.js",
    "app/api/provider-route-helpers.js",
    "app/api/providers/route.js",
    "app/api/providers/[id]/route.js",
    "app/api/providers/[id]/test/route.js",
    "app/api/providers/[id]/models/route.js",
    "app/api/providers/test-batch/route.js",
    "app/api/providers/validate/route.js",
    "app/api/provider-nodes/route.js",
    "app/api/provider-nodes/[id]/route.js",
    "app/api/provider-nodes/validate/route.js",
    "app/api/oauth/[provider]/[action]/route.js",
    "src/agent/orchestrator/runtime.js",
    "src/agent/orchestrator/action-api.js",
    "src/agent/orchestrator/codex-cli-runner.js",
    "src/agent/orchestrator/content-utils.js",
    "src/agent/orchestrator/event-stream.js",
    "src/agent/orchestrator/finalizer.js",
    "src/agent/orchestrator/goal-setup.js",
    "src/agent/orchestrator/initial-planning.js",
    "src/agent/orchestrator/loop-controller.js",
    "src/agent/orchestrator/model-routing-service.js",
    "src/agent/orchestrator/planner.js",
    "src/agent/orchestrator/protocol.js",
    "src/agent/orchestrator/prompt-service.js",
    "src/agent/orchestrator/result-normalizer.js",
    "src/agent/orchestrator/budget-service.js",
    "src/agent/orchestrator/risk-gate-service.js",
    "src/agent/orchestrator/review-iteration.js",
    "src/agent/orchestrator/review-loop.js",
    "src/agent/orchestrator/review-runner.js",
    "src/agent/orchestrator/task-appender.js",
    "src/agent/orchestrator/task-context.js",
    "src/agent/orchestrator/task-executor.js",
    "src/agent/orchestrator/task-gates.js",
    "src/agent/orchestrator/task-state-updater.js",
    "src/agent/orchestrator/task-verification-step.js",
    "src/agent/orchestrator/web-tool-worker.js",
    "src/agent/orchestrator/worker-dispatcher.js",
    "src/agent/orchestrator/worker-result-processor.js",
    "src/agent/orchestrator/worker-runner.js",
    "src/agent/orchestrator/index.js",
    "src/config/prompts/default-prompt-settings.js",
    "src/config/prompts/index.js",
    "src/config/models/default-model-pools.js",
    "src/config/models/model-tiers.js",
    "src/config/models/index.js",
    "src/config/loader/config-loader.js",
    "src/config/loader/config-merge.js",
    "src/config/loader/config-sanitizer.js",
    "src/config/loader/config-validator.js",
    "src/config/loader/index.js",
    "src/config/loader/runtime-config.js",
    "src/config/policies/browser-tool-policy.js",
    "src/config/policies/budget-policy.js",
    "src/config/policies/human-approval-policy.js",
    "src/config/policies/risk-policy.js",
    "src/config/policies/recovery-policy.js",
    "src/config/policies/runtime-policy.js",
    "src/config/policies/unattended-policy.js",
    "src/config/policies/verification-policy.js",
    "src/config/policies/index.js",
    "src/shared/utils/agent-home.js",
    "src/shared/types/agent-route-types.js",
    "src/storage/repositories/artifact-repository.js",
    "src/storage/repositories/budget-repository.js",
    "src/storage/repositories/event-repository.js",
    "src/storage/repositories/goal-repository.js",
    "src/storage/repositories/index.js",
    "src/storage/repositories/json-file-store.js",
    "src/storage/repositories/memory-repository.js",
    "src/storage/repositories/model-stats-repository.js",
    "src/storage/repositories/record-store.js",
    "src/storage/repositories/risk-repository.js",
    "src/storage/repositories/strategy-repository.js",
    "src/storage/repositories/task-event-repository.js",
    "src/storage/repositories/task-repository.js",
    "src/storage/repositories/task-store.js",
    "src/storage/repositories/verification-repository.js",
    "src/storage-repositories.test.js",
    "src/config-loader.test.js",
    "src/provider-oauth-runtime.test.js",
    "src/tools/browser/actions.js",
    "src/tools/browser/adapter-mock.js",
    "src/tools/browser/adapter-playwright.js",
    "src/tools/browser/index.js",
    "src/tools/browser/result-normalizer.js",
    "src/tools/browser/runtime.js",
    "src/tools/browser/screenshots.js",
    "src/tools/browser/session-manager.js",
    "src/tools/browser/snapshots.js",
    "src/tools/web/index.js",
    "src/tools/web/runtime.js",
    "src/tools/documents/index.js",
    "src/tools/documents/renderer.js",
    "src/tools/codex-cli/index.js",
    "src/tools/codex-cli/log-filter.js",
    "src/tools/codex-cli/result-parser.js",
    "src/tools/codex-cli/runtime.js",
    "src/tools/codex-cli/temp-workspace.js",
    "src/tools/files/file-store.js",
    "src/tools/files/hashing.js",
    "src/tools/files/index.js",
    "src/tools/files/temp-files.js",
    "src/tools/shell/command-result.js",
    "src/tools/shell/executor.js",
    "src/tools/shell/index.js",
    "src/security/cors.js",
    "src/security/tool-risk-gate.js",
    "src/security/request-auth.js",
    "src/lib/updater/updater.js",
    "scripts/start-production.js",
    "scripts/create-api-key.js",
    "src/security-regression.test.js",
    "src/tools-runtime.test.js",
    "src/agent-evidence.test.js",
    "src/agent-verification-file-intent.test.js",
    "src/agent-authenticity.test.js",
    "src/agent-corrective.test.js",
    "src/agent-action-decision.test.js",
    "src/agent-action-learning.test.js",
    "src/agent-decision-attribution.test.js",
    "src/agent-recovery.test.js",
    "src/agent-document-generation.test.js",
    "src/agent-orchestration.test.js",
    "src/agent-route-dashboard.test.js",
    "src/agent-route-task-runtime.test.js",
    "src/agent-route-memory-runtime.test.js"
  ].forEach(nodeCheck);

  writeReport();
  console.log("Build validation passed.");
}

try {
  main();
} catch (err) {
  writeReport();
  console.error(`Build validation failed: ${err.message}`);
  process.exitCode = 1;
}
