const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// In-memory storage
const users = new Map(); // username -> { password, id }
const rooms = new Map(); // roomCode -> { name, host, users: [], videoUrl }
const socketToUser = new Map(); // socketId -> { username, roomCode }
const userToSocket = new Map(); // username -> socketId

// Routes
app.get('/', (req, res) => {
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'room.html'));
});

// API Routes
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password diperlukan' });
  }
  
  if (users.has(username)) {
    return res.status(400).json({ error: 'Username sudah digunakan' });
  }
  
  const userId = uuidv4();
  users.set(username, { password, id: userId });
  res.json({ success: true, message: 'Registrasi berhasil' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password diperlukan' });
  }
  
  const user = users.get(username);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  
  res.json({ success: true, username });
});

app.post('/api/create-room', (req, res) => {
  const { roomName, username } = req.body;
  
  if (!roomName) {
    return res.status(400).json({ error: 'Nama room diperlukan' });
  }
  
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms.set(roomCode, {
    name: roomName,
    host: username,
    users: [username],
    videoUrl: null,
    videoState: { playing: false, currentTime: 0 }
  });
  
  res.json({ success: true, roomCode, roomName });
});

app.post('/api/join-room', (req, res) => {
  const { roomCode, username } = req.body;
  
  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ error: 'Room tidak ditemukan' });
  }
  
  res.json({ success: true, roomName: room.name, roomCode });
});

app.get('/api/rooms', (req, res) => {
  const roomList = [];
  rooms.forEach((value, key) => {
    roomList.push({
      code: key,
      name: value.name,
      users: value.users.length,
      host: value.host
    });
  });
  res.json(roomList);
});

// Socket.IO Events
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User joins room
  socket.on('join-room', ({ roomCode, username }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room tidak ditemukan' });
      return;
    }
    
    // Check if user already in room
    if (!room.users.includes(username)) {
      room.users.push(username);
    }
    
    socket.join(roomCode);
    socketToUser.set(socket.id, { username, roomCode });
    userToSocket.set(username, socket.id);
    
    // Send room info to user
    socket.emit('room-joined', {
      roomName: room.name,
      roomCode,
      isHost: room.host === username,
      videoUrl: room.videoUrl,
      videoState: room.videoState,
      users: room.users
    });
    
    // Notify others
    socket.to(roomCode).emit('user-joined', { username, users: room.users });
    
    console.log(`${username} joined room ${roomCode}`);
  });

  // Video URL change (host only)
  socket.on('set-video', ({ roomCode, videoUrl, username }) => {
    const room = rooms.get(roomCode);
    if (!room || room.host !== username) return;
    
    room.videoUrl = videoUrl;
    room.videoState = { playing: false, currentTime: 0 };
    
    io.to(roomCode).emit('video-changed', { videoUrl });
  });

  // Video control (host only)
  socket.on('video-control', ({ roomCode, action, currentTime, username }) => {
    const room = rooms.get(roomCode);
    if (!room || room.host !== username) return;
    
    if (action === 'play') {
      room.videoState.playing = true;
      room.videoState.currentTime = currentTime;
    } else if (action === 'pause') {
      room.videoState.playing = false;
      room.videoState.currentTime = currentTime;
    } else if (action === 'seek') {
      room.videoState.currentTime = currentTime;
    }
    
    socket.to(roomCode).emit('video-sync', { action, currentTime });
  });

  // WebRTC Signaling
  socket.on('voice-join', ({ roomCode, username }) => {
    socket.to(roomCode).emit('voice-user-joined', { socketId: socket.id, username });
  });

  socket.on('voice-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('voice-offer', { socketId: socket.id, offer });
  });

  socket.on('voice-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('voice-answer', { socketId: socket.id, answer });
  });

  socket.on('voice-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('voice-ice-candidate', { socketId: socket.id, candidate });
  });

  // Chat message
  socket.on('chat-message', ({ roomCode, username, message }) => {
    io.to(roomCode).emit('chat-message', { username, message, time: new Date().toLocaleTimeString() });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const userData = socketToUser.get(socket.id);
    if (userData) {
      const { username, roomCode } = userData;
      const room = rooms.get(roomCode);
      
      if (room) {
        // Remove user from room
        room.users = room.users.filter(u => u !== username);
        
        // Notify others
        socket.to(roomCode).emit('user-left', { username, users: room.users });
        
        // Delete room if empty or transfer host
        if (room.users.length === 0) {
          rooms.delete(roomCode);
          console.log(`Room ${roomCode} deleted (empty)`);
        } else if (room.host === username) {
          // Transfer host to next user
          room.host = room.users[0];
          io.to(roomCode).emit('host-changed', { newHost: room.host });
        }
      }
      
      socketToUser.delete(socket.id);
      userToSocket.delete(username);
      console.log(`${username} disconnected`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Watch Party server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
