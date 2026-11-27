package com.surebrowser.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** GitHub Releases'tan güncelleme: yeni sürüm varsa sorar, APK'yı indirip Android kurulumunu açar. */
object Updater {
    private val main = Handler(Looper.getMainLooper())
    private var shownThisRun = false

    private fun newer(a: String, b: String): Boolean {
        val x = a.trimStart('v').split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.trimStart('v').split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) { val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }; if (d != 0) return d > 0 }
        return false
    }

    fun checkOnLaunch(a: Activity) { if (!shownThisRun) { shownThisRun = true; check(a, manual = false) } }

    fun check(a: Activity, manual: Boolean) {
        Thread {
            try {
                val c = URL("https://api.github.com/repos/${BuildConfig.UPDATE_REPO}/releases/latest").openConnection() as HttpURLConnection
                c.setRequestProperty("Accept", "application/vnd.github+json"); c.connectTimeout = 10_000; c.readTimeout = 10_000
                val j = JSONObject(c.inputStream.bufferedReader().readText())
                val tag = j.optString("tag_name")
                val assets = j.optJSONArray("assets")
                var apk: String? = null
                if (assets != null) for (i in 0 until assets.length()) assets.getJSONObject(i).let { if (it.optString("name").endsWith(".apk")) apk = it.optString("browser_download_url") }
                main.post {
                    if (a.isFinishing) return@post
                    if (apk != null && newer(tag, BuildConfig.VERSION_NAME)) ask(a, tag.trimStart('v'), apk!!)
                    else if (manual) Toast.makeText(a, "SureBrowser güncel (${BuildConfig.VERSION_NAME})", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                if (manual) main.post { Toast.makeText(a, "Güncelleme denetlenemedi", Toast.LENGTH_SHORT).show() }
            }
        }.start()
    }

    private fun ask(a: Activity, version: String, url: String) {
        AlertDialog.Builder(a).setTitle("Yeni güncelleme var")
            .setMessage("SureBrowser $version hazır (şu an ${BuildConfig.VERSION_NAME}).\n\nİndirilip kurulur. Kimlikleriniz, IP'leriniz ve şifreleriniz korunur.")
            .setPositiveButton("Güncelle") { _, _ -> download(a, version, url) }
            .setNegativeButton("Sonra", null).show()
    }

    private fun download(a: Activity, version: String, url: String) {
        Toast.makeText(a, "Güncelleme indiriliyor…", Toast.LENGTH_SHORT).show()
        Thread {
            try {
                val dir = File(a.cacheDir, "updates").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val f = File(dir, "SureBrowser-$version.apk")
                (URL(url).openConnection() as HttpURLConnection).apply { instanceFollowRedirects = true }.inputStream.use { i -> f.outputStream().use { o -> i.copyTo(o) } }
                val uri = FileProvider.getUriForFile(a, "${a.packageName}.files", f)
                main.post {
                    a.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            } catch (e: Exception) { main.post { Toast.makeText(a, "Güncelleme indirilemedi", Toast.LENGTH_LONG).show() } }
        }.start()
    }
}
