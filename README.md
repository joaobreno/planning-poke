## Planning Poke

Aplicação completa de **Planning Poker** em tempo real, construída com:

- **Backend**: Node.js, Express, WebSocket (`ws`), persistência em arquivos JSON.
- **Frontend**: HTML5, CSS3 (glassmorphism), JavaScript vanilla.
- **Deploy**: Docker + docker-compose.

---

### ✨ Funcionalidades principais

- **Salas dinâmicas** com URL dedicada: `/room/&lt;slug&gt;`.
- **Usuários com sessão** (`sessionId` armazenado no navegador).
- **Atualização em tempo real** via WebSocket:
  - `join_room`, `leave_room`, `new_vote`, `reveal_votes`, `reset_votes`, `room_stats`, `sync_state`, `error`.
- **Salas privadas** com código de acesso.
- **Planning Poker clássico**:
  - Cartas: `0, 1, 2, 3, 5, 8, 13, 21, 34, 55, ?, coffee (☕)`.
  - Votos anônimos até a revelação.
  - Botão de **Revelar votos**.
  - Botão de **Reset**.
- **Estatísticas ao vivo** após revelar:
  - Total de votos.
  - Quantidade de valores únicos.
  - Valor mais frequente.
- **Modo apresentação**:
  - Layout focado nas cartas e estatísticas.
  - Tenta entrar em tela cheia (fullscreen).

---

### 📁 Estrutura de pastas

```text
/app
  /backend
    server.js        # Servidor Express + HTTP + rotas REST
    rooms.js         # Lógica e persistência das salas (JSON)
    websocket.js     # Servidor WebSocket e eventos em tempo real
    /data
      /rooms         # Arquivos JSON de cada sala (um por sala)

  /frontend
    index.html       # Página inicial (criar/entrar em sala)
    room.html        # Tela da sala de Planning Poker
    /css
      styles.css     # Estilo moderno (glassmorphism)
    /js
      main.js        # Lógica da home (criação/entrada em sala)
      room.js        # Lógica da sala (WebSocket, votos, stats, UI)

Dockerfile
docker-compose.yml
package.json
README.md
```

Cada sala é persistida em `/app/backend/data/rooms/<slug>.json` com o seguinte formato:

```json
{
  "name": "Time A",
  "private": true,
  "accessCode": "1234",
  "users": [],
  "votes": {},
  "stats": {
    "totalVotes": 0,
    "uniqueValues": 0,
    "mostFrequent": null
  },
  "revealed": false
}
```

---

### 🧩 Fluxo de uso

- **Home (`/`)**
  - Criar nova sala:
    - Informe o nome.
    - Opcional: marcar como **sala privada** e definir `accessCode`.
    - Ao criar, o backend gera um `slug` e redireciona para `/room/<slug>`.
  - Entrar em uma sala existente:
    - Informe o `slug` (ID) ou acesse diretamente pelo link `/room/<slug>`.

- **Sala (`/room/<slug>`)**
  - Configure seu **nome** e **avatar (emoji)**.
  - O navegador gera/guarda um `sessionId` para identificar você na sala.
  - Clique em uma carta para **votar** (votos ficam escondidos).
  - Qualquer participante pode:
    - **Revelar votos**.
    - **Resetar** a rodada (limpa votos e estatísticas).
  - Estatísticas aparecem somente após a revelação.
  - Use o botão **Modo apresentação** para exibir em fullscreen para o time.

---

### 🔌 Eventos WebSocket

- **Cliente → Servidor**
  - `join_room`:
    - `{ roomSlug, name, avatar, sessionId?, accessCode? }`
  - `leave_room`:
    - `{}`
  - `new_vote`:
    - `{ value }` (ex.: `"5"`, `"13"`, `"☕"`)
  - `reveal_votes`:
    - `{}`
  - `reset_votes`:
    - `{}`

- **Servidor → Cliente**
  - `sync_state`:
    - `{ room, selfSessionId }`  
      Estado atual da sala (participantes, se está revelada, votos se já revelado).
  - `room_stats`:
    - `{ stats }`  
      Estatísticas calculadas a partir dos votos.
  - `error`:
    - `{ code, message }`  
      Ex.: `invalid_access_code`, `room_not_found`, `not_in_room`.

Reconexão automática é feita no frontend (`room.js`) caso a conexão WebSocket seja perdida.

---

### 🧪 Rodando localmente (sem Docker)

Pré-requisitos:

- Node.js 18+ instalado.

Passos:

```bash
cd PLANNING POKE
npm install
npm start
```

Por padrão o servidor sobe em `http://localhost:3000`.

- Acesse `http://localhost:3000` para abrir a home.
- Crie uma sala ou entre diretamente em `http://localhost:3000/room/<slug>`.

Os arquivos de salas serão salvos em `app/backend/data/rooms`.

---

### 🐳 Rodando com Docker

#### Usando Docker direto

```bash
cd PLANNING POKE
docker build -t planning-poke .
docker run --name planning-poke \
  -p 3000:3000 \
  -v %cd%/app/backend/data/rooms:/usr/src/app/app/backend/data/rooms \
  planning-poke
```

> Em Linux/macOS, troque `%cd%` por `$(pwd)`.

#### Usando docker-compose

```bash
cd PLANNING POKE
docker-compose up --build
```

O serviço ficará disponível em `http://localhost:3000`.

O diretório `app/backend/data/rooms` é montado como volume, mantendo as salas mesmo após reiniciar o container.

---

### 🔒 Salas privadas

- Ao criar uma sala marcando **Sala privada**, o backend salva `private: true` e o `accessCode`.
- Na primeira entrada em `/room/<slug>`, o frontend:
  - Consulta `/api/rooms/:slug`;
  - Se a sala for privada, abre um **modal** pedindo o código de acesso;
  - Envia o `accessCode` junto com o evento `join_room`.
- Se o código estiver incorreto, o servidor envia `error` com `invalid_access_code` e o frontend volta a pedir o código.

---

### 💡 Observações

- A aplicação evita dependências desnecessárias: apenas `express` e `ws` no backend.
- Tudo é mantido em arquivos JSON, sem banco de dados externo.
- O design é responsivo e adequado tanto para desktop quanto para uso em uma TV/monitor no **modo apresentação**.


