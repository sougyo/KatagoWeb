'use strict';

// ============================================================
// Constants
// ============================================================
const GTP_COLS = 'ABCDEFGHJKLMNOPQRST'; // 19 letters, skipping I

const STAR_POINTS = {
  19: [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]],
  13: [[3,3],[3,6],[3,9],[6,3],[6,6],[6,9],[9,3],[9,6],[9,9]],
   9: [[2,2],[2,4],[2,6],[4,2],[4,4],[4,6],[6,2],[6,4],[6,6]],
};

const STATUS_LABELS = {
  idle:          '準備中',
  initializing:  'KataGo 起動中…',
  playing:       '対局中',
  'ai-thinking': 'AI 思考中…',
  analyzing:     '分析中',
  finished:      '終局',
  error:         'エラー',
};

// ============================================================
// SGF meta parser (client-side, lightweight)
// ============================================================
function parseSgfMeta(text) {
  const meta = { komi: 6.5, playerBlack: '', playerWhite: '' };
  const km = text.match(/KM\[([\d.+\-]+)\]/);
  if (km) {
    let k = parseFloat(km[1]);
    if (isFinite(k)) {
      if (Math.abs(k) > 150) k /= 100;
      meta.komi = k;
    }
  }
  const pb = text.match(/PB\[([^\]]*)\]/);
  if (pb) meta.playerBlack = pb[1].trim();
  const pw = text.match(/PW\[([^\]]*)\]/);
  if (pw) meta.playerWhite = pw[1].trim();
  return meta;
}

function updateSgfMetaDisplay(text) {
  const meta = parseSgfMeta(text);
  document.getElementById('rec-sgf-komi').value      = meta.komi;
  document.getElementById('rec-sgf-pb').textContent  = meta.playerBlack || '—';
  document.getElementById('rec-sgf-pw').textContent  = meta.playerWhite || '—';
}

// ============================================================
// GoBoard – lightweight board with capture logic (for record replay)
// ============================================================
class GoBoard {
  constructor(size) {
    this.size   = size;
    this.stones = {}; // {pos: 'black'|'white'}
  }

  play(color, pos) {
    if (pos === 'pass') return;
    this.stones[pos] = color;
    const opp = color === 'black' ? 'white' : 'black';
    // Remove captured opponent groups first
    for (const nb of this._adj(pos)) {
      if (this.stones[nb] === opp && !this._hasLiberty(nb, new Set())) {
        this._removeGroup(nb);
      }
    }
    // Remove own group if suicidal (ko-less simplified)
    if (!this._hasLiberty(pos, new Set())) {
      this._removeGroup(pos);
    }
  }

  _adj(pos) {
    const GTP_COLS = 'ABCDEFGHJKLMNOPQRST';
    const col = GTP_COLS.indexOf(pos[0]);
    const row = parseInt(pos.slice(1), 10);
    const result = [];
    if (col > 0) result.push(`${GTP_COLS[col-1]}${row}`);
    if (col < this.size - 1) result.push(`${GTP_COLS[col+1]}${row}`);
    if (row > 1) result.push(`${GTP_COLS[col]}${row-1}`);
    if (row < this.size) result.push(`${GTP_COLS[col]}${row+1}`);
    return result;
  }

  _hasLiberty(pos, visited) {
    if (visited.has(pos)) return false;
    visited.add(pos);
    const color = this.stones[pos];
    for (const nb of this._adj(pos)) {
      if (!this.stones[nb]) return true;
      if (this.stones[nb] === color && this._hasLiberty(nb, visited)) return true;
    }
    return false;
  }

  _removeGroup(pos) {
    const color = this.stones[pos];
    const stack = [pos];
    while (stack.length) {
      const cur = stack.pop();
      if (!this.stones[cur] || this.stones[cur] !== color) continue;
      delete this.stones[cur];
      for (const nb of this._adj(cur)) {
        if (this.stones[nb] === color) stack.push(nb);
      }
    }
  }
}

// ============================================================
// App state
// ============================================================
const state = {
  boards:          [],
  currentBoardId:  null,
  currentBoard:    null,   // latest board object from server
  analysisData:    null,   // latest analysis candidates
  records:         [],
  currentRecordId: null,
  currentRecord:   null,
  recordAnalysis:  null,
};

const socket = io();

// ============================================================
// Utility helpers
// ============================================================
function esc(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
  );
}

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// GTP position → SVG {x, y}  (viewBox units, 1-indexed, origin = top-left)
function gtpToXY(pos, N) {
  const col = GTP_COLS.indexOf(pos[0]);
  const row = parseInt(pos.slice(1), 10);
  if (col < 0 || isNaN(row)) return null;
  return { x: col + 1, y: N - row + 1 };
}

// SVG {x,y} → GTP position string
function xyToGtp(x, y, N) {
  return `${GTP_COLS[x - 1]}${N - y + 1}`;
}

// ============================================================
// Record tree utilities
// ============================================================

function computeStones(nodes, rootId, nodeId, size) {
  // Build path from root (inclusive) to nodeId
  const path = [];
  let cur = nodeId;
  while (cur) {
    const node = nodes[cur];
    if (!node) break;
    path.unshift(node);
    cur = node.parentId;
  }
  const board = new GoBoard(size);
  for (const node of path) {
    // Apply setup stones (AB / AW / AE) before the move of this node
    if (node.setup) {
      for (const pos of (node.setup.black ?? [])) board.stones[pos] = 'black';
      for (const pos of (node.setup.white ?? [])) board.stones[pos] = 'white';
      for (const pos of (node.setup.empty ?? [])) delete board.stones[pos];
    }
    if (node.move) board.play(node.move.color, node.move.pos);
  }
  return board.stones;
}

function getMoveNumber(nodes, nodeId) {
  let count = 0;
  let cur = nodeId;
  while (cur) {
    const node = nodes[cur];
    if (!node) break;
    if (node.move) count++;
    cur = node.parentId;
  }
  return count;
}

