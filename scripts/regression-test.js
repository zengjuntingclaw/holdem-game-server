"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3001";
const WS_URL = BASE_URL.replace(/^http/, "ws") + "/ws";
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
const EXPECTED_ROOM_MUSIC_PATH = fs.existsSync(path.join(__dirname, "..", "public", "music", "room-loop.mp3"))
  ? "/music/room-loop.mp3"
  : "/music/room-loop.ogg";
const activeSockets = new Set();

function log(step) {
  console.log(`ok - ${step}`);
}

async function api(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `${method} ${path} failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function expectApiError(path, status, options = {}) {
  try {
    await api(path, options);
  } catch (error) {
    assert.equal(error.status, status, `${path} should return HTTP ${status}`);
    return error.data;
  }
  assert.fail(`${path} should have failed with HTTP ${status}`);
}

async function createVerifiedUser(index) {
  const email = `regression-${RUN_ID}-${index}@example.test`;
  const password = `pass-${RUN_ID}`;
  const username = `测${index}${RUN_ID.slice(-3)}`;
  const registered = await api("/api/register", {
    method: "POST",
    body: { email, username, password }
  });
  assert.equal(registered.requiresVerification, true);
  assert.match(registered.devCode || "", /^\d{6}$/);
  await expectApiError("/api/login", 403, {
    method: "POST",
    body: { email, password }
  });
  const verified = await api("/api/email-code/verify", {
    method: "POST",
    body: { email, code: registered.devCode }
  });
  assert.ok(verified.token);
  const loggedIn = await api("/api/login", {
    method: "POST",
    body: { email, password }
  });
  assert.ok(loggedIn.token);
  return { ...loggedIn.user, email, password, token: loggedIn.token };
}

function connectClient(user) {
  const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(user.token)}`);
  activeSockets.add(socket);
  const messages = [];
  const waiters = [];
  let opened = false;

  socket.addEventListener("open", () => {
    opened = true;
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    Object.defineProperty(message, "_seq", { value: messages.length });
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(message)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  socket.addEventListener("error", (event) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(event.message || "WebSocket error"));
    }
  });

  function waitFor(predicate, label, timeoutMs = 5000) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async function waitOpen() {
    if (opened) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket open")), 5000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
  }

  function send(payload) {
    socket.send(JSON.stringify(payload));
  }

  function latestRoomState() {
    return messages.filter((message) => message.type === "roomState").at(-1);
  }

  return { user, socket, messages, waitFor, waitOpen, send, latestRoomState };
}

async function waitForRoom(client, predicate, label, timeoutMs = 5000) {
  return client.waitFor((message) => message.type === "roomState" && predicate(message), label, timeoutMs);
}

async function waitForNewRoom(client, afterSeq, predicate, label, timeoutMs = 5000) {
  return client.waitFor((message) => message.type === "roomState" && message._seq >= afterSeq && predicate(message), label, timeoutMs);
}

async function waitForError(client, contains, timeoutMs = 3000) {
  return client.waitFor((message) => message.type === "error" && message.error.includes(contains), `error: ${contains}`, timeoutMs);
}

function assertHoleVisibility(state, viewerUserId, expectedInHandSeats) {
  for (const seat of state.seats.filter(Boolean)) {
    if (!seat.inHand) continue;
    assert.equal(seat.hole.length, 2, `seat ${seat.seat} should expose two hole-card slots`);
    if (seat.userId === viewerUserId) {
      assert.ok(seat.hole.every((card) => /^[2-9TJQKA][shdc]$/.test(card)), "viewer should see own real hole cards");
    } else if (expectedInHandSeats.includes(seat.seat)) {
      assert.deepEqual(seat.hole, ["??", "??"], "viewer must not see other players' hole cards before showdown");
    }
  }
}

