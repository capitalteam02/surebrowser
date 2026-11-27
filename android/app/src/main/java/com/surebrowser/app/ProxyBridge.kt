package com.surebrowser.app

import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * Kimliğin işlemindeki yerel HTTP proxy'si. WebView her zaman buna bağlanır (ProxyController),
 * köprü trafiği o anki üst proxy'ye iletir. IP değişince yalnızca [upstream] değişir.
 * Üst proxy yoksa bağlantılar reddedilir: gerçek IP asla sızmaz.
 */
class ProxyBridge {
    val upstream = AtomicReference<SbProxy?>(null)
    @Volatile var direct = false // "Proxysiz" kimlik
    /** Üst proxy'ye bağlanılamadığında çağrılır (IP denetlenip gerekirse değiştirilir) */
    @Volatile var onUpstreamError: (() -> Unit)? = null
    private val server = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "sb-bridge").apply { isDaemon = true } }
    val port: Int get() = server.localPort

    fun start(): ProxyBridge {
        pool.execute {
            while (!server.isClosed) {
                val c = runCatching { server.accept() }.getOrNull() ?: continue
                pool.execute { handle(c) }
            }
        }
        return this
    }

    fun stop() { runCatching { server.close() }; pool.shutdownNow() }

    private fun dial(host: String, port: Int): Socket {
        if (direct) return Socket(host, port)
        val up = upstream.get() ?: throw java.io.IOException("IP yok")
        return Upstream.connect(up, host, port)
    }

    private fun handle(client: Socket) {
        client.use { c ->
            val cin = c.getInputStream(); val cout = c.getOutputStream()
            val head = runCatching { Upstream.readHead(cin) }.getOrNull() ?: return
            val first = head.substringBefore("\r\n")
            val parts = first.split(' ')
            if (parts.size < 3) return
            val method = parts[0]
            try {
                if (method.equals("CONNECT", true)) {
                    val hp = parts[1]
                    val host = if (hp.startsWith("[")) hp.substringAfter('[').substringBefore(']') else hp.substringBeforeLast(':')
                    val port = hp.substringAfterLast(':').toIntOrNull() ?: 443
                    val up = dial(host, port)
                    cout.write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray()); cout.flush()
                    pipe(c, cin, cout, up)
                } else {
                    // Düz HTTP: mutlak URL → hedefe bağlan, istek satırını kısalt, bağlantıyı tek istek için kullan
                    val uri = URI(parts[1])
                    val host = uri.host ?: return
                    val port = if (uri.port > 0) uri.port else 80
                    val path = (uri.rawPath?.ifEmpty { "/" } ?: "/") + (uri.rawQuery?.let { "?$it" } ?: "")
                    val headers = head.split("\r\n").drop(1).filter { it.isNotEmpty() }
                        .filterNot { it.startsWith("Proxy-", true) || it.startsWith("Connection:", true) || it.startsWith("Keep-Alive:", true) }
                    val upP = upstream.get()
                    val viaHttpProxy = !direct && upP != null && (upP.type == "http" || upP.type == "https")
                    val up: Socket
                    val out: StringBuilder
                    if (viaHttpProxy) {
                        // HTTP proxy'ye mutlak URL ile ilet (çoğu proxy 80 portuna CONNECT'e izin vermez)
                        up = Upstream.openProxy(upP!!)
                        out = StringBuilder("$method ${parts[1]} ${parts[2]}\r\n")
                        if (upP.username.isNotEmpty()) out.append("Proxy-Authorization: ").append(Upstream.basic(upP)).append("\r\n")
                    } else {
                        up = dial(host, port)
                        out = StringBuilder("$method $path ${parts[2]}\r\n")
                    }
                    headers.forEach { out.append(it).append("\r\n") }
                    out.append("Connection: close\r\n\r\n")
                    up.getOutputStream().apply { write(out.toString().toByteArray(Charsets.ISO_8859_1)); flush() }
                    pipe(c, cin, cout, up)
                }
            } catch (e: Exception) {
                if (!direct) onUpstreamError?.invoke()
                runCatching { cout.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()); cout.flush() }
            }
        }
    }

    private fun pipe(c: Socket, cin: InputStream, cout: OutputStream, up: Socket) {
        up.use { u ->
            val uin = u.getInputStream(); val uout = u.getOutputStream()
            val t = Thread {
                runCatching { copy(cin, uout) }
                runCatching { u.shutdownOutput() }
            }.apply { isDaemon = true; start() }
            runCatching { copy(uin, cout) }
            runCatching { c.shutdownOutput() }
            t.join(30_000)
        }
    }

    private fun copy(i: InputStream, o: OutputStream) {
        val b = ByteArray(32 * 1024)
        while (true) { val n = i.read(b); if (n < 0) break; o.write(b, 0, n); o.flush() }
    }
}
