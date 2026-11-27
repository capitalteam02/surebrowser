package com.surebrowser.app

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** Üst proxy üzerinden hedefe ham TCP bağlantısı açar (DNS proxy tarafında çözülür). */
object Upstream {
    private const val TIMEOUT = 15_000

    fun connect(p: SbProxy, destHost: String, destPort: Int): Socket {
        val raw = Socket()
        raw.connect(InetSocketAddress(p.host, p.port), TIMEOUT)
        raw.soTimeout = TIMEOUT
        val s: Socket = if (p.type == "https") {
            (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, p.host, p.port, true).also { (it as SSLSocket).startHandshake() }
        } else raw
        try {
            when (p.type) {
                "socks5" -> socks5(s, p, destHost, destPort)
                "socks4" -> socks4(s, p, destHost, destPort)
                else -> httpConnect(s, p, destHost, destPort)
            }
        } catch (e: Exception) { runCatching { s.close() }; throw e }
        s.soTimeout = 0
        return s
    }

    /** Proxy sunucusunun kendisine bağlanır (düz HTTP isteklerini mutlak URL ile iletmek için). */
    fun openProxy(p: SbProxy): Socket {
        val raw = Socket()
        raw.connect(InetSocketAddress(p.host, p.port), TIMEOUT)
        return if (p.type == "https") (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, p.host, p.port, true).also { (it as SSLSocket).startHandshake() } else raw
    }

    private fun readN(i: InputStream, n: Int): ByteArray {
        val b = ByteArray(n); var o = 0
        while (o < n) { val r = i.read(b, o, n - o); if (r < 0) throw IOException("Proxy bağlantıyı kapattı"); o += r }
        return b
    }

    private fun socks5(s: Socket, p: SbProxy, host: String, port: Int) {
        val o = s.getOutputStream(); val i = s.getInputStream()
        val auth = p.username.isNotEmpty()
        o.write(if (auth) byteArrayOf(5, 2, 0, 2) else byteArrayOf(5, 1, 0)); o.flush()
        val m = readN(i, 2)
        if (m[0].toInt() != 5) throw IOException("SOCKS5 değil")
        when (m[1].toInt() and 0xFF) {
            0 -> {}
            2 -> {
                val u = p.username.toByteArray(); val pw = p.password.toByteArray()
                o.write(byteArrayOf(1, u.size.toByte()) + u + byteArrayOf(pw.size.toByte()) + pw); o.flush()
                if (readN(i, 2)[1].toInt() != 0) throw IOException("SOCKS5 kullanıcı adı/şifre hatalı")
            }
            else -> throw IOException("SOCKS5 yöntem reddedildi")
        }
        val h = host.toByteArray()
        o.write(byteArrayOf(5, 1, 0, 3, h.size.toByte()) + h + byteArrayOf((port shr 8).toByte(), port.toByte())); o.flush()
        val r = readN(i, 4)
        if (r[1].toInt() != 0) throw IOException("SOCKS5 bağlanamadı (kod ${r[1]})")
        when (r[3].toInt()) { 1 -> readN(i, 6); 4 -> readN(i, 18); 3 -> readN(i, (readN(i, 1)[0].toInt() and 0xFF) + 2) }
    }

    private fun socks4(s: Socket, p: SbProxy, host: String, port: Int) {
        // SOCKS4a: alan adı proxy'de çözülür
        val o = s.getOutputStream(); val i = s.getInputStream()
        o.write(byteArrayOf(4, 1, (port shr 8).toByte(), port.toByte(), 0, 0, 0, 1) + p.username.toByteArray() + byteArrayOf(0) + host.toByteArray() + byteArrayOf(0))
        o.flush()
        val r = readN(i, 8)
        if (r[1].toInt() != 0x5A) throw IOException("SOCKS4 reddetti")
    }

    private fun httpConnect(s: Socket, p: SbProxy, host: String, port: Int) {
        val o = s.getOutputStream()
        val sb = StringBuilder("CONNECT $host:$port HTTP/1.1\r\nHost: $host:$port\r\n")
        if (p.username.isNotEmpty()) sb.append("Proxy-Authorization: ").append(basic(p)).append("\r\n")
        sb.append("\r\n")
        o.write(sb.toString().toByteArray()); o.flush()
        val head = readHead(s.getInputStream()) ?: throw IOException("Proxy yanıt vermedi")
        val status = head.substringBefore("\r\n")
        if (!Regex("^HTTP/1\\.[01] 200").containsMatchIn(status)) throw IOException("Proxy reddetti: $status")
    }

