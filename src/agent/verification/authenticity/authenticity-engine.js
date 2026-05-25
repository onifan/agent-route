"use strict";

const {
  evaluateBrowserAuthenticity,
  evaluateListAuthenticity,
  evaluateOutputPresenceAuthenticity,
  evaluateProposalAuthenticity,
  mergeAuthenticityResults
} = require("./authenticity-rules");

function evaluateAuthenticity(task = {}, workerResult = {}, context = {}) {
  const state = { authenticitySignals: [] };
  const result = mergeAuthenticityResults([
    evaluateOutputPresenceAuthenticity(state, task, workerResult, context),
    evaluateListAuthenticity(state, task, workerResult, context),
    evaluateBrowserAuthenticity(state, task, workerResult, context),
    evaluateProposalAuthenticity(state, task, workerResult, context)
  ]);
  return {
    ...result,
    authenticitySignals: state.authenticitySignals.slice(0, 20)
  };
}

module.exports = {
  evaluateAuthenticity
};
