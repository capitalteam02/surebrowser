// Yerel proxy köprüsü.
// Chromium, SOCKS proxy'lerde kullanıcı adı/şifreyi desteklemez; HTTP proxy
// kimlik doğrulaması da arka plan istekleri (IP kontrolü vb.) için zahmetlidir.
// Bu yüzden kimlik doğrulamalı her proxy için 127.0.0.1 üzerinde şifresiz bir
// HTTP proxy açıyoruz; o da trafiği şifreli üst proxy'ye iletiyor.

const http = require('http');
const net = require('net');
const tls = require('tls');
const { SocksClient } = require('socks');

function upstreamSocket(upstream, destHost, destPort) {
  const type = upstream.type;
  if (type === 'socks5' || type === 'socks4') {
    return SocksClient.createConnection({
      proxy: {
        host: upstream.host,
        port: Number(upstream.port),
        type: type === 'socks5' ? 5 : 4,
        userId: upstream.username || undefined,
        password: upstream.password || undefined,
      },
      command: 'connect',
      destination: { host: destHost, port: Number(destPort) },
      timeout: 20000,
    }).then((info) => info.socket);
  }

  // http / https üst proxy: CONNECT tüneli aç
  return new Promise((resolve, reject) => {
    const opts = { host: upstream.host, port: Number(upstream.port) };
    const sock = type === 'https'
      ? tls.connect({ ...opts, servername: upstream.host })
      : net.connect(opts);
    const onErr = (e) => reject(e);
    sock.once('error', onErr);
    sock.setTimeout(20000, () => sock.destroy(new Error('Üst proxy zaman aşımı')));
    sock.once(type === 'https' ? 'secureConnect' : 'connect', () => {
      let head = `CONNECT ${destHost}:${destPort} HTTP/1.1\r\nHost: ${destHost}:${destPort}\r\n`;
      if (upstream.username) {
        const tok = Buffer.from(`${upstream.username}:${upstream.password || ''}`).toString('base64');
        head += `Proxy-Authorization: Basic ${tok}\r\n`;
      }
      sock.write(head + '\r\n');
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) {
          if (buf.length > 16384) { sock.destroy(); reject(new Error('Geçersiz proxy yanıtı')); }
          return;
        }
        sock.removeListener('data', onData);
        const status = buf.slice(0, buf.indexOf('\r\n')).toString();
        if (!/^HTTP\/1\.[01] 200/.test(status)) {
          sock.destroy();
          return reject(new Error('Üst proxy reddetti: ' + status));
        }
        sock.removeListener('error', onErr);
        sock.setTimeout(0);
        const rest = buf.slice(idx + 4);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      };
      sock.on('data', onData);
    });
  });
}

class ProxyBridge {
  constructor(upstream) {
    this.upstream = upstream;
    this.server = null;
    this.port = 0;
    this.sockets = new Set();
  }

