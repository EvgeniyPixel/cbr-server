const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');
const { createInitialState, executeRound } = require('./game-logic');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const RECONNECT_TIMEOUT = 30000; // 30 сек на реконнект, потом ИИ

function makeCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

function broadcastLobby(code) {
  const room = rooms[code]; if(!room) return;
  io.to(code).emit('room:update', {
    players: room.players.map(p => ({
      id:p.id, name:p.name, color:p.color, ready:p.ready, connected:p.connected
    })),
    phase: room.phase, code: room.code,
  });
}

function joinRoom(socket, code, name, color) {
  const room = rooms[code];
  const id = room.players.length;
  room.players.push({
    id, socketId:socket.id,
    name:name||`Игрок ${id+1}`,
    color:color||'#f5c842',
    ready:false, connected:true, eliminated:false,
    aiControlled: false, // ИИ замещает когда true
    disconnectTimer: null,
  });
  socket.join(code);
  socket.data.code = code;
  socket.data.playerId = id;
  broadcastLobby(code);
  return id;
}

io.on('connection', socket => {
  console.log('+ connect', socket.id);

  socket.on('room:create', ({ name, color }, cb) => {
    const code = makeCode();
    rooms[code] = { code, phase:'lobby', players:[], pendingMoves:{}, gameState:null };
    const id = joinRoom(socket, code, name, color);
    cb({ ok:true, code, playerId:id });
  });

  socket.on('room:join', ({ code, name, color }, cb) => {
    const room = rooms[code];
    if(!room)                     return cb({ ok:false, error:'Комната не найдена' });
    if(room.phase !== 'lobby')    return cb({ ok:false, error:'Игра уже началась' });
    if(room.players.length >= 28) return cb({ ok:false, error:'Комната заполнена' });
    const id = joinRoom(socket, code, name, color);
    cb({ ok:true, code, playerId:id });
  });

  socket.on('room:ready', ({ code, ready }) => {
    const room = rooms[code]; if(!room) return;
    const p = room.players.find(p => p.socketId === socket.id);
    if(p) { p.ready = ready; broadcastLobby(code); }
    if(room.players.length >= 2 && room.players.every(p => p.ready)) startGame(code);
  });

  socket.on('game:move', ({ code, move }) => {
    const room = rooms[code];
    if(!room || room.phase !== 'playing') return;
    const gamePlayer = room.gameState?.players.find(p => p.socketId === socket.id);
    if(!gamePlayer || !gamePlayer.alive) return;
    const playerIndex = gamePlayer.id;

    // Отменяем ИИ-замещение если игрок вернулся
    const roomPlayer = room.players.find(p => p.socketId === socket.id);
    if(roomPlayer) roomPlayer.aiControlled = false;

    room.pendingMoves[playerIndex] = move;
    console.log(`[${code}] move from player ${playerIndex}`);
    io.to(code).emit('game:player_moved', { playerId: playerIndex });

    checkAllMoved(code);
  });

  // Реконнект
  socket.on('room:rejoin', ({ code, playerId }, cb) => {
    const room = rooms[code];
    if(!room) return cb({ ok:false, error:'Комната не найдена' });
    const roomPlayer = room.players.find(p => p.id === playerId);
    if(!roomPlayer) return cb({ ok:false, error:'Игрок не найден' });

    // Обновляем socketId
    roomPlayer.socketId = socket.id;
    roomPlayer.connected = true;
    roomPlayer.aiControlled = false;

    // Отменяем таймер ИИ-замещения
    if(roomPlayer.disconnectTimer) {
      clearTimeout(roomPlayer.disconnectTimer);
      roomPlayer.disconnectTimer = null;
    }

    // Обновляем socketId в gameState
    if(room.gameState) {
      const gp = room.gameState.players.find(p => p.id === playerId);
      if(gp) gp.socketId = socket.id;
    }

    socket.join(code);
    broadcastLobby(code);

    // Отправляем текущее состояние
    if(room.gameState) {
      socket.emit('game:start', {
        players: room.players.map(p => ({ id:p.id, name:p.name, color:p.color })),
        myPlayerIndex: playerId,
      });
      setTimeout(() => {
        socket.emit('game:state_sync', { state: sanitizeState(room.gameState), events:[] });
      }, 300);
    }

    io.to(code).emit('game:reconnected', { playerId, name: roomPlayer.name });
    cb({ ok:true });
  });

  socket.on('disconnect', () => {
    console.log('- disconnect', socket.id);
    for(const code in rooms) {
      const room = rooms[code];
      const roomPlayer = room.players.find(p => p.socketId === socket.id);
      if(!roomPlayer) continue;

      roomPlayer.connected = false;
      broadcastLobby(code);
      io.to(code).emit('game:disconnected', { playerId: roomPlayer.id, name: roomPlayer.name });

      // Удаляем пустые лобби
      if(room.phase === 'lobby' && room.players.every(p => !p.connected)) {
        delete rooms[code];
        console.log('Room deleted:', code);
        continue;
      }

      // Во время игры — даём 30 сек на реконнект, потом ИИ замещает
      if(room.phase === 'playing') {
        roomPlayer.disconnectTimer = setTimeout(() => {
          if(!roomPlayer.connected) {
            console.log(`[${code}] Player ${roomPlayer.id} replaced by AI`);
            roomPlayer.aiControlled = true;
            io.to(code).emit('game:ai_replaced', { playerId: roomPlayer.id, name: roomPlayer.name });
            // Если ждали его ход — подставляем null и проверяем
            if(!room.pendingMoves[roomPlayer.id]) {
              room.pendingMoves[roomPlayer.id] = null;
              checkAllMoved(code);
            }
          }
        }, RECONNECT_TIMEOUT);
      }
    }
  });
});

