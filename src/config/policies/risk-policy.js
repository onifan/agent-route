"use strict";

const DEFAULT_RISK_POLICY = Object.freeze({
  levels: ["low", "medium", "high", "critical"],
  shell: {
    readOnlyCommands: [
      "ls",
      "pwd",
      "cat",
      "head",
      "tail",
      "less",
      "more",
      "grep",
      "rg",
      "find",
      "sed",
      "awk",
      "wc",
      "date",
      "echo",
      "printf",
      "which",
      "whoami",
      "id",
      "git status",
      "git log",
      "git diff",
      "git show",
      "git branch"
    ],
    fileMutationCommands: [
      "touch",
      "mkdir",
      "cp",
      "mv",
      "chmod",
      "chown",
      "ln",
      "tee",
      "patch",
      "npm install",
      "pnpm install",
      "yarn install",
      "bun install",
      "git checkout",
      "git switch",
      "git restore",
      "git merge",
      "git rebase",
      "git stash"
    ],
    highRiskPatterns: ["rm", "sudo", "kill", "docker stop", "service stop", "systemctl stop"],
    criticalPatterns: ["rm -rf", "drop database", "truncate table", "deploy production", "publish"]
  },
  browser: {
    low: ["read_page", "scroll", "extract_information"],
    medium: ["fill_input", "click_button", "download_file"],
    high: ["submit", "delete", "upload", "login", "send_message", "publish"],
    critical: ["payment", "production_publish", "account_deletion"]
  },
  escalation: {
    mediumRetryAttempts: 3,
    highRetryAttempts: 5,
    longLoopMs: 30 * 60 * 1000
  }
});

module.exports = {
  DEFAULT_RISK_POLICY
};