function getNextColor(nodes, nodeId) {
  let blackMoves = 0, whiteMoves = 0;
  let hasBlackSetup = false;
  let cur = nodeId;
  while (cur) {
    const node = nodes[cur];
    if (!node) break;
    if (node.setup?.black?.length) hasBlackSetup = true;
    if (node.move?.color === 'black') blackMoves++;
    if (node.move?.color === 'white') whiteMoves++;
    cur = node.parentId;
  }
  // Handicap game (AB setup stones present): white moves first after setup.
  // Normal game: black moves first.
  if (hasBlackSetup) {
    return whiteMoves <= blackMoves ? 'white' : 'black';
  }
  return blackMoves <= whiteMoves ? 'black' : 'white';
}

function getPath(nodes, nodeId) {
  const path = [];
  let cur = nodeId;
  while (cur) {
    const node = nodes[cur];
    if (!node) break;
    path.unshift(cur);
    cur = node.parentId;
  }
  return path;
}

function getFirstChild(nodes, nodeId) {
  const node = nodes[nodeId];
  return node?.children?.[0] ?? null;
}

function getLastDescendant(nodes, nodeId) {
  let cur = nodeId;
  while (true) {
    const child = getFirstChild(nodes, cur);
    if (!child) return cur;
    cur = child;
  }
}

// ============================================================
// Navigation
// ============================================================
function showListView() {
  state.currentBoardId  = null;
  state.currentRecordId = null;
  document.getElementById('view-list').classList.remove('hidden');
  document.getElementById('view-game').classList.add('hidden');
  document.getElementById('view-record').classList.add('hidden');
  loadBoards();
}

function showGameView(boardId) {
  state.currentBoardId = boardId;
  document.getElementById('view-list').classList.add('hidden');
  document.getElementById('view-game').classList.remove('hidden');
  document.getElementById('view-record').classList.add('hidden');
  socket.emit('join', boardId);
}

function showRecordView(recordId) {
  state.currentRecordId = recordId;
  state.recordAnalysis  = null;
  document.getElementById('view-list').classList.add('hidden');
  document.getElementById('view-game').classList.add('hidden');
  document.getElementById('view-record').classList.remove('hidden');
  socket.emit('join-record', recordId);
}

// ============================================================
// Board list
// ============================================================
async function loadBoards() {
  const [boardsRes, recordsRes] = await Promise.all([
    fetch('/api/boards'),
    fetch('/api/records'),
  ]);
  state.boards  = await boardsRes.json();
  state.records = await recordsRes.json();
  renderBoardList();
}

