package com.surebrowser.app

import android.app.ActivityManager
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * Uygulamanın tek doğruluk kaynağı (ana işlemde çalışır).
 * IP havuzu, kimlik yuvaları (ülke+renk → proxy), şifreler, oturumlar ve işlem yuvaları burada.
 * Kimlik işlemleri (BrowserActivity) buraya ContentResolver.call ile erişir. Dışa açık değildir.
 */
class StateProvider : ContentProvider() {
    companion object {
        const val AUTH = "com.surebrowser.app.state"
        val STATE_URI: Uri = Uri.parse("content://$AUTH/state")
        fun identUri(ident: String): Uri = Uri.parse("content://$AUTH/ident/" + Uri.encode(ident))
        const val PROCESS_SLOTS = 12
        private const val FRESH_MS = 2 * 60_000L
    }

    private val lock = Any()
    private lateinit var file: File
    private val proxies = mutableListOf<SbProxy>()
    private val slots = mutableMapOf<String, String>()          // kimlik → proxy id
    private val procSlots = mutableMapOf<String, Int>()         // kimlik → işlem yuvası (0..11)
    private val passwords = mutableListOf<JSONObject>()         // {id, ident, origin, username, password, at}
    private val neverSave = mutableListOf<String>()
    private val sessions = mutableMapOf<String, JSONObject>()   // kimlik → {tabs:[{url,title}], active}
    private val used = mutableSetOf<String>()
    private var settings = JSONObject().put("search", "duckduckgo").put("savePasswords", true).put("autofill", true)

    private val serial = Executors.newSingleThreadExecutor()
    private val checkers = Executors.newFixedThreadPool(20)
    private val poolRunners = Executors.newFixedThreadPool(20) // checkOne'ı bekleyenler ayrı havuzda: kilitlenme olmasın
    private val checking = mutableMapOf<String, Future<CheckResult>>()
    private val reserved = mutableSetOf<String>()

    override fun onCreate(): Boolean {
        file = File(context!!.filesDir, "state.json")
        load()
        // Havuz arada bir tazelenir (uygulama açıkken)
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({ runCatching { checkPool(synchronized(lock) { proxies.filter { it.status != "dead" } }); rebalance() } }, 20, 20 * 60, TimeUnit.SECONDS)
        return true
    }

    /* ---------- Kalıcı veri ---------- */

    private fun load() {
        val o = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return
        o.optJSONArray("proxies")?.let { a -> for (i in 0 until a.length()) proxies += SbProxy.fromJson(a.getJSONObject(i), Crypto::dec) }
        o.optJSONObject("slots")?.let { s -> s.keys().forEach { slots[it] = s.getString(it) } }
        o.optJSONObject("procSlots")?.let { s -> s.keys().forEach { procSlots[it] = s.getInt(it) } }
        o.optJSONArray("passwords")?.let { a -> for (i in 0 until a.length()) passwords += a.getJSONObject(i).also { it.put("password", Crypto.dec(it.optString("password"))) } }
        o.optJSONArray("neverSave")?.let { a -> for (i in 0 until a.length()) neverSave += a.getString(i) }
        o.optJSONObject("sessions")?.let { s -> s.keys().forEach { sessions[it] = s.getJSONObject(it) } }
        o.optJSONArray("used")?.let { a -> for (i in 0 until a.length()) used += a.getString(i) }
        o.optJSONObject("settings")?.let { settings = it }
    }

    private fun save() = synchronized(lock) {
        val o = JSONObject()
        o.put("proxies", JSONArray(proxies.map { it.toJson(true, Crypto::enc) }))
        o.put("slots", JSONObject(slots as Map<*, *>))
        o.put("procSlots", JSONObject(procSlots as Map<*, *>))
        o.put("passwords", JSONArray(passwords.map { JSONObject(it.toString()).put("password", Crypto.enc(it.optString("password"))) }))
        o.put("neverSave", JSONArray(neverSave)); o.put("used", JSONArray(used.toList()))
        o.put("sessions", JSONObject(sessions as Map<*, *>)); o.put("settings", settings)
        val tmp = File(file.path + ".tmp"); tmp.writeText(o.toString()); tmp.renameTo(file)
    }

