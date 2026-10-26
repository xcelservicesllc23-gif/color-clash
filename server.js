const express = require("express");app.use(express.static('public'));const express = require('express');
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, app: "Color Clash" }));

const rooms = new Map();
const COLORS = [
  { name: "RED", hex: "#ff496c" }, { name: "BLUE", hex: "#42a5ff" },
  { name: "GREEN", hex: "#3ddc97" }, { name: "YELLOW", hex: "#ffd34e" },
  { name: "PURPLE", hex: "#b77bff" }, { name: "ORANGE", app.use(express.static('public'));hex: "#ff974d" }
];
const POWERUPS = ["HINT", "TIME FREEZE", "DOUBLE POINTS"];

function code() {
  let s;
  do { s = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (rooms.has(s));
  return s;
}
function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function roomOf(ws) { return ws.roomCode && rooms.get(ws.roomCode); }
function playerById(room, id) { return room.players.find(p => p.id === id); }
function publicRoom(room) {
  return {
    code: room.code, status: room.status, round: room.round, maxRounds: 5,
    hostId: room.hostId, players: room.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score,
      connected: p.connected, powerups: p.powerups, firsts: p.firsts,
      bestTime: p.bestTime
    })),
    challenge: room.challenge ? {
      target: room.challenge.target, tiles: room.challenge.tiles,
      endsAt: room.challenge.endsAt, number: room.challenge.number,
      answered: room.challenge.answered
    } : null,
    leaderboard: [...room.players].sort((a,b) => b.score-a.score || b.firsts-a.firsts || a.bestTime-b.bestTime)
      .map((p,i) => ({ id:p.id, name:p.name, score:p.score, rank:i+1 }))
  };
}
function broadcast(room) {
  const state = publicRoom(room);
  for (const p of room.players) if (p.ws) send(p.ws, "STATE", { state });
}
function notice(room, message, tone = "info") {
  for (const p of room.players) if (p.ws) send(p.ws, "NOTICE", { message, tone });
}
function makeChallenge(room) {
  const color = Math.floor(Math.random() * COLORS.length);
  const number = Math.floor(Math.random() * 9) + 1;
  const tiles = Array.from({length: 12}, () => ({
    color: Math.floor(Math.random()*COLORS.length),
    number: Math.floor(Math.random()*9)+1,
    gem: Math.random() < 0.09
  }));
  const targetIndex = Math.floor(Math.random()*tiles.length);
  tiles[targetIndex] = { color, number, gem: Math.random() < 0.2 };
  // Ensure the exact target occurs once.
  tiles.forEach((t, i) => { if (i !== targetIndex && t.color === color && t.number === number) {
    t.number = (t.number % 9) + 1;
  }});
  room.challenge = {
    target: { color, colorName: COLORS[color].name, hex: COLORS[color].hex, number },
    tiles, answered: [], number: (room.challengeNo || 0) + 1,
    endsAt: Date.now() + 12000, firstCorrectId: null, gemClaimed: false
  };
  room.challengeNo = room.challenge.number;
  room.status = "playing";
  broadcast(room);
  clearTimeout(room.challengeTimer);
  room.challengeTimer = setTimeout(() => finishChallenge(room.code), 12000);
}
function finishChallenge(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== "playing") return;
  room.status = "between";
  room.challenge = null;
  broadcast(room);
  if (room.challengeNo % 3 === 0) room.round = Math.min(5, Math.ceil(room.challengeNo / 3));
  if (room.challengeNo >= 15) return finishGame(room);
  clearTimeout(room.nextTimer);
  room.nextTimer = setTimeout(() => {
    const r = rooms.get(roomCode);
    if (r && r.status === "between") makeChallenge(r);
  }, 1800);
}
function finishGame(room) {
  room.status = "finished";
  room.challenge = null;
  const sorted = [...room.players].sort((a,b) => b.score-a.score || b.firsts-a.firsts || a.bestTime-b.bestTime);
  room.winnerId = sorted[0]?.id || null;
  broadcast(room);
  for (const p of room.players) if (p.ws) send(p.ws, "GAME_OVER", {
    winnerId: room.winnerId,
    winnerName: sorted[0]?.name || "Nobody",
    leaderboard: sorted.map((x,i)=>({rank:i+1,name:x.name,score:x.score}))
  });
}
function begin(room) {
  if (room.status !== "lobby" || room.players.filter(p=>p.connected).length < 2) return;
  room.status = "between"; room.round = 1; room.challengeNo = 0;
  broadcast(room);
  notice(room, "Get ready! First challenge starts now.", "good");
  makeChallenge(room);
}
function cleanRoom(room) {
  clearTimeout(room.challengeTimer); clearTimeout(room.nextTimer);
  rooms.delete(room.code);
}
wss.on("connection", ws => {
  ws.id = crypto.randomUUID();
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws,"ERROR",{message:"Invalid message."}); }
    if (msg.type === "CREATE") {
      if (ws.roomCode) return;
      const roomCode = code();
      const player = {
        id: ws.id, ws, name: String(msg.name || "Host").trim().slice(0,16) || "Host",
        avatar: String(msg.avatar || "💎"), score: 0, connected: true,
        powerups: ["HINT"], firsts: 0, bestTime: Infinity, doubleNext: false
      };
      const room = { code:roomCode, hostId:player.id, players:[player], status:"lobby", round:0, challenge:null };
      rooms.set(roomCode, room); ws.roomCode = roomCode;
      send(ws,"JOINED",{playerId:player.id,code:roomCode,isHost:true}); broadcast(room);
    } else if (msg.type === "JOIN") {
      const room = rooms.get(String(msg.code || "").toUpperCase());
      if (!room) return send(ws,"ERROR",{message:"Room code not found."});
      if (room.status !== "lobby") return send(ws,"ERROR",{message:"That game has already started."});
      if (room.players.length >= 8) return send(ws,"ERROR",{message:"Room is full (8 players maximum)."});
      if (ws.roomCode) return send(ws,"ERROR",{message:"You are already in a room."});
      const name = String(msg.name || "Player").trim().slice(0,16) || "Player";
      if (room.players.some(p=>p.name.toLowerCase()===name.toLowerCase())) return send(ws,"ERROR",{message:"That nickname is already taken in this room."});
      const p = {id:ws.id,ws,name,avatar:String(msg.avatar||"💎"),score:0,connected:true,powerups:["HINT"],firsts:0,bestTime:Infinity,doubleNext:false};
      room.players.push(p); ws.roomCode = room.code;
      send(ws,"JOINED",{playerId:p.id,code:room.code,isHost:false}); broadcast(room);
      notice(room, `${name} joined the room.`);
    } else if (msg.type === "START") {
      const room = roomOf(ws); if (!room) return;
      if (room.hostId !== ws.id) return send(ws,"ERROR",{message:"Only the host can start the game."});
      if (room.players.filter(p=>p.connected).length < 2) return send(ws,"ERROR",{message:"At least 2 players are required."});
      begin(room);
    } else if (msg.type === "ANSWER") {
      const room = roomOf(ws); if (!room || room.status !== "playing" || !room.challenge) return;
      const p = playerById(room, ws.id); if (!p || room.challenge.answered.includes(p.id)) return;
      const t = room.challenge.tiles[Number(msg.index)];
      if (!t) return;
      const elapsed = Math.max(0, Date.now() - (room.challenge.endsAt - 12000));
      const target = room.challenge.target;
      const correct = t.color === target.color && t.number === target.number;
      room.challenge.answered.push(p.id);
      if (correct) {
        const rank = room.challenge.answered.filter(id => {
          const pp = playerById(room,id); return pp && pp.lastCorrectChallenge === room.challenge.number;
        }).length + 1;
        const points = rank===1?100:rank===2?75:rank===3?50:25;
        p.score += points * (p.doubleNext ? 2 : 1); p.doubleNext = false;
        p.lastCorrectChallenge = room.challenge.number;
        if (rank===1) { p.firsts++; room.challenge.firstCorrectId = p.id; }
        p.bestTime = Math.min(p.bestTime, elapsed);
        if (t.gem && !room.challenge.gemClaimed) { p.score += 50; room.challenge.gemClaimed=true; }
        send(ws,"ANSWER_RESULT",{correct:true,points:points,gem:t.gem && room.challenge.gemClaimed,rank});
      } else {
        p.score -= 20;
        send(ws,"ANSWER_RESULT",{correct:false,points:-20});
      }
      broadcast(room);
      if (room.players.filter(x=>x.connected).every(x=>room.challenge.answered.includes(x.id))) finishChallenge(room.code);
    } else if (msg.type === "POWERUP") {
      const room = roomOf(ws); if (!room || room.status !== "playing") return;
      const p = playerById(room,ws.id); if (!p || !p.powerups.length) return;
      const power = String(msg.power || "");
      if (!p.powerups.includes(power)) return;
      p.powerups = p.powerups.filter(x=>x!==power);
      if (power === "DOUBLE POINTS") p.doubleNext = true;
      if (power === "HINT") send(ws,"POWERUP_RESULT",{power,message:`Look for ${room.challenge.target.colorName} ${room.challenge.target.number}.`});
      else if (power === "TIME FREEZE") {
        room.challenge.endsAt += 3000;
        clearTimeout(room.challengeTimer); room.challengeTimer=setTimeout(()=>finishChallenge(room.code),Math.max(0,room.challenge.endsAt-Date.now()));
        notice(room,`${p.name} used Time Freeze!`, "warning");
      } else send(ws,"POWERUP_RESULT",{power,message:"Double Points armed for your next correct answer."});
      broadcast(room);
    } else if (msg.type === "REMATCH") {
      const room = roomOf(ws); if (!room || room.status!=="finished" || room.hostId!==ws.id) return;
      room.players.forEach(p=>{p.score=0;p.firsts=0;p.bestTime=Infinity;p.powerups=["HINT"];p.doubleNext=false;});
      room.status="lobby";room.round=0;room.challenge=null;room.challengeNo=0;broadcast(room);
    }
  });
  ws.on("close", () => {
    const room = roomOf(ws); if (!room) return;
    const p = playerById(room,ws.id); if (!p) return;
    p.connected = false; p.ws = null;
    if (room.hostId === p.id) {
      const next = room.players.find(x=>x.connected);
      if (next) { room.hostId=next.id; notice(room,`${next.name} is now host.`); }
    }
    if (room.players.every(x=>!x.connected)) cleanRoom(room);
    else broadcast(room);
  });
});
server.listen(PORT, () => console.log(`Color Clash listening on port ${PORT}`));
