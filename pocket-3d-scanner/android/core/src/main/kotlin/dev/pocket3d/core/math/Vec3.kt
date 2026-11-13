package dev.pocket3d.core.math

import kotlinx.serialization.Serializable
import kotlin.math.sqrt

/** Immutable 3-vector (float). Used for UI-level math; bulk mesh data lives in FloatArrays. */
@Serializable
data class Vec3(val x: Float, val y: Float, val z: Float) {
    operator fun plus(o: Vec3) = Vec3(x + o.x, y + o.y, z + o.z)
    operator fun minus(o: Vec3) = Vec3(x - o.x, y - o.y, z - o.z)
    operator fun times(s: Float) = Vec3(x * s, y * s, z * s)
    operator fun div(s: Float) = Vec3(x / s, y / s, z / s)
    operator fun unaryMinus() = Vec3(-x, -y, -z)
    fun dot(o: Vec3) = x * o.x + y * o.y + z * o.z
    fun cross(o: Vec3) = Vec3(y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x)
    fun length() = sqrt(x * x + y * y + z * z)
    fun lengthSq() = x * x + y * y + z * z
    fun normalized(): Vec3 { val l = length(); return if (l > 1e-20f) this / l else ZERO }
    fun distanceTo(o: Vec3) = (this - o).length()
    fun lerp(o: Vec3, t: Float) = Vec3(x + (o.x - x) * t, y + (o.y - y) * t, z + (o.z - z) * t)
    operator fun get(i: Int) = when (i) { 0 -> x; 1 -> y; else -> z }
    fun toArray() = floatArrayOf(x, y, z)

    companion object {
        val ZERO = Vec3(0f, 0f, 0f)
        val ONE = Vec3(1f, 1f, 1f)
        val X = Vec3(1f, 0f, 0f)
        val Y = Vec3(0f, 1f, 0f)
        val Z = Vec3(0f, 0f, 1f)
        fun of(a: FloatArray, offset: Int = 0) = Vec3(a[offset], a[offset + 1], a[offset + 2])
    }
}
