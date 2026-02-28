const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');
const GTPClient  = require('./gtp-client');

// ---- KataGo paths ----
const KATAGO_HOME = process.env.KATAGO_HOME;
if (!KATAGO_HOME) {
  console.error('[error] KATAGO_HOME environment variable is not set.');
  process.exit(1);
}
const KATAGO_BIN = `${KATAGO_HOME}/katago`;
const KATAGO_CFG = `${KATAGO_HOME}/default_gtp.cfg`;
const KATAGO_MDL = `${KATAGO_HOME}/a.bin.gz`;

// ---- Express / Socket.IO setup ----
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- In-memory board store ----
// Map<id, Board>
// Board fields visible to client (via boardPublic): id, name, size, handicap, komi,
//   status, currentPlayer, moves, stones, lastMove, result, createdAt, moveCount
// Server-only fields: gtp (GTPClient instance)
const boards = new Map();

function makeBoard({ name, size, handicap }) {
  const id       = crypto.randomUUID();
  size     = parseInt(size)     || 19;
  handicap = parseInt(handicap) || 0;
  const komi = handicap >= 2 ? 0.5 : 6.5;
  const board = {
    id,
    name:          name || `対局 ${boards.size + 1}`,
    size,
    handicap,
    komi,
    status:        'idle',       // idle | initializing | playing | ai-thinking | finished | error
    currentPlayer: handicap >= 2 ? 'white' : 'black',
    moves:         [],           // [{color:'black'|'white', position:'A1'|'pass'}]
    stones:        {},           // {'A1': 'black', ...}
    lastMove:      null,         // GTP position string, or null
    result:        null,         // string | null
    createdAt:     new Date().toISOString(),
    gtp:           null,         // GTPClient – stripped before sending to client
  };
  boards.set(id, board);
  return board;
}

function boardPublic(b) {
  const { gtp, ...pub } = b;
  pub.moveCount = b.moves.length;
  return pub;
}

// ---- REST API ----

// List all boards
app.get('/api/boards', (_req, res) => {
  res.json([...boards.values()].map(boardPublic));
});

// Create a board and start KataGo asynchronously
app.post('/api/boards', (req, res) => {
  const board = makeBoard(req.body);
  board.status = 'initializing';
  res.json(boardPublic(board));

  // Start KataGo in the background; broadcast progress via Socket.IO
  _startKataGo(board).catch(err => {
    board.status = 'error';
    board.result = err.message;
    console.error(`[board ${board.id}] KataGo start failed:`, err.message);
    io.to(board.id).emit('board', boardPublic(board));
  });
});

// Get a single board
app.get('/api/boards/:id', (req, res) => {
  const b = boards.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(boardPublic(b));
});

// Delete a board (and kill its KataGo process)
app.delete('/api/boards/:id', async (req, res) => {
  const b = boards.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.gtp) await b.gtp.quit().catch(() => {});
  boards.delete(req.params.id);
  res.json({ ok: true });
});

// ---- Socket.IO ----
io.on('connection', socket => {
  let currentRoom = null;

  // Join a board room (and immediately get the current board state)
  socket.on('join', id => {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = id;
    socket.join(id);
    const b = boards.get(id);
    if (b) socket.emit('board', boardPublic(b));
  });

  // Player move
  socket.on('move', async ({ boardId, position }) => {
    const b = boards.get(boardId);
    if (!b || b.status !== 'playing' || b.currentPlayer !== 'black') return;
    if (b.stones[position]) {
      socket.emit('err', 'その場所には石が既にあります');
      return;
    }
    try {
      await b.gtp.play('black', position);
      b.stones          = _parseBoard(await b.gtp.showBoard(), b.size);
      b.moves.push({ color: 'black', position });
      b.lastMove        = position;
      b.currentPlayer   = 'white';
      b.status          = 'ai-thinking';
      io.to(boardId).emit('board', boardPublic(b));
      await _aiMove(b);
    } catch (e) {
      socket.emit('err', `手の実行に失敗: ${e.message}`);
    }
  });

  // Pass
  socket.on('pass', async boardId => {
    const b = boards.get(boardId);
    if (!b || b.status !== 'playing' || b.currentPlayer !== 'black') return;
    try {
      await b.gtp.play('black', 'pass');
      b.moves.push({ color: 'black', position: 'pass' });
      b.lastMove      = null;
      b.currentPlayer = 'white';
      b.status        = 'ai-thinking';
      io.to(boardId).emit('board', boardPublic(b));
      await _aiMove(b);
    } catch (e) {
      socket.emit('err', `パスに失敗: ${e.message}`);
    }
  });

  // Resign
  socket.on('resign', boardId => {
    const b = boards.get(boardId);
    if (!b || b.status === 'finished') return;
    b.status = 'finished';
    b.result = '投了 – KataGo（白）の勝ち';
    io.to(boardId).emit('board', boardPublic(b));
  });
});

// ---- Game logic ----

async function _startKataGo(board) {
  const gtp = new GTPClient(KATAGO_BIN, KATAGO_CFG, KATAGO_MDL);
  board.gtp = gtp;

  await gtp.start();
  await gtp.initGame(board.size, board.handicap, board.komi);

  const boardText  = await gtp.showBoard();
  board.stones     = _parseBoard(boardText, board.size);

  if (board.handicap >= 2) {
    // With handicap, white (KataGo) moves first
    board.status        = 'ai-thinking';
    board.currentPlayer = 'white';
    io.to(board.id).emit('board', boardPublic(board));
    await _aiMove(board);
  } else {
    board.status        = 'playing';
    board.currentPlayer = 'black';
    io.to(board.id).emit('board', boardPublic(board));
  }
}

async function _aiMove(board) {
  const pos = await board.gtp.genMove('white');

  if (pos.toLowerCase() === 'resign') {
    board.status = 'finished';
    board.result = 'KataGo が投了 – あなた（黒）の勝ち';
    io.to(board.id).emit('board', boardPublic(board));
    return;
  }

  const boardText  = await board.gtp.showBoard();
  board.stones     = _parseBoard(boardText, board.size);
  board.moves.push({ color: 'white', position: pos });
  board.lastMove   = pos.toLowerCase() === 'pass' ? null : pos;
  board.currentPlayer = 'black';

  // Two consecutive passes → game over
  const last2 = board.moves.slice(-2);
  if (
    last2.length === 2 &&
    last2[0].position === 'pass' &&
    last2[1].position === 'pass'
  ) {
    board.status = 'finished';
    board.result = '両者パス – 地計算をしてください';
  } else {
    board.status = 'playing';
  }

  io.to(board.id).emit('board', boardPublic(board));
}

/**
 * Parse KataGo's `showboard` text into a stones map.
 *
 * KataGo showboard format (19×19 example):
 *   " 1 . X . O . ..."   (row number right-padded to 2 chars, then stones separated by spaces)
 * X = black, O = white, . = empty, + = star point (empty)
 */
function _parseBoard(text, size) {
  const COLS   = 'ABCDEFGHJKLMNOPQRST';
  const stones = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)/);
    if (!m) continue;
    const row = parseInt(m[1]);
    if (row < 1 || row > size) continue;
    const content = m[2];
    for (let c = 0; c < size; c++) {
      const ch = content[c * 2];
      if (ch === 'X') stones[`${COLS[c]}${row}`] = 'black';
      else if (ch === 'O') stones[`${COLS[c]}${row}`] = 'white';
    }
  }
  return stones;
}

// ---- Graceful shutdown ----
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  for (const b of boards.values()) {
    if (b.gtp) await b.gtp.quit().catch(() => {});
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`KataGo: ${KATAGO_BIN}`);
});
