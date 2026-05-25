// game-logic.js — общая игровая логика для сервера
// Не зависит от DOM/браузера

const SIZE = 16;
const TYPES = ['pawn','knight','bishop','rook','queen','king'];
const AI_NAMES = [
  "Аскольд","Велемудр","Громобой","Добрыня","Еремей","Ждан","Зорислав",
  "Искандер","Казимир","Любомир","Мстислав","Невзор","Остромир","Пересвет",
  "Радомир","Святояр","Твердислав","Ульф","Фрол","Храбр","Цветан",
  "Чародей","Шуйский","Юрич","Ярило","Богдан","Власий"
];
const PCOL = [
  '#d4af37','#e74c3c','#3498db','#2ecc71','#9b59b6','#e67e22',
  '#1abc9c','#e91e63','#ff9800','#00bcd4','#8bc34a','#f44336',
  '#2196f3','#9c27b0','#ff5722','#607d8b','#795548','#4caf50',
  '#03a9f4','#673ab7','#ffeb3b','#009688','#ff4081','#7986cb',
  '#4db6ac','#ff7043','#26a69a','#ec407a'
];

// ─── Утилиты ─────────────────────────────────────────────────────────────────
const inB       = (r,c) => r>=0 && r<SIZE && c>=0 && c<SIZE;
const ringDist  = (r,c) => Math.min(r, c, SIZE-1-r, SIZE-1-c);

function createInitialState(humanPlayers) {
  // humanPlayers = [{id, name, color}] — онлайн игроки
  // остальные 28-N — ИИ

  const board   = Array.from({length:SIZE}, () => Array(SIZE).fill(null));
  const players = [];
  const playerNames = [];

  // Спавн позиции — рандомные
  const spawn = getSpawnPositions();
  shuffle(spawn);

  const numHumans = humanPlayers.length;

  for(let i = 0; i < 28; i++) {
    const [r, c] = spawn[i];
    const isHuman = i < numHumans;
    const color   = isHuman ? humanPlayers[i].color : PCOL[i];
    const name    = isHuman ? humanPlayers[i].name  : AI_NAMES[(i-1) % AI_NAMES.length];
    const socketId = isHuman ? humanPlayers[i].socketId : null;
    playerNames.push(name);
    players.push({ id:i, r, c, type:'pawn', kills:0, alive:true, color, isHuman, socketId });
    board[r][c] = i;
  }

  // Рандомный порядок ходов
  const order = shuffle([...Array(28).keys()]);

  // Рельсы
  const railPath = getOrderedRailPath();
  const minecarts = [];
  if(railPath.length >= 4) {
    const perSide = Math.floor(railPath.length / 4);
    for(let i = 0; i < 4; i++) {
      minecarts.push({...railPath[(i * perSide) % railPath.length]});
    }
  }

  // Террейны и награды
  const { terrains, pickups, portals, pressureButtons } = spawnTerrains(board);

  return {
    board, players, order, playerNames,
    round: 1, burned: 0, cycleN: 0,
    finalWavesActive: false, nextWaveThreshold: 3,
    centerEvolutionCounter: new Array(28).fill(0),
    hasMovedFirstTime: new Array(28).fill(false),
    scepterHolderId: null,
    scepterJustPickedUp: false,
    centerBurned: [],
    minecarts, railwayBurned: false,
    terrains, pickups, portals, pressureButtons: pressureButtons || [],
    phase: 'planning',
  };
}

