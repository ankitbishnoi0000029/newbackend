import { createServer } from 'http';
import { parse } from 'url';
import { readFile } from 'fs';
import { extname, join } from 'path';
import { Server } from 'socket.io';
import { saveGameRound, updateGameRound, getCurrentGameRound, getHistory, insertHistory } from './lib/dbWrk.js';
import { login, verifyTokenFromDB } from './lib/authUtils.js';

// ✅ FIXED: Remove localhost restriction for Railway
const port = process.env.PORT || 8000;
const host = '0.0.0.0'; // Listen on all network interfaces

// Indian timing: 9:00 AM to 9:00 PM IST
const GAME_START_HOUR_UTC = 3;
const GAME_START_MINUTE_UTC = 30;
const GAME_END_HOUR_UTC = 15;
const GAME_END_MINUTE_UTC = 32;
const ROUND_DURATION_SECONDS = 1 * 60;

// MIME types for static files
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Global game state
let currentRound = null;
let currentRoundId = null;
let gameTimer = null;
let roundTimer = null;
let roundResults = {
  a1: null, a2: null, b1: null, b2: null, c1: null, c2: null
};
let currentWheelValues = {
  a1: null, a2: null, b1: null, b2: null, c1: null, c2: null
};
let isGameCurrentlyActive = false;

// ✅ NEW: Round completion lock to prevent duplicates
let roundCompletionLock = {
  completed: false,
  roundId: null
};

function getCurrentGamePeriod() {
  const now = new Date();
  const nowUTC = new Date(now.getTime() + (now.getTimezoneOffset() * 60000));

  const gameStartTodayUTC = new Date(nowUTC);
  gameStartTodayUTC.setHours(GAME_START_HOUR_UTC, GAME_START_MINUTE_UTC, 0, 0);

  const gameEndTodayUTC = new Date(nowUTC);
  gameEndTodayUTC.setHours(GAME_END_HOUR_UTC, GAME_END_MINUTE_UTC, 0, 0);

  const gameStartTodayIST = new Date(gameStartTodayUTC.getTime() + (5.5 * 60 * 60 * 1000));
  const gameEndTodayIST = new Date(gameEndTodayUTC.getTime() + (5.5 * 60 * 60 * 1000));

  const isGameTime = nowUTC >= gameStartTodayUTC && nowUTC < gameEndTodayUTC;

  if (isGameTime) {
    const totalSecondsSinceGameStart = Math.floor((nowUTC - gameStartTodayUTC) / 1000);
    const currentRound = Math.floor(totalSecondsSinceGameStart / ROUND_DURATION_SECONDS) + 1;
    const secondsIntoCurrentRound = totalSecondsSinceGameStart % ROUND_DURATION_SECONDS;
    const roundTimeLeft = Math.max(0, ROUND_DURATION_SECONDS - secondsIntoCurrentRound);
    const timeUntilGameEnd = Math.max(0, Math.floor((gameEndTodayUTC - nowUTC) / 1000));

    return {
      isActive: true,
      timeUntilEnd: timeUntilGameEnd,
      currentRound: currentRound,
      currentTime: nowUTC,
      roundTimeLeft: roundTimeLeft,
      gameStartTime: gameStartTodayUTC,
      gameEndTime: gameEndTodayUTC,
      gameStartIST: gameStartTodayIST,
      gameEndIST: gameEndTodayIST,
      gameHours: "9:00 AM to 9:00 PM IST"
    };
  } else {
    let timeUntilNextGame;
    let nextGameStartUTC;
    let nextGameStartIST;

    if (nowUTC < gameStartTodayUTC) {
      nextGameStartUTC = gameStartTodayUTC;
      nextGameStartIST = gameStartTodayIST;
      timeUntilNextGame = Math.floor((gameStartTodayUTC - nowUTC) / 1000);
    } else {
      const gameStartTomorrowUTC = new Date(gameStartTodayUTC);
      gameStartTomorrowUTC.setDate(gameStartTomorrowUTC.getDate() + 1);
      nextGameStartUTC = gameStartTomorrowUTC;
      const gameStartTomorrowIST = new Date(gameStartTomorrowUTC.getTime() + (5.5 * 60 * 60 * 1000));
      nextGameStartIST = gameStartTomorrowIST;
      timeUntilNextGame = Math.floor((gameStartTomorrowUTC - nowUTC) / 1000);
    }

    return {
      isActive: false,
      timeUntilEnd: null,
      currentRound: null,
      currentTime: nowUTC,
      roundTimeLeft: 0,
      gameStartTime: gameStartTodayUTC,
      gameEndTime: gameEndTodayUTC,
      timeUntilNextGame: timeUntilNextGame,
      nextGameStart: nextGameStartUTC,
      nextGameStartIST: nextGameStartIST,
      gameHours: "9:00 AM to 9:00 PM IST",
      statusMessage: nowUTC < gameStartTodayUTC ?
        "Game will start at 9:00 AM IST" :
        "Game closed. Next game tomorrow at 9:00 AM IST"
    };
  }
}