    private fun changed(vararg idents: String) {
        val cr = context!!.contentResolver
        cr.notifyChange(STATE_URI, null)
        idents.forEach { cr.notifyChange(identUri(it), null) }
    }

    /* ---------- Sağlık kontrolü ---------- */

    private fun getProxy(id: String?) = proxies.firstOrNull { it.id == id }

    private fun checkOne(p: SbProxy, retry: Boolean = true): CheckResult {
        val f = synchronized(lock) {
            checking[p.id] ?: checkers.submit<CheckResult> {
                var r = ProxyChecker.check(p)
                if (!r.ok && retry) { Thread.sleep(1500); r = ProxyChecker.check(p) }
                synchronized(lock) {
                    p.checkedAt = System.currentTimeMillis(); p.ms = r.ms
                    if (r.ok) { p.status = "ok"; p.exitIp = r.ip; p.err = ""; if (r.cc.isNotEmpty()) { p.cc = r.cc.uppercase(); p.country = r.country; p.city = r.city } }
                    else { p.status = "dead"; p.err = r.err }
                    checking.remove(p.id)
                }
                save(); changed()
                r
            }.also { checking[p.id] = it; p.status = "checking" }
        }
        changed()
        return f.get()
    }

    private fun checkPool(list: List<SbProxy>) {
        val fs = list.map { p -> poolRunners.submit { runCatching { checkOne(p, retry = false) } } }
        fs.forEach { runCatching { it.get() } }
    }

    /* ---------- Yuvalar ---------- */

    private fun usedIps(except: String): Set<String> = synchronized(lock) {
        slots.filterKeys { it != except }.values.mapNotNull { getProxy(it)?.exitIp?.takeIf { ip -> ip.isNotEmpty() } }.toSet()
    }

    private fun candidates(key: String): List<SbProxy> = synchronized(lock) {
        val cc = slotCc(key); val color = slotColor(key)?.key
        val inSlot = slots.values.toSet(); val busy = usedIps(key)
        val ok = { p: SbProxy -> p.status == "ok" && p.ccOrUnknown == cc && p.id !in inSlot && p.id !in reserved && p.exitIp !in busy }
        val free = proxies.filter { it.color == color && ok(it) } + proxies.filter { it.color == null && ok(it) }
        if (free.isNotEmpty() || !procSlots.containsKey(key)) return@synchronized free
        // Boş IP yoksa: açık kimlik, açılmamış aynı ülke renginin IP'sini devralır
        val idleSlots = slots.filter { (k, _) -> k != key && slotCc(k) == cc && !procSlots.containsKey(k) }
        idleSlots.values.mapNotNull { getProxy(it) }.filter { it.status == "ok" && it.id !in reserved && (it.color == null || it.color == color) }
    }

    private fun fillSlot(key: String, verify: Boolean): SbProxy? {
        val skip = mutableSetOf<String>()
        repeat(40) {
            val c = candidates(key).firstOrNull { it.id !in skip } ?: run { synchronized(lock) { slots.remove(key) }; return null }
            skip += c.id
            synchronized(lock) { reserved += c.id }
            try {
                if (verify && System.currentTimeMillis() - c.checkedAt > FRESH_MS) checkOne(c)
                synchronized(lock) {
                    // Devralınan IP'nin eski (açılmamış) yuvası boşalır
                    val prevKey = slots.entries.firstOrNull { it.value == c.id && it.key != key }?.key
                    if (prevKey != null) slots.remove(prevKey)
                    if (c.status == "ok" && c.ccOrUnknown == slotCc(key) && proxies.contains(c) && c.exitIp !in usedIps(key)) {
                        slots[key] = c.id; save(); return c
                    }
                    if (prevKey != null) slots[prevKey] = c.id
                }
            } finally { synchronized(lock) { reserved -= c.id } }
        }
        return null
    }

    private fun isBad(key: String, p: SbProxy?, open: Boolean): Boolean {
        if (p == null || p.status != "ok" || p.ccOrUnknown != slotCc(key) || p.exitIp in usedIps(key)) return true
        return !open && p.color != null && p.color != slotColor(key)?.key
    }

