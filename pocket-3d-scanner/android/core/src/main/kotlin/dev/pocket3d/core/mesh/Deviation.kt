package dev.pocket3d.core.mesh

import kotlin.math.sqrt

internal fun deviationImpl(from: Mesh, to: Mesh, samples: Int, seed: Long, toBvh: Bvh?): DeviationStats {
    require(samples > 0) { "samples must be > 0" }
    val diagonal = Aabb.of(from.positions).diagonal
    val pos = from.positions; val idx = from.indices
    val fCount = from.faceCount
    // cumulative area table
    val cumulative = DoubleArray(fCount)
    var total = 0.0
    for (f in 0 until fCount) {
        val a = faceArea(pos, idx, f)
        if (a.isFinite()) total += a
        cumulative[f] = total
    }
    val bvh = toBvh ?: Bvh.build(to)
    require(total > 0.0) { "'from' mesh has no surface area" }
    require(bvh.triangleCount > 0) { "'to' mesh has no surface area" }

    val rng = SplitMix64(seed)
    val dist = FloatArray(samples)
    val out = DoubleArray(7)
    val stack = bvh.newStack()
    var sum = 0.0; var sumSq = 0.0; var max = 0.0
    for (s in 0 until samples) {
        val r = rng.nextDouble() * total
        // first face whose cumulative area exceeds r
        var lo = 0; var hi = fCount - 1
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            if (cumulative[mid] > r) hi = mid else lo = mid + 1
        }
        val f = lo
        val su = sqrt(rng.nextDouble()); val v = rng.nextDouble()
        val b0 = 1.0 - su; val b1 = su * (1.0 - v); val b2 = su * v
        val i0 = idx[3 * f] * 3; val i1 = idx[3 * f + 1] * 3; val i2 = idx[3 * f + 2] * 3
        val x = b0 * pos[i0] + b1 * pos[i1] + b2 * pos[i2]
        val y = b0 * pos[i0 + 1] + b1 * pos[i1 + 1] + b2 * pos[i2 + 1]
        val z = b0 * pos[i0 + 2] + b1 * pos[i1 + 2] + b2 * pos[i2 + 2]
        bvh.closest(x, y, z, Double.POSITIVE_INFINITY, out, stack)
        val d = sqrt(out[3])
        dist[s] = d.toFloat()
        sum += d; sumSq += d * d
        if (d > max) max = d
    }
    dist.sort()
    val p95 = dist[minOf(samples - 1, Math.ceil(0.95 * samples).toInt() - 1).coerceAtLeast(0)]
    return DeviationStats(
        mean = (sum / samples).toFloat(),
        rms = sqrt(sumSq / samples).toFloat(),
        p95 = p95,
        max = max.toFloat(),
        diagonal = diagonal,
        sampleCount = samples,
    )
}
