"use strict";

const $ = (selector) => document.querySelector(selector);
const CLIENT_VERSION = "0.1.12";
const DEFAULT_WAGER_AMOUNT = 20;
const EMOTES = [
  { key: "wellPlayed", text: "打得不错" },
  { key: "amazing", text: "真棒" },
  { key: "hello", text: "你好" },
  { key: "oops", text: "抱歉" },
  { key: "wow", text: "哇哦" }
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
  lastRoomId: localStorage.getItem("pokerLastRoomId") || "",
  lastWagerAmount: Number(localStorage.getItem("pokerLastWagerAmount") || DEFAULT_WAGER_AMOUNT)
};

const authView = $("#authView");
const appView = $("#appView");
const lobbyView = $("#lobbyView");
const roomView = $("#roomView");
const authError = $("#authError");

$("#loginBtn").addEventListener("click", () => auth("login"));
$("#registerBtn").addEventListener("click", () => auth("register"));
$("#sendCodeBtn").addEventListener("click", requestEmailCode);
$("#codeLoginBtn").addEventListener("click", verifyEmailCode);
$("#logoutBtn").addEventListener("click", logout);
$("#createRoomBtn").addEventListener("click", createRoom);
$("#refreshRoomsBtn").addEventListener("click", loadRooms);
$("#backLobbyBtn").addEventListener("click", attemptBackLobby);
$("#startHandBtn").addEventListener("click", () => send({ type: "startHand" }));
$("#readyBtn").addEventListener("click", toggleReady);
$("#standBtn").addEventListener("click", () => send({ type: "stand" }));
$("#randomAvatarBtn").addEventListener("click", () => send({ type: "switchAvatar" }));
$("#sendEmoteBtn").addEventListener("click", () => sendEmote());
$("#dealerTipBtn").addEventListener("click", tipDealer);
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
document.querySelectorAll("[data-bet-multiple]").forEach((button) => {
  button.addEventListener("click", () => chooseBetMultiple(Number(button.dataset.betMultiple)));
});
$("#allInBtn").addEventListener("click", chooseAllIn);
$("#presetFoldBtn").addEventListener("click", () => sendPresetAction("fold"));
$("#presetCheckCallBtn").addEventListener("click", () => sendPresetAction("checkCall"));
$("#presetBetRaiseBtn").addEventListener("click", () => sendPresetAction("betRaise"));
$("#presetClearBtn").addEventListener("click", () => sendPresetAction("clear"));
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
$("#dealerSpot").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  openDealerTipMenu();
});

boot();

async function boot() {
  renderRulesSidebar();
  setVersionLabel(CLIENT_VERSION);
  if (!state.token) {
    showAuth();
    return;
  }
  try {
    const data = await api("/api/me");
    state.user = data.user;
    showApp();
    await loadAvatars();
    connect();
    await loadRooms();
  } catch {
    logout();
  }
}

async function auth(mode) {
  authError.textContent = "";
  const email = $("#email").value.trim();
  const username = $("#username").value.trim();
  const password = $("#password").value;
  try {
    const data = await api(`/api/${mode}`, {
      method: "POST",
      body: JSON.stringify({ email, username, password })
    }, false);
    if (data.requiresVerification) {
      authError.innerHTML = data.devCode
        ? `${escapeHtml(data.message)}：<span class="devCode">${escapeHtml(data.devCode)}</span>`
        : escapeHtml(data.message || "请先完成邮箱验证码验证");
      $("#emailCode").focus();
      return;
    }
    await enterApp(data);
  } catch (error) {
    authError.textContent = error.message;
  }
}

async function requestEmailCode() {
  authError.textContent = "";
  const email = $("#email").value.trim();
  const button = $("#sendCodeBtn");
  button.disabled = true;
  try {
    const data = await api("/api/email-code/request", {
      method: "POST",
      body: JSON.stringify({ email })
    }, false);
    authError.innerHTML = data.devCode
      ? `本地验证码：<span class="devCode">${data.devCode}</span>`
      : data.message;
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    setTimeout(() => {
      button.disabled = false;
    }, 3000);
  }
}

