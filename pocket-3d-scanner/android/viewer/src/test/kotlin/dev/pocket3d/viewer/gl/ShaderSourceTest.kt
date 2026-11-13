package dev.pocket3d.viewer.gl

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The shaders cannot run in a JVM test, but their sources can be checked: basic GLSL ES 3.00
 * hygiene always, and a real compile + link with the Khronos reference compiler
 * (`glslangValidator`) when it is installed on the build machine.
 */
class ShaderSourceTest {
    private val programs = listOf(
        Triple("mesh", Shaders.MESH_VS, Shaders.MESH_FS),
        Triple("lines", Shaders.LINE_VS, Shaders.COLOR_FS),
        Triple("wide lines", Shaders.WIDE_LINE_VS, Shaders.VERTEX_COLOR_FS),
        Triple("points", Shaders.POINT_VS, Shaders.POINT_FS),
        Triple("background", Shaders.BACKGROUND_VS, Shaders.BACKGROUND_FS),
        Triple("camera background", Shaders.CAMERA_BG_VS, Shaders.CAMERA_BG_FS),
        Triple("planes", Shaders.PLANE_VS, Shaders.PLANE_FS),
        Triple("contact shadow", Shaders.SHADOW_VS, Shaders.SHADOW_FS),
    )

    @Test fun sourcesFollowTheEs300Rules() {
        for ((name, vs, fs) in programs) for ((kind, src) in listOf("vertex" to vs, "fragment" to fs)) {
            val lines = src.lines()
            assertEquals("$name $kind: #version must be the very first line", "#version 300 es", lines[0])
            assertTrue("$name $kind: default float precision missing", lines.any { it.trim().startsWith("precision ") && it.contains("float") })
            assertTrue("$name $kind: no main()", src.contains("void main()"))
            val extensions = lines.filter { it.trim().startsWith("#extension") }
            if (name == "camera background" && kind == "fragment")
                assertEquals(listOf("#extension GL_OES_EGL_image_external_essl3 : require"), extensions.map { it.trim() })
            else assertTrue("$name $kind must not need extensions", extensions.isEmpty())
            for (legacy in listOf("gl_FragColor", "texture2D(", "attribute ", "varying "))
                assertTrue("$name $kind uses ES 2 syntax: $legacy", !src.contains(legacy))
        }
    }

    private fun validator(): String? = listOf("/usr/bin/glslangValidator", "/usr/local/bin/glslangValidator").firstOrNull { File(it).canExecute() }

    private fun run(vararg cmd: String): Pair<Int, String> {
        val p = ProcessBuilder(*cmd).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        assertTrue("glslangValidator did not finish", p.waitFor(60, TimeUnit.SECONDS))
        return p.exitValue() to out
    }

    @Test fun everyProgramCompilesAndLinksWithTheReferenceCompiler() {
        val tool = validator()
        assumeTrue("glslangValidator is not installed", tool != null)
        val dir = File(System.getProperty("java.io.tmpdir"), "p3d-glsl-${System.nanoTime()}").apply { mkdirs() }
        try {
            for ((i, p) in programs.withIndex()) {
                val vs = File(dir, "p$i.vert").apply { writeText(p.second + "\n") }
                val fs = File(dir, "p$i.frag").apply { writeText(p.third + "\n") }
                val (code, out) = run(tool!!, "-l", vs.path, fs.path)
                assertEquals("program \"${p.first}\" does not compile/link:\n$out", 0, code)
            }
            // the check itself must be able to fail: a broken shader is rejected
            val bad = File(dir, "bad.frag").apply { writeText(Shaders.COLOR_FS.replace("fragColor = uColor;", "fragColor = uColour;") + "\n") }
            assertTrue(run(tool!!, bad.path).first != 0)
        } finally {
            dir.deleteRecursively()
        }
    }
}
