"use strict";

const $ = (selector) => document.querySelector(selector);
const CLIENT_VERSION = "0.1.70";
const DEFAULT_WAGER_AMOUNT = 20;
const EMOTES = [
  { key: "wellPlayed", text: "打得不错" },
  { key: "amazing", text: "真棒" },
  { key: "hello", text: "你好" },
  { key: "oops", text: "抱歉" },
  { key: "wow", text: "哇哦" },
  { key: "bluff", text: "这是诈唬吧" }
];
const CHIP_SOUND_URLS = [
  "/audio/chip-lay-1.ogg",
  "/audio/chip-lay-2.ogg",
  "/audio/chips-collide-1.ogg",
  "/audio/chips-stack-1.ogg"
];
const HAND_RULES = [
  { name: "同花顺", power: 8, example: ["A♠", "K♠", "Q♠", "J♠", "10♠"], desc: "五张连续且同花的牌，皇家同花顺是最高同花顺。" },
  { name: "四条", power: 7, example: ["9♠", "9♥", "9♦", "9♣", "A♠"], desc: "四张相同点数，加一张踢脚牌。" },
  { name: "葫芦", power: 6, example: ["K♠", "K♥", "K♦", "3♣", "3♠"], desc: "三条加一对，先比三条点数。" },
  { name: "同花", power: 5, example: ["A♥", "J♥", "8♥", "5♥", "2♥"], desc: "五张同花色，不要求连续。" },
  { name: "顺子", power: 4, example: ["9♠", "8♥", "7♦", "6♣", "5♠"], desc: "五张连续点数，A 可作最大或最小。" },
  { name: "三条", power: 3, example: ["Q♠", "Q♥", "Q♦", "A♣", "7♠"], desc: "三张相同点数，加两张踢脚牌。" },
  { name: "两对", power: 2, example: ["J♠", "J♥", "4♦", "4♣", "A♠"], desc: "两组对子，先比大对子。" },
  { name: "一对", power: 1, example: ["10♠", "10♥", "A♦", "8♣", "3♠"], desc: "一组对子，剩余三张为踢脚牌。" },
  { name: "高牌", power: 0, example: ["A♠", "Q♥", "9♦", "6♣", "2♠"], desc: "没有组成以上牌型时，比最大单牌。" }
];
const HAND_POWER = Object.fromEntries(HAND_RULES.map((rule) => [rule.name, rule.power]));

const state = {
  token: localStorage.getItem("pokerToken") || "",
  user: null,
  ws: null,
  rooms: [],
  roomState: null,
  avatars: [],
  dealers: [],
  dealerPage: 0,
  emoteMenuTargetSeat: null,
  serverOffsetMs: 0,
  countdownTimer: null,
  animatedSettlementKey: "",
  fairnessChecks: new Map(),
  pendingMessages: [],
  audioContext: null,
  chipBuffers: [],
  bgmAudio: null,
  bgmKey: "",
  bgmScope: "",
  bgmMusic: null,
  bgmTimer: null,
  bgmMuted: localStorage.getItem("pokerBgmMuted") === "1",
  musicDurations: new Map(),
  feedbackChallengeId: "",
  countdownAlertKey: "",
  version: CLIENT_VERSION,
  updatedAt: "",
  lastRoomId: localStorage.getItem("pokerLastRoomId") || "",
  lastWagerAmount: Number(localStorage.getItem("pokerLastWagerAmount") || DEFAULT_WAGER_AMOUNT),
  preferredOrientation: localStorage.getItem("pokerPreferredOrientation") || "portrait"
};

const authView = $("#authView");
const appView = $("#appView");
const lobbyView = $("#lobbyView");
const roomView = $("#roomView");
const authError = $("#authError");

$("#codeLoginBtn").addEventListener("click", codeLogin);
$("#authForm").addEventListener("submit", (event) => {
  event.preventDefault();
  codeLogin();
});
$("#logoutBtn").addEventListener("click", logout);
$("#saveProfileBtn").addEventListener("click", saveProfile);
$("#createRoomBtn").addEventListener("click", createRoom);
$("#refreshRoomsBtn").addEventListener("click", loadRooms);
$("#roomLookupBtn").addEventListener("click", lookupRoom);
$("#roomLookupInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") lookupRoom();
});
$("#copyRoomIdBtn").addEventListener("click", copyRoomId);
$("#backLobbyBtn").addEventListener("click", attemptBackLobby);
$("#orientationBtn").addEventListener("click", toggleTableOrientation);
$("#startHandBtn").addEventListener("click", () => send({ type: "startHand" }));
$("#readyBtn").addEventListener("click", toggleReady);
$("#standBtn").addEventListener("click", attemptStand);
$("#randomAvatarBtn").addEventListener("click", () => send({ type: "switchAvatar" }));
$("#sendEmoteBtn").addEventListener("click", () => sendEmote());
$("#dealerTipBtn").addEventListener("click", tipDealer);
$("#spectatorsToggle").addEventListener("click", toggleSpectatorsDrawer);
$("#spectatorsClose").addEventListener("click", closeSpectatorsDrawer);
$("#chatToggle").addEventListener("click", toggleChatDrawer);
$("#chatClose").addEventListener("click", closeChatDrawer);
$("#rulesToggle").addEventListener("click", toggleRulesDrawer);
$("#rulesClose").addEventListener("click", closeRulesDrawer);
$("#feedbackToggle").addEventListener("click", toggleFeedbackDrawer);
$("#feedbackClose").addEventListener("click", closeFeedbackDrawer);
$("#supportToggle").addEventListener("click", toggleSupportDrawer);
$("#supportClose").addEventListener("click", closeSupportDrawer);
$("#feedbackRefreshCaptcha").addEventListener("click", loadFeedbackChallenge);
$("#feedbackForm").addEventListener("submit", submitFeedback);
$("#bgmToggleBtn").addEventListener("click", toggleBgmMuted);
$("#foldBtn").addEventListener("click", () => sendAction("fold"));
$("#checkBtn").addEventListener("click", () => sendAction("check"));
$("#callBtn").addEventListener("click", () => sendAction("call"));
$("#betBtn").addEventListener("click", () => sendAction("bet"));
$("#raiseBtn").addEventListener("click", () => sendAction("raise"));
$("#amountRange").addEventListener("input", syncAmountFromRange);
$("#amountInput").addEventListener("input", syncAmountFromInput);
document.querySelectorAll("[data-wager-preset]").forEach((button) => {
  button.addEventListener("click", () => chooseWagerPreset(button.dataset.wagerPreset));
});
$("#allInBtn").addEventListener("click", chooseAllIn);
$("#chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  send({ type: "chat", text: input.value });
  input.value = "";
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".emoteBubble")) closeEmoteMenu();
  if (!event.target.closest(".dealerTipBubble")) closeDealerTipMenu();
  if (!event.target.closest(".sideDrawer")) closeSideDrawers();
});
document.addEventListener("pointerdown", () => {
  resumeBgm();
}, { passive: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeEmoteMenu();
    closeDealerTipMenu();
  }
});
const narrowScreenQuery = window.matchMedia("(max-width: 860px)");
narrowScreenQuery.addEventListener("change", closeSideDrawers);
window.addEventListener("orientationchange", closeSideDrawers);
$("#dealerSpot").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  openDealerTipMenu();
});
$("#dealerSpot").addEventListener("click", (event) => {
  event.stopPropagation();
  openDealerTipMenu();
});

boot();

function applyTableOrientation() {
  const landscape = state.preferredOrientation === "landscape";
  document.body.classList.toggle("tableLandscape", landscape);
  const button = $("#orientationBtn");
  if (!button) return;
  button.textContent = landscape ? "竖屏牌桌" : "横屏牌桌";
  button.setAttribute("aria-pressed", String(landscape));
  button.title = landscape ? "切换回竖屏布局" : "切换为横屏布局";
}

async function toggleTableOrientation() {
  const next = state.preferredOrientation === "landscape" ? "portrait" : "landscape";
  state.preferredOrientation = next;
  localStorage.setItem("pokerPreferredOrientation", next);
  applyTableOrientation();

  // Orientation locking is only available in a fullscreen mobile browser.
  try {
    if (next === "landscape" && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.();
    }
    if (screen.orientation?.lock) {
      await screen.orientation.lock(next);
    }
  } catch {
    showToast(next === "landscape" ? "已切换横屏布局；请旋转设备以获得最佳体验。" : "已切换竖屏布局。");
  }
}

async function boot() {
  renderRulesSidebar();
  setVersionLabel(CLIENT_VERSION);
  try {
    const data = await api("/api/me");
    if (data.token) {
      state.token = data.token;
      localStorage.setItem("pokerToken", state.token);
    }
    state.user = data.user;
    showApp();
    await loadAvatars();
    await loadDealers();
    connect();
    await loadRooms();
  } catch {
    logout();
  }
}

async function codeLogin() {
  authError.textContent = "";
  const email = $("#email").value.trim();
  const username = $("#username").value.trim();
  const codeInput = $("#verificationCode");
  const code = codeInput.value.trim();
  if (!email) {
    authError.textContent = "请输入邮箱";
    return;
  }
  if (code && !/^\d{6}$/.test(code)) {
    authError.textContent = "验证码需要 6 位数字";
    return;
  }
  try {
    if (!/^\d{6}$/.test(code)) {
      const requested = await api("/api/email-code/request", {
        method: "POST",
        body: JSON.stringify({ email })
      }, false);
      if (requested.devCode) codeInput.value = requested.devCode;
      $("#codeLoginBtn").textContent = "验证码登录";
      authError.textContent = requested.devCode ? `本机测试验证码：${requested.devCode}` : (requested.message || "验证码已发送");
      codeInput.focus();
      return;
    }
    const data = await api("/api/email-code/verify", {
      method: "POST",
      body: JSON.stringify({ email, username, code })
    }, false);
    await enterApp(data);
  } catch (error) {
    authError.textContent = error.message;
  }
}

