package com.surebrowser.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.ContentValues
import android.content.Intent
import android.content.res.Configuration
import android.database.ContentObserver
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.provider.MediaStore
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.*
import android.widget.*
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.util.concurrent.Executors

/**
 * Bir kimliğin tarayıcı penceresi. Her yuva (Browser0..Browser11) ayrı Android işleminde çalışır:
 * kendi WebView veri klasörü (çerez, önbellek), kendi yerel proxy köprüsü ve dolayısıyla kendi IP'si.
 */
open class BrowserActivity : Activity() {
    companion object {
        private var processIdent: String? = null
        private const val TAG = "SBTEST"
    }

    private lateinit var ident: String
    private lateinit var bridge: ProxyBridge
    private val io = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    private var proxy: SbProxy? = null
    private var proxyReady = false
    private val pendingLoads = mutableListOf<() -> Unit>()

    private class Tab(val web: WebView) { var title = "Yeni sekme"; var url = "" }
    private val tabs = mutableListOf<Tab>()
    private var active = -1

    private lateinit var idBar: LinearLayout
    private lateinit var idFlag: TextView
    private lateinit var idNote: TextView
    private lateinit var idSub: TextView
    private lateinit var address: EditText
    private lateinit var backBtn: TextView
    private lateinit var fwdBtn: TextView
    private lateinit var tabCount: TextView
    private lateinit var tabStrip: LinearLayout
    private lateinit var tabStripScroll: HorizontalScrollView
    private lateinit var webBox: FrameLayout
    private lateinit var promptBar: LinearLayout
    private lateinit var progress: ProgressBar
    private lateinit var rootView: LinearLayout