function renderBoardList() {
  const grid = document.getElementById('board-grid');
  const all  = [
    ...state.boards.map(b => ({ ...b, _type: 'board' })),
    ...state.records.map(r => ({ ...r, _type: 'record' })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (all.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">囲</div>
        <p>対局・棋譜がありません</p>
        <p class="empty-hint">「＋ 新しい対局」または「＋ 棋譜解析」で始めましょう</p>
      </div>`;
    return;
  }

  grid.innerHTML = '';
  for (const item of all) {
    grid.appendChild(item._type === 'record' ? makeRecordCard(item) : makeBoardCard(item));
  }
}

function makeBoardCard(board) {
  const card = document.createElement('div');
  card.className = 'board-card';

  const statusClass = `badge-${board.status}`;
  const handicapBadge = board.handicap > 0
    ? `<span class="badge">置き石 ${board.handicap}</span>`
    : '';

  card.innerHTML = `
    <div class="card-name">${esc(board.name)}</div>
    <div class="card-badges">
      <span class="badge">${board.size}×${board.size}</span>
      ${handicapBadge}
      <span class="badge ${statusClass}">${STATUS_LABELS[board.status] ?? board.status}</span>
    </div>
    <div class="card-footer">
      <span>${board.moveCount} 手</span>
      <span>${fmtDate(board.createdAt)}</span>
      <button class="btn-delete" title="削除">✕</button>
    </div>`;

  card.addEventListener('click', e => {
    if (e.target.classList.contains('btn-delete')) return;
    showGameView(board.id);
  });

  card.querySelector('.btn-delete').addEventListener('click', e => {
    e.stopPropagation();
    deleteBoard(board.id);
  });

  return card;
}

function makeRecordCard(record) {
  const card = document.createElement('div');
  card.className = 'board-card';
  const nodeCount = Object.keys(record.nodes ?? {}).length;
  card.innerHTML = `
    <div class="card-name">${esc(record.name)}</div>
    <div class="card-badges">
      <span class="badge">${record.size}×${record.size}</span>
      <span class="badge badge-record">棋譜</span>
    </div>
    <div class="card-footer">
      <span>${nodeCount - 1} 手</span>
      <span>${fmtDate(record.createdAt)}</span>
      <button class="btn-delete" title="削除">✕</button>
    </div>`;

  card.addEventListener('click', e => {
    if (e.target.classList.contains('btn-delete')) return;
    showRecordView(record.id);
  });
  card.querySelector('.btn-delete').addEventListener('click', e => {
    e.stopPropagation();
    deleteRecord(record.id);
  });
  return card;
}

async function deleteRecord(id) {
  if (!confirm('この棋譜を削除しますか？')) return;
  await fetch(`/api/records/${id}`, { method: 'DELETE' });
  loadBoards();
}

async function deleteBoard(id) {
  if (!confirm('この対局を削除しますか？')) return;
  await fetch(`/api/boards/${id}`, { method: 'DELETE' });
  loadBoards();
}

// ============================================================
// New board modal
// ============================================================
function openModal() {
  const n = state.boards.length + 1;
  document.getElementById('input-name').placeholder = `対局 ${n}`;
  document.getElementById('input-name').value = '';
  document.getElementById('input-handicap').value = '0';
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('input-name').focus();
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

function openRecordModal() {
  const n = state.records.length + 1;
  document.getElementById('rec-input-name-sgf').value    = '';
  document.getElementById('rec-input-name-sgf').placeholder = `棋譜 ${n}`;
  document.getElementById('rec-input-name-manual').value = '';
  document.getElementById('rec-input-name-manual').placeholder = `棋譜 ${n}`;
  document.getElementById('rec-input-sgf').value  = '';
  document.getElementById('rec-input-file').value = '';
  document.getElementById('rec-sgf-komi').value   = '6.5';
  document.getElementById('rec-sgf-pb').textContent = '—';
  document.getElementById('rec-sgf-pw').textContent = '—';
  document.getElementById('rec-input-komi').value = '6.5';
  // Show SGF tab by default
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-tab="tab-sgf"]').classList.add('active');
  document.getElementById('tab-sgf').classList.remove('hidden');
  document.getElementById('tab-manual').classList.add('hidden');
  document.getElementById('modal-record').classList.remove('hidden');
}

function closeRecordModal() {
  document.getElementById('modal-record').classList.add('hidden');
}

async function submitNewBoard(e) {
  e.preventDefault();
  const nameInput = document.getElementById('input-name');
  const name      = nameInput.value.trim() || nameInput.placeholder;
  const size      = document.getElementById('input-size').value;
  const handicap  = parseInt(document.getElementById('input-handicap').value) || 0;

  closeModal();
  document.getElementById('loading-overlay').classList.remove('hidden');

  try {
    const res   = await fetch('/api/boards', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, size, handicap }),
    });
    const board = await res.json();
    if (board.error) throw new Error(board.error);
    showGameView(board.id);
  } catch (err) {
    alert(`対局の作成に失敗しました: ${err.message}`);
  } finally {
    document.getElementById('loading-overlay').classList.add('hidden');
  }
}

// ============================================================
// Game view rendering
// ============================================================
function renderGame(board) {
  // Title
  document.getElementById('game-title').textContent = board.name;

  // Status
  const statusEl = document.getElementById('game-status');
  if (board.status === 'finished') {
    statusEl.textContent = board.result ?? '終局';
    statusEl.className   = 'game-status status-finished';
  } else if (board.status === 'error') {
    statusEl.textContent = `エラー: ${board.result ?? '不明'}`;
    statusEl.className   = 'game-status status-error';
  } else if (board.status === 'ai-thinking') {
    statusEl.textContent = '🤔 AI が思考中…';
    statusEl.className   = 'game-status status-thinking';
  } else if (board.status === 'analyzing') {
    statusEl.textContent = '🔍 分析中…';
    statusEl.className   = 'game-status status-analyzing';
  } else if (board.status === 'playing') {
    if (board.currentPlayer === 'black') {
      statusEl.textContent = 'あなたの番です（黒）';
      statusEl.className   = 'game-status status-your-turn';
    } else {
      statusEl.textContent = 'AI の番です（白）';
      statusEl.className   = 'game-status status-ai';
    }
  } else {
    statusEl.textContent = STATUS_LABELS[board.status] ?? board.status;
    statusEl.className   = 'game-status';
  }

  // Info
  document.getElementById('move-count').textContent =
    `第 ${board.moves.length} 手`;
  document.getElementById('komi-label').textContent =
    `コミ ${board.komi}  |  置き石 ${board.handicap}`;

  // Controls
  const canPlay     = (board.status === 'playing' || board.status === 'analyzing') && board.currentPlayer === 'black';
  const inGame      = board.status === 'playing' || board.status === 'ai-thinking'
                   || board.status === 'analyzing';
  const canAnalyze  = board.status === 'playing' && board.currentPlayer === 'black';
  const isAnalyzing = board.status === 'analyzing';
  const hasAnalysis = state.analysisData !== null && state.analysisData.length > 0;

  document.getElementById('btn-pass').disabled   = !canPlay;
  document.getElementById('btn-resign').disabled = !inGame;

  const btnAnalyze = document.getElementById('btn-analyze');
  btnAnalyze.hidden    = !(canAnalyze || isAnalyzing);
  btnAnalyze.textContent = isAnalyzing ? '分析停止' : '分析';
  btnAnalyze.classList.toggle('btn-analyze-active', isAnalyzing);

  // Analysis panel: 分析中 or 解析データがある間は表示し続ける
  const panel = document.getElementById('analysis-panel');
  panel.classList.toggle('hidden', !hasAnalysis && !isAnalyzing);
  if (hasAnalysis) updateAnalysisPanel(state.analysisData);

  // Move history
  renderMoveList(board.moves);

  // Board SVG: 解析データがある間は候補手を表示
  const container = document.getElementById('board-container');
  container.innerHTML = '';
  container.appendChild(buildBoardSvg(board, hasAnalysis ? state.analysisData : null));
}

function renderMoveList(moves) {
  const el = document.getElementById('move-list');
  el.innerHTML = '';
  for (let i = moves.length - 1; i >= 0; i--) {
    const m   = moves[i];
    const row = document.createElement('div');
    row.className = `move-item ${m.color}`;
    row.textContent =
      `${i + 1}. ${m.color === 'black' ? '黒' : '白'}: ${m.position}`;
    el.appendChild(row);
  }
}

// ============================================================
// SVG Board
// ============================================================
const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function buildBoardSvg(board, candidates = null) {
  const { size: N, stones, lastMove, status, currentPlayer } = board;
  const VB = N + 2; // viewBox: 1-unit margin on every side

  const svg = svgEl('svg', {
    viewBox:  `0 0 ${VB} ${VB}`,
    width:    '100%',
    height:   '100%',
  });

  // ---- Defs: gradients for stones ----
  const defs = svgEl('defs');

  const mkGrad = (id, light, dark) => {
    const g = svgEl('radialGradient', {
      id, cx: '35%', cy: '35%', r: '65%',
      gradientUnits: 'objectBoundingBox',
    });
    const s1 = svgEl('stop', { offset: '0%',   'stop-color': light });
    const s2 = svgEl('stop', { offset: '100%', 'stop-color': dark  });
    g.appendChild(s1); g.appendChild(s2);
    return g;
  };
  defs.appendChild(mkGrad('grad-black', '#888', '#111'));
  defs.appendChild(mkGrad('grad-white', '#fff', '#ccc'));
  svg.appendChild(defs);

  // ---- Board background ----
  svg.appendChild(svgEl('rect', {
    x: 0, y: 0, width: VB, height: VB, fill: '#DCA94E',
  }));

  // ---- Grid lines ----
  for (let i = 1; i <= N; i++) {
    svg.appendChild(svgEl('line', {
      x1: 1, y1: i, x2: N, y2: i,
      stroke: '#000', 'stroke-width': '0.035',
    }));
    svg.appendChild(svgEl('line', {
      x1: i, y1: 1, x2: i, y2: N,
      stroke: '#000', 'stroke-width': '0.035',
    }));
  }

  // ---- Coordinate labels ----
  const labelAttrs = {
    'text-anchor':        'middle',
    'dominant-baseline':  'middle',
    'font-size':          '0.48',
    fill:                 '#5a3e1b',
    'font-family':        'sans-serif',
  };
  for (let c = 0; c < N; c++) {
    for (const y of [0.55, N + 1.45]) {
      const t = svgEl('text', { ...labelAttrs, x: c + 1, y });
      t.textContent = GTP_COLS[c];
      svg.appendChild(t);
    }
  }
  for (let r = 1; r <= N; r++) {
    const y = N - r + 1;
    for (const x of [0.52, N + 1.48]) {
      const t = svgEl('text', { ...labelAttrs, x, y });
      t.textContent = r;
      svg.appendChild(t);
    }
  }

  // ---- Star points ----
  for (const [rv, cv] of (STAR_POINTS[N] ?? [])) {
    svg.appendChild(svgEl('circle', {
      cx: cv + 1, cy: rv + 1, r: '0.1', fill: '#000',
    }));
  }

  // ---- Stones ----
  for (const [pos, color] of Object.entries(stones)) {
    const xy = gtpToXY(pos, N);
    if (!xy) continue;

    svg.appendChild(svgEl('circle', {
      cx: xy.x, cy: xy.y, r: '0.46',
      fill:          `url(#grad-${color})`,
      stroke:        color === 'black' ? '#000' : '#aaa',
      'stroke-width': '0.03',
    }));

    // Last-move marker
    if (pos === lastMove) {
      svg.appendChild(svgEl('circle', {
        cx: xy.x, cy: xy.y, r: '0.14',
        fill:    color === 'black' ? '#e44' : '#e44',
        opacity: '0.9',
      }));
    }
  }

  // ---- Analysis candidate overlay ----
  if (candidates && candidates.length > 0) {
    const top = candidates
      .filter(c => c.move && c.move.toLowerCase() !== 'pass' && !stones[c.move])
      .sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0))
      .slice(0, 10);
    const maxVisits = top.length > 0 ? (top[0].visits ?? 1) : 1;
    const fontSize = N <= 9 ? '0.32' : N <= 13 ? '0.28' : '0.23';

    for (const c of top) {
      const xy = gtpToXY(c.move, N);
      if (!xy) continue;
      const ratio = (c.visits ?? 0) / maxVisits;
      const hue   = Math.round((c.winrate ?? 0.5) * 120);      // green=good, red=bad
      const alpha = (0.55 + ratio * 0.45).toFixed(2);

      // Filled circle: colour encodes winrate, opacity encodes relative visits
      svg.appendChild(svgEl('circle', {
        cx: xy.x, cy: xy.y, r: '0.44',
        fill: `hsla(${hue},80%,35%,${alpha})`,
        stroke: 'rgba(255,255,255,0.85)', 'stroke-width': '0.05',
      }));

      // Extra ring on the best move (order === 0)
      if (c.order === 0) {
        svg.appendChild(svgEl('circle', {
          cx: xy.x, cy: xy.y, r: '0.47',
          fill: 'none', stroke: 'white', 'stroke-width': '0.08',
        }));
      }

      // Win-rate percentage label
      const t = svgEl('text', {
        x: xy.x, y: xy.y,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': fontSize, 'font-weight': '700',
        fill: 'white', 'pointer-events': 'none', 'font-family': 'sans-serif',
      });
      t.textContent = `${Math.round((c.winrate ?? 0.5) * 100)}`;
      svg.appendChild(t);
    }
  }

  // ---- Click layer (only when it is the player's turn) ----
  if ((status === 'playing' || status === 'analyzing') && currentPlayer === 'black') {
    // Ghost stone (reused element, repositioned on hover)
    const ghost = svgEl('circle', {
      r: '0.44', fill: 'rgba(0,0,0,0.3)',
      'pointer-events': 'none', visibility: 'hidden',
    });
    svg.appendChild(ghost);

    // Transparent click targets at every empty intersection
    for (let rv = 0; rv < N; rv++) {
      for (let cv = 0; cv < N; cv++) {
        const x   = cv + 1;
        const y   = rv + 1;
        const pos = xyToGtp(x, y, N);
        if (stones[pos]) continue; // occupied

        const r = svgEl('rect', {
          x: x - 0.5, y: y - 0.5, width: '1', height: '1',
          fill: 'transparent', cursor: 'pointer',
          'data-pos': pos,
        });
        r.classList.add('hit');
        svg.appendChild(r);
      }
    }

    // Hover → show ghost stone
    svg.addEventListener('mousemove', e => {
      if (!e.target.classList.contains('hit')) {
        ghost.setAttribute('visibility', 'hidden');
        return;
      }
      const xy = gtpToXY(e.target.getAttribute('data-pos'), N);
      ghost.setAttribute('cx', xy.x);
      ghost.setAttribute('cy', xy.y);
      ghost.setAttribute('visibility', 'visible');
    });
    svg.addEventListener('mouseleave', () =>
      ghost.setAttribute('visibility', 'hidden')
    );

    // Click → optimistic update then send move
    svg.addEventListener('click', e => {
      if (!e.target.classList.contains('hit')) return;
      const pos = e.target.getAttribute('data-pos');

      state.analysisData = null; // 着手と同時に解析結果を消去

      // Immediately render the player's stone without waiting for the server.
      renderGame({
        ...board,
        stones:        { ...board.stones, [pos]: 'black' },
        lastMove:      pos,
        currentPlayer: 'white',
        status:        'ai-thinking',
      });

      socket.emit('move', { boardId: state.currentBoardId, position: pos });
    });
  }

  return svg;
}

