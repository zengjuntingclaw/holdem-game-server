"use strict";

const http = require("http");
const fs = require("fs");
const net = require("net");
const tls = require("tls");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("url");
const packageInfo = require("./package.json");

loadEnvFile();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@localhost";
const SMTP_SECURE = process.env.SMTP_SECURE === "1" || process.env.SMTP_SECURE === "true" || SMTP_PORT === 465;
const SMTP_TIMEOUT_MS = clampConfigInt(process.env.SMTP_TIMEOUT_MS, 12000, 3000, 60000);
const MAX_SEATS = 9;
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const TURN_TIME_MS = clampConfigInt(process.env.TURN_TIME_MS, 60000, 1000, 120000);
const EMOTE_COOLDOWN_MS = clampConfigInt(process.env.EMOTE_COOLDOWN_MS, 2500, 500, 60000);
const CHAT_COOLDOWN_MS = clampConfigInt(process.env.CHAT_COOLDOWN_MS, 3000, 500, 60000);
const DEALER_TIP_COOLDOWN_MS = clampConfigInt(process.env.DEALER_TIP_COOLDOWN_MS, 2000, 500, 60000);
const FEEDBACK_COOLDOWN_MS = clampConfigInt(process.env.FEEDBACK_COOLDOWN_MS, 30000, 3000, 300000);
const APP_VERSION = process.env.APP_VERSION || packageInfo.version || "0.1.0";
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "poker.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const AVATAR_DIRS = [
  path.join(PUBLIC_DIR, "avatars", "default"),
  path.join(__dirname, "..", "default_user_face")
];
const AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const EMOTES = new Map([
  ["wellPlayed", "打得不错"],
  ["amazing", "真棒"],
  ["hello", "你好"],
  ["oops", "抱歉"],
  ["wow", "哇哦"]
]);
const SERVER_STARTED_AT = Date.now();
const LOBBY_MUSIC = {
  mode: "single",
  startedAt: SERVER_STARTED_AT,
  tracks: [
    { id: "lobby-heavenly-loop", name: "Heavenly Loop", url: "/music/lobby-heavenly-loop.ogg" }
  ]
};
const ROOM_MUSIC_TRACKS = [
  roomLoopTrack()
];
const DEALER_BLESSINGS = [
  "祝各位手气顺顺",
  "好牌自然来",
  "今晚好运常在",
  "牌风稳一点，福气多一点",
  "愿底池温柔待你",
  "谢谢老板，祝你顺风顺水"
];

const sessions = new Map();
const feedbackChallenges = new Map();
const feedbackCooldowns = new Map();
const rooms = new Map();
const clients = new Set();
const db = initDatabase();

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

function clampConfigInt(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function initDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      password_salt TEXT,
      password_hash TEXT,
      verified_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at);
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      text TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id, created_at);
  `);
  return database;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeUsername(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email || "" };
}

function getUserById(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

function insertUser({ id = crypto.randomUUID(), email, username, passwordSalt = null, passwordHash = null, verifiedAt = null }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (id, email, username, password_salt, password_hash, verified_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, username, passwordSalt, passwordHash, verifiedAt, now);
  return getUserById(id);
}

function upsertCodeLoginUser(email) {
  const existing = getUserByEmail(email);
  if (existing) {
    if (!existing.verified_at) {
      db.prepare("UPDATE users SET verified_at = ? WHERE id = ?").run(Date.now(), existing.id);
    }
    return getUserByEmail(email);
  }
  return insertUser({
    email,
    username: uniqueEmailName(email),
    verifiedAt: Date.now()
  });
}

function uniqueEmailName(email) {
  const local = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 16) || "player";
  let name = local;
  let duplicate = 1;
  while (db.prepare("SELECT id FROM users WHERE username = ?").get(name)) {
    duplicate += 1;
    name = `${local}${duplicate}`;
  }
  return name;
}

function requireUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = sessions.get(token);
  const user = getUserById(userId);
  return user?.verified_at ? user : null;
}

function createFeedbackChallenge(userId) {
  cleanupFeedbackChallenges();
  const left = crypto.randomInt(2, 10);
  const right = crypto.randomInt(2, 10);
  const id = crypto.randomUUID();
  feedbackChallenges.set(id, {
    userId,
    answer: String(left + right),
    expiresAt: Date.now() + 5 * 60 * 1000,
    attempts: 0
  });
  return { id, question: `${left} + ${right} = ?`, expiresInMs: 5 * 60 * 1000 };
}

function cleanupFeedbackChallenges() {
  const now = Date.now();
  for (const [id, challenge] of feedbackChallenges) {
    if (challenge.expiresAt < now || challenge.attempts >= 5) feedbackChallenges.delete(id);
  }
}

function verifyFeedbackChallenge(userId, challengeId, answer) {
  cleanupFeedbackChallenges();
  const challenge = feedbackChallenges.get(String(challengeId || ""));
  if (!challenge || challenge.userId !== userId) return { ok: false, error: "验证码已失效，请刷新验证码" };
  if (challenge.expiresAt < Date.now()) {
    feedbackChallenges.delete(String(challengeId || ""));
    return { ok: false, error: "验证码已过期，请刷新验证码" };
  }
  challenge.attempts += 1;
  if (String(answer || "").trim() !== challenge.answer) {
    return { ok: false, error: "验证码不正确" };
  }
  feedbackChallenges.delete(String(challengeId || ""));
  return { ok: true };
}

function insertFeedback({ user, text, req }) {
  db.prepare(`
    INSERT INTO feedback (id, user_id, username, email, text, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    user.id,
    user.username,
    user.email || "",
    text,
    req.socket.remoteAddress || "",
    String(req.headers["user-agent"] || "").slice(0, 300),
    Date.now()
  );
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/version") {
      return json(res, 200, { version: APP_VERSION, startedAt: SERVER_STARTED_AT });
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      const username = normalizeUsername(body.username) || uniqueEmailName(email);
      const password = String(body.password || "");
      if (!isValidEmail(email)) {
        return json(res, 400, { error: "邮箱格式不正确" });
      }
      if (!/^[\w\u4e00-\u9fa5 -]{2,20}$/.test(username)) {
        return json(res, 400, { error: "昵称需要 2-20 个字符" });
      }
      if (password.length < 6) {
        return json(res, 400, { error: "密码至少 6 位" });
      }
      if (getUserByEmail(email)) {
        return json(res, 409, { error: "邮箱已注册" });
      }
      const passwordHash = hashPassword(password);
      const user = insertUser({
        email,
        username,
        passwordSalt: passwordHash.salt,
        passwordHash: passwordHash.hash
      });
      const verification = await createAndSendEmailCode(email);
      return json(res, 201, {
        requiresVerification: true,
        user: publicUser(user),
        message: verification.sent ? "注册成功，验证码已发送，请验证邮箱后登录" : "注册成功，请使用验证码完成邮箱验证",
        devCode: verification.devCode
      });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const user = getUserByEmail(email);
      if (!user || !user.password_hash || !user.password_salt) {
        return json(res, 401, { error: "邮箱或密码不正确" });
      }
      const passwordHash = hashPassword(password, user.password_salt);
      const ok = safeEqual(passwordHash.hash, user.password_hash);
      if (!ok) {
        return json(res, 401, { error: "邮箱或密码不正确" });
      }
      if (!user.verified_at) {
        return json(res, 403, { error: "邮箱未验证，请先获取验证码并完成验证码登录" });
      }
      const token = createToken();
      sessions.set(token, user.id);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/email-code/request") {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) {
        return json(res, 400, { error: "邮箱格式不正确" });
      }
      const result = await createAndSendEmailCode(email);
      return json(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/email-code/verify") {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      const code = String(body.code || "").trim();
      if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
        return json(res, 400, { error: "邮箱或验证码格式不正确" });
      }
      const verification = verifyEmailCode(email, code);
      if (!verification.ok) {
        return json(res, 400, { error: verification.error });
      }
      const user = upsertCodeLoginUser(email);
      const token = createToken();
      sessions.set(token, user.id);
      return json(res, 200, { token, user: publicUser(user) });
    }

    const user = requireUser(req);
    if (!user) {
      return json(res, 401, { error: "请先登录" });
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      return json(res, 200, { user: publicUser(user) });
    }

    if (req.method === "GET" && url.pathname === "/api/avatars") {
      return json(res, 200, { avatars: listAvatars() });
    }

    if (req.method === "GET" && url.pathname === "/api/rooms") {
      return json(res, 200, { rooms: [...rooms.values()].map(publicRoom) });
    }

    if (req.method === "GET" && url.pathname === "/api/feedback/challenge") {
      return json(res, 200, { challenge: createFeedbackChallenge(user.id) });
    }

    if (req.method === "POST" && url.pathname === "/api/feedback") {
      const now = Date.now();
      const availableAt = feedbackCooldowns.get(user.id) || 0;
      if (availableAt > now) {
        return json(res, 429, { error: `提交太快，请 ${Math.ceil((availableAt - now) / 1000)} 秒后再试` });
      }
      const body = await readBody(req);
      const text = String(body.text || "").trim().slice(0, 1200);
      if (text.length < 5) {
        return json(res, 400, { error: "意见至少 5 个字" });
      }
      const captcha = verifyFeedbackChallenge(user.id, body.challengeId, body.captcha);
      if (!captcha.ok) {
        return json(res, 400, { error: captcha.error });
      }
      insertFeedback({ user, text, req });
      feedbackCooldowns.set(user.id, now + FEEDBACK_COOLDOWN_MS);
      return json(res, 201, { ok: true, message: "已收到，谢谢你的意见" });
    }

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readBody(req);
      const name = String(body.name || `${user.username} 的牌桌`).trim().slice(0, 32);
      const settings = normalizeRoomSettings(body);
      const room = createRoom(name || `${user.username} 的牌桌`, user, settings);
      rooms.set(room.id, room);
      broadcastLobby();
      return json(res, 201, { room: publicRoom(room) });
    }

    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    return json(res, 400, { error: error.message || "请求失败" });
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashCode(email, code) {
  return crypto.createHash("sha256").update(`${email}:${code}:${process.env.CODE_PEPPER || "local-pepper"}`).digest("hex");
}

