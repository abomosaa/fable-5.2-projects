package com.detailedcapture.app

import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong

/** Thin bridge to the native core. Every command goes through one generic JSON entry point. */
object Core {
    init {
        System.loadLibrary("dcjni")
    }

    private external fun nativeCall(cmd: String, args: String, token: Long, threads: Int, memMB: Int): String
    private external fun nativeCancel(token: Long)
    private external fun nativeProgress(token: Long): String
    private external fun nativeLocate(dir: String, buffer: ByteBuffer, w: Int, h: Int, rowStride: Int, rotation: Int): String

    class CoreException(val code: String, message: String) : Exception(message)

    data class Progress(val stage: String, val fraction: Double, val detail: String)

    private val tokens = AtomicLong(1000)

    /** Worker threads and memory budget for heavy jobs; set from device capabilities at start-up. */
    @Volatile var threads = 2
    @Volatile var memMB = 384

    fun newToken(): Long = tokens.incrementAndGet()

    /** Blocking call. Throws [CoreException] with a plain-language message on failure. */
    fun call(cmd: String, args: JSONObject = JSONObject(), token: Long = 0): JSONObject {
        val raw = nativeCall(cmd, args.toString(), token, threads, memMB)
        val r = JSONObject(raw)
        if (!r.optBoolean("ok")) {
            val e = r.optJSONObject("error")
            throw CoreException(e?.optString("code") ?: "internal", e?.optString("message") ?: "Unknown error")
        }
        return r.optJSONObject("data") ?: JSONObject()
    }

    fun cancel(token: Long) = nativeCancel(token)

    fun progress(token: Long): Progress? {
        val s = nativeProgress(token)
        if (s.isEmpty()) return null
        val j = JSONObject(s)
        return Progress(j.optString("stage"), j.optDouble("fraction", 0.0), j.optString("detail"))
    }

    fun locate(dir: String, buffer: ByteBuffer, w: Int, h: Int, rowStride: Int, rotation: Int): JSONObject =
        JSONObject(nativeLocate(dir, buffer, w, h, rowStride, rotation))
}
