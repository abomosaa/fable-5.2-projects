package dev.pocket3d.core.mesh

import dev.pocket3d.core.math.Vec3
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Procedural test meshes. All closed meshes are wound counter-clockwise seen from outside. */
object Fixtures {
    /** A real (decodable) PNG so that exported files also satisfy external validators. */
    fun png(size: Int = 8, seed: Int = 1): ByteArray {
        val img = BufferedImage(size, size, BufferedImage.TYPE_INT_RGB)
        for (y in 0 until size) for (x in 0 until size) img.setRGB(x, y, ((x * 31 + y * 17 + seed * 101) * 2654435761L).toInt() and 0xffffff)
        val out = ByteArrayOutputStream()
        ImageIO.write(img, "png", out)
        return out.toByteArray()
    }

    fun texturedMaterial(name: String = "atlas", seed: Int = 1) = Material(name, TextureImage("image/png", png(8, seed), "$name.png"))

    /**
     * UV sphere centred on the origin. Vertices on the u = 0 / u = 1 seam are duplicated, and each
     * pole has one vertex per segment, like the output of a typical atlas unwrap. Every vertex is
     * referenced: (segments + 1) * (rings + 1) - 2 vertices, 2 * segments * (rings - 1) faces.
     * u = longitude / 2pi, v = polar angle / pi (v = 0 at the +Y pole). confidence = v.
     */
    fun uvSphere(radius: Float = 1f, segments: Int = 32, rings: Int = 16, material: Material = Material("plain")): Mesh {
        val cols = segments + 1
        val pos = FloatArray(3 * cols * (rings + 1)); val nrm = FloatArray(pos.size)
        val uv = FloatArray(2 * cols * (rings + 1)); val conf = FloatArray(cols * (rings + 1))
        for (i in 0..rings) for (j in 0..segments) {
            val theta = PI * i / rings
            val phi = 2 * PI * (if (j == segments) 0 else j) / segments
            val k = i * cols + j
            val nx = (sin(theta) * cos(phi)).toFloat(); val ny = cos(theta).toFloat(); val nz = (sin(theta) * sin(phi)).toFloat()
            // exact poles so that all pole duplicates weld
            val px = if (i == 0 || i == rings) 0f else nx * radius
            val pz = if (i == 0 || i == rings) 0f else nz * radius
            val py = if (i == 0) radius else if (i == rings) -radius else ny * radius
            pos[3 * k] = px; pos[3 * k + 1] = py; pos[3 * k + 2] = pz
            nrm[3 * k] = nx; nrm[3 * k + 1] = ny; nrm[3 * k + 2] = nz
            uv[2 * k] = j.toFloat() / segments; uv[2 * k + 1] = i.toFloat() / rings
            conf[k] = i.toFloat() / rings
        }
        val idx = ArrayList<Int>()
        for (i in 0 until rings) for (j in 0 until segments) {
            val a = i * cols + j; val b = (i + 1) * cols + j; val c = i * cols + j + 1; val d = (i + 1) * cols + j + 1
            if (i != 0) { idx.add(a); idx.add(c); idx.add(b) }
            if (i != rings - 1) { idx.add(b); idx.add(c); idx.add(d) }
        }
        // The first vertex of the top row and the last of the bottom row are not used by any face; drop them.
        val full = Mesh(pos, nrm, uv, conf, idx.toIntArray(), null, listOf(material))
        val last = full.vertexCount - 1
        val keep = (1 until last).toList()
        return Mesh(
            FloatArray(3 * keep.size) { pos[3 * keep[it / 3] + it % 3] }, FloatArray(3 * keep.size) { nrm[3 * keep[it / 3] + it % 3] },
            FloatArray(2 * keep.size) { uv[2 * keep[it / 2] + it % 2] }, FloatArray(keep.size) { conf[keep[it]] },
            IntArray(idx.size) { idx[it] - 1 }, null, listOf(material),
        )
    }

