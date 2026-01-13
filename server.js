import { createServer } from 'http';
import { parse } from 'url';
import { readFile } from 'fs';
import { extname, join } from 'path';
import { Server } from 'socket.io';
import { saveGameRound, updateGameRound, getCurrentGameRound, insertHistory } from './lib/dbWrk.js';

const hostname = 'localhost';
const port = process.env.PORT || 8000;

// Game timing constants (in UTC)
// 9:00 AM IST = 3:30 AM UTC (IST is UTC+5:30)
// 9:00 PM IST = 3:30 PM UTC
const GAME_START_HOUR = 3;
const GAME_START_MINUTE = 30;
const GAME_DURATION_MINUTES = 12 * 60; // 12 hours in minutes
const ROUND_DURATION_SECONDS = 1 * 60; // 2 minutes per round
const SAVE_BEFORE_END_SECONDS = 30; // Save 30 seconds before end

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
  const currentHour = nowUTC.getHours();
  const currentMinute = nowUTC.getMinutes();

  // Check if current time is within game hours (9:00 AM to 9:00 PM IST / 3:30 AM to 3:30 PM UTC)
  const currentTimeMinutes = currentHour * 60 + currentMinute;
  const gameStartMinutes = GAME_START_HOUR * 60 + GAME_START_MINUTE;
  const gameEndMinutes = gameStartMinutes + GAME_DURATION_MINUTES;

  if (currentTimeMinutes >= gameStartMinutes && currentTimeMinutes < gameEndMinutes) {
    const elapsedMinutes = currentTimeMinutes - gameStartMinutes;
    const currentRound = Math.floor(elapsedMinutes / (ROUND_DURATION_SECONDS / 60)) + 1; // 1-based round numbering
    const roundStartMinutes = gameStartMinutes + (currentRound - 1) * (ROUND_DURATION_SECONDS / 60);
    const roundElapsedSeconds = (currentTimeMinutes - roundStartMinutes) * 60;

    return {
      isActive: true,
      timeUntilEnd: gameEndMinutes - currentTimeMinutes,
      currentRound: currentRound,
      roundTimeLeft: ROUND_DURATION_SECONDS - roundElapsedSeconds,
      gameStartTime: new Date(nowUTC.getFullYear(), nowUTC.getMonth(), nowUTC.getDate(), GAME_START_HOUR, GAME_START_MINUTE),
      gameEndTime: new Date(nowUTC.getFullYear(), nowUTC.getMonth(), nowUTC.getDate(), GAME_START_HOUR + 12, GAME_START_MINUTE)
    };
  }

  // Calculate time until next game starts
  let nextGameDate = new Date(nowUTC);

  // If current time is before today's game start time, next game is today at 9 AM UTC
  // If current time is after today's game end time, next game is tomorrow at 9 AM UTC
  if (currentTimeMinutes < gameStartMinutes) {
    // Before 3:30 AM UTC today - next game is today at 3:30 AM UTC
    nextGameDate.setHours(GAME_START_HOUR, GAME_START_MINUTE, 0, 0);
  } else {
    // After 3:30 PM UTC today - next game is tomorrow at 3:30 AM UTC
    nextGameDate.setDate(nextGameDate.getDate() + 1);
    nextGameDate.setHours(GAME_START_HOUR, GAME_START_MINUTE, 0, 0);
  }

  const timeUntilStartMs = nextGameDate.getTime() - nowUTC.getTime();
  const timeUntilStartSeconds = Math.floor(timeUntilStartMs / 1000);

  return {
    isActive: false,
    timeUntilStart: timeUntilStartSeconds, // Return seconds directly
    currentRound: null,
    roundTimeLeft: 0,
    nextGameStart: nextGameDate
  };
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
        // console.log('🎮 Game activated');
      }

      const timeLeft = gamePeriod.timeUntilEnd * 60; // Convert to seconds
      const roundNumber = gamePeriod.currentRound;

      if (currentRound !== roundNumber) {
        currentRound = roundNumber;
        currentRoundStartTime = now;
        // console.log(`🎮 Starting round ${roundNumber}`);

        // Generate random wheel values for this round
        currentWheelValues = generateWheelValues();

        // Start new round with wheel values
        io.emit('round-start', {
          roundNumber: roundNumber,
          duration: ROUND_DURATION_SECONDS,
          saveAt: ROUND_DURATION_SECONDS - SAVE_BEFORE_END_SECONDS,
          roundTimeLeft: ROUND_DURATION_SECONDS,
          wheelValues: currentWheelValues
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
        timeLeft,
        roundNumber: roundNumber,
        roundTimeLeft: currentRoundTimeLeft,
        isActive: true
      });
    } else {
      // Check if game state changed from active to closed
      if (isGameCurrentlyActive) {
        isGameCurrentlyActive = false;
        // console.log('🌙 Game closed');

        // Send game closed notification only when state changes
        io.emit('game-closed', {
          timeUntilNextGame: gamePeriod.timeUntilStart, // Already in seconds
          nextGameStart: gamePeriod.nextGameStart
        });
      }

      currentRoundStartTime = null;
      // Don't send timer updates when game is closed - client handles its own countdown
    }
  }, 1000);
}

// Create HTTP server to serve static files
const httpServer = createServer((req, res) => {
  const parsedUrl = parse(req.url, true);
  let pathname = parsedUrl.pathname;

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
    // console.log('🟢 Socket connected:', socket.id);

    // Send current game state to new connection
    const gamePeriod = getCurrentGamePeriod();
    socket.emit('game-state', {
      ...gamePeriod,
      currentResults: roundResults,
      currentRoundId: currentRoundId
    });

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
      insertHistory(currentWheelValues);
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
        console.error('❌ Error saving round:', error);
        io.emit('round-saved', {
          success: false,
          error: error.message
        });
      }
    });

    // Handle round completion
    socket.on('round-complete', async (data) => {
      // console.log('🏁 Round complete:', data);

      if (currentRoundId) {
        await updateGameRound(currentRoundId, {
          ...roundResults,
          status: 'completed'
        });

        // Reset for next round
        roundResults = { a1: null, a2: null, b1: null, b2: null, c1: null, c2: null };
        currentRoundId = null;
      }

      io.emit('round-complete', data);
    });
});

httpServer.listen(port, (err) => {
  if (err) throw err;
  console.log(`> Ready on http://${hostname}:${port}`);
});
