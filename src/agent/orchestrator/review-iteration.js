"use strict";

function createReviewTask(iteration) {
  return {
    id: `goal-review-${iteration}`,
    title: "Review progress and decide next step",
    internal: true,
    routeInternal: true,
    modelPool: "commander",
    prompt: "Decide whether the goal is complete or append the next worker tasks."
  };
}

function shouldContinueAfterReview({ review, iteration, maxGoalIterations, strategyChanged }) {
  if (review.status === "done" && review.finalAnswer) return false;
  if (review.nextTasks.length && iteration < maxGoalIterations) return true;
  if (!review.nextTasks.length && strategyChanged && iteration < maxGoalIterations) return true;
  return false;
}

module.exports = {
  createReviewTask,
  shouldContinueAfterReview
};
