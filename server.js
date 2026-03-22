const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');
const GTPClient  = require('./gtp-client');
const Database   = require('better-sqlite3');

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

// ---- SQLite persistence ----
const db = new Database(path.join(__dirname, 'katago.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    handicap      INTEGER NOT NULL,
    komi          REAL NOT NULL,
    status        TEXT NOT NULL,
    currentPlayer TEXT NOT NULL,
    moves         TEXT NOT NULL,
    stones        TEXT NOT NULL,
    lastMove      TEXT,
    result        TEXT,
    createdAt     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    komi          REAL NOT NULL,
    playerBlack   TEXT NOT NULL DEFAULT '',
    playerWhite   TEXT NOT NULL DEFAULT '',
    rootId        TEXT NOT NULL,
    currentNodeId TEXT NOT NULL,
    createdAt     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS record_nodes (
    id        TEXT PRIMARY KEY,
    recordId  TEXT NOT NULL,
    parentId  TEXT,
    move      TEXT,
    children  TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (recordId) REFERENCES records(id) ON DELETE CASCADE
  );
`);
// Migrations
try { db.exec('ALTER TABLE record_nodes ADD COLUMN setup    TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE boards       ADD COLUMN analysisAt TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE record_nodes ADD COLUMN winrate    REAL'); } catch (_) {}
try { db.exec('ALTER TABLE record_nodes ADD COLUMN scoreMean  REAL'); } catch (_) {}
try { db.exec('ALTER TABLE record_nodes ADD COLUMN candidates TEXT'); } catch (_) {}

// Prepared statements
const _stmtUpsertBoard = db.prepare(`
  INSERT OR REPLACE INTO boards
    (id, name, size, handicap, komi, status, currentPlayer, moves, stones, lastMove, result, createdAt, analysisAt)
  VALUES
    (@id, @name, @size, @handicap, @komi, @status, @currentPlayer, @moves, @stones, @lastMove, @result, @createdAt, @analysisAt)
`);
function saveBoard(b) {
  _stmtUpsertBoard.run({
    id: b.id, name: b.name, size: b.size, handicap: b.handicap, komi: b.komi,
    status: b.status, currentPlayer: b.currentPlayer,
    moves:      JSON.stringify(b.moves),
    stones:     JSON.stringify(b.stones),
    lastMove:   b.lastMove   ?? null,
    result:     b.result     ?? null,
    createdAt:  b.createdAt,
    analysisAt: JSON.stringify(b.analysisAt ?? {}),
  });
}
const _stmtDeleteBoard = db.prepare('DELETE FROM boards WHERE id = ?');

const _stmtUpsertRecord = db.prepare(`
  INSERT OR REPLACE INTO records
    (id, name, size, komi, playerBlack, playerWhite, rootId, currentNodeId, createdAt)
  VALUES
    (@id, @name, @size, @komi, @playerBlack, @playerWhite, @rootId, @currentNodeId, @createdAt)
`);
const _stmtUpsertNode = db.prepare(`
  INSERT OR REPLACE INTO record_nodes (id, recordId, parentId, move, setup, children, winrate, scoreMean, candidates)
  VALUES (@id, @recordId, @parentId, @move, @setup, @children, @winrate, @scoreMean, @candidates)
`);
const _stmtUpdateNodeChildren    = db.prepare('UPDATE record_nodes SET children = ? WHERE id = ?');
const _stmtUpdateNodeWinrate     = db.prepare('UPDATE record_nodes SET winrate = ?, scoreMean = ? WHERE id = ?');
const _stmtUpdateNodeCandidates  = db.prepare('UPDATE record_nodes SET winrate = ?, scoreMean = ?, candidates = ? WHERE id = ?');
const _stmtUpdateRecordCurrent   = db.prepare('UPDATE records SET currentNodeId = ? WHERE id = ?');
const _stmtUpdateRecordKomi      = db.prepare('UPDATE records SET komi = ? WHERE id = ?');
const _stmtDeleteRecord          = db.prepare('DELETE FROM records WHERE id = ?');
const _stmtDeleteNode            = db.prepare('DELETE FROM record_nodes WHERE id = ?');

// ---- Analysis timeout ----
const ANALYSIS_TIMEOUT_MS = 60_000; // auto-stop analysis after 1 minute

function _clearAnalysisTimer(obj) {
  if (obj._analysisTimer) {
    clearTimeout(obj._analysisTimer);
    obj._analysisTimer = null;
  }
}

function saveRecord(r) {
  db.transaction(() => {
    _stmtUpsertRecord.run({
      id: r.id, name: r.name, size: r.size, komi: r.komi,
      playerBlack: r.playerBlack, playerWhite: r.playerWhite,
      rootId: r.rootId, currentNodeId: r.currentNodeId, createdAt: r.createdAt,
    });
    for (const [, node] of r.nodes) {
      _stmtUpsertNode.run({
        id: node.id, recordId: r.id,
        parentId:   node.parentId ?? null,
        move:       node.move       ? JSON.stringify(node.move)       : null,
        setup:      node.setup      ? JSON.stringify(node.setup)      : null,
        children:   JSON.stringify(node.children),
        winrate:    node.winrate    ?? null,
        scoreMean:  node.scoreMean  ?? null,
        candidates: node.candidates ? JSON.stringify(node.candidates) : null,
      });
    }
  })();
}

// ---- In-memory stores ----
// Loaded from DB on startup; also populated on create / deleted on delete.
const boards  = new Map();  // Map<id, Board>
const records = new Map();  // Map<id, Record>

// ---- Load persisted state from DB ----
{
  for (const row of db.prepare('SELECT * FROM boards').all()) {
    let { status, currentPlayer } = row;
    // Boards that were mid-init: restart fresh on join
    if (status === 'initializing') status = 'idle';
    // Boards in analysis: treat as playing (user's turn) on restart
    if (status === 'analyzing')    status = 'playing';
    // 'ai-thinking' stays as-is → _ensureGtp will resume AI on join
    // 'playing', 'finished', 'error' stay as-is
    boards.set(row.id, {
      id: row.id, name: row.name, size: row.size, handicap: row.handicap, komi: row.komi,
      status, currentPlayer,
      moves:      JSON.parse(row.moves),
      stones:     JSON.parse(row.stones),
      lastMove:   row.lastMove ?? null,
      result:     row.result   ?? null,
      createdAt:  row.createdAt,
      analysisAt: row.analysisAt ? JSON.parse(row.analysisAt) : {},
      gtp: null,
    });
  }

  const nodeRows      = db.prepare('SELECT * FROM record_nodes').all();
  const nodesByRecord = new Map();
  for (const n of nodeRows) {
    if (!nodesByRecord.has(n.recordId)) nodesByRecord.set(n.recordId, []);
    nodesByRecord.get(n.recordId).push(n);
  }
  for (const row of db.prepare('SELECT * FROM records').all()) {
    const nodes = new Map();
    for (const n of (nodesByRecord.get(row.id) ?? [])) {
      nodes.set(n.id, {
        id: n.id, parentId: n.parentId ?? null,
        move:       n.move       ? JSON.parse(n.move)       : null,
        setup:      n.setup      ? JSON.parse(n.setup)      : null,
        children:   JSON.parse(n.children),
        winrate:    n.winrate    ?? null,
        scoreMean:  n.scoreMean  ?? null,
        candidates: n.candidates ? JSON.parse(n.candidates) : null,
      });
    }
    records.set(row.id, {
      id: row.id, name: row.name, size: row.size, komi: row.komi,
      playerBlack: row.playerBlack ?? '', playerWhite: row.playerWhite ?? '',
      type: 'record', nodes,
      rootId: row.rootId, currentNodeId: row.currentNodeId,
      status: 'idle', gtp: null, createdAt: row.createdAt,
    });
  }
  console.log(`[db] loaded ${boards.size} board(s), ${records.size} record(s)`);
}

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
 * Parse an SGF string into { nodes:Map, rootId, size, komi, playerBlack, playerWhite }.
 * Supports SZ, KM, PB, PW, B, W properties. Handles simple branching.
 */
function parseSGF(sgfText) {
  const GTP_COLS = 'ABCDEFGHJKLMNOPQRST';
  let pos = 0;
  const text = sgfText.trim();
  let size = 19;
  let komi = 6.5;
  let playerBlack = '';
  let playerWhite = '';
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
    let move  = null;
    let setup = null;
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
      if (key === 'KM' && vals.length > 0) {
        let k = parseFloat(vals[0]);
        if (isFinite(k)) {
          // Some SGF databases store komi in hundredths (e.g. KM[375] = 3.75 pts).
          // KataGo rejects |komi| > 150, so divide by 100 when out of range.
          if (Math.abs(k) > 150) k /= 100;
          komi = k;
        }
      }
      if (key === 'PB' && vals[0] !== undefined) playerBlack = vals[0].trim();
      if (key === 'PW' && vals[0] !== undefined) playerWhite = vals[0].trim();
      if ((key === 'B' || key === 'W') && vals[0] !== undefined) {
        const coord = vals[0];
        const gtp = coord === '' ? 'pass' : sgfToGtp(coord, size);
        if (gtp) move = { color: key === 'B' ? 'black' : 'white', pos: gtp };
      }
      // Setup stones: AB (Add Black), AW (Add White), AE (Add Empty)
      if (key === 'AB' || key === 'AW' || key === 'AE') {
        const field = key === 'AB' ? 'black' : key === 'AW' ? 'white' : 'empty';
        for (const v of vals) {
          const gtp = sgfToGtp(v, size);
          if (gtp) {
            if (!setup) setup = {};
            if (!setup[field]) setup[field] = [];
            setup[field].push(gtp);
          }
        }
      }
    }
    const nodeId = mkNode(parentId, move);
    if (setup) nodes.get(nodeId).setup = setup;
    return nodeId;
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

  return { nodes, rootId, size, komi, playerBlack, playerWhite };
}

function makeRecord({ name, size, komi: komiOverride, sgf, playerBlack: pbArg, playerWhite: pwArg }) {
  const id = crypto.randomUUID();
  let size_ = parseInt(size) || 19;
  let komi  = 6.5;
  let playerBlack = pbArg || '';
  let playerWhite = pwArg || '';

  let nodes, rootId;
  if (sgf) {
    const parsed = parseSGF(sgf);
    nodes       = parsed.nodes;
    rootId      = parsed.rootId;
    size_       = parsed.size;
    komi        = parsed.komi;
    if (parsed.playerBlack) playerBlack = parsed.playerBlack;
    if (parsed.playerWhite) playerWhite = parsed.playerWhite;
    // Allow user to override komi from SGF
    const ko = parseFloat(komiOverride);
    if (!isNaN(ko)) komi = ko;
  } else {
    const ko = parseFloat(komiOverride);
    komi   = !isNaN(ko) ? ko : 6.5;
    nodes  = new Map();
    rootId = crypto.randomUUID();
    nodes.set(rootId, { id: rootId, parentId: null, move: null, children: [] });
  }

  const record = {
    id,
    name:          name || `棋譜 ${records.size + 1}`,
    size:          size_,
    komi,
    playerBlack,
    playerWhite,
    type:          'record',
    nodes,
    rootId,
    currentNodeId: rootId,
    status:        'idle',
    gtp:           null,
    createdAt:     new Date().toISOString(),
  };
  records.set(id, record);
  saveRecord(record);
  return record;
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
    status:        'idle',
    currentPlayer: handicap >= 2 ? 'white' : 'black',
    moves:         [],
    stones:        {},
    lastMove:      null,
    result:        null,
    createdAt:     new Date().toISOString(),
    analysisAt:    {},
    gtp:           null,
  };
  boards.set(id, board);
  return board;
}

function boardPublic(b) {
  const { gtp, _analysisTimer, ...pub } = b;
  pub.moveCount = b.moves.length;
  pub.currentCandidates = b.analysisAt[b.moves.length]?.candidates ?? null;
  return pub;
}

function recordPublic(r) {
  const nodesObj = {};
  for (const [k, v] of r.nodes) {
    const { candidates, ...nodeData } = v;  // candidates は currentCandidates で別送
    nodesObj[k] = nodeData;
  }
  const currentNode = r.nodes.get(r.currentNodeId);
  return {
    id:            r.id,
    name:          r.name,
    size:          r.size,
    komi:          r.komi,
    playerBlack:   r.playerBlack ?? '',
    playerWhite:   r.playerWhite ?? '',
    type:          r.type,
    nodes:         nodesObj,
    rootId:        r.rootId,
    currentNodeId: r.currentNodeId,
    status:        r.status,
    createdAt:     r.createdAt,
    currentCandidates: currentNode?.candidates ?? null,
  };
}

/**
 * Returns array of {color, pos} steps from root to nodeId.
 * Includes AB/AW setup stones (as individual play steps) and regular moves.
 */
/** Returns the color that is next to move at nodeId (mirrors client-side getNextColor). */
function _getNextColor(record, nodeId) {
  let blackMoves = 0, whiteMoves = 0, hasBlackSetup = false;
  let cur = nodeId;
  while (cur) {
    const node = record.nodes.get(cur);
    if (!node) break;
    if (node.setup?.black?.length) hasBlackSetup = true;
    if (node.move?.color === 'black') blackMoves++;
    if (node.move?.color === 'white') whiteMoves++;
    cur = node.parentId;
  }
  if (hasBlackSetup) return whiteMoves <= blackMoves ? 'white' : 'black';
  return blackMoves <= whiteMoves ? 'black' : 'white';
}

/** Recursively collect nodeId and all its descendants. */
function _collectSubtree(nodes, nodeId) {
  const ids = [nodeId];
  const node = nodes.get(nodeId);
  if (node) for (const childId of node.children) ids.push(..._collectSubtree(nodes, childId));
  return ids;
}

function buildGtpPath(record, nodeId) {
  const steps = [];
  let cur = nodeId;
  while (cur) {
    const node = record.nodes.get(cur);
    if (!node) break;
    const nodeSteps = [];
    if (node.setup) {
      for (const pos of (node.setup.black ?? [])) nodeSteps.push({ color: 'black', pos });
      for (const pos of (node.setup.white ?? [])) nodeSteps.push({ color: 'white', pos });
      // AE (remove stones) cannot be expressed as a GTP play command; skip for replay
    }
    if (node.move) nodeSteps.push(node.move);
    steps.unshift(...nodeSteps);
    cur = node.parentId;
  }
  return steps;
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
  saveBoard(board);
  res.json(boardPublic(board));

  _ensureGtp(board).catch(() => {});
});

// Get a single board
app.get('/api/boards/:id', (req, res) => {
  const b = boards.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(boardPublic(b));
});

// Delete a board (and kill its KataGo process)
// Convert a finished game to a record for review
app.post('/api/boards/:id/to-record', (req, res) => {
  const b = boards.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });

  // Fixed handicap positions matching KataGo's fixed_handicap command output.
  // Order: bottom-left, top-right, top-left, bottom-right, center, edges...
  const FIXED_HANDICAP = {
    19: {
      2: ['D4','Q16'],
      3: ['D4','Q16','D16'],
      4: ['D4','Q16','D16','Q4'],
      5: ['D4','Q16','D16','Q4','K10'],
      6: ['D4','Q16','D16','Q4','D10','Q10'],
      7: ['D4','Q16','D16','Q4','D10','Q10','K10'],
      8: ['D4','Q16','D16','Q4','D10','Q10','K4','K16'],
      9: ['D4','Q16','D16','Q4','D10','Q10','K4','K16','K10'],
    },
    13: {
      2: ['D4','K10'],
      3: ['D4','K10','D10'],
      4: ['D4','K10','D10','K4'],
      5: ['D4','K10','D10','K4','G7'],
      6: ['D4','K10','D10','K4','D7','K7'],
      7: ['D4','K10','D10','K4','D7','K7','G7'],
      8: ['D4','K10','D10','K4','D7','K7','G4','G10'],
      9: ['D4','K10','D10','K4','D7','K7','G4','G10','G7'],
    },
    9: {
      2: ['C3','G7'],
      3: ['C3','G7','C7'],
      4: ['C3','G7','C7','G3'],
      5: ['C3','G7','C7','G3','E5'],
      6: ['C3','G7','C7','G3','C5','G5'],
      7: ['C3','G7','C7','G3','C5','G5','E5'],
      8: ['C3','G7','C7','G3','C5','G5','E3','E7'],
      9: ['C3','G7','C7','G3','C5','G5','E3','E7','E5'],
    },
  };

  const id = crypto.randomUUID();
  const nodes = new Map();

  const rootId = crypto.randomUUID();
  const rootNode = { id: rootId, parentId: null, move: null, children: [] };

  // Add handicap stones as AB setup in the root node
  if (b.handicap >= 2) {
    const positions = (FIXED_HANDICAP[b.size] ?? {})[b.handicap] ?? [];
    if (positions.length > 0) rootNode.setup = { black: positions };
  }

  nodes.set(rootId, rootNode);

  let prevId = rootId;
  for (const m of b.moves) {
    const nodeId = crypto.randomUUID();
    nodes.set(nodeId, {
      id: nodeId,
      parentId: prevId,
      move: { color: m.color, pos: m.position },
      children: [],
    });
    nodes.get(prevId).children.push(nodeId);
    prevId = nodeId;
  }

  const record = {
    id,
    name: b.name,
    size: b.size,
    komi: b.komi,
    playerBlack: '',
    playerWhite: 'KataGo',
    type: 'record',
    nodes,
    rootId,
    currentNodeId: prevId, // start at the last move
    status: 'idle',
    gtp: null,
    createdAt: new Date().toISOString(),
  };

  records.set(id, record);
  saveRecord(record);
  res.json(recordPublic(record));
});

app.delete('/api/boards/:id', async (req, res) => {
  const b = boards.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.gtp) await b.gtp.quit().catch(() => {});
  boards.delete(req.params.id);
  _stmtDeleteBoard.run(req.params.id);
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
  _stmtDeleteRecord.run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/records/:id', (req, res) => {
  const r = records.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (req.body.komi !== undefined) {
    const k = parseFloat(req.body.komi);
    if (!isNaN(k)) {
      r.komi = k;
      _stmtUpdateRecordKomi.run(k, r.id);
    }
  }
  io.to(r.id).emit('record', recordPublic(r));
  res.json(recordPublic(r));
});

// ---- KataGo board init / resume ----

// Map<boardId, Promise> – prevents concurrent init for the same board
const _boardGtpInit = new Map();

/**
 * Ensure KataGo is running for a board.
 * - If gtp already exists: no-op.
 * - If no moves: fresh init (same as original _startKataGo).
 * - If has moves: replay the saved position (resume after restart).
 * AI is automatically triggered if it is white's turn after init/replay.
 */
async function _ensureGtp(board) {
  if (board.gtp) return;
  if (_boardGtpInit.has(board.id)) return _boardGtpInit.get(board.id);

  const p = (async () => {
    board.status = 'initializing';
    saveBoard(board);
    io.to(board.id).emit('board', boardPublic(board));

    const gtp = new GTPClient(KATAGO_BIN, KATAGO_CFG, KATAGO_MDL);
    board.gtp = gtp;
    await gtp.start();

    if (board.moves.length === 0) {
      // ---- Fresh start ----
      await gtp.initGame(board.size, board.handicap, board.komi);
      const boardText = await gtp.showBoard();
      board.stones = _parseBoard(boardText, board.size);

      if (board.handicap >= 2) {
        board.status        = 'ai-thinking';
        board.currentPlayer = 'white';
        saveBoard(board);
        io.to(board.id).emit('board', boardPublic(board));
        await _aiMove(board);
      } else {
        board.status        = 'playing';
        board.currentPlayer = 'black';
        saveBoard(board);
        io.to(board.id).emit('board', boardPublic(board));
      }
    } else {
      // ---- Resume: replay saved position ----
      await gtp.send(`boardsize ${board.size}`);
      await gtp.send('clear_board');
      if (board.handicap >= 2) await gtp.send(`fixed_handicap ${board.handicap}`);
      await gtp.send(`komi ${board.komi}`);
      for (const m of board.moves) await gtp.play(m.color, m.position);

      const boardText = await gtp.showBoard();
      board.stones = _parseBoard(boardText, board.size);

      if (board.currentPlayer === 'white') {
        // AI's turn (board was in ai-thinking when server stopped)
        board.status = 'ai-thinking';
        saveBoard(board);
        io.to(board.id).emit('board', boardPublic(board));
        await _aiMove(board);
      } else {
        board.status = 'playing';
        saveBoard(board);
        io.to(board.id).emit('board', boardPublic(board));
      }
    }
  })();

  _boardGtpInit.set(board.id, p);
  p.catch(err => {
    board.gtp    = null;
    board.status = 'error';
    board.result = err.message;
    console.error(`[board ${board.id}] KataGo init failed:`, err.message);
    saveBoard(board);
    io.to(board.id).emit('board', boardPublic(board));
  }).finally(() => {
    _boardGtpInit.delete(board.id);
  });
  return p;
}

// ---- Socket.IO ----
io.on('connection', socket => {
  let currentRoom = null;

  // Join a board room (and immediately get the current board state)
  socket.on('join', id => {
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = id;
    socket.join(id);
    const b = boards.get(id);
    if (!b) return;
    socket.emit('board', boardPublic(b));

    // Auto-resume KataGo for boards that need immediate action:
    // - 'idle': interrupted before KataGo ever started
    // - 'ai-thinking': AI was mid-move when server stopped
    if (!b.gtp && (b.status === 'idle' || b.status === 'ai-thinking')) {
      _ensureGtp(b).catch(() => {});
    }
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
      await _ensureGtp(b);
      if (b.gtp?.isAnalyzing) { _clearAnalysisTimer(b); await b.gtp.stopAnalysis().catch(() => {}); }
      await b.gtp.play('black', position);
      b.stones          = _parseBoard(await b.gtp.showBoard(), b.size);
      b.moves.push({ color: 'black', position });
      b.lastMove        = position;
      b.currentPlayer   = 'white';
      b.status          = 'ai-thinking';
      saveBoard(b);
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
      await _ensureGtp(b);
      if (b.gtp?.isAnalyzing) { _clearAnalysisTimer(b); await b.gtp.stopAnalysis().catch(() => {}); }
      await b.gtp.play('black', 'pass');
      b.moves.push({ color: 'black', position: 'pass' });
      b.lastMove      = null;
      b.currentPlayer = 'white';
      b.status        = 'ai-thinking';
      saveBoard(b);
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
    if (b.gtp?.isAnalyzing) { _clearAnalysisTimer(b); await b.gtp.stopAnalysis().catch(() => {}); }
    b.status = 'finished';
    b.result = '投了 – KataGo（白）の勝ち';
    saveBoard(b);
    io.to(boardId).emit('board', boardPublic(b));
  });

  // Start kata-analyze streaming
  socket.on('start-analysis', async boardId => {
    const b = boards.get(boardId);
    if (!b || b.status !== 'playing' || b.currentPlayer !== 'black') {
      socket.emit('err', '分析できる状態ではありません');
      return;
    }
    try {
      await _ensureGtp(b);
    } catch {
      return;
    }
    if (b.status !== 'playing' || b.currentPlayer !== 'black') return;

    b.status = 'analyzing';
    saveBoard(b);
    io.to(boardId).emit('board', boardPublic(b));

    _clearAnalysisTimer(b);
    b._analysisTimer = setTimeout(async () => {
      if (!b.gtp?.isAnalyzing) return;
      await b.gtp.stopAnalysis().catch(() => {});
      b.status = 'playing';
      saveBoard(b);
      io.to(boardId).emit('board', boardPublic(b));
    }, ANALYSIS_TIMEOUT_MS);

    const accCandidates = new Map();
    b.gtp.startAnalysis(20, lines => {
      for (const c of lines.map(_parseAnalysisLine)) {
        if (c.move && c.move.toLowerCase() !== 'pass') accCandidates.set(c.move, c);
      }
      const candidates = [...accCandidates.values()]
        .sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0))
        .slice(0, 20)
        .map((c, i) => ({ ...c, order: i }));
      // Update in-memory win rate and candidates for current position (saved to DB on analysis stop)
      const best = candidates.find(c => c.order === 0) ?? candidates[0];
      if (best) {
        b.analysisAt[b.moves.length] = { winrate: best.winrate, scoreMean: best.scoreMean ?? null, candidates };
      }
      console.log(`[analysis] acc ${accCandidates.size} moves, emitting ${candidates.length}, top: ${candidates[0]?.move} wr=${candidates[0]?.winrate?.toFixed(3)}`);
      io.to(boardId).emit('analysis', candidates);
    });
  });

  // Stop kata-analyze
  socket.on('stop-analysis', async boardId => {
    const b = boards.get(boardId);
    if (!b || !b.gtp) return;
    _clearAnalysisTimer(b);
    await b.gtp.stopAnalysis().catch(() => {});
    b.status = 'playing';
    saveBoard(b);
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
    if (r.gtp?.isAnalyzing) {
      _clearAnalysisTimer(r);
      r.gtp.stopAnalysis().catch(() => {});
      const node = r.nodes.get(r.currentNodeId);
      if (node?.winrate != null) _stmtUpdateNodeCandidates.run(node.winrate, node.scoreMean ?? null, node.candidates ? JSON.stringify(node.candidates) : null, node.id);
    }
    r.currentNodeId = nodeId;
    r.status = 'idle';
    _stmtUpdateRecordCurrent.run(nodeId, recordId);
    io.to(recordId).emit('record', recordPublic(r));
  });

  socket.on('record-delete-move', ({ recordId, nodeId }) => {
    const r = records.get(recordId);
    if (!r || !r.nodes.has(nodeId) || nodeId === r.rootId) return;
    const node   = r.nodes.get(nodeId);
    const parent = r.nodes.get(node.parentId);
    if (!parent) return;

    // Stop analysis if running
    if (r.gtp?.isAnalyzing) {
      _clearAnalysisTimer(r);
      r.gtp.stopAnalysis().catch(() => {});
    }

    // Collect nodeId + all descendants
    const toDelete = _collectSubtree(r.nodes, nodeId);

    // Remove from parent's children list
    parent.children = parent.children.filter(id => id !== nodeId);
    r.currentNodeId = node.parentId;

    db.transaction(() => {
      _stmtUpdateNodeChildren.run(JSON.stringify(parent.children), parent.id);
      _stmtUpdateRecordCurrent.run(node.parentId, recordId);
      for (const id of toDelete) {
        _stmtDeleteNode.run(id);
        r.nodes.delete(id);
      }
    })();

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
        _stmtUpdateRecordCurrent.run(childId, recordId);
        io.to(recordId).emit('record', recordPublic(r));
        return;
      }
    }
    // Create new child node
    const parentNodeId = r.currentNodeId;  // save before update
    const newId   = crypto.randomUUID();
    const newNode = { id: newId, parentId: parentNodeId, move: { color, pos }, children: [] };
    r.nodes.set(newId, newNode);
    curNode.children.push(newId);
    r.currentNodeId = newId;
    // Persist: new node + updated parent children + new currentNodeId
    db.transaction(() => {
      _stmtUpsertNode.run({
        id: newId, recordId,
        parentId:  parentNodeId,
        move:      JSON.stringify({ color, pos }),
        setup:     null,
        children:  '[]',
        winrate:   null,
        scoreMean: null,
      });
      _stmtUpdateNodeChildren.run(JSON.stringify(curNode.children), curNode.id);
      _stmtUpdateRecordCurrent.run(newId, recordId);
    })();
    io.to(recordId).emit('record', recordPublic(r));
  });

  socket.on('record-start-analysis', async recordId => {
    const r = records.get(recordId);
    if (!r) return;
    // Guard: prevent concurrent starts
    if (r.status === 'initializing' || r.status === 'analyzing') return;

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
      // KataGo requires komi to be a half-integer (multiple of 0.5).
      // Round to nearest 0.5 to handle Chinese-rules values like 3.75.
      const rawKomi = Number.isFinite(r.komi) ? r.komi : 6.5;
      const komi = Math.round(rawKomi * 2) / 2;
      console.log(`[record ${recordId}] analysis: size=${r.size}, komi=${komi} (raw=${rawKomi}), node=${r.currentNodeId}`);
      await gtp.send(`boardsize ${r.size}`);
      await gtp.send('clear_board');
      await gtp.send(`komi ${komi}`);
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

      _clearAnalysisTimer(r);
      r._analysisTimer = setTimeout(async () => {
        if (!r.gtp?.isAnalyzing) return;
        await r.gtp.stopAnalysis().catch(() => {});
        const node = r.nodes.get(r.currentNodeId);
        if (node?.winrate != null) _stmtUpdateNodeCandidates.run(node.winrate, node.scoreMean ?? null, node.candidates ? JSON.stringify(node.candidates) : null, node.id);
        r.status = 'idle';
        io.to(recordId).emit('record', recordPublic(r));
      }, ANALYSIS_TIMEOUT_MS);

      // kata-analyze returns winrate/scoreMean from the current player's perspective.
      // Normalize to always be from black's perspective.
      const isWhiteToMove = _getNextColor(r, r.currentNodeId) === 'white';
      const toBlackPov = c => isWhiteToMove
        ? { ...c,
            winrate:   c.winrate   != null ? 1 - c.winrate   : c.winrate,
            scoreMean: c.scoreMean != null ? -c.scoreMean     : c.scoreMean }
        : c;

      const accCandidates = new Map();
      gtp.startAnalysis(20, lines => {
        for (const c of lines.map(_parseAnalysisLine)) {
          if (c.move && c.move.toLowerCase() !== 'pass') accCandidates.set(c.move, toBlackPov(c));
        }
        const candidates = [...accCandidates.values()]
          .sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0))
          .slice(0, 20)
          .map((c, i) => ({ ...c, order: i }));
        // Update current node's win rate and candidates in memory (saved to DB on analysis stop)
        const best = candidates.find(c => c.order === 0) ?? candidates[0];
        if (best) {
          const node = r.nodes.get(r.currentNodeId);
          if (node) { node.winrate = best.winrate; node.scoreMean = best.scoreMean ?? null; node.candidates = candidates; }
        }
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
    _clearAnalysisTimer(r);
    await r.gtp.stopAnalysis().catch(() => {});
    const node = r.nodes.get(r.currentNodeId);
    if (node?.winrate != null) _stmtUpdateNodeCandidates.run(node.winrate, node.scoreMean ?? null, node.candidates ? JSON.stringify(node.candidates) : null, node.id);
    r.status = 'idle';
    io.to(recordId).emit('record', recordPublic(r));
  });
});

// ---- Game logic ----

async function _aiMove(board) {
  const pos = await board.gtp.genMove('white');

  if (pos.toLowerCase() === 'resign') {
    board.status = 'finished';
    board.result = 'KataGo が投了 – あなた（黒）の勝ち';
    saveBoard(board);
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

  saveBoard(board);
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
      case 'pv': {
        let pvEnd = i + 1;
        while (pvEnd < tok.length && tok[pvEnd] !== 'info') pvEnd++;
        r.pv = tok.slice(i + 1, pvEnd);
        i = pvEnd - 1;
        break;
      }
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
  db.close();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`KataGo: ${KATAGO_BIN}`);
});