async function createAndSendEmailCode(email) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const now = Date.now();
  db.prepare(`
    INSERT INTO email_codes (id, email, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), email, hashCode(email, code), now + 10 * 60 * 1000, now);

  const mail = {
    to: email,
    subject: "德州扑克登录验证码",
    text: `你的德州扑克登录验证码是：${code}\n\n验证码 10 分钟内有效。如果不是你本人操作，可以忽略这封邮件。`
  };

  if (!SMTP_HOST) {
    console.log(`[DEV EMAIL CODE] ${email}: ${code}`);
    return {
      sent: false,
      localCodeMode: true,
      devCode: code,
      message: "SMTP 未配置，已切换本地验证码模式"
    };
  }

  await sendSmtpMail(mail);
  return { sent: true, message: "验证码已发送" };
}

function verifyEmailCode(email, code) {
  const record = db.prepare(`
    SELECT * FROM email_codes
    WHERE email = ? AND consumed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(email);
  if (!record) return { ok: false, error: "请先获取验证码" };
  if (record.expires_at < Date.now()) return { ok: false, error: "验证码已过期" };
  if (record.attempts >= 5) return { ok: false, error: "验证码错误次数过多，请重新获取" };

  const ok = safeEqual(record.code_hash, hashCode(email, code));
  if (!ok) {
    db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(record.id);
    return { ok: false, error: "验证码不正确" };
  }
  db.prepare("UPDATE email_codes SET consumed_at = ? WHERE id = ?").run(Date.now(), record.id);
  return { ok: true };
}