let currentRoundStartTime = null;

function generateWheelValues() {
  const wheels = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
  const values = {};
  wheels.forEach(wheel => {
    values[wheel] = Math.floor(Math.random() * 10);
  });
  return values;
}

function startGameTimer(io) {
  if (gameTimer) clearInterval(gameTimer);
  gameTimer = setInterval(() => {
    const now = new Date();
    const gamePeriod = getCurrentGamePeriod();

    if (gamePeriod.isActive) {
      if (!isGameCurrentlyActive) {
        isGameCurrentlyActive = true;
        console.log('🎮 Game activated at 9:00 AM IST');
        io.emit('game-state', {
          ...gamePeriod,
          currentResults: roundResults,
          currentRoundId: currentRoundId
        });
      }

      const roundNumber = gamePeriod.currentRound;

      if (currentRound !== roundNumber) {
        currentRound = roundNumber;
        currentRoundStartTime = now;
        
        // ✅ RESET lock for new round
        roundCompletionLock = { completed: false, roundId: null };
        
        console.log(`🎮 Starting round ${roundNumber} at ${new Date().toLocaleTimeString('en-IN')} IST`);
        currentWheelValues = generateWheelValues();
        roundResults = { a1: null, a2: null, b1: null, b2: null, c1: null, c2: null };

        io.emit('round-start', {
          roundNumber: roundNumber,
          duration: ROUND_DURATION_SECONDS,
          roundTimeLeft: ROUND_DURATION_SECONDS,
          wheelValues: currentWheelValues,
          currentTimeIST: new Date(now.getTime() + (5.5 * 60 * 60 * 1000)).toLocaleTimeString('en-IN')
        });
      }

      let currentRoundTimeLeft = ROUND_DURATION_SECONDS;
      if (currentRoundStartTime) {
        const elapsedMs = now - currentRoundStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        currentRoundTimeLeft = Math.max(0, ROUND_DURATION_SECONDS - elapsedSeconds);
      }

      io.emit('game-timer', {
        roundNumber: roundNumber,
        roundTimeLeft: currentRoundTimeLeft,
        isActive: true,
        gameEndTime: gamePeriod.gameEndIST,
        currentTimeIST: new Date(now.getTime() + (5.5 * 60 * 60 * 1000)).toLocaleTimeString('en-IN')
      });
    } else {
      if (isGameCurrentlyActive) {
        isGameCurrentlyActive = false;
        console.log('🌙 Game closed at 9:00 PM IST');
        currentRound = null;
        currentRoundStartTime = null;
        roundResults = { a1: null, a2: null, b1: null, b2: null, c1: null, c2: null };

        io.emit('game-closed', {
          timeUntilNextGame: gamePeriod.timeUntilNextGame,
          nextGameStart: gamePeriod.nextGameStart,
          nextGameStartIST: gamePeriod.nextGameStartIST,
          message: "Game closed for today. Next game at 9:00 AM IST tomorrow."
        });
      }

      const updatedGamePeriod = getCurrentGamePeriod();
      io.emit('game-timer', {
        roundNumber: 0,
        roundTimeLeft: 0,
        isActive: false,
        timeUntilNextGame: updatedGamePeriod.timeUntilNextGame,
        nextGameStartIST: updatedGamePeriod.nextGameStartIST,
        statusMessage: updatedGamePeriod.statusMessage
      });
    }
  }, 1000);
}

