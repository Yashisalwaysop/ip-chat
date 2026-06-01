/* ============================================
   IP-CHAT — Client Application (Production)
   Supports:  /home  (index.html — join card)
              /room/:roomId  (room.html — direct room)
   ============================================ */

(() => {
  'use strict';

  // --- Constants ---
  const MAX_MESSAGE_LENGTH = 2000;
  const CHAR_WARN_THRESHOLD = 1800;
  const CHAR_DANGER_THRESHOLD = 1950;
  const ROOM_ID_REGEX = /^\d+(\.\d+)+$/;

  // --- Shared State ---
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
  let onlineUsers = [];

  // Image upload state
  let pendingImageFile = null;
  let pendingImageBase64 = null;

  // Voice recording state
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let recordingStartTime = 0;
  let recordingTimerInterval = null;
  let micSlideStartX = 0;

  // --- Detect which page we're on ---
  const isRoomPage = window.location.pathname.startsWith('/room/');
  const isHomePage = !isRoomPage;

  // --- Particle Background ---
  function initParticles() {
    const canvas = document.getElementById('particle-canvas');
    if (!canvas) return;
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

  // ============================================
  // SHARED SOCKET EVENT HANDLERS
  // ============================================

  function setupSocketListeners() {
    socket.on('room-joined', (data) => {
      window.history.pushState({}, '', `/room/${data.roomId}`);
      currentRoom = data.roomId;
      myNickname = data.nickname;
      onlineUsers = data.users || [];
      showChatScreen(data);
      hideReconnectBanner();
    });

    socket.on('new-message', (msg) => {
      appendMessage(msg);
      scrollToBottom();

      if (!documentFocused && msg.nickname !== myNickname) {
        unreadCount++;
        document.title = `(${unreadCount}) ${originalTitle}`;
      }

      if (soundEnabled && msg.nickname !== myNickname) {
        playBeep();
      }
    });

    socket.on('new-image', (msg) => {
      appendImageMessage(msg);
      scrollToBottom();
      if (!documentFocused && msg.nickname !== myNickname) {
        unreadCount++;
        document.title = `(${unreadCount}) ${originalTitle}`;
      }
      if (soundEnabled && msg.nickname !== myNickname) playBeep();
    });

    socket.on('new-voice', (msg) => {
      appendVoiceMessage(msg);
      scrollToBottom();
      if (!documentFocused && msg.nickname !== myNickname) {
        unreadCount++;
        document.title = `(${unreadCount}) ${originalTitle}`;
      }
      if (soundEnabled && msg.nickname !== myNickname) playBeep();
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
      // Show on whichever error element exists
      const errorEl = document.getElementById('error-msg') || document.getElementById('nick-error');
      if (errorEl) errorEl.textContent = msg;
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
      if (currentRoom && myNickname) {
        socket.emit('join-room', { roomId: currentRoom, nickname: myNickname });
      }
    });
  }

  // ============================================
  // SHARED UI FUNCTIONS
  // ============================================

  function showReconnectBanner() {
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.classList.add('visible');
  }

  function hideReconnectBanner() {
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.classList.remove('visible');
  }

  function showChatScreen(data) {
    const chatScreen = document.getElementById('chat-screen');
    const messagesEl = document.getElementById('messages');
    const roomIdText = document.getElementById('room-id-text');
    const sidebarAvatar = document.getElementById('sidebar-user-avatar');
    const messageInput = document.getElementById('message-input');

    // For home page, hide home screen first
    if (isHomePage) {
      const homeScreen = document.getElementById('home-screen');
      if (homeScreen) homeScreen.classList.remove('active');
    }

    // For room page, hide nickname overlay
    if (isRoomPage) {
      const overlay = document.getElementById('nick-overlay');
      if (overlay) overlay.style.display = 'none';
    }

    setTimeout(() => {
      chatScreen.classList.add('active');
    }, 100);

    if (roomIdText) roomIdText.textContent = data.roomId;
    updateUserCount(data.userCount);

    // Set sidebar avatar initial
    const initial = data.nickname.charAt(0).toUpperCase();
    if (sidebarAvatar) {
      sidebarAvatar.textContent = initial;
      sidebarAvatar.title = data.nickname;
    }

    // Clear previous messages
    if (messagesEl) messagesEl.innerHTML = '';

    // Add welcome message
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'welcome-msg';
    welcomeDiv.innerHTML = `
      <div class="welcome-icon">🔐</div>
      <p>You're connected as <strong style="color: #fff">${escapeHtml(data.nickname)}</strong><br>
      Share room ID <strong style="color: rgba(255,255,255,0.7); font-weight: 600">${escapeHtml(data.roomId)}</strong> to invite others.</p>
    `;
    if (messagesEl) messagesEl.appendChild(welcomeDiv);

    // Load history
    if (data.messages && data.messages.length > 0) {
      data.messages.forEach(msg => {
        if (msg.type === 'image') {
          appendImageMessage(msg, false);
        } else if (msg.type === 'voice') {
          appendVoiceMessage(msg, false);
        } else {
          appendMessage(msg, false);
        }
      });
    }

    // Populate users panel
    if (data.users) {
      onlineUsers = data.users;
      renderUsersPanel();
    }

    scrollToBottom();
    if (messageInput) messageInput.focus();
  }

  function appendMessage(msg, animate = true) {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;

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
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.innerHTML = html;
    messagesEl.appendChild(div);
  }

  function scrollToBottom() {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function updateUserCount(count) {
    const userCount = document.getElementById('user-count');
    if (!userCount) return;
    const countText = userCount.querySelector('.count-text');
    if (countText) countText.textContent = `${count} online`;
  }

  // --- Reactions ---
  function createReactionBadge(emoji, count) {
    const badge = document.createElement('div');
    badge.className = 'reaction-badge';
    badge.textContent = `${emoji} ${count}`;
    return badge;
  }

  function applyReaction(messageId, emoji, count) {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;
    const bubble = messagesEl.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!bubble) return;

    bubble.style.position = 'relative';

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
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    if (!messageInput) return;

    // If there's a pending image, send it
    if (pendingImageBase64 && pendingImageFile && socket && currentRoom) {
      socket.emit('send-image', {
        imageData: pendingImageBase64,
        mimeType: pendingImageFile.type,
      });
      clearImagePreview();
    }

    const text = messageInput.value.trim();
    if (text && socket && currentRoom) {
      socket.emit('send-message', { message: text });
    }

    if (!text && !pendingImageBase64) return; // nothing to send at all

    messageInput.value = '';
    messageInput.style.height = 'auto';
    if (sendBtn) sendBtn.disabled = true;
    updateCharCounter();

    if (isTyping) {
      socket.emit('stop-typing');
      isTyping = false;
    }
  }

  // --- Character Counter ---
  function updateCharCounter() {
    const messageInput = document.getElementById('message-input');
    const charCounter = document.getElementById('char-counter');
    if (!messageInput || !charCounter) return;

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
    const typingInd = document.getElementById('typing-indicator');
    const typingText = document.getElementById('typing-text');
    if (!typingInd || !typingText) return;

    const now = Date.now();
    for (const [name, time] of typingUsers) {
      if (now - time > 3000) {
        typingUsers.delete(name);
      }
    }

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

  setInterval(updateTypingIndicator, 2000);

  // --- Users Panel ---
  function renderUsersPanel() {
    const usersPanelList = document.getElementById('users-panel-list');
    if (!usersPanelList) return;

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
    const usersPanel = document.getElementById('users-panel');
    if (!usersPanel) return;
    usersPanel.hidden = false;
    void usersPanel.offsetWidth;
    usersPanel.classList.add('open');
    if (socket) socket.emit('get-users');
  }

  function hideUsersPanel() {
    const usersPanel = document.getElementById('users-panel');
    if (!usersPanel) return;
    usersPanel.classList.remove('open');
    setTimeout(() => {
      usersPanel.hidden = true;
    }, 250);
  }

  // --- Sound ---
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

      osc.onended = () => ctx.close();
    } catch (_) {
      // Web Audio not available
    }
  }

  // --- Toast ---
  function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
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

  // --- Unread Badge (tab focus) ---
  window.addEventListener('focus', () => {
    documentFocused = true;
    unreadCount = 0;
    document.title = originalTitle;
  });

  window.addEventListener('blur', () => {
    documentFocused = false;
  });

  // ============================================
  // IMAGE UPLOAD FUNCTIONS
  // ============================================

  function appendImageMessage(msg, animate = true) {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;

    const isSelf = msg.nickname === myNickname;
    const div = document.createElement('div');
    div.className = `message-bubble${isSelf ? ' self' : ''}`;
    div.setAttribute('data-msg-id', msg.id);
    if (!animate) div.style.animation = 'none';

    const time = new Date(msg.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const headerDiv = document.createElement('div');
    headerDiv.className = 'msg-header';
    headerDiv.innerHTML = `
      <span class="msg-nickname">${escapeHtml(msg.nickname)}</span>
      <span class="msg-time">${timeStr}</span>
    `;
    div.appendChild(headerDiv);

    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = `data:${msg.mimeType};base64,${msg.imageData}`;
    img.alt = 'Shared image';
    img.addEventListener('click', () => openLightbox(img.src));
    div.appendChild(img);

    messagesEl.appendChild(div);
  }

  function clearImagePreview() {
    pendingImageFile = null;
    pendingImageBase64 = null;
    const previewArea = document.getElementById('image-preview-area');
    const previewThumb = document.getElementById('image-preview-thumb');
    const previewName = document.getElementById('image-preview-name');
    if (previewArea) previewArea.classList.remove('active');
    if (previewThumb) previewThumb.src = '';
    if (previewName) previewName.textContent = '';
    updateSendBtnState();
  }

  function handleImageSelect(file) {
    if (!file || !file.type.startsWith('image/')) return;

    // Check file size (2MB = 2 * 1024 * 1024)
    if (file.size > 2 * 1024 * 1024) {
      showToast('Image too large (max 2MB)');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64Full = e.target.result; // data:image/...;base64,XXXX
      const base64Data = base64Full.split(',')[1]; // just the base64 part

      pendingImageFile = file;
      pendingImageBase64 = base64Data;

      // Show preview
      const previewArea = document.getElementById('image-preview-area');
      const previewThumb = document.getElementById('image-preview-thumb');
      const previewName = document.getElementById('image-preview-name');
      if (previewArea) previewArea.classList.add('active');
      if (previewThumb) previewThumb.src = base64Full;
      if (previewName) previewName.textContent = file.name;
      updateSendBtnState();
    };
    reader.readAsDataURL(file);
  }

  function updateSendBtnState() {
    const sendBtn = document.getElementById('send-btn');
    const messageInput = document.getElementById('message-input');
    if (!sendBtn) return;
    const hasText = messageInput && messageInput.value.trim();
    sendBtn.disabled = !hasText && !pendingImageBase64;
  }

  // ============================================
  // LIGHTBOX
  // ============================================

  function openLightbox(src) {
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src;
    lightbox.classList.add('active');
  }

  function closeLightbox() {
    const lightbox = document.getElementById('lightbox');
    if (lightbox) lightbox.classList.remove('active');
  }

  // ============================================
  // VOICE RECORDING FUNCTIONS
  // ============================================

  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function appendVoiceMessage(msg, animate = true) {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl) return;

    const isSelf = msg.nickname === myNickname;
    const div = document.createElement('div');
    div.className = `message-bubble${isSelf ? ' self' : ''}`;
    div.setAttribute('data-msg-id', msg.id);
    if (!animate) div.style.animation = 'none';

    const time = new Date(msg.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const headerDiv = document.createElement('div');
    headerDiv.className = 'msg-header';
    headerDiv.innerHTML = `
      <span class="msg-nickname">${escapeHtml(msg.nickname)}</span>
      <span class="msg-time">${timeStr}</span>
    `;
    div.appendChild(headerDiv);

    // Voice player container
    const voiceBubble = document.createElement('div');
    voiceBubble.className = 'voice-bubble';

    // Play/Pause button
    const playBtn = document.createElement('button');
    playBtn.className = 'voice-play-btn';
    playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z"/></svg>`;

    // Track area
    const trackDiv = document.createElement('div');
    trackDiv.className = 'voice-track';

    const progressBar = document.createElement('div');
    progressBar.className = 'voice-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'voice-progress-fill';
    progressBar.appendChild(progressFill);

    const durationSpan = document.createElement('span');
    durationSpan.className = 'voice-duration';
    durationSpan.textContent = formatDuration(msg.duration);

    trackDiv.appendChild(progressBar);
    trackDiv.appendChild(durationSpan);

    voiceBubble.appendChild(playBtn);
    voiceBubble.appendChild(trackDiv);

    // Hidden audio element
    const audio = document.createElement('audio');
    audio.src = `data:audio/webm;base64,${msg.audioData}`;
    audio.preload = 'metadata';

    let playing = false;

    playBtn.addEventListener('click', () => {
      if (playing) {
        audio.pause();
        playing = false;
        playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z"/></svg>`;
      } else {
        audio.play().catch(() => {});
        playing = true;
        playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>`;
      }
    });

    audio.addEventListener('timeupdate', () => {
      if (audio.duration) {
        const pct = (audio.currentTime / audio.duration) * 100;
        progressFill.style.width = pct + '%';
        durationSpan.textContent = formatDuration(audio.currentTime);
      }
    });

    audio.addEventListener('ended', () => {
      playing = false;
      playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z"/></svg>`;
      progressFill.style.width = '0%';
      durationSpan.textContent = formatDuration(msg.duration);
    });

    // Seek on click
    progressBar.addEventListener('click', (e) => {
      if (!audio.duration) return;
      const rect = progressBar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = pct * audio.duration;
    });

    div.appendChild(voiceBubble);
    div.appendChild(audio);
    messagesEl.appendChild(div);
  }

  function startRecording() {
    if (isRecording) return;

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        isRecording = true;
        audioChunks = [];
        recordingStartTime = Date.now();

        const micBtn = document.getElementById('mic-btn');
        const recIndicator = document.getElementById('recording-indicator');
        const recTimer = document.getElementById('recording-timer');

        if (micBtn) micBtn.classList.add('recording');
        if (recIndicator) recIndicator.classList.add('active');

        // Start timer display
        if (recTimer) recTimer.textContent = '0:00';
        recordingTimerInterval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
          if (recTimer) recTimer.textContent = formatDuration(elapsed);
        }, 500);

        mediaRecorder = new MediaRecorder(stream, {
          mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
        });

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          // Stop all tracks
          stream.getTracks().forEach(t => t.stop());

          const micBtn2 = document.getElementById('mic-btn');
          const recIndicator2 = document.getElementById('recording-indicator');
          if (micBtn2) micBtn2.classList.remove('recording');
          if (recIndicator2) recIndicator2.classList.remove('active');
          clearInterval(recordingTimerInterval);

          // If recording was cancelled, don't send
          if (!isRecording) return;
          isRecording = false;

          const duration = (Date.now() - recordingStartTime) / 1000;
          if (duration < 0.5) return; // too short

          const blob = new Blob(audioChunks, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            if (socket && currentRoom) {
              socket.emit('send-voice', { audioData: base64, duration: Math.round(duration) });
            }
          };
          reader.readAsDataURL(blob);
        };

        mediaRecorder.start();
      })
      .catch(() => {
        showToast('Microphone access denied');
      });
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      isRecording = false;
      return;
    }
    // isRecording stays true so onstop sends the data
    mediaRecorder.stop();
  }

  function cancelRecording() {
    isRecording = false; // flag so onstop won't send
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    const micBtn = document.getElementById('mic-btn');
    const recIndicator = document.getElementById('recording-indicator');
    if (micBtn) micBtn.classList.remove('recording');
    if (recIndicator) recIndicator.classList.remove('active');
    clearInterval(recordingTimerInterval);
    showToast('Recording cancelled');
  }

  // ============================================
  // SHARED CHAT UI BINDING
  // (called once chat elements exist on screen)
  // ============================================
  function bindChatUI() {
    const sendBtn = document.getElementById('send-btn');
    const messageInput = document.getElementById('message-input');
    const backBtn = document.getElementById('back-btn');
    const copyBtn = document.getElementById('copy-room-btn');
    const usersSidebarBtn = document.getElementById('users-sidebar-btn');
    const usersPanelClose = document.getElementById('users-panel-close');
    const muteToggleBtn = document.getElementById('mute-toggle-btn');
    const muteIconOff = document.getElementById('mute-icon-off');
    const muteIconOn = document.getElementById('mute-icon-on');

    if (sendBtn) sendBtn.addEventListener('click', sendMessage);

    if (messageInput) {
      messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';

        updateSendBtnState();
        updateCharCounter();

        if (!isTyping && messageInput.value.trim()) {
          isTyping = true;
          if (socket) socket.emit('typing');
        }

        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
          if (isTyping) {
            isTyping = false;
            if (socket) socket.emit('stop-typing');
          }
        }, 2000);
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (isRoomPage) {
          // Navigate to /home
          window.location.href = '/home';
        } else {
          showHomeScreen();
        }
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        if (!currentRoom) return;
        navigator.clipboard.writeText(window.location.href).then(() => {
          showToast('Link copied!');
        }).catch(() => {
          showToast('Failed to copy');
        });
      });
    }

    if (usersSidebarBtn) {
      usersSidebarBtn.addEventListener('click', () => {
        const usersPanel = document.getElementById('users-panel');
        if (usersPanel && usersPanel.classList.contains('open')) {
          hideUsersPanel();
        } else {
          showUsersPanel();
        }
      });
    }

    if (usersPanelClose) {
      usersPanelClose.addEventListener('click', hideUsersPanel);
    }

    // Close users panel on outside click
    document.addEventListener('click', (e) => {
      const usersPanel = document.getElementById('users-panel');
      const usersSidebarBtn2 = document.getElementById('users-sidebar-btn');
      if (usersPanel && usersPanel.classList.contains('open') &&
          !usersPanel.contains(e.target) &&
          e.target !== usersSidebarBtn2 &&
          !(usersSidebarBtn2 && usersSidebarBtn2.contains(e.target))) {
        hideUsersPanel();
      }
    });

    if (muteToggleBtn) {
      muteToggleBtn.addEventListener('click', () => {
        soundEnabled = !soundEnabled;
        if (soundEnabled) {
          if (muteIconOff) muteIconOff.style.display = 'none';
          if (muteIconOn) muteIconOn.style.display = 'block';
          muteToggleBtn.classList.add('active');
        } else {
          if (muteIconOff) muteIconOff.style.display = 'block';
          if (muteIconOn) muteIconOn.style.display = 'none';
          muteToggleBtn.classList.remove('active');
        }
      });
    }

    // --- Image Upload Bindings ---
    const attachBtn = document.getElementById('attach-btn');
    const imageFileInput = document.getElementById('image-file-input');
    const imagePreviewCancel = document.getElementById('image-preview-cancel');

    if (attachBtn && imageFileInput) {
      attachBtn.addEventListener('click', () => {
        imageFileInput.click();
      });

      imageFileInput.addEventListener('change', () => {
        const file = imageFileInput.files[0];
        if (file) handleImageSelect(file);
        imageFileInput.value = ''; // reset so same file can be re-selected
      });
    }

    if (imagePreviewCancel) {
      imagePreviewCancel.addEventListener('click', clearImagePreview);
    }

    // --- Lightbox Bindings ---
    const lightbox = document.getElementById('lightbox');
    const lightboxClose = document.getElementById('lightbox-close');

    if (lightbox) {
      lightbox.addEventListener('click', (e) => {
        // Close if clicked on the background, not the image
        if (e.target === lightbox) closeLightbox();
      });
    }
    if (lightboxClose) {
      lightboxClose.addEventListener('click', closeLightbox);
    }

    // Escape key closes lightbox
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });

    // --- Voice Recording Bindings ---
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) {
      micBtn.addEventListener('click', () => {
        if (isRecording) {
          stopRecording();
        } else {
          startRecording();
        }
      });

      // Slide-to-cancel: track touch start, if user slides left > 80px, cancel
      micBtn.addEventListener('touchstart', (e) => {
        if (isRecording) {
          micSlideStartX = e.touches[0].clientX;
        }
      }, { passive: true });

      micBtn.addEventListener('touchmove', (e) => {
        if (isRecording && micSlideStartX > 0) {
          const dx = micSlideStartX - e.touches[0].clientX;
          if (dx > 80) {
            cancelRecording();
            micSlideStartX = 0;
          }
        }
      }, { passive: true });

      micBtn.addEventListener('touchend', () => {
        micSlideStartX = 0;
      }, { passive: true });

      // Mouse-based slide cancel for desktop
      micBtn.addEventListener('mousedown', (e) => {
        if (isRecording) {
          micSlideStartX = e.clientX;
          const onMouseMove = (me) => {
            const dx = micSlideStartX - me.clientX;
            if (dx > 80) {
              cancelRecording();
              micSlideStartX = 0;
              document.removeEventListener('mousemove', onMouseMove);
              document.removeEventListener('mouseup', onMouseUp);
            }
          };
          const onMouseUp = () => {
            micSlideStartX = 0;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
          };
          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        }
      });
    }
  }

  // ============================================
  // PAGE 1: HOME PAGE (/home — index.html)
  // ============================================
  function initHomePage() {
    const homeScreen  = document.getElementById('home-screen');
    const roomInput   = document.getElementById('room-id-input');
    const nickInput   = document.getElementById('nickname-input');
    const joinBtn     = document.getElementById('join-btn');
    const inputStatus = document.getElementById('input-status');
    const errorMsg    = document.getElementById('error-msg');

    if (!homeScreen || !roomInput || !joinBtn) return;

    function validateRoomId(value) {
      return ROOM_ID_REGEX.test(value.trim());
    }

    roomInput.addEventListener('input', () => {
      const val = roomInput.value.trim();
      if (errorMsg) errorMsg.textContent = '';

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

    function joinRoom() {
      const roomId = roomInput.value.trim();
      const nickname = nickInput ? nickInput.value.trim() : '';

      if (!validateRoomId(roomId)) {
        if (errorMsg) errorMsg.textContent = 'Invalid format. Use dot-separated numbers (e.g. 42.100.7.3)';
        return;
      }

      if (!socket) {
        socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000 });
        setupSocketListeners();
      }

      socket.emit('join-room', { roomId, nickname });
    }

    joinBtn.addEventListener('click', joinRoom);

    roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !joinBtn.disabled) joinRoom();
    });

    if (nickInput) {
      nickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !joinBtn.disabled) joinRoom();
      });
    }

    // Bind chat UI for when they join
    bindChatUI();
  }

  // Show home screen (used when backing out of chat on home page)
  function showHomeScreen() {
    const chatScreen = document.getElementById('chat-screen');
    const homeScreen = document.getElementById('home-screen');
    const roomInput = document.getElementById('room-id-input');
    const nickInput = document.getElementById('nickname-input');
    const inputStatus = document.getElementById('input-status');
    const joinBtn = document.getElementById('join-btn');
    const errorMsg = document.getElementById('error-msg');

    if (chatScreen) chatScreen.classList.remove('active');
    setTimeout(() => {
      if (homeScreen) homeScreen.classList.add('active');
    }, 100);

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    currentRoom = null;
    myNickname = null;
    typingUsers.clear();
    onlineUsers = [];
    if (roomInput) roomInput.value = '';
    if (nickInput) nickInput.value = '';
    if (inputStatus) {
      inputStatus.className = 'input-status';
      inputStatus.textContent = '';
    }
    if (joinBtn) joinBtn.disabled = true;
    if (errorMsg) errorMsg.textContent = '';
    unreadCount = 0;
    document.title = originalTitle;
    hideUsersPanel();
  }

  // ============================================
  // PAGE 2: ROOM PAGE (/room/:roomId — room.html)
  // ============================================
  function initRoomPage() {
    // Extract room ID from URL
    const pathParts = window.location.pathname.split('/room/');
    const roomId = pathParts[1] ? decodeURIComponent(pathParts[1]) : '';

    // Validate room ID format
    if (!ROOM_ID_REGEX.test(roomId)) {
      window.location.href = '/home';
      return;
    }

    // Update page title
    originalTitle = `IP-Chat · Room ${roomId}`;
    document.title = originalTitle;

    // Show room code in the modal
    const nickRoomCode = document.getElementById('nick-room-code');
    if (nickRoomCode) nickRoomCode.textContent = roomId;

    // Nickname modal elements
    const nickInput = document.getElementById('nick-input');
    const nickJoinBtn = document.getElementById('nick-join-btn');
    const nickError = document.getElementById('nick-error');

    function joinWithNickname() {
      const nickname = nickInput ? nickInput.value.trim() : '';

      // Connect socket
      if (!socket) {
        socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000 });
        setupSocketListeners();
      }

      socket.emit('join-room', { roomId, nickname });
    }

    if (nickJoinBtn) {
      nickJoinBtn.addEventListener('click', joinWithNickname);
    }

    if (nickInput) {
      nickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinWithNickname();
      });

      // Auto-focus nickname input
      setTimeout(() => nickInput.focus(), 300);
    }

    // Bind chat UI
    bindChatUI();
  }

  // ============================================
  // INIT — Route to correct page handler
  // ============================================
  if (isRoomPage) {
    initRoomPage();
  } else {
    initHomePage();
  }

})();
