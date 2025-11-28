// Lógica da página de sala (WebSocket, votos, estatísticas, modo apresentação)

function $(selector) {
  return document.querySelector(selector);
}

const cardsValues = ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '?', '☕'];

const storageKeys = {
  userInfo: 'planningpoke:user',
  sessionForRoom: (slug) => `planningpoke:session:${slug}`
};

let ws = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
let roomSlug = null;
let currentRoom = null;
let selfSessionId = null;
let lastStats = null;
let currentAccessCode = null;
let hasShownEnterToast = false;
let lastOwnerSessionId = null;
let currentSelfVote = null;

const elements = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  initRoomSlug();
  loadInitialUserInfo();
  setupEmojiPicker();
  setupUserForm();
  setupControls();
  setupCards();
  fetchRoomMetaAndConnect();
});

function cacheElements() {
  elements.roomName = $('#room-name');
  elements.roomSlug = $('#room-slug');
  elements.copyRoomLink = $('#copy-room-link');
  elements.copyRoomCode = $('#copy-room-code');
  elements.connectionStatus = $('#connection-status');
  elements.cardsContainer = $('#cards-container');
  elements.participantsList = $('#participants-list');
  elements.roomMain = document.querySelector('.room-main');
  elements.currentVoteLabel = $('#current-vote-label');
  elements.currentVoteValue = $('#current-vote-value');
  elements.allVotesHelperText = $('#all-votes-helper-text');
  elements.revealButton = $('#reveal-button');
  elements.resetButton = $('#reset-button');
  elements.statsSection = $('#stats-section');
  elements.statTotalVotes = $('#stat-total-votes');
  elements.statUniqueValues = $('#stat-unique-values');
  elements.statAverage = $('#stat-average');
  elements.reportSection = $('#report-section');
  elements.reportList = $('#report-list');
  elements.presentationToggle = $('#presentation-toggle');
  elements.profileToggle = $('#profile-toggle');
  elements.profileContent = $('#profile-content');
  elements.userForm = $('#user-form');
  elements.userName = $('#user-name');
  elements.userAvatar = $('#user-avatar');
  elements.accessCodeModal = $('#access-code-modal');
  elements.accessCodeForm = $('#access-code-form');
  elements.accessCodeInput = $('#access-code-input');
  elements.accessCodeError = $('#access-code-error');
  elements.toast = $('#toast');
}

function initRoomSlug() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  // esperado: /room/<slug>
  roomSlug = parts[1] || '';
  elements.roomSlug.textContent = roomSlug || 'desconhecida';
}

function loadInitialUserInfo() {
  try {
    const stored = localStorage.getItem(storageKeys.userInfo);
    if (stored) {
      const info = JSON.parse(stored);
      if (info.name) elements.userName.value = info.name;
      if (info.avatar) elements.userAvatar.value = info.avatar;
    } else {
      // avatar gerado automaticamente se não existir
      elements.userAvatar.value = getRandomEmoji();
    }
  } catch {
    elements.userAvatar.value = getRandomEmoji();
  }
}

function saveUserInfo() {
  const info = {
    name: elements.userName.value.trim() || 'Anônimo',
    avatar: elements.userAvatar.value.trim() || getRandomEmoji()
  };
  localStorage.setItem(storageKeys.userInfo, JSON.stringify(info));
  return info;
}

function setupUserForm() {
  if (!elements.userForm) return;

  elements.userForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const info = saveUserInfo();
    showToast('Dados atualizados.');

    // Reenvia join_room para atualizar nome/avatar no servidor
    if (ws && ws.readyState === WebSocket.OPEN && currentRoom) {
      sendJoinRoom();
    }
  });
}

