package com.surebrowser.app

import org.json.JSONObject
import java.net.URLDecoder
import java.util.Locale
import java.util.UUID

/** Masaüstüyle aynı 10 renk. Kimlik = ülke + renk ("TR:red"). */
data class SbColor(val key: String, val name: String, val hex: Int)

val COLORS = listOf(
    SbColor("red", "Kırmızı", 0xFFE5484D.toInt()),
    SbColor("orange", "Turuncu", 0xFFF76B15.toInt()),
    SbColor("yellow", "Sarı", 0xFFFFC53D.toInt()),
    SbColor("green", "Yeşil", 0xFF30A46C.toInt()),
    SbColor("teal", "Turkuaz", 0xFF12A594.toInt()),
    SbColor("blue", "Mavi", 0xFF0090FF.toInt()),
    SbColor("navy", "Lacivert", 0xFF3E63DD.toInt()),
    SbColor("purple", "Mor", 0xFF8E4EC6.toInt()),
    SbColor("pink", "Pembe", 0xFFD6409F.toInt()),
    SbColor("brown", "Kahverengi", 0xFFA07553.toInt()),
)
const val DIRECT = "direct"
const val UNKNOWN_CC = "XX"
const val DIRECT_COLOR = 0xFF9A9993.toInt()

fun colorOf(key: String?): SbColor? = COLORS.firstOrNull { it.key == key }

fun countryName(cc: String?): String {
    if (cc.isNullOrEmpty() || cc == UNKNOWN_CC) return "Ülkesi bilinmeyen"
    val n = Locale("", cc).getDisplayCountry(Locale("tr"))
    return if (n.isNullOrBlank()) cc else n
}

fun flagEmoji(cc: String?): String {
    if (cc == null || cc.length != 2 || cc == UNKNOWN_CC) return "🏳️"
    return cc.uppercase().map { String(Character.toChars(0x1F1E6 + (it - 'A'))) }.joinToString("")
}

fun slotKey(cc: String, color: String) = "$cc:$color"
fun slotCc(key: String) = key.substringBefore(':')
fun slotColor(key: String) = colorOf(key.substringAfter(':'))
fun identLabel(key: String): String =
    if (key == DIRECT) "Proxysiz" else "${countryName(slotCc(key))} · ${slotColor(key)?.name ?: ""}"
fun identColor(key: String): Int = if (key == DIRECT) DIRECT_COLOR else slotColor(key)?.hex ?: DIRECT_COLOR

/** Açık renk üstünde koyu yazı */
fun inkFor(color: Int): Int {
    fun lin(v: Int): Double { val c = v / 255.0; return if (c <= 0.04045) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4) }
    val l = 0.2126 * lin((color shr 16) and 255) + 0.7152 * lin((color shr 8) and 255) + 0.0722 * lin(color and 255)
    return if (l > 0.36) 0xFF1F1F1D.toInt() else 0xFFFFFFFF.toInt()
}

/** Havuzdaki bir proxy */
data class SbProxy(
    val id: String,
    var type: String,
    var host: String,
    var port: Int,
    var username: String = "",
    var password: String = "",
    var note: String = "",
    var color: String? = null,
    var status: String = "unknown", // unknown | checking | ok | dead
    var exitIp: String = "",
    var cc: String = "",
    var country: String = "",
    var city: String = "",
    var ms: Long = 0,
    var err: String = "",
    var checkedAt: Long = 0,
) {
    val ccOrUnknown get() = cc.ifEmpty { UNKNOWN_CC }.uppercase()
    val key get() = "$type://$username@$host:$port"

    fun toJson(withSecret: Boolean, encrypt: (String) -> String = { it }): JSONObject = JSONObject().apply {
        put("id", id); put("type", type); put("host", host); put("port", port)
        put("username", username)
        put("password", if (withSecret) encrypt(password) else if (password.isNotEmpty()) "••••" else "")
        put("note", note); put("color", color ?: JSONObject.NULL)
        put("status", status); put("exitIp", exitIp); put("cc", cc); put("country", country); put("city", city)
        put("ms", ms); put("err", err); put("checkedAt", checkedAt)
    }

    companion object {
        fun fromJson(o: JSONObject, decrypt: (String) -> String = { it }) = SbProxy(
            id = o.getString("id"), type = o.optString("type", "http"), host = o.getString("host"), port = o.getInt("port"),
            username = o.optString("username"), password = decrypt(o.optString("password")),
            note = o.optString("note"), color = o.optString("color").takeIf { it.isNotEmpty() && it != "null" },
            status = o.optString("status", "unknown").let { if (it == "checking") "unknown" else it },
            exitIp = o.optString("exitIp"), cc = o.optString("cc"), country = o.optString("country"), city = o.optString("city"),
            ms = o.optLong("ms"), err = o.optString("err"), checkedAt = o.optLong("checkedAt"),
        )

        /** Satır biçimleri: socks5://k:ş@h:p · h:p:k:ş · k:ş@h:p · h:p · "Not | proxy" */
        fun parse(line0: String, defType: String): SbProxy? {
            var s = line0.trim()
            if (s.isEmpty() || s.startsWith("#")) return null
            var type = defType
            var note = ""
            if ('|' in s) { note = s.substringBefore('|').trim(); s = s.substringAfter('|').trim() }
            Regex("^(https?|socks5h?|socks4a?|socks)://", RegexOption.IGNORE_CASE).find(s)?.let {
                type = it.groupValues[1].lowercase().replace("socks5h", "socks5").replace("socks4a", "socks4")
                if (type == "socks") type = "socks5"
                s = s.substring(it.value.length)
            }
            var host: String; var port: String; var user = ""; var pass = ""
            if ('@' in s) {
                val cred = s.substringBeforeLast('@'); val hp = s.substringAfterLast('@')
                user = cred.substringBefore(':'); pass = if (':' in cred) cred.substringAfter(':') else ""
                host = hp.substringBefore(':'); port = hp.substringAfter(':', "")
            } else {
                val parts = s.split(':')
                if (parts.size >= 4) { host = parts[0]; port = parts[1]; user = parts[2]; pass = parts.drop(3).joinToString(":") }
                else { host = parts[0]; port = parts.getOrElse(1) { "" } }
            }
            runCatching { user = URLDecoder.decode(user, "UTF-8"); pass = URLDecoder.decode(pass, "UTF-8") }
            val p = port.trim().toIntOrNull() ?: return null
            if (host.isBlank() || p !in 1..65535) return null
            return SbProxy(UUID.randomUUID().toString().take(10), type, host.trim(), p, user, pass, note)
        }
    }
}

fun newId() = UUID.randomUUID().toString().replace("-", "").take(10)