async function enterApp(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem("pokerToken", state.token);
  showApp();
  await loadAvatars();
  await loadDealers();
  connect();
  await loadRooms();
}

async function saveProfile() {
  const status = $("#profileStatus");
  const button = $("#saveProfileBtn");
  status.textContent = "";
  button.disabled = true;
  try {
    const data = await api("/api/me", {
      method: "PATCH",
      body: JSON.stringify({ username: $("#profileUsername").value.trim() })
    });
    state.user = data.user;
    renderProfile();
    status.textContent = "已保存";
    showToast("昵称已更新");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function api(path, options = {}, authed = true) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (authed && state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function connect() {
  if (state.ws) state.ws.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws.addEventListener("open", () => {
    setConn("在线");
    if (state.roomState?.room?.id) {
      send({ type: "joinRoom", roomId: state.roomState.room.id });
    }
    const pending = state.pendingMessages.splice(0);
    pending.forEach((payload) => send(payload));
  });
  state.ws.addEventListener("close", () => {
    setConn("离线，正在重连");
    setTimeout(() => state.user && connect(), 1200);
  });
  state.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "hello" || message.type === "lobby") {
      if (message.serverNow) {
        state.serverOffsetMs = Date.now() - message.serverNow;
      }
      state.rooms = message.rooms || [];
      if (message.version) setVersionLabel(message.version, message.updatedAt);
      renderRooms();
      if (!state.roomState && message.music) syncBgm(message.music, "lobby");
    } else if (message.type === "roomState") {
      if (message.game?.serverNow) {
        state.serverOffsetMs = Date.now() - message.game.serverNow;
      }
      state.roomState = message;
      state.lastRoomId = message.room.id;
      localStorage.setItem("pokerLastRoomId", state.lastRoomId);
      if (message.version) setVersionLabel(message.version, message.updatedAt);
      if (message.game?.music) syncBgm(message.game.music, `room:${message.room.id}`);
      renderRoom();
    } else if (message.type === "interaction") {
      renderInteraction(message.interaction);
    } else if (message.type === "error") {
      if (message.error.includes("房间不存在")) {
        localStorage.removeItem("pokerLastRoomId");
        state.lastRoomId = "";
        renderResumeRoom();
      }
      showToast(message.error, "warn");
    }
  });
}

function send(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    state.pendingMessages.push(payload);
    setConn("连接中");
    return;
  }
  state.ws.send(JSON.stringify(payload));
}

function sendAction(action) {
  send({ type: "action", action, amount: normalizedWagerAmount() });
}

function sendPresetAction(action) {
  send({ type: "presetAction", action, amount: normalizedWagerAmount() });
}

function normalizedWagerAmount() {
  const range = $("#amountRange");
  const min = Number(range.min || 1);
  const max = Number(range.max || min);
  const amount = clampNumber(Number($("#amountInput").value || state.lastWagerAmount || min), min, max);
  setBetAmount(amount);
  return amount;
}

function syncAmountFromRange() {
  const range = $("#amountRange");
  $("#amountInput").value = range.value;
  updateRangeFill(range);
  rememberWagerAmount(Number(range.value));
}

function syncAmountFromInput() {
  const input = $("#amountInput");
  const range = $("#amountRange");
  const min = Number(range.min || 1);
  const max = Number(range.max || min);
  const value = clampNumber(Number(input.value || min), min, max);
  input.value = value;
  range.value = value;
  updateRangeFill(range);
  rememberWagerAmount(value);
}

function chooseWagerPreset(preset) {
  const snapshot = state.roomState;
  if (!snapshot) return;
  const mySeat = snapshot.seats.find((seat) => seat && seat.userId === state.user.id);
  if (!mySeat) return;
  const target = presetWagerTotal(snapshot, mySeat, preset);
  setBetAmount(target);
}

function chooseAllIn() {
  const snapshot = state.roomState;
  if (!snapshot) return;
  const mySeat = snapshot.seats.find((seat) => seat && seat.userId === state.user.id);
  if (!mySeat) return;
  setBetAmount(mySeat.bet + mySeat.chips);
}

function setBetAmount(amount) {
  const range = $("#amountRange");
  const min = Number(range.min || 1);
  const max = Number(range.max || min);
  const value = clampNumber(Math.floor(Number(amount) || min), min, max);
  range.value = value;
  $("#amountInput").value = value;
  updateRangeFill(range);
  rememberWagerAmount(value);
}

function updateRangeFill(range = $("#amountRange")) {
  if (!range) return;
  const min = Number(range.min || 0);
  const max = Number(range.max || min);
  const value = Number(range.value || min);
  const progress = max > min ? ((value - min) / (max - min)) * 100 : 100;
  range.style.setProperty("--range-progress", `${clampNumber(progress, 0, 100)}%`);
}

function updateAmountValue(value) {
  $("#amountValue").textContent = Number.isFinite(value) ? String(Math.floor(value)) : "0";
}

function rememberWagerAmount(value) {
  const amount = Math.max(1, Math.floor(Number(value) || DEFAULT_WAGER_AMOUNT));
  state.lastWagerAmount = amount;
  localStorage.setItem("pokerLastWagerAmount", String(amount));
  updateAmountValue(amount);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function minimumWagerTotal(snapshot, mySeat) {
  if (!mySeat) return Math.max(1, snapshot?.room?.bigBlind || 1);
  if (snapshot.game.currentBet > 0) {
    const minimumFullTotal = Number(snapshot.game.minimumFullWagerTotal || 0);
    const fallback = snapshot.game.currentBet + Number(snapshot.game.minRaise || snapshot.room.bigBlind || 1);
    return Math.min(mySeat.bet + mySeat.chips, minimumFullTotal || fallback);
  }
  return Math.min(mySeat.bet + mySeat.chips, snapshot.room.bigBlind);
}

function presetWagerTotal(snapshot, mySeat, preset) {
  const min = minimumWagerTotal(snapshot, mySeat);
  const max = mySeat.bet + mySeat.chips;
  const pot = Math.max(0, Number(snapshot.game.pot || 0));
  const currentBet = Math.max(0, Number(snapshot.game.currentBet || 0));
  const callAmount = Math.max(0, currentBet - (mySeat.bet || 0));
  const isPreflop = snapshot.game.status === "preflop";

  let target = min;
  if (preset === "slot2") {
    target = currentBet > 0
      ? Math.floor(currentBet * 2.5)
      : isPreflop
        ? snapshot.room.bigBlind * 2
        : Math.floor(pot / 2);
  } else if (preset === "slot3") {
    target = currentBet > 0
      ? currentBet * 3
      : isPreflop
        ? snapshot.room.bigBlind * 3
        : Math.floor(pot * 2 / 3);
  } else if (preset === "slot4") {
    target = currentBet > 0
      ? mySeat.bet + callAmount + pot + callAmount
      : isPreflop
        ? snapshot.room.bigBlind * 4
        : pot;
  }
  return clampNumber(Math.max(min, target), min, max);
}

function quickWagerLabels(snapshot) {
  if (snapshot.game.currentBet > 0) return ["最小", "2.5x", "3x", "底池"];
  if (snapshot.game.status === "preflop") return ["最小", "2x", "3x", "4x"];
  return ["最小", "1/2池", "2/3池", "底池"];
}

function sendEmote(emote = $("#emoteSelect").value, targetSeat) {
  const hasExplicitTarget = arguments.length >= 2;
  const targetValue = hasExplicitTarget ? targetSeat : $("#emoteTarget").value;
  send({
    type: "emote",
    emote,
    targetSeat: targetValue === "" ? null : Number(targetValue)
  });
  closeEmoteMenu();
}

function tipDealer(amount) {
  const numericAmount = Number(amount);
  const fallbackAmount = Number($("#dealerTipAmount").value || 5);
  send({ type: "dealerTip", amount: Number.isFinite(numericAmount) ? numericAmount : fallbackAmount });
  closeDealerTipMenu();
}

async function loadAvatars() {
  const data = await api("/api/avatars");
  state.avatars = await Promise.all((data.avatars || []).map(async (avatar) => ({
    ...avatar,
    displayUrl: await normalizeAvatarUrl(avatar.url)
  })));
}

async function loadDealers() {
  try {
    const data = await api("/api/dealers");
    state.dealers = data.dealers || [];
  } catch {
    state.dealers = [];
  }
}

async function loadRooms() {
  const data = await api("/api/rooms");
  state.rooms = data.rooms;
  renderRooms();
}

async function createRoom() {
  const name = $("#roomName").value.trim();
  const smallBlind = Number($("#smallBlindInput").value || 5);
  const bigBlind = Number($("#bigBlindInput").value || 10);
  const startingChips = Number($("#startingChipsInput").value || 1000);
  const maxSeats = Number($("#maxSeatsInput").value || 9);
  const data = await api("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name, smallBlind, bigBlind, startingChips, maxSeats })
  });
  joinRoom(data.room.id);
}

function joinRoom(roomId) {
  state.lastRoomId = String(roomId || "").toUpperCase();
  localStorage.setItem("pokerLastRoomId", state.lastRoomId);
  showRoom();
  send({ type: "joinRoom", roomId });
}

