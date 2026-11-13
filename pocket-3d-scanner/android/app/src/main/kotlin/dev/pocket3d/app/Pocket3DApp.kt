package dev.pocket3d.app

import android.app.Application
import dev.pocket3d.data.DataModule

class Pocket3DApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Builds storage + companion client, publishes them through core.services.Services and
        // resumes supervision of reconstruction jobs that were active when the process died.
        DataModule.install(this)
    }
}