function setupControls() {
  if (elements.profileToggle && elements.profileContent) {
    elements.profileToggle.addEventListener('click', () => {
      const isCollapsed = elements.profileContent.classList.toggle('collapsed');
      elements.profileToggle.dataset.collapsed = isCollapsed ? 'true' : 'false';
    });
  }

  if (elements.copyRoomLink) {
    elements.copyRoomLink.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        showToast('Link copiado para a área de transferência.');
      } catch {
        showToast('Não foi possível copiar o link.');
      }
    });
  }

  if (elements.copyRoomCode) {
    elements.copyRoomCode.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(roomSlug || elements.roomSlug.textContent || '');
        showToast('Código da sala copiado para a área de transferência.');
      } catch {
        showToast('Não foi possível copiar o código da sala.');
      }
    });
  }

  if (elements.revealButton) {
    elements.revealButton.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'reveal_votes', payload: {} }));
    });
  }

  if (elements.resetButton) {
    elements.resetButton.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'reset_votes', payload: {} }));
    });
  }

  if (elements.presentationToggle) {
    elements.presentationToggle.addEventListener('click', () => {
      togglePresentationMode();
    });
  }

  window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'leave_room', payload: {} }));
      } catch {
        // ignore
      }
    }
  });
}

function setupCards() {
  if (!elements.cardsContainer) return;
  elements.cardsContainer.innerHTML = '';

  cardsValues.forEach((value) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card-item';
    card.dataset.value = value;

    const label = document.createElement('span');
    label.className = 'card-label';
    label.textContent = 'Vote';

    const content = document.createElement('span');
    content.textContent = value;

    card.appendChild(label);
    card.appendChild(content);

    card.addEventListener('click', () => {
      handleCardClick(value);
    });

    elements.cardsContainer.appendChild(card);
  });
}

function handleCardClick(value) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const payload = { value };
  ws.send(JSON.stringify({ type: 'new_vote', payload }));

  // guarda voto atual localmente para exibir antes da revelação
  currentSelfVote = value;
  updateCurrentVoteLabel();

  // otimismo visual: marca carta selecionada localmente
  document
    .querySelectorAll('.card-item')
    .forEach((el) => el.classList.remove('selected'));

  const selected = document.querySelector(`.card-item[data-value="${CSS.escape(value)}"]`);
  if (selected) {
    selected.classList.add('selected');
  }
}

function fetchRoomMetaAndConnect() {
  setConnectionStatus('connecting', 'Verificando sala...');

  fetch(`/api/rooms/${encodeURIComponent(roomSlug)}`)
    .then((res) => {
      if (!res.ok) throw new Error('Sala não encontrada.');
      return res.json();
    })
    .then((data) => {
      if (data.name && elements.roomName) {
        elements.roomName.textContent = data.name;
      }

      if (elements.roomMain) {
        elements.roomMain.classList.remove('room-main-blurred');
      }

      if (data.private) {
        // pede código de acesso antes de conectar no WebSocket
        openAccessCodeModal();
      } else {
        connectWebSocket();
      }
    })
    .catch((err) => {
      console.error(err);
      setConnectionStatus('disconnected', 'Sala não encontrada.');
      showToast('Sala não encontrada. Verifique o link.');
      if (elements.roomMain) {
        elements.roomMain.classList.add('room-main-blurred');
      }
    });
}

function openAccessCodeModal() {
  if (!elements.accessCodeModal) return;
  elements.accessCodeModal.classList.remove('hidden');
  elements.accessCodeInput.focus();

  elements.accessCodeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    elements.accessCodeError.classList.add('hidden');
    const code = elements.accessCodeInput.value.trim();
    if (!code) {
      elements.accessCodeError.textContent = 'Informe o código de acesso.';
      elements.accessCodeError.classList.remove('hidden');
      return;
    }
    currentAccessCode = code;
    elements.accessCodeModal.classList.add('hidden');
    connectWebSocket();
  });
}

function connectWebSocket() {
  if (!roomSlug) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${protocol}://${window.location.host}/ws`;

  setConnectionStatus('connecting', 'Conectando...');

  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setConnectionStatus('connected', 'Conectado');
    showToast('Você entrou na sala.');
    reconnectAttempts = 0;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    sendJoinRoom();
  });

  ws.addEventListener('message', (event) => {
    handleWebSocketMessage(event.data);
  });

  ws.addEventListener('close', () => {
    setConnectionStatus('disconnected', 'Desconectado. Tentando reconectar...');
    showToast('Você saiu da sala.');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    setConnectionStatus('disconnected', 'Erro na conexão. Tentando reconectar...');
    scheduleReconnect();
  });
}