    private val identObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) { io.execute { applyProxy(Store.proxy(this@BrowserActivity, "check", ident), "observer") } }
    }
    private val health = object : Runnable {
        override fun run() { io.execute { applyProxy(Store.proxy(this@BrowserActivity, "check", ident), "health") }; main.postDelayed(this, 60_000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ident = intent.getStringExtra("ident") ?: run { finish(); return }
        // Bu işlem yalnızca bir kimliğe ait olabilir (WebView veri klasörü işlem başına bir kez seçilir)
        if (processIdent == null) {
            WebView.setDataDirectorySuffix("id_" + ident.replace(Regex("[^A-Za-z0-9]"), "_"))
            processIdent = ident
        } else if (processIdent != ident) {
            Toast.makeText(this, "Bu pencere yeniden başlatılıyor, tekrar dokunun", Toast.LENGTH_LONG).show()
            finishAndRemoveTask(); android.os.Process.killProcess(android.os.Process.myPid()); return
        }
        Store.hold(this) // ana işlem bu pencere açıkken dondurulmasın
        bridge = ProxyBridge().start()
        bridge.direct = ident == DIRECT
        var lastErrCheck = 0L
        bridge.onUpstreamError = {
            val now = System.currentTimeMillis()
            if (now - lastErrCheck > 8_000) { lastErrCheck = now; Log.i(TAG, "upstream-error|$ident"); io.execute { applyProxy(Store.proxy(this, "acquire", ident), "error") } }
        }
        buildUi()
        setupProxyOverride()
        contentResolver.registerContentObserver(StateProvider.identUri(ident), false, identObserver)
        io.execute { Store.call(this, "markUsed", ident) }

        // IP'yi al, sonra oturumu geri yükle
        io.execute {
            val p = if (ident == DIRECT) null else Store.proxy(this, "acquire", ident)
            val sess = Store.str(this, "sessionGet", ident)
            main.post {
                applyProxy(p, "acquire")
                val extraUrl = intent.getStringExtra("url")
                val list = runCatching { JSONObject(sess!!).getJSONArray("tabs") }.getOrNull()
                if (list != null && list.length() > 0) {
                    for (i in 0 until list.length()) newTab(list.getJSONObject(i).optString("url"), activate = false)
                    activate(runCatching { JSONObject(sess!!).optInt("active") }.getOrDefault(0).coerceIn(0, tabs.size - 1))
                } else newTab(extraUrl ?: "", activate = true)
                if (extraUrl != null && list != null && list.length() > 0) newTab(extraUrl, true)
            }
        }
        main.postDelayed(health, 60_000)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra("url")?.let { newTab(it, true) }
    }

    override fun onPause() { super.onPause(); runCatching { CookieManager.getInstance().flush() }; saveSession() }
    override fun onStop() { super.onStop(); runCatching { CookieManager.getInstance().flush() } }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        runCatching { contentResolver.unregisterContentObserver(identObserver) }
        if (::bridge.isInitialized) bridge.stop()
        if (isFinishing && ::ident.isInitialized) {
            // Kimlik kapandı: yuvayı boşalt, işlemi sonlandır (yuva başka kimliğe verilebilsin)
            val i = ident
            Thread { runCatching { Store.call(applicationContext, "releaseSlot", i) }; android.os.Process.killProcess(android.os.Process.myPid()) }.start()
        }
        super.onDestroy()
    }

    /* ---------- Proxy ---------- */

    private fun setupProxyOverride() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            Toast.makeText(this, "Bu cihazın WebView sürümü proxy desteklemiyor. Android System WebView'i güncelleyin.", Toast.LENGTH_LONG).show()
            proxyReady = false; return
        }
        val cfg = ProxyConfig.Builder().addProxyRule("127.0.0.1:${bridge.port}").apply {
            // localhost da köprüden geçsin (test sunucuları dahil); destekliyse
            runCatching { removeImplicitRules() }
        }.build()
        ProxyController.getInstance().setProxyOverride(cfg, { it.run() }) {
            proxyReady = true
            pendingLoads.toList().forEach { it() }; pendingLoads.clear()
        }
    }

    private fun applyProxy(p: SbProxy?, why: String) {
        if (ident == DIRECT) { main.post { renderIdentity() }; return }
        val old = proxy
        proxy = p
        bridge.upstream.set(p)
        main.post {
            renderIdentity()
            if (old != null && p != null && old.id != p.id) {
                notice("${old.exitIp} çöktü ya da değişti, yerine ${p.exitIp} geldi. Oturum korunuyor.")
                current()?.web?.reload()
            } else if (p != null && old == null && why != "acquire") {
                notice("Yeni IP: ${p.exitIp}"); current()?.web?.reload()
            } else if (p == null && old != null) notice("Bu ülkede kullanılabilir IP kalmadı. Bağlantı kesildi (gerçek IP kullanılmaz).")
            else if (p == null && why == "acquire") notice("Bu kimlik için çalışan IP yok. IP havuzuna bu ülkeden IP ekleyin.")
        }
    }

    /* ---------- Arayüz ---------- */

    private fun iconBtn(label: String, desc: String, onClick: () -> Unit) = TextView(this).apply {
        text = label; textSize = 20f; gravity = Gravity.CENTER; contentDescription = desc
        setTextColor(Pal.ink(context)); minWidth = dp(44); minHeight = dp(44)
        ripple(rounded(0x00000000, dp(10).toFloat())); setOnClickListener { onClick() }
    }

    private fun buildUi() {
        val root = vbox()
        rootView = root
        // Kimlik çubuğu: bayrak, IP notu, ülke · renk · IP
        idBar = hbox().apply { setPadding(dp(12), dp(8), dp(6), dp(8)) }
        idFlag = text("", 22f)
        idNote = text("", 16f, bold = true, lines = 1)
        idSub = text("", 12.5f, lines = 1)
        val idText = vbox().add(idNote).add(idSub)
        idBar.add(idFlag, lp(-2, -2).margins(r = dp(10))); idBar.add(idText, lp(0, -2, 1f))
        idBar.add(barBtn("Kimlikler") { startActivity(Intent(this, HubActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) })
        idBar.add(barBtn("⋮") { showMenu(it) })
        root.add(idBar)

        // Adres satırı
        val nav = hbox().apply { setPadding(dp(4), dp(4), dp(8), dp(4)); setBackgroundColor(Pal.bar(context)) }
        backBtn = iconBtn("‹", "Geri") { current()?.web?.let { if (it.canGoBack()) it.goBack() } }
        fwdBtn = iconBtn("›", "İleri") { current()?.web?.let { if (it.canGoForward()) it.goForward() } }
        val reload = iconBtn("⟳", "Yenile") { current()?.web?.reload() }
        address = EditText(this).apply {
            setSingleLine(); textSize = 14f; hint = "Adres yazın veya arayın"
            imeOptions = EditorInfo.IME_ACTION_GO; inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            background = rounded(Pal.bg(context), dp(12).toFloat()); setPadding(dp(12), dp(8), dp(12), dp(8))
            setSelectAllOnFocus(true)
            setOnEditorActionListener { _, a, e ->
                if (a == EditorInfo.IME_ACTION_GO || (e != null && e.keyCode == KeyEvent.KEYCODE_ENTER && e.action == KeyEvent.ACTION_DOWN)) { go(text.toString()); true } else false
            }
        }
        tabCount = TextView(this).apply {
            textSize = 13f; gravity = Gravity.CENTER; setTextColor(Pal.ink(context)); typeface = android.graphics.Typeface.DEFAULT_BOLD
            background = rounded(0, dp(6).toFloat(), Pal.ink(context), dp(2)); minWidth = dp(28); minHeight = dp(28)
            contentDescription = "Sekmeler"; setOnClickListener { tabStripScroll.visibility = if (tabStripScroll.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        }
        nav.add(backBtn).add(fwdBtn).add(reload).add(address, lp(0, dp(42), 1f).margins(l = dp(4), r = dp(8)))
        nav.add(tabCount, lp(dp(32), dp(32)).margins(r = dp(4)))
        nav.add(iconBtn("+", "Yeni sekme") { newTab("", true) })
        root.add(nav)

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = View.GONE }
        root.add(progress, lp(-1, dp(3)))

        // Sekme şeridi (aynı kimlik, aynı IP)
        tabStrip = hbox().apply { setPadding(dp(6), dp(4), dp(6), dp(6)) }
        tabStripScroll = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(tabStrip); setBackgroundColor(Pal.bar(context)) }
        root.add(tabStripScroll)

        webBox = FrameLayout(this).apply { setBackgroundColor(0xFFFFFFFF.toInt()) }
        root.add(webBox, lp(-1, 0, 1f))

        // Şifre kaydetme sorusu
        promptBar = hbox(dp(10)).apply { visibility = View.GONE; setBackgroundColor(Pal.surface(context)) }
        root.add(promptBar)
        setContentView(root)
        root.fitSystemBars()
        renderIdentity()
    }

    private fun barBtn(label: String, onClick: (View) -> Unit) = TextView(this).apply {
        text = label; textSize = 14f; gravity = Gravity.CENTER; setPadding(dp(12), dp(8), dp(12), dp(8)); minHeight = dp(40)
        setOnClickListener { onClick(it) }
    }

    private fun renderIdentity() {
        val col = identColor(ident); val ink = inkFor(col)
        idBar.setBackgroundColor(col)
        rootView.setBackgroundColor(col)
        window.statusBarColor = col
        for (i in 0 until idBar.childCount) (idBar.getChildAt(i) as? TextView)?.setTextColor(ink)
        idNote.setTextColor(ink); idSub.setTextColor(ink); idSub.alpha = 0.9f
        val p = proxy
        idFlag.text = if (ident == DIRECT) "🌐" else flagEmoji(slotCc(ident))
        idNote.text = p?.note?.takeIf { it.isNotEmpty() } ?: identLabel(ident)
        idSub.text = when {
            ident == DIRECT -> "Proxysiz · gerçek IP"
            p == null -> "${identLabel(ident)} · IP yok, bağlantı kesik"
            else -> listOfNotNull(if (p.note.isNotEmpty()) identLabel(ident) else null, p.exitIp, p.city.takeIf { it.isNotEmpty() }).joinToString(" · ")
        }
        // Son kullanılanlar ekranında kimlik adı ve rengi
        val label = (p?.note?.takeIf { it.isNotEmpty() }?.let { "$it · " } ?: "") + identLabel(ident)
        @Suppress("DEPRECATION")
        setTaskDescription(ActivityManager.TaskDescription(label, null as Bitmap?, col))
    }

    private fun renderTabs() {
        tabStrip.removeAllViews()
        tabs.forEachIndexed { i, t ->
            val on = i == active
            val chip = hbox().apply {
                setPadding(dp(12), dp(6), dp(4), dp(6))
                background = rounded(if (on) identColor(ident) else Pal.surface(context), dp(16).toFloat(), Pal.line(context), if (on) 0 else dp(1))
            }
            val ink = if (on) inkFor(identColor(ident)) else Pal.ink(this)
            chip.add(text(t.title.ifEmpty { "Yeni sekme" }, 13f, ink, lines = 1).apply { maxWidth = dp(170) })
            chip.add(TextView(this).apply { text = "  ✕"; textSize = 13f; setTextColor(ink); setPadding(dp(4), 0, dp(8), 0); setOnClickListener { closeTab(i) } })
            chip.setOnClickListener { activate(i) }
            tabStrip.add(chip, lp(-2, -2).margins(r = dp(6)))
        }
        tabCount.text = tabs.size.toString()
        // Dar ekranda (Fold dış ekranı) adres çubuğuna yer açılsın: ileri düğmesi gizlenir
        fwdBtn.visibility = if (resources.configuration.screenWidthDp < 600) View.GONE else View.VISIBLE
        // Geniş ekranda (Fold iç ekran) şerit hep açık; dar ekranda birden çok sekme varsa
        val wide = resources.configuration.screenWidthDp >= 600
        if (wide || tabs.size > 1) tabStripScroll.visibility = View.VISIBLE else tabStripScroll.visibility = View.GONE
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        renderTabs() // katla/aç: WebView'ler yeniden oluşturulmaz, yalnızca şerit uyarlanır
    }

    private fun current(): Tab? = tabs.getOrNull(active)

    private fun showMenu(anchor: View) {
        PopupMenu(this, anchor).apply {
            menu.add("Yeni sekme").setOnMenuItemClickListener { newTab("", true); true }
            if (ident != DIRECT) {
                menu.add("Bu kimliğe yeni IP ver").setOnMenuItemClickListener { io.execute { applyProxy(Store.proxy(this@BrowserActivity, "nextIp", ident), "next") }; true }
                menu.add("IP'yi şimdi denetle").setOnMenuItemClickListener { io.execute { applyProxy(Store.proxy(this@BrowserActivity, "acquire", ident), "check") }; true }
            }
            menu.add("Başka kimliği yan yana aç").setOnMenuItemClickListener {
                startActivity(Intent(this@BrowserActivity, HubActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT)); true
            }
            menu.add("Çerez ve önbelleği temizle").setOnMenuItemClickListener {
                android.app.AlertDialog.Builder(this@BrowserActivity).setMessage("${identLabel(ident)}: tüm sitelerden çıkış yapılır. Kayıtlı şifreler silinmez.")
                    .setPositiveButton("Temizle") { _, _ ->
                        CookieManager.getInstance().removeAllCookies(null); WebStorage.getInstance().deleteAllData()
                        tabs.forEach { it.web.clearCache(true) }; current()?.web?.reload()
                    }.setNegativeButton("Vazgeç", null).show(); true
            }
            menu.add("Kimliği kapat").setOnMenuItemClickListener { saveSession(); finishAndRemoveTask(); true }
        }.show()
    }

    /* ---------- Sekmeler ---------- */

    private val chromeUa by lazy {
        WebSettings.getDefaultUserAgent(this).replace("; wv", "").replace(Regex(" Version/\\d+\\.\\d+"), "")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(): WebView {
        val w = WebView(this)
        w.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
            loadWithOverviewMode = true; useWideViewPort = true
            builtInZoomControls = true; displayZoomControls = false
            setSupportMultipleWindows(true); javaScriptCanOpenWindowsAutomatically = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = chromeUa
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        installScripts(w)
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "http" || u.scheme == "https" || u.scheme == "about" || u.scheme == "data" || u.scheme == "blob") return false
                runCatching { startActivity(Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                return true
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { tabOf(view)?.url = url; if (view == current()?.web) { setAddress(url); progress.visibility = View.VISIBLE }; updateNav() }
            override fun onPageFinished(view: WebView, url: String) {
                tabOf(view)?.let { it.url = url; it.title = view.title ?: url }
                if (view == current()?.web) { setAddress(url); progress.visibility = View.GONE }
                Log.i(TAG, "page|$ident|${view.title}|$url")
                updateNav(); renderTabs(); saveSession()
                CookieManager.getInstance().flush() // girişler ani kapanmada kaybolmasın
            }
            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (!req.isForMainFrame) return
                val d = err.description?.toString() ?: ""
                Log.i(TAG, "error|$ident|$d")
                if (ident != DIRECT && ("PROXY" in d || "TUNNEL" in d || "SOCKS" in d || "CONNECTION" in d))
                    io.execute { applyProxy(Store.proxy(this@BrowserActivity, "acquire", ident), "error") }
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String?) { tabOf(view)?.title = title ?: ""; Log.i(TAG, "title|$ident|$title"); renderTabs() }
            override fun onProgressChanged(view: WebView, p: Int) { if (view == current()?.web) progress.progress = p }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                // Yeni pencere istekleri aynı kimlikte yeni sekme olur
                val t = newTab(null, true)
                (resultMsg.obj as WebView.WebViewTransport).webView = t.web
                resultMsg.sendToTarget(); return true
            }
            override fun onCloseWindow(window: WebView) { tabs.indexOfFirst { it.web == window }.takeIf { it >= 0 }?.let { closeTab(it) } }
            // İzin sorusu yok: masaüstündeki gibi
            override fun onPermissionRequest(request: PermissionRequest) { request.grant(request.resources) }
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) { callback.invoke(origin, true, false) }
        }
        w.setDownloadListener { url, ua, disposition, mime, _ -> download(url, ua, disposition, mime) }
        return w
    }

    private fun tabOf(w: WebView) = tabs.firstOrNull { it.web == w }

    /** url null: onCreateWindow (WebView yükleyecek) */
    private fun newTab(url: String?, activate: Boolean): Tab {
        val t = Tab(makeWebView())
        tabs += t
        webBox.addView(t.web, FrameLayout.LayoutParams(-1, -1))
        t.web.visibility = View.GONE
        if (activate) activate(tabs.size - 1) else renderTabs()
        if (!url.isNullOrEmpty()) load(t, url)
        else if (url != null && activate) main.postDelayed({ address.requestFocus(); (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(address, 0) }, 200)
        return t
    }

    private fun load(t: Tab, url: String) {
        t.url = url
        val run = { t.web.loadUrl(url) }
        if (proxyReady || ident == DIRECT && !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) run() else pendingLoads += run
    }

    private fun activate(i: Int) {
        if (i !in tabs.indices) return
        active = i
        tabs.forEachIndexed { j, t -> t.web.visibility = if (j == i) View.VISIBLE else View.GONE }
        setAddress(tabs[i].url); updateNav(); renderTabs(); saveSession()
    }

    private fun closeTab(i: Int) {
        if (i !in tabs.indices) return
        val t = tabs.removeAt(i)
        webBox.removeView(t.web); t.web.destroy()
        if (tabs.isEmpty()) { newTab("", true); return }
        activate((if (active >= i) active - 1 else active).coerceIn(0, tabs.size - 1))
    }

    private fun setAddress(u: String) { if (!address.hasFocus()) address.setText(if (u == "about:blank") "" else u) }

    private fun updateNav() {
        val w = current()?.web
        backBtn.alpha = if (w?.canGoBack() == true) 1f else 0.3f
        fwdBtn.alpha = if (w?.canGoForward() == true) 1f else 0.3f
    }

    private fun go(text: String) {
        val s = text.trim()
        val url = when {
            s.isEmpty() -> return
            Regex("^(https?|about|data):", RegexOption.IGNORE_CASE).containsMatchIn(s) -> s
            Regex("^(localhost|[\\d.]+)(:\\d+)?(/|$)").containsMatchIn(s) -> "http://$s"
            !s.contains(' ') && Regex("^[^\\s/]+\\.[a-z]{2,}(:\\d+)?(/.*)?$", RegexOption.IGNORE_CASE).matches(s) -> "https://$s"
            else -> {
                val q = Uri.encode(s)
                val eng = runCatching { JSONObject(Store.str(this, "getSettings") ?: "{}").optString("search") }.getOrDefault("duckduckgo")
                if (eng == "google") "https://www.google.com/search?q=$q" else "https://duckduckgo.com/?q=$q"
            }
        }
        address.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(address.windowToken, 0)
        current()?.let { load(it, url) } ?: newTab(url, true)
    }

    override fun onBackPressed() {
        val w = current()?.web
        if (w != null && w.canGoBack()) w.goBack() else moveTaskToBack(true) // kimlik açık kalır
    }

    private var saveScheduled = false
    private fun saveSession() {
        if (saveScheduled) return
        saveScheduled = true
        main.postDelayed({
            saveScheduled = false
            val arr = JSONArray(tabs.filter { it.url.isNotEmpty() && it.url != "about:blank" }.map { JSONObject().put("url", it.url).put("title", it.title) })
            val json = JSONObject().put("tabs", arr).put("active", active.coerceAtLeast(0)).toString()
            io.execute { Store.call(this, "sessionSave", ident, Store.bundle("json" to json)) }
        }, 500)
    }

    /* ---------- Bildirim ve şifre sorusu ---------- */

    private fun notice(msg: String) { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }

    private fun askSave(origin: String, user: String, pass: String, update: Boolean) {
        promptBar.removeAllViews()
        val host = Uri.parse(origin).host ?: origin
        promptBar.add(text("🔑 $host${if (user.isNotEmpty()) " · $user" else ""}: şifre ${if (update) "güncellensin" else "kaydedilsin"} mi?", 13.5f, lines = 2), lp(0, -2, 1f))
        fun act(label: String, primary: Boolean, f: () -> Unit) = promptBar.add(button(label, primary) { promptBar.visibility = View.GONE; f() }, lp(-2, -2).margins(l = dp(6)))
        act(if (update) "Güncelle" else "Kaydet", true) {
            io.execute { Store.call(this, "pwSave", ident, Store.bundle("origin" to origin, "username" to user, "password" to pass)) }
            notice("$host şifresi kaydedildi")
        }
        act("Asla", false) { io.execute { Store.call(this, "pwNever", origin) } }
        act("Şimdi değil", false) {}
        promptBar.visibility = View.VISIBLE
    }

    /* ---------- Sayfa betikleri: WebRTC kapalı, şifre yakalama ve doldurma ---------- */

    private fun installScripts(w: WebView) {
        val js = assets.open("page.js").bufferedReader().readText()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, "SBPass", setOf("*")) { view, message, sourceOrigin, isMainFrame, reply ->
                if (!isMainFrame) return@addWebMessageListener
                val origin = sourceOrigin.toString().trimEnd('/')
                if (!origin.startsWith("http")) return@addWebMessageListener
                val m = runCatching { JSONObject(message.data ?: "{}") }.getOrNull() ?: return@addWebMessageListener
                when (m.optString("t")) {
                    "get" -> io.execute {
                        val creds = Store.str(this, "pwGet", ident, Store.bundle("origin" to origin)) ?: "[]"
                        main.post { runCatching { reply.postMessage(creds) } }
                    }
                    "cap" -> {
                        val u = m.optString("u"); val p = m.optString("p")
                        if (p.isEmpty()) return@addWebMessageListener
                        io.execute {
                            val r = Store.str(this, "pwShouldAsk", ident, Store.bundle("origin" to origin, "username" to u, "password" to p))
                            Log.i(TAG, "pwcapture|$ident|$origin|$u|$r")
                            if (r == "save" || r == "update") main.post { askSave(origin, u, p, r == "update") }
                        }
                    }
                }
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) WebViewCompat.addDocumentStartJavaScript(w, js, setOf("*"))
    }

    /* ---------- İndirme: proxy üzerinden, İndirilenler klasörüne ---------- */

    private fun download(url: String, ua: String, disposition: String?, mime: String?) {
        val name = URLUtil.guessFileName(url, disposition, mime)
        notice("İndiriliyor: $name")
        io.execute {
            try {
                val conn = (if (ident == DIRECT) URL(url).openConnection() else URL(url).openConnection(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", bridge.port)))) as HttpURLConnection
                conn.setRequestProperty("User-Agent", ua)
                CookieManager.getInstance().getCookie(url)?.let { conn.setRequestProperty("Cookie", it) }
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name); put(MediaStore.Downloads.MIME_TYPE, mime ?: "application/octet-stream")
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw Exception("Kaydedilemedi")
                conn.inputStream.use { i -> contentResolver.openOutputStream(uri)!!.use { o -> i.copyTo(o) } }
                main.post { notice("İndirildi: $name (İndirilenler)") }
            } catch (e: Exception) { main.post { notice("İndirme başarısız: $name") } }
        }
    }
}

// Her yuva ayrı işlem (AndroidManifest.xml: android:process=":bN")
class Browser0 : BrowserActivity()
class Browser1 : BrowserActivity()
class Browser2 : BrowserActivity()
class Browser3 : BrowserActivity()
class Browser4 : BrowserActivity()
class Browser5 : BrowserActivity()
class Browser6 : BrowserActivity()
class Browser7 : BrowserActivity()
class Browser8 : BrowserActivity()
class Browser9 : BrowserActivity()
class Browser10 : BrowserActivity()
class Browser11 : BrowserActivity()
