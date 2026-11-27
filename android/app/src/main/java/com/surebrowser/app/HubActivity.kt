package com.surebrowser.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.database.ContentObserver
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/** Ana ekran: ülke ve renk seçici, IP havuzu, şifreler, ayarlar. */
class HubActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var S = JSONObject()
    private var tab = "ids"
    private lateinit var content: LinearLayout
    private lateinit var tabsRow: LinearLayout
    private var poolQuery = ""
    private var renderPending = false

    private val observer = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) { refresh() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Pal.bar(this)
        val root = vbox().apply { setBackgroundColor(Pal.bg(context)) }
        val top = hbox(dp(14)).apply { setBackgroundColor(Pal.bar(context)) }
        top.add(text("SureBrowser", 20f, bold = true), lp(0, -2, 1f))
        top.add(text("v${BuildConfig.VERSION_NAME}", 12f, Pal.muted(this)))
        root.add(top)
        tabsRow = hbox(dp(8)).apply { setBackgroundColor(Pal.bar(context)) }
        root.add(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(tabsRow) })
        content = vbox(dp(14))
        root.add(ScrollView(this).apply { addView(content); isFillViewport = true; setBackgroundColor(Pal.bg(context)) }, lp(-1, 0, 1f))
        root.setBackgroundColor(Pal.bar(this))
        setContentView(root)
        root.fitSystemBars()
        contentResolver.registerContentObserver(StateProvider.STATE_URI, false, observer)
        refresh()
        Updater.checkOnLaunch(this)
    }

    override fun onDestroy() { contentResolver.unregisterContentObserver(observer); super.onDestroy() }
    override fun onResume() { super.onResume(); refresh() }

    private fun refresh() {
        if (renderPending) return
        renderPending = true
        main.postDelayed({
            io.execute {
                val s = Store.str(this, "state")
                main.post { renderPending = false; if (s != null) { S = JSONObject(s); render() } }
            }
        }, 120)
    }

    private fun renderTabs() {
        tabsRow.removeAllViews()
        listOf("ids" to "Kimlikler", "pool" to "IP havuzu", "pw" to "Şifreler", "set" to "Ayarlar").forEach { (k, label) ->
            val on = k == tab
            tabsRow.add(TextView(this).apply {
                text = label; textSize = 14f; setPadding(dp(16), dp(9), dp(16), dp(9))
                setTextColor(if (on) Pal.bar(context) else Pal.ink(context))
                ripple(rounded(if (on) Pal.ink(context) else Pal.surface(context), dp(18).toFloat()))
                setOnClickListener { tab = k; render() }
            }, lp(-2, -2).margins(r = dp(6)))
        }
    }

    private fun render() {
        renderTabs()
        content.removeAllViews()
        when (tab) { "ids" -> renderIdentities(); "pool" -> renderPool(); "pw" -> renderPasswords(); else -> renderSettings() }
    }

    private fun proxyById(id: String?): JSONObject? {
        if (id == null) return null
        val a = S.optJSONArray("proxies") ?: return null
        for (i in 0 until a.length()) if (a.getJSONObject(i).optString("id") == id) return a.getJSONObject(i)
        return null
    }

    /* ---------- Kimlikler ---------- */

    private fun columns(): Int {
        val wDp = resources.configuration.screenWidthDp
        return when { wDp >= 840 -> 5; wDp >= 600 -> 4; wDp >= 400 -> 3; else -> 2 }
    }

    private fun renderIdentities() {
        val open = S.optJSONArray("open")?.length() ?: 0
        content.add(text("Hangi ülkeden, hangi renkten IP?", 20f, bold = true))
        content.add(text("Her ülkenin 10 rengi var; her renk ayrı bir kimlik ve kendi IP'si. Kimlik ayrı bir pencerede açılır; yan yana görmek için basılı tutup \"Yan yana aç\" deyin. Açık: $open/${StateProvider.PROCESS_SLOTS}", 13f, Pal.muted(this)), lp().margins(t = dp(4), b = dp(10)))
        content.add(button("Proxysiz sekme (gerçek IP)") { openIdentity(DIRECT, false) }, lp(-2, -2).margins(b = dp(12)))
        val countries = S.optJSONArray("countries") ?: JSONArray()
        if (countries.length() == 0) {
            content.add(text("Havuzda henüz çalışan IP yok. \"IP havuzu\" sekmesinden IP ekleyin; denetlenince ülkelerine göre burada listelenir.", 15f, Pal.muted(this)), lp().margins(t = dp(20)))
            return
        }
        val slots = S.optJSONArray("slots") ?: JSONArray()
        for (i in 0 until countries.length()) {
            val c = countries.getJSONObject(i)
            val cc = c.getString("cc")
            val head = hbox().apply { setPadding(0, dp(14), 0, dp(8)) }
            head.add(text(flagEmoji(cc), 26f), lp(-2, -2).margins(r = dp(8)))
            head.add(text(c.getString("name"), 18f, bold = true), lp(-2, -2).margins(r = dp(8)))
            head.add(text("${c.getInt("ok")} çalışan IP" + if (c.getInt("dead") > 0) " · ${c.getInt("dead")} çöken" else "", 13f, Pal.muted(this)))
            content.add(head)
            val grid = GridLayout(this).apply { columnCount = columns() }
            for (j in 0 until slots.length()) {
                val s = slots.getJSONObject(j)
                if (s.getString("cc") == cc) grid.addView(slotCard(s), GridLayout.LayoutParams().apply {
                    width = 0; columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f); setMargins(dp(4), dp(4), dp(4), dp(4))
                })
            }
            content.add(grid)
        }
    }

    private fun slotCard(s: JSONObject): View {
        val key = s.getString("key")
        val col = colorOf(s.getString("color"))!!
        val p = proxyById(s.optString("proxyId").takeIf { it.isNotEmpty() && it != "null" })
        val open = s.optBoolean("open")
        val card = vbox().apply { clipToOutline = true; background = rounded(Pal.surface(context), dp(12).toFloat(), Pal.line(context), dp(1)) }
        val band = hbox(dp(10)).apply { setBackgroundColor(col.hex) }
        band.add(text(col.name, 14f, inkFor(col.hex), bold = true), lp(0, -2, 1f))
        if (s.optInt("passwords") > 0) band.add(text("${s.optInt("passwords")} şifre", 11f, inkFor(col.hex)))
        card.add(band)
        val body = vbox(dp(10))
        body.add(text(p?.optString("exitIp") ?: "—", 14f, bold = true, lines = 1))
        body.add(text(p?.optString("note")?.ifEmpty { p.optString("city") } ?: "", 12f, Pal.muted(this), lines = 1))
        val st = when { p == null -> "Bu renkte IP yok"; open -> "Açık · dokununca öne gelir"; s.optBoolean("hasMemory") -> "Oturumu kayıtlı"; else -> "Hazır" }
        body.add(text(st, 11.5f, if (p == null) Pal.DANGER else if (open) Pal.WARN else Pal.muted(this), lines = 1), lp().margins(t = dp(6)))
        card.add(body)
        card.alpha = if (p == null) 0.5f else 1f
        card.minimumHeight = dp(110)
        if (p != null) {
            card.setOnClickListener { openIdentity(key, false) }
            card.setOnLongClickListener {
                PopupMenu(this, card).apply {
                    menu.add("Yan yana aç").setOnMenuItemClickListener { openIdentity(key, true); true }
                    menu.add("Yeni IP ver").setOnMenuItemClickListener { io.execute { Store.call(this@HubActivity, "nextIp", key) }; true }
                }.show(); true
            }
        }
        return card
    }

    private fun openIdentity(ident: String, adjacent: Boolean) {
        io.execute {
            val slot = Store.call(this, "openSlot", ident).getInt("slot", -1)
            main.post {
                if (slot < 0) { Toast.makeText(this, "Aynı anda en fazla ${StateProvider.PROCESS_SLOTS} kimlik açık olabilir. Birini kapatın.", Toast.LENGTH_LONG).show(); return@post }
                val i = Intent(this, Class.forName("com.surebrowser.app.Browser$slot")).putExtra("ident", ident)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (adjacent) i.addFlags(Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                startActivity(i)
            }
        }
    }

    /* ---------- IP havuzu ---------- */

    private fun renderPool() {
        content.add(text("IP ekle", 13f, Pal.muted(this), bold = true))
        val input = EditText(this).apply {
            hint = "Her satıra bir proxy:\nsocks5://kullanici:sifre@1.2.3.4:1080\n1.2.3.4:8080:kullanici:sifre\nInstagram | http://5.6.7.8:3128"
            minLines = 4; gravity = Gravity.TOP; textSize = 13f; typeface = android.graphics.Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            background = rounded(Pal.surface(context), dp(10).toFloat(), Pal.line(context), dp(1)); setPadding(dp(10), dp(10), dp(10), dp(10))
        }
        content.add(input, lp().margins(t = dp(6)))
        val types = listOf("http", "https", "socks5", "socks4")
        val typeSp = Spinner(this).apply { adapter = ArrayAdapter(context, android.R.layout.simple_spinner_dropdown_item, types.map { it.uppercase() }) }
        val colorSp = Spinner(this).apply { adapter = ArrayAdapter(context, android.R.layout.simple_spinner_dropdown_item, listOf("Otomatik") + COLORS.map { it.name }) }
        val note = text("", 13f, Pal.muted(this))
        val row = hbox().apply { setPadding(0, dp(6), 0, dp(6)) }
        row.add(typeSp, lp(0, -2, 1f)); row.add(colorSp, lp(0, -2, 1f))
        row.add(button("Havuza ekle", true) {
            val t = input.text.toString(); if (t.isBlank()) return@button
            val color = if (colorSp.selectedItemPosition == 0) null else COLORS[colorSp.selectedItemPosition - 1].key
            io.execute {
                val r = JSONObject(Store.str(this, "import", t, Store.bundle("type" to types[typeSp.selectedItemPosition], "color" to color)) ?: "{}")
                main.post {
                    val bad = r.optJSONArray("bad") ?: JSONArray()
                    note.text = "${r.optInt("added")} IP eklendi, deneniyor ve ülkeleri bulunuyor." + (if (r.optInt("dup") > 0) " ${r.optInt("dup")} tekrar atlandı." else "") + (if (bad.length() > 0) " Okunamayan ${bad.length()} satır." else "")
                    input.setText((0 until bad.length()).joinToString("\n") { bad.getString(it) })
                }
            }
        })
        content.add(row); content.add(note)
        content.add(text("Ülke otomatik bulunur. \"Not | proxy\" yazarsanız not o IP'ye eklenir.", 12f, Pal.muted(this)), lp().margins(b = dp(12)))

        val proxies = S.optJSONArray("proxies") ?: JSONArray()
        val head = hbox()
        head.add(text("Havuz (${proxies.length()})", 13f, Pal.muted(this), bold = true), lp(0, -2, 1f))
        head.add(button("Hepsini dene") { io.execute { Store.call(this, "testAll") } }, lp(-2, -2).margins(r = dp(6)))
        head.add(button("Çökenleri sil") {
            AlertDialog.Builder(this).setMessage("Çöken IP'ler havuzdan silinsin mi?").setPositiveButton("Sil") { _, _ -> io.execute { Store.call(this, "deleteDead") } }.setNegativeButton("Vazgeç", null).show()
        })
        content.add(head)
        val search = EditText(this).apply { hint = "IP, ülke, not veya adres ara"; setText(poolQuery); setSingleLine() }
        search.setOnEditorActionListener { _, _, _ -> poolQuery = search.text.toString(); render(); true }
        content.add(search)
        val active = mutableMapOf<String, String>()
        S.optJSONArray("slots")?.let { a -> for (i in 0 until a.length()) a.getJSONObject(i).let { s -> s.optString("proxyId").takeIf { it.isNotEmpty() && it != "null" }?.let { active[it] = s.getString("key") } } }
        val q = poolQuery.lowercase()
        var shown = 0
        for (i in 0 until proxies.length()) {
            val p = proxies.getJSONObject(i)
            val hay = "${p.optString("host")}:${p.optInt("port")} ${p.optString("note")} ${p.optString("exitIp")} ${countryName(p.optString("cc"))}".lowercase()
            if (q.isNotEmpty() && q !in hay) continue
            if (++shown > 150) { content.add(text("Daha fazlası var; aramayla daraltın.", 12f, Pal.muted(this))); break }
            content.add(proxyRow(p, active[p.optString("id")]), lp().margins(t = dp(6)))
        }
    }

    private fun proxyRow(p: JSONObject, live: String?): View {
        val box = vbox(dp(10)).apply { background = rounded(Pal.surface(context), dp(10).toFloat(), Pal.line(context), dp(1)) }
        val st = p.optString("status")
        val l1 = hbox()
        if (p.optString("cc").isNotEmpty()) l1.add(text(flagEmoji(p.optString("cc")) + " ", 15f))
        l1.add(text(p.optString("type").uppercase() + "  ", 11f, Pal.muted(this), bold = true))
        l1.add(text("${p.optString("host")}:${p.optInt("port")}" + if (p.optString("username").isNotEmpty()) " 🔒" else "", 14f, bold = true, lines = 1), lp(0, -2, 1f))
        if (live != null) l1.add(text("${slotColor(live)?.name} · aktif", 11f, inkFor(identColor(live)), bold = true).apply { setPadding(dp(6), dp(2), dp(6), dp(2)); background = rounded(identColor(live), dp(4).toFloat()) })
        box.add(l1)
        if (p.optString("note").isNotEmpty() || p.optString("color").let { it.isNotEmpty() && it != "null" })
            box.add(text(listOfNotNull(p.optString("note").takeIf { it.isNotEmpty() }, colorOf(p.optString("color"))?.let { "Renk: ${it.name}" }).joinToString(" · "), 12.5f, Pal.ink(this)))
        val stTxt = when (st) {
            "ok" -> "Çalışıyor · ${p.optString("exitIp")} · ${countryName(p.optString("cc"))} · ${p.optLong("ms")} ms"
            "dead" -> "Çöktü · ${p.optString("err")}"
            "checking" -> "Deneniyor…"
            else -> "Denenmedi"
        }
        box.add(text(stTxt, 12f, when (st) { "ok" -> Pal.OK; "dead" -> Pal.DANGER; else -> Pal.muted(this) }, lines = 1))
        box.setOnClickListener { editProxy(p) }
        box.alpha = if (st == "dead") 0.65f else 1f
        return box
    }

    private fun editProxy(p: JSONObject) {
        val v = vbox(dp(18))
        val note = EditText(this).apply { hint = "Not (pencere adında ve üst çubukta görünür)"; setText(p.optString("note")); setSingleLine() }
        val colorSp = Spinner(this).apply {
            adapter = ArrayAdapter(context, android.R.layout.simple_spinner_dropdown_item, listOf("Otomatik") + COLORS.map { it.name })
            setSelection(COLORS.indexOfFirst { it.key == p.optString("color") } + 1)
        }
        v.add(note); v.add(colorSp, lp().margins(t = dp(10)))
        AlertDialog.Builder(this).setTitle("${p.optString("host")}:${p.optInt("port")}").setView(v)
            .setPositiveButton("Kaydet") { _, _ ->
                val color = if (colorSp.selectedItemPosition == 0) "" else COLORS[colorSp.selectedItemPosition - 1].key
                io.execute { Store.call(this, "updateProxy", p.optString("id"), Store.bundle("note" to note.text.toString(), "color" to color)) }
            }
            .setNeutralButton("Dene") { _, _ -> io.execute { Store.call(this, "testProxy", p.optString("id")) } }
            .setNegativeButton("Sil") { _, _ -> io.execute { Store.call(this, "deleteProxy", p.optString("id")) } }
            .show()
    }

    /* ---------- Şifreler ---------- */

    private fun renderPasswords() {
        val set = S.optJSONObject("settings") ?: JSONObject()
        fun toggle(label: String, key: String) = Switch(this).apply {
            text = label; textSize = 15f; isChecked = set.optBoolean(key, true)
            setOnCheckedChangeListener { _, on -> io.execute { Store.call(this@HubActivity, "settings", JSONObject().put(key, on).toString()) } }
        }
        content.add(toggle("Giriş yapınca şifreyi kaydetmeyi öner", "savePasswords"), lp().margins(b = dp(8)))
        content.add(toggle("Kayıtlı şifreleri otomatik doldur", "autofill"), lp().margins(b = dp(14)))
        val pws = S.optJSONArray("passwords") ?: JSONArray()
        content.add(text("Kayıtlı şifreler (${pws.length()})", 13f, Pal.muted(this), bold = true))
        if (pws.length() == 0) content.add(text("Henüz kayıtlı şifre yok. Bir sitede giriş yaptığınızda sorulur.", 14f, Pal.muted(this)), lp().margins(t = dp(8)))
        for (i in 0 until pws.length()) {
            val x = pws.getJSONObject(i)
            val ident = x.optString("ident")
            val row = vbox(dp(12)).apply { background = rounded(Pal.surface(context), dp(10).toFloat(), Pal.line(context), dp(1)) }
            val host = runCatching { android.net.Uri.parse(x.optString("origin")).host }.getOrNull() ?: x.optString("origin")
            row.add(text("$host  ·  ${x.optString("username")}", 15f, bold = true, lines = 1))
            row.add(text((if (ident == DIRECT) "" else flagEmoji(slotCc(ident)) + " ") + identLabel(ident), 12.5f, Pal.muted(this)))
            row.setOnClickListener {
                AlertDialog.Builder(this).setTitle(host).setMessage("${identLabel(ident)}\n${x.optString("username")}")
                    .setPositiveButton("Kopyala") { _, _ -> io.execute { val pw = Store.str(this, "pwReveal", x.optString("id")) ?: ""; main.post {
                        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("şifre", pw))
                        Toast.makeText(this, "Şifre kopyalandı", Toast.LENGTH_SHORT).show() } } }
                    .setNeutralButton("Göster") { _, _ -> io.execute { val pw = Store.str(this, "pwReveal", x.optString("id")) ?: ""; main.post {
                        AlertDialog.Builder(this).setTitle(host).setMessage(pw).setPositiveButton("Tamam", null).show() } } }
                    .setNegativeButton("Sil") { _, _ -> io.execute { Store.call(this, "pwDelete", x.optString("id")) } }.show()
            }
            content.add(row, lp().margins(t = dp(6)))
        }
        val never = S.optJSONArray("neverSave") ?: JSONArray()
        if (never.length() > 0) {
            content.add(text("Şifresi hiç kaydedilmeyecek siteler", 13f, Pal.muted(this), bold = true), lp().margins(t = dp(18)))
            for (i in 0 until never.length()) {
                val o = never.getString(i)
                val r = hbox(dp(6))
                r.add(text(o, 14f), lp(0, -2, 1f))
                r.add(button("Listeden çıkar") { io.execute { Store.call(this, "pwUnnever", o) } })
                content.add(r)
            }
        }
    }

    /* ---------- Ayarlar ---------- */

    private fun renderSettings() {
        val set = S.optJSONObject("settings") ?: JSONObject()
        content.add(text("Arama motoru", 13f, Pal.muted(this), bold = true))
        val engines = listOf("duckduckgo" to "DuckDuckGo", "google" to "Google")
        content.add(Spinner(this).apply {
            adapter = ArrayAdapter(context, android.R.layout.simple_spinner_dropdown_item, engines.map { it.second })
            setSelection(engines.indexOfFirst { it.first == set.optString("search", "duckduckgo") }.coerceAtLeast(0))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(a: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                    if (engines[pos].first != set.optString("search")) io.execute { Store.call(this@HubActivity, "settings", JSONObject().put("search", engines[pos].first).toString()) }
                }
                override fun onNothingSelected(a: AdapterView<*>?) {}
            }
        }, lp().margins(b = dp(18)))
        content.add(button("Güncellemeleri denetle") { Updater.check(this, manual = true) }, lp(-2, -2))
        content.add(text("Sürüm ${BuildConfig.VERSION_NAME}", 13f, Pal.muted(this)), lp().margins(t = dp(10)))
        content.add(text("Her kimlik ayrı bir Android işleminde çalışır: kendi IP'si, çerezleri, önbelleği ve şifreleri vardır. Proxy yoksa kimliğin bağlantısı kesilir, gerçek IP'ye düşmez. WebRTC kapalıdır.", 12.5f, Pal.muted(this)), lp().margins(t = dp(18)))
    }
}
