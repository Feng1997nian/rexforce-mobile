export function calculateMetrics(points) {
  if (!points.length) {
    return { duration: 0, peak: 0, mean: 0, impulse: 0, rfd: 0, leftPeak: 0, rightPeak: 0, leftImpulse: 0, rightImpulse: 0 };
  }

  let peak = 0;
  let sum = 0;
  let impulse = 0;
  let leftPeak = 0;
  let rightPeak = 0;
  let leftImpulse = 0;
  let rightImpulse = 0;
  let rfd = 0;
  let rfdStart = 0;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const value = Math.max(0, point.valueKg);
    const left = Math.max(0, point.leftKg ?? point.valueKg);
    const right = Math.max(0, point.rightKg ?? 0);
    peak = Math.max(peak, value);
    leftPeak = Math.max(leftPeak, left);
    rightPeak = Math.max(rightPeak, right);
    sum += value;

    if (i === 0) continue;
    const previous = points[i - 1];
    const previousValue = Math.max(0, previous.valueKg);
    const previousLeft = Math.max(0, previous.leftKg ?? previous.valueKg);
    const previousRight = Math.max(0, previous.rightKg ?? 0);
    const dt = (point.timestampMs - previous.timestampMs) / 1000;
    if (dt > 0 && dt <= 0.2) {
      impulse += ((value + previousValue) / 2) * 9.80665 * dt;
      leftImpulse += ((left + previousLeft) / 2) * 9.80665 * dt;
      rightImpulse += ((right + previousRight) / 2) * 9.80665 * dt;
    }

    const windowStart = point.timestampMs - 200;
    while (rfdStart + 1 < i && points[rfdStart + 1].timestampMs <= windowStart) rfdStart += 1;
    const windowDt = (point.timestampMs - points[rfdStart].timestampMs) / 1000;
    if (windowDt > 0 && windowDt <= 0.25) {
      const startValue = Math.max(0, points[rfdStart].valueKg);
      rfd = Math.max(rfd, ((value - startValue) * 9.80665) / windowDt);
    }
  }

  return {
    duration: Math.max(0, (points.at(-1).timestampMs - points[0].timestampMs) / 1000),
    peak,
    mean: sum / points.length,
    impulse,
    rfd,
    leftPeak,
    rightPeak,
    leftImpulse,
    rightImpulse,
  };
}
