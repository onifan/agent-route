"use strict";

const taskRuntime = require("../tasks");

const { WORKER_OUTCOME } = taskRuntime;

async function verifyWorkerResultIfNeeded({ workerResult, runningTask, verifyTaskResult }) {
  if (workerResult.status !== WORKER_OUTCOME.SUCCESS) return workerResult;
  const verification = await verifyTaskResult(workerResult, runningTask);
  return {
    ...workerResult,
    verification
  };
}

module.exports = {
  verifyWorkerResultIfNeeded
};
