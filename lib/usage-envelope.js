"use strict";

const MONTHLY_CAPACITY = 100;
const ROLLOVER_CAPACITY = 25;
const RESERVE_CAPACITY = 100;
const SEGMENT_COUNT = 4;
const SEGMENT_UNIT = MONTHLY_CAPACITY / SEGMENT_COUNT;
const HALF_SEGMENT_UNIT = SEGMENT_UNIT / 2;
const LOW_WARNING_THRESHOLD = HALF_SEGMENT_UNIT;

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function toIsoOrNull(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeRawUsageData(rawUsageData = {}) {
  const safe = rawUsageData && typeof rawUsageData === "object" && !Array.isArray(rawUsageData)
    ? rawUsageData
    : {};

  return {
    monthly: {
      capacity: MONTHLY_CAPACITY,
      remaining: clampNumber(safe.monthly && safe.monthly.remaining, 0, MONTHLY_CAPACITY)
    },
    rollover: {
      capacity: ROLLOVER_CAPACITY,
      remaining: clampNumber(safe.rollover && safe.rollover.remaining, 0, ROLLOVER_CAPACITY)
    },
    reserve: {
      capacity: RESERVE_CAPACITY,
      remaining: clampNumber(safe.reserve && safe.reserve.remaining, 0, RESERVE_CAPACITY)
    },
    lastRenewalAt: toIsoOrNull(safe.lastRenewalAt)
  };
}

function getEnvelopeState(rawUsageData = {}) {
  const normalized = normalizeRawUsageData(rawUsageData);
  const totalAvailable = normalized.rollover.remaining + normalized.monthly.remaining + normalized.reserve.remaining;

  return {
    ...normalized,
    totalAvailable,
    lowWarningThreshold: LOW_WARNING_THRESHOLD
  };
}

function consumePool(poolRemaining, amountToConsume) {
  const take = Math.min(poolRemaining, amountToConsume);
  return {
    consumed: take,
    remaining: poolRemaining - take,
    rest: amountToConsume - take
  };
}

function consumeEnvelope(rawUsageData = {}, amount = 0) {
  const state = getEnvelopeState(rawUsageData);
  const requested = clampNumber(amount, 0, Number.MAX_SAFE_INTEGER);

  const fromRollover = consumePool(state.rollover.remaining, requested);
  const fromMonthly = consumePool(state.monthly.remaining, fromRollover.rest);
  const fromReserve = consumePool(state.reserve.remaining, fromMonthly.rest);

  const nextState = {
    monthly: {
      capacity: state.monthly.capacity,
      remaining: fromMonthly.remaining
    },
    rollover: {
      capacity: state.rollover.capacity,
      remaining: fromRollover.remaining
    },
    reserve: {
      capacity: state.reserve.capacity,
      remaining: fromReserve.remaining
    },
    lastRenewalAt: state.lastRenewalAt
  };

  return {
    state: getEnvelopeState(nextState),
    consumed: requested - fromReserve.rest,
    unconsumed: fromReserve.rest,
    breakdown: {
      rollover: fromRollover.consumed,
      monthly: fromMonthly.consumed,
      reserve: fromReserve.consumed
    }
  };
}

function computeGaugeSegments(amount, options = {}) {
  const capacity = clampNumber(options.capacity, 1, Number.MAX_SAFE_INTEGER);
  const segmentCount = Number.isInteger(options.segmentCount) && options.segmentCount > 0
    ? options.segmentCount
    : SEGMENT_COUNT;
  const segmentUnit = capacity / segmentCount;
  const halfSegment = segmentUnit / 2;
  const showRedWhenLow = options.showRedWhenLow === true;

  const safeAmount = clampNumber(amount, 0, capacity);
  const fullSegments = Math.floor(safeAmount / segmentUnit);
  const remainder = safeAmount - fullSegments * segmentUnit;
  const hasHalfSegment = remainder >= halfSegment;
  const isLowPositive = safeAmount > 0 && safeAmount < halfSegment;

  const segments = [];
  for (let i = 0; i < segmentCount; i += 1) {
    if (i < fullSegments) {
      segments.push("dark");
      continue;
    }

    if (i === fullSegments && (hasHalfSegment || isLowPositive)) {
      segments.push(showRedWhenLow && isLowPositive ? "red" : "light");
      continue;
    }

    segments.push("empty");
  }

  return segments;
}

function shouldShowLowEnvelopeWarning(rawUsageData = {}) {
  const state = getEnvelopeState(rawUsageData);
  return state.totalAvailable < LOW_WARNING_THRESHOLD;
}

function isNewCalendarMonth(previousIsoDate, nowDate) {
  if (!previousIsoDate) return true;
  const previous = new Date(previousIsoDate);
  if (Number.isNaN(previous.getTime())) return true;

  return (
    previous.getUTCFullYear() !== nowDate.getUTCFullYear() ||
    previous.getUTCMonth() !== nowDate.getUTCMonth()
  );
}

function applyMonthlyRenewal(rawUsageData = {}, now = new Date()) {
  const state = getEnvelopeState(rawUsageData);
  const nowDate = now instanceof Date ? now : new Date(now);

  if (Number.isNaN(nowDate.getTime())) {
    return {
      renewed: false,
      state
    };
  }

  if (!isNewCalendarMonth(state.lastRenewalAt, nowDate)) {
    return {
      renewed: false,
      state
    };
  }

  const nextRollover = Math.min(ROLLOVER_CAPACITY, state.monthly.remaining);
  const next = {
    monthly: {
      capacity: MONTHLY_CAPACITY,
      remaining: MONTHLY_CAPACITY
    },
    rollover: {
      capacity: ROLLOVER_CAPACITY,
      remaining: nextRollover
    },
    reserve: {
      capacity: RESERVE_CAPACITY,
      remaining: clampNumber(state.reserve.remaining, 0, RESERVE_CAPACITY)
    },
    lastRenewalAt: nowDate.toISOString()
  };

  return {
    renewed: true,
    state: getEnvelopeState(next)
  };
}

function addComplementaryReserve(rawUsageData = {}, amount = 0) {
  const state = getEnvelopeState(rawUsageData);
  const toAdd = clampNumber(amount, 0, Number.MAX_SAFE_INTEGER);
  const nextReserve = clampNumber(state.reserve.remaining + toAdd, 0, RESERVE_CAPACITY);

  return getEnvelopeState({
    monthly: state.monthly,
    rollover: state.rollover,
    reserve: {
      capacity: RESERVE_CAPACITY,
      remaining: nextReserve
    },
    lastRenewalAt: state.lastRenewalAt
  });
}

module.exports = {
  MONTHLY_CAPACITY,
  ROLLOVER_CAPACITY,
  RESERVE_CAPACITY,
  SEGMENT_COUNT,
  LOW_WARNING_THRESHOLD,
  getEnvelopeState,
  consumeEnvelope,
  computeGaugeSegments,
  shouldShowLowEnvelopeWarning,
  applyMonthlyRenewal,
  addComplementaryReserve
};