// ✅ IMPROVED CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
};

const httpServer = createServer(async (req, res) => {
  const parsedUrl = parse(req.url, true);
  let pathname = parsedUrl.pathname;

  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // ✅ Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { ...corsHeaders, 'Content-Length': 0 });
    res.end();
    return;
  }

  // ✅ Health check endpoint
  if (pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({
      success: true,
      message: 'Server is running',
      timestamp: new Date().toISOString(),
      port: port
    }));
    return;
  }

  // ✅ Login endpoint
  if (pathname === '/api/login' && req.method === 'POST') {
    console.log('📥 Login API request received');
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        if (!body) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ success: false, error: 'Request body is required' }));
          return;
        }

        const { username, password } = JSON.parse(body);

        if (!username || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ success: false, error: 'Username and password are required' }));
          return;
        }

        const result = await login(username, password);

        if (result.success) {
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify(result));
        }
      } catch (error) {
        console.error('❌ Login API error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: false, error: 'Internal server error', details: error.message }));
      }
    });
    return;
  }

  // Token verify endpoint
  if (pathname === '/api/token/verify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        let token = null;
        if (body) {
          try {
            const parsed = JSON.parse(body);
            token = parsed.token;
          } catch (e) {}
        }
        if (!token) {
          const authHeader = req.headers.authorization;
          if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
          }
        }
        if (!token) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ success: false, error: 'Token is required' }));
          return;
        }
        const result = await verifyTokenFromDB(token);
        res.writeHead(result.success ? 200 : 401, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('Verify token error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
      }
    });
    return;
  }

  // Get history endpoint
  if (pathname === '/api/history' && req.method === 'GET') {
    try {
      const result = await getHistory();
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Get history error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
    }
    return;
  }

  // Insert history endpoint
  if (pathname === '/api/history' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        if (!body) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ success: false, error: 'Request body is required' }));
          return;
        }
        const historyData = JSON.parse(body);
        if (historyData.a1 === undefined || historyData.a2 === undefined ||
            historyData.b1 === undefined || historyData.b2 === undefined ||
            historyData.c1 === undefined || historyData.c2 === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ success: false, error: 'All wheel values required' }));
          return;
        }
        const result = await insertHistory(historyData);
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('Insert history error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
      }
    });
    return;
  }

  // 404 for unknown API endpoints
  if (pathname.startsWith('/api/')) {
    console.log(`❌ API endpoint not found: ${req.method} ${pathname}`);
    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ success: false, error: 'API endpoint not found' }));
    return;
  }

  // Serve static files
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const filePath = join(process.cwd(), 'public', pathname);
  const ext = extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'text/plain';

  readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>500 Internal Server Error</h1>');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const io = new Server(httpServer, {
  path: '/api/socket',
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

startGameTimer(io);

