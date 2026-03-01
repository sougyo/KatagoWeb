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

// ---- In-memory record store ----
// Map<id, Record>
// Record: { id, name, size, komi, type:'record', nodes:Map, rootId, currentNodeId, status, gtp, createdAt }
// Node:   { id, parentId, move:{color,pos}|null, children:[] }
const records = new Map();

// ---- SGF utilities ----

/** Convert SGF coordinate pair (e.g. 'pd') to GTP string (e.g. 'Q16') for a given board size. */
function sgfToGtp(coord, size) {
  if (!coord || coord.length < 2) return null;
  const GTP_COLS = 'ABCDEFGHJKLMNOPQRST';
  const a = coord.charCodeAt(0) - 97; // 'a'=0
  const b = coord.charCodeAt(1) - 97;
  if (a < 0 || a >= size || b < 0 || b >= size) return null;
  const col = GTP_COLS[a];
  const row = size - b;
  return `${col}${row}`;
}

/**
 * Parse an SGF string into { nodes:Map, rootId, size, komi }.
 * Supports SZ, KM, B, W properties. Handles simple branching.
 */
function parseSGF(sgfText) {
  const GTP_COLS = 'ABCDEFGHJKLMNOPQRST';
  let pos = 0;
  const text = sgfText.trim();
  let size = 19;
  let komi = 6.5;
  const nodes = new Map();
  let nodeCounter = 0;

  function mkNode(parentId, move) {
    const id = `n${nodeCounter++}`;
    nodes.set(id, { id, parentId, move, children: [] });
    if (parentId && nodes.has(parentId)) {
      nodes.get(parentId).children.push(id);
    }
    return id;
  }

  function skipWS() {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  }

  function parsePropValue() {
    // Expects cursor at '[', reads until matching ']' (handles '\]' escape)
    pos++; // skip '['
    let val = '';
    while (pos < text.length && text[pos] !== ']') {
      if (text[pos] === '\\') { pos++; }
      val += text[pos++];
    }
    pos++; // skip ']'
    return val;
  }

  function parseNode(parentId) {
    // node: ';' followed by properties
    if (text[pos] !== ';') return null;
    pos++;
    let move = null;
    while (pos < text.length) {
      skipWS();
      if (text[pos] === ';' || text[pos] === '(' || text[pos] === ')') break;
      // Read property key
      let key = '';
      while (pos < text.length && /[A-Z]/.test(text[pos])) key += text[pos++];
      if (!key) { pos++; continue; }
      // Read all values
      const vals = [];
      skipWS();
      while (pos < text.length && text[pos] === '[') {
        vals.push(parsePropValue());
        skipWS();
      }
      if (key === 'SZ' && vals[0]) size = parseInt(vals[0]) || 19;
      if (key === 'KM' && vals[0]) komi = parseFloat(vals[0]) || 6.5;
      if ((key === 'B' || key === 'W') && vals[0] !== undefined) {
        const coord = vals[0];
        const gtp = coord === '' ? 'pass' : sgfToGtp(coord, size);
        if (gtp) move = { color: key === 'B' ? 'black' : 'white', pos: gtp };
      }
    }
    return mkNode(parentId, move);
  }

  function parseSequence(parentId) {
    let lastId = parentId;
    while (pos < text.length) {
      skipWS();
      if (text[pos] === ';') {
        lastId = parseNode(lastId);
      } else if (text[pos] === '(') {
        pos++;
        parseSequence(lastId);
        skipWS();
        if (text[pos] === ')') pos++;
      } else {
        break;
      }
    }
    return lastId;
  }

  // Find first '('
  while (pos < text.length && text[pos] !== '(') pos++;
  if (pos >= text.length) throw new Error('Invalid SGF: no opening paren');
  pos++; // skip '('

  // Create root node (no move)
  const rootId = mkNode(null, null);
  parseSequence(rootId);

  return { nodes, rootId, size, komi };
}

function makeRecord({ name, size, komi, sgf }) {
  const id = crypto.randomUUID();
  size = parseInt(size) || 19;
  komi = parseFloat(komi);
  if (isNaN(komi)) komi = 6.5;

  let nodes, rootId;
  if (sgf) {
    const parsed = parseSGF(sgf);
    nodes  = parsed.nodes;
    rootId = parsed.rootId;
    size   = parsed.size;
    komi   = parsed.komi;
  } else {
    nodes  = new Map();
    rootId = crypto.randomUUID();
    nodes.set(rootId, { id: rootId, parentId: null, move: null, children: [] });
  }

  const record = {
    id,
    name:          name || `棋譜 ${records.size + 1}`,
    size,
    komi,
    type:          'record',
    nodes,
    rootId,
    currentNodeId: rootId,
    status:        'idle',
    gtp:           null,
    createdAt:     new Date().toISOString(),
  };
  records.set(id, record);
  return record;
}

