const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

/* ============================================
   CONSTANTS
   ============================================ */
const MAX_MESSAGE_LENGTH = 2000;
const MAX_NICKNAME_LENGTH = 20;
const MAX_ROOMS = 500;
const MAX_USERS_PER_ROOM = 50;
const RATE_LIMIT_WINDOW_MS = 3000;
const RATE_LIMIT_MAX = 5;
const ROOM_KEEPALIVE_MS = 60000; // 60 seconds after last user leaves
const MESSAGE_HISTORY_LIMIT = 200;

/* ============================================
   SERVER SETUP
   ============================================ */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 25000,
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================
   IN-MEMORY STORAGE
   ============================================ */
// rooms = { roomId: { messages: [], users: Map<socketId, {nickname, joinedAt}>, cleanupTimer: null } }
const rooms = {};

/* ============================================
   HELPERS
   ============================================ */

/** Strip all HTML tags from a string */
function stripHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '');
}

/** Sanitize and enforce max length */
function sanitizeString(str, maxLength) {
  if (typeof str !== 'string') return '';
  return stripHtml(str).trim().slice(0, maxLength);
}

/** Generate a random 6-char hex-style ID */
function generateAnonId() {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Get or create a room, cancelling any pending cleanup timer */
function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      messages: [],
      users: new Map(),
      cleanupTimer: null,
    };
  } else if (rooms[roomId].cleanupTimer) {
    // Room exists with a pending cleanup — cancel it
    clearTimeout(rooms[roomId].cleanupTimer);
    rooms[roomId].cleanupTimer = null;
  }
  return rooms[roomId];
}

/** Schedule room cleanup after the keepalive period */
function scheduleRoomCleanup(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Only schedule if truly empty
  if (room.users.size > 0) return;

  // Clear any existing timer
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
  }

  room.cleanupTimer = setTimeout(() => {
    // Double-check still empty
    if (rooms[roomId] && rooms[roomId].users.size === 0) {
      delete rooms[roomId];
    }
  }, ROOM_KEEPALIVE_MS);
}

/** Get list of user nicknames in a room */
function getRoomUserList(roomId) {
  const room = rooms[roomId];
  if (!room) return [];
  return Array.from(room.users.values()).map((u) => u.nickname);
}

/** Count active rooms (excluding those with only a cleanup timer and no users) */
function countActiveRooms() {
  return Object.keys(rooms).length;
}

/* ============================================
   RATE LIMITER (per socket)
   ============================================ */
function createRateLimiter() {
  const timestamps = [];

  return function isRateLimited() {
    const now = Date.now();
    // Remove timestamps outside the window
    while (timestamps.length > 0 && now - timestamps[0] > RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length >= RATE_LIMIT_MAX) {
      return true;
    }
    timestamps.push(now);
    return false;
  };
}

/* ============================================
   SOCKET.IO CONNECTION HANDLER
   ============================================ */
