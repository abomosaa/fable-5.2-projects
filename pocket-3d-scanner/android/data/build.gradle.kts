plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.pocket3d.data"
    compileSdk = 36
    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { jvmToolchain(17) }
    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            it.maxHeapSize = "768m"
            it.testLogging { events("failed", "skipped") }
            // Optional integration tests against a real companion (RealCompanionIntegrationTest).
            for (name in listOf("POCKET3D_TEST_COMPANION", "POCKET3D_TEST_PAIRING_FILE", "POCKET3D_TEST_IMAGES")) {
                val value = System.getenv(name) ?: ""
                if (value.isNotEmpty()) it.environment(name, value)
                it.inputs.property(name, value)
            }
            // A pairing code is single-use: never serve these tests from the build cache.
            if (!System.getenv("POCKET3D_TEST_COMPANION").isNullOrEmpty() ||
                !System.getenv("POCKET3D_TEST_PAIRING_FILE").isNullOrEmpty()) it.outputs.upToDateWhen { false }
        }
    }
}

dependencies {
    api(project(":core"))
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    implementation(libs.coroutines.android)
    implementation(libs.exifinterface)
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.service)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
    androidTestImplementation(libs.androidx.test.ext)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.coroutines.test)
    androidTestImplementation(libs.okhttp.mockwebserver)
}