async function sendSmtpMail({ to, subject, text }) {
  const socket = SMTP_SECURE
    ? tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST })
    : net.connect({ host: SMTP_HOST, port: SMTP_PORT });
  let secureSocket = socket;
  secureSocket.setTimeout(SMTP_TIMEOUT_MS, () => secureSocket.destroy(new Error("SMTP 连接超时")));
  let buffer = "";

  const readLine = () => new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      const complete = lines.find((line) => /^\d{3} /.test(line));
      if (!complete) return;
      secureSocket.off("data", onData);
      secureSocket.off("error", onError);
      buffer = "";
      resolve(complete);
    };
    const onError = (error) => {
      secureSocket.off("data", onData);
      reject(error);
    };
    secureSocket.on("data", onData);
    secureSocket.on("error", onError);
  });
  const command = async (line, expected = ["250"]) => {
    secureSocket.write(`${line}\r\n`);
    const response = await readLine();
    if (!expected.some((code) => response.startsWith(code))) {
      throw new Error(`SMTP 发送失败：${response}`);
    }
    return response;
  };

  await new Promise((resolve, reject) => {
    secureSocket.once(SMTP_SECURE ? "secureConnect" : "connect", resolve);
    secureSocket.once("error", reject);
  });
  await readLine();
  await command(`EHLO ${SMTP_HOST}`);
  if (!SMTP_SECURE) {
    await command("STARTTLS", ["220"]);
    secureSocket = tls.connect({ socket, servername: SMTP_HOST });
    secureSocket.setTimeout(SMTP_TIMEOUT_MS, () => secureSocket.destroy(new Error("SMTP 连接超时")));
    await new Promise((resolve, reject) => {
      secureSocket.once("secureConnect", resolve);
      secureSocket.once("error", reject);
    });
    await command(`EHLO ${SMTP_HOST}`);
  }
  if (SMTP_USER || SMTP_PASS) {
    await command("AUTH LOGIN", ["334"]);
    await command(Buffer.from(SMTP_USER).toString("base64"), ["334"]);
    await command(Buffer.from(SMTP_PASS).toString("base64"), ["235"]);
  }
  await command(`MAIL FROM:<${SMTP_FROM}>`);
  await command(`RCPT TO:<${to}>`, ["250", "251"]);
  await command("DATA", ["354"]);
  const message = [
    `From: ${SMTP_FROM}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text.replace(/^\./gm, "..")
  ].join("\r\n");
  await command(`${message}\r\n.`, ["250"]);
  await command("QUIT", ["221"]);
  secureSocket.end();
}

function serveStatic(req, res, url) {
  if (url.pathname.startsWith("/avatars/")) {
    return serveAvatar(req, res, url);
  }
  const rawPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rawPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = contentTypeFor(ext);
    const headers = staticHeadersFor(ext, type, stat.size);
    const range = req.headers.range;
    if (range) {
      const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        const errorHeaders = { ...headers, "content-range": `bytes */${stat.size}` };
        delete errorHeaders["content-length"];
        res.writeHead(416, errorHeaders);
        return res.end();
      }
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!match[1] && match[2]) {
        const suffixLength = Number(match[2]);
        start = Math.max(0, stat.size - suffixLength);
        end = stat.size - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= stat.size) {
        const errorHeaders = { ...headers, "content-range": `bytes */${stat.size}` };
        delete errorHeaders["content-length"];
        res.writeHead(416, errorHeaders);
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        ...headers,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${stat.size}`
      });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function contentTypeFor(ext) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".txt": "text/plain; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function staticHeadersFor(ext, type, size) {
  const isAudio = [".ogg", ".mp3", ".wav"].includes(ext);
  const isVersionedAsset = [".css", ".js", ".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
  return {
    "content-type": type,
    "content-length": size,
    "accept-ranges": "bytes",
    "cache-control": isAudio
      ? "public, max-age=604800"
      : isVersionedAsset
      ? "public, max-age=3600"
      : "no-store"
  };
}

function roomLoopTrack() {
  const mp3Path = path.join(PUBLIC_DIR, "music", "room-loop.mp3");
  if (fs.existsSync(mp3Path)) {
    return versionedMusicTrack("room-loop-mp3", "Room Loop", "/music/room-loop.mp3", mp3Path);
  }
  const oggPath = path.join(PUBLIC_DIR, "music", "room-loop.ogg");
  return versionedMusicTrack("room-loop", "Room Loop", "/music/room-loop.ogg", oggPath);
}

function versionedMusicTrack(id, name, url, filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { id, name, url: `${url}?v=${Math.floor(stat.mtimeMs)}` };
  } catch {
    return { id, name, url };
  }
}

function listAvatars() {
  const seen = new Set();
  const avatars = [];
  for (const dir of AVATAR_DIRS) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (seen.has(name) || !AVATAR_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
        const filePath = path.join(dir, name);
        if (!fs.statSync(filePath).isFile()) continue;
        seen.add(name);
        avatars.push({ name, url: `/avatars/${encodeURIComponent(name)}` });
      }
    } catch {
      // Missing optional avatar directory is fine.
    }
  }
  return avatars;
}

function isAllowedAvatar(name) {
  return listAvatars().some((avatar) => avatar.name === name);
}

function randomAvatar(except = "") {
  const avatars = listAvatars().map((avatar) => avatar.name);
  const choices = avatars.filter((name) => name !== except);
  const pool = choices.length ? choices : avatars;
  if (!pool.length) return "";
  return pool[crypto.randomInt(pool.length)];
}

function serveAvatar(req, res, url) {
  const requested = decodeURIComponent(url.pathname.slice("/avatars/".length));
  const filePath = avatarFilePath(requested);
  if (!filePath) {
    res.writeHead(404);
    return res.end("Not found");
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif"
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
    res.end(data);
  });
}

function avatarFilePath(name) {
  if (!name || path.basename(name) !== name || !AVATAR_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    return null;
  }
  for (const dir of AVATAR_DIRS) {
    const filePath = path.join(dir, name);
    try {
      if (fs.statSync(filePath).isFile()) return filePath;
    } catch {
      // Try the next avatar directory.
    }
  }
  return null;
}

function normalizeRoomSettings(body) {
  const smallBlind = clampInt(body.smallBlind, SMALL_BLIND, 1, 100000);
  const bigBlind = clampInt(body.bigBlind, Math.max(BIG_BLIND, smallBlind * 2), smallBlind + 1, 200000);
  const startingChips = clampInt(body.startingChips, STARTING_CHIPS, bigBlind * 20, 10000000);
  return { smallBlind, bigBlind, startingChips };
}

