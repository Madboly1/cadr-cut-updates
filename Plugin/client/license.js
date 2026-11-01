/* CADR CUT - Offline License & Tamper-Proof 3-Day Trial Runtime (v1.4)
 * The plugin ships with PUBLIC KEY ONLY. Never put private_key.pem here.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "cadrLicenseV1";
  var DEVICE_CACHE_KEY = "cadrDeviceIdCacheV2";
  var TRIAL_STORAGE_KEY = "cadrTrialLedgerV1";
  var PRODUCT = "CADR_CUT";
  var FORMAT = "CADR-LIC-1";
  var TRIAL_DAYS = 3;
  var TRIAL_DURATION_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000; /* 72 hours (3 full days) */
  var TRIAL_SECRET_SALT = "CADR-STUDIO-TRIAL-SEAL-2026-v1";
  var REG_TRIAL_KEY = "HKCU\\Software\\Classes\\CLSID\\{8F9C4D2A-5B71-4E3A-9C1D-2A6E8B4F1026}";

  var publicKeyPem =
`-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApANhrmguFuiFHk34Rr06gxcP2BepXmF48hBuVXPtsMockOmtGa5mEizmp6X3sAT+JhIIy/cNsBhdqfhjngx4jBYIDAfeee3FfcruI6MK99dYfu2Wqg1+LFrK+V4mVwtg0iHPp4hiB+ZBJdxeOmlAuLQHJX/Q4qx46iYQdlMcTTi1ELhk0Z6J6WOoA8eYjPsU3eBOC+0GOlzpncerqQqppi2kuUzmT12O7qLxMeVXUqMt2G5j/l+o6VuCdC8Y6uQemrfzNQhWCSK7XSdLSgEexq291ALjzUA45w1luogbGVECInGqGbAGvTT50RLm4mtEeAGNsLPrNCTYod/zkgIMAQIDAQAB
-----END PUBLIC KEY-----`;

  function node() {
    if (window.cep_node && typeof window.cep_node.require === "function") {
      return window.cep_node;
    }
    var req = (typeof window.require === "function") ? window.require
            : (typeof require === "function" ? require : null);
    if (req) {
      window.cep_node = {
        require: req,
        process: (typeof process !== "undefined") ? process : (window.process || {}),
        Buffer: (typeof Buffer !== "undefined") ? Buffer : (window.Buffer || null)
      };
      return window.cep_node;
    }
    return null;
  }

  /* Pure-JS SHA-256 implementation */
  function sha256Bytes(asciiBytes) {
    var K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    var H = [
      0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
      0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
    ];
    var l = asciiBytes.length;
    var bitLenHi = Math.floor((l * 8) / 0x100000000);
    var bitLenLo = (l * 8) >>> 0;
    var padLen = ((l + 9 + 63) & ~63);
    var words = new Array(padLen >> 2);
    for (var z = 0; z < words.length; z++) words[z] = 0;
    for (var i = 0; i < l; i++) {
      words[i >> 2] |= (asciiBytes[i] & 0xff) << (24 - (i % 4) * 8);
    }
    words[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
    words[words.length - 2] = bitLenHi;
    words[words.length - 1] = bitLenLo;

    function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
    var W = new Array(64);
    for (var j = 0; j < words.length; j += 16) {
      for (var t = 0; t < 16; t++) W[t] = words[j + t] | 0;
      for (var t2 = 16; t2 < 64; t2++) {
        var s0 = rotr(7, W[t2 - 15]) ^ rotr(18, W[t2 - 15]) ^ (W[t2 - 15] >>> 3);
        var s1 = rotr(17, W[t2 - 2]) ^ rotr(19, W[t2 - 2]) ^ (W[t2 - 2] >>> 10);
        W[t2] = (W[t2 - 16] + s0 + W[t2 - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var r = 0; r < 64; r++) {
        var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + K[r] + W[r]) | 0;
        var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var outHex = "";
    for (var hi = 0; hi < 8; hi++) {
      outHex += ("00000000" + (H[hi] >>> 0).toString(16)).slice(-8);
    }
    return outHex.toUpperCase();
  }

  function sha256Utf8Hex(str) {
    var utf8 = unescape(encodeURIComponent(String(str)));
    var arr = [];
    for (var i = 0; i < utf8.length; i++) arr.push(utf8.charCodeAt(i) & 0xff);
    return sha256Bytes(arr);
  }

  var RSA_MODULUS_HEX = "a40361ae682e16e8851e4df846bd3a83170fd817a95e6178f2106e5573edb0ca1c90e9ad19ae66122ce6a7a5f7b004fe261208cbf70db0185da9f8639e0c788c16080c07de79edc57dcaee23a30af7d7587eed96aa0d7e2c5acaf95e26570b60d221cfa7886207e64125dc5e3a6940b8b407257fd0e2ac78ea261076531c4d38b510b864d19e89e963a803c7988cfb14dde04e0bed063a5ce99dc7aba90aa9a62da4b94ce64f5d8eeea2f131e55752a32dd86e63fe5fa8e95b82742f18eae41e9ab7f33508560922bb5d274b4a011ec6adbdd402e3cd4038e70d65ba881b1951022271aa19b006bd34f9d112e6e26b4478018db0b3eb3424d8a1dff392020c01";

  function verifyRsaSha256PureJs(payloadB64, signatureB64) {
    try {
      if (typeof BigInt === "undefined") return false;
      var b64 = String(signatureB64).replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var rawSig = atob(b64);
      var sigHex = "";
      for (var i = 0; i < rawSig.length; i++) {
        sigHex += ("0" + (rawSig.charCodeAt(i) & 0xff).toString(16)).slice(-2);
      }
      var s = BigInt("0x" + sigHex);
      var n = BigInt("0x" + RSA_MODULUS_HEX);
      var e = BigInt(65537);
      var result = BigInt(1);
      var base = s % n;
      var exp = e;
      while (exp > BigInt(0)) {
        if (exp & BigInt(1)) result = (result * base) % n;
        exp = exp >> BigInt(1);
        base = (base * base) % n;
      }
      var emHex = result.toString(16).toUpperCase();
      while (emHex.length < 512) emHex = "0" + emHex;
      var digestHex = sha256Utf8Hex(payloadB64);
      var asn1Prefix = "3031300D060960864801650304020105000420";
      return emHex.slice(-(asn1Prefix.length + 64)) === (asn1Prefix + digestHex);
    } catch (err) {
      return false;
    }
  }

  function b64urlDecodeUtf8(text) {
    var b64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bytes = atob(b64);
    var escaped = "";
    for (var i = 0; i < bytes.length; i++) escaped += "%" + ("00" + bytes.charCodeAt(i).toString(16)).slice(-2);
    return decodeURIComponent(escaped);
  }

  function b64urlToBuffer(text, BufferCtor) {
    var b64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return BufferCtor.from(b64, "base64");
  }

  var cachedDeviceId = "";

  function getDeviceId() {
    if (cachedDeviceId && cachedDeviceId.indexOf("CADR-") === 0) return cachedDeviceId;
    try {
      var fromStore = window.localStorage.getItem(DEVICE_CACHE_KEY);
      if (fromStore && fromStore.indexOf("CADR-") === 0 && fromStore.length >= 20) {
        cachedDeviceId = fromStore;
        return cachedDeviceId;
      }
    } catch (e) {}

    var n = node();
    if (n) {
      try {
        var fs = n.require("fs");
        var path = n.require("path");
        var os = n.require("os");
        var proc = n.process || (typeof process !== "undefined" ? process : {});
        var env = proc.env || {};
        var home = os.homedir ? os.homedir() : (env.USERPROFILE || env.HOME || "");
        var appData = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
        var idFile = appData ? path.join(appData, "CADR_STUDIO", ".cadr_device_id") : (home ? path.join(home, ".cadr_device_id") : "");

        if (idFile && fs.existsSync(idFile)) {
          var savedId = String(fs.readFileSync(idFile, "utf8") || "").trim();
          if (savedId.indexOf("CADR-") === 0 && savedId.length >= 20) {
            cachedDeviceId = savedId;
            try { window.localStorage.setItem(DEVICE_CACHE_KEY, cachedDeviceId); } catch (e0) {}
            return cachedDeviceId;
          }
        }

        /* Pure in-memory OS fingerprint (NO spawnSync / reg.exe that crashes Premiere Pro 2026!) */
        var plat = proc.platform || (String(navigator.platform || "").indexOf("Win") === 0 ? "win32" : "darwin");
        var cpuModel = (os.cpus && os.cpus().length) ? String(os.cpus()[0].model || "") : "";
        var userStr = "";
        try { userStr = os.userInfo ? String(os.userInfo().username || "") : ""; } catch (eu) {}
        var raw = [plat, os.arch(), os.hostname(), cpuModel, userStr].join("|");
        cachedDeviceId = "CADR-" + sha256Utf8Hex(raw).slice(0, 32);
        try { window.localStorage.setItem(DEVICE_CACHE_KEY, cachedDeviceId); } catch (e2) {}
        if (idFile) {
          try {
            var idDir = path.dirname(idFile);
            if (!fs.existsSync(idDir)) fs.mkdirSync(idDir, { recursive: true });
            fs.writeFileSync(idFile, cachedDeviceId, "utf8");
          } catch (ew) {}
        }
        return cachedDeviceId;
      } catch (e3) {}
    }

    try {
      var hostEnv = (window.__adobe_cep__ && window.__adobe_cep__.getHostEnvironment)
        ? String(window.__adobe_cep__.getHostEnvironment())
        : "";
      var sysPath = (window.__adobe_cep__ && window.__adobe_cep__.getSystemPath)
        ? String(window.__adobe_cep__.getSystemPath("userData"))
        : "";
      var seed = [
        navigator.platform || "OS",
        navigator.hardwareConcurrency || 8,
        (window.screen ? (window.screen.width + "x" + window.screen.height) : ""),
        sysPath,
        hostEnv.slice(0, 120)
      ].join("|");
      cachedDeviceId = "CADR-" + sha256Utf8Hex(seed).slice(0, 32);
      try { window.localStorage.setItem(DEVICE_CACHE_KEY, cachedDeviceId); } catch (e4) {}
      return cachedDeviceId;
    } catch (e5) {
      return "CADR-" + sha256Utf8Hex("CADR-DEFAULT-MACHINE").slice(0, 32);
    }
  }

  /* =====================================================================
   * UNINSTALL-PROOF 3-DAY FREE TRIAL LEDGER
   * Stores signed firstSeen + lastSeen timestamps across multiple hidden
   * system locations outside the plugin folder so deleting/reinstalling
   * the plugin or clearing localStorage NEVER resets the 3-day trial!
   * ===================================================================== */

  function signTrialRecord(deviceId, firstSeen, lastSeen) {
    return sha256Utf8Hex([deviceId, String(firstSeen), String(lastSeen), TRIAL_SECRET_SALT].join("|")).slice(0, 32);
  }

  function encodeTrialRecord(rec) {
    var json = JSON.stringify(rec);
    return "CT1." + btoa(unescape(encodeURIComponent(json)));
  }

  function decodeTrialRecord(raw, expectedDeviceId) {
    try {
      if (!raw || typeof raw !== "string") return null;
      var clean = raw.trim();
      if (clean.indexOf("CT1.") !== 0) return null;
      var json = decodeURIComponent(escape(atob(clean.slice(4))));
      var obj = JSON.parse(json);
      if (!obj || obj.deviceId !== expectedDeviceId) return null;
      var fs = Number(obj.firstSeen);
      var ls = Number(obj.lastSeen);
      if (!isFinite(fs) || !isFinite(ls) || fs <= 1700000000000) return null;
      var expectedSig = signTrialRecord(obj.deviceId, fs, ls);
      if (obj.sig !== expectedSig) return null;
      return { deviceId: obj.deviceId, firstSeen: fs, lastSeen: ls, sig: obj.sig };
    } catch (e) {
      return null;
    }
  }

  function getTrialAnchorPaths() {
    var n = node();
    if (!n) return [];
    try {
      var path = n.require("path");
      var os = n.require("os");
      var proc = n.process || (typeof process !== "undefined" ? process : {});
      var env = proc.env || {};
      var home = os.homedir ? os.homedir() : (env.USERPROFILE || env.HOME || "");
      var appData = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
      var localAppData = env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
      var paths = [];

      if (appData) {
        paths.push(path.join(appData, "Adobe", "Common", ".cadr_sys_anchor.dat"));
        paths.push(path.join(appData, "CADR_STUDIO", ".cadr_trial_state.dat"));
      }
      if (localAppData) {
        paths.push(path.join(localAppData, ".cadr_lic_anchor.dat"));
      }
      if (home) {
        paths.push(path.join(home, ".cadr_studio_telemetry"));
      }
      return paths;
    } catch (e) {
      return [];
    }
  }

  var cachedTrialRecord = null;
  var lastTrialDiskSyncAt = 0;

  function loadAndSyncTrialState(deviceId) {
    var now = Date.now();
    if (cachedTrialRecord && cachedTrialRecord.deviceId === deviceId && (now - lastTrialDiskSyncAt < 30000)) {
      if (now > cachedTrialRecord.lastSeen) {
        cachedTrialRecord.lastSeen = now;
        cachedTrialRecord.sig = signTrialRecord(deviceId, cachedTrialRecord.firstSeen, cachedTrialRecord.lastSeen);
      }
      return cachedTrialRecord;
    }

    var candidates = [];

    /* 1. Check localStorage */
    try {
      var lsRaw = window.localStorage.getItem(TRIAL_STORAGE_KEY);
      var lsRec = decodeTrialRecord(lsRaw, deviceId);
      if (lsRec) candidates.push(lsRec);
    } catch (e1) {}

    /* 2. Check all hidden filesystem anchors */
    var n = node();
    var anchorPaths = getTrialAnchorPaths();
    if (n && anchorPaths.length) {
      try {
        var fs = n.require("fs");
        for (var i = 0; i < anchorPaths.length; i++) {
          try {
            if (fs.existsSync(anchorPaths[i])) {
              var txt = fs.readFileSync(anchorPaths[i], "utf8");
              var fRec = decodeTrialRecord(txt, deviceId);
              if (fRec) candidates.push(fRec);
            }
          } catch (ef) {}
        }
      } catch (e2) {}
    }

    /* All 4 hidden filesystem anchors checked in-memory without spawnSync */

    var earliestFirstSeen = now;
    var latestLastSeen = now;
    var isNewTrial = (candidates.length === 0);

    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c].firstSeen < earliestFirstSeen) {
        earliestFirstSeen = candidates[c].firstSeen;
      }
      if (candidates[c].lastSeen > latestLastSeen) {
        latestLastSeen = candidates[c].lastSeen;
      }
    }

    var effectiveNow = Math.max(now, latestLastSeen);
    var canonical = {
      deviceId: deviceId,
      firstSeen: earliestFirstSeen,
      lastSeen: effectiveNow,
      sig: signTrialRecord(deviceId, earliestFirstSeen, effectiveNow)
    };

    cachedTrialRecord = canonical;
    lastTrialDiskSyncAt = now;

    var encoded = encodeTrialRecord(canonical);

    /* Persist back to localStorage */
    try {
      window.localStorage.setItem(TRIAL_STORAGE_KEY, encoded);
    } catch (e4) {}

    /* Persist back to all hidden filesystem anchors */
    if (n && anchorPaths.length) {
      try {
        var fsWrite = n.require("fs");
        var pathMod = n.require("path");
        for (var w = 0; w < anchorPaths.length; w++) {
          try {
            var dir = pathMod.dirname(anchorPaths[w]);
            if (!fsWrite.existsSync(dir)) {
              fsWrite.mkdirSync(dir, { recursive: true });
            }
            fsWrite.writeFileSync(anchorPaths[w], encoded, "utf8");
          } catch (ew) {}
        }
      } catch (e5) {}
    }



    return canonical;
  }

  function evaluateTrialStatus(deviceId) {
    var rec = loadAndSyncTrialState(deviceId);
    var now = Date.now();
    /* Anti-clock-rollback: if system clock was rolled back behind lastSeen, use lastSeen */
    var effectiveNow = Math.max(now, rec.lastSeen);
    var elapsed = Math.max(0, effectiveNow - rec.firstSeen);
    var remainingMs = TRIAL_DURATION_MS - elapsed;
    var expiresAtIso = new Date(rec.firstSeen + TRIAL_DURATION_MS).toISOString();

    if (remainingMs > 0) {
      var totalHours = Math.ceil(remainingMs / (1000 * 60 * 60));
      var daysLeft = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
      var hoursRemainder = Math.ceil((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      if (hoursRemainder >= 24) {
        daysLeft += 1;
        hoursRemainder = 0;
      }
      return {
        ok: true,
        isTrial: true,
        trialRemainingMs: remainingMs,
        trialTotalHoursLeft: totalHours,
        trialDaysLeft: daysLeft,
        trialHoursLeft: hoursRemainder,
        firstSeenAt: new Date(rec.firstSeen).toISOString(),
        expiresAt: expiresAtIso,
        deviceId: deviceId,
        payload: {
          product: PRODUCT,
          customer: "Free Trial (3 Days)",
          plan: "trial-3d",
          issuedAt: new Date(rec.firstSeen).toISOString(),
          expiresAt: expiresAtIso
        }
      };
    }

    return {
      ok: false,
      isTrial: false,
      trialExpired: true,
      firstSeenAt: new Date(rec.firstSeen).toISOString(),
      expiresAt: expiresAtIso,
      deviceId: deviceId,
      error: "انتهت الفترة التجريبية المجانية (3 أيام). برجاء إدخال كود التفعيل (License Key) للاستمرار."
    };
  }

  /* =====================================================================
   * FULL LICENSE STORAGE (Also backed up to persistent disk config!)
   * ===================================================================== */

  function getPersistentLicenseFilePath() {
    var n = node();
    if (!n) return "";
    try {
      var path = n.require("path");
      var os = n.require("os");
      var proc = n.process || (typeof process !== "undefined" ? process : {});
      var env = proc.env || {};
      var home = os.homedir ? os.homedir() : (env.USERPROFILE || env.HOME || "");
      var appData = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
      if (appData) return path.join(appData, "CADR_STUDIO", "license_key.json");
      if (home) return path.join(home, ".cadr_license_key.json");
    } catch (e) {}
    return "";
  }

  function readStored() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.key) return parsed;
      }
    } catch (e) {}

    /* Fallback to persistent disk file if localStorage was cleared */
    var n = node();
    var diskPath = getPersistentLicenseFilePath();
    if (n && diskPath) {
      try {
        var fs = n.require("fs");
        if (fs.existsSync(diskPath)) {
          var diskParsed = JSON.parse(fs.readFileSync(diskPath, "utf8"));
          if (diskParsed && diskParsed.key) {
            try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(diskParsed)); } catch (e2) {}
            return diskParsed;
          }
        }
      } catch (e3) {}
    }
    return null;
  }

  function writeStored(key) {
    var record = { key: key, savedAt: new Date().toISOString() };
    var savedAny = false;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      savedAny = true;
    } catch (e) {}

    var n = node();
    var diskPath = getPersistentLicenseFilePath();
    if (n && diskPath) {
      try {
        var fs = n.require("fs");
        var path = n.require("path");
        var dir = path.dirname(diskPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(diskPath, JSON.stringify(record), "utf8");
        savedAny = true;
      } catch (e2) {}
    }
    return savedAny;
  }

  function parseKey(input) {
    var text = String(input || "").trim();
    if (!text) return { ok: false, error: "الترخيص فاضي." };
    var parts = text.split(".");
    if (parts.length !== 3 || parts[0] !== FORMAT) return { ok: false, error: "صيغة License Key غير صحيحة." };
    try {
      var payload = JSON.parse(b64urlDecodeUtf8(parts[1]));
      return { ok: true, payload: payload, payloadB64: parts[1], signatureB64: parts[2] };
    } catch (e) {
      return { ok: false, error: "تعذر قراءة بيانات الترخيص." };
    }
  }

  function verifyKey(input) {
    var parsed = parseKey(input);
    if (!parsed.ok) return parsed;
    var p = parsed.payload;
    if (!p || p.product !== PRODUCT) return { ok: false, error: "الترخيص ليس خاصًا بـ CADR CUT." };
    if (!p.licenseId || !p.deviceId || !p.issuedAt) return { ok: false, error: "بيانات الترخيص ناقصة." };

    var deviceId = getDeviceId();
    if (String(p.deviceId) !== String(deviceId)) {
      return { ok: false, error: "الترخيص مرتبط بجهاز آخر.", deviceId: deviceId, payload: p };
    }

    var validSignature = false;
    var n = node();
    if (n) {
      try {
        var crypto = n.require("crypto");
        var Buf = n.Buffer || n.require("buffer").Buffer;
        var verify = crypto.createVerify("RSA-SHA256");
        verify.update(parsed.payloadB64, "utf8");
        verify.end();
        validSignature = verify.verify(publicKeyPem, b64urlToBuffer(parsed.signatureB64, Buf));
      } catch (e) {
        validSignature = verifyRsaSha256PureJs(parsed.payloadB64, parsed.signatureB64);
      }
    } else {
      validSignature = verifyRsaSha256PureJs(parsed.payloadB64, parsed.signatureB64);
    }

    if (!validSignature) {
      return { ok: false, error: "التوقيع غير صالح أو License Key تم تعديله.", deviceId: deviceId, payload: p };
    }

    var now = Date.now();
    if (p.expiresAt !== null && p.expiresAt !== undefined && p.expiresAt !== "") {
      var expiry = Date.parse(p.expiresAt);
      if (!isFinite(expiry)) return { ok: false, error: "تاريخ انتهاء الترخيص غير صالح.", deviceId: deviceId, payload: p };
      if (now > expiry) return { ok: false, error: "الترخيص منتهي الصلاحية.", deviceId: deviceId, payload: p };
    }

    return { ok: true, isTrial: false, payload: p, deviceId: deviceId };
  }

  function current() {
    var deviceId = getDeviceId();
    var stored = readStored();
    if (stored && stored.key) {
      var result = verifyKey(stored.key);
      if (result.ok) return result;
    }
    /* No active paid license key -> evaluate the 3-day uninstall-proof free trial */
    return evaluateTrialStatus(deviceId);
  }

  function activate(key) {
    var result = verifyKey(key);
    if (!result.ok) return result;
    if (!writeStored(String(key).trim())) return { ok: false, error: "تعذر حفظ الترخيص على هذا الجهاز.", deviceId: result.deviceId };
    return result;
  }

  function deactivate() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    var n = node();
    var diskPath = getPersistentLicenseFilePath();
    if (n && diskPath) {
      try { n.require("fs").unlinkSync(diskPath); } catch (e2) {}
    }
    return true;
  }

  window.CADRLicense = {
    product: PRODUCT,
    getDeviceId: getDeviceId,
    verify: verifyKey,
    current: current,
    activate: activate,
    deactivate: deactivate,
    getStoredKey: function () { var s = readStored(); return s ? s.key : ""; }
  };
})();
