package dev.pocket3d.data

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import dev.pocket3d.core.project.ReconJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Foreground service (type dataSync) that keeps the process alive while reconstruction jobs
 * are uploading, running on the companion or downloading, and shows what is really happening.
 * It contains no job logic: the [SyncEngine] publishes its active jobs through
 * [AndroidSyncKeepAlive] and this service only mirrors them into a notification.
 *
 * Without the notification permission the service still runs (the system lists it under
 * active apps); posting simply has no visible effect.
 */
class ReconSyncService : LifecycleService() {

    private var mirror: Job? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        // startForegroundService() obliges us to call startForeground() promptly, whatever the state.
        val entered = try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, build(jobs.value),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
            true
        } catch (_: Exception) {
            // e.g. ForegroundServiceStartNotAllowedException when restarted in the background:
            // supervision continues for as long as the process lives and resumes at the next app start.
            false
        }
        if (!entered) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (mirror == null) {
            mirror = lifecycleScope.launch {
                jobs.collectLatest { list ->
                    if (list.isEmpty()) {
                        // Brief grace period: the next queued job usually starts right away.
                        delay(IDLE_GRACE_MS)
                        ServiceCompat.stopForeground(this@ReconSyncService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                        stopSelf()
                    } else {
                        post(build(list))
                        delay(MIN_UPDATE_INTERVAL_MS)   // rate limit; collectLatest keeps only the newest state
                    }
                }
            }
        }
        return START_STICKY
    }

    /** Android 15+: the daily time budget of dataSync services ran out. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) } catch (_: Exception) { }
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun createChannel() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Reconstruction progress",
                    NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Upload, reconstruction and download progress of 3D scans"
                    setShowBadge(false)
                })
            }
        } catch (_: Exception) {
        }
    }

    private fun post(notification: Notification) {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification)
        } catch (_: Exception) {
            // Notifications are optional; the transfer is not.
        }
    }

    private fun build(list: List<ReconJob>): Notification {
        val job = list.firstOrNull()
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentTitle(if (list.size > 1) "3D reconstruction (${list.size} jobs)" else "3D reconstruction")
            .setContentText(job?.let { SyncText.describe(it) } ?: "Finishing")
        if (job != null) {
            val p = SyncText.progress(job)
            if (p != null) builder.setProgress(1000, (p * 1000).toInt(), false) else builder.setProgress(0, 0, true)
        }
        try {
            packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
                builder.setContentIntent(PendingIntent.getActivity(this, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            }
        } catch (_: Exception) {
        }
        return builder.build()
    }

    companion object {
        private const val CHANNEL_ID = "pocket3d.recon_sync"
        private const val NOTIFICATION_ID = 0x3D5C
        private const val MIN_UPDATE_INTERVAL_MS = 500L
        private const val IDLE_GRACE_MS = 1_500L

        /** Active jobs as last published by the engine. */
        internal val jobs = MutableStateFlow<List<ReconJob>>(emptyList())
        @Volatile internal var running = false
    }
}

/** [SyncKeepAlive] backed by [ReconSyncService]. */
class AndroidSyncKeepAlive(context: Context) : SyncKeepAlive {
    private val appContext = context.applicationContext

    override fun onActiveJobs(jobs: List<ReconJob>) {
        val wasIdle = ReconSyncService.jobs.value.isEmpty()
        ReconSyncService.jobs.value = jobs
        if (jobs.isNotEmpty() && (wasIdle || !ReconSyncService.running)) {
            try {
                ContextCompat.startForegroundService(appContext, Intent(appContext, ReconSyncService::class.java))
            } catch (_: Exception) {
                // Not allowed right now (app in the background on Android 12+). Jobs keep being
                // supervised while the process lives and are resumed when the app is opened.
            }
        }
    }
}
