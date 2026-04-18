const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room storage
// rooms = { 'roomId': { messages: [], users: Set() } }
const rooms = {};

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      messages: [],
      users: new Map() // socketId -> { nickname, joinedAt }
    };
  }
  return rooms[roomId];
}

function generateAnonId() {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, nickname }) => {
    // Validate room ID format
    if (!/^\d+(\.\d+)+$/.test(roomId)) {
      socket.emit('error-msg', 'Invalid room ID format. Use dot-separated numbers (e.g. 1.1.1.1)');
      return;
    }

    // Leave previous room if any
    if (currentRoom) {
      const prevRoom = rooms[currentRoom];
      if (prevRoom) {
        const userData = prevRoom.users.get(socket.id);
        prevRoom.users.delete(socket.id);
        io.to(currentRoom).emit('user-left', {
          nickname: userData?.nickname || 'Anonymous',
          userCount: prevRoom.users.size
        });
        // Clean up empty rooms
        if (prevRoom.users.size === 0) {
          delete rooms[currentRoom];
        }
      }
      socket.leave(currentRoom);
    }

    currentRoom = roomId;
    const room = getOrCreateRoom(roomId);

    const displayName = nickname?.trim() || `anon_${generateAnonId()}`;

    room.users.set(socket.id, {
      nickname: displayName,
      joinedAt: Date.now()
    });

    socket.join(roomId);

    // Send room info and history to the joining user
    socket.emit('room-joined', {
      roomId,
      nickname: displayName,
      messages: room.messages,
      userCount: room.users.size,
      users: Array.from(room.users.values()).map(u => u.nickname)
    });

    // Notify others in the room
    socket.to(roomId).emit('user-joined', {
      nickname: displayName,
      userCount: room.users.size
    });
  });

  socket.on('send-message', ({ message }) => {
    if (!currentRoom || !message?.trim()) return;

    const room = rooms[currentRoom];
    if (!room) return;

    const userData = room.users.get(socket.id);
    if (!userData) return;

    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      nickname: userData.nickname,
      message: message.trim().slice(0, 2000), // Limit message length
      timestamp: Date.now()
    };

    room.messages.push(msg);

    // Keep only last 200 messages per room
    if (room.messages.length > 200) {
      room.messages = room.messages.slice(-200);
    }

    io.to(currentRoom).emit('new-message', msg);
  });

  socket.on('typing', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const userData = room.users.get(socket.id);
    if (!userData) return;
    socket.to(currentRoom).emit('user-typing', { nickname: userData.nickname });
  });

  socket.on('stop-typing', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('user-stop-typing', { nickname: socket.id });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      const userData = room.users.get(socket.id);
      room.users.delete(socket.id);

      io.to(currentRoom).emit('user-left', {
        nickname: userData?.nickname || 'Anonymous',
        userCount: room.users.size
      });

      // Clean up empty rooms
      if (room.users.size === 0) {
        delete rooms[currentRoom];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🔒 IP-Chat server running at http://localhost:${PORT}\n`);
});
