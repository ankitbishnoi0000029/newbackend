import { createServer } from 'http';
import { parse } from 'url';
import { readFile } from 'fs';
import { extname, join } from 'path';
import { Server } from 'socket.io';
import { saveGameRound, updateGameRound, getCurrentGameRound, getHistory, insertHistory } from './lib/dbWrk.js';
import { login, verifyTokenFromDB } from './lib/authUtils.js';

const hostname = 'localhost';
const port = process.env.PORT || 8000;

// Indian timing: 9:00 AM to 9:00 PM IST
// IST is UTC+5:30, so:
// 9:00 AM IST = 3:30 AM UTC
// 9:00 PM IST = 3:30 PM UTC (15:30 UTC)
// const GAME_START_HOUR_UTC = 3;  // 3:30 AM UTC = 9:00 AM IST
// const GAME_START_MINUTE_UTC = 30;
// const GAME_END_HOUR_UTC = 15;   // 3:30 PM UTC = 9:00 PM IST
// const GAME_END_MINUTE_UTC = 30;
// const ROUND_DURATION_SECONDS = 15 * 60; // 15 minutes per round

const GAME_START_HOUR_UTC = 1;  // 3:30 AM UTC = 9:00 AM IST
const GAME_START_MINUTE_UTC = 20;
const GAME_END_HOUR_UTC = 30;   // 3:30 PM UTC = 9:00 PM IST
const GAME_END_MINUTE_UTC = 30;
const ROUND_DURATION_SECONDS = 1 * 60; // 15 minutes per round
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
let isGameCurrentlyActive = false; // Track current game state