async function lookupRoom() {
  const input = $("#roomLookupInput");
  const result = $("#roomLookupResult");
  const roomId = input.value.trim().toUpperCase();
  if (!roomId) {
    result.classList.remove("hidden");
    result.innerHTML = `<p class="hint">先输入房间 ID。</p>`;
    return;
  }
  result.classList.remove("hidden");
  result.innerHTML = `<p class="hint">查询中...</p>`;
  try {
    const response = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    const activeRoom = response.room;
    if (!activeRoom) {
      result.innerHTML = `<p class="error">没找到这个当前在线房间。</p>`;
      return;
    }
    result.innerHTML = renderRoomLookupResult(activeRoom, roomId);
    result.querySelector("[data-lookup-join]")?.addEventListener("click", () => joinRoom(activeRoom.id));
  } catch (error) {
    result.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

function renderRoomLookupResult(activeRoom, roomId) {
  return `
    <div class="lookupCard">
      <div class="lookupHead">
        <div>
          <strong>${escapeHtml(activeRoom.name || "牌桌")}</strong>
          <p class="hint">#${escapeHtml(activeRoom.id || roomId)} · 当前在线</p>
        </div>
        <button type="button" data-lookup-join>进入</button>
      </div>
    </div>
  `;
}

async function copyRoomId() {
  const roomId = state.roomState?.room?.id;
  if (!roomId) return;
  try {
    await navigator.clipboard.writeText(roomId);
    showToast(`已复制房间 ID：${roomId}`);
  } catch {
    const input = document.createElement("input");
    input.value = roomId;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    showToast(`已复制房间 ID：${roomId}`);
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // Local cleanup still logs the user out if the server is unreachable.
  }
  localStorage.removeItem("pokerToken");
  state.token = "";
  state.user = null;
  state.roomState = null;
  clearCountdown();
  stopBgm();
  if (state.ws) state.ws.close();
  showAuth();
}

function showAuth() {
  document.body.classList.remove("lobby-active");
  authView.classList.remove("hidden");
  appView.classList.add("hidden");
  closeSpectatorsDrawer();
  $("#spectatorsDrawer")?.classList.add("hidden");
  closeChatDrawer();
  $("#chatDrawer")?.classList.add("hidden");
  $("#supportDrawer")?.classList.add("hidden");
}

function showApp() {
  if (!document.body.classList.contains("room-active")) document.body.classList.add("lobby-active");
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  $("#userLabel").textContent = state.user ? state.user.username : "未登录";
  renderProfile();
  setVersionLabel(state.version || CLIENT_VERSION);
  if (!lobbyView.classList.contains("hidden")) $("#supportDrawer")?.classList.remove("hidden");
  updateBgmToggle();
}

function renderProfile() {
  if (!state.user) return;
  $("#userLabel").textContent = state.user.username;
  $("#profileEmail").textContent = `邮箱：${state.user.email}`;
  $("#profileUsername").value = state.user.username || "";
}

function showLobby() {
  document.body.classList.remove("room-active");
  document.body.classList.add("lobby-active");
  if (state.roomState) send({ type: "leaveRoom" });
  lobbyView.classList.remove("hidden");
  roomView.classList.add("hidden");
  closeSpectatorsDrawer();
  $("#spectatorsDrawer")?.classList.add("hidden");
  closeChatDrawer();
  $("#chatDrawer")?.classList.add("hidden");
  $("#supportDrawer")?.classList.remove("hidden");
  state.roomState = null;
  clearCountdown();
  loadRooms();
}

function showRoom() {
  document.body.classList.add("room-active");
  document.body.classList.remove("lobby-active");
  lobbyView.classList.add("hidden");
  roomView.classList.remove("hidden");
  $("#spectatorsDrawer")?.classList.remove("hidden");
  $("#chatDrawer")?.classList.remove("hidden");
  closeSupportDrawer();
  $("#supportDrawer")?.classList.add("hidden");
  applyTableOrientation();
}

function attemptBackLobby() {
  if (isMySeatLocked()) {
    showToast("手牌进行中不能退出房间。关闭页面只会显示离线，座位和筹码仍由服务器保留。", "warn");
    return;
  }
  showLobby();
}

function isMySeatLocked() {
  const snapshot = state.roomState;
  if (!snapshot || !state.user) return false;
  const active = !["waiting", "showdown"].includes(snapshot.game.status);
  return active && snapshot.seats.some((seat) => seat && seat.userId === state.user.id);
}

function toggleReady() {
  const snapshot = state.roomState;
  if (!snapshot || !state.user) return;
  const mySeat = snapshot.seats.find((seat) => seat && seat.userId === state.user.id);
  if (!mySeat) {
    showToast("先坐下，再准备。", "warn");
    return;
  }
  send({ type: mySeat.ready ? "unready" : "ready" });
}

function attemptStand() {
  const snapshot = state.roomState;
  const mySeat = snapshot?.seats.find((seat) => seat && seat.userId === state.user?.id);
  const activeHand = snapshot && !["waiting", "showdown"].includes(snapshot.game.status);
  if (mySeat?.ready && !activeHand) {
    showToast("请先点“取消准备”，再起身。", "warn");
    return;
  }
  send({ type: "stand" });
}

function setConn(text) {
  $("#connLabel").textContent = text;
}

function showToast(message, tone = "info") {
  const stack = $("#toastStack");
  if (!stack || !message) return;
  const toast = document.createElement("div");
  toast.className = `softToast ${tone}`;
  toast.innerHTML = `
    <div class="softToastText">${escapeHtml(message)}</div>
    <div class="softToastBar"></div>
  `;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

function setVersionLabel(version, updatedAt) {
  state.version = version || CLIENT_VERSION;
  const label = $("#versionLabel");
  if (label) label.textContent = `v${state.version}`;
  if (updatedAt) state.updatedAt = updatedAt;
  renderUpdateStamp();
}

function renderUpdateStamp() {
  const stamp = $("#updateStamp");
  if (!stamp || !state.updatedAt) return;
  const updated = new Date(state.updatedAt);
  if (Number.isNaN(updated.getTime())) return;
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(updated).replaceAll("/", ".");
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(updated);
  stamp.dateTime = state.updatedAt;
  stamp.innerHTML = `<span>${date}</span><span>${time}</span>`;
}

function toggleBgmMuted() {
  state.bgmMuted = !state.bgmMuted;
  localStorage.setItem("pokerBgmMuted", state.bgmMuted ? "1" : "0");
  updateBgmToggle();
  if (state.bgmMuted) {
    if (state.bgmAudio) state.bgmAudio.pause();
  } else if (state.bgmMusic) {
    syncBgm(state.bgmMusic, state.bgmScope);
  }
}

function updateBgmToggle() {
  const button = $("#bgmToggleBtn");
  if (!button) return;
  button.textContent = state.bgmMuted ? "BGM 关" : "BGM 开";
  button.setAttribute("aria-pressed", String(!state.bgmMuted));
  button.classList.toggle("muted", state.bgmMuted);
}

function renderRulesSidebar() {
  $("#handRankCards").innerHTML = HAND_RULES.map((rule) => `
    <article class="handRankCard power${rule.power}">
      <div>
        <strong>${escapeHtml(rule.name)}</strong>
        <span>强度 ${rule.power + 1}</span>
      </div>
      <div class="miniCards">${rule.example.map((card) => `<span>${escapeHtml(card)}</span>`).join("")}</div>
      <p>${escapeHtml(rule.desc)}</p>
    </article>
  `).join("");
  updateSideDrawerLabels();
}

function toggleRulesDrawer() {
  const drawer = $("#rulesDrawer");
  const willOpen = !drawer.classList.contains("open");
  closeSideDrawers();
  if (willOpen) drawer.classList.add("open");
  updateSideDrawerLabels();
}

function closeRulesDrawer() {
  $("#rulesDrawer").classList.remove("open");
  updateSideDrawerLabels();
}

function toggleSpectatorsDrawer() {
  const drawer = $("#spectatorsDrawer");
  const willOpen = !drawer.classList.contains("open");
  closeSideDrawers();
  if (willOpen) drawer.classList.add("open");
  updateSideDrawerLabels();
}

function closeSpectatorsDrawer() {
  $("#spectatorsDrawer").classList.remove("open");
  updateSideDrawerLabels();
}

function toggleChatDrawer() {
  const drawer = $("#chatDrawer");
  const willOpen = !drawer.classList.contains("open");
  closeSideDrawers();
  if (willOpen) drawer.classList.add("open");
  updateSideDrawerLabels();
}

function closeChatDrawer() {
  $("#chatDrawer").classList.remove("open");
  updateSideDrawerLabels();
}

function toggleFeedbackDrawer() {
  const drawer = $("#feedbackDrawer");
  const willOpen = !drawer.classList.contains("open");
  closeSideDrawers();
  if (willOpen) {
    drawer.classList.add("open");
    if (!state.feedbackChallengeId) loadFeedbackChallenge();
  }
  updateSideDrawerLabels();
}

function closeFeedbackDrawer() {
  $("#feedbackDrawer").classList.remove("open");
  updateSideDrawerLabels();
}

function toggleSupportDrawer() {
  const drawer = $("#supportDrawer");
  const willOpen = !drawer.classList.contains("open");
  closeSideDrawers();
  if (willOpen) drawer.classList.add("open");
  updateSideDrawerLabels();
}

function closeSupportDrawer() {
  $("#supportDrawer").classList.remove("open");
  updateSideDrawerLabels();
}

function closeSideDrawers() {
  $("#spectatorsDrawer")?.classList.remove("open");
  $("#chatDrawer")?.classList.remove("open");
  $("#rulesDrawer")?.classList.remove("open");
  $("#feedbackDrawer")?.classList.remove("open");
  $("#supportDrawer")?.classList.remove("open");
  updateSideDrawerLabels();
}

function updateSideDrawerLabels() {
  const spectatorsOpen = $("#spectatorsDrawer")?.classList.contains("open");
  const chatOpen = $("#chatDrawer")?.classList.contains("open");
  const rulesOpen = $("#rulesDrawer")?.classList.contains("open");
  const feedbackOpen = $("#feedbackDrawer")?.classList.contains("open");
  const supportOpen = $("#supportDrawer")?.classList.contains("open");
  const spectatorCount = $("#spectators")?.dataset.count || "0";
  if ($("#spectatorsToggle")) $("#spectatorsToggle").innerHTML = `观众 ${spectatorCount} ${spectatorsOpen ? "&lt;" : "&gt;"}`;
  if ($("#chatToggle")) $("#chatToggle").innerHTML = `聊天 ${chatOpen ? "&lt;" : "&gt;"}`;
  if ($("#rulesToggle")) $("#rulesToggle").innerHTML = `牌型 ${rulesOpen ? "&gt;" : "&lt;"}`;
  if ($("#feedbackToggle")) $("#feedbackToggle").innerHTML = `意见 ${feedbackOpen ? "&gt;" : "&lt;"}`;
  if ($("#supportToggle")) $("#supportToggle").innerHTML = `随缘 ${supportOpen ? "&gt;" : "&lt;"}`;
}

async function loadFeedbackChallenge() {
  const status = $("#feedbackStatus");
  if (status) status.textContent = "正在获取验证码...";
  try {
    const data = await api("/api/feedback/challenge");
    state.feedbackChallengeId = data.challenge.id;
    $("#feedbackCaptchaQuestion").textContent = data.challenge.question;
    $("#feedbackCaptchaInput").value = "";
    if (status) status.textContent = "";
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

async function submitFeedback(event) {
  event.preventDefault();
  const status = $("#feedbackStatus");
  const button = $("#feedbackSubmit");
  button.disabled = true;
  if (status) status.textContent = "正在提交...";
  try {
    const data = await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        text: $("#feedbackText").value,
        challengeId: state.feedbackChallengeId,
        captcha: $("#feedbackCaptchaInput").value
      })
    });
    $("#feedbackText").value = "";
    state.feedbackChallengeId = "";
    await loadFeedbackChallenge();
    if (status) status.textContent = data.message || "已提交";
  } catch (error) {
    await loadFeedbackChallenge();
    if (status) status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function audioContext() {
  if (!("AudioContext" in window || "webkitAudioContext" in window)) return null;
  if (!state.audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioCtor();
  }
  return state.audioContext;
}

async function loadChipSounds() {
  const context = audioContext();
  if (!context || state.chipBuffers.length) return;
  const buffers = await Promise.all(CHIP_SOUND_URLS.map(async (url) => {
    const response = await fetch(url);
    return context.decodeAudioData(await response.arrayBuffer());
  }));
  state.chipBuffers = buffers;
}

function ensureBgmAudio() {
  if (state.bgmAudio) return state.bgmAudio;
  const audio = new Audio();
  audio.preload = "auto";
  audio.volume = 0.2;
  audio.addEventListener("ended", () => {
    if (state.bgmMusic) syncBgm(state.bgmMusic, state.bgmScope);
  });
  state.bgmAudio = audio;
  return audio;
}

async function musicDuration(track) {
  if (state.musicDurations.has(track.url)) return state.musicDurations.get(track.url);
  const audio = new Audio(track.url);
  audio.preload = "metadata";
  const duration = await new Promise((resolve) => {
    audio.addEventListener("loadedmetadata", () => resolve(Number.isFinite(audio.duration) ? audio.duration : 60), { once: true });
    audio.addEventListener("error", () => resolve(60), { once: true });
  });
  state.musicDurations.set(track.url, duration || 60);
  return duration || 60;
}

async function chooseSyncedTrack(music) {
  const tracks = music?.tracks || [];
  if (!tracks.length) return null;
  const durations = await Promise.all(tracks.map(musicDuration));
  const elapsed = Math.max(0, (Date.now() - state.serverOffsetMs - music.startedAt) / 1000);
  if (music.mode === "single" || tracks.length === 1) {
    const duration = durations[0] || 60;
    return { track: tracks[0], offset: elapsed % duration, duration };
  }
  const total = durations.reduce((sum, duration) => sum + duration, 0) || tracks.length * 60;
  let position = elapsed % total;
  for (let i = 0; i < tracks.length; i += 1) {
    if (position < durations[i]) return { track: tracks[i], offset: position, duration: durations[i] };
    position -= durations[i];
  }
  return { track: tracks[0], offset: 0, duration: durations[0] || 60 };
}

async function syncBgm(music, scope) {
  if (!music?.tracks?.length) return;
  state.bgmMusic = music;
  state.bgmScope = scope;
  if (state.bgmMuted) {
    if (state.bgmAudio) state.bgmAudio.pause();
    updateBgmToggle();
    return;
  }
  const audio = ensureBgmAudio();
  const picked = await chooseSyncedTrack(music);
  if (!picked) return;
  const targetSrc = new URL(picked.track.url, location.href).href;
  const key = `${scope}:${music.startedAt}:${picked.track.id}`;
  const isNewTrack = state.bgmKey !== key || audio.src !== targetSrc;
  audio.loop = music.mode === "single" || music.tracks.length === 1;
  audio.volume = scope === "lobby" ? 0.18 : 0.16;
  if (isNewTrack) {
    state.bgmKey = key;
    audio.src = targetSrc;
    audio.load();
  }
  const applyTime = () => {
    const drift = Math.abs((audio.currentTime || 0) - picked.offset);
    if (isNewTrack || drift > 1.6) {
      try {
        audio.currentTime = Math.min(Math.max(0, picked.offset), Math.max(0, picked.duration - 0.35));
      } catch {}
    }
  };
  if (audio.readyState >= 1) applyTime();
  else audio.addEventListener("loadedmetadata", applyTime, { once: true });
  audio.play().catch(() => {});
  if (!state.bgmTimer) {
    state.bgmTimer = setInterval(() => {
      if (state.bgmMusic) syncBgm(state.bgmMusic, state.bgmScope);
    }, 5000);
  }
}

function resumeBgm() {
  loadChipSounds().catch(() => {});
  if (state.audioContext?.state === "suspended") state.audioContext.resume().catch(() => {});
  if (state.bgmMuted) return;
  if (state.bgmAudio && state.bgmMusic) state.bgmAudio.play().catch(() => {});
}

function stopBgm() {
  if (state.bgmTimer) {
    clearInterval(state.bgmTimer);
    state.bgmTimer = null;
  }
  if (state.bgmAudio) {
    state.bgmAudio.pause();
    state.bgmAudio.removeAttribute("src");
    state.bgmAudio.load();
  }
  state.bgmKey = "";
  state.bgmMusic = null;
  state.bgmScope = "";
}

function playChipSound(volume = 0.44) {
  const context = audioContext();
  if (!context) return;
  if (context.state !== "running") context.resume().catch(() => {});
  if (!state.chipBuffers.length) {
    loadChipSounds().catch(() => {});
    return;
  }
  const source = context.createBufferSource();
  source.buffer = state.chipBuffers[Math.floor(Math.random() * state.chipBuffers.length)];
  source.playbackRate.value = 0.92 + Math.random() * 0.22;
  const gain = context.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(context.destination);
  source.start();
}

function playCountdownTick(seconds) {
  const context = audioContext();
  if (!context) return;
  if (context.state !== "running") context.resume().catch(() => {});
  const now = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(seconds <= 2 ? 0.16 : 0.1, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  gain.connect(context.destination);
  const osc = context.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(seconds <= 2 ? 1046.5 : 880, now);
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + 0.18);
}

function playSettlementSound(power) {
  playChipSound(Math.min(0.72, 0.38 + power * 0.045));
  const context = audioContext();
  if (!context || context.state !== "running") return;
  const now = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.min(0.12, 0.035 + power * 0.012), now + 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9 + power * 0.08);
  gain.connect(context.destination);
  [523.25, 659.25, 783.99].slice(0, Math.max(1, Math.min(3, power - 1))).forEach((frequency, index) => {
    const osc = context.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(frequency, now + index * 0.05);
    osc.connect(gain);
    osc.start(now + index * 0.05);
    osc.stop(now + 0.85 + power * 0.08);
  });
}

function renderRooms() {
  const container = $("#rooms");
  renderResumeRoom();
  if (!state.rooms.length) {
    container.innerHTML = `<p class="hint">暂无房间，先创建一桌。</p>`;
    return;
  }
  container.innerHTML = state.rooms.map((room) => `
    <div class="roomItem">
      <div>
        <strong>${escapeHtml(room.name)}</strong>
        <p class="hint">${room.seats}/${room.maxSeats} 人 · ${statusText(room.status)} · 盲注 ${room.smallBlind}/${room.bigBlind} · 初始 ${room.startingChips}</p>
      </div>
      <button data-room="${room.id}">进入</button>
    </div>
  `).join("");
  container.querySelectorAll("[data-room]").forEach((button) => {
    button.addEventListener("click", () => joinRoom(button.dataset.room));
  });
}

function renderResumeRoom() {
  const box = $("#resumeRoom");
  if (!box) return;
  const room = state.rooms.find((item) => item.id === state.lastRoomId);
  if (!room || state.roomState?.room?.id === room.id) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <div>
      <strong>上次牌桌还在</strong>
      <p class="hint">${escapeHtml(room.name)} #${escapeHtml(room.id)} · ${room.seats}/${room.maxSeats} 人 · ${statusText(room.status)}</p>
    </div>
    <button type="button" data-resume-room="${escapeHtml(room.id)}">回到牌桌</button>
  `;
  box.classList.remove("hidden");
  box.querySelector("[data-resume-room]").addEventListener("click", () => joinRoom(room.id));
}

function renderRoom() {
  const snapshot = state.roomState;
  if (!snapshot) return;
  showRoom();
  $(".tableSurface").classList.toggle("showdown", snapshot.game.status === "showdown");
  $("#roomTitle").textContent = `${snapshot.room.name} #${snapshot.room.id}`;
  $("#handInfo").textContent = `${statusText(snapshot.game.status)} · 第 ${snapshot.game.handNumber} 手 · 盲注 ${snapshot.room.smallBlind}/${snapshot.room.bigBlind}`;
  $("#copyRoomIdBtn").textContent = `房间 ID：${snapshot.room.id}`;
  const boardKey = snapshot.game.board.join(",");
  if (state._lastBoardKey !== boardKey) {
    state._lastBoardKey = boardKey;
    $("#board").innerHTML = snapshot.game.board.map(cardHtml).join("") || `<span class="hint">等待发牌</span>`;
  }
  $("#potValue").textContent = snapshot.game.pot;
  // Update dealer image from room state
  if (snapshot.game.dealerImage) {
    const dealerImg = document.querySelector("#dealerSpot img");
    if (dealerImg && dealerImg.src !== new URL(snapshot.game.dealerImage, location.href).href) {
      dealerImg.src = snapshot.game.dealerImage;
    }
  }
  $("#lastAction").innerHTML = fairnessHtml(snapshot.game);
  updateFairnessVerification(snapshot.game);
  renderSettlement(snapshot.game, snapshot.settlement);
  renderSpectators(snapshot.spectators || []);

  const acting = snapshot.seats[snapshot.game.actingSeat];
  $("#turnLabel").textContent = acting ? `轮到 ${acting.username}` : "等待操作";

  const mySeat = snapshot.seats.find((seat) => seat && seat.userId === state.user.id);
  const isMyTurn = mySeat && snapshot.game.actingSeat === mySeat.seat;
  const callAmount = mySeat ? Math.max(0, snapshot.game.currentBet - mySeat.bet) : 0;
  const maxWagerTotal = mySeat ? mySeat.bet + mySeat.chips : 0;
  const activeHand = !["waiting", "showdown"].includes(snapshot.game.status);
  const canReady = Boolean(mySeat) && !activeHand;
  $("#callBtn").textContent = callAmount > 0 ? `跟注 ${callAmount}` : "跟注";
  $("#checkBtn").textContent = "过牌";
  $("#readyBtn").textContent = mySeat?.ready ? "取消准备" : "准备";
  $("#readyBtn").disabled = !canReady;
  $("#readyBtn").classList.toggle("readyActive", canReady && !mySeat?.ready);
  $(".playbar").classList.toggle("myTurn", Boolean(isMyTurn));
  $(".playbar").classList.toggle("canPrepare", canReady && !mySeat?.ready);
  $("#standBtn").disabled = !mySeat || activeHand;
  $("#checkBtn").disabled = !isMyTurn || callAmount > 0;
  $("#callBtn").disabled = !isMyTurn || callAmount === 0;
  $("#foldBtn").disabled = !isMyTurn;
  $("#betBtn").disabled = !isMyTurn || snapshot.game.currentBet > 0 || maxWagerTotal <= 0;
  $("#raiseBtn").disabled = !isMyTurn || snapshot.game.currentBet === 0 || !mySeat?.canRaise;
  $("#actionButtons").classList.toggle("needsCall", callAmount > 0);
  $("#actionButtons").classList.toggle("canCheck", callAmount === 0);
  renderWagerControls(snapshot, mySeat, isMyTurn, activeHand);
  $("#randomAvatarBtn").disabled = !mySeat || activeHand || !state.avatars.length;
  $("#dealerTipBtn").disabled = !mySeat || activeHand;
  $("#startHandBtn").disabled = !snapshot.room.canStart;
  const nextHandRemainingMs = Math.max(0, Number(snapshot.game.nextHandStartsAt || 0) - (Date.now() - state.serverOffsetMs));
  $("#startHandBtn").textContent = nextHandRemainingMs > 0
    ? `自动开始 ${Math.ceil(nextHandRemainingMs / 1000)}s`
    : snapshot.room.canStart
      ? "开始下一手"
      : `等待准备 ${snapshot.room.readySeats}/${snapshot.room.seats}`;

  $("#seats").innerHTML = snapshot.seats.map((seat, index) => seatHtml(seat, index, snapshot.game, mySeat, activeHand, snapshot.seats.length)).join("");
  $("#seats").querySelectorAll("[data-sit]").forEach((button) => {
    button.addEventListener("click", () => send({ type: "sit", seat: Number(button.dataset.sit) }));
  });
  $("#seats").querySelectorAll(".seat:not(.empty)[data-seat]").forEach((seatEl) => {
    seatEl.querySelector(".seatAvatar")?.addEventListener("click", (event) => {
      event.stopPropagation();
      openEmoteMenu(Number(seatEl.dataset.seat));
    });
    seatEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openEmoteMenu(Number(seatEl.dataset.seat));
    });
  });
  renderSocialControls(snapshot, mySeat, activeHand);
  updateCountdown(snapshot, mySeat);
  maybeAnimateSettlement(snapshot);

  $("#messages").innerHTML = snapshot.messages.map((message) => (
    `<div><strong>${escapeHtml(message.username)}:</strong> ${escapeHtml(message.text)}</div>`
  )).join("");
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function renderSpectators(spectators) {
  const panel = $("#spectators");
  if (!panel) return;
  const items = spectators || [];
  panel.dataset.count = String(items.length);
  panel.classList.toggle("empty", items.length === 0);
  updateSideDrawerLabels();
  panel.innerHTML = `
    <div class="spectatorsTitle">观众 <strong>${items.length}</strong></div>
    <div class="spectatorsList">
      ${items.length
        ? items.map((spectator) => `<span class="spectatorName">${escapeHtml(spectator.username)}</span>`).join("")
        : `<span class="spectatorEmpty">暂无观众</span>`}
    </div>
  `;
}

function renderWagerControls(snapshot, mySeat, isMyTurn, activeHand) {
  const max = mySeat ? Math.max(1, mySeat.bet + mySeat.chips) : Math.max(1, snapshot.room.bigBlind);
  const min = Math.max(1, minimumWagerTotal(snapshot, mySeat));
  const canAdjust = Boolean(mySeat) && activeHand && mySeat.inHand && !mySeat.folded && !mySeat.allIn && min <= max;
  const range = $("#amountRange");
  const input = $("#amountInput");
  const current = clampNumber(Number(state.lastWagerAmount || input.value || min), min, max);
  range.min = min;
  range.max = max;
  const smallBlind = Math.max(1, Number(snapshot.room.smallBlind || 1));
  range.step = smallBlind;
  range.value = current;
  updateRangeFill(range);
  input.min = min;
  input.max = max;
  input.step = smallBlind;
  input.value = current;
  range.disabled = !canAdjust;
  input.disabled = !canAdjust;
  const callAmount = mySeat ? Math.max(0, snapshot.game.currentBet - mySeat.bet) : 0;
  $("#wagerHint").textContent = mySeat
    ? callAmount > 0
      ? `跟注 ${callAmount} · 最小加注到 ${min} · 最大全下到 ${max} · 剩余 ${mySeat.chips}`
      : `最小下注 ${min} · 最大全下 ${max} · 剩余 ${mySeat.chips}`
    : "入座后可调整下注";
  $("#wagerMode").textContent = snapshot.game.currentBet > 0 ? "加注到" : "下注额";
  updateAmountValue(current);
  const labels = quickWagerLabels(snapshot);
  document.querySelectorAll("[data-wager-preset]").forEach((button, index) => {
    button.textContent = labels[index] || button.textContent;
    button.disabled = !canAdjust;
  });
  document.querySelectorAll("#allInBtn").forEach((button) => {
    button.disabled = !canAdjust;
  });
  renderWagerScale(min, max, smallBlind);
  $("#actionButtons").classList.toggle("isMyTurn", Boolean(isMyTurn));
}

function renderWagerScale(min, max, smallBlind) {
  const ticks = $("#wagerTicks");
  const scale = $("#wagerScale");
  if (!ticks || !scale) return;
  const multipliers = [1, 2, 4, 8];
  const values = [...new Set([
    min,
    ...multipliers.map((multiple) => clampNumber(smallBlind * multiple, min, max)),
    max
  ])].sort((a, b) => a - b);
  ticks.innerHTML = values.map((value) => `<option value="${value}"></option>`).join("");
  scale.innerHTML = values.map((value) => {
    const multiple = value / smallBlind;
    const label = Number.isInteger(multiple) ? `${multiple}×盲` : value;
    return `<span>${label}</span>`;
  }).join("");
}

function seatPosition(index, totalSeats) {
  const angle = Math.PI / 2 + (index / totalSeats) * 2 * Math.PI;
  const left = 50 + 40 * Math.cos(angle);
  const top = 51.5 + 40 * Math.sin(angle);
  return `left:${left.toFixed(1)}%;top:${top.toFixed(1)}%`;
}

function seatHtml(seat, index, game, mySeat, activeHand, totalSeats) {
  const posStyle = seatPosition(index, totalSeats);
  if (!seat) {
    const seatLocked = mySeat && (activeHand || mySeat.ready);
    const disabled = seatLocked ? " disabled" : "";
    const label = mySeat?.ready ? "已准备" : mySeat ? "换座" : "坐下";
    return `<div class="seat empty" data-seat="${index}" style="${posStyle}"><button class="secondary" data-sit="${index}"${disabled}>${label}</button></div>`;
  }
  const classes = ["seat"];
  if (game.status === "showdown") classes.push("showdownSeat");
  if (game.status === "showdown" && game.winners?.some((winner) => winner.seat === index)) classes.push("winner");
  if (game.actingSeat === index) classes.push("active");
  if (mySeat?.seat === index) classes.push("mine");
  if (seat.folded) classes.push("folded");
  if (!seat.connected) classes.push("disconnected");
  const badges = [];
  if (game.button === index) badges.push("庄");
  if (seat.ready) badges.push("已准备");
  if (seat.allIn) badges.push("All-in");
  if (!["waiting", "showdown"].includes(game.status) && !seat.inHand) badges.push("等待下一手");
  if (!seat.connected) badges.push("离线");
  if (seat.bet > 0) badges.push(`本轮 ${seat.bet}`);
  const avatarUrl = seat.avatar ? displayAvatarUrl(seat.avatar) : "";
  const initial = escapeHtml((seat.username || "?").slice(0, 1));
  return `
    <div class="${classes.join(" ")}" data-seat="${index}" style="${posStyle}">
      ${avatarUrl
        ? `<img class="seatAvatar" src="${avatarUrl}" alt="">`
        : `<div class="seatAvatar fallbackAvatar">${initial}</div>`}
      <div class="seatBody">
        <div class="seatTop">
          <span class="seatName">${escapeHtml(seat.username)}</span>
        </div>
        <span class="stack seatStack"><span class="chipIcon"></span>${seat.chips}</span>
        <div class="cards">${seat.hole.map(cardHtml).join("")}</div>
        <div class="badges">${badges.map((item) => `<span class="badge">${item}</span>`).join("")}</div>
        <p class="hint">${escapeHtml(seat.result || (seat.folded ? "已弃牌" : ""))}</p>
      </div>
    </div>
  `;
}

function renderSocialControls(snapshot, mySeat, activeHand) {
  const avatarBox = $("#avatarChoices");
  avatarBox.innerHTML = state.avatars.map((avatar) => {
    const selected = mySeat?.avatar === avatar.name ? " selected" : "";
    const disabled = !mySeat || activeHand ? " disabled" : "";
    return `
      <button class="avatarChoice${selected}" type="button" data-avatar="${escapeHtml(avatar.name)}"${disabled} title="切换头像">
        <img src="${avatar.displayUrl || avatar.url}" alt="">
      </button>
    `;
  }).join("");
  avatarBox.querySelectorAll("[data-avatar]").forEach((button) => {
    button.addEventListener("click", () => send({ type: "switchAvatar", avatar: button.dataset.avatar }));
  });

  const target = $("#emoteTarget");
  const currentTarget = target.value;
  const options = [`<option value="">全桌</option>`].concat(snapshot.seats
    .filter((seat) => seat && seat.userId !== mySeat?.userId)
    .map((seat) => `<option value="${seat.seat}">${escapeHtml(seat.username)}</option>`));
  target.innerHTML = options.join("");
  if ([...target.options].some((option) => option.value === currentTarget)) {
    target.value = currentTarget;
  }
  $("#sendEmoteBtn").disabled = !mySeat;
  $("#emoteSelect").disabled = !mySeat;
  $("#emoteTarget").disabled = !mySeat;
  $("#dealerTipAmount").disabled = !mySeat || activeHand;
}

function updateCountdown(snapshot, mySeat) {
  clearCountdown();
  const countdown = $("#turnCountdown");
  const activeHand = !["waiting", "showdown"].includes(snapshot.game.status);
  const acting = snapshot.seats[snapshot.game.actingSeat];
  if (!activeHand || !acting || !snapshot.game.turnDeadlineAt) {
    countdown.classList.add("hidden");
    return;
  }

  // Fixed position in top-right corner of the table — no dynamic positioning
  countdown.style.left = "82%";
  countdown.style.top = "12%";

  const render = () => {
    const serverNow = Date.now() - state.serverOffsetMs;
    const remainingMs = Math.max(0, snapshot.game.turnDeadlineAt - serverNow);
    const seconds = Math.ceil(remainingMs / 1000);
    const totalMs = Math.max(1000, snapshot.game.timeLimitMs || 60000);
    const progress = Math.max(0, Math.min(1, remainingMs / totalMs));
    const timerColor = progress > 0.5 ? "#35c486" : progress > 0.18 ? "#d7b85a" : "#de5962";
    const isMine = acting.userId === mySeat?.userId;
    $("#turnCountdownName").textContent = acting.userId === mySeat?.userId ? "轮到你" : `轮到 ${acting.username}`;
    $("#turnCountdownValue").textContent = String(seconds).padStart(2, "0");
    countdown.style.setProperty("--turn-progress", `${progress * 100}%`);
    countdown.style.setProperty("--turn-color", timerColor);
    roomView.style.setProperty("--turn-progress", `${progress * 100}%`);
    roomView.style.setProperty("--turn-color", timerColor);
    countdown.classList.toggle("mine", isMine);
    countdown.classList.toggle("urgent", seconds <= 5);
    countdown.classList.remove("hidden");
    document.querySelectorAll(".seat").forEach((seat) => {
      seat.classList.toggle("timeWarning", false);
    });
    const actingSeat = document.querySelector(`[data-seat="${snapshot.game.actingSeat}"]`);
    if (actingSeat) {
      actingSeat.classList.toggle("timeWarning", seconds <= 5);
    }
    if (isMine && seconds <= 5 && seconds > 0) {
      const alertKey = `${snapshot.room.id}:${snapshot.game.handNumber}:${snapshot.game.actingSeat}:${seconds}`;
      if (state.countdownAlertKey !== alertKey) {
        state.countdownAlertKey = alertKey;
        playCountdownTick(seconds);
        if ("vibrate" in navigator) navigator.vibrate(seconds <= 2 ? 90 : 45);
      }
    }
    if (remainingMs <= 0) clearCountdown(false);
  };
  render();
  state.countdownTimer = setInterval(render, 250);
}

function renderSettlement(game, settlement = {}) {
  const panel = $("#settlementPanel");
  if (game.status !== "showdown" || !game.winners?.length) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  const impact = settlementImpact(game.winners);
  panel.className = `settlementPanel settlementTier${impact.tier}`;
  panel.innerHTML = `
    <div class="settlementTitle">${escapeHtml(impact.title)}</div>
    ${game.winners.map((winner) => `
      <div class="settlementWinner${winner === impact.bestWinner ? " primaryWinner" : ""}">
      <div class="settlementRow">
        <span>${escapeHtml(winner.pot || "底池")}</span>
        <strong>${escapeHtml(winner.username)} +${winner.amount}</strong>
        <em>${escapeHtml(winner.hand || "")}</em>
      </div>
      ${winner.bestCards?.length ? `<div class="settlementBestCards"><span class="settlementBestLabel">最佳5张</span>${winner.bestCards.map(cardHtml).join("")}</div>` : ""}
      </div>
    `).join("")}
    ${(settlement.lastHand || []).length ? `
      <div class="handPointsTitle">本手积分（所有人）</div>
      <div class="handPoints">
        ${([...settlement.lastHand].sort((a, b) => b.delta - a.delta)).map((row) => `
          <div class="handPointRow${row.isWinner ? " isWinner" : ""}">
            <span class="handPointName">${escapeHtml(row.username)}</span>
            <span class="handPointResult">${escapeHtml(row.result || (row.delta === 0 ? "未参与" : ""))}</span>
            <strong class="handPointDelta ${row.delta >= 0 ? "gain" : "loss"}">${row.delta >= 0 ? "+" : ""}${row.delta}</strong>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${(settlement.scoreboard || []).length ? `
      <div class="scoreboardTitle">本房积分结算</div>
      <div class="scoreboard">
        ${settlement.scoreboard.map((player) => `
          <div class="scoreboardRow">
            <span>${escapeHtml(player.username)}</span>
            <span>${player.chips} / ${player.buyIn}</span>
            <strong class="${player.net >= 0 ? "gain" : "loss"}">${player.net >= 0 ? "+" : ""}${player.net}</strong>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;
  panel.classList.remove("hidden");
}

function maybeAnimateSettlement(snapshot) {
  if (snapshot.game.status !== "showdown" || !snapshot.game.winners?.length) return;
  const key = `${snapshot.room.id}:${snapshot.game.handNumber}:${snapshot.game.winners.map((winner) => `${winner.seat}-${winner.amount}-${winner.pot}`).join("|")}`;
  if (state.animatedSettlementKey === key) return;
  state.animatedSettlementKey = key;
  setTimeout(() => animatePotToWinners(snapshot.game.winners), 120);
  setTimeout(() => animateHandCelebration(snapshot.game.winners), 360);
}

function settlementImpact(winners) {
  const best = (winners || []).reduce((acc, winner) => {
    const power = handPowerFromWinner(winner);
    const amount = Number(winner.amount || 0);
    const score = power * 100000 + amount;
    return score > acc.score ? { winner, power, amount, score } : acc;
  }, { winner: null, power: 0, amount: 0, score: -1 });
  const total = (winners || []).reduce((sum, winner) => sum + Number(winner.amount || 0), 0);
  const amountTier = total >= 800 ? 3 : total >= 300 ? 2 : total >= 80 ? 1 : 0;
  const handTier = best.power >= 7 ? 4 : best.power >= 5 ? 3 : best.power >= 3 ? 2 : best.power >= 1 ? 1 : 0;
  const tier = Math.min(5, Math.max(amountTier, handTier));
  const title = tier >= 5 ? "爆炸奖池" : tier >= 4 ? "高能结算" : tier >= 3 ? "大牌命中" : tier >= 2 ? "漂亮收池" : "奖池分配";
  return { tier, title, power: best.power, amount: best.amount, total, bestWinner: best.winner };
}

function animatePotToWinners(winners) {
  const pot = $(".pot");
  const host = roomView;
  if (!pot || !host) return;
  const base = host.getBoundingClientRect();
  const potRect = pot.getBoundingClientRect();
  playChipSound(0.5);
  const impact = settlementImpact(winners);
  winners.forEach((winner, winnerIndex) => {
    const target = winnerTarget(winner);
    if (!target) return;
    const targetRect = target.getBoundingClientRect();
    const chips = Math.min(24, Math.max(5 + impact.tier * 2, Math.ceil(Number(winner.amount || 0) / 16)));
    for (let i = 0; i < chips; i += 1) {
      const chip = document.createElement("span");
      chip.className = `flyingChip settlementChip settlementChipTier${impact.tier}`;
      const startX = potRect.left + potRect.width / 2 - base.left;
      const startY = potRect.top + potRect.height / 2 - base.top;
      const spread = 10 + impact.tier * 4;
      const endX = targetRect.left + targetRect.width / 2 - base.left + (i % 5 - 2) * spread;
      const endY = targetRect.top + targetRect.height / 2 - base.top + (Math.floor(i / 5) - 1) * Math.max(8, spread - 3);
      chip.style.left = `${startX}px`;
      chip.style.top = `${startY}px`;
      chip.style.setProperty("--dx", `${endX - startX}px`);
      chip.style.setProperty("--dy", `${endY - startY}px`);
      chip.style.animationDelay = `${winnerIndex * 0.16 + i * Math.max(0.025, 0.055 - impact.tier * 0.005)}s`;
      host.appendChild(chip);
      setTimeout(() => chip.remove(), 1500 + winnerIndex * 200 + i * 60);
    }
    setTimeout(() => {
      target.classList.add("winnerAvatarPulse", `winnerTier${impact.tier}`);
      burstOnWinnerAvatar(target, impact.tier, winnerIndex);
      setTimeout(() => target.classList.remove("winnerAvatarPulse", `winnerTier${impact.tier}`), 1000 + impact.tier * 180);
    }, winnerIndex * 220 + 520);
  });
}

function winnerTarget(winner) {
  const seat = Number.isInteger(winner.seat) ? document.querySelector(`[data-seat="${winner.seat}"]`) : null;
  return seat?.querySelector(".seatAvatar") || seat;
}

function burstOnWinnerAvatar(target, tier, winnerIndex = 0) {
  const host = roomView;
  if (!target || !host) return;
  const base = host.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2 - base.left;
  const centerY = rect.top + rect.height / 2 - base.top;
  const count = 16 + tier * 10;
  for (let i = 0; i < count; i += 1) {
    const particle = document.createElement("span");
    particle.className = `avatarPrizeBurst avatarPrizeBurstTier${tier}`;
    const angle = (Math.PI * 2 * i) / count;
    const radius = 42 + tier * 16 + Math.random() * (24 + tier * 10);
    particle.style.left = `${centerX}px`;
    particle.style.top = `${centerY}px`;
    particle.style.setProperty("--x", `${Math.cos(angle) * radius}px`);
    particle.style.setProperty("--y", `${Math.sin(angle) * radius}px`);
    particle.style.setProperty("--delay", `${winnerIndex * 0.08 + Math.random() * 0.12}s`);
    host.appendChild(particle);
    setTimeout(() => particle.remove(), 1400 + tier * 150);
  }
}

function handPowerFromWinner(winner) {
  const hand = String(winner.hand || "");
  const rule = HAND_RULES.find((item) => hand.startsWith(item.name));
  return rule ? rule.power : 0;
}

function animateHandCelebration(winners) {
  const host = roomView;
  if (!host || !winners?.length) return;
  const best = winners.reduce((acc, winner) => {
    const power = handPowerFromWinner(winner);
    return power > acc.power ? { power, winner } : acc;
  }, { power: 0, winner: winners[0] });
  const power = best.power;
  const impact = settlementImpact(winners);
  playSettlementSound(power);
  const overlay = document.createElement("div");
  const target = winnerTarget(best.winner);
  if (!target) return;
  const base = host.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  overlay.className = `celebrationOverlay winnerCelebration celebrationPower${Math.min(8, power)} celebrationTier${impact.tier}`;
  overlay.style.left = `${targetRect.left + targetRect.width / 2 - base.left}px`;
  overlay.style.top = `${targetRect.top - base.top}px`;
  overlay.style.setProperty("--celebration-scale", String(1 + impact.tier * 0.18));
  const burstCount = Math.min(130, (power >= 8 ? 78 : power >= 7 ? 64 : power >= 6 ? 48 : power >= 4 ? 34 : power >= 2 ? 22 : 10) + impact.tier * 10);
  overlay.innerHTML = `
    <div class="celebrationTitle">
      <strong>${escapeHtml(best.winner.hand || "赢得底池")}</strong>
      <span>${escapeHtml(best.winner.username || "")} +${escapeHtml(best.winner.amount || "")}</span>
      ${best.winner.bestCards?.length ? `<div class="celebrationCards">${best.winner.bestCards.map(cardHtml).join("")}</div>` : ""}
    </div>
  `;
  for (let i = 0; i < burstCount; i += 1) {
    const particle = document.createElement("span");
    particle.className = power >= 6 ? "fireworkParticle" : "sparkParticle";
    const angle = (Math.PI * 2 * i) / burstCount;
    const radius = 100 + impact.tier * 34 + Math.random() * (power >= 6 ? 260 + impact.tier * 42 : 130 + impact.tier * 26);
    particle.style.setProperty("--x", `${Math.cos(angle) * radius}px`);
    particle.style.setProperty("--y", `${Math.sin(angle) * radius}px`);
    particle.style.setProperty("--delay", `${Math.random() * 0.42}s`);
    particle.style.setProperty("--hue", `${38 + Math.random() * 290}`);
    overlay.appendChild(particle);
  }
  for (let i = 0; i < impact.tier; i += 1) {
    const ring = document.createElement("span");
    ring.className = "celebrationRing";
    ring.style.setProperty("--delay", `${i * 0.16}s`);
    overlay.appendChild(ring);
  }
  host.appendChild(overlay);
  setTimeout(() => overlay.remove(), 2400 + power * 190 + impact.tier * 120);
}

function clearCountdown(hide = true) {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  state.countdownAlertKey = "";
  document.querySelectorAll(".seat.timeWarning").forEach((seat) => seat.classList.remove("timeWarning"));
  roomView.style.removeProperty("--turn-progress");
  roomView.style.removeProperty("--turn-color");
  if (hide) $("#turnCountdown")?.classList.add("hidden");
}

function openEmoteMenu(targetSeat) {
  const snapshot = state.roomState;
  if (!snapshot || !state.user) return;
  const mySeat = snapshot.seats.find((seat) => seat && seat.userId === state.user.id);
  if (!mySeat) {
    showToast("先坐下，再互动。", "warn");
    return;
  }
  const explicitTargetSeat = Number.isInteger(targetSeat) && targetSeat !== mySeat.seat ? targetSeat : null;
  const target = explicitTargetSeat !== null ? snapshot.seats[explicitTargetSeat] : null;
  if (explicitTargetSeat !== null && !target) return;
  closeEmoteMenu();
  state.emoteMenuTargetSeat = explicitTargetSeat;

  const anchorSeat = explicitTargetSeat !== null ? explicitTargetSeat : mySeat.seat;
  const anchorSeatEl = document.querySelector(`[data-seat="${anchorSeat}"]`);
  const surface = $(".tableSurface");
  const host = roomView;
  if (!anchorSeatEl || !surface) return;
  const base = host.getBoundingClientRect();
  const seatRect = (anchorSeatEl.querySelector(".seatAvatar") || anchorSeatEl).getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = "emoteBubble";
  bubble.innerHTML = `
    ${target ? `<div class="emoteBubbleHint">对 ${escapeHtml(target.username)} 说：</div>` : ""}
    <div class="emoteBubbleTail"></div>
    ${EMOTES.map((emote, index) => `
      <button type="button" class="emoteBubbleChoice emoteChoice${index}" data-emote="${emote.key}">
        ${escapeHtml(explicitTargetSeat !== null ? `你${emote.text}` : emote.text)}
      </button>
    `).join("")}
  `;
  const centerX = seatRect.left + seatRect.width / 2 - base.left;
  const clampedX = Math.min(Math.max(centerX, 118), Math.max(118, base.width - 118));
  const fromBottom = base.bottom - seatRect.top;
  const nearBottom = seatRect.top > surfaceRect.top + surfaceRect.height * 0.58;
  bubble.style.left = `${clampedX}px`;
  if (nearBottom) {
    bubble.style.bottom = `${fromBottom + 12}px`;
  } else {
    bubble.style.top = `${seatRect.bottom - base.top + 12}px`;
    bubble.classList.add("dropDown");
  }
  host.appendChild(bubble);
  bubble.querySelectorAll("[data-emote]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      sendEmote(button.dataset.emote, state.emoteMenuTargetSeat);
    });
  });
}

function closeEmoteMenu() {
  document.querySelectorAll(".emoteBubble").forEach((menu) => menu.remove());
  state.emoteMenuTargetSeat = null;
}

async function openDealerTipMenu() {
  const snapshot = state.roomState;
  if (!snapshot || !state.user) return;
  const mySeat = snapshot.seats.find((seat) => seat && seat.userId === state.user.id);
  const canTip = Boolean(mySeat) && ["waiting", "showdown"].includes(snapshot.game.status);
  closeEmoteMenu();
  closeDealerTipMenu();

  const dealerEl = $("#dealerSpot");
  const surface = $(".tableSurface");
  const host = roomView;
  if (!dealerEl || !surface) return;
  const base = host.getBoundingClientRect();
  const seatRect = dealerEl.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = "dealerTipBubble";

  const dealersPerPage = 4;
  const dealerPageCount = Math.max(1, Math.ceil(state.dealers.length / dealersPerPage));
  state.dealerPage = Math.min(Math.max(0, state.dealerPage), dealerPageCount - 1);
  const dealerThumbs = state.dealers
    .slice(state.dealerPage * dealersPerPage, (state.dealerPage + 1) * dealersPerPage)
    .map((dealer) => {
      const current = snapshot.game.dealerImage?.includes(encodeURIComponent(dealer.name));
      const selected = current ? " selected" : "";
      return `<button class="dealerThumb${selected}" type="button" data-dealer="${escapeHtml(dealer.name)}" title="${escapeHtml(dealer.displayName)}">
        <img src="${dealer.url}" alt="${escapeHtml(dealer.displayName)}">
        <span>${escapeHtml(dealer.displayName)}</span>
      </button>`;
    })
    .join("");

  bubble.innerHTML = `
    <div class="dealerTipTail"></div>
    ${canTip ? `
      <div class="dealerTipControls">
        <input class="dealerTipBubbleAmount" type="number" min="1" step="1" value="5">
        <button type="button" class="dealerTipBubbleButton">打赏</button>
      </div>
    ` : `<p class="dealerTipUnavailable">仅等待或结算时可打赏</p>`}
    <div class="dealerPickerRow">
      <button class="dealerPager" type="button" data-dealer-page="previous" aria-label="上一页荷官"${state.dealerPage === 0 ? " disabled" : ""}>‹</button>
      <div class="dealerSwitchGrid">${dealerThumbs || `<p class="hint">暂无荷官可选</p>`}</div>
      <button class="dealerPager" type="button" data-dealer-page="next" aria-label="下一页荷官"${state.dealerPage >= dealerPageCount - 1 ? " disabled" : ""}>›</button>
    </div>
    ${state.dealers.length > dealersPerPage ? `<span class="dealerPage">${state.dealerPage + 1}/${dealerPageCount}</span>` : ""}
  `;
  const centerX = seatRect.left + seatRect.width / 2 - base.left;
  const halfWidth = Math.min(160, Math.max(100, (base.width - 20) / 2));
  const clampedX = Math.min(Math.max(centerX, halfWidth + 6), Math.max(halfWidth + 6, base.width - halfWidth - 6));
  const fromBottom = base.bottom - seatRect.top;
  const nearBottom = seatRect.top > surfaceRect.top + surfaceRect.height * 0.58;
  bubble.style.left = `${clampedX}px`;
  if (nearBottom) {
    bubble.style.bottom = `${fromBottom + 12}px`;
  } else {
    bubble.style.top = `${seatRect.bottom - base.top + 12}px`;
    bubble.classList.add("dropDown");
  }
  host.appendChild(bubble);
  const input = bubble.querySelector(".dealerTipBubbleAmount");
  const button = bubble.querySelector(".dealerTipBubbleButton");
  if (input && button) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      tipDealer(Number(input.value || 5));
    });
    input.addEventListener("click", (event) => event.stopPropagation());
  }
  bubble.querySelectorAll("[data-dealer]").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      send({ type: "switchDealer", dealer: item.dataset.dealer });
      closeDealerTipMenu();
    });
  });
  bubble.querySelectorAll("[data-dealer-page]").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      state.dealerPage += item.dataset.dealerPage === "next" ? 1 : -1;
      openDealerTipMenu();
    });
  });
}

function closeDealerTipMenu() {
  document.querySelectorAll(".dealerTipBubble").forEach((menu) => menu.remove());
}

function displayAvatarUrl(name) {
  const avatar = state.avatars.find((item) => item.name === name);
  return avatar?.displayUrl || `/avatars/${encodeURIComponent(name)}`;
}

async function normalizeAvatarUrl(url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch {
    return url;
  }

  const source = document.createElement("canvas");
  source.width = image.naturalWidth || image.width;
  source.height = image.naturalHeight || image.height;
  if (!source.width || !source.height) return url;
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  sourceContext.drawImage(image, 0, 0);
  const pixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = pixels[(y * source.width + x) * 4 + 3];
      if (alpha > 12) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) return url;

  const outputSize = 112;
  const padding = 6;
  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const scale = Math.min((outputSize - padding * 2) / cropWidth, (outputSize - padding * 2) / cropHeight);
  const drawWidth = Math.round(cropWidth * scale);
  const drawHeight = Math.round(cropHeight * scale);
  const output = document.createElement("canvas");
  output.width = outputSize;
  output.height = outputSize;
  const outputContext = output.getContext("2d");
  outputContext.drawImage(
    source,
    minX,
    minY,
    cropWidth,
    cropHeight,
    Math.round((outputSize - drawWidth) / 2),
    Math.round((outputSize - drawHeight) / 2),
    drawWidth,
    drawHeight
  );
  return output.toDataURL("image/png");
}

function renderInteraction(interaction) {
  if (!interaction || !state.roomState) return;
  if (interaction.kind === "chipsToPot") {
    animateSeatToPot(interaction.fromSeat, interaction.amount);
    return;
  }
  playInteractionVoice(interaction);
  const isDealerTip = interaction.kind === "dealerTip";
  const anchor = isDealerTip
    ? $("#dealerSpot")
    : Number.isInteger(interaction.targetSeat)
    ? document.querySelector(`[data-seat="${interaction.targetSeat}"]`)
    : $(".pot");
  const origin = Number.isInteger(interaction.fromSeat)
    ? document.querySelector(`[data-seat="${interaction.fromSeat}"]`)
    : null;
  const effectHost = roomView;
  const base = effectHost.getBoundingClientRect();
  const rect = (anchor || $(".tableSurface") || effectHost).getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = `tableEffect ${isDealerTip ? "tipEffect dealerSpeech" : ""} ${interaction.kind === "chatBubble" ? "chatEffect" : ""}`;
  bubble.textContent = isDealerTip && interaction.dealerReply && !interaction.quiet
    ? interaction.dealerReply
    : interaction.text || "";
  bubble.style.left = `${rect.left + rect.width / 2 - base.left}px`;
  bubble.style.top = `${rect.top - base.top}px`;
  effectHost.appendChild(bubble);
  [anchor, origin].filter(Boolean).forEach((node) => {
    const avatar = node.querySelector?.(".seatAvatar") || node;
    avatar.classList.remove("bump");
    void avatar.offsetWidth;
    avatar.classList.add("bump");
    setTimeout(() => avatar.classList.remove("bump"), 700);
  });
  setTimeout(() => bubble.remove(), 1800);
}

function animateSeatToPot(fromSeat, amount) {
  const source = Number.isInteger(fromSeat) ? document.querySelector(`[data-seat="${fromSeat}"]`) : null;
  const pot = $(".pot");
  const host = roomView;
  if (!source || !pot || !host) return;
  const base = host.getBoundingClientRect();
  const sourceRect = source.getBoundingClientRect();
  const potRect = pot.getBoundingClientRect();
  const startX = sourceRect.left + sourceRect.width / 2 - base.left;
  const startY = sourceRect.top + sourceRect.height / 2 - base.top;
  const endX = potRect.left + potRect.width / 2 - base.left;
  const endY = potRect.top + potRect.height / 2 - base.top;
  const chips = Math.min(9, Math.max(3, Math.ceil(Number(amount || 0) / 15)));
  playChipSound(0.42);
  for (let i = 0; i < chips; i += 1) {
    const chip = document.createElement("span");
    chip.className = "flyingChip betChip";
    chip.style.left = `${startX + (i % 3 - 1) * 8}px`;
    chip.style.top = `${startY + (Math.floor(i / 3) - 1) * 7}px`;
    chip.style.setProperty("--dx", `${endX - startX}px`);
    chip.style.setProperty("--dy", `${endY - startY}px`);
    chip.style.animationDelay = `${i * 0.045}s`;
    host.appendChild(chip);
    setTimeout(() => chip.remove(), 1300 + i * 55);
  }
  source.classList.add("betPulse");
  setTimeout(() => source.classList.remove("betPulse"), 520);
  showPotGain(amount);
}

function showPotGain(amount) {
  const pot = $(".pot");
  if (!pot) return;
  const gain = document.createElement("span");
  gain.className = "potGain";
  gain.textContent = `+${amount}`;
  pot.appendChild(gain);
  setTimeout(() => gain.remove(), 950);
}

function playInteractionVoice(interaction) {
  if (interaction.kind !== "emote" || !interaction.text || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(interaction.text);
  utterance.lang = "zh-CN";
  utterance.rate = 1.08;
  utterance.pitch = 1.02;
  const voices = window.speechSynthesis.getVoices();
  const chineseVoice = voices.find((voice) => /zh|Chinese|中文/i.test(`${voice.lang} ${voice.name}`));
  if (chineseVoice) utterance.voice = chineseVoice;
  window.speechSynthesis.speak(utterance);
}

function fairnessHtml(game) {
  const last = escapeHtml(game.lastAction || "");
  const commit = game.fairness?.deckCommit || "";
  if (!commit) return last;
  const shortCommit = commit.slice(0, 12);
  const verifyKey = fairnessKey(game);
  const verifiedText = state.fairnessChecks.get(verifyKey);
  const verified = game.fairness.seed && game.fairness.deck?.length
    ? ` · 已公开种子 ${escapeHtml(game.fairness.seed.slice(0, 8))} · <span id="fairnessVerify">${escapeHtml(verifiedText || "验证中")}</span>`
    : "";
  return `${last}<br><span class="fairness">公平哈希 ${escapeHtml(shortCommit)}${verified}</span>`;
}

function fairnessKey(game) {
  return `${game.handNumber}:${game.fairness?.deckCommit || ""}`;
}

async function updateFairnessVerification(game) {
  const proof = game.fairness;
  if (!proof?.seed || !proof.deck?.length || !proof.deckCommit || !crypto.subtle) return;
  const key = fairnessKey(game);
  if (state.fairnessChecks.has(key)) return;
  state.fairnessChecks.set(key, "验证中");
  const input = `${proof.seed}:${proof.deck.join(",")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  state.fairnessChecks.set(key, hash === proof.deckCommit ? "验证通过" : "验证失败");
  const label = $("#fairnessVerify");
  if (label && state.roomState?.game?.handNumber === game.handNumber) {
    label.textContent = state.fairnessChecks.get(key);
    label.className = hash === proof.deckCommit ? "fairnessOk" : "fairnessBad";
  }
}

function cardHtml(card) {
  if (card === "??") return `<span class="card back"></span>`;
  const suit = card[1];
  const suitText = { s: "♠", h: "♥", d: "♦", c: "♣" }[suit] || suit;
  const red = suit === "h" || suit === "d" ? " red" : "";
  const rankText = card[0] === "T" ? "10" : card[0];
  return `<span class="card${red}"><span class="cardRank">${rankText}</span><span class="cardSuit">${suitText}</span></span>`;
}

function statusText(status) {
  return {
    waiting: "等待",
    preflop: "翻牌前",
    flop: "翻牌圈",
    turn: "转牌圈",
    river: "河牌圈",
    showdown: "结算"
  }[status] || status;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