// ─── Раунд ───────────────────────────────────────────────────────────────────
function executeRound(state, humanMoves) {
  // humanMoves = { playerId: {r, c, isAttack} }
  // Возвращает новое состояние + список событий для анимации

  const events = []; // для клиентов: анимации, звуки

  // 1. AI планирует ходы
  const pendingMoves = { ...humanMoves };
  state.players.forEach(p => {
    if(!p.alive || p.isHuman) return;
    const moves = getMovesForPiece(p, state);
    if(!moves.length) { pendingMoves[p.id] = null; return; }
    const safe = moves.filter(m => !isWarn(m.r,m.c,state) && !isBurned(m.r,m.c,state) && !isDeadlyCell(m.r,m.c,state));
    const pool = safe.length ? safe : moves;
    pool.sort((a,b) => dist(a,7.5,7.5) - dist(b,7.5,7.5));
    pendingMoves[p.id] = pool[Math.floor(Math.random() * Math.min(2, pool.length))];
  });

  // 2. Скипетр — первым ходит обладатель (если он есть)
  let execOrder = [...state.order];

  // 3. Выполняем ходы
  for(const pid of execOrder) {
    const p = state.players[pid];
    if(!p?.alive) continue;
    const mv = pendingMoves[pid];
    if(!mv || (mv.r === p.r && mv.c === p.c)) continue;

    // Проверяем доступность хода
    if(!inB(mv.r, mv.c) || isBurned(mv.r, mv.c, state)) continue;
    if(getTerrainAt(mv.r, mv.c, state) === 'mountain') continue;

    const oldR = p.r, oldC = p.c;
    const targetOcc = state.board[mv.r][mv.c];

    // Пешка атакует только по диагонали
    let canMove = false, kill = false, targetId = null;
    if(p.type === 'pawn') {
      const dr = mv.r - p.r, dc = mv.c - p.c;
      const isDiag = (dr !== 0 && dc !== 0);
      if(targetOcc === null) { canMove = true; }
      else if(targetOcc !== pid && isDiag) { canMove = true; kill = true; targetId = targetOcc; }
      // Пешка прямо в занятую — столкновение
      else if(targetOcc !== pid && !isDiag) {
        // Столкновение пешек
        const victim = state.players[targetOcc];
        if(victim?.alive) {
          events.push({ type:'collision', r: mv.r, c: mv.c, attacker: pid, victim: targetOcc });
          handlePawnCollision(state, p, pid, mv, events);
          continue;
        }
      }
    } else {
      if(targetOcc === null) { canMove = true; }
      else if(targetOcc !== pid) { canMove = true; kill = true; targetId = targetOcc; }
    }

    if(!canMove) continue;

    // Убийство
    if(kill && targetId !== null) {
      const victim = state.players[targetId];
      if(victim?.alive) {
        victim.alive = false;
        state.board[victim.r][victim.c] = null;
        state.order = state.order.filter(id => id !== targetId);
        p.kills++;
        events.push({ type:'kill', killer: pid, victim: targetId });
        evolveByKills(p, state, events);
      }
    }

    // Перемещение
    state.board[oldR][oldC] = null;
    p.r = mv.r; p.c = mv.c;
    state.board[mv.r][mv.c] = pid;
    events.push({ type:'move', pid, fromR:oldR, fromC:oldC, toR:mv.r, toC:mv.c });

    // Портал
    if(state.portals[`${p.r},${p.c}`]) {
      applyPortal(state, p, pid, events);
    }

    // Лава
    if(getTerrainAt(p.r, p.c, state) === 'lava') {
      p.alive = false;
      state.board[p.r][p.c] = null;
      state.order = state.order.filter(id => id !== pid);
      events.push({ type:'lava_death', pid });
    }

    // Лёд
    if(getTerrainAt(p.r, p.c, state) === 'ice' && p.alive) {
      const neighbors = [];
      for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++) {
        if(!dr && !dc) continue;
        const nr=p.r+dr, nc=p.c+dc;
        if(inB(nr,nc) && !isBurned(nr,nc,state) && state.board[nr][nc]===null && getTerrainAt(nr,nc,state)!=='mountain') {
          neighbors.push({r:nr,c:nc});
        }
      }
      if(neighbors.length) {
        const dest = neighbors[Math.floor(Math.random()*neighbors.length)];
        const fromR = p.r, fromC = p.c;
        state.board[p.r][p.c] = null;
        p.r = dest.r; p.c = dest.c;
        state.board[dest.r][dest.c] = pid;
        events.push({ type:'ice_slide', pid, fromR, fromC, toR:dest.r, toC:dest.c });
      }
    }

    // Подбор наград
    const pk = `${p.r},${p.c}`;
    if(state.pickups[pk]) {
      const ptype = state.pickups[pk];
      delete state.pickups[pk];
      if(ptype === 'scepter') {
        state.scepterHolderId = pid;
        console.log(`[scepter] picked up by player ${pid}`);
        events.push({ type:'pickup_scepter', pid });
      } else {
        const idx = TYPES.indexOf(p.type);
        if(idx < TYPES.length - 1) {
          p.type = TYPES[idx+1];
          events.push({ type:'pickup_powerup', pid, newType: p.type });
        }
      }
    }

    // Центр поля
    if(isInCenter(p.r, p.c)) {
      state.centerEvolutionCounter[pid] = (state.centerEvolutionCounter[pid] || 0) + 1;
      if(state.centerEvolutionCounter[pid] >= 2) {
        state.centerEvolutionCounter[pid] = 0;
        const idx = TYPES.indexOf(p.type);
        if(idx < TYPES.length - 1) {
          p.type = TYPES[idx+1];
          events.push({ type:'evo_center', pid, newType: p.type });
        }
      }
    } else {
      state.centerEvolutionCounter[pid] = 0;
    }
  }

  // 4. Вагонетки
  if(!state.railwayBurned && state.minecarts.length) {
    const railPath = getOrderedRailPath();
    const steps = 3;
    state.minecarts = state.minecarts.map(mc => {
      let pos = mc;
      // Проверяем есть ли пассажир на вагонетке
      const passenger = state.board[pos.r]?.[pos.c];
      for(let s=0;s<steps;s++) {
        const nextPos = getNextMinecartPosition(pos, 1, railPath);
        // Давим всех на пути (кроме пассажира)
        const occ = state.board[nextPos.r]?.[nextPos.c];
        if(occ !== null && occ !== undefined && occ !== passenger) {
          const victim = state.players[occ];
          if(victim?.alive) {
            victim.alive = false;
            state.board[nextPos.r][nextPos.c] = null;
            state.order = state.order.filter(id => id !== occ);
            events.push({ type:'cart_kill', victim: occ, r: nextPos.r, c: nextPos.c });
          }
        }
        // Перемещаем пассажира вместе с вагонеткой
        if(passenger !== null && passenger !== undefined && state.players[passenger]?.alive) {
          state.board[pos.r][pos.c] = null;
          state.players[passenger].r = nextPos.r;
          state.players[passenger].c = nextPos.c;
          state.board[nextPos.r][nextPos.c] = passenger;
        }
        pos = nextPos;
      }
      return pos;
    });
    events.push({ type:'carts_moved', minecarts: state.minecarts });
  }

  // 5. Волна огня
  state.cycleN++;
  state.updateNextWaveThreshold?.();
  const threshold = state.nextWaveThreshold;
  if(!state.finalWavesActive && state.cycleN >= threshold) {
    state.burned++;
    state.cycleN = 0;
    events.push({ type:'fire_wave', ring: state.burned });
    // Убиваем на сгоревших клетках
    state.players.forEach(p => {
      if(p.alive && isBurned(p.r, p.c, state)) {
        p.alive = false;
        state.board[p.r][p.c] = null;
        state.order = state.order.filter(id => id !== p.id);
        events.push({ type:'burned', pid: p.id });
      }
    });
    if(state.burned >= 7) state.finalWavesActive = true;
  }

  // Сжигаем рельсы если нужно
  if(!state.railwayBurned && state.burned > 0 && isBurned(SIZE-1-3, 3, state)) {
    state.railwayBurned = true;
    state.minecarts = [];
    events.push({ type:'railway_burned' });
  }

  // 6. Скипетр
  let scepterAppliedId = null;
  if(state.scepterHolderId !== null) {
    const sid = state.scepterHolderId;
    if(!state.players[sid]?.alive) {
      events.push({ type:'scepter_removed', pid: sid });
    } else {
      events.push({ type:'scepter_first', pid: sid });
      events.push({ type:'scepter_applied', pid: sid });
      scepterAppliedId = sid;
    }
    state.scepterHolderId = null;
  }

  // 7. Конец раунда
  state.round++;
  state.phase = 'planning';

  // Порядок: если скипетр — holder первым, остальные не меняются
  // Если нет скипетра — rotate (первый идёт в конец)
  if(scepterAppliedId !== null && state.players[scepterAppliedId]?.alive) {
    state.order = state.order.filter(id => id !== scepterAppliedId);
    state.order.unshift(scepterAppliedId);
  } else {
    // Обычная ротация как в одиночной
    if(state.order.length > 1) {
      state.order.push(state.order.shift());
    }
  }

  return { state, events };
}