async function driveHandToShowdown(clientsBySeat) {
  for (let step = 0; step < 40; step += 1) {
    const state = clientsBySeat[0].latestRoomState();
    assert.ok(state, "room state should exist");
    if (state.game.status === "showdown") return state;
    const actingSeat = state.game.actingSeat;
    assert.ok(Number.isInteger(actingSeat), `acting seat should be set during ${state.game.status}`);
    const client = clientsBySeat[actingSeat];
    assert.ok(client, `client for acting seat ${actingSeat} should exist`);
    if (client.socket.readyState !== WebSocket.OPEN) {
      const afterSeq = clientsBySeat[0].messages.length;
      await waitForNewRoom(clientsBySeat[0], afterSeq, (message) => {
        if (message.game.status === "showdown") return true;
        return message.game.actingSeat !== actingSeat;
      }, `auto advance disconnected seat ${actingSeat}`, 5000);
      continue;
    }
    const player = state.seats[actingSeat];
    const callAmount = Math.max(0, state.game.currentBet - player.bet);
    const afterSeq = clientsBySeat[0].messages.length;
    const beforeStatus = state.game.status;
    const beforeBoard = state.game.board.length;
    const beforeAction = state.game.lastAction;
    client.send({ type: "action", action: callAmount > 0 ? "call" : "check" });
    await waitForNewRoom(clientsBySeat[0], afterSeq, (message) => {
      if (message.game.status === "showdown") return true;
      return message.game.actingSeat !== actingSeat
        || message.game.status !== beforeStatus
        || message.game.board.length !== beforeBoard
        || message.game.lastAction !== beforeAction;
    }, `advance after seat ${actingSeat}`, 5000);
  }
  assert.fail("hand did not finish within expected action count");
}