    /** Torus around the Y axis, seams duplicated in both directions. */
    fun torus(major: Float = 1f, minor: Float = 0.35f, nu: Int = 48, nv: Int = 24, material: Material = Material("plain")): Mesh {
        val cols = nv + 1
        val count = (nu + 1) * cols
        val pos = FloatArray(3 * count); val nrm = FloatArray(3 * count); val uv = FloatArray(2 * count); val conf = FloatArray(count)
        for (i in 0..nu) for (j in 0..nv) {
            val u = 2 * PI * (if (i == nu) 0 else i) / nu
            val v = 2 * PI * (if (j == nv) 0 else j) / nv
            val k = i * cols + j
            pos[3 * k] = ((major + minor * cos(v)) * cos(u)).toFloat()
            pos[3 * k + 1] = (minor * sin(v)).toFloat()
            pos[3 * k + 2] = ((major + minor * cos(v)) * sin(u)).toFloat()
            nrm[3 * k] = (cos(v) * cos(u)).toFloat(); nrm[3 * k + 1] = sin(v).toFloat(); nrm[3 * k + 2] = (cos(v) * sin(u)).toFloat()
            uv[2 * k] = i.toFloat() / nu; uv[2 * k + 1] = j.toFloat() / nv
            conf[k] = (0.5 + 0.5 * cos(u)).toFloat()
        }
        val idx = IntArray(nu * nv * 6)
        var o = 0
        for (i in 0 until nu) for (j in 0 until nv) {
            val a = i * cols + j; val b = (i + 1) * cols + j; val c = i * cols + j + 1; val d = (i + 1) * cols + j + 1
            idx[o++] = a; idx[o++] = c; idx[o++] = b
            idx[o++] = b; idx[o++] = c; idx[o++] = d
        }
        return Mesh(pos, nrm, uv, conf, idx, null, listOf(material))
    }

    /** Cylinder side around the Y axis from y = 0 to y = height, without caps; one duplicated seam. */
    fun openCylinder(radius: Float = 1f, height: Float = 2f, segments: Int = 32, stacks: Int = 8): Mesh {
        val cols = segments + 1
        val count = (stacks + 1) * cols
        val pos = FloatArray(3 * count); val nrm = FloatArray(3 * count); val uv = FloatArray(2 * count)
        for (i in 0..stacks) for (j in 0..segments) {
            val phi = 2 * PI * (if (j == segments) 0 else j) / segments
            val k = i * cols + j
            pos[3 * k] = (radius * cos(phi)).toFloat(); pos[3 * k + 1] = height * i / stacks; pos[3 * k + 2] = (radius * sin(phi)).toFloat()
            nrm[3 * k] = cos(phi).toFloat(); nrm[3 * k + 2] = sin(phi).toFloat()
            uv[2 * k] = j.toFloat() / segments; uv[2 * k + 1] = 1f - i.toFloat() / stacks
        }
        val idx = IntArray(stacks * segments * 6)
        var o = 0
        for (i in 0 until stacks) for (j in 0 until segments) {
            val a = i * cols + j; val b = (i + 1) * cols + j; val c = i * cols + j + 1; val d = (i + 1) * cols + j + 1
            idx[o++] = a; idx[o++] = b; idx[o++] = c
            idx[o++] = b; idx[o++] = d; idx[o++] = c
        }
        return Mesh(pos, nrm, uv, null, idx, null, listOf(Material("plain")))
    }

    /**
     * Grid in the XZ plane covering [0, size]^2, facing +Y, with uv = (x, z) / size and
     * confidence = x / size. [height] displaces y.
     */
    fun planeGrid(nx: Int = 10, nz: Int = 10, size: Float = 1f, material: Material = Material("plain"), height: (Float, Float) -> Float = { _, _ -> 0f }): Mesh {
        val cols = nx + 1
        val count = cols * (nz + 1)
        val pos = FloatArray(3 * count); val uv = FloatArray(2 * count); val conf = FloatArray(count)
        for (iz in 0..nz) for (ix in 0..nx) {
            val k = iz * cols + ix
            val x = size * ix / nx; val z = size * iz / nz
            pos[3 * k] = x; pos[3 * k + 1] = height(x, z); pos[3 * k + 2] = z
            uv[2 * k] = ix.toFloat() / nx; uv[2 * k + 1] = iz.toFloat() / nz
            conf[k] = ix.toFloat() / nx
        }
        val idx = IntArray(nx * nz * 6)
        var o = 0
        for (iz in 0 until nz) for (ix in 0 until nx) {
            val a = iz * cols + ix; val b = a + 1; val c = a + cols; val d = c + 1
            idx[o++] = a; idx[o++] = c; idx[o++] = b
            idx[o++] = b; idx[o++] = c; idx[o++] = d
        }
        return MeshOps.recomputeNormals(Mesh(pos, null, uv, conf, idx, null, listOf(material)))
    }

