# Archived test output of the final build

| File / folder | What | Result |
|---|---|---|
| `companion-pytest.txt`, `companion-pytest.xml` | `cd companion && .venv-dev/bin/python -m pytest` — server, security, jobs, pipeline units and the container end-to-end tests against the shipped image | 178 tests, 0 failures, 0 errors, 0 skipped |
| `android-unit/capture-testDebugUnitTest/` | Gradle JUnit XML | 109 tests, 0 failures, 0 skipped |
| `android-unit/capture-testReleaseUnitTest/` | Gradle JUnit XML | 109 tests, 0 failures, 0 skipped |
| `android-unit/core-test/` | Gradle JUnit XML | 142 tests, 0 failures, 0 skipped |
| `android-unit/data-testDebugUnitTest/` | Gradle JUnit XML (only the live companion test: this variant was re-run with `POCKET3D_TEST_PAIRING_FILE` set; the full module run is the Release variant) | 1 tests, 0 failures, 0 skipped |
| `android-unit/data-testReleaseUnitTest/` | Gradle JUnit XML | 56 tests, 0 failures, 1 skipped |
| `android-unit/viewer-testDebugUnitTest/` | Gradle JUnit XML | 65 tests, 0 failures, 0 skipped |
| `android-unit/viewer-testReleaseUnitTest/` | Gradle JUnit XML | 65 tests, 0 failures, 0 skipped |
| `android-instrumented-AppFlowTest.txt` | `adb shell am instrument -w -r …` on the emulator against `dist/pocket3d-scanner-1.0.0-debug.apk` | 5 tests, OK |
| `../_phone_data_layer_live/` | `LiveCompanionTest` against the running companion container (real reconstruction of the 12 smoke photos) | 1 test, passed |

The one skipped test in `data-testReleaseUnitTest` is `LiveCompanionTest`, which skips itself unless a running companion is configured.