    /** Açık kimliğin IP'sini doğrular; bozuksa aynı ülkeden yenisini verir. */
    private fun ensure(key: String, force: Boolean): SbProxy? {
        var p = synchronized(lock) { getProxy(slots[key]) }
        if (p != null && p.status != "dead" && (force || System.currentTimeMillis() - p.checkedAt > FRESH_MS)) checkOne(p)
        p = synchronized(lock) { getProxy(slots[key]) }
        if (!isBad(key, p, true)) return p
        synchronized(lock) { slots.remove(key) }
        val fresh = fillSlot(key, verify = true)
        if (fresh?.id != p?.id) changed(key)
        return fresh
    }

    private fun activeCountries(): List<JSONObject> = synchronized(lock) {
        val m = linkedMapOf<String, IntArray>()
        proxies.filter { it.status == "ok" || it.status == "dead" }.forEach { val a = m.getOrPut(it.ccOrUnknown) { IntArray(2) }; if (it.status == "ok") a[0]++ else a[1]++ }
        procSlots.keys.filter { it != DIRECT }.forEach { m.getOrPut(slotCc(it)) { IntArray(2) } }
        m.filter { (cc, a) -> a[0] > 0 || procSlots.keys.any { it != DIRECT && slotCc(it) == cc } }
            .map { (cc, a) -> JSONObject().put("cc", cc).put("name", countryName(cc)).put("ok", a[0]).put("dead", a[1]) }
            .sortedWith(compareBy<JSONObject>({ if (it.getString("cc") == "TR") 0 else 1 }, { if (it.getString("cc") == UNKNOWN_CC) 1 else 0 }, { -it.getInt("ok") }, { it.getString("name") }))
    }

    private fun rebalance() {
        serial.submit {
            val keys = activeCountries().flatMap { c -> COLORS.map { slotKey(c.getString("cc"), it.key) } }
            for (key in keys) {
                val open = procSlots.containsKey(key)
                val cur = synchronized(lock) { getProxy(slots[key]) }
                if (open) { if (isBad(key, cur, true)) ensure(key, false); continue }
                val color = slotColor(key)?.key
                val better = cur != null && cur.color == null && synchronized(lock) { proxies.any { it.color == color && it.status == "ok" && it.ccOrUnknown == cur.ccOrUnknown && it.id !in slots.values } }
                if (isBad(key, cur, false) || better) { synchronized(lock) { slots.remove(key) }; fillSlot(key, verify = false) }
            }
            save(); changed()
        }
    }

    /* ---------- İşlem yuvaları (her açık kimlik ayrı Android işlemi) ---------- */

    private fun aliveProcesses(): Set<String> {
        val am = context!!.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return am.runningAppProcesses?.map { it.processName }?.toSet() ?: emptySet()
    }

    private fun openSlot(ident: String): Int = synchronized(lock) {
        val alive = aliveProcesses()
        // Ölmüş işlemlerin yuvalarını boşalt
        procSlots.entries.removeAll { (id, n) -> id != ident && "${context!!.packageName}:b$n" !in alive }
        procSlots[ident]?.let { return it }
        val free = (0 until PROCESS_SLOTS).firstOrNull { it !in procSlots.values } ?: return -1
        procSlots[ident] = free; used += ident; save(); free
    }

    /* ---------- Durum (ana ekran için) ---------- */

    private fun stateJson(): String = synchronized(lock) {
        val countries = activeCountries()
        val slotsArr = JSONArray()
        countries.forEach { c ->
            COLORS.forEach { col ->
                val key = slotKey(c.getString("cc"), col.key)
                val p = getProxy(slots[key])
                slotsArr.put(JSONObject().put("key", key).put("cc", c.getString("cc")).put("color", col.key)
                    .put("proxyId", p?.id ?: JSONObject.NULL).put("open", procSlots.containsKey(key))
                    .put("hasMemory", key in used).put("passwords", passwords.count { it.optString("ident") == key }))
            }
        }
        JSONObject()
            .put("countries", JSONArray(countries)).put("slots", slotsArr)
            .put("proxies", JSONArray(proxies.map { it.toJson(false) }))
            .put("passwords", JSONArray(passwords.map { JSONObject(it.toString()).apply { remove("password") } }))
            .put("neverSave", JSONArray(neverSave)).put("settings", settings)
            .put("open", JSONArray(procSlots.keys.toList()))
            .toString()
    }

