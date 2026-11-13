package dev.pocket3d.core.mesh

/** Growable primitive int list (no boxing). */
internal class IntList(capacity: Int = 16) {
    var data = IntArray(if (capacity < 4) 4 else capacity)
    var size = 0
        private set

    fun add(v: Int) {
        if (size == data.size) data = data.copyOf(size * 2)
        data[size++] = v
    }

    operator fun get(i: Int): Int = data[i]
    operator fun set(i: Int, v: Int) { data[i] = v }
    fun clear() { size = 0 }
    fun toArray(): IntArray = data.copyOf(size)
}

/** Growable primitive float list (no boxing). */
internal class FloatList(capacity: Int = 16) {
    var data = FloatArray(if (capacity < 4) 4 else capacity)
    var size = 0
        private set

    fun add(v: Float) {
        if (size == data.size) data = data.copyOf(size * 2)
        data[size++] = v
    }

    operator fun get(i: Int): Float = data[i]
    fun toArray(): FloatArray = data.copyOf(size)
}

/**
 * Open-addressing hash map from non-negative Long keys to Int values (linear probing, load
 * factor <= 0.5). Absent keys read as -1, so stored values must be >= 0.
 */
internal class LongIntMap(expected: Int = 16) {
    private var keys: LongArray
    private var vals: IntArray
    private var mask: Int
    var size = 0
        private set

    init {
        var cap = 8
        while (cap < expected * 2L && cap < (1 shl 30)) cap = cap shl 1
        keys = LongArray(cap) { EMPTY }
        vals = IntArray(cap)
        mask = cap - 1
    }

    private fun slot(key: Long): Int {
        val h = key * -0x61c8864680b583ebL
        return (h xor (h ushr 32)).toInt() and mask
    }

    /** Value for [key] or -1. */
    fun get(key: Long): Int {
        var i = slot(key)
        while (true) {
            val k = keys[i]
            if (k == key) return vals[i]
            if (k == EMPTY) return -1
            i = (i + 1) and mask
        }
    }

    fun put(key: Long, value: Int) {
        var i = slot(key)
        while (true) {
            val k = keys[i]
            if (k == key) { vals[i] = value; return }
            if (k == EMPTY) {
                keys[i] = key; vals[i] = value; size++
                if (size * 2 > keys.size) grow()
                return
            }
            i = (i + 1) and mask
        }
    }

    private fun grow() {
        val oldK = keys; val oldV = vals
        val cap = oldK.size shl 1
        keys = LongArray(cap) { EMPTY }
        vals = IntArray(cap)
        mask = cap - 1
        size = 0
        for (i in oldK.indices) if (oldK[i] != EMPTY) put(oldK[i], oldV[i])
    }

    private companion object { const val EMPTY = Long.MIN_VALUE }
}

/** Pack an unordered pair of non-negative ints into a Long key (smaller id in the high word). */
internal fun edgeKey(a: Int, b: Int): Long =
    if (a < b) (a.toLong() shl 32) or b.toLong() else (b.toLong() shl 32) or a.toLong()

/** Pack an ordered pair of non-negative ints into a Long key. */
internal fun pairKey(a: Int, b: Int): Long = (a.toLong() shl 32) or (b.toLong() and 0xffffffffL)

/** SplitMix64: tiny deterministic PRNG whose output is identical on every JVM / ART version. */
internal class SplitMix64(seed: Long) {
    private var s = seed
    fun nextLong(): Long {
        s += -0x61c8864680b583ebL
        var z = s
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        return z xor (z ushr 31)
    }
    /** Uniform double in [0, 1). */
    fun nextDouble(): Double = (nextLong() ushr 11) * (1.0 / (1L shl 53))
}

/**
 * Binary min-heap over the ids `0 until n` with updatable keys. Ties are broken by the lower id,
 * so the pop order is fully deterministic.
 */
internal class IndexedMinHeap(n: Int) {
    private val heap = IntArray(n)
    private val pos = IntArray(n) { -1 }
    private val key = DoubleArray(n)
    var size = 0
        private set

    fun contains(id: Int) = pos[id] >= 0
    fun keyOf(id: Int) = key[id]
    fun peek(): Int = heap[0]

    private fun less(a: Int, b: Int): Boolean {
        val ka = key[a]; val kb = key[b]
        return ka < kb || (ka == kb && a < b)
    }

    /** Insert [id] or change its key. */
    fun update(id: Int, k: Double) {
        val p = pos[id]
        if (p < 0) {
            key[id] = k
            heap[size] = id; pos[id] = size
            siftUp(size++)
        } else {
            val old = key[id]
            key[id] = k
            if (k < old) siftUp(p) else if (k > old) siftDown(p)
        }
    }

    fun remove(id: Int) {
        val p = pos[id]
        if (p < 0) return
        pos[id] = -1
        size--
        if (p == size) return
        val last = heap[size]
        heap[p] = last; pos[last] = p
        siftUp(p)
        siftDown(pos[last])
    }

    fun pop(): Int {
        val top = heap[0]
        remove(top)
        return top
    }

    private fun siftUp(start: Int) {
        var i = start
        val id = heap[i]
        while (i > 0) {
            val parent = (i - 1) ushr 1
            val pid = heap[parent]
            if (!less(id, pid)) break
            heap[i] = pid; pos[pid] = i
            i = parent
        }
        heap[i] = id; pos[id] = i
    }

    private fun siftDown(start: Int) {
        var i = start
        val id = heap[i]
        while (true) {
            var child = 2 * i + 1
            if (child >= size) break
            if (child + 1 < size && less(heap[child + 1], heap[child])) child++
            val cid = heap[child]
            if (!less(cid, id)) break
            heap[i] = cid; pos[cid] = i
            i = child
        }
        heap[i] = id; pos[id] = i
    }
}
