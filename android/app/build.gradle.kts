import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Sürüm masaüstüyle aynı: ../package.json
val pkgVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(rootProject.file("../package.json").readText())!!.groupValues[1]
val (vMaj, vMin, vPat) = pkgVersion.split(".").map { it.toInt() }

// İmza: yerelde ~/Library/Android/surebrowser-keystore.properties, CI'da ortam değişkenleri
val signProps = Properties().apply {
    val f = File(System.getProperty("user.home"), "Library/Android/surebrowser-keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
    System.getenv("SB_KEYSTORE_FILE")?.let { setProperty("storeFile", it) }
    System.getenv("SB_KEYSTORE_PASSWORD")?.let { setProperty("storePassword", it); setProperty("keyPassword", it) }
    System.getenv("SB_KEY_ALIAS")?.let { setProperty("keyAlias", it) }
}

android {
    namespace = "com.surebrowser.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.surebrowser.app"
        minSdk = 29
        targetSdk = 35
        versionCode = vMaj * 10000 + vMin * 100 + vPat
        versionName = pkgVersion
        buildConfigField("String", "UPDATE_REPO", "\"capitalteam02/surebrowser\"")
    }
    signingConfigs {
        create("release") {
            if (signProps.getProperty("storeFile") != null) {
                storeFile = file(signProps.getProperty("storeFile"))
                storePassword = signProps.getProperty("storePassword")
                keyAlias = signProps.getProperty("keyAlias", "surebrowser")
                keyPassword = signProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (signProps.getProperty("storeFile") != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-ktx:1.13.1")
}