    /* ---------- Çağrılar ---------- */

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        val out = Bundle()
        val x = extras ?: Bundle()
        fun res(v: Any?) { out.putString("r", v?.toString()) }
        fun proxyOut(p: SbProxy?) = res(p?.toJson(true)) // aynı uygulamanın işlemlerine, şifre açık
        when (method) {
            "state" -> res(stateJson())
            "import" -> {
                val type = x.getString("type") ?: "http"; val color = x.getString("color")
                val seen = synchronized(lock) { proxies.map { it.key }.toMutableSet() }
                var added = 0; var dup = 0; val bad = JSONArray(); val fresh = mutableListOf<SbProxy>()
                (arg ?: "").lines().forEach { line ->
                    if (line.isBlank()) return@forEach
                    val p = SbProxy.parse(line, type)
                    if (p == null) { bad.put(line.trim()); return@forEach }
                    if (!seen.add(p.key)) { dup++; return@forEach }
                    p.color = color; fresh += p; added++
                }
                synchronized(lock) { proxies += fresh }
                save(); changed()
                Thread { checkPool(fresh); rebalance() }.start()
                res(JSONObject().put("added", added).put("dup", dup).put("bad", bad))
            }
            "updateProxy" -> {
                synchronized(lock) {
                    getProxy(arg)?.let { p ->
                        if (x.containsKey("note")) p.note = (x.getString("note") ?: "").take(80)
                        if (x.containsKey("color")) p.color = x.getString("color")?.takeIf { it.isNotEmpty() }
                    }
                }
                save(); changed(*synchronized(lock) { slots.filterValues { it == arg }.keys.toTypedArray() })
                if (x.containsKey("color")) rebalance()
            }
            "deleteProxy" -> {
                val keys = synchronized(lock) { proxies.removeAll { it.id == arg }; slots.filterValues { it == arg }.keys.toList().onEach { slots.remove(it) } }
                save(); changed(*keys.toTypedArray()); rebalance()
            }
            "deleteDead" -> { synchronized(lock) { proxies.removeAll { it.status == "dead" && it.id !in slots.values } }; save(); changed() }
            "testProxy" -> { val p = synchronized(lock) { getProxy(arg) }; if (p != null) Thread { checkOne(p); rebalance() }.start() }
            "testAll" -> Thread { checkPool(synchronized(lock) { proxies.toList() }); rebalance() }.start()
            "openSlot" -> out.putInt("slot", openSlot(arg!!))
            "releaseSlot" -> { synchronized(lock) { procSlots.remove(arg) }; save(); changed() }
            "acquire", "check" -> {
                val ident = arg!!
                if (ident == DIRECT) { res(null); return out }
                val f = serial.submit<SbProxy?> { ensure(ident, method == "acquire") }
                proxyOut(runCatching { f.get(90, TimeUnit.SECONDS) }.getOrNull())
            }
            "nextIp" -> {
                val ident = arg!!
                val f = serial.submit<SbProxy?> {
                    val cur = synchronized(lock) { getProxy(slots.remove(ident)) }
                    if (cur != null) synchronized(lock) { reserved += cur.id }
                    val fresh = try { fillSlot(ident, true) } finally { if (cur != null) synchronized(lock) { reserved -= cur.id } }
                    if (fresh == null && cur != null) synchronized(lock) { slots[ident] = cur.id }
                    save(); changed(ident); fresh ?: cur
                }
                proxyOut(runCatching { f.get(90, TimeUnit.SECONDS) }.getOrNull())
            }
            "markUsed" -> { synchronized(lock) { used += arg!! }; save() }
            "sessionGet" -> res(synchronized(lock) { sessions[arg] })
            "sessionSave" -> { synchronized(lock) { sessions[arg!!] = JSONObject(x.getString("json") ?: "{}") }; save() }
            "pwGet" -> {
                val ident = arg!!; val origin = x.getString("origin")
                res(if (!settings.optBoolean("autofill", true)) JSONArray() else synchronized(lock) {
                    JSONArray(passwords.filter { it.optString("ident") == ident && it.optString("origin") == origin }.sortedByDescending { it.optLong("at") }
                        .map { JSONObject().put("username", it.optString("username")).put("password", it.optString("password")) })
                })
            }
            "pwShouldAsk" -> {
                val ident = arg!!; val origin = x.getString("origin") ?: ""; val u = x.getString("username") ?: ""; val pw = x.getString("password") ?: ""
                val r = synchronized(lock) {
                    if (!settings.optBoolean("savePasswords", true) || origin in neverSave) "no"
                    else passwords.firstOrNull { it.optString("ident") == ident && it.optString("origin") == origin && it.optString("username") == u }
                        ?.let { if (it.optString("password") == pw) "no" else "update" } ?: "save"
                }
                res(r)
            }
            "pwSave" -> {
                val ident = arg!!; val origin = x.getString("origin") ?: ""; val u = x.getString("username") ?: ""; val pw = x.getString("password") ?: ""
                synchronized(lock) {
                    val ex = passwords.firstOrNull { it.optString("ident") == ident && it.optString("origin") == origin && it.optString("username") == u }
                    if (ex != null) ex.put("password", pw).put("at", System.currentTimeMillis())
                    else passwords += JSONObject().put("id", newId()).put("ident", ident).put("origin", origin).put("username", u).put("password", pw).put("at", System.currentTimeMillis())
                }
                save(); changed()
            }
            "pwNever" -> { synchronized(lock) { if (arg!! !in neverSave) neverSave += arg } ; save(); changed() }
            "pwUnnever" -> { synchronized(lock) { neverSave.remove(arg) }; save(); changed() }
            "pwDelete" -> { synchronized(lock) { passwords.removeAll { it.optString("id") == arg } }; save(); changed() }
            "pwReveal" -> res(synchronized(lock) { passwords.firstOrNull { it.optString("id") == arg }?.optString("password") })
            "settings" -> {
                val patch = JSONObject(arg ?: "{}")
                synchronized(lock) { patch.keys().forEach { settings.put(it, patch.get(it)) } }
                save(); changed()
            }
            "getSettings" -> res(synchronized(lock) { settings.toString() })
        }
        return out
    }

    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, s: String?, a: Array<out String>?): Int = 0
}