async function main() {
  const page = await fetch(`${BASE_URL}/`);
  assert.equal(page.status, 200);
  const version = await api("/api/version");
  assert.match(version.version, /^\d+\.\d+\.\d+$/);
  log("首页可访问");

  const users = [];
  for (let i = 0; i < 4; i += 1) {
    users.push(await createVerifiedUser(i));
  }
  log("注册/邮箱验证码/验证后登录流程正常，未验证登录会被拒绝");

  const avatarResponse = await api("/api/avatars", { token: users[0].token });
  assert.ok(Array.isArray(avatarResponse.avatars));
  assert.ok(avatarResponse.avatars.length >= 1);
  const avatarImage = await fetch(`${BASE_URL}${avatarResponse.avatars[0].url}`);
  assert.equal(avatarImage.status, 200);
  assert.match(avatarImage.headers.get("content-type") || "", /^image\//);
  log("默认头像列表和静态头像文件可访问");

  const raiseRoomResponse = await api("/api/rooms", {
    token: users[0].token,
    method: "POST",
    body: { name: `加注测试 ${RUN_ID}`, smallBlind: 5, bigBlind: 10, startingChips: 1000 }
  });
  const raiseClients = users.slice(0, 3).map(connectClient);
  await Promise.all(raiseClients.map((client) => client.waitOpen()));
  for (const client of raiseClients) client.send({ type: "joinRoom", roomId: raiseRoomResponse.room.id });
  await Promise.all(raiseClients.map((client) => waitForRoom(client, (message) => message.room.id === raiseRoomResponse.room.id, "join raise room")));
  for (let seat = 0; seat < 3; seat += 1) {
    raiseClients[seat].send({ type: "sit", seat });
    await waitForRoom(raiseClients[seat], (message) => Boolean(message.seats[seat]), `raise sit ${seat}`);
    raiseClients[seat].send({ type: "ready" });
  }
  await waitForRoom(raiseClients[0], (message) => message.room.canStart, "raise room ready");
  raiseClients[0].send({ type: "startHand" });
  await waitForRoom(raiseClients[0], (message) => message.game.status === "preflop" && message.game.actingSeat === 0, "raise room preflop");
  raiseClients[0].send({ type: "action", action: "raise", amount: 20 });
  const raisedState = await waitForRoom(raiseClients[0], (message) => message.game.currentBet === 20 && message.seats[0]?.bet === 20, "legal raise to 20");
  assert.equal(raisedState.game.minRaise, 10);
  assert.equal(raisedState.game.pot, 35);
  raiseClients.forEach((client) => client.socket.close());
  log("合法加注金额可成功提交并广播");

  const roomResponse = await api("/api/rooms", {
    token: users[0].token,
    method: "POST",
    body: { name: `回归测试 ${RUN_ID}`, smallBlind: 5, bigBlind: 10, startingChips: 1000 }
  });
  const roomId = roomResponse.room.id;
  assert.equal(roomResponse.room.smallBlind, 5);
  assert.equal(roomResponse.room.bigBlind, 10);
  assert.equal(roomResponse.room.startingChips, 1000);
  log("房间创建和盲注/初始筹码配置正常");

  const clients = users.map(connectClient);
  await Promise.all(clients.map((client) => client.waitOpen()));
  for (const client of clients) client.send({ type: "joinRoom", roomId });
  await Promise.all(clients.map((client) => waitForRoom(client, (message) => message.room.id === roomId, "join room")));
  const spectatorOnly = clients[3].latestRoomState();
  assert.ok(spectatorOnly);
  assert.equal(spectatorOnly.seats.filter(Boolean).length, 0);
  log("WebSocket 进房同步正常，未入座也可观战");

  for (let seat = 0; seat < 3; seat += 1) {
    clients[seat].send({ type: "sit", seat });
    await waitForRoom(clients[seat], (message) => Boolean(message.seats[seat]), `sit ${seat}`);
  }
  clients[0].send({ type: "sit", seat: 4 });
  const movedOut = await waitForRoom(clients[0], (message) => !message.seats[0] && message.seats[4]?.userId === users[0].id, "move seat 0 to 4");
  assert.equal(movedOut.seats[4].chips, 1000);
  clients[0].send({ type: "sit", seat: 0 });
  await waitForRoom(clients[0], (message) => message.seats[0]?.userId === users[0].id && !message.seats[4], "move seat 4 to 0");
  clients[1].send({ type: "stand" });
  await waitForRoom(clients[0], (message) => !message.seats[1], "stand from seat 1");
  clients[1].send({ type: "sit", seat: 1 });
  await waitForRoom(clients[0], (message) => message.seats[1]?.userId === users[1].id, "sit back seat 1");
  log("非进行中可换座、起身，空位释放后可重新坐下");

  for (let seat = 0; seat < 3; seat += 1) {
    clients[seat].send({ type: "ready" });
  }
  await waitForRoom(clients[0], (message) => message.room.canStart, "all ready");
  log("入座、准备、全部准备后可开局正常");

  clients[0].send({ type: "startHand" });
  const started = await waitForRoom(clients[0], (message) => message.game.status === "preflop", "preflop");
  assert.equal(started.version, version.version);
  assert.equal(started.game.music.mode, "single");
  assert.equal(started.game.music.tracks.length, 1);
  assert.ok(started.game.music.tracks[0].url.startsWith(EXPECTED_ROOM_MUSIC_PATH));
  assert.equal(started.game.pot, 15);
  assert.equal(started.game.currentBet, 10);
  assert.equal(started.game.minRaise, 10);
  assert.equal(started.game.button, 0);
  assert.equal(started.seats[1].bet, 5);
  assert.equal(started.seats[2].bet, 10);
  assert.equal(started.game.timeLimitMs, 60000);
  assert.ok(started.game.turnDeadlineAt > started.game.serverNow);
  await Promise.all([
    clients[0].waitFor((message) => message.type === "interaction" && message.interaction.kind === "chipsToPot" && message.interaction.fromSeat === 1, "small blind animation"),
    clients[0].waitFor((message) => message.type === "interaction" && message.interaction.kind === "chipsToPot" && message.interaction.fromSeat === 2, "big blind animation")
  ]);
  const blindAnimations = clients[0].messages.filter((message) => message.type === "interaction" && message.interaction.kind === "chipsToPot");
  assert.ok(blindAnimations.some((message) => message.interaction.fromSeat === 1 && message.interaction.amount === 5));
  assert.ok(blindAnimations.some((message) => message.interaction.fromSeat === 2 && message.interaction.amount === 10));
  log("开局、庄位/大小盲、60 秒计时和盲注筹码动画广播正常");

  for (let seat = 0; seat < 3; seat += 1) {
    const state = await waitForRoom(clients[seat], (message) => message.game.status === "preflop", `visibility ${seat}`);
    assertHoleVisibility(state, users[seat].id, [0, 1, 2]);
    assert.equal(state.game.fairness.seed, "");
    assert.deepEqual(state.game.fairness.deck, []);
    assert.match(state.game.fairness.deckCommit, /^[a-f0-9]{64}$/);
  }
  const spectatorState = await waitForRoom(clients[3], (message) => message.game.status === "preflop", "spectator visibility");
  for (const seat of spectatorState.seats.filter((item) => item?.inHand)) {
    assert.deepEqual(seat.hole, ["??", "??"], "spectator must not see any active hole cards");
  }
  log("未摊牌前私牌隔离和公平哈希隐藏正常");

  clients[1].send({ type: "presetAction", action: "fold" });
  const presetState = await waitForRoom(clients[1], (message) => message.seats[1]?.pendingAction?.action === "fold", "preset fold");
  assert.equal(presetState.seats[1].pendingAction.action, "fold");
  log("未轮到自己时可以提前预设弃牌");

  clients[0].send({ type: "stand" });
  await waitForError(clients[0], "手牌进行中不能离座");
  clients[0].send({ type: "switchAvatar" });
  await waitForError(clients[0], "手牌进行中不能更换头像");
  log("手牌进行中离座和换头像会被拒绝");

  clients[3].send({ type: "sit", seat: 3 });
  const lateJoin = await waitForRoom(clients[3], (message) => Boolean(message.seats[3]), "late sit");
  assert.equal(lateJoin.seats[3].inHand, false);
  assert.equal(lateJoin.seats[3].hole.length, 0);
  log("牌局中有空位可入座，但新玩家不会加入当前手牌");

  clients[0].send({ type: "emote", emote: "wellPlayed", targetSeat: 0 });
  const selfEmote = await clients[1].waitFor((message) => message.type === "interaction" && message.interaction.kind === "emote", "self emote");
  assert.equal(selfEmote.interaction.text, "打得不错");
  assert.equal(selfEmote.interaction.targetSeat, null);
  log("全桌互动不会带“你”，指向自己会按全桌处理");

  await new Promise((resolve) => setTimeout(resolve, 2600));
  clients[0].send({ type: "emote", emote: "hello", targetSeat: 1 });
  const targetEmote = await clients[1].waitFor((message) => message.type === "interaction" && message.interaction.kind === "emote" && message.interaction.emote === "hello", "target emote");
  assert.equal(targetEmote.interaction.text, "你你好");
  assert.equal(targetEmote.interaction.targetSeat, 1);
  log("点名互动会广播目标和“你 + 台词”文案");

  clients[2].socket.close();
  const offlineState = await waitForRoom(clients[0], (message) => message.seats[2] && !message.seats[2].connected, "seat 2 offline");
  assert.equal(offlineState.seats[2].connected, false);
  log("玩家断线后座位会显示离线");

  const showdown = await driveHandToShowdown({ 0: clients[0], 1: clients[1], 2: clients[2] });
  assert.equal(showdown.game.status, "showdown");
  assert.equal(showdown.game.pot, 0);
  assert.equal(showdown.game.board.length, 5);
  assert.ok(showdown.game.winners.length >= 1);
  assert.match(showdown.game.fairness.seed, /^[a-f0-9]{64}$/);
  assert.equal(showdown.game.fairness.deck.length, 52);
  const totalChips = showdown.seats.filter(Boolean).reduce((sum, seat) => sum + seat.chips + seat.bet, 0) + showdown.game.pot + showdown.game.dealerTips;
  assert.equal(totalChips, 4000);
  for (const seat of showdown.seats.filter((item) => item?.inHand)) {
    assert.ok(seat.hole.every((card) => /^[2-9TJQKA][shdc]$/.test(card)), "all hole cards should reveal at showdown");
  }
  log("下注轮转、发公共牌、摊牌、奖池归零、筹码守恒和公平证明公开正常");

  const autoTexts = clients[0].messages
    .filter((message) => message.type === "roomState")
    .map((message) => message.game.lastAction)
    .filter((text) => text.includes("离线自动") || text.includes("按预设"));
  assert.equal(showdown.seats[1].folded, true);
  assert.ok(autoTexts.some((text) => text.includes("离线自动")));
  log("预设弃牌和离线自动不加注都已执行");

  clients[1].socket.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const reconnect = connectClient(users[1]);
  await reconnect.waitOpen();
  reconnect.send({ type: "joinRoom", roomId });
  const reconnected = await waitForRoom(reconnect, (message) => message.room.id === roomId && message.game.status === "showdown", "reconnect");
  assert.ok(reconnected.seats[1].connected);
  log("断线后使用同账号重连可恢复房间状态");

  clients.forEach((client) => client.socket.close());
  reconnect.socket.close();
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => {
  for (const socket of activeSockets) {
    try {
      socket.close();
    } catch {
      // Ignore cleanup failures.
    }
  }
});
