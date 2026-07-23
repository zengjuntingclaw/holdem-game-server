"use strict";

// 独立校验：room_settlements 表 DDL、INSERT、SELECT 与积分(delta)计算逻辑。
// 不依赖运行中的服务器，使用 node:sqlite 内存库复刻 server.js 中的真实 SQL。
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE IF NOT EXISTS room_settlements (
    room_id TEXT NOT NULL,
    hand_number INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    chips_before INTEGER NOT NULL,
    chips_after INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    committed INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '',
    is_winner INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, hand_number, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_room_settlements_room_hand ON room_settlements(room_id, hand_number);
  CREATE INDEX IF NOT EXISTS idx_room_settlements_room_user ON room_settlements(room_id, user_id, hand_number);
`);
console.log("ok - DDL 创建成功（与 server.js 一致）");

// 复刻 recordHandSettlement 的积分计算
function computeRows(roomId, handNumber, seats, winners) {
  const now = Date.now();
  const rows = [];
  for (const player of seats) {
    const chipsBefore = Number.isFinite(player.startHandChips) ? player.startHandChips : player.chips;
    const chipsAfter = player.chips;
    const delta = chipsAfter - chipsBefore;
    rows.push({
      roomId,
      handNumber,
      userId: player.userId,
      username: player.username,
      chipsBefore,
      chipsAfter,
      delta,
      committed: player.committed || 0,
      result: player.result || "",
      isWinner: winners.some((w) => w.userId === player.userId) ? 1 : 0,
      createdAt: now
    });
  }
  return rows;
}

// 模拟一手牌：3 名玩家，盲注后有人弃牌，A 赢得底池
const seats = [
  { userId: "u1", username: "甲", startHandChips: 1000, chips: 1150, committed: 50, result: "葫芦，赢得 150", },
  { userId: "u2", username: "乙", startHandChips: 1000, chips: 950, committed: 50, result: "弃牌" },
  { userId: "u3", username: "丙", startHandChips: 1000, chips: 900, committed: 100, result: "一对" }
];
// 甲本手净 +150（赢得 150），乙 -50，丙 -100；合计应为 0（筹码守恒）
const rows = computeRows("ROOM1", 1, seats, [{ userId: "u1" }]);

const stmt = db.prepare(`
  INSERT OR REPLACE INTO room_settlements (
    room_id, hand_number, user_id, username, chips_before, chips_after,
    delta, committed, result, is_winner, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const r of rows) {
  stmt.run(r.roomId, r.handNumber, r.userId, r.username, r.chipsBefore, r.chipsAfter, r.delta, r.committed, r.result, r.isWinner, r.createdAt);
}
console.log("ok - INSERT 成功，写入 " + rows.length + " 行");

// 复刻 history 接口的 SELECT（列别名与 server.js 一致）
const selected = db.prepare(`
  SELECT room_id AS roomId, hand_number AS handNumber, user_id AS userId, username,
         chips_before AS chipsBefore, chips_after AS chipsAfter, delta, committed,
         result, is_winner AS isWinner, created_at AS createdAt
  FROM room_settlements
  WHERE room_id = ?
  ORDER BY hand_number DESC, delta DESC
  LIMIT ?
`).all("ROOM1", 300);
console.log("ok - SELECT 成功，返回 " + selected.length + " 行");

// 断言
const assert = require("node:assert/strict");
assert.equal(selected.length, 3, "应返回 3 名玩家");
const sumDelta = selected.reduce((s, r) => s + r.delta, 0);
assert.equal(sumDelta, 0, "本手所有玩家 delta 之和必须为 0（筹码守恒），实际=" + sumDelta);
const winner = selected.find((r) => r.isWinner === 1);
assert.equal(winner.username, "甲", "赢家应为甲");
assert.equal(winner.delta, 150, "甲 delta 应为 +150");
assert.ok(selected.every((r) => r.chipsAfter - r.chipsBefore === r.delta), "chipsAfter - chipsBefore 必须等于 delta");
assert.ok(selected.every((r) => typeof r.createdAt === "number"), "createdAt 必须为数字");

console.log("PASS - 牌局结算积分记录逻辑与 SQL 全部校验通过");
console.log(JSON.stringify(selected, null, 2));