function clampInt(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function createRoom(name, owner, settings = {}) {
  const smallBlind = settings.smallBlind || SMALL_BLIND;
  const bigBlind = settings.bigBlind || BIG_BLIND;
  const startingChips = settings.startingChips || STARTING_CHIPS;
  return {
    id: crypto.randomBytes(4).toString("hex").toUpperCase(),
    name,
    ownerId: owner.id,
    createdAt: Date.now(),
    settings: { smallBlind, bigBlind, startingChips },
    dealerTips: 0,
    turnTimer: null,
    chipAnimations: [],
    music: {
      mode: "single",
      startedAt: Date.now(),
      tracks: ROOM_MUSIC_TRACKS
    },
    cooldowns: {
      emote: new Map(),
      chat: new Map(),
      dealerTip: new Map()
    },
    seats: Array.from({ length: MAX_SEATS }, () => null),
    messages: [],
    game: {
      status: "waiting",
      handNumber: 0,
      button: -1,
      smallBlind,
      bigBlind,
      deck: [],
      deckCommit: "",
      fairSeed: "",
      revealedDeck: [],
      board: [],
      pot: 0,
      currentBet: 0,
      minRaise: bigBlind,
      actingSeat: null,
      turnStartedAt: 0,
      turnDeadlineAt: 0,
      acted: [],
      winners: [],
      lastAction: "等待玩家入座"
    }
  };
}

function publicRoom(room) {
  const seated = occupiedSeats(room).filter((player) => player.chips > 0);
  const readySeats = seated.filter((player) => player.ready).length;
  return {
    id: room.id,
    name: room.name,
    seats: room.seats.filter(Boolean).length,
    maxSeats: MAX_SEATS,
    status: room.game.status,
    handNumber: room.game.handNumber,
    ownerId: room.ownerId,
    smallBlind: room.settings.smallBlind,
    bigBlind: room.settings.bigBlind,
    startingChips: room.settings.startingChips,
    readySeats,
    canStart: seated.length >= 2 && readySeats === seated.length && ["waiting", "showdown"].includes(room.game.status)
  };
}

function publicLobbyPayload() {
  return {
    type: "lobby",
    rooms: [...rooms.values()].map(publicRoom),
    music: LOBBY_MUSIC,
    version: APP_VERSION,
    serverNow: Date.now()
  };
}

function createDeck(serverSeed = crypto.randomBytes(32).toString("hex")) {
  const suits = ["s", "h", "d", "c"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(rank + suit);
    }
  }
  const random = seededRandom(serverSeed);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function seededRandom(seed) {
  let counter = 0;
  let pool = Buffer.alloc(0);
  let offset = 0;
  return () => {
    if (offset + 4 > pool.length) {
      pool = crypto.createHash("sha256").update(`${seed}:${counter}`).digest();
      counter += 1;
      offset = 0;
    }
    const value = pool.readUInt32BE(offset);
    offset += 4;
    return value / 0x100000000;
  };
}

function deckCommit(seed, deck) {
  return crypto.createHash("sha256").update(`${seed}:${deck.join(",")}`).digest("hex");
}

function occupiedSeats(room) {
  return room.seats
    .map((seat, index) => {
      if (!seat) return null;
      seat.seat = index;
      return seat;
    })
    .filter(Boolean);
}

function nextSeat(room, from, predicate = () => true) {
  for (let step = 1; step <= MAX_SEATS; step += 1) {
    const index = (from + step + MAX_SEATS) % MAX_SEATS;
    const player = room.seats[index];
    if (player && predicate(player, index)) {
      return index;
    }
  }
  return null;
}

function activePlayers(room) {
  return occupiedSeats(room).filter((player) => !player.folded && player.inHand);
}

function isHandInProgress(room) {
  return !["waiting", "showdown"].includes(room.game.status);
}

function seatedPlayer(room, userId) {
  return room.seats.find((seat) => seat && seat.userId === userId) || null;
}

function playersNeedingAction(room) {
  return activePlayers(room).filter((player) => player.chips > 0);
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.game.turnStartedAt = 0;
  room.game.turnDeadlineAt = 0;
}

function scheduleTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  const game = room.game;
  if (!isHandInProgress(room) || game.actingSeat === null) {
    game.turnStartedAt = 0;
    game.turnDeadlineAt = 0;
    return;
  }
  const player = room.seats[game.actingSeat];
  if (!player || !canAct(player)) {
    game.turnStartedAt = 0;
    game.turnDeadlineAt = 0;
    return;
  }
  const now = Date.now();
  game.turnStartedAt = now;
  game.turnDeadlineAt = now + TURN_TIME_MS;
  const handNumber = game.handNumber;
  const actingSeat = game.actingSeat;
  const deadline = game.turnDeadlineAt;
  room.turnTimer = setTimeout(() => {
    handleTurnTimeout(room.id, handNumber, actingSeat, deadline);
  }, TURN_TIME_MS + 100);
}

function handleTurnTimeout(roomId, handNumber, actingSeat, deadline) {
  const room = rooms.get(roomId);
  if (!room) return;
  const game = room.game;
  if (!isHandInProgress(room) || game.handNumber !== handNumber || game.actingSeat !== actingSeat || game.turnDeadlineAt !== deadline) {
    return;
  }
  const player = room.seats[actingSeat];
  if (!player || !canAct(player)) {
    autoAdvanceIfNeeded(room);
    scheduleTurnTimer(room);
    broadcastRoom(room);
    return;
  }
  const callAmount = Math.max(0, game.currentBet - player.bet);
  if (callAmount > 0) {
    player.folded = true;
    game.lastAction = `${player.username} 超时弃牌`;
  } else {
    game.lastAction = `${player.username} 超时过牌`;
  }
  game.acted = [...new Set([...game.acted, player.userId])];
  autoAdvanceIfNeeded(room);
  processAutomaticTurns(room);
  scheduleTurnTimer(room);
  broadcastRoom(room);
}

function startHand(room) {
  const seated = occupiedSeats(room).filter((player) => player.chips > 0);
  if (seated.length < 2) {
    throw new Error("至少需要 2 个有筹码的玩家");
  }
  if (!seated.every((player) => player.ready)) {
    throw new Error("所有入座玩家准备后才能开始");
  }

  const game = room.game;
  game.status = "preflop";
  game.handNumber += 1;
  const fairSeed = crypto.randomBytes(32).toString("hex");
  const fullDeck = createDeck(fairSeed);
  game.deck = [...fullDeck];
  game.fairSeed = fairSeed;
  game.deckCommit = deckCommit(fairSeed, fullDeck);
  game.revealedDeck = [];
  game.board = [];
  game.pot = 0;
  game.currentBet = 0;
  game.minRaise = room.settings.bigBlind;
  game.acted = [];
  game.winners = [];

  for (const player of occupiedSeats(room)) {
    player.hole = [];
    player.bet = 0;
    player.committed = 0;
    player.folded = false;
    player.allIn = false;
    player.inHand = player.chips > 0;
    player.ready = false;
    player.pendingAction = null;
    player.result = "";
  }

  game.button = nextSeat(room, game.button, (player) => player.inHand);
  const playerCount = seated.length;
  const smallBlindSeat = playerCount === 2 ? game.button : nextSeat(room, game.button, (player) => player.inHand);
  const bigBlindSeat = nextSeat(room, smallBlindSeat, (player) => player.inHand);

  const smallBlindPaid = takeChips(room, smallBlindSeat, Math.min(room.settings.smallBlind, room.seats[smallBlindSeat].chips));
  const bigBlindPaid = takeChips(room, bigBlindSeat, Math.min(room.settings.bigBlind, room.seats[bigBlindSeat].chips));
  addChipAnimation(room, smallBlindSeat, smallBlindPaid, "小盲");
  addChipAnimation(room, bigBlindSeat, bigBlindPaid, "大盲");
  game.currentBet = Math.max(room.seats[smallBlindSeat].bet, room.seats[bigBlindSeat].bet);

  for (let round = 0; round < 2; round += 1) {
    for (const player of occupiedSeats(room).filter((item) => item.inHand)) {
      player.hole.push(game.deck.pop());
    }
  }

  game.actingSeat = nextSeat(room, bigBlindSeat, canAct);
  game.lastAction = `第 ${game.handNumber} 手牌开始`;
  autoAdvanceIfNeeded(room);
  processAutomaticTurns(room);
  scheduleTurnTimer(room);
}

function canAct(player) {
  return player.inHand && !player.folded && player.chips > 0;
}

function takeChips(room, seatIndex, amount) {
  const player = room.seats[seatIndex];
  const paid = Math.max(0, Math.min(Number(amount) || 0, player.chips));
  player.chips -= paid;
  player.bet += paid;
  player.committed = (player.committed || 0) + paid;
  player.allIn = player.chips === 0;
  room.game.pot += paid;
  return paid;
}