// ============================================================
// Record view rendering
// ============================================================

function renderRecord(record) {
  state.currentRecord = record;
  const { nodes, rootId, currentNodeId, size, komi, name, status, playerBlack, playerWhite } = record;

  document.getElementById('rec-title').textContent = name;

  // Player names
  const playersEl = document.getElementById('rec-players');
  if (playerBlack || playerWhite) {
    playersEl.innerHTML =
      `<span>● ${esc(playerBlack || '不明')}</span>` +
      `<span>○ ${esc(playerWhite || '不明')}</span>`;
    playersEl.style.display = '';
  } else {
    playersEl.style.display = 'none';
  }

  // Komi label (only update when not editing)
  if (document.getElementById('rec-komi-edit').classList.contains('hidden')) {
    document.getElementById('rec-komi-label').textContent = `コミ ${komi}  |  ${size}×${size}`;
  }

  const moveNum = getMoveNumber(nodes, currentNodeId);
  document.getElementById('rec-move-info').textContent = `第 ${moveNum} 手`;

  // Status badge
  const statusEl = document.getElementById('rec-status');
  if (status === 'initializing') {
    statusEl.textContent = 'KataGo 起動中…';
    statusEl.className   = 'game-status status-thinking';
  } else if (status === 'analyzing') {
    statusEl.textContent = '分析中…';
    statusEl.className   = 'game-status status-analyzing';
  } else if (status === 'error') {
    statusEl.textContent = 'エラー';
    statusEl.className   = 'game-status status-error';
  } else {
    statusEl.textContent = '';
    statusEl.className   = 'game-status';
  }

  // Nav buttons
  const node    = nodes[currentNodeId];
  const parent  = node?.parentId;
  const hasPrev = parent != null;
  const hasNext = (node?.children?.length ?? 0) > 0;
  document.getElementById('btn-rec-first').disabled = !hasPrev;
  document.getElementById('btn-rec-prev').disabled  = !hasPrev;
  document.getElementById('btn-rec-next').disabled  = !hasNext;
  document.getElementById('btn-rec-last').disabled  = !hasNext;

  // Analyze button
  const btnAna = document.getElementById('btn-rec-analyze');
  const isAnalyzing = status === 'analyzing';
  btnAna.textContent = isAnalyzing ? '分析停止' : '分析';
  btnAna.classList.toggle('btn-analyze-active', isAnalyzing);
  btnAna.disabled = status === 'initializing';

  // Analysis panel
  const panel = document.getElementById('rec-analysis-panel');
  const hasAna = state.recordAnalysis && state.recordAnalysis.length > 0;
  panel.classList.toggle('hidden', !hasAna && !isAnalyzing);
  if (hasAna) updateRecordAnalysisPanel(state.recordAnalysis);

  // Board
  const stones   = computeStones(nodes, rootId, currentNodeId, size);
  const lastNode = nodes[currentNodeId];
  const lastMove = lastNode?.move?.pos && lastNode.move.pos !== 'pass' ? lastNode.move.pos : null;
  const nextColor = getNextColor(nodes, currentNodeId);

  const container = document.getElementById('rec-board-container');
  container.innerHTML = '';
  container.appendChild(buildRecordBoardSvg(record, stones, lastMove, nextColor,
    hasAna ? state.recordAnalysis : null));

  renderMoveTree(record);
}

