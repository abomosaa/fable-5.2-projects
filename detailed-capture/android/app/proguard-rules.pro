# JNI entry points are looked up by name from native code.
-keep class com.detailedcapture.app.Core { *; }
-keepclasseswithmembernames class * { native <methods>; }