function handlePlayerAction(room, user, payload) {
  const seatIndex = room.seats.findIndex((player) => player && player.userId === user.id);
  if (seatIndex === -1) {
    throw new Error("你还没有入座");
  }
  applyPlayerAction(room, seatIndex, String(payload.action || ""), payload.amount);
  finishActionProcessing(room);
}

function applyPlayerAction(room, seatIndex, action, amount, prefix = "") {
  const game = room.game;
  const player = room.seats[seatIndex];
  if (!player) throw new Error("你还没有入座");
  if (game.status === "waiting" || game.status === "showdown") {
    throw new Error("当前没有进行中的手牌");
  }
  if (game.actingSeat !== seatIndex) {
    throw new Error("还没轮到你");
  }
  const callAmount = Math.max(0, game.currentBet - player.bet);
  const name = prefix ? `${player.username} ${prefix}` : player.username;
  player.pendingAction = null;

  if (action === "fold") {
    player.folded = true;
    game.acted.push(player.userId);
    game.lastAction = `${name} 弃牌`;
  } else if (action === "check") {
    if (callAmount > 0) {
      throw new Error("当前不能过牌，需要跟注或弃牌");
    }
    game.acted.push(player.userId);
    game.lastAction = `${name} 过牌`;
  } else if (action === "call") {
    const paid = takeChips(room, seatIndex, callAmount);
    addChipAnimation(room, seatIndex, paid, "跟注");
    game.acted.push(player.userId);
    game.lastAction = `${name} 跟注 ${paid}`;
  } else if (action === "bet") {
    if (game.currentBet > 0) {
      throw new Error("已有下注，请选择加注");
    }
    const total = Math.floor(Number(amount));
    if (!Number.isFinite(total) || total < room.settings.bigBlind) {
      throw new Error(`下注至少 ${room.settings.bigBlind}`);
    }
    const paid = takeChips(room, seatIndex, total);
    addChipAnimation(room, seatIndex, paid, "下注");
    game.currentBet = player.bet;
    game.minRaise = room.settings.bigBlind;
    game.acted = [player.userId];
    game.lastAction = `${name} 下注 ${paid}`;
  } else if (action === "raise") {
    const total = Math.floor(Number(amount));
    const raiseBy = total - game.currentBet;
    if (!Number.isFinite(total) || total <= game.currentBet) {
      throw new Error("加注金额需要高于当前下注");
    }
    if (raiseBy < game.minRaise && total < player.bet + player.chips) {
      throw new Error(`最小加注额为 ${game.minRaise}`);
    }
    const paid = takeChips(room, seatIndex, total - player.bet);
    addChipAnimation(room, seatIndex, paid, "加注");
    if (player.bet > game.currentBet) {
      game.minRaise = Math.max(game.minRaise, player.bet - game.currentBet);
      game.currentBet = player.bet;
      game.acted = [player.userId];
    } else {
      game.acted.push(player.userId);
    }
    game.lastAction = `${name} 加注到 ${player.bet}（本次投入 ${paid}）`;
  } else {
    throw new Error("未知操作");
  }

  game.acted = [...new Set(game.acted)];
  autoAdvanceIfNeeded(room);
}

function finishActionProcessing(room) {
  processAutomaticTurns(room);
  scheduleTurnTimer(room);
}

function setPresetAction(room, user, payload) {
  const seatIndex = room.seats.findIndex((player) => player && player.userId === user.id);
  if (seatIndex === -1) throw new Error("你还没有入座");
  const player = room.seats[seatIndex];
  if (!isHandInProgress(room) || !player.inHand || player.folded || player.allIn) {
    throw new Error("当前不能设置预设动作");
  }
  const action = String(payload.action || "");
  if (action === "clear") {
    player.pendingAction = null;
    room.game.lastAction = `${player.username} 清除了预设动作`;
    return;
  }
  if (!["fold", "checkCall", "betRaise"].includes(action)) {
    throw new Error("未知预设动作");
  }
  const amount = clampInt(payload.amount, 0, 0, player.bet + player.chips);
  player.pendingAction = {
    action,
    amount,
    createdAt: Date.now()
  };
  room.game.lastAction = `${player.username} 已设置预设动作`;
  if (room.game.actingSeat === seatIndex) {
    processAutomaticTurns(room);
    scheduleTurnTimer(room);
  }
}

function processAutomaticTurns(room) {
  let guard = MAX_SEATS * 8;
  while (guard > 0 && isHandInProgress(room) && Number.isInteger(room.game.actingSeat)) {
    guard -= 1;
    const seatIndex = room.game.actingSeat;
    const player = room.seats[seatIndex];
    if (!player || !canAct(player)) {
      autoAdvanceIfNeeded(room);
      continue;
    }
    const disconnected = !isUserConnected(player.userId);
    const preset = player.pendingAction;
    if (!disconnected && !preset) break;
    const resolved = resolveAutomaticAction(room, seatIndex, disconnected ? null : preset);
    const prefix = disconnected ? "离线自动" : "按预设";
    applyPlayerAction(room, seatIndex, resolved.action, resolved.amount, prefix);
  }
}

function resolveAutomaticAction(room, seatIndex, preset) {
  const game = room.game;
  const player = room.seats[seatIndex];
  const callAmount = Math.max(0, game.currentBet - player.bet);
  const fallback = callAmount > 0 ? { action: "fold", amount: 0 } : { action: "check", amount: 0 };
  if (!preset) return fallback;

  if (preset.action === "fold") return { action: "fold", amount: 0 };
  if (preset.action === "checkCall") return callAmount > 0
    ? { action: "call", amount: 0 }
    : { action: "check", amount: 0 };

  if (preset.action === "betRaise") {
    const total = Math.floor(Number(preset.amount));
    if (game.currentBet === 0 && Number.isFinite(total) && total >= room.settings.bigBlind) {
      return { action: "bet", amount: total };
    }
    const raiseBy = total - game.currentBet;
    const canRaise = Number.isFinite(total)
      && total > game.currentBet
      && (raiseBy >= game.minRaise || total >= player.bet + player.chips);
    if (game.currentBet > 0 && canRaise) {
      return { action: "raise", amount: total };
    }
  }

  return fallback;
}

function autoAdvanceIfNeeded(room) {
  const game = room.game;
  if (game.status === "waiting" || game.status === "showdown") {
    return;
  }

  const alive = activePlayers(room);
  if (alive.length === 1) {
    awardSingleWinner(room, alive[0]);
    return;
  }

  const needAction = playersNeedingAction(room);
  if (needAction.length === 0) {
    runBoardToShowdown(room);
    return;
  }

  const complete = needAction.every((player) => player.bet === game.currentBet && game.acted.includes(player.userId));
  if (complete) {
    advanceStreet(room);
    return;
  }

  if (game.actingSeat === null || !canAct(room.seats[game.actingSeat])) {
    game.actingSeat = nextSeat(room, game.actingSeat ?? game.button, canAct);
    return;
  }

  if (room.seats[game.actingSeat].bet === game.currentBet && game.acted.includes(room.seats[game.actingSeat].userId)) {
    game.actingSeat = nextSeat(room, game.actingSeat, (player) => canAct(player) && !(player.bet === game.currentBet && game.acted.includes(player.userId)));
  }
}

