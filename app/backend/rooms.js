const fs = require('fs');
const path = require('path');

const ROOMS_DIR = path.join(__dirname, 'data', 'rooms');

// Garante que o diretório de salas existe
function ensureRoomsDir() {
  if (!fs.existsSync(ROOMS_DIR)) {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
  }
}

function getRoomFilePath(slug) {
  ensureRoomsDir();
  return path.join(ROOMS_DIR, `${slug}.json`);
}

// Gera um slug simples baseado no nome + sufixo aleatório
function generateSlug(name) {
  const base = name
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sala';
  const rand = Math.random().toString(36).substring(2, 6);
  return `${base}-${rand}`;
}

function computeStats(room) {
  const votes = Object.values(room.votes || {}).filter(
    (v) => v !== null && v !== undefined
  );

  const stats = {
    totalVotes: votes.length,
    uniqueValues: 0,
    mostFrequent: null,
    average: null
  };

  if (votes.length === 0) {
    return stats;
  }

  const freq = {};
  let maxCount = 0;
  let mode = null;

  for (const v of votes) {
    freq[v] = (freq[v] || 0) + 1;
    if (freq[v] > maxCount) {
      maxCount = freq[v];
      mode = v;
    }
  }

  stats.uniqueValues = Object.keys(freq).length;
  stats.mostFrequent = mode;

   // Média apenas dos votos numéricos
   const numericVotes = votes
     .map((v) => Number(v))
     .filter((n) => !Number.isNaN(n));

   if (numericVotes.length > 0) {
     const sum = numericVotes.reduce((acc, n) => acc + n, 0);
     stats.average = sum / numericVotes.length;
   }

  return stats;
}

function loadRoom(slug) {
  try {
    const filePath = getRoomFilePath(slug);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    // Garante campos padrão
    return {
      name: data.name || 'Sala',
      private: Boolean(data.private),
      accessCode: data.accessCode || null,
      users: Array.isArray(data.users) ? data.users : [],
      votes: data.votes || {},
      stats: data.stats || {
        totalVotes: 0,
        uniqueValues: 0,
        mostFrequent: null,
        average: null
      },
      revealed: Boolean(data.revealed),
      ownerSessionId: data.ownerSessionId || null,
      emptiedAt: data.emptiedAt || null,
      ownerLeftAt: data.ownerLeftAt || null
    };
  } catch (err) {
    console.error('Erro ao carregar sala', slug, err);
    return null;
  }
}

function saveRoom(slug, room) {
  try {
    ensureRoomsDir();
    const filePath = getRoomFilePath(slug);
    const toSave = {
      name: room.name,
      private: Boolean(room.private),
      accessCode: room.accessCode || null,
      users: room.users || [],
      votes: room.votes || {},
      stats: room.stats || {
        totalVotes: 0,
        uniqueValues: 0,
        mostFrequent: null
      },
      revealed: Boolean(room.revealed),
      ownerSessionId: room.ownerSessionId || null,
      emptiedAt: room.emptiedAt || null,
      ownerLeftAt: room.ownerLeftAt || null
    };
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('Erro ao salvar sala', slug, err);
  }
}

function createRoom({ name, isPrivate, accessCode }) {
  const slug = generateSlug(name || 'Sala');
  const room = {
    name: name || 'Sala',
    private: Boolean(isPrivate),
    accessCode: isPrivate ? String(accessCode || '').trim() || null : null,
    users: [],
    votes: {},
    stats: {
      totalVotes: 0,
      uniqueValues: 0,
      mostFrequent: null,
      average: null
    },
    revealed: false,
    ownerSessionId: null,
    emptiedAt: null,
    ownerLeftAt: null
  };
  saveRoom(slug, room);
  return { slug, room };
}

function upsertUser(room, { sessionId, name, avatar }) {
  const users = room.users || [];
  const idx = users.findIndex((u) => u.sessionId === sessionId);

  const cleanName = (name || '').toString().trim() || 'Anônimo';
  const cleanAvatar = (avatar || '').toString().trim() || null;

  if (idx === -1) {
    users.push({
      sessionId,
      name: cleanName,
      avatar: cleanAvatar,
      connected: true
    });
  } else {
    users[idx] = {
      ...users[idx],
      name: cleanName,
      avatar: cleanAvatar || users[idx].avatar || null,
      connected: true
    };
  }

  room.users = users;

  // Sala deixou de ficar vazia: limpa o marcador de esvaziamento
  if (room.users && room.users.length > 0) {
    room.emptiedAt = null;
  }

  // Se o usuário que voltou é o dono atual, limpa o timestamp de saída
  if (
    room.ownerSessionId &&
    String(room.ownerSessionId) === String(sessionId)
  ) {
    room.ownerLeftAt = null;
  }

  return room;
}

function markUserDisconnected(room, sessionId) {
  room.users = (room.users || []).map((u) =>
    u.sessionId === sessionId ? { ...u, connected: false } : u
  );
  return room;
}

function removeUser(room, sessionId) {
  const wasOwner =
    room.ownerSessionId && String(room.ownerSessionId) === String(sessionId);

  room.users = (room.users || []).filter((u) => u.sessionId !== sessionId);
  if (room.votes && Object.prototype.hasOwnProperty.call(room.votes, sessionId)) {
    delete room.votes[sessionId];
  }

  if (wasOwner) {
    // Se ainda há participantes, marca quando o dono saiu (para possível
    // transferência após o tempo configurado). Se não há mais participantes,
    // a sala fica sem dono.
    if (room.users && room.users.length > 0) {
      room.ownerLeftAt = new Date().toISOString();
    } else {
      room.ownerSessionId = null;
      room.ownerLeftAt = null;
    }
  }

  // Se a sala ficou sem participantes, registra quando foi esvaziada
  if (!room.users || room.users.length === 0) {
    room.emptiedAt = new Date().toISOString();
  }

  return room;
}

function deleteRoom(slug) {
  try {
    const filePath = getRoomFilePath(slug);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error('Erro ao deletar sala', slug, err);
  }
}

function setVote(room, sessionId, value) {
  room.votes = room.votes || {};
  room.votes[sessionId] = value;
  room.stats = computeStats(room);
  return room;
}

function resetVotes(room) {
  room.votes = {};
  room.revealed = false;
  room.stats = {
    totalVotes: 0,
    uniqueValues: 0,
    mostFrequent: null,
    average: null
  };
  return room;
}

function revealVotes(room) {
  room.revealed = true;
  room.stats = computeStats(room);
  return room;
}

function buildPublicState(room, slug) {
  const users = (room.users || []).map((u) => ({
    sessionId: u.sessionId,
    name: u.name,
    avatar: u.avatar,
    connected: Boolean(u.connected),
    hasVoted: Boolean(room.votes && room.votes[u.sessionId])
  }));

  return {
    slug,
    name: room.name,
    private: Boolean(room.private),
    revealed: Boolean(room.revealed),
    ownerSessionId: room.ownerSessionId || null,
    users,
    votes: room.revealed ? room.votes || {} : {}, // votos só aparecem depois da revelação
    stats: room.stats || {
      totalVotes: 0,
      uniqueValues: 0,
      mostFrequent: null,
      average: null
    }
  };
}

module.exports = {
  ROOMS_DIR,
  loadRoom,
  saveRoom,
  createRoom,
  upsertUser,
  removeUser,
  markUserDisconnected,
  setVote,
  resetVotes,
  revealVotes,
  buildPublicState,
  computeStats,
  deleteRoom
};