async function verifyEmailCode() {
  authError.textContent = "";
  const email = $("#email").value.trim();
  const code = $("#emailCode").value.trim();
  try {
    const data = await api("/api/email-code/verify", {
      method: "POST",
      body: JSON.stringify({ email, code })
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
  connect();
  await loadRooms();
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
    setTimeout(() => state.token && connect(), 1200);
  });
  state.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "hello" || message.type === "lobby") {
      if (message.serverNow) {
        state.serverOffsetMs = Date.now() - message.serverNow;
      }
      state.rooms = message.rooms || [];
      if (message.version) setVersionLabel(message.version);
      renderRooms();
      if (!state.roomState && message.music) syncBgm(message.music, "lobby");
    } else if (message.type === "roomState") {
      if (message.game?.serverNow) {
        state.serverOffsetMs = Date.now() - message.game.serverNow;
      }
      state.roomState = message;
      state.lastRoomId = message.room.id;
      localStorage.setItem("pokerLastRoomId", state.lastRoomId);
      if (message.version) setVersionLabel(message.version);
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
  rememberWagerAmount(value);
}

function chooseBetMultiple(multiple) {
  const snapshot = state.roomState;
  if (!snapshot) return;
  const mySeat = snapshot.seats.find((seat) => seat && seat.userId === state.user.id);
  if (!mySeat) return;
  const target = snapshot.room.bigBlind * multiple;
  setBetAmount(Math.max(minimumWagerTotal(snapshot, mySeat), target));
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
  rememberWagerAmount(value);
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
    const minRaise = Number(snapshot.game.minRaise || snapshot.room.bigBlind || 1);
    return Math.min(mySeat.bet + mySeat.chips, snapshot.game.currentBet + minRaise);
  }
  return Math.min(mySeat.bet + mySeat.chips, snapshot.room.bigBlind);
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
  const data = await api("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name, smallBlind, bigBlind, startingChips })
  });
  joinRoom(data.room.id);
}

function joinRoom(roomId) {
  state.lastRoomId = String(roomId || "").toUpperCase();
  localStorage.setItem("pokerLastRoomId", state.lastRoomId);
  showRoom();
  send({ type: "joinRoom", roomId });
}

function logout() {
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
  authView.classList.remove("hidden");
  appView.classList.add("hidden");
  $("#supportDrawer")?.classList.add("hidden");
}

function showApp() {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  $("#userLabel").textContent = state.user ? state.user.username : "未登录";
  setVersionLabel(state.version || CLIENT_VERSION);
  if (!lobbyView.classList.contains("hidden")) $("#supportDrawer")?.classList.remove("hidden");
  updateBgmToggle();
}

function showLobby() {
  if (state.roomState) send({ type: "leaveRoom" });
  lobbyView.classList.remove("hidden");
  roomView.classList.add("hidden");
  $("#supportDrawer")?.classList.remove("hidden");
  state.roomState = null;
  clearCountdown();
  loadRooms();
}