function advanceStreet(room) {
  const game = room.game;
  for (const player of occupiedSeats(room)) {
    player.bet = 0;
  }
  game.currentBet = 0;
  game.minRaise = room.settings.bigBlind;
  game.acted = [];

  if (game.status === "preflop") {
    game.board.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
    game.status = "flop";
    game.lastAction = "翻牌";
  } else if (game.status === "flop") {
    game.board.push(game.deck.pop());
    game.status = "turn";
    game.lastAction = "转牌";
  } else if (game.status === "turn") {
    game.board.push(game.deck.pop());
    game.status = "river";
    game.lastAction = "河牌";
  } else {
    showdown(room);
    return;
  }

  const needAction = playersNeedingAction(room);
  if (needAction.length <= 1) {
    runBoardToShowdown(room);
    return;
  }
  game.actingSeat = nextSeat(room, game.button, canAct);
}

function runBoardToShowdown(room) {
  const game = room.game;
  while (game.board.length < 5) {
    game.board.push(game.deck.pop());
  }
  showdown(room);
}

function awardSingleWinner(room, player) {
  const game = room.game;
  clearTurnTimer(room);
  player.chips += game.pot;
  player.result = `赢得底池 ${game.pot}`;
  game.winners = [{
    seat: player.seat,
    userId: player.userId,
    username: player.username,
    amount: game.pot,
    hand: "其他玩家弃牌",
    pot: "底池"
  }];
  game.pot = 0;
  game.actingSeat = null;
  game.status = "showdown";
  revealFairProof(room);
  game.lastAction = `${player.username} 赢得本手`;
}

function showdown(room) {
  const game = room.game;
  clearTurnTimer(room);
  const contenders = activePlayers(room);
  const ranked = contenders.map((player) => ({
    player,
    result: evaluateSeven([...player.hole, ...game.board])
  }));
  ranked.sort((a, b) => compareScores(b.result.score, a.result.score));

  for (const { player, result } of ranked) {
    player.result = result.name;
  }

  const sidePots = buildSidePots(room);
  const winnings = new Map();
  const winnerRows = [];
  for (const pot of sidePots) {
    const eligibleRanked = ranked.filter(({ player }) => pot.eligible.includes(player));
    if (!eligibleRanked.length) continue;
    const best = eligibleRanked[0].result.score;
    const winners = eligibleRanked.filter((item) => compareScores(item.result.score, best) === 0);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const { player, result } of winners) {
      const amount = share + (remainder > 0 ? 1 : 0);
      remainder -= 1;
      player.chips += amount;
      winnings.set(player.userId, (winnings.get(player.userId) || 0) + amount);
      winnerRows.push({
        seat: player.seat,
        userId: player.userId,
        username: player.username,
        amount,
        hand: result.name,
        pot: pot.name
      });
    }
  }

  for (const { player, result } of ranked) {
    const won = winnings.get(player.userId) || 0;
    if (won > 0) player.result = `${result.name}，赢得 ${won}`;
  }

  game.winners = winnerRows;
  game.pot = 0;
  game.actingSeat = null;
  game.status = "showdown";
  revealFairProof(room);
  game.lastAction = "摊牌结算";
}

function buildSidePots(room) {
  const contributors = occupiedSeats(room)
    .filter((player) => player.inHand && (player.committed || 0) > 0)
    .sort((a, b) => (a.committed || 0) - (b.committed || 0));
  const levels = [...new Set(contributors.map((player) => player.committed || 0))].filter((amount) => amount > 0);
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const participants = contributors.filter((player) => (player.committed || 0) >= level);
    const eligible = participants.filter((player) => !player.folded);
    const amount = (level - previous) * participants.length;
    if (amount > 0 && eligible.length) {
      pots.push({
        name: pots.length === 0 ? "主池" : `边池 ${pots.length}`,
        amount,
        eligible
      });
    }
    previous = level;
  }
  const totalSidePots = pots.reduce((sum, pot) => sum + pot.amount, 0);
  if (!pots.length && room.game.pot > 0) {
    return [{ name: "主池", amount: room.game.pot, eligible: activePlayers(room) }];
  }
  if (totalSidePots < room.game.pot) {
    const eligible = activePlayers(room);
    if (eligible.length) {
      pots.push({
        name: pots.length === 0 ? "主池" : `边池 ${pots.length}`,
        amount: room.game.pot - totalSidePots,
        eligible
      });
    }
  }
  return pots;
}

function revealFairProof(room) {
  const game = room.game;
  game.revealedDeck = createDeck(game.fairSeed);
}

function rankValue(card) {
  return "23456789TJQKA".indexOf(card[0]) + 2;
}

function evaluateSeven(cards) {
  const byRank = new Map();
  const bySuit = new Map();
  for (const card of cards) {
    const rank = rankValue(card);
    const suit = card[1];
    byRank.set(rank, (byRank.get(rank) || 0) + 1);
    if (!bySuit.has(suit)) bySuit.set(suit, []);
    bySuit.get(suit).push(rank);
  }
  const ranksDesc = [...byRank.keys()].sort((a, b) => b - a);
  const counts = [...byRank.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flushRanks = [...bySuit.values()].find((items) => items.length >= 5)?.sort((a, b) => b - a) || null;
  const straightHigh = findStraightHigh(ranksDesc);
  const straightFlushHigh = flushRanks ? findStraightHigh([...new Set(flushRanks)]) : 0;

  if (straightFlushHigh) return namedScore("同花顺", [8, straightFlushHigh]);

  const quad = counts.find(([, count]) => count === 4);
  if (quad) {
    const kicker = ranksDesc.find((rank) => rank !== quad[0]);
    return namedScore("四条", [7, quad[0], kicker]);
  }

  const trips = counts.filter(([, count]) => count === 3).map(([rank]) => rank);
  const pairs = counts.filter(([, count]) => count === 2).map(([rank]) => rank);
  if (trips.length && (pairs.length || trips.length > 1)) {
    return namedScore("葫芦", [6, trips[0], trips.length > 1 ? trips[1] : pairs[0]]);
  }

  if (flushRanks) return namedScore("同花", [5, ...flushRanks.slice(0, 5)]);
  if (straightHigh) return namedScore("顺子", [4, straightHigh]);
  if (trips.length) {
    return namedScore("三条", [3, trips[0], ...ranksDesc.filter((rank) => rank !== trips[0]).slice(0, 2)]);
  }
  if (pairs.length >= 2) {
    const kicker = ranksDesc.find((rank) => rank !== pairs[0] && rank !== pairs[1]);
    return namedScore("两对", [2, pairs[0], pairs[1], kicker]);
  }
  if (pairs.length === 1) {
    return namedScore("一对", [1, pairs[0], ...ranksDesc.filter((rank) => rank !== pairs[0]).slice(0, 3)]);
  }
  return namedScore("高牌", [0, ...ranksDesc.slice(0, 5)]);
}

function namedScore(name, score) {
  return { name, score };
}

function findStraightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  let run = 1;
  for (let i = 1; i < unique.length; i += 1) {
    if (unique[i - 1] - unique[i] === 1) {
      run += 1;
      if (run >= 5) return unique[i - 4];
    } else {
      run = 1;
    }
  }
  return 0;
}