// ─── Вспомогательные ─────────────────────────────────────────────────────────
function isBurned(r, c, state) { return ringDist(r,c) < state.burned; }
function isWarn(r, c, state) {
  if(state.finalWavesActive) return false;
  return state.cycleN === state.nextWaveThreshold - 1 && ringDist(r,c) === state.burned;
}
function getTerrainAt(r, c, state) { return state.terrains[`${r},${c}`] || null; }
function isInCenter(r, c) { return r >= 7 && r <= 8 && c >= 7 && c <= 8; }
function dist(p, r, c) { return Math.hypot(p.r - r, p.c - c); }

function isDeadlyCell(r, c, state) {
  if(!inB(r,c) || isBurned(r,c,state)) return true;
  if(getTerrainAt(r,c,state) === 'lava') return true;
  if(!state.railwayBurned) {
    const railPath = getOrderedRailPath();
    for(const mc of state.minecarts) {
      let pos = mc;
      for(let s=0;s<3;s++) {
        pos = getNextMinecartPosition(pos, 1, railPath);
        if(pos.r === r && pos.c === c) return true;
      }
    }
  }
  return false;
}

function evolveByKills(p, state, events) {
  const oldType = p.type;
  const killType = p.kills>=5?'king':p.kills>=4?'queen':p.kills>=3?'rook':p.kills>=2?'bishop':'knight';
  const killIdx    = TYPES.indexOf(killType);
  const currentIdx = TYPES.indexOf(p.type);
  if(killIdx > currentIdx) p.type = killType;
  else {
    const next = currentIdx + 1;
    if(next < TYPES.length) p.type = TYPES[next];
  }
  if(p.type !== oldType) {
    events.push({ type:'evolved', pid: p.id, newType: p.type, oldType });
    // При эволюции в короля выдаём скипетр
    if(p.type === 'king') {
      state.scepterHolderId = p.id;
    }
  }
}