    /** Concatenate meshes (attributes present in all inputs are kept); every input keeps its own materials. */
    fun merge(vararg meshes: Mesh): Mesh {
        val vTotal = meshes.sumOf { it.vertexCount }; val fTotal = meshes.sumOf { it.faceCount }
        val pos = FloatArray(3 * vTotal)
        val nrm = if (meshes.all { it.normals != null }) FloatArray(3 * vTotal) else null
        val uv = if (meshes.all { it.uvs != null }) FloatArray(2 * vTotal) else null
        val conf = if (meshes.all { it.confidence != null }) FloatArray(vTotal) else null
        val idx = IntArray(3 * fTotal); val fm = IntArray(fTotal)
        val materials = ArrayList<Material>()
        var vo = 0; var fo = 0
        for (m in meshes) {
            System.arraycopy(m.positions, 0, pos, 3 * vo, 3 * m.vertexCount)
            if (nrm != null) System.arraycopy(m.normals!!, 0, nrm, 3 * vo, 3 * m.vertexCount)
            if (uv != null) System.arraycopy(m.uvs!!, 0, uv, 2 * vo, 2 * m.vertexCount)
            if (conf != null) System.arraycopy(m.confidence!!, 0, conf, vo, m.vertexCount)
            for (i in m.indices.indices) idx[3 * fo + i] = m.indices[i] + vo
            for (f in 0 until m.faceCount) fm[fo + f] = materials.size + m.materialOfFace(f)
            materials.addAll(m.materials)
            vo += m.vertexCount; fo += m.faceCount
        }
        return Mesh(pos, nrm, uv, conf, idx, fm, materials)
    }

    fun translate(mesh: Mesh, t: Vec3) = MeshOps.transform(mesh, dev.pocket3d.core.math.Mat4.translation(t))

    /** Sphere with the faces above y = +cut and (optionally) below y = -cut removed (whole faces, by centroid). */
    fun sphereWithoutCaps(radius: Float, segments: Int, rings: Int, cut: Float, both: Boolean, bottomCut: Float = cut): Mesh {
        val s = uvSphere(radius, segments, rings)
        val remove = BooleanArray(s.faceCount) { f ->
            val y = centroid(s, f).y
            y > cut || (both && y < -bottomCut)
        }
        return MeshOps.removeFaces(s, remove)
    }

    // ---- measurement helpers ----

    fun centroid(m: Mesh, f: Int): Vec3 = (m.position(m.indices[3 * f]) + m.position(m.indices[3 * f + 1]) + m.position(m.indices[3 * f + 2])) / 3f

    fun faceNormal(m: Mesh, f: Int): Vec3 {
        val a = m.position(m.indices[3 * f]); val b = m.position(m.indices[3 * f + 1]); val c = m.position(m.indices[3 * f + 2])
        return (b - a).cross(c - a)
    }

    fun faceArea(m: Mesh, f: Int): Float = faceNormal(m, f).length() * 0.5f

    fun minFaceArea(m: Mesh): Float = (0 until m.faceCount).minOf { faceArea(m, it) }

    /** Smallest ratio 2 * area / longestEdge^2 over all faces (0 = degenerate, 0.87 = equilateral). */
    fun minFaceQuality(m: Mesh): Float = (0 until m.faceCount).minOf { f ->
        val a = m.position(m.indices[3 * f]); val b = m.position(m.indices[3 * f + 1]); val c = m.position(m.indices[3 * f + 2])
        val longest = maxOf((b - a).lengthSq(), (c - b).lengthSq(), (a - c).lengthSq())
        if (longest == 0f) 0f else (b - a).cross(c - a).length() / longest
    }

    fun areaOf(m: Mesh, predicate: (Int) -> Boolean): Double {
        var a = 0.0
        for (f in 0 until m.faceCount) if (predicate(f)) a += faceArea(m, f)
        return a
    }

    fun length(a: Vec3) = sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}
