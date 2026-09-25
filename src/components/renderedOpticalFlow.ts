/** Sparse, image-only patch tracking. No mesh motion or stencil flag enters this estimator. */
export type FlowFrame = { gray: Float32Array; mask: Uint8Array; size: number };
export type FlowVector = { x: number; y: number; dx: number; dy: number };

export function estimateRenderedFlow(a: FlowFrame, b: FlowFrame): FlowVector[] {
  const n = a.size;
  const integrals = new Map<FlowFrame, Uint32Array>();
  for (const f of [a, b]) {
    const sums = new Uint32Array((n + 1) * (n + 1));
    for (let y = 0; y < n; y++) {
      let row = 0;
      for (let x = 0; x < n; x++) {
        row += f.mask[y * n + x] ? 1 : 0;
        sums[(y + 1) * (n + 1) + x + 1] = sums[y * (n + 1) + x + 1] + row;
      }
    }
    integrals.set(f, sums);
  }
  function valid(f: FlowFrame, x: number, y: number) {
    if (x < 5 || y < 5 || x >= n - 5 || y >= n - 5) return false;
    const s = integrals.get(f)!,
      w = n + 1,
      l = x - 4,
      r = x + 5,
      t = y - 4,
      b = y + 5;
    return s[b * w + r] - s[t * w + r] - s[b * w + l] + s[t * w + l] === 81;
  }
  function match(from: FlowFrame, to: FlowFrame, x: number, y: number) {
    if (!valid(from, x, y)) return null;
    let gx2 = 0,
      gy2 = 0,
      gxy = 0;
    for (let j = -3; j <= 3; j++)
      for (let i = -3; i <= 3; i++) {
        const k = (y + j) * n + x + i;
        const gx = (from.gray[k + 1] - from.gray[k - 1]) * 0.5,
          gy = (from.gray[k + n] - from.gray[k - n]) * 0.5;
        gx2 += gx * gx;
        gy2 += gy * gy;
        gxy += gx * gy;
      }
    // Reject flat patches and single edges (aperture ambiguity).
    if (
      (gx2 + gy2 - Math.sqrt((gx2 - gy2) ** 2 + 4 * gxy * gxy)) / 98 <
      0.00002
    )
      return null;
    const score = (dx: number, dy: number) => {
      if (!valid(to, x + dx, y + dy)) return Infinity;
      let s = 0;
      for (let j = -4; j <= 4; j += 2)
        for (let i = -4; i <= 4; i += 2) {
          const d =
            from.gray[(y + j) * n + x + i] -
            to.gray[(y + j + dy) * n + x + i + dx];
          s += d * d;
        }
      return s / 25;
    };
    let best = Infinity,
      dx = 0,
      dy = 0;
    const candidates: { x: number; y: number; s: number }[] = [];
    for (let j = -16; j <= 16; j++)
      for (let i = -16; i <= 16; i++) {
        const s = score(i, j);
        candidates.push({ x: i, y: j, s });
        if (s < best) {
          best = s;
          dx = i;
          dy = j;
        }
      }
    const cx = dx,
      cy = dy;
    for (let j = cy - 2; j <= cy + 2; j++)
      for (let i = cx - 2; i <= cx + 2; i++) {
        const s = score(i, j);
        if (s < best) {
          best = s;
          dx = i;
          dy = j;
        }
      }
    const alternative = Math.min(
      ...candidates
        .filter((c) => Math.hypot(c.x - dx, c.y - dy) > 4)
        .map((c) => c.s),
    );
    if (
      !Number.isFinite(best) ||
      best > 0.008 ||
      best >= alternative * 0.85 ||
      Math.abs(dx) >= 16 ||
      Math.abs(dy) >= 16
    )
      return null;
    const sub = (minus: number, plus: number) => {
      if (best < 1e-12) return 0;
      const den = minus - 2 * best + plus;
      return Number.isFinite(den) && den > 1e-9
        ? Math.max(-0.5, Math.min(0.5, (0.5 * (minus - plus)) / den))
        : 0;
    };
    return {
      dx: dx + sub(score(dx - 1, dy), score(dx + 1, dy)),
      dy: dy + sub(score(dx, dy - 1), score(dx, dy + 1)),
      ix: dx,
      iy: dy,
    };
  }
  const result: FlowVector[] = [];
  for (let y = 12; y < n - 12; y += 24)
    for (let x = 12; x < n - 12; x += 24) {
      const forward = match(a, b, x, y);
      if (!forward) continue;
      const backward = match(b, a, x + forward.ix, y + forward.iy);
      if (
        !backward ||
        Math.hypot(forward.dx + backward.dx, forward.dy + backward.dy) > 1.5
      )
        continue;
      result.push({ x, y, dx: forward.dx, dy: forward.dy });
    }
  return result;
}