function compareScores(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function roomStateFor(room, viewerId) {
  const reveal = room.game.status === "showdown";
  return {
    room: publicRoom(room),
    game: {
      status: room.game.status,
      handNumber: room.game.handNumber,
      button: room.game.button,
      board: room.game.board,
      pot: room.game.pot,
      dealerTips: room.dealerTips || 0,
      currentBet: room.game.currentBet,
      minRaise: room.game.minRaise,
      actingSeat: room.game.actingSeat,
      turnStartedAt: room.game.turnStartedAt || 0,
      turnDeadlineAt: room.game.turnDeadlineAt || 0,
      timeLimitMs: TURN_TIME_MS,
      serverNow: Date.now(),
      smallBlind: room.game.smallBlind,
      bigBlind: room.game.bigBlind,
      winners: room.game.winners,
      lastAction: room.game.lastAction,
      fairness: {
        algorithm: "sha256(seed:deck)",
        deckCommit: room.game.deckCommit || "",
        seed: reveal ? room.game.fairSeed : "",
        deck: reveal ? room.game.revealedDeck : []
      },
      music: room.music
    },
    version: APP_VERSION,
    seats: room.seats.map((player, seat) => player ? {
      seat,
      userId: player.userId,
      username: player.username,
      chips: player.chips,
      bet: player.bet || 0,
      folded: Boolean(player.folded),
      allIn: Boolean(player.allIn),
      inHand: Boolean(player.inHand),
      ready: Boolean(player.ready),
      avatar: player.avatar || "",
      connected: isUserConnected(player.userId),
      pendingAction: player.userId === viewerId ? player.pendingAction || null : null,
      hole: reveal || player.userId === viewerId ? player.hole || [] : (player.hole || []).map(() => "??"),
      result: player.result || ""
    } : null),
    messages: room.messages.slice(-30)
  };
}

function isUserConnected(userId) {
  for (const client of clients) {
    if (client.user.id === userId && !client.closed) return true;
  }
  return false;
}

function broadcastLobby() {
  const payload = publicLobbyPayload();
  for (const client of clients) {
    sendJson(client, payload);
  }
}

function broadcastRoom(room) {
  for (const client of clients) {
    if (client.roomId === room.id) {
      sendJson(client, { type: "roomState", ...roomStateFor(room, client.user.id) });
    }
  }
  flushChipAnimations(room);
  broadcastLobby();
}

function broadcastInteraction(room, interaction) {
  for (const client of clients) {
    if (client.roomId === room.id) {
      sendJson(client, { type: "interaction", interaction });
    }
  }
}

function addChipAnimation(room, seat, amount, reason = "") {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(seat)) return;
  room.chipAnimations.push({
    kind: "chipsToPot",
    fromSeat: seat,
    amount,
    reason,
    handNumber: room.game.handNumber,
    at: Date.now()
  });
}

function flushChipAnimations(room) {
  if (!room.chipAnimations.length) return;
  const animations = room.chipAnimations.splice(0);
  for (const animation of animations) {
    broadcastInteraction(room, animation);
  }
}

function randomDealerBlessing() {
  return DEALER_BLESSINGS[Math.floor(Math.random() * DEALER_BLESSINGS.length)];
}

function enforceCooldown(room, bucket, userId, durationMs) {
  const cooldowns = room.cooldowns?.[bucket];
  if (!cooldowns) return;
  const now = Date.now();
  const availableAt = cooldowns.get(userId) || 0;
  if (availableAt > now) {
    const seconds = Math.ceil((availableAt - now) / 1000);
    throw new Error(`操作太快，请 ${seconds} 秒后再试`);
  }
  cooldowns.set(userId, now + durationMs);
}