function sendJoinRoom() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const userInfo = saveUserInfo();

  // tenta reutilizar sessionId salvo previamente
  const storedSession = localStorage.getItem(storageKeys.sessionForRoom(roomSlug));
  let sessionId = null;
  if (storedSession) {
    try {
      const parsed = JSON.parse(storedSession);
      sessionId = parsed.sessionId || null;
    } catch {
      sessionId = null;
    }
  }

  const payload = {
    roomSlug,
    name: userInfo.name,
    avatar: userInfo.avatar,
    sessionId,
    accessCode: currentAccessCode
  };

  ws.send(
    JSON.stringify({
      type: 'join_room',
      payload
    })
  );
}

function scheduleReconnect() {
  if (reconnectTimeout) return;

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
  reconnectAttempts += 1;

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectWebSocket();
  }, delay);
}

function handleWebSocketMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (err) {
    console.error('Mensagem WS inválida', err);
    return;
  }

  const { type, payload } = msg;

  switch (type) {
    case 'sync_state':
      if (payload && payload.room) {
        const previousRoom = currentRoom;
        const previousOwnerId = previousRoom?.ownerSessionId || null;

        // Notificações de entrada/saída para outros participantes
        if (previousRoom) {
          notifyRoomUserChanges(previousRoom, payload.room, payload.selfSessionId);
        }

        currentRoom = payload.room;
        selfSessionId = payload.selfSessionId;
        if (selfSessionId) {
          localStorage.setItem(
            storageKeys.sessionForRoom(roomSlug),
            JSON.stringify({ sessionId: selfSessionId })
          );
        }

        const newOwnerId = currentRoom.ownerSessionId || null;
        if (previousOwnerId !== newOwnerId) {
          handleOwnerChangeToast(previousOwnerId, newOwnerId);
          lastOwnerSessionId = newOwnerId;
        }

        if (Object.prototype.hasOwnProperty.call(payload, 'selfVote')) {
          currentSelfVote = payload.selfVote;
        }

        updateCurrentVoteLabel();

        renderRoom();
      }
      break;
    case 'room_stats':
      if (payload && payload.stats) {
        lastStats = payload.stats;
        renderStats();
      }
      break;
    case 'error':
      if (payload) {
        handleServerError(payload);
      }
      break;
    default:
      console.warn('Evento WebSocket desconhecido:', type);
  }
}

function handleOwnerChangeToast(previousOwnerId, newOwnerId) {
  // Apenas nos importamos quando passa a existir um dono
  if (!newOwnerId) {
    return;
  }

  const users = currentRoom?.users || [];
  const newOwner = users.find(
    (u) => u && String(u.sessionId) === String(newOwnerId)
  );

  const isSelf = selfSessionId && String(selfSessionId) === String(newOwnerId);

  if (isSelf) {
    showToast('Você agora é o dono da sala.');
    return;
  }

  const name = newOwner?.name || 'Alguém';
  showToast(`${name} agora é o dono da sala.`);
}

function notifyRoomUserChanges(prevRoom, nextRoom, selfId) {
  const prevUsers = prevRoom.users || [];
  const nextUsers = nextRoom.users || [];

  const prevById = new Map(prevUsers.map((u) => [u.sessionId, u]));
  const nextById = new Map(nextUsers.map((u) => [u.sessionId, u]));

  // Entradas: usuários que não existiam antes
  nextUsers.forEach((user) => {
    if (!user || !user.sessionId) return;
    if (user.sessionId === selfId) return; // não notifica a própria entrada aqui
    if (!prevById.has(user.sessionId)) {
      const name = user.name || 'Anônimo';
      showToast(`${name} entrou na sala.`);
    }
  });

  // Saídas: usuários que existiam antes e não existem mais
  prevUsers.forEach((user) => {
    if (!user || !user.sessionId) return;
    if (user.sessionId === selfId) return; // não notifica a própria saída aqui
    if (!nextById.has(user.sessionId)) {
      const name = user.name || 'Anônimo';
      showToast(`${name} saiu da sala.`);
    }
  });
}