function updateRecordAnalysisPanel(candidates) {
  if (!candidates || candidates.length === 0) return;
  const best = candidates.find(c => c.order === 0) ?? candidates[0];
  const bwr  = (best.winrate ?? 0.5) * 100;
  const wwr  = 100 - bwr;
  document.getElementById('rec-wr-black').style.width = `${bwr.toFixed(1)}%`;
  document.getElementById('rec-wr-white').style.width = `${wwr.toFixed(1)}%`;
  document.getElementById('rec-wr-text').textContent  = `黒 ${bwr.toFixed(1)}% / 白 ${wwr.toFixed(1)}%`;
  const sm = best.scoreMean;
  document.getElementById('rec-score-text').textContent =
    sm != null && !isNaN(sm)
      ? `スコア: ${sm >= 0 ? '黒' : '白'} +${Math.abs(sm).toFixed(1)}`
      : '';
}

function buildRecordBoardSvg(record, stones, lastMove, nextColor, candidates = null) {
  const { size: N, currentNodeId } = record;
  const VB = N + 2;

  const svg = svgEl('svg', { viewBox: `0 0 ${VB} ${VB}`, width: '100%', height: '100%' });
  const defs = svgEl('defs');
  const mkGrad = (id, light, dark) => {
    const g = svgEl('radialGradient', { id, cx: '35%', cy: '35%', r: '65%', gradientUnits: 'objectBoundingBox' });
    g.appendChild(svgEl('stop', { offset: '0%',   'stop-color': light }));
    g.appendChild(svgEl('stop', { offset: '100%', 'stop-color': dark  }));
    return g;
  };
  defs.appendChild(mkGrad('rec-grad-black', '#888', '#111'));
  defs.appendChild(mkGrad('rec-grad-white', '#fff', '#ccc'));
  svg.appendChild(defs);

  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: VB, height: VB, fill: '#DCA94E' }));

  for (let i = 1; i <= N; i++) {
    svg.appendChild(svgEl('line', { x1: 1, y1: i, x2: N, y2: i, stroke: '#000', 'stroke-width': '0.035' }));
    svg.appendChild(svgEl('line', { x1: i, y1: 1, x2: i, y2: N, stroke: '#000', 'stroke-width': '0.035' }));
  }

  const labelAttrs = { 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': '0.48', fill: '#5a3e1b', 'font-family': 'sans-serif' };
  for (let c = 0; c < N; c++) {
    for (const y of [0.55, N + 1.45]) {
      const t = svgEl('text', { ...labelAttrs, x: c + 1, y });
      t.textContent = GTP_COLS[c];
      svg.appendChild(t);
    }
  }
  for (let r = 1; r <= N; r++) {
    const y = N - r + 1;
    for (const x of [0.52, N + 1.48]) {
      const t = svgEl('text', { ...labelAttrs, x, y });
      t.textContent = r;
      svg.appendChild(t);
    }
  }

  for (const [rv, cv] of (STAR_POINTS[N] ?? [])) {
    svg.appendChild(svgEl('circle', { cx: cv + 1, cy: rv + 1, r: '0.1', fill: '#000' }));
  }

  for (const [pos, color] of Object.entries(stones)) {
    const xy = gtpToXY(pos, N);
    if (!xy) continue;
    svg.appendChild(svgEl('circle', { cx: xy.x, cy: xy.y, r: '0.46', fill: `url(#rec-grad-${color})`, stroke: color === 'black' ? '#000' : '#aaa', 'stroke-width': '0.03' }));
    if (pos === lastMove) {
      svg.appendChild(svgEl('circle', { cx: xy.x, cy: xy.y, r: '0.14', fill: '#e44', opacity: '0.9' }));
    }
  }

  // Candidates overlay
  if (candidates && candidates.length > 0) {
    const top = candidates
      .filter(c => c.move && c.move.toLowerCase() !== 'pass' && !stones[c.move])
      .sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0))
      .slice(0, 10);
    const maxVisits = top.length > 0 ? (top[0].visits ?? 1) : 1;
    const fontSize  = N <= 9 ? '0.32' : N <= 13 ? '0.28' : '0.23';
    for (const c of top) {
      const xy = gtpToXY(c.move, N);
      if (!xy) continue;
      const ratio = (c.visits ?? 0) / maxVisits;
      const hue   = Math.round((c.winrate ?? 0.5) * 120);
      const alpha = (0.55 + ratio * 0.45).toFixed(2);
      svg.appendChild(svgEl('circle', { cx: xy.x, cy: xy.y, r: '0.44', fill: `hsla(${hue},80%,35%,${alpha})`, stroke: 'rgba(255,255,255,0.85)', 'stroke-width': '0.05' }));
      if (c.order === 0) {
        svg.appendChild(svgEl('circle', { cx: xy.x, cy: xy.y, r: '0.47', fill: 'none', stroke: 'white', 'stroke-width': '0.08' }));
      }
      const t = svgEl('text', { x: xy.x, y: xy.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': fontSize, 'font-weight': '700', fill: 'white', 'pointer-events': 'none', 'font-family': 'sans-serif' });
      t.textContent = `${Math.round((c.winrate ?? 0.5) * 100)}`;
      svg.appendChild(t);
    }
  }

  // Click layer: clicking places a stone
  const ghost = svgEl('circle', { r: '0.44', fill: nextColor === 'black' ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.4)', 'pointer-events': 'none', visibility: 'hidden' });
  svg.appendChild(ghost);

  for (let rv = 0; rv < N; rv++) {
    for (let cv = 0; cv < N; cv++) {
      const x   = cv + 1;
      const y   = rv + 1;
      const pos = xyToGtp(x, y, N);
      if (stones[pos]) continue;
      const r = svgEl('rect', { x: x - 0.5, y: y - 0.5, width: '1', height: '1', fill: 'transparent', cursor: 'pointer', 'data-pos': pos });
      r.classList.add('hit');
      svg.appendChild(r);
    }
  }

  svg.addEventListener('mousemove', e => {
    if (!e.target.classList.contains('hit')) { ghost.setAttribute('visibility', 'hidden'); return; }
    const xy = gtpToXY(e.target.getAttribute('data-pos'), N);
    ghost.setAttribute('cx', xy.x);
    ghost.setAttribute('cy', xy.y);
    ghost.setAttribute('visibility', 'visible');
  });
  svg.addEventListener('mouseleave', () => ghost.setAttribute('visibility', 'hidden'));

  svg.addEventListener('click', e => {
    if (!e.target.classList.contains('hit')) return;
    const pos = e.target.getAttribute('data-pos');
    state.recordAnalysis = null;
    socket.emit('record-add-move', { recordId: state.currentRecordId, color: nextColor, pos });
  });

  return svg;
}

function renderMoveTree(record) {
  const { nodes, rootId, currentNodeId } = record;
  const el = document.getElementById('rec-move-tree');
  el.innerHTML = '';

  // Show path from root to current node
  const path = getPath(nodes, currentNodeId);
  for (let i = 1; i < path.length; i++) {
    const nodeId = path[i];
    const node   = nodes[nodeId];
    if (!node || !node.move) continue;
    const parentNode = nodes[node.parentId];
    const totalSibs  = parentNode?.children?.length ?? 1;
    const sibIdx      = parentNode ? parentNode.children.indexOf(nodeId) : 0;

    const item = document.createElement('div');
    item.className = 'move-item' + (nodeId === currentNodeId ? ' current' : '');
    item.dataset.nodeId = nodeId;

    const color  = node.move.color === 'black' ? '黒' : '白';
    const prefix = totalSibs > 1 ? `[分岐 ${sibIdx + 1}/${totalSibs}] ` : '';
    item.textContent = `${i}. ${color}: ${node.move.pos} ${prefix}`;
    item.addEventListener('click', () => {
      socket.emit('record-navigate', { recordId: state.currentRecordId, nodeId });
    });
    el.appendChild(item);
  }

  // Show children of current node (branches)
  const curNode = nodes[currentNodeId];
  if (curNode && curNode.children.length > 0) {
    const hdr = document.createElement('div');
    hdr.className = 'tree-branch-header';
    hdr.textContent = '次の手:';
    el.appendChild(hdr);

    const moveNum = getMoveNumber(nodes, currentNodeId);
    for (const childId of curNode.children) {
      const child = nodes[childId];
      if (!child || !child.move) continue;
      const item = document.createElement('div');
      item.className = 'move-item branch-option';
      item.dataset.nodeId = childId;
      const color = child.move.color === 'black' ? '黒' : '白';
      item.textContent = `  ${moveNum + 1}. ${color}: ${child.move.pos}`;
      item.addEventListener('click', () => {
        socket.emit('record-navigate', { recordId: state.currentRecordId, nodeId: childId });
      });
      el.appendChild(item);
    }
  }

  // Scroll current item into view
  const curEl = el.querySelector('.current');
  if (curEl) curEl.scrollIntoView({ block: 'nearest' });
}

// ============================================================
// Socket.IO listeners
// ============================================================
socket.on('board', board => {
  if (board.id !== state.currentBoardId) return;
  // 着手（手数が増えた）タイミングで解析結果を消す。停止だけなら残す。
  const prevLen = state.currentBoard?.moves?.length ?? -1;
  if (board.moves.length > prevLen) state.analysisData = null;
  state.currentBoard = board;
  renderGame(board);
});

// Streaming analysis update: re-render board SVG + panel (fast path)
socket.on('analysis', candidates => {
  if (!state.currentBoard || candidates.length === 0) return;
  console.log('[analysis] received', candidates.length, 'candidates, board status:', state.currentBoard.status);
  state.analysisData = candidates;

  document.getElementById('analysis-panel').classList.remove('hidden');

  const container = document.getElementById('board-container');
  container.innerHTML = '';
  container.appendChild(buildBoardSvg(state.currentBoard, candidates));

  updateAnalysisPanel(candidates);
});

socket.on('err', msg => {
  showToast(msg, 'error');
});

socket.on('connect', () => {
  if (state.currentBoardId)  socket.emit('join', state.currentBoardId);
  if (state.currentRecordId) socket.emit('join-record', state.currentRecordId);
});

socket.on('record', record => {
  if (record.id !== state.currentRecordId) return;
  state.currentRecord = record;
  renderRecord(record);
});

socket.on('record-analysis', candidates => {
  if (!state.currentRecord || candidates.length === 0) return;
  state.recordAnalysis = candidates;
  document.getElementById('rec-analysis-panel').classList.remove('hidden');
  updateRecordAnalysisPanel(candidates);
  // Re-render board with candidates
  const { nodes, rootId, currentNodeId, size } = state.currentRecord;
  const stones    = computeStones(nodes, rootId, currentNodeId, size);
  const lastNode  = nodes[currentNodeId];
  const lastMove  = lastNode?.move?.pos && lastNode.move.pos !== 'pass' ? lastNode.move.pos : null;
  const nextColor = getNextColor(nodes, currentNodeId);
  const container = document.getElementById('rec-board-container');
  container.innerHTML = '';
  container.appendChild(buildRecordBoardSvg(state.currentRecord, stones, lastMove, nextColor, candidates));
});

// ============================================================
// Toast notification
// ============================================================
function showToast(msg, type = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent  = msg;
  t.className    = `toast toast-${type} visible`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), 3000);
}