function handleWsMessage(client, message) {
  const payload = JSON.parse(message);
  if (payload.type === "joinRoom") {
    const room = rooms.get(String(payload.roomId || "").toUpperCase());
    if (!room) throw new Error("房间不存在");
    client.roomId = room.id;
    sendJson(client, { type: "roomState", ...roomStateFor(room, client.user.id) });
    broadcastRoom(room);
    return;
  }

  if (payload.type === "leaveRoom") {
    const previousRoom = rooms.get(client.roomId);
    if (previousRoom && isHandInProgress(previousRoom) && seatedPlayer(previousRoom, client.user.id)) {
      throw new Error("手牌进行中不能退出房间");
    }
    client.roomId = null;
    if (previousRoom) broadcastRoom(previousRoom);
    sendJson(client, publicLobbyPayload());
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room) throw new Error("请先进入房间");

  if (payload.type === "sit") {
    const index = Number(payload.seat);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_SEATS) {
      throw new Error("座位不存在");
    }
    const currentIndex = room.seats.findIndex((seat) => seat && seat.userId === client.user.id);
    if (currentIndex === index) {
      throw new Error("你已经坐在这个座位");
    }
    if (room.seats[index]) {
      throw new Error("这个座位有人了");
    }
    if (currentIndex >= 0) {
      if (isHandInProgress(room)) throw new Error("手牌进行中不能换座位");
      const player = room.seats[currentIndex];
      player.ready = false;
      player.pendingAction = null;
      player.result = "";
      room.seats[currentIndex] = null;
      room.seats[index] = player;
      room.game.lastAction = `${client.user.username} 换到座位 ${index + 1}`;
      broadcastRoom(room);
      return;
    }
    room.seats[index] = {
      userId: client.user.id,
      username: client.user.username,
      chips: room.settings.startingChips,
      avatar: randomAvatar(),
      bet: 0,
      hole: [],
      folded: false,
      allIn: false,
      inHand: false,
      ready: false,
      pendingAction: null,
      result: ""
    };
    room.game.lastAction = `${client.user.username} 入座`;
    broadcastRoom(room);
  } else if (payload.type === "stand") {
    const index = room.seats.findIndex((seat) => seat && seat.userId === client.user.id);
    if (index >= 0 && !isHandInProgress(room)) {
      room.seats[index] = null;
      room.game.lastAction = `${client.user.username} 离座`;
      broadcastRoom(room);
    } else if (index < 0) {
      throw new Error("你还没有入座");
    } else {
      throw new Error("手牌进行中不能离座");
    }
  } else if (payload.type === "ready") {
    const player = seatedPlayer(room, client.user.id);
    if (!player) throw new Error("你还没有入座");
    if (isHandInProgress(room)) throw new Error("手牌进行中不能修改准备状态");
    player.ready = true;
    player.result = "";
    room.game.lastAction = `${client.user.username} 已准备`;
    broadcastRoom(room);
  } else if (payload.type === "unready") {
    const player = seatedPlayer(room, client.user.id);
    if (!player) throw new Error("你还没有入座");
    if (isHandInProgress(room)) throw new Error("手牌进行中不能修改准备状态");
    player.ready = false;
    room.game.lastAction = `${client.user.username} 取消准备`;
    broadcastRoom(room);
  } else if (payload.type === "switchAvatar") {
    const player = seatedPlayer(room, client.user.id);
    if (!player) throw new Error("你还没有入座");
    if (isHandInProgress(room)) throw new Error("手牌进行中不能更换头像");
    const requested = String(payload.avatar || "");
    player.avatar = requested && isAllowedAvatar(requested) ? requested : randomAvatar(player.avatar);
    room.game.lastAction = `${client.user.username} 更换了头像`;
    broadcastRoom(room);
  } else if (payload.type === "emote") {
    const fromSeat = room.seats.findIndex((seat) => seat && seat.userId === client.user.id);
    if (fromSeat === -1) throw new Error("你还没有入座");
    const emoteKey = String(payload.emote || "");
    const baseText = EMOTES.get(emoteKey);
    if (!baseText) throw new Error("未知互动");
    const rawTargetSeat = payload.targetSeat;
    let targetSeat = rawTargetSeat === null || rawTargetSeat === undefined || rawTargetSeat === "" ? null : Number(rawTargetSeat);
    if (targetSeat !== null && !Number.isInteger(targetSeat)) throw new Error("互动目标不存在");
    if (targetSeat === fromSeat) targetSeat = null;
    if (targetSeat !== null && (!room.seats[targetSeat] || targetSeat < 0 || targetSeat >= MAX_SEATS)) {
      throw new Error("互动目标不存在");
    }
    const target = targetSeat !== null ? room.seats[targetSeat] : null;
    enforceCooldown(room, "emote", client.user.id, EMOTE_COOLDOWN_MS);
    const text = target ? `你${baseText}` : baseText;
    broadcastInteraction(room, {
      kind: "emote",
      emote: emoteKey,
      text,
      baseText,
      fromSeat,
      fromUsername: client.user.username,
      targetSeat,
      targetUsername: target?.username || "",
      at: Date.now()
    });
  } else if (payload.type === "dealerTip") {
    const player = seatedPlayer(room, client.user.id);
    const fromSeat = room.seats.findIndex((seat) => seat && seat.userId === client.user.id);
    if (!player) throw new Error("你还没有入座");
    if (isHandInProgress(room)) throw new Error("手牌进行中不能打赏，以免影响下注筹码");
    enforceCooldown(room, "dealerTip", client.user.id, DEALER_TIP_COOLDOWN_MS);
    const amount = clampInt(payload.amount, 5, 1, player.chips);
    if (amount > player.chips) throw new Error("筹码不足");
    player.chips -= amount;
    room.dealerTips = (room.dealerTips || 0) + amount;
    room.game.lastAction = `${client.user.username} 打赏荷官 ${amount}`;
    broadcastRoom(room);
    broadcastInteraction(room, {
      kind: "dealerTip",
      text: `打赏荷官 ${amount}`,
      dealerReply: randomDealerBlessing(),
      quiet: !["waiting", "showdown"].includes(room.game.status),
      fromSeat,
      fromUsername: client.user.username,
      targetSeat: null,
      amount,
      at: Date.now()
    });
  } else if (payload.type === "startHand") {
    if (isHandInProgress(room)) {
      throw new Error("手牌进行中");
    }
    startHand(room);
    broadcastRoom(room);
  } else if (payload.type === "action") {
    handlePlayerAction(room, client.user, payload);
    broadcastRoom(room);
  } else if (payload.type === "presetAction") {
    setPresetAction(room, client.user, payload);
    broadcastRoom(room);
  } else if (payload.type === "chat") {
    const text = String(payload.text || "").trim().slice(0, 160);
    if (text) {
      const fromSeat = room.seats.findIndex((seat) => seat && seat.userId === client.user.id);
      enforceCooldown(room, "chat", client.user.id, CHAT_COOLDOWN_MS);
      room.messages.push({ username: client.user.username, text, at: Date.now() });
      broadcastRoom(room);
      if (fromSeat !== -1) {
        broadcastInteraction(room, {
          kind: "chatBubble",
          text,
          fromSeat,
          fromUsername: client.user.username,
          targetSeat: fromSeat,
          at: Date.now()
        });
      }
    }
  } else {
    throw new Error("未知消息类型");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
  } else {
    serveStatic(req, res, url);
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const token = url.searchParams.get("token") || "";
  const userId = sessions.get(token);
  const user = getUserById(userId);
  if (url.pathname !== "/ws" || !user?.verified_at) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));

  const client = { socket, user: publicUser(user), roomId: null, buffer: Buffer.alloc(0), closed: false };
  clients.add(client);
  sendJson(client, { ...publicLobbyPayload(), type: "hello", user: client.user });

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    let frame;
    while ((frame = readFrame(client)) !== null) {
      if (frame.opcode === 8) {
        socket.end();
        break;
      }
      if (frame.opcode === 1) {
        try {
          handleWsMessage(client, frame.payload.toString("utf8"));
        } catch (error) {
          sendJson(client, { type: "error", error: error.message || "操作失败" });
        }
      }
    }
  });
  socket.on("close", () => closeClient(client));
  socket.on("error", () => closeClient(client));
});

function closeClient(client) {
  if (client.closed) return;
  client.closed = true;
  clients.delete(client);
  const room = rooms.get(client.roomId);
  if (room) {
    processAutomaticTurns(room);
    scheduleTurnTimer(room);
    broadcastRoom(room);
  }
}

function readFrame(client) {
  const buffer = client.buffer;
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    length = high * 2 ** 32 + low;
    offset += 8;
  }
  const maskOffset = masked ? 4 : 0;
  if (buffer.length < offset + maskOffset + length) return null;
  const mask = masked ? buffer.slice(offset, offset + 4) : null;
  offset += maskOffset;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (masked) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }
  client.buffer = buffer.slice(offset + length);
  return { opcode, payload };
}

function sendJson(client, payload) {
  sendText(client, JSON.stringify(payload));
}

function sendText(client, text) {
  if (client.closed || client.socket.destroyed) return;
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  client.socket.write(Buffer.concat([header, payload]));
}

server.listen(PORT, HOST, () => {
  console.log(`Texas Hold'em server running at http://${HOST}:${PORT}`);
});
