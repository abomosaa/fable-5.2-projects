package dev.pocket3d.core.math

import kotlin.math.tan

/**
 * 4x4 matrix helpers on column-major FloatArray(16) (OpenGL / glTF layout: element (row r, col c)
 * is m[c * 4 + r]). Pure functions; no android.opengl dependency so they are JVM-testable.
 */
object Mat4 {
    fun identity() = floatArrayOf(1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)

    fun mul(a: FloatArray, b: FloatArray): FloatArray {
        val r = FloatArray(16)
        for (c in 0 until 4) for (row in 0 until 4) {
            var s = 0f
            for (k in 0 until 4) s += a[k * 4 + row] * b[c * 4 + k]
            r[c * 4 + row] = s
        }
        return r
    }

    fun translation(t: Vec3) = identity().also { it[12] = t.x; it[13] = t.y; it[14] = t.z }
    fun scale(s: Float) = identity().also { it[0] = s; it[5] = s; it[10] = s }

    fun rotation(q: Quat): FloatArray {
        val (x, y, z, w) = q
        return floatArrayOf(
            1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0f,
            2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0f,
            2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0f,
            0f, 0f, 0f, 1f,
        )
    }

    /** Compose translation * rotation * uniformScale (applied to a point: scale, then rotate, then translate). */
    fun trs(t: Vec3, q: Quat, s: Float): FloatArray = mul(translation(t), mul(rotation(q), scale(s)))

    fun transformPoint(m: FloatArray, p: Vec3): Vec3 {
        val x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]
        val y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]
        val z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]
        val w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15]
        return if (w != 1f && w != 0f) Vec3(x / w, y / w, z / w) else Vec3(x, y, z)
    }

    fun transformDir(m: FloatArray, d: Vec3) = Vec3(
        m[0] * d.x + m[4] * d.y + m[8] * d.z,
        m[1] * d.x + m[5] * d.y + m[9] * d.z,
        m[2] * d.x + m[6] * d.y + m[10] * d.z,
    )

    fun perspective(fovYRad: Float, aspect: Float, near: Float, far: Float): FloatArray {
        val f = 1f / tan(fovYRad / 2f)
        val m = FloatArray(16)
        m[0] = f / aspect; m[5] = f
        m[10] = (far + near) / (near - far); m[11] = -1f
        m[14] = 2f * far * near / (near - far)
        return m
    }

    fun lookAt(eye: Vec3, target: Vec3, up: Vec3): FloatArray {
        val f = (target - eye).normalized()
        val s = f.cross(up).normalized()
        val u = s.cross(f)
        return floatArrayOf(
            s.x, u.x, -f.x, 0f,
            s.y, u.y, -f.y, 0f,
            s.z, u.z, -f.z, 0f,
            -s.dot(eye), -u.dot(eye), f.dot(eye), 1f,
        )
    }

    /** General 4x4 inverse (cofactor expansion). Returns null if singular. */
    fun invert(m: FloatArray): FloatArray? {
        val inv = FloatArray(16)
        inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]
        inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]
        inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]
        inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]
        inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]
        inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]
        inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]
        inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]
        inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]
        inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]
        inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]
        inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]
        inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]
        inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]
        inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]
        inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]
        val det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
        if (det == 0f || det.isNaN()) return null
        val d = 1f / det
        for (i in 0 until 16) inv[i] *= d
        return inv
    }
}

/** Ray with origin and unit direction. */
data class Ray(val origin: Vec3, val dir: Vec3) {
    fun at(t: Float) = origin + dir * t
}
