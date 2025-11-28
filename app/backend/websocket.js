const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const {
  loadRoom,
  saveRoom,
  upsertUser,
  removeUser,
  setVote,
  resetVotes,
  revealVotes,
  buildPublicState,
  computeStats
} = require('./rooms');

// Tempo máximo que o dono pode ficar fora da sala antes de perder a posse (30s)
const OWNER_ABSENCE_TTL_MS = 30 * 1000;

/**
 * Inicializa o servidor WebSocket sobre o mesmo servidor HTTP do Express.
 *
 * Eventos suportados (cliente -> servidor):
 * - join_room { roomSlug, name, avatar?, sessionId?, accessCode? }
 * - leave_room {}
 * - new_vote { value }
 * - reveal_votes {}
 * - reset_votes {}
 *
 * Eventos enviados (servidor -> cliente):
 * - sync_state { room, selfSessionId }
 * - room_stats { stats }
 * - error { code, message }
 */
function initWebSocketServer(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  // Map de conexão -> { roomSlug, sessionId }
  const connectionInfo = new Map();
  // Map de sala -> Set de conexões
  const roomConnections = new Map();

  function refreshOwnerForRoom(room) {
    if (!room) return room;

    const users = room.users || [];
    const hasUsers = users.length > 0;

    // Sala sem participantes: não há dono nem timestamp relevante
    if (!hasUsers) {
      room.ownerSessionId = null;
      room.ownerLeftAt = null;
      return room;
    }

    // Sem dono atual: nada a fazer aqui (primeiro participante definirá)
    if (!room.ownerSessionId) {
      room.ownerLeftAt = null;
      return room;
    }

    // Verifica se o dono atual ainda está na lista de usuários
    const currentOwner = users.find(
      (u) => String(u.sessionId) === String(room.ownerSessionId)
    );

    if (currentOwner) {
      // Dono presente na sala => não há ausência a considerar
      room.ownerLeftAt = null;
      return room;
    }

    // Dono não está na sala: respeita o TTL antes de transferir a posse
    if (!room.ownerLeftAt) {
      room.ownerLeftAt = new Date().toISOString();
      return room;
    }

    const leftAt = Date.parse(room.ownerLeftAt);
    if (Number.isNaN(leftAt)) {
      room.ownerLeftAt = new Date().toISOString();
      return room;
    }

    const now = Date.now();
    if (now - leftAt >= OWNER_ABSENCE_TTL_MS) {
      const nextOwner = users[0];
      if (nextOwner) {
        room.ownerSessionId = nextOwner.sessionId;
        room.ownerLeftAt = null;
      } else {
        room.ownerSessionId = null;
        room.ownerLeftAt = null;
      }
    }

    return room;
  }

  function addConnectionToRoom(ws, roomSlug) {
    if (!roomConnections.has(roomSlug)) {
      roomConnections.set(roomSlug, new Set());
    }
    roomConnections.get(roomSlug).add(ws);
  }

  function removeConnection(ws) {
    const info = connectionInfo.get(ws);
    if (!info) return;
    const { roomSlug, sessionId } = info;
    const conns = roomConnections.get(roomSlug);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) {
        roomConnections.delete(roomSlug);
      }
    }

    const room = loadRoom(roomSlug);
    if (room) {
      // Marca usuário desconectado removendo-o da sala
      let updated = removeUser(room, sessionId);
      updated = refreshOwnerForRoom(updated);
      saveRoom(roomSlug, updated);
      broadcastRoomState(roomSlug);
    }
    connectionInfo.delete(ws);
  }

  function broadcast(roomSlug, message) {
    const conns = roomConnections.get(roomSlug);
    if (!conns) return;

    const payload = JSON.stringify(message);
    for (const client of conns) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function broadcastRoomState(roomSlug) {
    const room = loadRoom(roomSlug);
    if (!room) return;

    const conns = roomConnections.get(roomSlug);
    if (!conns) return;

    for (const client of conns) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const info = connectionInfo.get(client);
      if (!info) continue;

      const publicState = buildPublicState(room, roomSlug);
      const selfVote =
        room.votes && Object.prototype.hasOwnProperty.call(room.votes, info.sessionId)
          ? room.votes[info.sessionId]
          : null;

      client.send(
        JSON.stringify({
          type: 'sync_state',
          payload: {
            room: publicState,
            selfSessionId: info.sessionId,
            selfVote
          }
        })
      );
    }

    // Também envia estatísticas ao vivo
    const stats = computeStats(room);
    broadcast(roomSlug, {
      type: 'room_stats',
      payload: { stats }
    });
  }

  function sendError(ws, code, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'error',
        payload: { code, message }
      })
    );
  }

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.error('Mensagem inválida recebida via WS', err);
        sendError(ws, 'invalid_message', 'Mensagem inválida.');
        return;
      }

      const { type, payload } = msg || {};

      switch (type) {
        case 'join_room':
          handleJoinRoom(ws, payload);
          break;
        case 'leave_room':
          handleLeaveRoom(ws);
          break;
        case 'new_vote':
          handleNewVote(ws, payload);
          break;
        case 'reveal_votes':
          handleRevealVotes(ws);
          break;
        case 'reset_votes':
          handleResetVotes(ws);
          break;
        default:
          sendError(ws, 'unknown_event', 'Evento WebSocket desconhecido.');
      }
    });

    ws.on('close', () => {
      handleLeaveRoom(ws);
    });

    ws.on('error', (err) => {
      console.error('Erro na conexão WebSocket', err);
      handleLeaveRoom(ws);
    });
  });

  function handleJoinRoom(ws, payload = {}) {
    const { roomSlug, name, avatar, sessionId, accessCode } = payload;
    if (!roomSlug) {
      sendError(ws, 'missing_room', 'Sala não informada.');
      return;
    }

    let room = loadRoom(roomSlug);
    if (!room) {
      sendError(ws, 'room_not_found', 'Sala não encontrada.');
      return;
    }

    // Validação de sala privada
    if (room.private && room.accessCode) {
      const provided = (accessCode || '').toString().trim();
      if (!provided || provided !== room.accessCode) {
        sendError(ws, 'invalid_access_code', 'Código de acesso inválido para esta sala.');
        return;
      }
    }

    room = refreshOwnerForRoom(room);

    const finalSessionId = sessionId || randomUUID();

    room = upsertUser(room, {
      sessionId: finalSessionId,
      name,
      avatar
    });

    // Se a sala ativa não possui dono após o refresh, o participante que entrou vira o dono
    if (!room.ownerSessionId) {
      room.ownerSessionId = finalSessionId;
      room.ownerLeftAt = null;
    }
    saveRoom(roomSlug, room);

    connectionInfo.set(ws, { roomSlug, sessionId: finalSessionId });
    addConnectionToRoom(ws, roomSlug);

    // Envia estado sincronizado para todos na sala
    broadcastRoomState(roomSlug);
  }

  function handleLeaveRoom(ws) {
    const info = connectionInfo.get(ws);
    if (!info) return;
    const { roomSlug, sessionId } = info;

    const room = loadRoom(roomSlug);
    if (room) {
      let updated = removeUser(room, sessionId);
      updated = refreshOwnerForRoom(updated);
      saveRoom(roomSlug, updated);
      broadcastRoomState(roomSlug);
    }

    removeConnection(ws);
  }

  function handleNewVote(ws, payload = {}) {
    const info = connectionInfo.get(ws);
    if (!info) {
      sendError(ws, 'not_in_room', 'Você não está em nenhuma sala.');
      return;
    }
    const { roomSlug, sessionId } = info;
    const { value } = payload;

    if (typeof value === 'undefined' || value === null) {
      sendError(ws, 'invalid_vote', 'Voto inválido.');
      return;
    }

    const room = loadRoom(roomSlug);
    if (!room) {
      sendError(ws, 'room_not_found', 'Sala não encontrada.');
      return;
    }

    setVote(room, sessionId, value);
    saveRoom(roomSlug, room);

    // Atualiza estado para todos (sem revelar os valores individuais se ainda não estiver revelado)
    broadcastRoomState(roomSlug);
  }

  function handleRevealVotes(ws) {
    const info = connectionInfo.get(ws);
    if (!info) {
      sendError(ws, 'not_in_room', 'Você não está em nenhuma sala.');
      return;
    }
    const { roomSlug, sessionId } = info;
    let room = loadRoom(roomSlug);
    if (!room) {
      sendError(ws, 'room_not_found', 'Sala não encontrada.');
      return;
    }

    room = refreshOwnerForRoom(room);

    if (room.ownerSessionId && String(room.ownerSessionId) !== String(sessionId)) {
      sendError(ws, 'not_owner', 'Apenas o dono da sala pode revelar os votos.');
      return;
    }

    revealVotes(room);
    saveRoom(roomSlug, room);

    broadcastRoomState(roomSlug);
  }

  function handleResetVotes(ws) {
    const info = connectionInfo.get(ws);
    if (!info) {
      sendError(ws, 'not_in_room', 'Você não está em nenhuma sala.');
      return;
    }
    const { roomSlug, sessionId } = info;
    let room = loadRoom(roomSlug);
    if (!room) {
      sendError(ws, 'room_not_found', 'Sala não encontrada.');
      return;
    }

    room = refreshOwnerForRoom(room);

    if (room.ownerSessionId && String(room.ownerSessionId) !== String(sessionId)) {
      sendError(ws, 'not_owner', 'Apenas o dono da sala pode resetar os votos.');
      return;
    }

    resetVotes(room);
    saveRoom(roomSlug, room);

    broadcastRoomState(roomSlug);
  }

  console.log('Servidor WebSocket inicializado em /ws');
}

module.exports = {
  initWebSocketServer
};