function showRoom() {
  lobbyView.classList.add("hidden");
  roomView.classList.remove("hidden");
  closeSupportDrawer();
  $("#supportDrawer")?.classList.add("hidden");
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

function setVersionLabel(version) {
  state.version = version || CLIENT_VERSION;
  const label = $("#versionLabel");
  if (label) label.textContent = `v${state.version}`;
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
  $("#rulesDrawer")?.classList.remove("open");
  $("#feedbackDrawer")?.classList.remove("open");
  $("#supportDrawer")?.classList.remove("open");
  updateSideDrawerLabels();
}

function updateSideDrawerLabels() {
  const rulesOpen = $("#rulesDrawer")?.classList.contains("open");
  const feedbackOpen = $("#feedbackDrawer")?.classList.contains("open");
  const supportOpen = $("#supportDrawer")?.classList.contains("open");
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
  $("#roomTitle").textContent = `${snapshot.room.name} #${snapshot.room.id}`;
  $("#handInfo").textContent = `${statusText(snapshot.game.status)} · 第 ${snapshot.game.handNumber} 手 · 盲注 ${snapshot.room.smallBlind}/${snapshot.room.bigBlind}`;
  $("#board").innerHTML = snapshot.game.board.map(cardHtml).join("") || `<span class="hint">等待发牌</span>`;
  $("#potValue").textContent = snapshot.game.pot;
  $("#lastAction").innerHTML = fairnessHtml(snapshot.game);
  updateFairnessVerification(snapshot.game);
  renderSettlement(snapshot.game);
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
  $("#readyBtn").textContent = mySeat?.ready ? "取消准备" : "准备";
  $("#readyBtn").disabled = !canReady;
  $("#readyBtn").classList.toggle("readyActive", canReady && !mySeat?.ready);
  $(".playbar").classList.toggle("myTurn", Boolean(isMyTurn));
  $(".playbar").classList.toggle("canPrepare", canReady && !mySeat?.ready);
  $("#standBtn").disabled = !mySeat || activeHand;
  $("#checkBtn").disabled = !isMyTurn || callAmount > 0;
  $("#callBtn").disabled = !isMyTurn || callAmount === 0;
  $("#foldBtn").disabled = !isMyTurn;
  $("#betBtn").disabled = !isMyTurn || snapshot.game.currentBet > 0 || maxWagerTotal < snapshot.room.bigBlind;
  $("#raiseBtn").disabled = !isMyTurn || snapshot.game.currentBet === 0 || maxWagerTotal <= snapshot.game.currentBet;
  renderWagerControls(snapshot, mySeat, isMyTurn, activeHand);
  $("#randomAvatarBtn").disabled = !mySeat || activeHand || !state.avatars.length;
  $("#dealerTipBtn").disabled = !mySeat || activeHand;
  renderPresetControls(snapshot, mySeat, activeHand);
  $("#startHandBtn").disabled = !snapshot.room.canStart;
  $("#startHandBtn").textContent = snapshot.room.canStart
    ? "开始下一手"
    : `等待准备 ${snapshot.room.readySeats}/${snapshot.room.seats}`;

  $("#seats").innerHTML = snapshot.seats.map((seat, index) => seatHtml(seat, index, snapshot.game, mySeat, activeHand)).join("");
  $("#seats").querySelectorAll("[data-sit]").forEach((button) => {
    button.addEventListener("click", () => send({ type: "sit", seat: Number(button.dataset.sit) }));
  });
  $("#seats").querySelectorAll(".seat:not(.empty)[data-seat]").forEach((seatEl) => {
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
  panel.classList.toggle("empty", items.length === 0);
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
  range.step = 1;
  range.value = current;
  input.min = min;
  input.max = max;
  input.value = current;
  range.disabled = !canAdjust;
  input.disabled = !canAdjust;
  $("#wagerHint").textContent = mySeat
    ? `最小 ${min} · 最大 ${max} · 剩余 ${mySeat.chips}`
    : "入座后可调整下注";
  $("#wagerMode").textContent = snapshot.game.currentBet > 0 ? "加注到" : "下注额";
  updateAmountValue(current);
  document.querySelectorAll("[data-bet-multiple], #allInBtn").forEach((button) => {
    button.disabled = !canAdjust;
  });
  $("#presetBetRaiseBtn").textContent = snapshot.game.currentBet > 0 ? "预加注" : "预下注";
  $("#actionButtons").classList.toggle("isMyTurn", Boolean(isMyTurn));
}

function renderPresetControls(snapshot, mySeat, activeHand) {
  const canPreset = Boolean(mySeat) && activeHand && mySeat.inHand && !mySeat.folded && !mySeat.allIn;
  const pending = mySeat?.pendingAction;
  const amount = pending?.amount ? ` ${pending.amount}` : "";
  const text = pending
    ? {
      fold: "预设：弃牌",
      checkCall: "预设：过牌/跟注",
      betRaise: `预设：下注/加注${amount}`
    }[pending.action] || "预设：已设置"
    : "预设：无";
  $("#presetStatus").textContent = text;
  ["#presetFoldBtn", "#presetCheckCallBtn", "#presetBetRaiseBtn", "#presetClearBtn"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = !canPreset;
  });
  $("#presetClearBtn").disabled = !canPreset || !pending;
}

function seatHtml(seat, index, game, mySeat, activeHand) {
  const posClass = `pos${index}`;
  if (!seat) {
    const disabled = mySeat && activeHand ? " disabled" : "";
    const label = mySeat ? "换座" : "坐下";
    return `<div class="seat empty ${posClass}" data-seat="${index}"><button class="secondary" data-sit="${index}"${disabled}>${label}</button></div>`;
  }
  const classes = ["seat", posClass];
  if (game.actingSeat === index) classes.push("active");
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
    <div class="${classes.join(" ")}" data-seat="${index}">
      ${avatarUrl
        ? `<img class="seatAvatar" src="${avatarUrl}" alt="">`
        : `<div class="seatAvatar fallbackAvatar">${initial}</div>`}
      <div class="seatBody">
        <div class="seatTop">
          <span class="seatName">${escapeHtml(seat.username)}</span>
          <span class="stack"><span class="chipIcon"></span>${seat.chips}</span>
        </div>
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

function renderSettlement(game) {
  const panel = $("#settlementPanel");
  if (game.status !== "showdown" || !game.winners?.length) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  panel.innerHTML = `
    <div class="settlementTitle">奖池分配</div>
    ${game.winners.map((winner) => `
      <div class="settlementRow">
        <span>${escapeHtml(winner.pot || "底池")}</span>
        <strong>${escapeHtml(winner.username)} +${winner.amount}</strong>
        <em>${escapeHtml(winner.hand || "")}</em>
      </div>
    `).join("")}
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

function animatePotToWinners(winners) {
  const pot = $(".pot");
  const host = roomView;
  if (!pot || !host) return;
  const base = host.getBoundingClientRect();
  const potRect = pot.getBoundingClientRect();
  playChipSound(0.5);
  winners.forEach((winner, winnerIndex) => {
    const target = Number.isInteger(winner.seat) ? document.querySelector(`[data-seat="${winner.seat}"]`) : null;
    if (!target) return;
    const targetRect = target.getBoundingClientRect();
    const chips = Math.min(10, Math.max(4, Math.ceil(Number(winner.amount || 0) / 20)));
    for (let i = 0; i < chips; i += 1) {
      const chip = document.createElement("span");
      chip.className = "flyingChip";
      const startX = potRect.left + potRect.width / 2 - base.left;
      const startY = potRect.top + potRect.height / 2 - base.top;
      const endX = targetRect.left + targetRect.width / 2 - base.left + (i % 3 - 1) * 10;
      const endY = targetRect.top + targetRect.height / 2 - base.top + (Math.floor(i / 3) - 1) * 8;
      chip.style.left = `${startX}px`;
      chip.style.top = `${startY}px`;
      chip.style.setProperty("--dx", `${endX - startX}px`);
      chip.style.setProperty("--dy", `${endY - startY}px`);
      chip.style.animationDelay = `${winnerIndex * 0.2 + i * 0.055}s`;
      host.appendChild(chip);
      setTimeout(() => chip.remove(), 1500 + winnerIndex * 200 + i * 60);
    }
    setTimeout(() => {
      target.classList.add("winnerPulse");
      setTimeout(() => target.classList.remove("winnerPulse"), 900);
    }, winnerIndex * 220 + 520);
  });
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
  playSettlementSound(power);
  const overlay = document.createElement("div");
  overlay.className = `celebrationOverlay celebrationPower${Math.min(8, power)}`;
  const burstCount = power >= 8 ? 70 : power >= 7 ? 58 : power >= 6 ? 44 : power >= 4 ? 30 : power >= 2 ? 18 : 8;
  overlay.innerHTML = `
    <div class="celebrationTitle">
      <strong>${escapeHtml(best.winner.hand || "赢得底池")}</strong>
      <span>${escapeHtml(best.winner.username || "")} +${escapeHtml(best.winner.amount || "")}</span>
    </div>
  `;
  for (let i = 0; i < burstCount; i += 1) {
    const particle = document.createElement("span");
    particle.className = power >= 6 ? "fireworkParticle" : "sparkParticle";
    const angle = (Math.PI * 2 * i) / burstCount;
    const radius = 90 + Math.random() * (power >= 6 ? 230 : 120);
    particle.style.setProperty("--x", `${Math.cos(angle) * radius}px`);
    particle.style.setProperty("--y", `${Math.sin(angle) * radius}px`);
    particle.style.setProperty("--delay", `${Math.random() * 0.42}s`);
    particle.style.setProperty("--hue", `${38 + Math.random() * 290}`);
    overlay.appendChild(particle);
  }
  host.appendChild(overlay);
  setTimeout(() => overlay.remove(), 2100 + power * 180);
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

  const mySeatEl = document.querySelector(`[data-seat="${mySeat.seat}"]`);
  const surface = $(".tableSurface");
  const host = roomView;
  if (!mySeatEl || !surface) return;
  const base = host.getBoundingClientRect();
  const seatRect = mySeatEl.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = "emoteBubble";
  bubble.innerHTML = `
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

function openDealerTipMenu() {
  const snapshot = state.roomState;
  if (!snapshot || !state.user) return;
  const mySeat = snapshot.seats.find((seat) => seat && seat.userId === state.user.id);
  if (!mySeat) {
    showToast("先坐下，再打赏荷官。", "warn");
    return;
  }
  if (!["waiting", "showdown"].includes(snapshot.game.status)) {
    showToast("手牌进行中不能打赏，以免影响下注筹码。", "warn");
    return;
  }
  closeEmoteMenu();
  closeDealerTipMenu();

  const mySeatEl = document.querySelector(`[data-seat="${mySeat.seat}"]`);
  const surface = $(".tableSurface");
  const host = roomView;
  if (!mySeatEl || !surface) return;
  const base = host.getBoundingClientRect();
  const seatRect = mySeatEl.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = "dealerTipBubble";
  bubble.innerHTML = `
    <div class="dealerTipTail"></div>
    <strong>打赏荷官</strong>
    <div class="dealerTipControls">
      <input class="dealerTipBubbleAmount" type="number" min="1" step="1" value="5">
      <button type="button" class="dealerTipBubbleButton">打赏</button>
    </div>
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
  const input = bubble.querySelector(".dealerTipBubbleAmount");
  bubble.querySelector(".dealerTipBubbleButton").addEventListener("click", (event) => {
    event.stopPropagation();
    tipDealer(Number(input.value || 5));
  });
  input.addEventListener("click", (event) => event.stopPropagation());
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
  if (card === "??") return `<span class="card back">?</span>`;
  const suit = card[1];
  const suitText = { s: "♠", h: "♥", d: "♦", c: "♣" }[suit] || suit;
  const red = suit === "h" || suit === "d" ? " red" : "";
  const rankText = card[0] === "T" ? "10" : card[0];
  return `<span class="card${red}">${rankText}${suitText}</span>`;
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