io.on('connection', (socket) => {
  console.log('🟢 Socket connected:', socket.id);

  const gamePeriod = getCurrentGamePeriod();
  const currentTimeIST = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000));

  if (gamePeriod.isActive) {
    socket.emit('game-state', {
      ...gamePeriod,
      currentResults: roundResults,
      currentRoundId: currentRoundId,
      currentTimeIST: currentTimeIST.toLocaleTimeString('en-IN'),
      gameHours: "9:00 AM to 9:00 PM IST"
    });
  } else {
    socket.emit('game-closed', {
      timeUntilNextGame: gamePeriod.timeUntilNextGame,
      nextGameStart: gamePeriod.nextGameStart,
      nextGameStartIST: gamePeriod.nextGameStartIST,
      message: gamePeriod.statusMessage,
      currentTimeIST: currentTimeIST.toLocaleTimeString('en-IN')
    });
  }

  socket.on('disconnect', () => {});

  socket.on('user-selection', (data) => {
    if (data.a1 !== undefined) currentWheelValues.a1 = data.a1;
    if (data.a2 !== undefined) currentWheelValues.a2 = data.a2;
    if (data.b1 !== undefined) currentWheelValues.b1 = data.b1;
    if (data.b2 !== undefined) currentWheelValues.b2 = data.b2;
    if (data.c1 !== undefined) currentWheelValues.c1 = data.c1;
    if (data.c2 !== undefined) currentWheelValues.c2 = data.c2;
    io.emit('wheel-values-update', {
      wheelValues: currentWheelValues,
      timestamp: data.timestamp
    });
  });

  socket.on('get-game-state', () => {
    const gamePeriod = getCurrentGamePeriod();
    socket.emit('game-state', {
      ...gamePeriod,
      currentResults: roundResults,
      currentRoundId: currentRoundId
    });
  });

  socket.on('wheel-result', (data) => {
    console.log('🎡 Wheel result:', data);
    roundResults[data.wheel] = data.result;
    io.emit('wheel-result', data);
  });

  socket.on('game-result', async (data) => {
    console.log('🏆 Game result:', data);
    const historyData = {
      roundId: currentRoundId,
      roundStartTime: currentRoundStartTime ? currentRoundStartTime.toISOString() : new Date().toISOString(),
      ...data.results
    };
    const historyResult = await insertHistory(historyData);
    if (!historyResult.success) {
      throw new Error(historyResult.error);
    }
    Object.assign(roundResults, data.results);
    if (currentRoundId) {
      await updateGameRound(currentRoundId, { ...roundResults, status: 'completed' });
    }
    io.emit('game-result', data);
  });

  socket.on('save-round', async (data) => {
    try {
      const roundStartTime = new Date();
      const roundEndTime = new Date(roundStartTime.getTime() + ROUND_DURATION_SECONDS * 1000);
      const result = await saveGameRound({
        roundNumber: data.roundNumber,
        roundStartTime,
        roundEndTime,
        ...roundResults,
        status: 'active'
      });
      if (result.success) {
        currentRoundId = result.roundId;
        console.log(`✅ Round ${data.roundNumber} saved with ID: ${currentRoundId}`);
      }
      io.emit('round-saved', {
        success: result.success,
        roundId: result.roundId,
        roundNumber: data.roundNumber
      });
    } catch (error) {
      io.emit('round-saved', { success: false, error: error.message });
    }
  });

  socket.on('round-complete', async (data) => {
    if (!currentRoundId) {
      console.log('⚠️ No active round');
      return;
    }
    if (roundCompletionLock.completed && roundCompletionLock.roundId === currentRoundId) {
      console.log('⚠️ Round already completed');
      return;
    }
    roundCompletionLock.completed = true;
    roundCompletionLock.roundId = currentRoundId;
    console.log('🏁 Round complete (LOCKED):', currentRoundId);
    try {
      await updateGameRound(currentRoundId, { ...roundResults, status: 'completed' });
      roundResults = { a1: null, a2: null, b1: null, b2: null, c1: null, c2: null };
      currentRoundId = null;
      io.emit('round-complete', data);
      console.log('✅ Round completed');
    } catch (err) {
      console.error('❌ Round completion failed:', err);
      roundCompletionLock.completed = false;
    }
  });
});

// ✅ FIXED: Listen on 0.0.0.0 for Railway
httpServer.listen(port, host, (err) => {
  if (err) throw err;
  console.log(`✅ Server ready on ${host}:${port}`);
  console.log(`🌐 Public URL: https://patient-love-production.up.railway.app`);
});