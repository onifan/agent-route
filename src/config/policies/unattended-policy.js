"use strict";

const UNATTENDED_POLICY = Object.freeze({
  enabled: true,
  requiresAutonomousContext: true,
  nightHours: {
    start: 23,
    end: 6
  }
});

function hasAutonomousContext(context = {}, policy = UNATTENDED_POLICY) {
  if (!policy || policy.requiresAutonomousContext === false) return true;
  if (context.userInitiated === true || context.interactive === true) return false;
  return Boolean(context.unattended === true || context.autonomous === true || Number(context.runElapsedMs || 0) > 0);
}

function isUnattendedHour(hour, policy = UNATTENDED_POLICY) {
  if (!policy || policy.enabled === false) return false;
  const number = Number(hour);
  if (!Number.isFinite(number)) return false;
  const start = Number(policy.nightHours && policy.nightHours.start);
  const end = Number(policy.nightHours && policy.nightHours.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start > end ? number >= start || number < end : number >= start && number < end;
}

module.exports = {
  UNATTENDED_POLICY,
  hasAutonomousContext,
  isUnattendedHour
};
