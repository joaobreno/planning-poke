const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { ROOMS_DIR, createRoom, loadRoom, saveRoom, deleteRoom } = require('./rooms');
const { initWebSocketServer } = require('./websocket');

const PORT = process.env.PORT || 3000;

// Tempo máximo que uma sala pode ficar vazia antes de ser removida (5 minutos)
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;

// Garante que o diretório de dados existe (útil no primeiro start / Docker)
if (!fs.existsSync(ROOMS_DIR)) {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
}

const app = express();
app.use(express.json());

// API REST simples para gerenciamento de salas

/**
 * Cria uma nova sala.
 * body: { name: string, private?: boolean, accessCode?: string }
 */
app.post('/api/rooms', (req, res) => {
  try {
    const { name, private: isPrivate, accessCode } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res
        .status(400)
        .json({ error: 'O campo "name" da sala é obrigatório.' });
    }

    const { slug, room } = createRoom({
      name,
      isPrivate: Boolean(isPrivate),
      accessCode
    });

    return res.status(201).json({
      slug,
      name: room.name,
      private: room.private
    });
  } catch (err) {
    console.error('Erro ao criar sala', err);
    return res.status(500).json({ error: 'Erro interno ao criar sala.' });
  }
});

/**
 * Obtém metadados simples de uma sala.
 */
app.get('/api/rooms/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    const room = loadRoom(slug);
    if (!room) {
      return res.status(404).json({ error: 'Sala não encontrada.' });
    }
    return res.json({
      slug,
      name: room.name,
      private: room.private
    });
  } catch (err) {
    console.error('Erro ao buscar sala', err);
    return res.status(500).json({ error: 'Erro interno ao buscar sala.' });
  }
});

// Servir arquivos estáticos do frontend
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// Rota dedicada para sala com slug, servindo room.html
app.get('/room/:slug', (req, res) => {
  res.sendFile(path.join(frontendPath, 'room.html'));
});

// Fallback: homepage
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

const server = http.createServer(app);

// Inicializa WebSocket
initWebSocketServer(server);

function cleanupEmptyRooms() {
  try {
    const files = fs.readdirSync(ROOMS_DIR);
    const now = Date.now();

    files
      .filter((f) => f.endsWith('.json'))
      .forEach((file) => {
        const slug = path.basename(file, '.json');
        const room = loadRoom(slug);
        if (!room) return;

        const users = room.users || [];

        // Sala com participantes: garante que não haja marcação de esvaziada
        if (users.length > 0) {
          if (room.emptiedAt) {
            room.emptiedAt = null;
            saveRoom(slug, room);
          }
          return;
        }

        // Sala vazia e ainda sem timestamp: marca agora e aguarda próximo ciclo
        if (!room.emptiedAt) {
          room.emptiedAt = new Date().toISOString();
          saveRoom(slug, room);
          return;
        }

        const emptiedAtTime = Date.parse(room.emptiedAt);
        if (Number.isNaN(emptiedAtTime)) {
          // Se o valor estiver inválido, regrava com o horário atual e não apaga ainda
          room.emptiedAt = new Date().toISOString();
          saveRoom(slug, room);
          return;
        }

        if (now - emptiedAtTime >= EMPTY_ROOM_TTL_MS) {
          deleteRoom(slug);
          console.log(
            `Sala ${slug} removida por inatividade (sem participantes por mais de 5 minutos).`
          );
        }
      });
  } catch (err) {
    console.error('Erro ao limpar salas vazias', err);
  }
}

// Roda a limpeza de salas vazias periodicamente (a cada 1 minuto)
setInterval(cleanupEmptyRooms, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
});

