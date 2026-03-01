const { spawn } = require('child_process');

/**
 * GTP (Go Text Protocol) client for KataGo.
 *
 * Normal commands are queued and executed serially.
 * Every command – including kata-analyze and the stop command – is assigned
 * a unique integer ID so that responses can be matched unambiguously.
 *
 *   Request:  "<id> <cmd>\n"
 *   Success:  "= <id> <result>\n\n"
 *   Failure:  "? <id> <message>\n\n"
 *
 * Analysis mode (kata-analyze):
 *   After sending "<analysisCmdId> kata-analyze <interval>", KataGo:
 *     1. Sends "= <analysisCmdId>\n\n" as acknowledgement.
 *     2. Streams "info move ..." lines, terminated by blank lines, indefinitely.
 *   To stop, we send the next normal GTP command ("<stopCmdId> name").
 *   KataGo finishes the current batch, then replies "= <stopCmdId> KataGo\n\n".
 *   We identify that reply by its ID to know analysis has ended.
 */
class GTPClient {
  constructor(katagoPath, configPath, modelPath) {
    this.katagoPath = katagoPath;
    this.configPath = configPath;
    this.modelPath  = modelPath;
    this.proc    = null;
    this.cmdId   = 0;
    this.queue   = [];   // waiting commands: {id, cmd, resolve, reject}
    this.current = null; // command currently awaiting a response
    this.buffer  = '';

    // Analysis state
    this.isAnalyzing    = false;
    this._analysisCmdId = null;  // ID of the kata-analyze command
    this._analysisBuf   = [];    // lines accumulated for the current batch
    this._onAnalysis    = null;  // callback(lines[])
    this._stopCmdId     = null;  // ID of the command sent to stop analysis
    this._stopResolve   = null;  // resolve() when stop response arrives
  }

  /** Spawn KataGo and wait for it to initialise (load model, etc.). */
  start() {
    return new Promise((resolve, reject) => {
      const args = ['gtp', '-config', this.configPath, '-model', this.modelPath];
      console.log(`[GTP] start: ${this.katagoPath} ${args.join(' ')}`);

      this.proc = spawn(this.katagoPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      this.proc.stdout.on('data', chunk => {
        this.buffer += chunk.toString();
        this._flush();
      });

      this.proc.stderr.on('data', chunk => {
        process.stderr.write(`[katago] ${chunk}`);
      });

      this.proc.on('error', err => {
        reject(err);
        this._rejectAll(err);
      });

      this.proc.on('close', code => {
        const err = new Error(`KataGo process exited (code ${code})`);
        this._rejectAll(err);
      });

      // Allow time for KataGo to load the neural network model.
      setTimeout(resolve, 2000);
    });
  }

  // ---- response parsing ----

  _flush() {
    this.isAnalyzing ? this._flushAnalysis() : this._flushNormal();
  }

  /** Normal mode: look for \n\n-terminated GTP response blocks. */
  _flushNormal() {
    let i;
    while ((i = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, i).trim();
      this.buffer  = this.buffer.slice(i + 2);
      if (block) this._handleBlock(block);
    }
  }

  /**
   * Analysis mode: process line-by-line.
   *
   * "info ..." lines accumulate into a batch.
   * A blank line flushes the batch to the callback.
   *
   * GTP response lines (= or ?) carry a command ID:
   *   = <analysisCmdId> → acknowledgement that kata-analyze started; keep going.
   *   = <stopCmdId>     → our stop command was processed; exit analysis mode.
   */
  _flushAnalysis() {
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line  = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);

      if (line.startsWith('info ')) {
        this._analysisBuf.push(line);
      } else if (line === '') {
        if (this._analysisBuf.length > 0) {
          const batch = [...this._analysisBuf];
          this._analysisBuf = [];
          console.log(`[GTP] analysis batch: ${batch.length} moves, callback=${this._onAnalysis != null}`);
          if (this._onAnalysis) this._onAnalysis(batch);
        }
      } else if (line.startsWith('=') || line.startsWith('?')) {
        const m   = line.match(/^[=?]\s*(\d+)/);
        const rid = m ? parseInt(m[1], 10) : null;
        console.log(`[GTP] gtp response: "${line.slice(0, 60)}" rid=${rid} analysisCmdId=${this._analysisCmdId} stopCmdId=${this._stopCmdId}`);

        if (rid === this._analysisCmdId) {
          // kata-analyze acknowledgement – stream is now running; nothing to do.
        } else if (this._stopCmdId !== null && rid === this._stopCmdId) {
          // Our stop command was acknowledged → analysis has ended.
          this._exitAnalysis();
          break;
        }
      }
    }

