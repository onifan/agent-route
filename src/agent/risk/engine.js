"use strict";

const { DEFAULT_RISK_POLICY, HUMAN_APPROVAL_POLICY, UNATTENDED_POLICY } = require("../../config/loader");
const { hasAutonomousContext, isUnattendedHour } = require("../../config/policies/unattended-policy");

const RISK_LEVEL = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical"
});

const APPROVAL_STATUS = Object.freeze({
  NOT_REQUIRED: "not_required",
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected"
});

const RISK_ORDER = Object.freeze({
  [RISK_LEVEL.LOW]: 0,
  [RISK_LEVEL.MEDIUM]: 1,
  [RISK_LEVEL.HIGH]: 2,
  [RISK_LEVEL.CRITICAL]: 3
});

const READ_ONLY_COMMANDS = new Set(DEFAULT_RISK_POLICY.shell.readOnlyCommands);

const FILE_MUTATION_COMMANDS = new Set(DEFAULT_RISK_POLICY.shell.fileMutationCommands);

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function collapseText(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function redactSensitive(value) {
  let text = String(value == null ? "" : value);
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(ghp|github_pat|glpat|xox[baprs]|sk|rk|pk_live|pk_test)_[A-Za-z0-9_=-]{12,}/gi,
    /\b(sk|rk)-[A-Za-z0-9_-]{16,}/gi,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|password|passwd|pwd|cookie|secret)\b\s*[:=]\s*['"]?[^'"\s]{8,}/gi
  ];
  for (const pattern of patterns) text = text.replace(pattern, "[REDACTED_SECRET]");
  return text;
}

function normalizeRiskLevel(value, fallback = RISK_LEVEL.LOW) {
  const raw = String(value || fallback || RISK_LEVEL.LOW)
    .trim()
    .toLowerCase();
  if (["none", "safe", "low", "l0"].includes(raw)) return RISK_LEVEL.LOW;
  if (["medium", "moderate", "normal", "l1"].includes(raw)) return RISK_LEVEL.MEDIUM;
  if (["high", "risky", "l2"].includes(raw)) return RISK_LEVEL.HIGH;
  if (["critical", "danger", "dangerous", "severe", "l3"].includes(raw)) return RISK_LEVEL.CRITICAL;
  return fallback;
}

function normalizeApprovalStatus(value, requiresApproval = false) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (["approved", "approve", "confirmed", "human_approved"].includes(raw)) return APPROVAL_STATUS.APPROVED;
  if (["rejected", "denied", "declined", "canceled"].includes(raw)) return APPROVAL_STATUS.REJECTED;
  if (["pending", "waiting", "waiting_human", "awaiting_confirmation"].includes(raw)) return APPROVAL_STATUS.PENDING;
  return requiresApproval ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED;
}

function compareRiskLevel(left, right) {
  return RISK_ORDER[normalizeRiskLevel(left)] - RISK_ORDER[normalizeRiskLevel(right)];
}

function maxRiskLevel(...levels) {
  return (
    levels.map((level) => normalizeRiskLevel(level)).sort((a, b) => RISK_ORDER[b] - RISK_ORDER[a])[0] || RISK_LEVEL.LOW
  );
}

function isRiskAtLeast(level, threshold) {
  return compareRiskLevel(level, threshold) >= 0;
}