/** Diğer işlemlerden sağlayıcıya erişim */
object Store {
    /**
     * Açık bir kimlik penceresi sağlayıcıya kalıcı (stable) bağlantı tutar. Android böylece ana işlemi
     * "kullanımda" sayar ve dondurmaz (Android 14+ arka plandaki işlemleri dondurur, çağrılar düşer).
     */
    @Volatile private var held: android.content.ContentProviderClient? = null

    fun hold(ctx: Context) {
        if (held == null) held = ctx.applicationContext.contentResolver.acquireContentProviderClient(StateProvider.AUTH)
    }
    fun release() { runCatching { held?.close() }; held = null }

    fun call(ctx: Context, method: String, arg: String? = null, extras: Bundle? = null): Bundle {
        held?.let { c ->
            try { return c.call(method, arg, extras) ?: Bundle() } catch (e: Exception) {
                // Ana işlem yeniden başladıysa bağlantıyı tazele
                runCatching { c.close() }; held = null; hold(ctx)
            }
        }
        return ctx.contentResolver.call(StateProvider.STATE_URI, method, arg, extras) ?: Bundle()
    }

    fun str(ctx: Context, method: String, arg: String? = null, extras: Bundle? = null): String? = call(ctx, method, arg, extras).getString("r")

    fun proxy(ctx: Context, method: String, ident: String): SbProxy? =
        str(ctx, method, ident)?.let { SbProxy.fromJson(JSONObject(it)) }

    fun bundle(vararg kv: Pair<String, String?>) = Bundle().apply { kv.forEach { putString(it.first, it.second) } }
}