  start() {
    const up = this.upstream;
    this.server = http.createServer((req, res) => {
      // Düz HTTP istekleri (https olmayan siteler)
      let target;
      try { target = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];

      if (up.type === 'http' || up.type === 'https') {
        // Üst HTTP proxy'ye mutlak URL ile ilet
        if (up.username) {
          headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${up.username}:${up.password || ''}`).toString('base64');
        }
        const mod = up.type === 'https' ? require('https') : http;
        const preq = mod.request({ host: up.host, port: Number(up.port), method: req.method, path: req.url, headers }, (pres) => {
          res.writeHead(pres.statusCode, pres.headers);
          pres.pipe(res);
        });
        preq.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(preq);
        return;
      }

      // SOCKS üzerinden
      const port = target.port || 80;
      const preq = http.request({
        host: target.hostname,
        port,
        method: req.method,
        path: target.pathname + target.search,
        headers,
        createConnection: (_o, cb) => {
          upstreamSocket(up, target.hostname, port).then((s) => cb(null, s), (e) => cb(e));
        },
      }, (pres) => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
      });
      preq.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(preq);
    });

    // HTTPS tünelleri
    this.server.on('connect', (req, clientSock, head) => {
      const [host, port] = splitHostPort(req.url);
      clientSock.on('error', () => {});
      upstreamSocket(up, host, port).then((upSock) => {
        this.track(upSock);
        upSock.on('error', () => clientSock.destroy());
        clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upSock.write(head);
        upSock.pipe(clientSock);
        clientSock.pipe(upSock);
      }).catch(() => {
        clientSock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
    });

    this.server.on('connection', (s) => this.track(s));

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  track(s) {
    this.sockets.add(s);
    s.once('close', () => this.sockets.delete(s));
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server) this.server.close();
    this.server = null;
  }
}

function splitHostPort(s) {
  // [ipv6]:port veya host:port
  const m = /^\[(.+)\]:(\d+)$/.exec(s);
  if (m) return [m[1], m[2]];
  const i = s.lastIndexOf(':');
  return i === -1 ? [s, '443'] : [s.slice(0, i), s.slice(i + 1)];
}

module.exports = { ProxyBridge };

// Proxy'yi Chromium oturumu açmadan, doğrudan Node üzerinden dener.
// Çıkış IP'sini ve ülkesini döndürür. Binlerce proxy için hafif.
function fetchJsonVia(upstream, host, path, timeoutMs, plainPort) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('Zaman aşımı')), timeoutMs);
    upstreamSocket(upstream, host, plainPort || 443).then((raw) => {
      const s = plainPort ? raw : tls.connect({ socket: raw, servername: host });
      if (plainPort) process.nextTick(() => s.emit('secureConnect'));
      let buf = '';
      s.setEncoding('utf8');
      s.on('secureConnect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`));
      s.on('data', (d) => { buf += d; });
      s.on('error', (e) => finish(e));
      s.on('close', () => {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return finish(new Error('Boş yanıt'));
        let body = buf.slice(i + 4);
        if (/transfer-encoding:\s*chunked/i.test(buf.slice(0, i))) {
          let out = ''; let rest = body;
          for (;;) { const n = rest.indexOf('\r\n'); const len = parseInt(rest.slice(0, n), 16); if (!len) break; out += rest.substr(n + 2, len); rest = rest.slice(n + 2 + len + 2); }
          body = out;
        }
        try { finish(null, JSON.parse(body)); } catch { finish(new Error('Geçersiz yanıt')); }
      });
      setTimeout(() => s.destroy(), timeoutMs);
    }, (e) => finish(e));
  });
}

async function checkProxy(upstream, timeoutMs = 12000) {
  const t0 = Date.now();
  // Yalnızca otomatik testler için: düz HTTP sahte IP servisi
  if (process.env.PT_IPCHECK_HTTP) {
    const [h, port] = process.env.PT_IPCHECK_HTTP.split(':');
    try {
      const j = await fetchJsonVia(upstream, h, '/ip', timeoutMs, Number(port));
      return { ok: true, ip: j.ip, cc: j.cc || '', country: '', city: '', ms: Date.now() - t0 };
    } catch (e) { return { ok: false, err: String(e.message || e), ms: Date.now() - t0 }; }
  }
  try {
    const j = await fetchJsonVia(upstream, 'ipwho.is', '/', timeoutMs);
    if (j && j.ip) return { ok: true, ip: j.ip, cc: j.country_code || '', country: j.country || '', city: j.city || '', ms: Date.now() - t0 };
  } catch (e) {
    if (/Zaman aşımı|ECONNREFUSED|ENOTFOUND|reddetti|Socks|socks|EHOSTUNREACH|ECONNRESET/.test(String(e.message))) {
      return { ok: false, err: String(e.message || e), ms: Date.now() - t0 };
    }
  }
  try {
    const j = await fetchJsonVia(upstream, 'api.ipify.org', '/?format=json', timeoutMs);
    if (j && j.ip) return { ok: true, ip: j.ip, cc: '', country: '', city: '', ms: Date.now() - t0 };
    return { ok: false, err: 'IP alınamadı', ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, err: String(e.message || e), ms: Date.now() - t0 };
  }
}

module.exports.checkProxy = checkProxy;
