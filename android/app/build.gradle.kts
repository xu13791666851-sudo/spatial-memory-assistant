plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

val isolatedTabletTest = providers.gradleProperty("isolatedTabletTest")
    .map(String::toBooleanStrict).orElse(false).get()

android {
    namespace = "com.spatialmemory.assistant"
    compileSdk = 36

    defaultConfig {
        // Separate install preserves every existing test app and its private memories.
        applicationId = if (isolatedTabletTest) "com.spatialmemory.assistant.iseeyou.tablettest" else "com.spatialmemory.assistant.iseeyou.native"
        manifestPlaceholders["appLabel"] = if (isolatedTabletTest) "I SEE YOU 平板测试" else "I SEE YOU 原生测试"
        minSdk = 26
        targetSdk = 36
        versionCode = 22
        versionName = if (isolatedTabletTest) "0.16.0-tablet-memory" else "0.16.0-native-memory"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += "arm64-v8a" }
        buildConfigField("boolean", "PC_GATEWAY_MODE", "true")
        buildConfigField("String", "QWEN_API_KEY", "\"\"")
        buildConfigField("String", "GATEWAY_URL", "\"https://i-see-you-android-core-test.pages.dev\"")
        buildConfigField("String", "SUPABASE_URL", "\"https://awkzcvvzrsfjvqlloqqi.supabase.co\"")
        buildConfigField("String", "SUPABASE_PUBLISHABLE_KEY", "\"sb_publishable_fWXqw7l-psI5pqwbY3zQlA_-Z7D74Yp\"")
    }

    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    androidResources { noCompress += "tflite"; ignoreAssetsPattern = "site" }
    buildFeatures { buildConfig = true }
    sourceSets {
        getByName("main").jniLibs.srcDirs("libs")
    }
    testOptions { unitTests.isIncludeAndroidResources = true }
}

dependencies {
    implementation(files("libs/AoqClientSdk-release.aar"))
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.9.1")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("androidx.room:room-runtime:2.7.2")
    implementation("androidx.room:room-ktx:2.7.2")
    ksp("androidx.room:room-compiler:2.7.2")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.tensorflow:tensorflow-lite:2.17.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
