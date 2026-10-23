const GRAVITY = 9.80665;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function movementOnset(points, bodyMassKg, takeoffIndex) {
  if (!points.length || takeoffIndex < 1) return null;
  const baselineEnd = points[0].timestampMs + 750;
  const deviation = Math.max(2, bodyMassKg * 0.05);
  let candidate = null;
  for (let index = 0; index < takeoffIndex; index += 1) {
    const point = points[index];
    if (point.timestampMs < baselineEnd) continue;
    if (Math.abs(Math.max(0, point.valueKg) - bodyMassKg) >= deviation) {
      if (candidate === null) candidate = point.timestampMs;
      if (point.timestampMs - candidate >= 30) return candidate;
    } else {
      candidate = null;
    }
  }
  return null;
}

export function analyzeJumps(points, options = {}) {
  const usable = points.filter((point) => Number.isFinite(point.timestampMs) && Number.isFinite(point.valueKg));
  if (usable.length < 2) return { bodyMassKg: 0, jumps: [], cmj: null };
  const baselineLimit = usable[0].timestampMs + (options.baselineMs ?? 1000);
  const baseline = usable.filter((point) => point.timestampMs <= baselineLimit).map((point) => Math.max(0, point.valueKg));
  const bodyMassKg = median(baseline);
  const takeoffThresholdKg = options.takeoffThresholdKg ?? 2.04;
  const minFlightMs = options.minFlightMs ?? 100;
  const minLandingMs = options.minLandingMs ?? 25;
  const jumps = [];
  let onGround = true;
  let candidateTimestamp = null;
  let candidateIndex = null;
  let takeoff = null;
  let takeoffIndex = null;
  let previousLanding = null;

  for (let index = 0; index < usable.length; index += 1) {
    const point = usable[index];
    const forceKg = Math.max(0, point.valueKg);
    if (onGround) {
      if (forceKg <= takeoffThresholdKg) {
        if (candidateTimestamp === null) {
          candidateTimestamp = point.timestampMs;
          candidateIndex = index;
        }
        if (point.timestampMs - candidateTimestamp >= minFlightMs) {
          takeoff = candidateTimestamp;
          takeoffIndex = candidateIndex;
          onGround = false;
          candidateTimestamp = null;
          candidateIndex = null;
        }
      } else {
        candidateTimestamp = null;
        candidateIndex = null;
      }
      continue;
    }

    if (forceKg > takeoffThresholdKg) {
      if (candidateTimestamp === null) candidateTimestamp = point.timestampMs;
      if (point.timestampMs - candidateTimestamp >= minLandingMs) {
        const landing = candidateTimestamp;
        const flightTime = (landing - takeoff) / 1000;
        const jumpHeightM = GRAVITY * flightTime * flightTime / 8;
        const contactTime = previousLanding === null ? null : (takeoff - previousLanding) / 1000;
        jumps.push({ number: jumps.length + 1, takeoffMs: takeoff, landingMs: landing, flightTime, jumpHeightM, contactTime, rsi: contactTime && contactTime > 0 ? jumpHeightM / contactTime : null });
        previousLanding = landing;
        onGround = true;
        candidateTimestamp = null;
        candidateIndex = null;
      }
    } else {
      candidateTimestamp = null;
    }
  }

  const first = jumps[0] || null;
  let cmj = null;
  if (first) {
    const firstTakeoffIndex = usable.findIndex((point) => point.timestampMs >= first.takeoffMs);
    const onset = movementOnset(usable, bodyMassKg, firstTakeoffIndex);
    const timeToTakeoff = onset === null ? null : (first.takeoffMs - onset) / 1000;
    cmj = { ...first, movementOnsetMs: onset, timeToTakeoff, rsiMod: timeToTakeoff && timeToTakeoff > 0 ? first.jumpHeightM / timeToTakeoff : null };
  }
  return { bodyMassKg, jumps, cmj };
}