    fun basic(p: SbProxy): String =
        "Basic " + android.util.Base64.encodeToString("${p.username}:${p.password}".toByteArray(), android.util.Base64.NO_WRAP)

    /** "\r\n\r\n"e kadar başlığı okur (fazlasını okumamak için bayt bayt). */
    fun readHead(i: InputStream, max: Int = 32768): String? {
        val buf = ByteArrayOutputStream()
        var last = 0
        while (buf.size() < max) {
            val b = i.read()
            if (b < 0) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
            buf.write(b)
            last = (last shl 8) or b
            if (last == 0x0D0A0D0A) return buf.toString("ISO-8859-1")
        }
        throw IOException("Başlık çok uzun")
    }
}

data class CheckResult(val ok: Boolean, val ip: String = "", val cc: String = "", val country: String = "", val city: String = "", val ms: Long = 0, val err: String = "")

/** Proxy'yi WebView açmadan dener: çıkış IP'si ve ülkesi. */
object ProxyChecker {
    private fun getJson(p: SbProxy, host: String, path: String, tls: Boolean, port: Int = if (tls) 443 else 80): JSONObject {
        var s = Upstream.connect(p, host, port)
        s.soTimeout = 15_000
        if (tls) s = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(s, host, port, true).also { (it as SSLSocket).startHandshake() }
        s.use { sock ->
            sock.getOutputStream().apply {
                write("GET $path HTTP/1.1\r\nHost: $host\r\nUser-Agent: Mozilla/5.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n".toByteArray()); flush()
            }
            val all = sock.getInputStream().readBytes().toString(Charsets.UTF_8)
            val idx = all.indexOf("\r\n\r\n"); if (idx < 0) throw IOException("Boş yanıt")
            var body = all.substring(idx + 4)
            if (Regex("transfer-encoding:\\s*chunked", RegexOption.IGNORE_CASE).containsMatchIn(all.substring(0, idx))) {
                val out = StringBuilder(); var rest = body
                while (true) {
                    val n = rest.indexOf("\r\n"); if (n < 0) break
                    val len = rest.substring(0, n).trim().toIntOrNull(16) ?: break
                    if (len == 0) break
                    out.append(rest, n + 2, n + 2 + len); rest = rest.substring(n + 2 + len + 2)
                }
                body = out.toString()
            }
            return JSONObject(body)
        }
    }

    /** Testler için: adb shell setprop debug.surebrowser.ipcheck host:port (düz HTTP /ip) */
    private fun testHook(): String? = runCatching {
        val c = Class.forName("android.os.SystemProperties")
        (c.getMethod("get", String::class.java).invoke(null, "debug.surebrowser.ipcheck") as String).takeIf { it.isNotBlank() }
    }.getOrNull()

    fun check(p: SbProxy): CheckResult {
        val t0 = System.currentTimeMillis()
        val ms = { System.currentTimeMillis() - t0 }
        testHook()?.let { hp ->
            return try {
                val j = getJson(p, hp.substringBefore(':'), "/ip", false, hp.substringAfter(':').toInt())
                CheckResult(true, j.getString("ip"), j.optString("cc"), "", "", ms())
            } catch (e: Exception) { CheckResult(false, ms = ms(), err = e.message ?: "hata") }
        }
        try {
            val j = getJson(p, "ipwho.is", "/", true)
            if (j.has("ip")) return CheckResult(true, j.getString("ip"), j.optString("country_code"), j.optString("country"), j.optString("city"), ms())
        } catch (e: Exception) {
            val m = e.message ?: ""
            if (e is java.net.SocketTimeoutException || e is java.net.ConnectException || "reddetti" in m || "SOCKS" in m || "hatalı" in m)
                return CheckResult(false, ms = ms(), err = m.ifEmpty { e.javaClass.simpleName })
        }
        return try {
            val j = getJson(p, "api.ipify.org", "/?format=json", true)
            CheckResult(true, j.getString("ip"), ms = ms())
        } catch (e: Exception) { CheckResult(false, ms = ms(), err = e.message ?: e.javaClass.simpleName) }
    }
}
