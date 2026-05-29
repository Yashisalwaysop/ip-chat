/* ============================================
   IP-CHAT — Client Application (Production)
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

  const backBtn          = document.getElementById('back-btn');
  const roomIdText       = document.getElementById('room-id-text');
  const userCount        = document.getElementById('user-count');
  const messagesEl       = document.getElementById('messages');
  const typingInd        = document.getElementById('typing-indicator');
  const typingText       = document.getElementById('typing-text');
  const messageInput     = document.getElementById('message-input');
  const sendBtn          = document.getElementById('send-btn');
  const copyBtn          = document.getElementById('copy-room-btn');
  const toast            = document.getElementById('toast');
  const sidebarAvatar    = document.getElementById('sidebar-user-avatar');
  const reconnectBanner  = document.getElementById('reconnect-banner');
  const usersPanel       = document.getElementById('users-panel');
  const usersPanelList   = document.getElementById('users-panel-list');
  const usersPanelClose  = document.getElementById('users-panel-close');
  const usersSidebarBtn  = document.getElementById('users-sidebar-btn');
  const muteToggleBtn    = document.getElementById('mute-toggle-btn');
  const muteIconOff      = document.getElementById('mute-icon-off');
  const muteIconOn       = document.getElementById('mute-icon-on');
  const charCounter      = document.getElementById('char-counter');

  // --- Constants ---
  const MAX_MESSAGE_LENGTH = 2000;
  const CHAR_WARN_THRESHOLD = 1800;
  const CHAR_DANGER_THRESHOLD = 1950;
  const ROOM_ID_REGEX = /^\d+(\.\d+)+$/;

  // --- State ---
  let socket = null;
  let currentRoom = null;
  let myNickname = null;
  let typingTimeout = null;
  let isTyping = false;
  let soundEnabled = false;
  let unreadCount = 0;
  let documentFocused = true;
  let originalTitle = 'IP-Chat · Anonymous Rooms';
  const typingUsers = new Map();
  let onlineUsers = []; // current room user list

  // --- Particle Background ---
  function initParticles() {
    const canvas = document.getElementById('particle-canvas');
    const ctx = canvas.getContext('2d');
    let particles = [];

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
      requestAnimationFrame(animate);
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
      socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000 });
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
      onlineUsers = data.users || [];
      showChatScreen(data);
      hideReconnectBanner();
    });

    socket.on('new-message', (msg) => {
      appendMessage(msg);
      scrollToBottom();

      // Unread badge when tab not focused
      if (!documentFocused && msg.nickname !== myNickname) {
        unreadCount++;
        document.title = `(${unreadCount}) ${originalTitle}`;
      }

      // Sound beep for others' messages
      if (soundEnabled && msg.nickname !== myNickname) {
        playBeep();
      }
    });

    socket.on('user-joined', (data) => {
      appendSystemMessage(`<span class="sys-highlight">${escapeHtml(data.nickname)}</span> joined the room`);
      updateUserCount(data.userCount);
      if (data.users) {
        onlineUsers = data.users;
        renderUsersPanel();
      }
      scrollToBottom();
    });

    socket.on('user-left', (data) => {
      appendSystemMessage(`<span class="sys-highlight">${escapeHtml(data.nickname)}</span> left the room`);
      updateUserCount(data.userCount);
      if (data.users) {
        onlineUsers = data.users;
        renderUsersPanel();
      }
      // Remove from typing
      typingUsers.delete(data.nickname);
      updateTypingIndicator();
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

    socket.on('rate-limited', () => {
      showToast('Slow down! You\'re sending messages too fast.');
    });

    socket.on('users-list', (data) => {
      if (data.users) {
        onlineUsers = data.users;
        renderUsersPanel();
      }
    });

    socket.on('message-reaction', (data) => {
      applyReaction(data.messageId, data.emoji, data.count);
    });

    // --- Reconnection Flow ---
    socket.on('disconnect', () => {
      showReconnectBanner();
    });

    socket.on('connect', () => {
      hideReconnectBanner();
      // Re-join the room on reconnect
      if (currentRoom && myNickname) {
        socket.emit('join-room', { roomId: currentRoom, nickname: myNickname });
      }
    });
  }

  // --- Reconnect Banner ---
  function showReconnectBanner() {
    reconnectBanner.classList.add('visible');
  }

  function hideReconnectBanner() {
    reconnectBanner.classList.remove('visible');
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

    // Populate users panel
    if (data.users) {
      onlineUsers = data.users;
      renderUsersPanel();
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
    onlineUsers = [];
    roomInput.value = '';
    nickInput.value = '';
    inputStatus.className = 'input-status';
    inputStatus.textContent = '';
    joinBtn.disabled = true;
    errorMsg.textContent = '';
    unreadCount = 0;
    document.title = originalTitle;
    hideUsersPanel();
  }

  backBtn.addEventListener('click', showHomeScreen);

  // --- Messages ---
  function appendMessage(msg, animate = true) {
    const isSelf = msg.nickname === myNickname;
    const div = document.createElement('div');
    div.className = `message-bubble${isSelf ? ' self' : ''}`;
    div.setAttribute('data-msg-id', msg.id);
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

    // Apply existing reactions from history
    if (msg.reactions && msg.reactions['❤️'] && msg.reactions['❤️'] > 0) {
      const badge = createReactionBadge('❤️', msg.reactions['❤️']);
      div.appendChild(badge);
      div.style.position = 'relative';
    }

    // Double-click for reaction
    div.addEventListener('dblclick', () => {
      if (socket && currentRoom) {
        socket.emit('react', { messageId: msg.id });
      }
    });

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

  // --- Reactions ---
  function createReactionBadge(emoji, count) {
    const badge = document.createElement('div');
    badge.className = 'reaction-badge';
    badge.textContent = `${emoji} ${count}`;
    return badge;
  }

  function applyReaction(messageId, emoji, count) {
    const bubble = messagesEl.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!bubble) return;

    bubble.style.position = 'relative';

    // Update or create badge
    let badge = bubble.querySelector('.reaction-badge');
    if (badge) {
      badge.textContent = `${emoji} ${count}`;
    } else {
      badge = createReactionBadge(emoji, count);
      bubble.appendChild(badge);
    }
  }

  // --- Send Message ---
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !socket || !currentRoom) return;

    socket.emit('send-message', { message: text });
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    updateCharCounter();

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

    // Character counter
    updateCharCounter();

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

  // --- Character Counter ---
  function updateCharCounter() {
    const len = messageInput.value.length;
    if (len > CHAR_WARN_THRESHOLD) {
      charCounter.textContent = `${len}/${MAX_MESSAGE_LENGTH}`;
      charCounter.style.display = 'block';
      if (len >= CHAR_DANGER_THRESHOLD) {
        charCounter.classList.add('danger');
      } else {
        charCounter.classList.remove('danger');
      }
    } else {
      charCounter.style.display = 'none';
      charCounter.classList.remove('danger');
    }
  }

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

  // --- Users Panel ---
  function renderUsersPanel() {
    usersPanelList.innerHTML = '';
    onlineUsers.forEach(name => {
      const row = document.createElement('div');
      row.className = 'users-panel-row';

      const avatar = document.createElement('div');
      avatar.className = 'users-panel-avatar';
      avatar.textContent = name.charAt(0).toUpperCase();

      const nick = document.createElement('span');
      nick.className = 'users-panel-nick';
      nick.textContent = escapeHtml(name);

      if (name === myNickname) {
        const youBadge = document.createElement('span');
        youBadge.className = 'users-panel-you';
        youBadge.textContent = '(you)';
        nick.appendChild(youBadge);
      }

      row.appendChild(avatar);
      row.appendChild(nick);
      usersPanelList.appendChild(row);
    });
  }

  function showUsersPanel() {
    usersPanel.hidden = false;
    // Trigger reflow for animation
    void usersPanel.offsetWidth;
    usersPanel.classList.add('open');
    // Request fresh user list
    if (socket) socket.emit('get-users');
  }

  function hideUsersPanel() {
    usersPanel.classList.remove('open');
    setTimeout(() => {
      usersPanel.hidden = true;
    }, 250);
  }

  usersSidebarBtn.addEventListener('click', () => {
    if (usersPanel.classList.contains('open')) {
      hideUsersPanel();
    } else {
      showUsersPanel();
    }
  });

  usersPanelClose.addEventListener('click', hideUsersPanel);

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (usersPanel.classList.contains('open') &&
        !usersPanel.contains(e.target) &&
        e.target !== usersSidebarBtn &&
        !usersSidebarBtn.contains(e.target)) {
      hideUsersPanel();
    }
  });

  // --- Sound Toggle ---
  muteToggleBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    if (soundEnabled) {
      muteIconOff.style.display = 'none';
      muteIconOn.style.display = 'block';
      muteToggleBtn.classList.add('active');
    } else {
      muteIconOff.style.display = 'block';
      muteIconOn.style.display = 'none';
      muteToggleBtn.classList.remove('active');
    }
  });

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);

      // Cleanup
      osc.onended = () => ctx.close();
    } catch (_) {
      // Web Audio not available — silently ignore
    }
  }

  // --- Unread Badge (tab focus) ---
  window.addEventListener('focus', () => {
    documentFocused = true;
    unreadCount = 0;
    document.title = originalTitle;
  });

  window.addEventListener('blur', () => {
    documentFocused = false;
  });

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