function getCurrentGamePeriod() {
  const now = new Date();
  const nowUTC = new Date(now.getTime() + (now.getTimezoneOffset() * 60000)); // Convert to UTC

  // Calculate today's game start time in UTC (3:30 AM UTC = 9:00 AM IST)
  const gameStartTodayUTC = new Date(nowUTC);
  gameStartTodayUTC.setHours(GAME_START_HOUR_UTC, GAME_START_MINUTE_UTC, 0, 0);

  // Calculate today's game end time in UTC (3:30 PM UTC = 9:00 PM IST)
  const gameEndTodayUTC = new Date(nowUTC);
  gameEndTodayUTC.setHours(GAME_END_HOUR_UTC, GAME_END_MINUTE_UTC, 0, 0);

  // Convert to IST for display purposes (optional)
  const gameStartTodayIST = new Date(gameStartTodayUTC.getTime() + (5.5 * 60 * 60 * 1000));
  const gameEndTodayIST = new Date(gameEndTodayUTC.getTime() + (5.5 * 60 * 60 * 1000));

  // Check if current time is within game hours (9:00 AM to 9:00 PM IST)
  const isGameTime = nowUTC >= gameStartTodayUTC && nowUTC < gameEndTodayUTC;

  if (isGameTime) {
    // Game is active - calculate current round
    const totalSecondsSinceGameStart = Math.floor((nowUTC - gameStartTodayUTC) / 1000);
    const currentRound = Math.floor(totalSecondsSinceGameStart / ROUND_DURATION_SECONDS) + 1; // 1-based round numbering

    // Calculate round time left
    const secondsIntoCurrentRound = totalSecondsSinceGameStart % ROUND_DURATION_SECONDS;
    const roundTimeLeft = Math.max(0, ROUND_DURATION_SECONDS - secondsIntoCurrentRound);

    // Calculate time until game ends (9:00 PM IST)
    const timeUntilGameEnd = Math.max(0, Math.floor((gameEndTodayUTC - nowUTC) / 1000));

    return {
      isActive: true,
      timeUntilEnd: timeUntilGameEnd,
      currentRound: currentRound,
      currentTime: nowUTC,
      roundTimeLeft: roundTimeLeft,
      gameStartTime: gameStartTodayUTC,
      gameEndTime: gameEndTodayUTC,
      // Indian times for display
      gameStartIST: gameStartTodayIST,
      gameEndIST: gameEndTodayIST,
      gameHours: "9:00 AM to 9:00 PM IST"
    };
  } else {
    // Game is closed - calculate time until next game
    let timeUntilNextGame;
    let nextGameStartUTC;
    let nextGameStartIST;

    if (nowUTC < gameStartTodayUTC) {
      // Next game is today at 9:00 AM IST
      nextGameStartUTC = gameStartTodayUTC;
      nextGameStartIST = gameStartTodayIST;
      timeUntilNextGame = Math.floor((gameStartTodayUTC - nowUTC) / 1000);
    } else {
      // Next game is tomorrow at 9:00 AM IST
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

// Store the round start time to properly calculate remaining time
let currentRoundStartTime = null;

// Generate random wheel values for a round
function generateWheelValues() {
  const wheels = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
  const values = {};

  wheels.forEach(wheel => {
    values[wheel] = Math.floor(Math.random() * 10); // 0-9
  });

  return values;
}

function startGameTimer(io) {
  if (gameTimer) clearInterval(gameTimer);
  gameTimer = setInterval(() => {
    const now = new Date();
    const gamePeriod = getCurrentGamePeriod();

    if (gamePeriod.isActive) {
      // Check if game state changed from closed to active
      if (!isGameCurrentlyActive) {
        isGameCurrentlyActive = true;
        console.log('🎮 Game activated at 9:00 AM IST');

        // Send game state to all clients
        io.emit('game-state', {
          ...gamePeriod,
          currentResults: roundResults,
          currentRoundId: currentRoundId
        });
      }

      const roundNumber = gamePeriod.currentRound;

      // Check if we need to start a new round
      if (currentRound !== roundNumber) {
        currentRound = roundNumber;
        currentRoundStartTime = now;
        console.log(`🎮 Starting round ${roundNumber} at ${new Date().toLocaleTimeString('en-IN')} IST`);

        // Generate random wheel values for this round
        currentWheelValues = generateWheelValues();

        // Reset round results
        roundResults = { a1: null, a2: null, b1: null, b2: null, c1: null, c2: null };

        // Start new round with wheel values
        io.emit('round-start', {
          roundNumber: roundNumber,
          duration: ROUND_DURATION_SECONDS,
          roundTimeLeft: ROUND_DURATION_SECONDS,
          wheelValues: currentWheelValues,
          currentTimeIST: new Date(now.getTime() + (5.5 * 60 * 60 * 1000)).toLocaleTimeString('en-IN')
        });
      }

      // Calculate current round time left based on actual elapsed time
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
      // Check if game state changed from active to closed
      if (isGameCurrentlyActive) {
        isGameCurrentlyActive = false;
        console.log('🌙 Game closed at 9:00 PM IST');

        // Reset round tracking
        currentRound = null;
        currentRoundStartTime = null;
        roundResults = { a1: null, a2: null, b1: null, b2: null, c1: null, c2: null };

        // Send game closed notification
        io.emit('game-closed', {
          timeUntilNextGame: gamePeriod.timeUntilNextGame,
          nextGameStart: gamePeriod.nextGameStart,
          nextGameStartIST: gamePeriod.nextGameStartIST,
          message: "Game closed for today. Next game at 9:00 AM IST tomorrow."
        });
      }

      // Send countdown updates when game is closed
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
  }, 1000); // Update every second
}

// Create HTTP server to serve static files and API endpoints
const httpServer = createServer(async (req, res) => {
  const parsedUrl = parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Normalize pathname (remove trailing slash except for root)
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Content-Length': 0
    });
    res.end();
    return;
  }

  // Handle health check endpoint
  if (pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      success: true,
      message: 'Server is running',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Handle API endpoints
  if (pathname === '/api/login' && req.method === 'POST') {
    console.log('Login API request received');
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        if (!body) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, error: 'Request body is required' }));
          return;
        }

        const { username, password } = JSON.parse(body);

        if (!username || !password) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, error: 'Username and password are required' }));
          return;
        }

        const result = await login(username, password);

        if (result.success) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(result));
        }
      } catch (error) {
        console.error('Login API error:', error);
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: false, error: 'Internal server error', details: error.message }));
      }
    });
    return;
  }

  // Handle POST /api/token/verify - Verify token
  if (pathname === '/api/token/verify' && req.method === 'POST') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        // Try to get token from body first, then from Authorization header
        let token = null;

        if (body) {
          try {
            const parsed = JSON.parse(body);
            token = parsed.token;
          } catch (e) {
            // Body is not JSON, ignore
          }
        }

        // If not in body, check Authorization header
        if (!token) {
          const authHeader = req.headers.authorization;
          if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
          }
        }

        if (!token) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, error: 'Token is required. Provide in body as {token: "..."} or in Authorization header as Bearer token' }));
          return;
        }

        const result = await verifyTokenFromDB(token);

        if (result.success) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(result));
        }
      } catch (error) {
        console.error('Verify token API error:', error);
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: false, error: 'Internal server error', details: error.message }));
      }
    });
    return;
  }

  // Handle GET /api/history - Get game history
  if (pathname === '/api/history' && req.method === 'GET') {
    try {
      const result = await getHistory();

      if (result.success) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(result));
      }
    } catch (error) {
      console.error('Get history API error:', error);
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ success: false, error: 'Internal server error', details: error.message }));
    }
    return;
  }

  // Handle POST /api/history - Insert game history
  if (pathname === '/api/history' && req.method === 'POST') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        if (!body) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, error: 'Request body is required' }));
          return;
        }

        const historyData = JSON.parse(body);

        // Validate required fields
        if (historyData.a1 === undefined || historyData.a2 === undefined ||
          historyData.b1 === undefined || historyData.b2 === undefined ||
          historyData.c1 === undefined || historyData.c2 === undefined) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, error: 'All wheel values (a1, a2, b1, b2, c1, c2) are required' }));
          return;
        }

        // Insert history into database
        const result = await insertHistory(historyData);

        if (result.success) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(500, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(result));
        }
      } catch (error) {
        console.error('Insert history API error:', error);
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: false, error: 'Internal server error', details: error.message }));
      }
    });
    return;
  }

  // Log all other requests for debugging
  if (pathname.startsWith('/api/')) {
    console.log(`API endpoint not found: ${req.method} ${pathname}`);
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ success: false, error: 'API endpoint not found' }));
    return;
  }

  // Default to index.html for root path
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  // Build file path
  const filePath = join(process.cwd(), 'public', pathname);

  // Get file extension and MIME type
  const ext = extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'text/plain';

  // Read and serve file
  readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // File not found
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>');
      } else {
        // Server error
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>500 Internal Server Error</h1>');
      }
      return;
    }

    // Serve file
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