function handleServerError(err) {
  const { code, message } = err;
  showToast(message || 'Erro no servidor.');

  if (code === 'invalid_access_code') {
    // volta a pedir o código
    currentAccessCode = null;
    if (elements.accessCodeModal && elements.accessCodeInput) {
      elements.accessCodeModal.classList.remove('hidden');
      elements.accessCodeError.textContent = 'Código inválido. Tente novamente.';
      elements.accessCodeError.classList.remove('hidden');
      elements.accessCodeInput.value = '';
      elements.accessCodeInput.focus();
    }
  }
}

function renderRoom() {
  if (!currentRoom) return;

  const isOwner =
    currentRoom.ownerSessionId &&
    selfSessionId &&
    String(currentRoom.ownerSessionId) === String(selfSessionId);

  // Atualiza título
  if (currentRoom.name && elements.roomName) {
    elements.roomName.textContent = currentRoom.name;
  }

  // Controle de botões de dono (revelar / reset)
  if (elements.revealButton) {
    elements.revealButton.disabled = !isOwner;
  }
  if (elements.resetButton) {
    elements.resetButton.disabled = !isOwner;
  }

  // Participantes
  renderParticipants();

  // Atualiza visual das cartas (selecionada + revelada)
  renderCardsState();

  // Estatísticas (apenas após revelação, conforme regra)
  if (currentRoom.revealed) {
    renderStats();
    elements.statsSection.classList.remove('hidden');
    renderReport();
    if (elements.reportSection) {
      elements.reportSection.classList.remove('hidden');
    }
  } else {
    elements.statsSection.classList.add('hidden');
    if (elements.reportSection) {
      elements.reportSection.classList.add('hidden');
    }
    if (elements.reportList) {
      elements.reportList.innerHTML = '';
    }
  }
}

function renderParticipants() {
  if (!elements.participantsList) return;

  const users = currentRoom.users || [];
  const ownerId = currentRoom.ownerSessionId || null;

  elements.participantsList.innerHTML = '';

  let totalVoters = 0;
  let totalUsers = 0;

  users.forEach((user) => {
    if (!user) return;
    totalUsers += 1;

    const li = document.createElement('li');
    li.className = 'participant';
    if (user.sessionId === selfSessionId) {
      li.classList.add('you');
    }

    const avatar = document.createElement('div');
    avatar.className = 'participant-avatar';
    avatar.textContent = user.avatar || '🙂';

    const info = document.createElement('div');
    info.className = 'participant-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'participant-name';
    nameEl.textContent = user.name || 'Anônimo';

    if (ownerId && String(ownerId) === String(user.sessionId)) {
      const ownerBadge = document.createElement('span');
      ownerBadge.className = 'participant-owner-badge';
      ownerBadge.textContent = '👑 Admin';
      nameEl.appendChild(ownerBadge);
    }

    const meta = document.createElement('div');
    meta.className = 'participant-meta';

    const statusSpan = document.createElement('span');
    statusSpan.textContent = user.connected ? 'online' : 'offline';

    const votedSpan = document.createElement('span');
    const hasVoted = Boolean(user.hasVoted);
    if (hasVoted) {
      totalVoters += 1;
    }
    votedSpan.textContent = hasVoted ? 'votou' : 'aguardando voto';

    meta.appendChild(statusSpan);
    meta.appendChild(votedSpan);

    info.appendChild(nameEl);
    info.appendChild(meta);

    const statusDot = document.createElement('div');
    statusDot.className = 'participant-status-dot';
    statusDot.dataset.status = user.connected ? 'online' : 'offline';

    li.appendChild(avatar);
    li.appendChild(info);
    li.appendChild(statusDot);

    elements.participantsList.appendChild(li);
  });

  if (elements.allVotesHelperText) {
    if (totalUsers > 0 && totalVoters === totalUsers) {
      elements.allVotesHelperText.textContent = 'Todos os participantes já votaram.';
      elements.allVotesHelperText.classList.add('participants-all-voted');
    } else {
      elements.allVotesHelperText.textContent = '';
      elements.allVotesHelperText.classList.remove('participants-all-voted');
    }
  }
}