function recordPublic(r) {
  const nodesObj = {};
  for (const [k, v] of r.nodes) nodesObj[k] = v;
  return {
    id:            r.id,
    name:          r.name,
    size:          r.size,
    komi:          r.komi,
    type:          r.type,
    nodes:         nodesObj,
    rootId:        r.rootId,
    currentNodeId: r.currentNodeId,
    status:        r.status,
    createdAt:     r.createdAt,
  };
}

/** Returns array of move objects [{color, pos}] from root to nodeId (excluding root's null move). */
function buildGtpPath(record, nodeId) {
  const path = [];
  let cur = nodeId;
  while (cur && cur !== record.rootId) {
    const node = record.nodes.get(cur);
    if (!node) break;
    if (node.move) path.unshift(node.move);
    cur = node.parentId;
  }
  return path;
}

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

// ---- REST API: Records ----

app.get('/api/records', (_req, res) => {
  res.json([...records.values()].map(recordPublic));
});

app.post('/api/records', (req, res) => {
  try {
    const record = makeRecord(req.body);
    res.json(recordPublic(record));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/records/:id', (req, res) => {
  const r = records.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(recordPublic(r));
});

app.delete('/api/records/:id', async (req, res) => {
  const r = records.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.gtp) await r.gtp.quit().catch(() => {});
  records.delete(req.params.id);
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
    if (!b || (b.status !== 'playing' && b.status !== 'analyzing') || b.currentPlayer !== 'black') return;
    if (b.stones[position]) {
      socket.emit('err', 'その場所には石が既にあります');
      return;
    }
    try {
      if (b.gtp?.isAnalyzing) await b.gtp.stopAnalysis().catch(() => {});
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
    if (!b || (b.status !== 'playing' && b.status !== 'analyzing') || b.currentPlayer !== 'black') return;
    try {
      if (b.gtp?.isAnalyzing) await b.gtp.stopAnalysis().catch(() => {});
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
  socket.on('resign', async boardId => {
    const b = boards.get(boardId);
    if (!b || b.status === 'finished') return;
    if (b.gtp?.isAnalyzing) await b.gtp.stopAnalysis().catch(() => {});
    b.status = 'finished';
    b.result = '投了 – KataGo（白）の勝ち';
    io.to(boardId).emit('board', boardPublic(b));
  });

  // Start kata-analyze streaming
  socket.on('start-analysis', boardId => {
    const b = boards.get(boardId);
    if (!b || !b.gtp || b.status !== 'playing' || b.currentPlayer !== 'black') {
      socket.emit('err', '分析できる状態ではありません');
      return;
    }
    b.status = 'analyzing';
    io.to(boardId).emit('board', boardPublic(b));

    const accCandidates = new Map(); // move → candidate (累積)
    b.gtp.startAnalysis(20, lines => {
      for (const c of lines.map(_parseAnalysisLine)) {
        if (c.move && c.move.toLowerCase() !== 'pass') accCandidates.set(c.move, c);
      }
      const candidates = [...accCandidates.values()]
        .sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0))
        .slice(0, 10)
        .map((c, i) => ({ ...c, order: i }));
      console.log(`[analysis] acc ${accCandidates.size} moves, emitting ${candidates.length}, top: ${candidates[0]?.move} wr=${candidates[0]?.winrate?.toFixed(3)}`);
      io.to(boardId).emit('analysis', candidates);
    });
  });

  // Stop kata-analyze
  socket.on('stop-analysis', async boardId => {
    const b = boards.get(boardId);
    if (!b || !b.gtp) return;
    await b.gtp.stopAnalysis().catch(() => {});
    b.status = 'playing';
    io.to(boardId).emit('board', boardPublic(b));
  });

  // ---- Record Socket.IO handlers ----

  socket.on('join-record', id => {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = id;
    socket.join(id);
    const r = records.get(id);
    if (r) socket.emit('record', recordPublic(r));
  });

  socket.on('record-navigate', ({ recordId, nodeId }) => {
    const r = records.get(recordId);
    if (!r || !r.nodes.has(nodeId)) return;
    if (r.gtp?.isAnalyzing) r.gtp.stopAnalysis().catch(() => {});
    r.currentNodeId = nodeId;
    r.status = 'idle';
    io.to(recordId).emit('record', recordPublic(r));
  });

  socket.on('record-add-move', ({ recordId, color, pos }) => {
    const r = records.get(recordId);
    if (!r) return;
    const curNode = r.nodes.get(r.currentNodeId);
    if (!curNode) return;
    // Reuse existing child with same move if present
    for (const childId of curNode.children) {
      const child = r.nodes.get(childId);
      if (child && child.move && child.move.color === color && child.move.pos === pos) {
        r.currentNodeId = childId;
        io.to(recordId).emit('record', recordPublic(r));
        return;
      }
    }
    // Create new child node
    const newId = crypto.randomUUID();
    r.nodes.set(newId, { id: newId, parentId: r.currentNodeId, move: { color, pos }, children: [] });
    curNode.children.push(newId);
    r.currentNodeId = newId;
    io.to(recordId).emit('record', recordPublic(r));
  });

  socket.on('record-start-analysis', async recordId => {
    const r = records.get(recordId);
    if (!r) return;
    // Start KataGo if not yet started
    if (!r.gtp) {
      r.status = 'initializing';
      io.to(recordId).emit('record', recordPublic(r));
      try {
        const gtp = new GTPClient(KATAGO_BIN, KATAGO_CFG, KATAGO_MDL);
        r.gtp = gtp;
        await gtp.start();
      } catch (e) {
        r.status = 'error';
        io.to(recordId).emit('record', recordPublic(r));
        return;
      }
    }
    // Replay board position
    try {
      const gtp = r.gtp;
      if (gtp.isAnalyzing) await gtp.stopAnalysis().catch(() => {});
      await gtp.send(`boardsize ${r.size}`);
      await gtp.send('clear_board');
      await gtp.send(`komi ${r.komi}`);
      const path = buildGtpPath(r, r.currentNodeId);
      for (const { color, pos } of path) {
        if (pos === 'pass') {
          await gtp.send(`play ${color} pass`);
        } else {
          await gtp.play(color, pos);
        }
      }
      r.status = 'analyzing';
      io.to(recordId).emit('record', recordPublic(r));

      const accCandidates = new Map();
      gtp.startAnalysis(20, lines => {
        for (const c of lines.map(_parseAnalysisLine)) {
          if (c.move && c.move.toLowerCase() !== 'pass') accCandidates.set(c.move, c);
        }
        const candidates = [...accCandidates.values()]
          .sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0))
          .slice(0, 10)
          .map((c, i) => ({ ...c, order: i }));
        io.to(recordId).emit('record-analysis', candidates);
      });
    } catch (e) {
      console.error(`[record ${recordId}] analysis start failed:`, e.message);
      r.status = 'idle';
      io.to(recordId).emit('record', recordPublic(r));
    }
  });

  socket.on('record-stop-analysis', async recordId => {
    const r = records.get(recordId);
    if (!r || !r.gtp) return;
    await r.gtp.stopAnalysis().catch(() => {});
    r.status = 'idle';
    io.to(recordId).emit('record', recordPublic(r));
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
 * Parse one "info move ..." line from kata-analyze output.
 * Fields: move, visits, winrate, scoreMean, prior, lcb, order, pv
 */
function _parseAnalysisLine(line) {
  const tok = line.split(' ');
  const r   = {};
  for (let i = 0; i < tok.length; i++) {
    switch (tok[i]) {
      case 'move':      r.move      = tok[++i]; break;
      case 'visits':    r.visits    = parseInt(tok[++i], 10); break;
      case 'winrate':   r.winrate   = parseFloat(tok[++i]); break;
      case 'scoreMean': r.scoreMean = parseFloat(tok[++i]); break;
      case 'prior':     r.prior     = parseFloat(tok[++i]); break;
      case 'lcb':       r.lcb       = parseFloat(tok[++i]); break;
      case 'order':     r.order     = parseInt(tok[++i], 10); break;
      case 'pv':        r.pv = tok.slice(i + 1); i = tok.length; break;
    }
  }
  return r;
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
  for (const r of records.values()) {
    if (r.gtp) await r.gtp.quit().catch(() => {});
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`KataGo: ${KATAGO_BIN}`);
});