io.on('connection', (socket) => {
  let currentRoom = null;
  const checkRateLimit = createRateLimiter();

  /** Leave the current room (used on disconnect, room-switch, and back) */
  function leaveCurrentRoom() {
    if (!currentRoom || !rooms[currentRoom]) return;

    const room = rooms[currentRoom];
    const userData = room.users.get(socket.id);
    room.users.delete(socket.id);
    socket.leave(currentRoom);

    io.to(currentRoom).emit('user-left', {
      nickname: userData?.nickname || 'Anonymous',
      userCount: room.users.size,
      users: getRoomUserList(currentRoom),
    });

    // Schedule cleanup instead of immediate deletion
    if (room.users.size === 0) {
      scheduleRoomCleanup(currentRoom);
    }

    currentRoom = null;
  }

  /* ---------- JOIN ROOM ---------- */
  socket.on('join-room', ({ roomId, nickname }) => {
    // Sanitize inputs
    roomId = sanitizeString(roomId || '', 50);
    nickname = sanitizeString(nickname || '', MAX_NICKNAME_LENGTH);

    // Validate room ID format
    if (!/^\d+(\.\d+)+$/.test(roomId)) {
      socket.emit('error-msg', 'Invalid room ID format. Use dot-separated numbers (e.g. 1.1.1.1)');
      return;
    }

    // Check room cap (only for genuinely new rooms)
    if (!rooms[roomId] && countActiveRooms() >= MAX_ROOMS) {
      socket.emit('error-msg', 'Server room limit reached. Please try again later.');
      return;
    }

    // Leave previous room if any
    if (currentRoom) {
      leaveCurrentRoom();
    }

    const room = getOrCreateRoom(roomId);

    // Check user cap for this room
    if (room.users.size >= MAX_USERS_PER_ROOM) {
      socket.emit('error-msg', `Room is full (max ${MAX_USERS_PER_ROOM} users).`);
      return;
    }

    const displayName = nickname || `anon_${generateAnonId()}`;

    currentRoom = roomId;
    room.users.set(socket.id, {
      nickname: displayName,
      joinedAt: Date.now(),
    });

    socket.join(roomId);

    // Send room info and history to the joining user
    socket.emit('room-joined', {
      roomId,
      nickname: displayName,
      messages: room.messages,
      userCount: room.users.size,
      users: getRoomUserList(roomId),
    });

    // Notify others in the room
    socket.to(roomId).emit('user-joined', {
      nickname: displayName,
      userCount: room.users.size,
      users: getRoomUserList(roomId),
    });
  });

  /* ---------- SEND MESSAGE ---------- */
  socket.on('send-message', ({ message }) => {
    if (!currentRoom || !rooms[currentRoom]) return;

    // Rate limit check — silently drop and notify sender
    if (checkRateLimit()) {
      socket.emit('rate-limited', { message: 'You are sending messages too fast.' });
      return;
    }

    // Sanitize message
    const cleaned = sanitizeString(message || '', MAX_MESSAGE_LENGTH);
    if (!cleaned) return;

    const room = rooms[currentRoom];
    const userData = room.users.get(socket.id);
    if (!userData) return;

    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      nickname: userData.nickname,
      message: cleaned,
      timestamp: Date.now(),
      reactions: {},
    };

    room.messages.push(msg);

    // Keep only last N messages per room
    if (room.messages.length > MESSAGE_HISTORY_LIMIT) {
      room.messages = room.messages.slice(-MESSAGE_HISTORY_LIMIT);
    }

    io.to(currentRoom).emit('new-message', msg);
  });

  /* ---------- TYPING ---------- */
  socket.on('typing', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const userData = rooms[currentRoom].users.get(socket.id);
    if (!userData) return;
    socket.to(currentRoom).emit('user-typing', { nickname: userData.nickname });
  });

  /* ---------- STOP TYPING (BUG FIX: was sending socket.id instead of nickname) ---------- */
  socket.on('stop-typing', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const userData = rooms[currentRoom].users.get(socket.id);
    if (!userData) return;
    socket.to(currentRoom).emit('user-stop-typing', { nickname: userData.nickname });
  });

  /* ---------- GET USERS ---------- */
  socket.on('get-users', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    socket.emit('users-list', {
      users: getRoomUserList(currentRoom),
    });
  });

  /* ---------- REACTIONS ---------- */
  socket.on('react', ({ messageId }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const userData = room.users.get(socket.id);
    if (!userData) return;

    // Sanitize messageId
    const safeId = sanitizeString(messageId || '', 30);
    if (!safeId) return;

    // Find the message
    const msg = room.messages.find((m) => m.id === safeId);
    if (!msg) return;

    // Initialize reactions if needed
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions['❤️']) msg.reactions['❤️'] = 0;
    msg.reactions['❤️']++;

    io.to(currentRoom).emit('message-reaction', {
      messageId: safeId,
      emoji: '❤️',
      count: msg.reactions['❤️'],
    });
  });

  /* ---------- DISCONNECT ---------- */
  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });
});

/* ============================================
   START SERVER
   ============================================ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🔒 IP-Chat server running at http://localhost:${PORT}\n`);
});