function checkAllMoved(code) {
  const room = rooms[code]; if(!room || !room.gameState) return;
  const liveHumans = room.gameState.players.filter(p => p.isHuman && p.alive);
  const allReady = liveHumans.every(p => {
    const rp = room.players.find(rp => rp.id === p.id);
    // Считаем готовым если: выбрал ход ИЛИ ИИ замещает ИЛИ офлайн > 30 сек
    return room.pendingMoves[p.id] !== undefined || rp?.aiControlled;
  });
  if(allReady) executeRoundOnServer(code);
}

function startGame(code) {
  const room = rooms[code]; if(!room) return;
  room.phase = 'playing';
  room.pendingMoves = {};
  const humanPlayers = room.players.map(p => ({ id:p.id, name:p.name, color:p.color, socketId:p.socketId }));
  room.gameState = createInitialState(humanPlayers);

  room.players.forEach(roomPlayer => {
    const gamePlayer = room.gameState.players.find(p => p.socketId === roomPlayer.socketId);
    const playerIndex = gamePlayer ? gamePlayer.id : 0;
    io.to(roomPlayer.socketId).emit('game:start', {
      players: humanPlayers,
      myPlayerIndex: playerIndex,
    });
  });

  setTimeout(() => {
    io.to(code).emit('game:state_sync', { state: sanitizeState(room.gameState), events:[] });
    broadcastLobby(code);
  }, 300);
}

function executeRoundOnServer(code) {
  const room = rooms[code]; if(!room || !room.gameState) return;
  const humanMoves = { ...room.pendingMoves };
  room.pendingMoves = {};

  console.log(`[${code}] Executing round ${room.gameState.round}`);

  try {
    const { state, events } = executeRound(room.gameState, humanMoves);
    room.gameState = state;
    const alive = state.players.filter(p => p.alive);
    room.players.forEach(p => { if(!state.players[p.id]?.alive) p.eliminated = true; });

    const socketsInRoom = io.sockets.adapter.rooms.get(code);
    console.log(`[${code}] Sending state_sync to ${socketsInRoom?.size} sockets`);

    io.to(code).emit('game:state_sync', { state: sanitizeState(state), events });

    if(alive.length <= 1) {
      room.phase = 'ended';
      io.to(code).emit('game:over', { winner: alive[0] || null });
    }
  } catch(e) { console.error('Round error:', e); }
}

function sanitizeState(state) {
  return {
    players:state.players, board:state.board, order:state.order, round:state.round,
    burned:state.burned, cycleN:state.cycleN, finalWavesActive:state.finalWavesActive,
    nextWaveThreshold:state.nextWaveThreshold, scepterHolderId:state.scepterHolderId,
    scepterJustPickedUp:state.scepterJustPickedUp,
    centerBurned: state.centerBurned || [],
    minecarts:state.minecarts, railwayBurned:state.railwayBurned, terrains:state.terrains,
    pickups:state.pickups, portals:state.portals, centerEvolutionCounter:state.centerEvolutionCounter,
    playerNames: state.playerNames, pressureButtons: state.pressureButtons || [],
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ CBR Server на порту ${PORT}`);
  console.log(`💻 http://localhost:${PORT}`);
  console.log(`📱 http://ВАШ_IP:${PORT}`);
});
