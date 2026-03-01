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
// App state
// ============================================================
const state = {
  boards:         [],
  currentBoardId: null,
  currentBoard:   null,   // latest board object from server
  analysisData:   null,   // latest analysis candidates
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
// Navigation
// ============================================================
function showListView() {
  state.currentBoardId = null;
  document.getElementById('view-list').classList.remove('hidden');
  document.getElementById('view-game').classList.add('hidden');
  loadBoards();
}

function showGameView(boardId) {
  state.currentBoardId = boardId;
  document.getElementById('view-list').classList.add('hidden');
  document.getElementById('view-game').classList.remove('hidden');
  // Ask server to join the room; server responds with current board state.
  socket.emit('join', boardId);
}

// ============================================================
// Board list
// ============================================================
async function loadBoards() {
  const res    = await fetch('/api/boards');
  state.boards = await res.json();
  renderBoardList();
}

function renderBoardList() {
  const grid = document.getElementById('board-grid');

  if (state.boards.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">囲</div>
        <p>対局がありません</p>
        <p class="empty-hint">「＋ 新しい対局」ボタンで始めましょう</p>
      </div>`;
    return;
  }

  grid.innerHTML = '';
  // Show newest first
  [...state.boards].reverse().forEach(b => grid.appendChild(makeBoardCard(b)));
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
  if (state.currentBoardId) socket.emit('join', state.currentBoardId);
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
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
  document.getElementById('form-new-board').addEventListener('submit', submitNewBoard);
  document.getElementById('modal').addEventListener('click', e => {
    if (e.target === document.getElementById('modal')) closeModal();
  });

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

  loadBoards();
});