function applyPortal(state, p, pid, events) {
  const portal = state.portals[`${p.r},${p.c}`];
  if(!portal) return;
  const [tr, tc] = portal.targetKey.split(',').map(Number);
  state.board[p.r][p.c] = null;
  const occ = state.board[tr][tc];
  if(occ !== null && occ !== pid) {
    const victim = state.players[occ];
    if(victim?.alive) {
      victim.alive = false;
      state.order = state.order.filter(id => id !== occ);
      events.push({ type:'portal_kill', victim: occ });
    }
  }
  p.r = tr; p.c = tc;
  state.board[tr][tc] = pid;
  events.push({ type:'portal_teleport', pid, toR:tr, toC:tc });
}

function handlePawnCollision(state, p, pid, mv, events) {
  const dr = Math.sign(mv.r - p.r), dc = Math.sign(mv.c - p.c);
  const occupantId = state.board[mv.r][mv.c];
  const victim = state.players[occupantId];
  const landR = mv.r - dr, landC = mv.c - dc;
  const pushR = mv.r + dr, pushC = mv.c + dc;

  // Клетка столкновения → лава (или гора если вода)
  const wasTerrain = getTerrainAt(mv.r, mv.c, state);
  state.terrains[`${mv.r},${mv.c}`] = wasTerrain === 'water' ? 'mountain' : 'lava';
  events.push({ type:'collision_terrain', r:mv.r, c:mv.c, terrain: state.terrains[`${mv.r},${mv.c}`] });

  // Пешка встаёт перед
  if(inB(landR,landC) && !isBurned(landR,landC,state) && state.board[landR][landC]===null && getTerrainAt(landR,landC,state)!=='mountain') {
    state.board[p.r][p.c] = null;
    p.r = landR; p.c = landC;
    state.board[landR][landC] = pid;
  }

  // Жертва откидывается
  if(inB(pushR,pushC) && !isBurned(pushR,pushC,state) && getTerrainAt(pushR,pushC,state)!=='mountain') {
    const blocker = state.board[pushR][pushC];
    if(blocker !== null) {
      victim.alive = false;
      state.board[mv.r][mv.c] = null;
      state.order = state.order.filter(id => id !== occupantId);
      events.push({ type:'collision_kill', victim: occupantId, cause:'blocked', colR:mv.r, colC:mv.c });
    } else {
      state.board[mv.r][mv.c] = null;
      victim.r = pushR; victim.c = pushC;
      state.board[pushR][pushC] = occupantId;
      events.push({ type:'collision_push', victim: occupantId, toR:pushR, toC:pushC, colR:mv.r, colC:mv.c });
    }
  } else {
    victim.alive = false;
    state.board[mv.r][mv.c] = null;
    state.order = state.order.filter(id => id !== occupantId);
    events.push({ type:'collision_kill', victim: occupantId, cause:'edge', colR:mv.r, colC:mv.c });
  }
}

