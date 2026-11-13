package dev.pocket3d.core.math

import kotlinx.serialization.Serializable
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Unit quaternion (x, y, z, w) — Hamilton convention, same component order as glTF and ARCore. */
@Serializable
data class Quat(val x: Float, val y: Float, val z: Float, val w: Float) {
    operator fun times(o: Quat) = Quat(
        w * o.x + x * o.w + y * o.z - z * o.y,
        w * o.y - x * o.z + y * o.w + z * o.x,
        w * o.z + x * o.y - y * o.x + z * o.w,
        w * o.w - x * o.x - y * o.y - z * o.z,
    )
    fun conjugate() = Quat(-x, -y, -z, w)
    fun normalized(): Quat {
        val l = sqrt(x * x + y * y + z * z + w * w)
        return if (l > 1e-20f) Quat(x / l, y / l, z / l, w / l) else IDENTITY
    }
    fun rotate(v: Vec3): Vec3 {
        val u = Vec3(x, y, z)
        val t = u.cross(v) * 2f
        return v + t * w + u.cross(t)
    }

    companion object {
        val IDENTITY = Quat(0f, 0f, 0f, 1f)
        fun axisAngle(axis: Vec3, radians: Float): Quat {
            val a = axis.normalized(); val s = sin(radians / 2f)
            return Quat(a.x * s, a.y * s, a.z * s, cos(radians / 2f))
        }
        /** Shortest rotation taking unit vector [from] to unit vector [to]. */
        fun fromTo(from: Vec3, to: Vec3): Quat {
            val f = from.normalized(); val t = to.normalized()
            val d = f.dot(t)
            if (d > 0.999999f) return IDENTITY
            if (d < -0.999999f) {
                var ortho = Vec3.X.cross(f)
                if (ortho.lengthSq() < 1e-6f) ortho = Vec3.Y.cross(f)
                return axisAngle(ortho, Math.PI.toFloat())
            }
            val c = f.cross(t)
            return Quat(c.x, c.y, c.z, 1f + d).normalized()
        }
    }
}
