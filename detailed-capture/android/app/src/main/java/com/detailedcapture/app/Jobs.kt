package com.detailedcapture.app

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.concurrent.LinkedBlockingDeque
import kotlin.concurrent.thread

class DcApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Repo.appContext = this
        // bound CPU / memory use of heavy jobs to what the device can sustain
        val am = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val mi = android.app.ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val totalMB = (mi.totalMem / (1024 * 1024)).toInt()
        Core.memMB = when {
            totalMB >= 7000 -> 900
            totalMB >= 5000 -> 640
            totalMB >= 3000 -> 420
            else -> 256
        }
        val cores = Runtime.getRuntime().availableProcessors()
        Core.threads = when {
            totalMB < 3000 -> 1
            cores >= 8 -> 3
            cores >= 4 -> 2
            else -> 1
        }
        JobManager.start(this)
    }
}

/** A unit of long-running work executed off the UI thread, one at a time, under a foreground service. */
class Job(val type: String, val projectDir: File, val title: String, val work: (job: Job) -> String?) {
    val token: Long = Core.newToken()
    @Volatile var cancelled = false
    @Volatile var manualProgress: Core.Progress? = null
}

data class JobState(val type: String, val projectDir: File, val title: String, val stage: String, val fraction: Double, val detail: String, val queued: Int)
data class JobEvent(val type: String, val projectDir: File, val ok: Boolean, val cancelled: Boolean, val message: String?)

object JobManager {
    val state = MutableStateFlow<JobState?>(null)
    val events = MutableSharedFlow<JobEvent>(extraBufferCapacity = 32)
    /** bumped whenever a job changed project data */
    val revision = MutableStateFlow(0)

    private val queue = LinkedBlockingDeque<Job>()
    @Volatile private var current: Job? = null
    private lateinit var app: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun start(context: Context) {
        app = context.applicationContext
        thread(name = "dc-jobs", isDaemon = true) {
            while (true) {
                val job = queue.take()
                current = job
                runJob(job)
                current = null
                if (queue.isEmpty()) {
                    state.value = null
                    app.stopService(Intent(app, ProcessingService::class.java))
                }
            }
        }
        scope.launch {
            while (isActive) {
                current?.let { j ->
                    val p = j.manualProgress ?: Core.progress(j.token)
                    state.value = JobState(j.type, j.projectDir, j.title, p?.stage ?: j.title, p?.fraction ?: 0.0, p?.detail ?: "", queue.size)
                }
                delay(200)
            }
        }
    }

    private fun runJob(job: Job) {
        state.value = JobState(job.type, job.projectDir, job.title, job.title, 0.0, "", queue.size)
        val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
        val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "detailedcapture:job").apply { acquire(60 * 60 * 1000L) }
        try {
            if (job.cancelled) throw Core.CoreException("cancelled", "Cancelled.")
            val msg = job.work(job)
            revision.value++
            events.tryEmit(JobEvent(job.type, job.projectDir, true, false, msg))
        } catch (e: Core.CoreException) {
            revision.value++
            events.tryEmit(JobEvent(job.type, job.projectDir, false, e.code == "cancelled", e.message))
        } catch (e: UserFacingException) {
            revision.value++
            events.tryEmit(JobEvent(job.type, job.projectDir, false, job.cancelled, e.message))
        } catch (e: Throwable) {
            revision.value++
            events.tryEmit(JobEvent(job.type, job.projectDir, false, false, "Unexpected error: ${e.message}"))
        } finally {
            runCatching { wl.release() }
        }
    }

    fun enqueue(job: Job) {
        // coalesce registration requests for the same project that have not started yet
        if (job.type == "register" && queue.any { it.type == "register" && it.projectDir == job.projectDir }) return
        queue.put(job)
        state.value = state.value?.copy(queued = queue.size) ?: JobState(job.type, job.projectDir, job.title, "Queued", 0.0, "", queue.size)
        ContextCompat.startForegroundService(app, Intent(app, ProcessingService::class.java))
    }

    fun cancelCurrent() {
        current?.let {
            it.cancelled = true
            Core.cancel(it.token)
        }
    }

    fun cancelAll(projectDir: File? = null) {
        queue.removeAll { projectDir == null || it.projectDir == projectDir }
        current?.let { if (projectDir == null || it.projectDir == projectDir) cancelCurrent() }
    }

    fun isBusy(projectDir: File): Boolean = current?.projectDir == projectDir || queue.any { it.projectDir == projectDir }

    // ---- job factories ------------------------------------------------------------------------------
    fun register(dir: File, full: Boolean = false) = enqueue(Job("register", dir, "Checking close-ups") { job ->
        Core.call("register", JSONObject().put("dir", dir.absolutePath).put("full", full), job.token)
        Core.call("coverage", JSONObject().put("dir", dir.absolutePath))
        null
    })

    fun compose(dir: File) = enqueue(Job("compose", dir, "Fusing detail") { job ->
        Core.call("register", JSONObject().put("dir", dir.absolutePath), job.token)
        val r = Core.call("compose", JSONObject().put("dir", dir.absolutePath), job.token)
        "Fused ${r.optInt("width")} × ${r.optInt("height")} px"
    })

    fun addFrame(dir: File, title: String, work: () -> Unit) = enqueue(Job("add", dir, title) { work(); null })
}

/** Keeps processing alive while the app is in the background and shows real progress with a cancel action. */
class ProcessingService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            JobManager.cancelCurrent()
            return START_NOT_STICKY
        }
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Processing", NotificationManager.IMPORTANCE_LOW))
        val n = build(JobManager.state.value)
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(NOTIF_ID, n)
        scope.launch {
            JobManager.state.collect { st ->
                if (st != null) runCatching { nm.notify(NOTIF_ID, build(st)) }
            }
        }
        return START_NOT_STICKY
    }

    private fun build(st: JobState?): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val cancel = PendingIntent.getService(this, 1, Intent(this, ProcessingService::class.java).setAction(ACTION_CANCEL), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(st?.title ?: "Detailed Capture")
            .setContentText(st?.let { "${it.stage} ${(it.fraction * 100).toInt()}%" } ?: "Working…")
            .setProgress(100, ((st?.fraction ?: 0.0) * 100).toInt(), st == null)
            .setOngoing(true).setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "Cancel", cancel)
            .build()
    }

    override fun onDestroy() {
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "processing"
        const val NOTIF_ID = 42
        const val ACTION_CANCEL = "com.detailedcapture.app.CANCEL"
    }
}
