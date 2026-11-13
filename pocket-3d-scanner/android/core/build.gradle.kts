// Pure Kotlin/JVM library: math, mesh processing, file formats, capture-quality and
// coordinate-convention logic. No Android dependencies, so everything here is covered by
// fast deterministic JVM unit tests (`./gradlew :core:test`).
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}
kotlin { jvmToolchain(17) }
dependencies {
    api(libs.serialization.json)
    api(libs.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
tasks.test {
    useJUnit()
    maxHeapSize = "2g"
    testLogging { events("failed", "skipped") }
}