// ============================================================
// Analysis panel
// ============================================================
function updateAnalysisPanel(candidates) {
  if (!candidates || candidates.length === 0) return;
  // Use the best move (order=0) for the win-rate display
  const best = candidates.find(c => c.order === 0) ?? candidates[0];
  const bwr  = (best.winrate ?? 0.5) * 100;
  const wwr  = 100 - bwr;

  document.getElementById('wr-black').style.width = `${bwr.toFixed(1)}%`;
  document.getElementById('wr-white').style.width = `${wwr.toFixed(1)}%`;
  document.getElementById('wr-text').textContent  =
    `黒 ${bwr.toFixed(1)}% / 白 ${wwr.toFixed(1)}%`;

  const sm = best.scoreMean;
  if (sm != null && !isNaN(sm)) {
    const side = sm >= 0 ? '黒' : '白';
    document.getElementById('score-text').textContent =
      `スコア: ${side} +${Math.abs(sm).toFixed(1)}`;
  } else {
    document.getElementById('score-text').textContent = '';
  }
}

// ============================================================
// Bootstrap
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // List view
  document.getElementById('btn-new-board').addEventListener('click', openModal);
  document.getElementById('btn-new-record').addEventListener('click', openRecordModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
  document.getElementById('form-new-board').addEventListener('submit', submitNewBoard);
  document.getElementById('modal').addEventListener('click', e => {
    if (e.target === document.getElementById('modal')) closeModal();
  });
  document.getElementById('modal-record').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-record')) closeRecordModal();
  });

  // Tab switching in record modal
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      document.getElementById(btn.dataset.tab).classList.remove('hidden');
    });
  });

  // SGF file reader
  document.getElementById('rec-input-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result;
      document.getElementById('rec-input-sgf').value = text;
      updateSgfMetaDisplay(text);
    };
    reader.readAsText(file);
  });

  // SGF textarea: auto-update meta on input
  document.getElementById('rec-input-sgf').addEventListener('input', e => {
    updateSgfMetaDisplay(e.target.value);
  });

  // SGF form submit
  document.getElementById('form-new-record-sgf').addEventListener('submit', async e => {
    e.preventDefault();
    const nameInput = document.getElementById('rec-input-name-sgf');
    const name = nameInput.value.trim() || nameInput.placeholder;
    const sgf  = document.getElementById('rec-input-sgf').value.trim();
    const komi = document.getElementById('rec-sgf-komi').value;
    if (!sgf) { showToast('SGF テキストを入力してください', 'error'); return; }
    closeRecordModal();
    try {
      const res    = await fetch('/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sgf, komi }),
      });
      const record = await res.json();
      if (record.error) throw new Error(record.error);
      showRecordView(record.id);
    } catch (err) {
      showToast(`棋譜の作成に失敗しました: ${err.message}`, 'error');
    }
  });

  // Manual form submit
  document.getElementById('form-new-record-manual').addEventListener('submit', async e => {
    e.preventDefault();
    const nameInput = document.getElementById('rec-input-name-manual');
    const name = nameInput.value.trim() || nameInput.placeholder;
    const size = document.getElementById('rec-input-size').value;
    const komi = document.getElementById('rec-input-komi').value;
    closeRecordModal();
    try {
      const res    = await fetch('/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, size, komi }),
      });
      const record = await res.json();
      if (record.error) throw new Error(record.error);
      showRecordView(record.id);
    } catch (err) {
      showToast(`棋譜の作成に失敗しました: ${err.message}`, 'error');
    }
  });

  document.getElementById('btn-cancel-record-sgf').addEventListener('click', closeRecordModal);
  document.getElementById('btn-cancel-record-manual').addEventListener('click', closeRecordModal);

  // Game view
  document.getElementById('btn-back').addEventListener('click', showListView);
  document.getElementById('btn-pass').addEventListener('click', () => {
    if (state.currentBoardId) {
      state.analysisData = null;
      socket.emit('pass', state.currentBoardId);
    }
  });
  document.getElementById('btn-resign').addEventListener('click', () => {
    if (state.currentBoardId && confirm('投了しますか？')) {
      socket.emit('resign', state.currentBoardId);
    }
  });
  document.getElementById('btn-analyze').addEventListener('click', () => {
    if (!state.currentBoardId) return;
    const isAnalyzing = state.currentBoard?.status === 'analyzing';
    socket.emit(isAnalyzing ? 'stop-analysis' : 'start-analysis', state.currentBoardId);
  });

  // Record view – komi inline edit
  async function saveRecordKomi() {
    const val = parseFloat(document.getElementById('rec-komi-input').value);
    if (isNaN(val)) return;
    await fetch(`/api/records/${state.currentRecordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ komi: val }),
    });
    document.getElementById('rec-komi-row').classList.remove('hidden');
    document.getElementById('rec-komi-edit').classList.add('hidden');
  }

  document.getElementById('btn-rec-edit-komi').addEventListener('click', () => {
    if (!state.currentRecord) return;
    document.getElementById('rec-komi-input').value = state.currentRecord.komi;
    document.getElementById('rec-komi-row').classList.add('hidden');
    document.getElementById('rec-komi-edit').classList.remove('hidden');
    document.getElementById('rec-komi-input').focus();
  });
  document.getElementById('btn-rec-komi-save').addEventListener('click', saveRecordKomi);
  document.getElementById('btn-rec-komi-cancel').addEventListener('click', () => {
    document.getElementById('rec-komi-row').classList.remove('hidden');
    document.getElementById('rec-komi-edit').classList.add('hidden');
  });
  document.getElementById('rec-komi-input').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); saveRecordKomi(); }
    if (e.key === 'Escape') document.getElementById('btn-rec-komi-cancel').click();
  });

  // Record view navigation
  document.getElementById('btn-rec-back').addEventListener('click', showListView);

  document.getElementById('btn-rec-first').addEventListener('click', () => {
    if (!state.currentRecord) return;
    socket.emit('record-navigate', { recordId: state.currentRecordId, nodeId: state.currentRecord.rootId });
  });

  document.getElementById('btn-rec-prev').addEventListener('click', () => {
    if (!state.currentRecord) return;
    const node = state.currentRecord.nodes[state.currentRecord.currentNodeId];
    if (node?.parentId) {
      state.recordAnalysis = null;
      socket.emit('record-navigate', { recordId: state.currentRecordId, nodeId: node.parentId });
    }
  });

  document.getElementById('btn-rec-next').addEventListener('click', () => {
    if (!state.currentRecord) return;
    const child = getFirstChild(state.currentRecord.nodes, state.currentRecord.currentNodeId);
    if (child) {
      state.recordAnalysis = null;
      socket.emit('record-navigate', { recordId: state.currentRecordId, nodeId: child });
    }
  });

  document.getElementById('btn-rec-last').addEventListener('click', () => {
    if (!state.currentRecord) return;
    const last = getLastDescendant(state.currentRecord.nodes, state.currentRecord.currentNodeId);
    if (last !== state.currentRecord.currentNodeId) {
      state.recordAnalysis = null;
      socket.emit('record-navigate', { recordId: state.currentRecordId, nodeId: last });
    }
  });

  document.getElementById('btn-rec-pass').addEventListener('click', () => {
    if (!state.currentRecord) return;
    const nextColor = getNextColor(state.currentRecord.nodes, state.currentRecord.currentNodeId);
    state.recordAnalysis = null;
    socket.emit('record-add-move', { recordId: state.currentRecordId, color: nextColor, pos: 'pass' });
  });

  document.getElementById('btn-rec-analyze').addEventListener('click', () => {
    if (!state.currentRecordId) return;
    const isAnalyzing = state.currentRecord?.status === 'analyzing';
    if (isAnalyzing) {
      socket.emit('record-stop-analysis', state.currentRecordId);
    } else {
      state.recordAnalysis = null;
      socket.emit('record-start-analysis', state.currentRecordId);
    }
  });

  loadBoards();
});