function renderCardsState() {
  if (!currentRoom || !elements.cardsContainer) return;

  const votes = currentRoom.votes || {};
  const revealed = Boolean(currentRoom.revealed);
  const myVote = revealed
    ? votes[selfSessionId]
    : currentSelfVote;

  document.querySelectorAll('.card-item').forEach((card) => {
    const value = card.dataset.value;
    card.classList.remove('selected', 'revealed');

    if (myVote && String(myVote) === String(value)) {
      card.classList.add('selected');
    }
    if (revealed) {
      card.classList.add('revealed');
    }
  });
}

function updateCurrentVoteLabel() {
  if (!elements.currentVoteLabel || !elements.currentVoteValue) return;

  if (currentSelfVote === null || typeof currentSelfVote === 'undefined') {
    elements.currentVoteLabel.classList.add('hidden');
    elements.currentVoteValue.textContent = '-';
    return;
  }

  elements.currentVoteLabel.classList.remove('hidden');
  elements.currentVoteValue.textContent = String(currentSelfVote);
}

function renderStats() {
  const stats = lastStats || currentRoom?.stats;
  if (!stats || !elements.statTotalVotes) return;

  elements.statTotalVotes.textContent = stats.totalVotes ?? 0;
  elements.statUniqueValues.textContent = stats.uniqueValues ?? 0;
  if (elements.statAverage) {
    const avg = typeof stats.average === 'number' ? stats.average : null;
    elements.statAverage.textContent =
      avg !== null && !Number.isNaN(avg) ? avg.toFixed(1) : '-';
  }
}

function renderReport() {
  if (!elements.reportList || !currentRoom) return;

  const users = currentRoom.users || [];
  const votes = currentRoom.votes || {};

  elements.reportList.innerHTML = '';

  users.forEach((user) => {
    if (!user) return;
    const item = document.createElement('div');
    item.className = 'report-item';

    const userSpan = document.createElement('span');
    userSpan.className = 'report-user';
    userSpan.textContent = user.name || 'Anônimo';

    const voteSpan = document.createElement('span');
    voteSpan.className = 'report-vote';
    const v = votes[user.sessionId];
    voteSpan.textContent =
      v !== null && typeof v !== 'undefined' ? String(v) : '-';

    item.appendChild(userSpan);
    item.appendChild(voteSpan);
    elements.reportList.appendChild(item);
  });
}

function setConnectionStatus(status, text) {
  if (!elements.connectionStatus) return;
  elements.connectionStatus.dataset.status = status;
  elements.connectionStatus.textContent = text;
}

let toastTimeout = null;
function showToast(message) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 3000);
}

function togglePresentationMode() {
  const body = document.body;
  const isOn = body.classList.toggle('presentation');
  elements.presentationToggle.textContent = isOn
    ? 'Sair do modo apresentação'
    : 'Modo apresentação';

  // tenta entrar/ sair de fullscreen
  if (isOn) {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {
        // ignore erro de fullscreen
      });
    }
  } else if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {
      // ignore
    });
  }
}

function getRandomEmoji() {
  const emojis = [
    '😎',
    '🤓',
    '🚀',
    '🧠',
    '🔥',
    '🦊',
    '🐼',
    '🦄',
    '🐱',
    '🐧',
    '😀',
    '😁',
    '😅',
    '😇',
    '😍',
    '🤠',
    '🤖',
    '👾',
    '🐶',
    '🐯',
    '🐸',
    '🐵',
    '🐢',
    '🐙'
  ];
  return emojis[Math.floor(Math.random() * emojis.length)];
}

function setupEmojiPicker() {
  const options = document.querySelectorAll('.emoji-option');
  if (!options.length || !elements.userAvatar) return;

  const applySelection = (emoji) => {
    if (!emoji) return;
    elements.userAvatar.value = emoji;
    options.forEach((btn) => {
      const btnEmoji = btn.dataset.emoji || btn.textContent.trim();
      btn.classList.toggle('selected', btnEmoji === emoji);
    });
  };

  // Estado inicial baseado no valor atual do input (carregado do storage ou random)
  const initialEmoji = (elements.userAvatar.value || '').trim() || getRandomEmoji();
  applySelection(initialEmoji);

  options.forEach((btn) => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji || btn.textContent.trim();
      applySelection(emoji);
      saveUserInfo();
      showToast('Avatar atualizado.');
    });
  });
}