    // Resume normal queue processing once analysis has ended.
    if (!this.isAnalyzing) this._processQueue();
  }

  /** Clean up all analysis state and resolve the stopAnalysis() promise. */
  _exitAnalysis() {
    this.isAnalyzing    = false;
    this._analysisBuf   = [];
    this._onAnalysis    = null;
    this._analysisCmdId = null;
    this._stopCmdId     = null;
    const r = this._stopResolve;
    this._stopResolve   = null;
    if (r) r();
  }

  _handleBlock(block) {
    if (!this.current) {
      // Unsolicited output (e.g. startup messages) – ignore.
      return;
    }
    const { resolve, reject } = this.current;
    this.current = null;

    if (block[0] === '=') {
      resolve(block.replace(/^=\d*\s*/, '').trim());
    } else if (block[0] === '?') {
      reject(new Error(block.replace(/^\?\d*\s*/, '').trim() || 'GTP error'));
    } else {
      reject(new Error(`Unexpected GTP response: ${block}`));
    }
    this._processQueue();
  }

  _processQueue() {
    // Do not send queued commands while analysis is active.
    if (this.current || this.queue.length === 0 || this.isAnalyzing) return;
    this.current = this.queue.shift();
    this.proc.stdin.write(`${this.current.id} ${this.current.cmd}\n`);
  }

  _rejectAll(err) {
    if (this.current) { this.current.reject(err); this.current = null; }
    for (const c of this.queue) c.reject(err);
    this.queue = [];
  }

  // ---- public API: normal commands ----

  send(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.proc) { reject(new Error('GTP process not started')); return; }
      const id = this.cmdId++;
      this.queue.push({ id, cmd, resolve, reject });
      this._processQueue();
    });
  }

  async initGame(size, handicap, komi) {
    await this.send(`boardsize ${size}`);
    await this.send('clear_board');
    if (handicap >= 2) {
      await this.send(`fixed_handicap ${handicap}`);
      await this.send(`komi ${komi ?? 0.5}`);
    } else {
      await this.send(`komi ${komi ?? 6.5}`);
    }
  }

  play(color, pos)   { return this.send(`play ${color} ${pos}`); }
  async genMove(color) {
    const r = await this.send(`genmove ${color}`);
    return r.trim(); // "pass", "resign", or "A1" etc.
  }
  showBoard()        { return this.send('showboard'); }

  // ---- public API: analysis ----

  /**
   * Start kata-analyze streaming.
   * @param {number}   intervalCentis  Report interval in centiseconds (e.g. 200 = 2 s).
   * @param {function} callback        Called with an array of raw "info ..." line strings
   *                                   each time a batch completes.
   */
  startAnalysis(intervalCentis, callback) {
    if (this.isAnalyzing || !this.proc) return;
    const id = this.cmdId++;
    this.isAnalyzing    = true;
    this._analysisCmdId = id;
    this._analysisBuf   = [];
    this._onAnalysis    = callback;
    this._stopCmdId     = null;
    this._stopResolve   = null;
    // Write directly to stdin – bypasses the serial queue (which must be idle here).
    this.proc.stdin.write(`${id} kata-analyze ${intervalCentis}\n`);
  }

  /**
   * Stop kata-analyze by sending a new GTP command with a fresh ID.
   * KataGo will finish its current batch, then reply to this command.
   * Resolves when that reply arrives (analysis has fully ended).
   */
  stopAnalysis() {
    if (!this.isAnalyzing) return Promise.resolve();
    return new Promise(resolve => {
      // _onAnalysis はここでは null にしない。
      // KataGo が stop コマンドを処理する前に届いたバッチも表示させるため。
      // _onAnalysis の無効化は _exitAnalysis() で行う。
      this._stopResolve = resolve;
      const id = this.cmdId++;
      this._stopCmdId = id;
      this.proc.stdin.write(`${id} name\n`);
    });
  }

  async quit() {
    if (!this.proc) return;
    if (this.isAnalyzing) await this.stopAnalysis().catch(() => {});
    try {
      await Promise.race([this.send('quit'), new Promise(r => setTimeout(r, 800))]);
    } catch (_) {}
    this.proc.kill();
    this.proc = null;
  }
}

module.exports = GTPClient;