// Start the game timer
startGameTimer(io);

io.on('connection', (socket) => {
  console.log('🟢 Socket connected:', socket.id);

  // Send current game state to new connection
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

  socket.on('disconnect', () => {
    // console.log('🔴 Socket disconnected:', socket.id);
  });

  // Handle user selections
  socket.on('user-selection', (data) => {
    // console.log('🎯 User selection:', data);

    // Update server's wheel values
    if (data.a1 !== undefined) currentWheelValues.a1 = data.a1;
    if (data.a2 !== undefined) currentWheelValues.a2 = data.a2;
    if (data.b1 !== undefined) currentWheelValues.b1 = data.b1;
    if (data.b2 !== undefined) currentWheelValues.b2 = data.b2;
    if (data.c1 !== undefined) currentWheelValues.c1 = data.c1;
    if (data.c2 !== undefined) currentWheelValues.c2 = data.c2;

    // console.log('🔄 Updated wheel values:', currentWheelValues);

    // Broadcast updated wheel values to all clients
    io.emit('wheel-values-update', {
      wheelValues: currentWheelValues,
      timestamp: data.timestamp
    });
  });

  // Handle get game state requests
  socket.on('get-game-state', () => {
    const gamePeriod = getCurrentGamePeriod();
    socket.emit('game-state', {
      ...gamePeriod,
      currentResults: roundResults,
      currentRoundId: currentRoundId
    });
  });

  // Handle wheel results
  socket.on('wheel-result', (data) => {
    // console.log('🎡 Wheel result:', data);
    roundResults[data.wheel] = data.result;
    io.emit('wheel-result', data);
  });

  // Handle game results
  socket.on('game-result', async (data) => {
    // console.log('🏆 Game result:', data);



    // Update round results
    Object.assign(roundResults, data.results);

    // Save to database if we have a current round
    if (currentRoundId) {
      await updateGameRound(currentRoundId, {
        ...roundResults,
        status: 'completed'
      });
    }

    io.emit('game-result', data);
  });

  // Handle round save
  socket.on('save-round', async (data) => {
    // console.log('💾 Saving round data:', data);

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
        // console.log(`✅ Round ${data.roundNumber} saved with ID: ${currentRoundId}`);
      }

      io.emit('round-saved', {
        success: result.success,
        roundId: result.roundId,
        roundNumber: data.roundNumber
      });
    } catch (error) {
      // console.error('❌ Error saving round:', error);
      io.emit('round-saved', {
        success: false,
        error: error.message
      });
    }
  });

  // Handle round completio
  socket.on('round-complete', async (data) => {
    // ❌ No active round
    if (!currentRoundId) {
      console.log('⚠️ No active round, ignoring');
      return;
    }

    // 🔒 GLOBAL LOCK CHECK
    if (
      roundCompletionLock.completed &&
      roundCompletionLock.roundId === currentRoundId
    ) {
      console.log('⚠️ Round already completed globally, skipping insert');
      return;
    }

    // 🔐 LOCK THE ROUND
    roundCompletionLock.completed = true;
    roundCompletionLock.roundId = currentRoundId;

    console.log('🏁 Round complete (LOCKED):', currentRoundId);

    try {
      const historyData = {
        roundId: currentRoundId, // 👈 IMPORTANT
        roundStartTime: currentRoundStartTime
          ? currentRoundStartTime.toISOString()
          : new Date().toISOString(),
        a1: roundResults.a1,
        a2: roundResults.a2,
        b1: roundResults.b1,
        b2: roundResults.b2,
        c1: roundResults.c1,
        c2: roundResults.c2
      };

      const historyResult = await insertHistory(historyData);

      if (!historyResult.success) {
        throw new Error(historyResult.error);
      }

      await updateGameRound(currentRoundId, {
        ...roundResults,
        status: 'completed'
      });

      // Reset for next round
      roundResults = { a1: null, a2: null, b1: null, b2: null, c1: null, c2: null };
      currentRoundId = null;

      io.emit('round-complete', data);
      console.log('✅ Round completed & saved ONCE');

    } catch (err) {
      console.error('❌ Round completion failed:', err);

      // 🔓 unlock if DB failed (important)
      roundCompletionLock.completed = false;
    }
  });


});

httpServer.listen(port, (err) => {
  if (err) throw err;
  console.log(`> Ready on http://${hostname}:${port}`);
});