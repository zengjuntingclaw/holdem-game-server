"use strict";

// 启动真实服务器，验证：1) 新表 DDL 在启动时成功创建（不崩溃）；
// 2) 新增的 /api/history/rooms/:id/settlements 路由可正常响应（不存在房间返回 404，而非 500）。
const { spawn } = require("node:child_process");
const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["--experimental-sqlite", "server.js"], {
  cwd: __dirname + "/..",
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

async function waitForServer(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/version`);
      if (r.ok) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const up = await waitForServer(8000);
  if (!up) {
    console.error("FAIL - 服务器未能在 8s 内启动。日志：\n" + serverLog);
    child.kill("SIGKILL");
    process.exit(1);
  }
  console.log("ok - 服务器启动成功（新表 DDL 已执行）");

  const version = await (await fetch(`${BASE}/api/version`)).json();
  console.log("ok - /api/version 返回版本 " + version.version);

  // 本地模式（无 SMTP）会直接返回验证码 devCode
  const email = `boot-smoke-${Date.now()}@example.com`;
  const requested = await (await fetch(`${BASE}/api/email-code/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email })
  })).json();
  if (!requested.devCode) {
    console.error("FAIL - 未返回 devCode（本地验证码模式异常）", requested);
    child.kill("SIGKILL");
    process.exit(1);
  }
  const verified = await (await fetch(`${BASE}/api/email-code/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code: requested.devCode, username: "冒烟测试" })
  })).json();
  if (!verified.token) {
    console.error("FAIL - 登录失败", verified);
    child.kill("SIGKILL");
    process.exit(1);
  }
  const token = verified.token;
  console.log("ok - 已登录测试账号");

  const missing = await fetch(`${BASE}/api/history/rooms/ZZZZ/settlements`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await missing.json().catch(() => ({}));
  if (missing.status === 404) {
    console.log("ok - 不存在房间返回 404：", body.error);
  } else {
    console.error(`FAIL - 期望 404，实际 ${missing.status}`, body);
    child.kill("SIGKILL");
    process.exit(1);
  }

  // 错误路径：缺少房间号（带登录态）
  const bad = await fetch(`${BASE}/api/history/rooms//settlements`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (bad.status === 400) {
    console.log("ok - 缺少房间号返回 400");
  } else {
    console.error(`FAIL - 期望 400，实际 ${bad.status}`);
    child.kill("SIGKILL");
    process.exit(1);
  }

  console.log("PASS - 服务器启动与新接口路由校验通过");
  child.kill("SIGKILL");
  process.exit(0);
}

child.on("exit", (code) => {
  if (code && code !== 0 && code !== null) {
    console.error("server exited with", code);
    process.exit(1);
  }
});

main().catch((e) => {
  console.error("FAIL -", e);
  child.kill("SIGKILL");
  process.exit(1);
});
