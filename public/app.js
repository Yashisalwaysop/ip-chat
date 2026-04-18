/* ============================================
   IP-CHAT — Client Application
   ============================================ */

(() => {
  'use strict';

  // --- DOM Elements ---
  const homeScreen  = document.getElementById('home-screen');
  const chatScreen  = document.getElementById('chat-screen');
  const roomInput   = document.getElementById('room-id-input');
  const nickInput   = document.getElementById('nickname-input');
  const joinBtn     = document.getElementById('join-btn');
  const inputStatus = document.getElementById('input-status');
  const errorMsg    = document.getElementById('error-msg');

  const backBtn       = document.getElementById('back-btn');
  const roomIdText    = document.getElementById('room-id-text');
  const userCount     = document.getElementById('user-count');
  const messagesEl    = document.getElementById('messages');
  const welcomeMsg    = document.getElementById('welcome-msg');
  const typingInd     = document.getElementById('typing-indicator');
  const typingText    = document.getElementById('typing-text');
  const messageInput  = document.getElementById('message-input');
  const sendBtn       = document.getElementById('send-btn');
  const copyBtn       = document.getElementById('copy-room-btn');
  const toast         = document.getElementById('toast');
  const sidebarAvatar = document.getElementById('sidebar-user-avatar');

  // --- State ---
  let socket = null;
  let currentRoom = null;
  let myNickname = null;
  let typingTimeout = null;
  let isTyping = false;
  const typingUsers = new Map();
  const ROOM_ID_REGEX = /^\d+(\.\d+)+$/;

  // --- Particle Background (Soft blue/purple) ---
  function initParticles() {
    const canvas = document.getElementById('particle-canvas');
    const ctx = canvas.getContext('2d');
    let particles = [];
    let animFrame;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    resize();
    window.addEventListener('resize', resize);

    class Particle {
      constructor() {
        this.reset();
      }
      reset() {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.vx = (Math.random() - 0.5) * 0.2;
        this.vy = (Math.random() - 0.5) * 0.2;
        this.radius = Math.random() * 1 + 0.3;
        this.opacity = Math.random() * 0.2 + 0.03;
      }
      update() {
        this.x += this.vx;
        this.y += this.vy;
        if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
        if (this.y < 0 || this.y > canvas.height) this.vy *= -1;
      }
      draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity})`;
        ctx.fill();
      }
    }

    const count = Math.min(50, Math.floor((canvas.width * canvas.height) / 25000));
    for (let i = 0; i < count; i++) {
      particles.push(new Particle());
    }

    function drawLines() {
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 100) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(255, 255, 255, ${0.03 * (1 - dist / 100)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
    }

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.update();
        p.draw();
      });
      drawLines();
      animFrame = requestAnimationFrame(animate);
    }

    animate();
  }

  initParticles();

  // --- Validation ---
  function validateRoomId(value) {
    return ROOM_ID_REGEX.test(value.trim());
  }

  roomInput.addEventListener('input', () => {
    const val = roomInput.value.trim();
    errorMsg.textContent = '';

    if (!val) {
      inputStatus.className = 'input-status';
      inputStatus.textContent = '';
      joinBtn.disabled = true;
      return;
    }

    if (validateRoomId(val)) {
      inputStatus.className = 'input-status valid';
      inputStatus.textContent = '✓';
      joinBtn.disabled = false;
    } else {
      inputStatus.className = 'input-status invalid';
      inputStatus.textContent = '✗';
      joinBtn.disabled = true;
    }
  });

  // --- Join Room ---
  function joinRoom() {
    const roomId = roomInput.value.trim();
    const nickname = nickInput.value.trim();

    if (!validateRoomId(roomId)) {
      errorMsg.textContent = 'Invalid format. Use dot-separated numbers (e.g. 42.100.7.3)';
      return;
    }

    // Connect to server
    if (!socket) {
      socket = io();
      setupSocketListeners();
    }

    socket.emit('join-room', { roomId, nickname });
  }

  joinBtn.addEventListener('click', joinRoom);

  // Enter key on inputs
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinRoom();
  });

  nickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinRoom();
  });

  // --- Socket Listeners ---
  function setupSocketListeners() {
    socket.on('room-joined', (data) => {
      currentRoom = data.roomId;
      myNickname = data.nickname;
      showChatScreen(data);
    });

    socket.on('new-message', (msg) => {
      appendMessage(msg);
      scrollToBottom();
    });

    socket.on('user-joined', (data) => {
      appendSystemMessage(`<span class="sys-highlight">${escapeHtml(data.nickname)}</span> joined the room`);
      updateUserCount(data.userCount);
      scrollToBottom();
    });

    socket.on('user-left', (data) => {
      appendSystemMessage(`<span class="sys-highlight">${escapeHtml(data.nickname)}</span> left the room`);
      updateUserCount(data.userCount);
      scrollToBottom();
    });

    socket.on('user-typing', (data) => {
      typingUsers.set(data.nickname, Date.now());
      updateTypingIndicator();
    });

    socket.on('user-stop-typing', (data) => {
      typingUsers.delete(data.nickname);
      updateTypingIndicator();
    });

    socket.on('error-msg', (msg) => {
      errorMsg.textContent = msg;
    });

    socket.on('disconnect', () => {
      appendSystemMessage('Connection lost. Reconnecting...');
    });

    socket.on('connect', () => {
      if (currentRoom) {
        socket.emit('join-room', { roomId: currentRoom, nickname: myNickname });
      }
    });
  }

  // --- Screen Transitions ---
  function showChatScreen(data) {
    homeScreen.classList.remove('active');
    setTimeout(() => {
      chatScreen.classList.add('active');
    }, 100);

    roomIdText.textContent = data.roomId;
    updateUserCount(data.userCount);

    // Set sidebar avatar initial
    const initial = data.nickname.charAt(0).toUpperCase();
    sidebarAvatar.textContent = initial;
    sidebarAvatar.title = data.nickname;

    // Clear previous messages
    messagesEl.innerHTML = '';

    // Add welcome message
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'welcome-msg';
    welcomeDiv.innerHTML = `
      <div class="welcome-icon">🔐</div>
      <p>You're connected as <strong style="color: #fff">${escapeHtml(data.nickname)}</strong><br>
      Share room ID <strong style="color: rgba(255,255,255,0.7); font-weight: 600">${escapeHtml(data.roomId)}</strong> to invite others.</p>
    `;
    messagesEl.appendChild(welcomeDiv);

    // Load history
    if (data.messages && data.messages.length > 0) {
      data.messages.forEach(msg => appendMessage(msg, false));
    }

    scrollToBottom();
    messageInput.focus();
  }

  function showHomeScreen() {
    chatScreen.classList.remove('active');
    setTimeout(() => {
      homeScreen.classList.add('active');
    }, 100);

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    currentRoom = null;
    myNickname = null;
    typingUsers.clear();
    roomInput.value = '';
    nickInput.value = '';
    inputStatus.className = 'input-status';
    inputStatus.textContent = '';
    joinBtn.disabled = true;
    errorMsg.textContent = '';
  }

  backBtn.addEventListener('click', showHomeScreen);

  // --- Messages ---
  function appendMessage(msg, animate = true) {
    // Remove welcome message if it's the first real message
    const welcome = messagesEl.querySelector('.welcome-msg');
    // Keep welcome; messages appear below it

    const isSelf = msg.nickname === myNickname;
    const div = document.createElement('div');
    div.className = `message-bubble${isSelf ? ' self' : ''}`;
    if (!animate) div.style.animation = 'none';

    const time = new Date(msg.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-nickname">${escapeHtml(msg.nickname)}</span>
        <span class="msg-time">${timeStr}</span>
      </div>
      <div class="msg-text">${escapeHtml(msg.message)}</div>
    `;

    messagesEl.appendChild(div);
  }

  function appendSystemMessage(html) {
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.innerHTML = html;
    messagesEl.appendChild(div);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function updateUserCount(count) {
    const countText = userCount.querySelector('.count-text');
    countText.textContent = `${count} online`;
  }

  // --- Send Message ---
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !socket || !currentRoom) return;

    socket.emit('send-message', { message: text });
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;

    // Stop typing
    if (isTyping) {
      socket.emit('stop-typing');
      isTyping = false;
    }
  }

  sendBtn.addEventListener('click', sendMessage);

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener('input', () => {
    // Auto-resize textarea
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';

    // Enable/disable send button
    sendBtn.disabled = !messageInput.value.trim();

    // Typing indicator
    if (!isTyping && messageInput.value.trim()) {
      isTyping = true;
      socket.emit('typing');
    }

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (isTyping) {
        isTyping = false;
        socket.emit('stop-typing');
      }
    }, 2000);
  });

  // --- Typing Indicator ---
  function updateTypingIndicator() {
    // Clean stale entries (older than 3 seconds)
    const now = Date.now();
    for (const [name, time] of typingUsers) {
      if (now - time > 3000) {
        typingUsers.delete(name);
      }
    }

    // Filter out self
    const others = [...typingUsers.keys()].filter(n => n !== myNickname);

    if (others.length === 0) {
      typingInd.classList.add('hidden');
      return;
    }

    typingInd.classList.remove('hidden');

    if (others.length === 1) {
      typingText.textContent = `${others[0]} is typing...`;
    } else if (others.length === 2) {
      typingText.textContent = `${others[0]} and ${others[1]} are typing...`;
    } else {
      typingText.textContent = `${others.length} people are typing...`;
    }
  }

  // Periodically clean typing indicators
  setInterval(updateTypingIndicator, 2000);

  // --- Copy Room ID ---
  copyBtn.addEventListener('click', () => {
    if (!currentRoom) return;
    navigator.clipboard.writeText(currentRoom).then(() => {
      showToast('Room ID copied to clipboard!');
    }).catch(() => {
      showToast('Failed to copy');
    });
  });

  // --- Toast ---
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 300);
    }, 2000);
  }

  // --- Helpers ---
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

})();