function uniqueList(values, limit = 60) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = collapseText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function taskText(task = {}, context = {}) {
  return [
    context.goal,
    context.goalText,
    task.title,
    task.description,
    task.type,
    task.modelPool,
    task.prompt,
    task.input && typeof task.input === "string" ? task.input : "",
    task.routingReason,
    Array.isArray(task.successCriteria) ? task.successCriteria.join(" ") : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function actionText(action) {
  if (action == null) return "";
  if (typeof action === "string") return action;
  if (typeof action !== "object") return String(action);
  return [
    action.type,
    action.kind,
    action.action,
    action.detectedActionType,
    action.evidenceSource,
    action.name,
    action.label,
    action.text,
    action.selector,
    action.url,
    action.currentUrl,
    action.previousUrl,
    action.nextUrl,
    action.command,
    action.path,
    action.target
  ]
    .filter(Boolean)
    .join(" ");
}

function hasMeaningfulBrowserEvidence(item = {}) {
  if (!item || typeof item !== "object") return false;
  return Boolean(
    item.action ||
    item.detectedActionType ||
    item.url ||
    item.currentUrl ||
    item.previousUrl ||
    item.nextUrl ||
    item.afterUrl ||
    item.beforeUrl ||
    item.title ||
    item.previousTitle ||
    item.textPreview ||
    item.pageText ||
    item.visibleTextHints ||
    item.screenshotPath ||
    item.snapshotPath ||
    item.selector ||
    item.label
  );
}

function collectActions(task = {}, workerResult = {}, context = {}) {
  const evidence = workerResult.evidence || {};
  const normalizedBrowserEvidence = [
    ...(Array.isArray(evidence.browserEvidence) ? evidence.browserEvidence : []),
    ...(evidence.normalizedEvidence && Array.isArray(evidence.normalizedEvidence.browser)
      ? evidence.normalizedEvidence.browser
      : []),
    ...(evidence.browser ? [evidence.browser] : [])
  ]
    .filter(hasMeaningfulBrowserEvidence)
    .map((item) => ({
      type: "browser",
      action: item.detectedActionType || item.action || "browser_action",
      detectedActionType: item.detectedActionType || "",
      evidenceSource: item.evidenceSource || "",
      label: item.title || "",
      text: item.textPreview || item.pageText || "",
      url: item.url || item.currentUrl || item.nextUrl || item.afterUrl || "",
      previousUrl: item.previousUrl || item.beforeUrl || "",
      nextUrl: item.nextUrl || item.afterUrl || item.currentUrl || "",
      target: item.screenshotPath || item.snapshotPath || ""
    }));
  return [
    ...(Array.isArray(task.actions) ? task.actions : []),
    ...(Array.isArray(context.actions) ? context.actions : []),
    ...(Array.isArray(workerResult.actions) ? workerResult.actions : []),
    ...normalizedBrowserEvidence
  ];
}

function isReadOnlyWebToolTask(task = {}, workerResult = {}) {
  const type = String(task.type || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  const model = String(workerResult.model || "").toLowerCase();
  return (
    toolWorker === "web" ||
    model === "web-tool" ||
    /^(web_search|web_read|web_fetch|api_read|http_fetch|public_web_read|public_api_read)$/.test(type)
  );
}

function addSignal(state, level, reason, source, details = {}, options = {}) {
  const riskLevel = normalizeRiskLevel(level);
  if (RISK_ORDER[riskLevel] > RISK_ORDER[state.riskLevel]) state.riskLevel = riskLevel;
  const safeReason = collapseText(reason);
  if (safeReason) state.riskReasons.push(safeReason);
  state.riskSignals.push({
    source: source || "rule",
    riskLevel,
    reason: safeReason,
    details: sanitizeDetails(details)
  });
  if (options.escalation && !state.escalationReason) state.escalationReason = safeReason;
  if (options.blocked && !state.blockedReason) state.blockedReason = safeReason || "Risk engine blocked this action.";
}

function sanitizeDetails(details = {}) {
  const out = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (value == null) continue;
    if (typeof value === "string") out[key] = redactSensitive(value).slice(0, 400);
    else if (Array.isArray(value))
      out[key] = value
        .slice(0, 12)
        .map((item) => (typeof item === "string" ? redactSensitive(item).slice(0, 240) : item));
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else out[key] = redactSensitive(JSON.stringify(value)).slice(0, 400);
  }
  return out;
}

function tokenizeShellCommand(command) {
  const tokens = [];
  const input = String(command || "");
  const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
  let match;
  while ((match = pattern.exec(input))) {
    tokens.push((match[1] || match[2] || match[3] || match[4] || "").trim());
  }
  return tokens.filter(Boolean);
}

function splitShellSegments(command) {
  return String(command || "")
    .split(/\s*(?:&&|\|\||;|\|)\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripCommandWrappers(tokens) {
  let next = tokens.slice();
  while (next[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(next[0])) next = next.slice(1);
  if (["time", "command", "env", "noglob"].includes(next[0])) next = next.slice(1);
  return next;
}

function startsWithCommand(tokens, name) {
  return tokens[0] === name || `${tokens[0] || ""} ${tokens[1] || ""}`.trim() === name;
}

function hasRecursiveForce(tokens) {
  const flags = tokens.filter((token) => /^-/.test(token)).join("");
  return flags.includes("r") && flags.includes("f");
}

function shellTargets(tokens) {
  return tokens.slice(1).filter((token) => token && !token.startsWith("-"));
}

function isBroadTarget(target) {
  const value = String(target || "").trim();
  return ["/", ".", "./", "*", "/*", "./*", "~", "~/", "$HOME"].includes(value) || /^\.\.?(?:\/\*)?$/.test(value);
}

function isSystemPath(target) {
  const value = String(target || "").trim();
  return /^\/(?:System|Library|bin|sbin|usr|etc|var|private|opt|Applications)(?:\/|$)/.test(value);
}

function isDatabaseTarget(target) {
  return (
    /\.(sqlite|sqlite3|db|duckdb)$/i.test(String(target || "")) ||
    /\b(database|postgres|mysql|mariadb|mongo|redis|table)\b/i.test(String(target || ""))
  );
}

function commandName(tokens) {
  if (!tokens.length) return "";
  const two = `${tokens[0]} ${tokens[1] || ""}`.trim();
  if (READ_ONLY_COMMANDS.has(two) || FILE_MUTATION_COMMANDS.has(two)) return two;
  return tokens[0];
}

function classifyShellCommand(command, context = {}) {
  const signals = [];
  let riskLevel = RISK_LEVEL.LOW;
  let blockedReason = "";
  const push = (level, reason, details = {}, blocked = false) => {
    const normalized = normalizeRiskLevel(level);
    if (RISK_ORDER[normalized] > RISK_ORDER[riskLevel]) riskLevel = normalized;
    signals.push({ riskLevel: normalized, reason, details: sanitizeDetails(details) });
    if (blocked && !blockedReason) blockedReason = reason;
  };

  for (const segment of splitShellSegments(command)) {
    let tokens = stripCommandWrappers(tokenizeShellCommand(segment));
    if (!tokens.length) continue;
    if (tokens[0] === "sudo") {
      push(RISK_LEVEL.HIGH, "Shell command uses sudo and can change privileged system state.", { command: segment });
      tokens = stripCommandWrappers(tokens.slice(1));
    }
    const name = commandName(tokens);
    const lowerSegment = segment.toLowerCase();
    const targets = shellTargets(tokens);

    if (/\b(drop\s+database|drop\s+table|truncate\s+table|delete\s+from)\b/i.test(segment)) {
      push(RISK_LEVEL.CRITICAL, "Shell command appears to delete database data.", { command: segment }, true);
      continue;
    }
    if (/\b(terraform|tofu)\s+(apply|destroy)\b/i.test(segment)) {
      push(RISK_LEVEL.CRITICAL, "Infrastructure command can change or destroy live resources.", { command: segment });
      continue;
    }
    if (/\b(npm|pnpm|yarn|bun)\s+publish\b/i.test(segment) || /\b(deploy|release)\b/i.test(segment)) {
      push(RISK_LEVEL.CRITICAL, "Publish or deploy command has external production side effects.", {
        command: segment
      });
      continue;
    }
    if (/\b(mkfs|diskutil\s+erase|dd\s+if=|dd\s+of=)\b/i.test(segment)) {
      push(RISK_LEVEL.CRITICAL, "Disk mutation command can destroy local data.", { command: segment }, true);
      continue;
    }

    if (name === "rm") {
      const recursiveForce = hasRecursiveForce(tokens);
      const dangerousTarget = targets.some(
        (target) => isBroadTarget(target) || isSystemPath(target) || isDatabaseTarget(target)
      );
      if (recursiveForce || dangerousTarget) {
        push(
          RISK_LEVEL.CRITICAL,
          recursiveForce
            ? "Shell command uses recursive forced deletion."
            : "Shell command deletes a broad, system, or database target.",
          { command: segment, targets },
          recursiveForce &&
            (targets.length === 0 ||
              targets.some((target) => isBroadTarget(target) || isSystemPath(target) || isDatabaseTarget(target)))
        );
      } else {
        push(RISK_LEVEL.HIGH, "Shell command deletes local files.", { command: segment, targets });
      }
      continue;
    }

    if (startsWithCommand(tokens, "git reset") && tokens.includes("--hard")) {
      push(RISK_LEVEL.HIGH, "git reset --hard can discard local work.", { command: segment });
      continue;
    }
    if (startsWithCommand(tokens, "git clean")) {
      push(
        tokens.some((token) => token.includes("x")) ? RISK_LEVEL.CRITICAL : RISK_LEVEL.HIGH,
        "git clean can delete untracked files.",
        { command: segment }
      );
      continue;
    }
    if (startsWithCommand(tokens, "git push")) {
      push(RISK_LEVEL.HIGH, "git push publishes code or branch state externally.", { command: segment });
      continue;
    }
    if (name === "find" && tokens.includes("-delete")) {
      push(RISK_LEVEL.HIGH, "find -delete can remove many local files.", { command: segment });
      continue;
    }
    if (
      startsWithCommand(tokens, "docker stop") ||
      startsWithCommand(tokens, "docker kill") ||
      startsWithCommand(tokens, "docker rm") ||
      startsWithCommand(tokens, "docker compose")
    ) {
      const level = /\bdown\b/.test(lowerSegment) ? RISK_LEVEL.HIGH : RISK_LEVEL.HIGH;
      push(level, "Docker command can stop or remove running services.", { command: segment });
      continue;
    }
    if (["kill", "pkill", "killall", "systemctl", "launchctl"].includes(name)) {
      push(RISK_LEVEL.HIGH, "Process or service control command can interrupt running systems.", { command: segment });
      continue;
    }
    if (["kubectl", "helm"].includes(name)) {
      const level = /\b(delete|scale|apply|upgrade|rollback)\b/i.test(segment) ? RISK_LEVEL.HIGH : RISK_LEVEL.MEDIUM;
      push(level, "Cluster management command can affect external services.", { command: segment });
      continue;
    }
    if (name === "chmod" || name === "chown") {
      const recursive = tokens.some((token) => /^-.*R/.test(token));
      const systemTarget = targets.some(isSystemPath);
      push(
        recursive || systemTarget ? RISK_LEVEL.HIGH : RISK_LEVEL.MEDIUM,
        "Permission command can change file access behavior.",
        { command: segment, targets }
      );
      continue;
    }

    if (READ_ONLY_COMMANDS.has(name)) {
      push(RISK_LEVEL.LOW, "Read-only shell command.", { command: segment });
      continue;
    }
    if (FILE_MUTATION_COMMANDS.has(name)) {
      push(RISK_LEVEL.MEDIUM, "Shell command can modify the working tree or local files.", { command: segment });
      continue;
    }
    if (/[>]{1,2}/.test(segment)) {
      push(RISK_LEVEL.MEDIUM, "Shell command redirects output and may overwrite files.", { command: segment });
      continue;
    }
    push(context.defaultShellRisk || RISK_LEVEL.MEDIUM, "Shell command has unknown side effects.", {
      command: segment
    });
  }

  return {
    riskLevel,
    riskReasons: uniqueList(signals.map((signal) => signal.reason)),
    riskSignals: signals,
    blockedReason
  };
}

function extractShellCommands(task = {}, workerResult = {}, context = {}) {
  const commands = [];
  const actions = collectActions(task, workerResult, context);
  for (const action of actions) {
    if (action && typeof action === "object") {
      const type = String(action.type || action.kind || "").toLowerCase();
      if (action.command && /(shell|terminal|exec|command|bash|zsh|sh)/.test(type || "shell")) {
        commands.push(String(action.command));
      }
      continue;
    }
    const text = String(action || "").trim();
    const prefixed = text.match(/^(?:shell|terminal|exec|command|bash|zsh|sh)\s*[:>-]\s*(.+)$/i);
    if (prefixed) commands.push(prefixed[1]);
  }

  const text = taskText(task, context);
  const commandPatterns = [
    /(?:run|execute|执行|运行命令|shell command|terminal command)\s+`([^`]+)`/gi,
    /(?:run|execute|执行|运行命令|shell command|terminal command)\s+["']([^"'\n]+)["']/gi,
    /\b(rm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+[^\n;]+)\b/gi,
    /\b(npm\s+publish|pnpm\s+publish|yarn\s+publish|bun\s+publish)\b[^\n;]*/gi,
    /\b(terraform\s+(?:apply|destroy))\b[^\n;]*/gi
  ];
  for (const pattern of commandPatterns) {
    let match;
    while ((match = pattern.exec(text))) commands.push(match[1]);
  }
  return uniqueList(
    commands.map((command) => redactSensitive(command)),
    20
  );
}

function classifyBrowserAction(action, context = {}) {
  const raw = actionText(action);
  const lower = raw.toLowerCase();
  const type =
    action && typeof action === "object"
      ? String(action.action || action.kind || action.type || "").toLowerCase()
      : lower;
  const evidenceSource =
    action && typeof action === "object"
      ? String(action.evidenceSource || action.evidence_source || "").toLowerCase()
      : "";
  const detectedActionType =
    action && typeof action === "object"
      ? String(action.detectedActionType || action.detected_action_type || "").toLowerCase()
      : "";
  const url =
    action && typeof action === "object" ? String(action.url || context.url || "") : String(context.url || "");
  const external = isExternalUrl(url);
  const realAccount =
    /\b(real account|logged in|authenticated|production account|真实账号|已登录|登录态|正式账号)\b/i.test(
      `${raw} ${context.goal || ""}`
    );

  if (
    evidenceSource === "web-tool" &&
    /^(read_page|browser_action|web_search|web_fetch|open_page)?$/.test(detectedActionType || "read_page") &&
    !/\b(click|fill|type|input|submit|send|login|upload|delete|payment|publish)\b/i.test(type)
  ) {
    return browserResult(RISK_LEVEL.LOW, "Web tool browser evidence is read-only.", "read", {
      action: raw,
      url,
      external
    });
  }

  if (/\b(pay|payment|purchase|checkout|billing|付款|支付|购买|结账)\b/i.test(lower)) {
    return browserResult(RISK_LEVEL.CRITICAL, "Browser action may create a payment or purchase.", "payment", {
      action: raw,
      url,
      external
    });
  }
  if (/\b(delete|remove|destroy|cancel subscription|删除|移除|取消订阅)\b/i.test(lower)) {
    return browserResult(RISK_LEVEL.CRITICAL, "Browser action may delete or cancel real data.", "delete", {
      action: raw,
      url,
      external
    });
  }
  if (/\b(publish|deploy|release|post public|发布|上线|公开发布)\b/i.test(lower)) {
    return browserResult(RISK_LEVEL.HIGH, "Browser action may publish externally visible content.", "publish", {
      action: raw,
      url,
      external
    });
  }
  if (/\b(login|sign in|signin|authenticate|password|2fa|otp|登录|登陆|认证|验证码)\b/i.test(lower)) {
    return browserResult(RISK_LEVEL.HIGH, "Browser action involves account login or authentication.", "login", {
      action: raw,
      url,
      external
    });
  }
  if (/\b(submit|apply|send|message|email|comment|proposal|提交|发送|投递|申请|留言|评论)\b/i.test(lower)) {
    const level = /proposal|申请|投递/.test(lower) || realAccount || external ? RISK_LEVEL.HIGH : RISK_LEVEL.MEDIUM;
    return browserResult(level, "Browser action may submit data or send a real message.", "submit", {
      action: raw,
      url,
      external,
      realAccount
    });
  }
  if (/\b(upload|attach|上传|附件)\b/i.test(lower)) {
    return browserResult(RISK_LEVEL.HIGH, "Browser action uploads local data to an external surface.", "upload", {
      action: raw,
      url,
      external
    });
  }
  if (/\b(download|save file|下载)\b/i.test(lower)) {
    return browserResult(RISK_LEVEL.MEDIUM, "Browser action downloads a file to the local environment.", "download", {
      action: raw,
      url,
      external
    });
  }
  if (/\b(fill|type|input|enter text|填写|输入)\b/i.test(type) || /\b(input|textarea|form)\b/i.test(lower)) {
    const level = /\b(password|token|secret|cookie|密码|验证码)\b/i.test(lower) ? RISK_LEVEL.HIGH : RISK_LEVEL.MEDIUM;
    return browserResult(level, "Browser action changes form state.", "fill", { action: raw, url, external });
  }
  if (/\b(click|press|tap|点击|按钮)\b/i.test(type)) {
    return browserResult(RISK_LEVEL.MEDIUM, "Browser click can change page state.", "click", {
      action: raw,
      url,
      external
    });
  }
  if (/\b(read|extract|scrape|screenshot|observe|scroll|navigate|open|读取|提取|滚动|截图|访问|打开)\b/i.test(lower)) {
    return browserResult(
      external ? RISK_LEVEL.LOW : RISK_LEVEL.LOW,
      "Browser action is read-only or navigational.",
      "read",
      { action: raw, url, external }
    );
  }
  return browserResult(RISK_LEVEL.MEDIUM, "Browser automation action has unknown side effects.", "browser", {
    action: raw,
    url,
    external
  });
}

function browserResult(riskLevel, reason, actionType, details = {}) {
  return {
    riskLevel,
    riskReasons: [reason],
    riskSignals: [{ riskLevel, reason, source: "browser_action", details: sanitizeDetails(details) }],
    actionType
  };
}

function isExternalUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function extractBrowserActions(task = {}, workerResult = {}, context = {}) {
  const actions = [];
  for (const action of collectActions(task, workerResult, context)) {
    if (action && typeof action === "object") {
      const text = actionText(action);
      const type = String(action.type || action.kind || action.action || "").toLowerCase();
      if (
        type === "browser_action" &&
        !action.detectedActionType &&
        !action.url &&
        !action.nextUrl &&
        !action.previousUrl &&
        !action.text &&
        !action.label &&
        !action.selector &&
        !action.target
      ) {
        continue;
      }
      if (
        /(browser|click|fill|type|input|submit|scroll|navigate|download|upload|login|publish|payment|delete)/i.test(
          `${type} ${text}`
        )
      ) {
        actions.push(action);
      }
      continue;
    }
    const text = String(action || "").trim();
    if (/^called:[a-z0-9_-]+$/i.test(text)) continue;
    if (
      /\b(browser|click|fill|type|input|submit|scroll|navigate|download|upload|login|publish|payment|delete|网页|浏览器|点击|填写|提交|发送|登录|支付|发布|删除)\b/i.test(
        text
      )
    ) {
      actions.push(text);
    }
  }

  return actions.slice(0, 30);
}

function evaluateCapabilityRisk(state, task = {}) {
  const type = String(task.type || "").toLowerCase();
  const pool = String(task.modelPool || "").toLowerCase();
  if (
    (/(shell|terminal|local_execution|file|filesystem|codex-cli)/.test(type) || pool === "codex-cli") &&
    state.riskLevel === RISK_LEVEL.LOW
  ) {
    addSignal(
      state,
      RISK_LEVEL.MEDIUM,
      "Task has local execution capability; semantic risk remains model-declared unless a concrete tool action is observed.",
      "capability",
      {
        type,
        modelPool: pool
      }
    );
  }
}

function evaluateShellRisk(state, task = {}, workerResult = {}, context = {}) {
  const commands = extractShellCommands(task, workerResult, context);
  for (const command of commands) {
    const classified = classifyShellCommand(command, context);
    for (const signal of classified.riskSignals) {
      addSignal(
        state,
        signal.riskLevel,
        signal.reason,
        "shell_command",
        { command },
        {
          blocked: Boolean(classified.blockedReason)
        }
      );
    }
    if (classified.blockedReason && !state.blockedReason) state.blockedReason = classified.blockedReason;
  }
}

function evaluateBrowserRisk(state, task = {}, workerResult = {}, context = {}) {
  const actions = extractBrowserActions(task, workerResult, context);
  const actionTypes = [];
  for (const action of actions) {
    const classified = classifyBrowserAction(action, context);
    actionTypes.push(classified.actionType);
    for (const reason of classified.riskReasons) {
      addSignal(state, classified.riskLevel, reason, "browser_action", {
        action: actionText(action),
        actionType: classified.actionType
      });
    }
  }
  const repeatedSideEffects = actionTypes.filter((type) =>
    ["submit", "delete", "login", "payment", "publish", "upload"].includes(type)
  );
  if (repeatedSideEffects.length >= 2) {
    addSignal(
      state,
      RISK_LEVEL.CRITICAL,
      "Browser automation repeated high-impact actions in one task.",
      "risk_escalation",
      { actionTypes },
      { escalation: true }
    );
  }
}

function evaluateEscalationRisk(state, task = {}, workerResult = {}, context = {}) {
  const attempts = Math.max(
    Number(task.attempts || 0),
    Number(context.attempts || 0),
    Number(context.nextAttempt || 0)
  );
  const history = Array.isArray(task.history) ? task.history : [];
  const failures = history.filter((entry) =>
    /failed|retry|blocked/i.test(`${entry.to || ""} ${entry.reason || ""}`)
  ).length;
  if (
    attempts >= DEFAULT_RISK_POLICY.escalation.highRetryAttempts ||
    failures >= DEFAULT_RISK_POLICY.escalation.highRetryAttempts
  ) {
    addSignal(
      state,
      state.riskLevel === RISK_LEVEL.HIGH ? RISK_LEVEL.CRITICAL : RISK_LEVEL.HIGH,
      "Retry count is high enough to escalate task risk.",
      "risk_escalation",
      { attempts, failures },
      { escalation: true }
    );
  } else if (
    attempts >= DEFAULT_RISK_POLICY.escalation.mediumRetryAttempts ||
    failures >= DEFAULT_RISK_POLICY.escalation.mediumRetryAttempts
  ) {
    addSignal(
      state,
      maxRiskLevel(state.riskLevel, RISK_LEVEL.MEDIUM),
      "Repeated retries increase operational risk.",
      "risk_escalation",
      { attempts, failures },
      { escalation: true }
    );
  }

  const elapsedMs = Number(context.runElapsedMs || context.elapsedMs || 0);
  if (elapsedMs >= DEFAULT_RISK_POLICY.escalation.longLoopMs && isRiskAtLeast(state.riskLevel, RISK_LEVEL.MEDIUM)) {
    addSignal(
      state,
      RISK_LEVEL.HIGH,
      "Long autonomous loop increases risk of unattended drift.",
      "risk_escalation",
      { elapsedMs },
      { escalation: true }
    );
  }

  const hour = context.localHour == null ? new Date().getHours() : Number(context.localHour);
  if (
    hasAutonomousContext(context, UNATTENDED_POLICY) &&
    isUnattendedHour(hour, UNATTENDED_POLICY) &&
    isRiskAtLeast(state.riskLevel, RISK_LEVEL.MEDIUM)
  ) {
    addSignal(
      state,
      RISK_LEVEL.HIGH,
      "High-impact work is running during likely unattended hours.",
      "risk_escalation",
      { hour },
      { escalation: true }
    );
  }

  const workerStatus = String(workerResult.status || workerResult.outcome || "").toLowerCase();
  const model = String(context.model || workerResult.model || "").toLowerCase();
  if (
    (workerStatus === "failure" || workerStatus === "retry") &&
    (model.includes(":free") || model.startsWith("oc/") || model.startsWith("gc/"))
  ) {
    addSignal(
      state,
      RISK_LEVEL.MEDIUM,
      "Free fallback worker failed or requested retry; continue with caution.",
      "risk_escalation",
      { model, workerStatus },
      { escalation: true }
    );
  }
}

function evaluateTaskRisk(task = {}, context = {}) {
  const workerResult = context.workerResult || {};
  const baseRisk = normalizeRiskLevel(task.riskLevel || task.risk_level || context.riskLevel || RISK_LEVEL.LOW);
  const explicitApproval = Boolean(
    task.requiresHumanApproval ||
    task.requires_human_approval ||
    task.requiresHumanConfirmation ||
    task.requires_human_confirmation
  );
  const state = {
    riskLevel: baseRisk,
    riskReasons: baseRisk !== RISK_LEVEL.LOW ? [`Planner assigned ${baseRisk} risk.`] : [],
    riskSignals: [],
    escalationReason: "",
    blockedReason: ""
  };

  if (explicitApproval) {
    addSignal(state, RISK_LEVEL.HIGH, "Task was explicitly marked as requiring human approval.", "planner");
  }

  evaluateCapabilityRisk(state, task);
  evaluateShellRisk(state, task, workerResult, context);
  evaluateBrowserRisk(state, task, workerResult, context);
  evaluateEscalationRisk(state, task, workerResult, context);

  state.riskReasons = uniqueList(state.riskReasons);
  const approvalStatus = normalizeApprovalStatus(task.approvalStatus || task.approval_status, explicitApproval);
  const requiresHumanApproval =
    !state.blockedReason &&
    isRiskAtLeast(
      state.riskLevel,
      normalizeRiskLevel(HUMAN_APPROVAL_POLICY.requireApprovalAtRiskLevel, RISK_LEVEL.HIGH)
    ) &&
    approvalStatus !== APPROVAL_STATUS.APPROVED;
  const approvalReason = requiresHumanApproval
    ? state.riskReasons.find((reason) =>
        /submit|delete|payment|publish|deploy|login|sudo|shell|account|external|risk/i.test(reason)
      ) || `${state.riskLevel} risk task requires human approval.`
    : "";
  const suggestedAction = state.blockedReason
    ? "block"
    : requiresHumanApproval
      ? "request_human_approval"
      : state.riskLevel === RISK_LEVEL.MEDIUM
        ? "proceed_with_caution"
        : "allow";

  return {
    at: nowIso(),
    phase: String(context.phase || "manual"),
    riskLevel: state.riskLevel,
    riskReasons: state.riskReasons,
    requiresHumanApproval,
    approvalReason,
    approvalStatus: requiresHumanApproval ? APPROVAL_STATUS.PENDING : approvalStatus,
    escalationReason: state.escalationReason,
    suggestedAction,
    blockedReason: state.blockedReason,
    riskSignals: state.riskSignals.slice(0, 20)
  };
}

function compactEvaluation(evaluation = {}) {
  return {
    at: evaluation.at || nowIso(),
    phase: evaluation.phase || "manual",
    riskLevel: normalizeRiskLevel(evaluation.riskLevel),
    riskReasons: uniqueList(evaluation.riskReasons || []),
    requiresHumanApproval: Boolean(evaluation.requiresHumanApproval),
    approvalReason: evaluation.approvalReason || "",
    approvalStatus: normalizeApprovalStatus(evaluation.approvalStatus, evaluation.requiresHumanApproval),
    escalationReason: evaluation.escalationReason || "",
    suggestedAction: evaluation.suggestedAction || "",
    blockedReason: evaluation.blockedReason || "",
    riskSignals: Array.isArray(evaluation.riskSignals) ? clone(evaluation.riskSignals).slice(0, 20) : []
  };
}

module.exports = {
  APPROVAL_STATUS,
  RISK_LEVEL,
  classifyBrowserAction,
  classifyShellCommand,
  compactEvaluation,
  compareRiskLevel,
  evaluateTaskRisk,
  extractBrowserActions,
  extractShellCommands,
  isRiskAtLeast,
  maxRiskLevel,
  normalizeApprovalStatus,
  normalizeRiskLevel
};