function shuffle(arr) {
  for(let i=arr.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

// ─── Спавн и рельсы ──────────────────────────────────────────────────────────
function getSpawnPositions() {
  const pts = [];
  for(let c=1;c<=13;c+=2) pts.push([0,c]);
  for(let r=1;r<=13;r+=2) pts.push([r,SIZE-1]);
  for(let c=14;c>=2;c-=2) pts.push([SIZE-1,c]);
  for(let r=2;r<=14;r+=2) pts.push([r,0]);
  return pts;
}

function getOrderedRailPath() {
  const ring = 3, lo = ring, hi = SIZE-1-ring;
  const path = [];
  for(let c=lo;c<=hi;c++) path.push({r:lo,c});
  for(let r=lo+1;r<=hi;r++) path.push({r,c:hi});
  for(let c=hi-1;c>=lo;c--) path.push({r:hi,c});
  for(let r=hi-1;r>lo;r--) path.push({r,c:lo});
  return path;
}

function getNextMinecartPosition(pos, steps, railPath) {
  if(!railPath) railPath = getOrderedRailPath();
  let idx = railPath.findIndex(p=>p.r===pos.r&&p.c===pos.c);
  if(idx < 0) idx = 0;
  idx = (idx - steps + railPath.length) % railPath.length;
  return railPath[idx];
}

function spawnTerrains(board) {
  const terrains = {}, pickups = {}, portals = {};
  function shuffled(arr) { return shuffle([...arr]); }
  function placeOnRing(ring, type, count, avoidNeighborsOf=[], excludeCells=[]) {
    const excSet = new Set(excludeCells.map(({r,c})=>`${r},${c}`));
    const candidates = shuffled(getRingCells(ring)).filter(({r,c})=>board[r][c]===null&&!excSet.has(`${r},${c}`));
    const placed=[];
    for(const {r,c} of candidates) {
      if(placed.length>=count) break;
      const tooClose=[...placed,...avoidNeighborsOf].some(p=>Math.abs(p.r-r)<=1&&Math.abs(p.c-c)<=1);
      if(tooClose) continue;
      terrains[`${r},${c}`]=type; placed.push({r,c});
    }
    return placed;
  }
  function getRingCells(ring) {
    const lo=ring,hi=SIZE-1-ring,cells=[];
    for(let c=lo;c<=hi;c++){cells.push({r:lo,c});cells.push({r:hi,c});}
    for(let r=lo+1;r<hi;r++){cells.push({r,c:lo});cells.push({r,c:hi});}
    return cells;
  }

  // Порталы — углы кольца 1
  const R1=1,MAX1=SIZE-1-R1;
  const portalDefs=[
    {r:R1,c:R1,ovalColor:'#e03030',arrowColor:'#30c030',arrowDir:'right'},
    {r:R1,c:MAX1,ovalColor:'#30c030',arrowColor:'#e07020',arrowDir:'down'},
    {r:MAX1,c:MAX1,ovalColor:'#e07020',arrowColor:'#3070e0',arrowDir:'left'},
    {r:MAX1,c:R1,ovalColor:'#3070e0',arrowColor:'#e03030',arrowDir:'up'},
  ];
  portalDefs.forEach((pd,i)=>{
    const next=portalDefs[(i+1)%4];
    portals[`${pd.r},${pd.c}`]={...pd,targetKey:`${next.r},${next.c}`};
  });

  // Кнопки ускорения — углы кольца 4
  const R4=4, MAX4=SIZE-1-R4;
  const buttonCorners=[{r:R4,c:R4},{r:R4,c:MAX4},{r:MAX4,c:R4},{r:MAX4,c:MAX4}];
  const excludeFromWater=[...buttonCorners];

  // Награды — углы кольца 5
  const R5=5,MAX5=SIZE-1-R5;
  const ring5corners=[{r:R5,c:R5},{r:R5,c:MAX5},{r:MAX5,c:R5},{r:MAX5,c:MAX5}];
  shuffled(ring5corners).forEach(({r,c},i)=>{pickups[`${r},${c}`]=i<2?'scepter':'powerup';});

  // Террейны
  // Горы: excludeCells = награды + кнопки (не ставим НА них)
  placeOnRing(5,'mountain',4,[],[...ring5corners,...buttonCorners]);
  placeOnRing(4,'water',12,[],excludeFromWater);
  const fc=placeOnRing(6,'forest',2);
  placeOnRing(6,'ice',2,fc);

  // Кнопки НЕ добавляем в terrains — они хранятся отдельно в pressureButtons
  // buttonCorners.forEach(({r,c})=>{ terrains[`${r},${c}`]='button'; });

  return {terrains,pickups,portals,pressureButtons:buttonCorners};
}

function getMovesForPiece(p, state) {
  const {r,c,type,id} = p;
  const moves = [];
  const isFirst = (!state.hasMovedFirstTime[id] && state.round === 1);

  if(type === 'pawn') {
    const maxD = isFirst ? 2 : 1;
    for(let dr=-maxD;dr<=maxD;dr++) for(let dc=-maxD;dc<=maxD;dc++) {
      if(!dr&&!dc) continue;
      if(Math.max(Math.abs(dr),Math.abs(dc))>maxD) continue;
      const isQueen=(dr===0||dc===0||Math.abs(dr)===Math.abs(dc));
      if(!isQueen) continue;
      const nr=r+dr,nc=c+dc;
      if(!inB(nr,nc)||isBurned(nr,nc,state)) continue;
      if(getTerrainAt(nr,nc,state)==='mountain') continue;
      const occ=state.board[nr][nc];
      const isDiag=(dr!==0&&dc!==0);
      const isFar=isFirst&&Math.max(Math.abs(dr),Math.abs(dc))===2;
      if(occ===null) moves.push({r:nr,c:nc,isAttack:false,isFirstMove:isFar});
      else if(occ!==id&&isDiag) moves.push({r:nr,c:nc,isAttack:true,isFirstMove:false});
    }
  } else {
    const dirs = type==='knight'
      ? [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]
      : [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
    const maxSteps = type==='king'?2:type==='knight'?1:SIZE;
    for(const [dr,dc] of dirs) {
      for(let s=1;s<=maxSteps;s++) {
        const nr=r+dr*s,nc=c+dc*s;
        if(!inB(nr,nc)||isBurned(nr,nc,state)) break;
        if(getTerrainAt(nr,nc,state)==='mountain') break;
        const occ=state.board[nr][nc];
        if(occ===null) {
          moves.push({r:nr,c:nc,isAttack:false,isFirstMove:false});
          if(getTerrainAt(nr,nc,state)==='water') break;
        } else {
          if(occ!==id) moves.push({r:nr,c:nc,isAttack:true,isFirstMove:false});
          break;
        }
      }
    }
  }
  return moves;
}

module.exports = { createInitialState, executeRound, getMovesForPiece, SIZE, TYPES };
