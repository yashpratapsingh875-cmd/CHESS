// ============================================================
// board.js  (ported from board.py)
// ============================================================
// Tkinter Canvas + Frame widgets are rewritten as an HTML <canvas>
// plus DOM side panel. The position math, flip transform, click
// state machine, and turn logic all port directly - only the
// drawing/widget calls are rewritten.

import {
    createPieces,
    resetBoard,
    drawPieces,
    getPiece,
    getAvailableMoves,
    selectPiece,
    getSelectedMove,
    updatePiecePosition,
    checkWinner,
    getAlivePlayers,
    eliminatePlayer,
    applyNetworkMove,
    getAllPieces,
    getStandardArmy,
    getPlayerRegionCells,
    placeCustomPieces,
    drawGhostPiece,
    serializeState,
    loadState,
} from "./pieces.js";

const LIGHT = "#DDD6E1";
const DARK = "#9A784F";
const MARGIN = 30;

// Below this, the side panel drops under the board instead of
// beside it (see the matching @media rule in style.css) and the
// margin around the board shrinks so small phones don't lose most
// of their screen to whitespace.
const MOBILE_BREAKPOINT_PX = 700;

const CHAT_MAX_LENGTH = 300;
const CHAT_HISTORY_LIMIT = 200;

// ============================================================
// GAME MODE CONFIGURATION
// ============================================================

export const GAME_MODE = {
    Classic: { rows: 8, cols: 8, players: 2 },
    "12 x 12": { rows: 12, cols: 12, players: 2 },
    "4 Player": { rows: 14, cols: 14, players: 4 },
    "6 Player": { rows: 16, cols: 16, players: 6 },
    Custom: { rows: 16, cols: 16, players: 2 },
    // Placeholder only - whoever joins via this mode gets their
    // actual board/pieces overwritten by the survivor's sync_state
    // moments later (see GameNetwork._checkMatchReady in menu.js).
    // Scoped to 2-player/8x8 matches: if the real resumed match used
    // different dimensions, this initial board is wrong until synced
    // and briefly mismatched right after.
    "Unfinished Match": { rows: 8, cols: 8, players: 2 },
};

// Display color NAME per player (distinct from pieces.js's
// PLAYER_COLORS, which are hex fill colors for the glyphs).
const PLAYER_COLOR_NAMES = {
    1: "White",
    2: "Black",
    3: "Red",
    4: "Blue",
    5: "Green",
    6: "Yellow",
};

// How long a disconnected opponent has to reconnect mid-match
// before the remaining local player is awarded the win.
export const DISCONNECT_GRACE_SECONDS = 120;

// Modes that start with an empty board and a placement phase,
// instead of a fixed layout from loadGame(). Currently just
// 6-player - every other mode already has a working fixed layout.
const PLACEMENT_MODES = new Set(["6 Player"]);

// How long each player gets to arrange their own army.
const PLACEMENT_SECONDS = 120;

export class Board {
    constructor(root, mode, startCallback = null, options = {}) {
        try {
            this.root = root; // container element the board mounts into
            this.mode = mode;
            this.startCallback = startCallback;

            // When true, loadGame() leaves pieces.js's board state
            // exactly as-is instead of calling createPieces() - used
            // when a 6-player custom Placement phase (see
            // placement.js) has already populated it.
            this.skipPieceSetup = Boolean(options.skipPieceSetup);

            this.hoveredSquare = null;
            this.hoverMoves = [];
            this.selectedMoves = [];

            this.MARGIN = MARGIN;
            this.LIGHT = LIGHT;
            this.DARK = DARK;

            const config = GAME_MODE[mode];

            this.rows = config.rows;
            this.cols = config.cols;
            this.players = config.players;
            this.boardSize = 0;
            this.square = 0;

            this.offsetX = 0;
            this.offsetY = 0;

            this.currentPlayer = 1;
            this.playerLabels = {};
            this.network = null;
            this.networkMove = false;
            this.selectedSource = null;
            this.gameOver = false;

            // Which player number THIS device controls.
            // null = offline/hotseat, no device-level restriction
            // (everyone shares one screen and takes turns manually).
            this.myPlayerIndex = null;

            // Whether to render the board upside-down (both rank
            // and file mirrored) so THIS device's own pieces sit
            // nearer the bottom of the screen, matching the usual
            // "your army faces you" chess convention. Computed once
            // in setLocalPlayer(), once we know which player this
            // device actually is. Stays false for offline/hotseat
            // play, where players share one screen.
            this.flipBoard = false;

            // {playerIndex: playerName} from the online room
            // roster, if any. Empty in offline/hotseat mode, in
            // which case the side panel just shows "Player N".
            this.playerNames = {};

            // Mid-match disconnect grace-period timers, keyed by
            // remoteId. See startDisconnectTimer() below.
            this.disconnectTimers = {};
            this.disconnectBannerFrame = null;

            this._resizeObserver = null;
            this._onWindowResize = null;

            // ------------------------------------------------
            // PLACEMENT PHASE STATE
            // ------------------------------------------------
            // See startPlacementPhase() and the methods below it for
            // the full flow. Inert (usesPlacement === false) for
            // every mode except 6-player.
            this.usesPlacement = PLACEMENT_MODES.has(mode);
            this.placementPhase = false;
            this.placementOnline = false;
            this.placementStatus = {};
            this.placementActivePlayer = null;
            this.placementCells = [];
            this.placementTray = [];
            this.placementPlaced = {};
            this.placementArmedType = null;
            this.placementSecondsLeft = 0;
            this.placementTimerId = null;

            this.thinkingMs = {};
            for (let p = 1; p <= this.players; p++) this.thinkingMs[p] = 0;
            this._clockPlayer = this.currentPlayer;
            this._clockLast = Date.now();
            this._clockIntervalId = null;

            this.chatEnabled = false;
            this.chatThreads = { all: [] };
            this.chatUnread = {};
            this.chatTab = "all";
            this.chatDrafts = {};
            this.chatExpanded = false;

            this.createUI();
            this.loadGame();
            this.drawBoard();
            this._startClock();
        } catch (e) {
            alert(`Board Error\n\nAn unexpected error occurred while loading the board.\n\n${e}`);
        }
    }

    // ========================================================
    // NETWORKING HOOK
    // ========================================================

    setNetwork(network) {
        // Attach the GameNetwork object to this board.
        // The board remains usable without networking.
        this.network = network;
        console.log("[Board] Networking attached.");

        // Chat is available in every online mode. In 2-player games
        // there's only ever one other person to talk to, so the tag
        // bar (All/P1/P2...) and the alliance button - both aimed at
        // choosing between several opponents - are suppressed; see
        // the chatIs1v1 checks in _enableChat()/_renderChatTabs().
        this._enableChat();
    }

    // ========================================================
    // LOCAL PLAYER IDENTITY
    // ========================================================

    setLocalPlayer(playerIndex) {
        // Record which player number THIS device controls.
        //
        // This is what lets clickBoard() detect, locally, whether
        // it is this device's turn before allowing a move - so the
        // device whose turn it is is the only one that can generate
        // and broadcast a move for that turn.
        //
        // Also decides the board's on-screen orientation: if this
        // player's own pieces start in the top half of the board,
        // the board is flipped (180 degrees) so they render at the
        // bottom instead - the standard "your own army faces you"
        // convention.
        this.myPlayerIndex = playerIndex;

        if (this.chatEnabled) this._renderChatTabs();

        console.log(`[Board] Local player set to: ${playerIndex}`);

        this.flipBoard = this._shouldFlipFor(playerIndex);

        // Re-render immediately so the new orientation takes
        // effect, if the board has already been drawn once.
        if (this.square) {
            this.drawBoard();
        }
    }

    _shouldFlipFor(playerIndex) {
        // True if `playerIndex`'s own pieces start, on average, in
        // the TOP half of the board - meaning the board should be
        // flipped so they end up at the bottom instead.
        if (playerIndex === null || playerIndex === undefined) return false;

        const myPieces = getAllPieces().filter((piece) => piece.player === playerIndex);

        if (myPieces.length === 0) return false;

        const averageRow = myPieces.reduce((sum, piece) => sum + piece.row, 0) / myPieces.length;

        return averageRow < this.rows / 2;
    }

    // ========================================================
    // PERSPECTIVE TRANSFORM
    // ========================================================
    // Both methods are their own inverse (a 180-degree rotation
    // applied twice returns the original value), so the same pair
    // is used both when DRAWING (logical -> screen) and when
    // reading a click back (screen -> logical).

    _screenRow(row) {
        if (this.flipBoard) return this.rows - 1 - row;
        return row;
    }

    _screenCol(col) {
        if (this.flipBoard) return this.cols - 1 - col;
        return col;
    }

    setPlayerNames(names) {
        // Attach a {playerIndex: playerName} mapping, e.g. from
        // the online room roster, so the side panel can show real
        // names instead of just "Player N". Safe to call before or
        // after createUI() - it just refreshes the labels.
        this.playerNames = { ...(names || {}) };

        if (this.chatEnabled) this._renderChatTabs();

        if (this.playerLabels && Object.keys(this.playerLabels).length) {
            this.updatePlayerHighlight();
        }
    }

    _formatPlayerLabel(player) {
        // Build this player's side-panel line, e.g.
        // "PLAYER 2 - paadu - Black" online, or
        // "PLAYER 2 - Black" offline/unnamed.
        const color = PLAYER_COLOR_NAMES[player] ?? `Player ${player}`;
        const name = this.playerNames[player];

        if (name) {
            return `PLAYER ${player} - ${name} - ${color}`;
        }

        return `PLAYER ${player} - ${color}`;
    }

    // ========================================================
    // DISCONNECT GRACE PERIOD
    // ========================================================
    // If a connected opponent's WebRTC link drops mid-match, show
    // a countdown banner. If they don't reconnect before it hits
    // zero, this device's local player is awarded the win via the
    // same showWinner() popup used for a normal win.
    //
    // FUTURE FEATURE (not built yet, just leaving the hook here):
    // mid-match re-entry - letting a disconnected player actually
    // rejoin and resume the game instead of only ever cancelling
    // the timer. cancelDisconnectTimer() below is the natural
    // place that would plug into, since it already runs exactly
    // when a peer reconnects in time.

    startDisconnectTimer(remoteId, playerName = null, playerIndex = null) {
        // Start a grace-period countdown for a remote player whose
        // connection was just lost. Safe to call more than once for
        // the same remoteId - only the first call starts a timer.
        if (this.disconnectTimers[remoteId]) return;

        if (this.disconnectBannerFrame === null) {
            this.disconnectBannerFrame = document.createElement("div");
            this.disconnectBannerFrame.className = "disconnect-banner-frame";
            this.canvasWrap.appendChild(this.disconnectBannerFrame);
        }

        const label = document.createElement("div");
        label.className = "disconnect-label";
        this.disconnectBannerFrame.appendChild(label);

        const displayName =
            playerName || (playerIndex !== null ? `Player ${playerIndex}` : "Opponent");

        this.disconnectTimers[remoteId] = {
            secondsLeft: DISCONNECT_GRACE_SECONDS,
            label,
            timeoutId: null,
            displayName,
        };

        this._tickDisconnectTimer(remoteId);
    }

    _tickDisconnectTimer(remoteId) {
        const timerState = this.disconnectTimers[remoteId];

        if (timerState === undefined) {
            // Already cancelled (e.g. reconnected) - stop ticking.
            return;
        }

        const secondsLeft = timerState.secondsLeft;

        if (secondsLeft <= 0) {
            this._disconnectTimerExpired(remoteId);
            return;
        }

        const minutes = Math.floor(secondsLeft / 60);
        const seconds = secondsLeft % 60;

        timerState.label.textContent =
            `\u26a0 ${timerState.displayName} disconnected - ` +
            `you win in ${minutes}:${String(seconds).padStart(2, "0")} ` +
            `if they don't reconnect`;

        timerState.secondsLeft = secondsLeft - 1;

        timerState.timeoutId = setTimeout(() => this._tickDisconnectTimer(remoteId), 1000);
    }

    _disconnectTimerExpired(remoteId) {
        const timerState = this.disconnectTimers[remoteId];
        delete this.disconnectTimers[remoteId];

        if (timerState === undefined) return;

        timerState.label.remove();

        this._cleanupDisconnectBannerIfEmpty();

        const winner = this.myPlayerIndex !== null ? this.myPlayerIndex : this.currentPlayer;

        this.showWinner(winner, `${timerState.displayName} disconnected and did not reconnect in time.`);
    }

    cancelDisconnectTimer(remoteId) {
        // Cancel a running grace-period countdown for remoteId,
        // e.g. because that player reconnected before time ran out.
        const timerState = this.disconnectTimers[remoteId];
        delete this.disconnectTimers[remoteId];

        if (timerState === undefined) return;

        if (timerState.timeoutId !== null) {
            clearTimeout(timerState.timeoutId);
        }

        timerState.label.remove();

        this._cleanupDisconnectBannerIfEmpty();
    }

    _cleanupDisconnectBannerIfEmpty() {
        if (Object.keys(this.disconnectTimers).length === 0 && this.disconnectBannerFrame !== null) {
            this.disconnectBannerFrame.remove();
            this.disconnectBannerFrame = null;
        }
    }

    // ========================================================
    // ELIMINATE DISCONNECTED PLAYER (4/6 player matches - no
    // reconnect grace period there, see GameNetwork in menu.js)
    // ========================================================

    eliminateRemotePlayer(playerIndex, displayName = null) {
        if (this.gameOver) return;
        if (!Number.isInteger(playerIndex)) return;

        const label = displayName || `Player ${playerIndex}`;

        eliminatePlayer(playerIndex);

        this._showEliminationNotice(`${label} disconnected and was eliminated.`);

        this.drawBoard();
        this.updatePlayerHighlight();

        const winner = checkWinner();

        if (winner !== null) {
            this.showWinner(winner);
            return;
        }

        // If it was the eliminated player's turn, nobody can act on
        // it anymore - hand the turn to the next surviving player.
        // Otherwise leave the current turn alone.
        if (this.currentPlayer === playerIndex) {
            this.nextTurn();
        }
    }

    _showEliminationNotice(message) {
        // Reuses the same banner styling as the disconnect-timer
        // countdown, but as a brief, non-interactive toast instead -
        // there's nothing to count down since the elimination is
        // already final.
        if (this.disconnectBannerFrame === null) {
            this.disconnectBannerFrame = document.createElement("div");
            this.disconnectBannerFrame.className = "disconnect-banner-frame";
            this.container.appendChild(this.disconnectBannerFrame);
        }

        const label = document.createElement("div");
        label.className = "disconnect-label";
        label.textContent = `\u2620 ${message}`;
        this.disconnectBannerFrame.appendChild(label);

        setTimeout(() => {
            label.remove();
            this._cleanupDisconnectBannerIfEmpty();
        }, 4000);
    }

    // ========================================================
    // HANDLE NETWORK MOVE
    // ========================================================

    handleNetworkMove(remoteId, data) {
        // Apply a move received from another player.
        const fromPos = data.from;
        const toPos = data.to;

        const [moved, captured] = applyNetworkMove(fromPos, toPos, this.rows, this.cols);

        if (!moved) {
            console.log(`[Board] Rejected network move from ${remoteId}: ${fromPos} -> ${toPos}`);
            return;
        }

        console.log(`[Board] Remote move applied: ${fromPos} -> ${toPos}`);

        this.networkMove = true;

        this.selectedMoves = [];
        this.drawBoard();

        if (captured) {
            const winner = checkWinner();

            if (winner !== null) {
                this.showWinner(winner);
            }
        }

        this.networkMove = false;
    }

    // ========================================================
    // HANDLE NETWORK TURN
    // ========================================================

    handleNetworkTurn(playerIndex) {
        // Apply a TURN message received from another player.
        const parsed = Number(playerIndex);

        if (!Number.isInteger(parsed)) return;
        if (!(parsed >= 1 && parsed <= this.players)) return;

        this.currentPlayer = parsed;
        this.updatePlayerHighlight();

        console.log(`[Board] Remote turn -> Player ${this.currentPlayer}`);
    }

    // ========================================================
    // STATE SNAPSHOT (mid-match reconnection)
    // ========================================================

    getStateSnapshot() {
        // 2-player scope only (see the file-level reconnect note in
        // menu.js): the one index that isn't this survivor's own is
        // whichever slot the returning/joining side should take
        // over as. Needed by a third-party joiner (no prior
        // identity of their own), and harmless/redundant for the
        // original disconnected player reconnecting.
        const forPlayerIndex = this.players === 2 ? (this.myPlayerIndex === 1 ? 2 : 1) : null;

        this._accrueClock();

        return {
            ...serializeState(),
            currentPlayer: this.currentPlayer,
            forPlayerIndex,
            thinkingMs: { ...this.thinkingMs },
        };
    }

    applyStateSync(data) {
        loadState({ pieces: data.pieces });

        this.currentPlayer = Number(data.currentPlayer) || this.currentPlayer;
        this.selectedSource = null;
        this.selectedMoves = [];
        this.hoveredSquare = null;
        this.hoverMoves = [];
        this.gameOver = false;

        if (data.thinkingMs && typeof data.thinkingMs === "object") {
            for (const p of Object.keys(this.thinkingMs)) {
                const v = Number(data.thinkingMs[p]);
                if (Number.isFinite(v)) this.thinkingMs[p] = v;
            }
        }

        this._clockLast = Date.now();
        this._clockPlayer = this.currentPlayer;

        this.updatePlayerHighlight();
        this.drawBoard();

        console.log("[Board] State synced after reconnect.");
    }

    // ========================================================
    // PLACEMENT PHASE
    // ========================================================
    // 6-player mode only (see PLACEMENT_MODES). Each player gets
    // PLACEMENT_SECONDS to arrange a fixed 16-piece army within
    // their own corner region (see pieces.js's getPlayerRegionCells
    // / getStandardArmy). Online, every player does this
    // simultaneously on their own device, in their own region only,
    // and broadcasts the finished arrangement once confirmed (or
    // once their timer runs out). Offline/hotseat has no network to
    // broadcast over, so it's sequential instead: the same UI, one
    // local player's turn at a time, on the same screen.

    startPlacementPhase() {
        if (!this.usesPlacement) return;
        if (this.placementPhase) return; // already running

        this.placementPhase = true;
        this.placementOnline = this.network !== null;

        this.placementStatus = {};
        for (let player = 1; player <= this.players; player++) {
            this.placementStatus[player] = "pending";
        }

        // Online: this device only ever places for its own player
        // number. Offline/hotseat: start with Player 1, advancing
        // through each player's turn in _finalizeLocalPlacement().
        const startingPlayer = this.placementOnline ? this.myPlayerIndex : 1;

        this._beginLocalPlacementTurn(startingPlayer);
    }

    _beginLocalPlacementTurn(player) {
        this.placementActivePlayer = player;
        this.placementCells = getPlayerRegionCells(player, this.rows, this.cols);
        this.placementTray = getStandardArmy();
        this.placementPlaced = {};
        this.placementArmedType = null;
        this.placementStatus[player] = "placing";

        this._renderPlacementPanel();
        this.drawBoard();

        this._startPlacementTimer();
    }

    _startPlacementTimer() {
        if (this.placementTimerId !== null) {
            clearInterval(this.placementTimerId);
        }

        this.placementSecondsLeft = PLACEMENT_SECONDS;
        this._updatePlacementTimerLabel();

        this.placementTimerId = setInterval(() => {
            this.placementSecondsLeft -= 1;

            if (this.placementSecondsLeft <= 0) {
                clearInterval(this.placementTimerId);
                this.placementTimerId = null;
                this._updatePlacementTimerLabel();
                this._finalizeLocalPlacement();
                return;
            }

            this._updatePlacementTimerLabel();
        }, 1000);
    }

    _updatePlacementTimerLabel() {
        if (!this.placementTimerLabel) return;

        const seconds = Math.max(0, this.placementSecondsLeft);
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;

        this.placementTimerLabel.textContent = `${minutes}:${String(remainder).padStart(2, "0")}`;
    }

    // --------------------------------------------------------
    // BOARD CLICKS DURING PLACEMENT
    // --------------------------------------------------------

    _handlePlacementClick(event) {
        // Only this device's own active player can ever be placing
        // here - online, that's always myPlayerIndex; offline, it's
        // whichever local player's turn it currently is.
        const pos = this.getCursorSquare(event);

        if (pos === null) return;

        const [row, col] = pos;
        const cellKey = `${row},${col}`;

        const inRegion = this.placementCells.some(([r, c]) => r === row && c === col);

        if (!inRegion) return;

        // Clicking an already-placed cell picks that piece back up
        // into the tray, regardless of whether something else is
        // currently armed.
        if (this.placementPlaced[cellKey]) {
            const removedType = this.placementPlaced[cellKey];
            delete this.placementPlaced[cellKey];
            this.placementTray.push(removedType);

            this._renderPlacementTray();
            this.drawBoard();
            return;
        }

        if (!this.placementArmedType) return;

        const trayIndex = this.placementTray.indexOf(this.placementArmedType);

        if (trayIndex === -1) {
            this.placementArmedType = null;
            return;
        }

        this.placementTray.splice(trayIndex, 1);
        this.placementPlaced[cellKey] = this.placementArmedType;

        // Auto-clear the armed selection once its last copy is used,
        // so the tray never shows a now-impossible selection.
        if (!this.placementTray.includes(this.placementArmedType)) {
            this.placementArmedType = null;
        }

        this._renderPlacementTray();
        this.drawBoard();
    }

    // --------------------------------------------------------
    // FINALIZE / CONFIRM
    // --------------------------------------------------------

    _finalizeLocalPlacement() {
        if (!this.placementPhase) return;

        if (this.placementTimerId !== null) {
            clearInterval(this.placementTimerId);
            this.placementTimerId = null;
        }

        // Auto-fill: whatever is still in the tray when time runs
        // out (or Confirm is clicked early) fills the remaining
        // empty cells in tray order, so every player always ends up
        // with a full army on the board.
        const emptyCells = this.placementCells.filter(([r, c]) => !this.placementPlaced[`${r},${c}`]);

        for (const [r, c] of emptyCells) {
            if (this.placementTray.length === 0) break;
            this.placementPlaced[`${r},${c}`] = this.placementTray.shift();
        }

        const player = this.placementActivePlayer;

        const placements = Object.entries(this.placementPlaced).map(([key, pieceType]) => {
            const [r, c] = key.split(",").map(Number);
            return { type: pieceType, row: r, col: c };
        });

        if (!placeCustomPieces(player, placements)) {
            // Invalid arrangement (e.g. both bishops on the same
            // color square) - don't advance with an empty army for
            // this player. Restart the timer and let them fix it.
            alert(
                "Invalid placement\n\nYour two bishops must be on opposite-colored squares. " +
                    "Adjust and confirm again.",
            );
            this._startPlacementTimer();
            return;
        }

        this.placementStatus[player] = "ready";

        if (this.placementOnline) {
            if (this.network !== null) {
                try {
                    this.network.sendPlacement(player, placements);
                } catch (error) {
                    console.log(`[Board] Error sending placement: ${error}`);
                }
            }

            this._renderPlacementPanel();
            this.drawBoard();
            this._checkPlacementComplete();
            return;
        }

        // Offline/hotseat: hand off to the next local player, or
        // finish if that was the last one.
        const nextPlayer = player + 1;

        if (nextPlayer <= this.players) {
            this._beginLocalPlacementTurn(nextPlayer);
        } else {
            this._endPlacementPhase();
        }
    }

    // --------------------------------------------------------
    // INCOMING NETWORK PLACEMENT
    // --------------------------------------------------------

    handleNetworkPlacement(remoteId, data) {
        if (!this.placementPhase) return;

        const player = Number(data.player);

        if (!Number.isInteger(player)) return;
        if (this.placementStatus[player] === "ready") return; // already applied

        if (!placeCustomPieces(player, data.pieces)) {
            console.log(`[Board] Rejected invalid placement from player ${player}.`);
            return;
        }

        this.placementStatus[player] = "ready";

        console.log(`[Board] Player ${player} finished placing pieces.`);

        this._renderPlacementPanel();
        this.drawBoard();
        this._checkPlacementComplete();
    }

    _checkPlacementComplete() {
        const allReady = Object.values(this.placementStatus).every((status) => status === "ready");

        if (allReady) {
            this._endPlacementPhase();
        }
    }

    _endPlacementPhase() {
        this.placementPhase = false;

        if (this.placementTimerId !== null) {
            clearInterval(this.placementTimerId);
            this.placementTimerId = null;
        }

        this.currentPlayer = 1;

        // setLocalPlayer() computed flipBoard back when the board
        // was still empty (placement hadn't happened yet), so it
        // always came out false. Now that this player's pieces
        // actually exist, recompute it so their army still ends up
        // oriented toward the bottom of their own screen, same as
        // every other mode.
        if (this.myPlayerIndex !== null) {
            this.flipBoard = this._shouldFlipFor(this.myPlayerIndex);
        }

        this._buildNormalSidePanel();
        this.updatePlayerHighlight();
        this.drawBoard();
    }

    // --------------------------------------------------------
    // PLACEMENT SIDE PANEL
    // --------------------------------------------------------

    _renderPlacementPanel() {
        this.sidePanel.className = "side-panel placement-mode";
        this.sidePanel.innerHTML = "";

        const title = document.createElement("div");
        title.className = "mode-title placement-title";
        title.textContent = "Place Your Pieces";
        this.sidePanel.appendChild(title);

        this.placementTimerLabel = document.createElement("div");
        this.placementTimerLabel.className = "placement-timer";
        this.sidePanel.appendChild(this.placementTimerLabel);
        this._updatePlacementTimerLabel();

        // --------------------------------------------------
        // SCROLLABLE PLAYER STATUS LIST
        // --------------------------------------------------
        const statusHeading = document.createElement("div");
        statusHeading.className = "players-heading";
        statusHeading.textContent = "Players";
        this.sidePanel.appendChild(statusHeading);

        this.placementStatusFrame = document.createElement("div");
        this.placementStatusFrame.className = "placement-status-list";
        this.sidePanel.appendChild(this.placementStatusFrame);
        this._renderPlacementStatusList();

        // --------------------------------------------------
        // TRAY
        // --------------------------------------------------
        const trayHeading = document.createElement("div");
        trayHeading.className = "players-heading";
        trayHeading.textContent = "Your Pieces";
        this.sidePanel.appendChild(trayHeading);

        this.placementTrayFrame = document.createElement("div");
        this.placementTrayFrame.className = "placement-tray";
        this.sidePanel.appendChild(this.placementTrayFrame);
        this._renderPlacementTray();

        // --------------------------------------------------
        // CONFIRM / CLEAR
        // --------------------------------------------------
        const confirmButton = document.createElement("button");
        confirmButton.className = "menu-button placement-confirm-button";
        confirmButton.textContent = "Confirm";
        confirmButton.addEventListener("click", () => this._finalizeLocalPlacement());
        this.sidePanel.appendChild(confirmButton);

        const clearButton = document.createElement("button");
        clearButton.className = "menu-button placement-clear-button";
        clearButton.textContent = "Clear";
        clearButton.addEventListener("click", () => {
            for (const pieceType of Object.values(this.placementPlaced)) {
                this.placementTray.push(pieceType);
            }
            this.placementPlaced = {};
            this.placementArmedType = null;
            this._renderPlacementTray();
            this.drawBoard();
        });
        this.sidePanel.appendChild(clearButton);

        const backButton = document.createElement("button");
        backButton.className = "menu-button back-button";
        backButton.textContent = "Back";
        backButton.addEventListener("click", () => this.back());
        this.sidePanel.appendChild(backButton);
    }

    _renderPlacementStatusList() {
        if (!this.placementStatusFrame) return;

        this.placementStatusFrame.innerHTML = "";

        const STATUS_ICON = { pending: "\u2013", placing: "\u23f3", ready: "\u2705" };

        for (let player = 1; player <= this.players; player++) {
            const row = document.createElement("div");
            row.className = "player-label placement-status-row";

            if (player === this.placementActivePlayer && this.placementStatus[player] === "placing") {
                row.classList.add("active");
            }

            const name = this.playerNames[player] || `Player ${player}`;
            const icon = STATUS_ICON[this.placementStatus[player]] || STATUS_ICON.pending;

            row.textContent = `${icon} ${name}`;
            this.placementStatusFrame.appendChild(row);
        }
    }

    _renderPlacementTray() {
        if (!this.placementTrayFrame) return;

        this.placementTrayFrame.innerHTML = "";

        // Group remaining tray pieces by type, with counts, rather
        // than one button per individual piece.
        const counts = {};
        for (const pieceType of this.placementTray) {
            counts[pieceType] = (counts[pieceType] || 0) + 1;
        }

        const typeOrder = ["king", "queen", "rook", "bishop", "knight", "soldier"];

        for (const pieceType of typeOrder) {
            const count = counts[pieceType];
            if (!count) continue;

            const item = document.createElement("button");
            item.className = "placement-tray-item";
            if (this.placementArmedType === pieceType) {
                item.classList.add("armed");
            }
            item.textContent = `${pieceType} \u00d7${count}`;
            item.addEventListener("click", () => {
                this.placementArmedType = this.placementArmedType === pieceType ? null : pieceType;
                this._renderPlacementTray();
            });

            this.placementTrayFrame.appendChild(item);
        }

        if (this.placementTray.length === 0) {
            const doneNote = document.createElement("div");
            doneNote.className = "placement-tray-empty";
            doneNote.textContent = "All pieces placed.";
            this.placementTrayFrame.appendChild(doneNote);
        }
    }

    // --------------------------------------------------------
    // PLACEMENT CANVAS RENDERING
    // --------------------------------------------------------

    _drawPlacementRegions(ctx) {
        for (let player = 1; player <= this.players; player++) {
            const cells = getPlayerRegionCells(player, this.rows, this.cols);

            if (!cells.length) continue;

            const rowsInRegion = cells.map(([r]) => r);
            const colsInRegion = cells.map(([, c]) => c);

            const minRow = Math.min(...rowsInRegion);
            const maxRow = Math.max(...rowsInRegion);
            const minCol = Math.min(...colsInRegion);
            const maxCol = Math.max(...colsInRegion);

            const screenRowA = this._screenRow(minRow);
            const screenRowB = this._screenRow(maxRow);
            const screenColA = this._screenCol(minCol);
            const screenColB = this._screenCol(maxCol);

            const screenMinRow = Math.min(screenRowA, screenRowB);
            const screenMinCol = Math.min(screenColA, screenColB);

            const x1 = this.offsetX + screenMinCol * this.square;
            const y1 = this.offsetY + screenMinRow * this.square;
            const regionWidth = (Math.abs(screenColA - screenColB) + 1) * this.square;
            const regionHeight = (Math.abs(screenRowA - screenRowB) + 1) * this.square;

            const isActive = player === this.placementActivePlayer;

            ctx.save();

            if (isActive) {
                ctx.fillStyle = "rgba(255, 215, 0, 0.10)";
                ctx.fillRect(x1, y1, regionWidth, regionHeight);
                ctx.lineWidth = 4;
                ctx.strokeStyle = "#FFD700";
            } else {
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
            }

            ctx.strokeRect(x1 + 1, y1 + 1, regionWidth - 2, regionHeight - 2);
            ctx.restore();
        }
    }

    _drawPlacementGhosts(ctx) {
        for (const [key, pieceType] of Object.entries(this.placementPlaced)) {
            const [row, col] = key.split(",").map(Number);

            drawGhostPiece(
                ctx,
                pieceType,
                this.placementActivePlayer,
                row,
                col,
                this.boardSize,
                this.rows,
                this.cols,
                this.offsetX,
                this.offsetY,
                this.flipBoard,
            );
        }
    }

    // ========================================================
    // UI
    // ========================================================

    createUI() {
        this.container = document.createElement("div");
        this.container.className = "board-container";

        // ====================================================
        // CANVAS
        // ====================================================
        this.canvasWrap = document.createElement("div");
        this.canvasWrap.className = "board-canvas-wrap";

        this.canvas = document.createElement("canvas");
        this.canvasWrap.appendChild(this.canvas);
        this.container.appendChild(this.canvasWrap);

        // ====================================================
        // SIDE PANEL
        // ====================================================
        this.sidePanel = document.createElement("div");
        this.sidePanel.className = "side-panel";
        this.container.appendChild(this.sidePanel);

        // A placement-phase mode starts with the side panel empty -
        // startPlacementPhase() (called separately, once the Board
        // knows its network/local-player identity) fills it in with
        // the placement UI instead of the normal player list. Every
        // other mode gets its normal side panel right away.
        if (!this.usesPlacement) {
            this._buildNormalSidePanel();
        }

        this.root.appendChild(this.container);

        // ====================================================
        // CANVAS EVENTS
        // ====================================================
        this.canvas.addEventListener("mousemove", (event) => this.onMouseMove(event));
        this.canvas.addEventListener("mouseleave", () => this._clearHover());
        this.canvas.addEventListener("click", (event) => this.clickBoard(event));

        // Touch devices don't fire mousemove (no hover), and the
        // click that a browser synthesizes after a tap arrives too
        // late/unreliably for this - handle taps directly instead.
        // preventDefault() on touchend stops that synthetic click
        // from also firing, so clickBoard() only runs once per tap.
        this.canvas.addEventListener(
            "touchend",
            (event) => {
                event.preventDefault();
                const touch = event.changedTouches[0];
                if (touch) this.clickBoard(touch);
            },
            { passive: false },
        );

        this._resizeObserver = new ResizeObserver(() => this.drawBoard());
        this._resizeObserver.observe(this.canvasWrap);

        // Fallback for browsers/situations where ResizeObserver
        // doesn't fire promptly enough - notably mobile browsers
        // resizing the visual viewport when the address bar
        // shows/hides, or a device rotating. A short delay lets
        // the new dimensions actually settle first.
        this._onWindowResize = () => {
            this.drawBoard();
            setTimeout(() => this.drawBoard(), 250);
        };

        window.addEventListener("resize", this._onWindowResize);
        window.addEventListener("orientationchange", this._onWindowResize);
    }

    // ========================================================
    // NORMAL (NON-PLACEMENT) SIDE PANEL
    // ========================================================
    // Split out from createUI() so it can also be rebuilt once a
    // placement phase finishes (see _endPlacementPhase()).

    _buildNormalSidePanel() {
        this.sidePanel.className = "side-panel";
        this.sidePanel.innerHTML = "";

        // ====================================================
        // GAME MODE TITLE
        // ====================================================
        const modeTitle = document.createElement("div");
        modeTitle.className = "mode-title";
        modeTitle.textContent = this.mode;
        this.sidePanel.appendChild(modeTitle);

        // ====================================================
        // PLAYER LIST
        // ====================================================
        this.playerListFrame = document.createElement("div");
        this.playerListFrame.className = "player-list-frame";
        this.sidePanel.appendChild(this.playerListFrame);

        const playersHeading = document.createElement("div");
        playersHeading.className = "players-heading";
        playersHeading.textContent = "Players";
        this.playerListFrame.appendChild(playersHeading);

        // Create every player's label
        this.playerLabels = {};

        for (let player = 1; player <= this.players; player++) {
            const label = document.createElement("div");
            label.className = "player-label";
            const nameSpan = document.createElement("span");
            nameSpan.className = "player-name";
            const timeSpan = document.createElement("span");
            timeSpan.className = "player-time";
            for (const cls of ["pl-num-long", "pl-num-short", "pl-sep1", "pl-nm", "pl-sep2", "pl-col"]) {
                const part = document.createElement("span");
                part.className = cls;
                nameSpan.appendChild(part);
            }
            label.append(nameSpan, timeSpan);
            this.playerListFrame.appendChild(label);
            this.playerLabels[player] = label;
            this._renderLabel(label, player);
        }

        this.updatePlayerHighlight();

        // ====================================================
        // BACK BUTTON
        // ====================================================
        const backButton = document.createElement("button");
        backButton.className = "menu-button back-button";
        backButton.textContent = "Back";
        backButton.addEventListener("click", () => this.back());
        this.sidePanel.appendChild(backButton);
    }

    // ========================================================
    // GAME INITIALIZATION
    // ========================================================

    loadGame() {
        this.boardSize = 0;
        this.square = 0;

        this.offsetX = 0;
        this.offsetY = 0;

        // Placement-phase modes start with an empty board - pieces
        // are added one player at a time as each confirms their own
        // arrangement (see startPlacementPhase()).
        if (!this.usesPlacement) {
            createPieces(this.rows, this.cols, this.players);
        } else {
            resetBoard();
        }
    }

    // ========================================================
    // BOARD RENDERING
    // ========================================================

    drawBoard() {
        const width = this.canvasWrap.clientWidth;
        const height = this.canvasWrap.clientHeight;

        // Match the CSS pixel size, accounting for device pixel
        // ratio so the board stays crisp on high-DPI screens.
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.max(1, Math.floor(width * dpr));
        this.canvas.height = Math.max(1, Math.floor(height * dpr));
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;

        const ctx = this.canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        // Leave room around board. On small screens the fixed 30px
        // margin ate a disproportionate share of the board - scale
        // it down with the smaller of the two dimensions instead.
        const margin = Math.min(this.MARGIN, Math.floor(Math.min(width, height) * 0.04));

        const availableWidth = width - 2 * margin;
        const availableHeight = height - 2 * margin;

        // Prevent negative/zero size
        if (availableWidth <= 0 || availableHeight <= 0) {
            return;
        }

        // ----------------------------------------------------
        // BOARD SIZE
        // ----------------------------------------------------
        this.boardSize = Math.min(availableWidth, availableHeight);

        // ----------------------------------------------------
        // SQUARE SIZE
        // ----------------------------------------------------
        this.square = this.boardSize / this.rows;

        // ----------------------------------------------------
        // CENTER BOARD
        // ----------------------------------------------------
        this.offsetX = (width - this.boardSize) / 2;
        this.offsetY = (height - this.boardSize) / 2;

        // ----------------------------------------------------
        // DRAW SQUARES
        // ----------------------------------------------------
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                const screenRow = this._screenRow(row);
                const screenCol = this._screenCol(col);

                const x1 = this.offsetX + screenCol * this.square;
                const y1 = this.offsetY + screenRow * this.square;

                const color = (row + col) % 2 === 0 ? this.LIGHT : this.DARK;

                ctx.fillStyle = color;
                ctx.fillRect(x1, y1, this.square, this.square);
            }
        }

        // Draw pieces after board
        this.renderPieces(ctx);

        // ----------------------------------------------------
        // PLACEMENT PHASE OVERLAY
        // ----------------------------------------------------
        if (this.placementPhase) {
            this._drawPlacementRegions(ctx);
            this._drawPlacementGhosts(ctx);
            return;
        }

        // ----------------------------------------------------
        // OVERLAYS (hover + selected-move indicators)
        // ----------------------------------------------------
        if (this.hoveredSquare !== null) {
            this._drawHoverSquare(ctx);
            this._drawMoveDots(ctx, this.hoverMoves);
        }

        if (this.selectedMoves.length) {
            this._drawMoveDots(ctx, this.selectedMoves);
        }
    }

    // ========================================================
    // PIECE RENDERING
    // ========================================================

    getCursorSquare(event) {
        if (this.boardSize <= 0) return null;

        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const square = this.boardSize / this.rows;

        // Check whether cursor is inside board
        if (
            !(
                x >= this.offsetX &&
                x < this.offsetX + this.boardSize &&
                y >= this.offsetY &&
                y < this.offsetY + this.boardSize
            )
        ) {
            return null;
        }

        const col = Math.floor((x - this.offsetX) / square);
        const row = Math.floor((y - this.offsetY) / square);

        // col/row above are SCREEN positions (derived straight from
        // pixel location) - convert back to logical board
        // coordinates before handing them to any caller. The
        // transform is its own inverse, so the same helpers used
        // for drawing work here too.
        return [this._screenRow(row), this._screenCol(col)];
    }

    // ========================================================
    // MOUSE HOVER
    // ========================================================

    _clearHover() {
        if (this.hoveredSquare === null) return;
        this.hoveredSquare = null;
        this.hoverMoves = [];
        this.drawBoard();
    }

    onMouseMove(event) {
        const position = this.getCursorSquare(event);

        // ----------------------------------------------------
        // Cursor outside board
        // ----------------------------------------------------
        if (position === null) {
            this._clearHover();
            return;
        }

        const [row, col] = position;

        // ----------------------------------------------------
        // Same square
        // ----------------------------------------------------
        if (
            this.hoveredSquare !== null &&
            this.hoveredSquare[0] === row &&
            this.hoveredSquare[1] === col
        ) {
            return;
        }

        this.hoveredSquare = [row, col];

        // ----------------------------------------------------
        // Check if cursor is over a piece
        // ----------------------------------------------------
        const piece = getPiece(row, col);

        if (piece === null) {
            this.hoverMoves = [];
            this.drawBoard();
            return;
        }

        // ----------------------------------------------------
        // Get available moves
        // ----------------------------------------------------
        this.hoverMoves = getAvailableMoves(row, col, this.rows, this.cols);

        this.drawBoard();
    }

    // ========================================================
    // PIECE RENDERING
    // ========================================================

    renderPieces(ctx) {
        drawPieces(ctx, this.boardSize, this.rows, this.cols, this.offsetX, this.offsetY, this.flipBoard);
    }

    // ========================================================
    // HOVER SQUARE OUTLINE
    // ========================================================

    _drawHoverSquare(ctx) {
        const [row, col] = this.hoveredSquare;

        const x1 = this.offsetX + this._screenCol(col) * this.square;
        const y1 = this.offsetY + this._screenRow(row) * this.square;

        ctx.save();
        ctx.strokeStyle = "#00AFFF";
        ctx.lineWidth = 3;
        ctx.strokeRect(x1 + 1.5, y1 + 1.5, this.square - 3, this.square - 3);
        ctx.restore();
    }

    // ========================================================
    // AVAILABLE MOVES
    // ========================================================

    _drawMoveDots(ctx, moves) {
        const radius = this.square * 0.18;

        for (const [row, col, moveType] of moves) {
            const x = this.offsetX + this._screenCol(col) * this.square + this.square / 2;
            const y = this.offsetY + this._screenRow(row) * this.square + this.square / 2;

            const color = moveType === "move" ? "#00AFFF" : "#FF4040";

            ctx.save();
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    // ========================================================
    // BOARD CLICK
    // ========================================================

    clickBoard(event) {
        if (this.gameOver) return;

        if (this.placementPhase) {
            this._handlePlacementClick(event);
            return;
        }

        const pos = this.getCursorSquare(event);

        if (pos === null) return;

        const [row, col] = pos;

        // ------------------------------------------------
        // TURN OWNERSHIP CHECK (online only)
        // ------------------------------------------------
        // Offline/hotseat has myPlayerIndex === null, so this
        // never restricts local play. Online, a device may only
        // act while it is that device's own player's turn.
        if (
            this.network !== null &&
            this.myPlayerIndex !== null &&
            this.currentPlayer !== this.myPlayerIndex
        ) {
            return;
        }

        // ----------------------------------------------------
        // LOCAL MOVE
        // ----------------------------------------------------

        // Remember which piece was selected before
        // updatePiecePosition() clears selection.
        let selectedPieceObj = null;

        if (this.selectedSource !== null) {
            selectedPieceObj = getPiece(this.selectedSource[0], this.selectedSource[1]);
        }

        const [moved, captured] = updatePiecePosition(row, col, this.rows);

        if (moved) {
            // ------------------------------------------------
            // SEND MOVE TO PEERS
            // ------------------------------------------------
            if (this.network !== null && !this.networkMove && this.selectedSource !== null) {
                const fromPos = this.selectedSource;

                let pieceId = "piece";

                if (selectedPieceObj !== null) {
                    pieceId = `P${selectedPieceObj.player}_${fromPos[0]}_${fromPos[1]}`;
                }

                this.network.sendMove(pieceId, [...fromPos], [row, col]);
            }

            this.selectedSource = null;
            this.selectedMoves = [];

            this.drawBoard();

            // ------------------------------------------------
            // WIN CHECK
            // ------------------------------------------------
            if (captured) {
                const winner = checkWinner();

                if (winner !== null) {
                    this.showWinner(winner);
                    return;
                }
            }

            // ------------------------------------------------
            // NEXT TURN
            // ------------------------------------------------
            this.nextTurn();

            return;
        }

        // ----------------------------------------------------
        // PIECE SELECTION
        // ----------------------------------------------------
        const piece = getPiece(row, col);

        if (piece === null) return;

        if (piece.player !== this.currentPlayer) return;

        if (selectPiece(row, col, this.rows, this.cols)) {
            // Remember source square.
            this.selectedSource = [row, col];

            this.selectedMoves = getSelectedMove();

            this.drawBoard();
        }
    }

    // ========================================================
    // TURN SYSTEM
    // ========================================================

    nextTurn() {
        const alivePlayers = getAlivePlayers();

        // Only one player remains
        if (alivePlayers.length <= 1) return;

        // Try next players until an alive player is found.
        // IMPORTANT: alive status must be checked on every candidate,
        // not only after wrapping past the last player number - an
        // earlier version always ended up back on Player 1.
        for (let i = 0; i < this.players; i++) {
            this.currentPlayer += 1;

            if (this.currentPlayer > this.players) {
                this.currentPlayer = 1;
            }

            if (alivePlayers.includes(this.currentPlayer)) {
                this.updatePlayerHighlight();

                console.log("Player", this.currentPlayer, "turn");

                // Send TURN only for a locally generated turn change.
                // A remote TURN must not be broadcast again.
                if (this.network !== null && !this.networkMove) {
                    try {
                        this.network.sendTurn(this.currentPlayer);
                    } catch (error) {
                        console.log(`[Board] Network turn error: ${error}`);
                    }
                }

                return;
            }
        }
    }

    // ========================================================
    // CLEANUP (leaving this match, one way or another)
    // ========================================================

    _cleanupMatchSession() {
        // Tear down this match's networking and any still-running
        // disconnect timers. Called whenever this Board stops being
        // the active game - both when a winner is declared and when
        // the player clicks Back - so a leftover connection can
        // never keep running in the background and touch the shared
        // game state (pieces.js's module state) after a new match
        // starts. Safe to call more than once.
        for (const remoteId of Object.keys(this.disconnectTimers)) {
            this.cancelDisconnectTimer(remoteId);
        }

        if (this.placementTimerId !== null) {
            clearInterval(this.placementTimerId);
            this.placementTimerId = null;
        }

        if (this._clockIntervalId !== null) {
            this._accrueClock();
            clearInterval(this._clockIntervalId);
            this._clockIntervalId = null;
            this.updatePlayerHighlight();
        }

        if (this.network !== null) {
            try {
                this.network.close();
            } catch (error) {
                console.log(`[Board] Error closing network during cleanup: ${error}`);
            }
        }

        if (this._resizeObserver !== null) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        if (this._onWindowResize !== null) {
            window.removeEventListener("resize", this._onWindowResize);
            window.removeEventListener("orientationchange", this._onWindowResize);
            this._onWindowResize = null;
        }
    }

    // ========================================================
    // RETURN TO MENU
    // ========================================================

    back() {
        try {
            this._cleanupMatchSession();

            this.container.remove();

            // Screen-switch, not object recreation: the Menu
            // instance already exists and just needs to be shown
            // again (see main.js / menu.js).
            if (this.startCallback) this.startCallback();
        } catch (e) {
            alert(`Menu Error\n\nCould not return to the main menu.\n\n${e}`);
        }
    }

    // ========================================================
    // PLAYER LIST
    // ========================================================

    getPlayerList() {
        const lines = ["Players:\n"];

        for (let player = 1; player <= this.players; player++) {
            const color = PLAYER_COLOR_NAMES[player] ?? `Player ${player}`;
            lines.push(`Player ${player} = ${color}`);
        }

        return lines.join("\n");
    }

    // ========================================================
    // WINNER
    // ========================================================

    showWinner(winner, reason = "The last king remaining.") {
        // The match is objectively over - tear down networking and
        // any running disconnect timers now, rather than waiting
        // for (and depending on) the player clicking Back.
        this._cleanupMatchSession();

        // Disable further board interaction
        this.gameOver = true;

        if (this.chatEnabled) this._setChatExpanded(false);

        // ----------------------------------------------------
        // Dark overlay + winner card
        // ----------------------------------------------------
        this.winnerOverlay = document.createElement("div");
        this.winnerOverlay.className = "winner-overlay";

        const winnerCard = document.createElement("div");
        winnerCard.className = "winner-card";
        this.winnerOverlay.appendChild(winnerCard);

        const trophy = document.createElement("div");
        trophy.className = "winner-trophy";
        trophy.textContent = "\u{1F3C6}";
        winnerCard.appendChild(trophy);

        const heading = document.createElement("div");
        heading.className = "winner-heading";
        heading.textContent = "CONGRATULATIONS!";
        winnerCard.appendChild(heading);

        const subheading = document.createElement("div");
        subheading.className = "winner-subheading";
        subheading.textContent = `Player ${winner} wins!`;
        winnerCard.appendChild(subheading);

        const reasonLine = document.createElement("div");
        reasonLine.className = "winner-reason";
        reasonLine.textContent = reason;
        winnerCard.appendChild(reasonLine);

        // Attach to canvasWrap (not this.container) so the overlay
        // only covers the board itself - the side panel, and its
        // Back button, stays outside the overlay and clickable.
        this.canvasWrap.appendChild(this.winnerOverlay);
    }

    // ========================================================
    // PLAYER HIGHLIGHT
    // ========================================================

    updatePlayerHighlight() {
        this._accrueClock();

        if (!this.playerLabels) return;

        for (const [playerStr, label] of Object.entries(this.playerLabels)) {
            const player = Number(playerStr);

            this._renderLabel(label, player);

            if (player === this.currentPlayer) {
                label.classList.add("active");
            } else {
                label.classList.remove("active");
            }
        }
    }

    // ========================================================
    // THINKING-TIME CLOCK
    // ========================================================

    _renderLabel(label, player) {
        const [numLong, numShort, sep1, nm, sep2, col] = label.children[0].children;
        const name = this.playerNames[player];

        numLong.textContent = `PLAYER ${player}`;
        numShort.textContent = `P${player}`;
        sep1.textContent = name ? " - " : "";
        nm.textContent = name || "";
        sep2.textContent = " - ";
        col.textContent = PLAYER_COLOR_NAMES[player] ?? `Player ${player}`;
        label.classList.toggle("has-name", Boolean(name));

        label.children[1].textContent = this._formatThinkingTime(this.thinkingMs[player] ?? 0);
    }

    _formatThinkingTime(ms) {
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const mm = String(m).padStart(2, "0");
        const ss = String(s).padStart(2, "0");

        return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    _clockRunning() {
        return !this.gameOver && !this.placementPhase;
    }

    _accrueClock() {
        // Credits elapsed time to whoever the clock was last running
        // for, THEN switches to the current player - so calling this
        // right after currentPlayer changes (updatePlayerHighlight
        // does) gives the previous player their final stretch.
        const now = Date.now();

        if (this._clockRunning() && this._clockPlayer in this.thinkingMs) {
            this.thinkingMs[this._clockPlayer] += now - this._clockLast;
        }

        this._clockLast = now;
        this._clockPlayer = this.currentPlayer;
    }

    _startClock() {
        this._clockLast = Date.now();
        this._clockIntervalId = setInterval(() => this._tickClock(), 500);
    }

    _tickClock() {
        this._accrueClock();

        const label = this.playerLabels && this.playerLabels[this.currentPlayer];

        if (label && this._clockRunning()) {
            this._renderLabel(label, this.currentPlayer);
        }
    }

    // ========================================================
    // CHAT (online 4-player)
    // ========================================================

    _isMobileLayout() {
        return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
    }

    _chatName(player) {
        const name = this.playerNames[player];

        return name ? `P${player} ${name}` : `P${player}`;
    }

    _chatThreadVisible(key) {
        return this.chatTab === key && (!this._isMobileLayout() || this.chatExpanded);
    }

    _enableChat() {
        if (this.chatEnabled) return;

        this.chatEnabled = true;
        this.chatIs1v1 = this.players === 2;

        const make = (tag, cls) => {
            const el = document.createElement(tag);
            el.className = cls;
            return el;
        };

        const dock = make("div", "chat-dock");
        const panel = make("div", "chat-panel");
        const handle = make("div", "chat-handle");
        const tabs = make("div", "chat-tabs");
        const preview = make("div", "chat-preview");
        const pinned = make("div", "chat-pinned");
        const list = make("div", "chat-messages");
        const allyBtn = make("button", "chat-alliance-btn");
        const row = make("div", "chat-input-row");
        const input = make("input", "chat-input");
        const send = make("button", "chat-send");

        pinned.hidden = true;
        allyBtn.hidden = true;
        tabs.hidden = this.chatIs1v1;
        allyBtn.type = "button";
        allyBtn.textContent = "Send alliance request";
        input.type = "text";
        input.maxLength = CHAT_MAX_LENGTH;
        input.placeholder = "Message...";
        input.autocomplete = "off";
        send.type = "button";
        send.textContent = "Send";

        row.append(input, send);
        panel.append(handle, tabs, preview, pinned, list, allyBtn, row);
        dock.appendChild(panel);

        this.container.classList.add("with-chat");
        this.container.appendChild(dock);

        this.chatPanel = panel;
        this.chatTabsEl = tabs;
        this.chatPreviewEl = preview;
        this.chatPinnedEl = pinned;
        this.chatListEl = list;
        this.chatAllyBtn = allyBtn;
        this.chatInput = input;

        tabs.addEventListener("click", (event) => {
            const button = event.target.closest(".chat-tab");
            if (button) this._selectChatTab(button.dataset.tab);
        });

        let swipeStartY = null;

        handle.addEventListener(
            "touchstart",
            (event) => {
                swipeStartY = event.touches[0].clientY;
            },
            { passive: true },
        );

        handle.addEventListener(
            "touchend",
            (event) => {
                if (swipeStartY === null) return;

                event.preventDefault();

                const dy = event.changedTouches[0].clientY - swipeStartY;
                swipeStartY = null;

                if (dy < -25) this._setChatExpanded(true);
                else if (dy > 25) this._setChatExpanded(false);
                else this._setChatExpanded(!this.chatExpanded);
            },
            { passive: false },
        );

        handle.addEventListener("click", () => this._setChatExpanded(!this.chatExpanded));
        preview.addEventListener("click", () => this._setChatExpanded(true));
        allyBtn.addEventListener("click", () => this._draftAlliance());
        send.addEventListener("click", () => this._sendChat());

        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this._sendChat();
            }
        });

        input.addEventListener("input", () => {
            if (!input.value.trim()) delete input.dataset.kind;
        });

        this._renderChatTabs();
        this._renderChatMessages();
        this._renderChatPreview();
    }

    _renderChatTabs() {
        if (!this.chatEnabled) return;
        if (this.chatIs1v1) return; // no tabs/alliance button - one opponent only

        const keys = ["all"];

        for (let p = 1; p <= this.players; p++) {
            if (p !== this.myPlayerIndex) keys.push(String(p));
        }

        if (!keys.includes(this.chatTab)) this.chatTab = "all";

        this.chatTabsEl.textContent = "";

        for (const key of keys) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "chat-tab" + (key === this.chatTab ? " active" : "");
            button.dataset.tab = key;

            if (key === "all") {
                button.textContent = "All";
            } else {
                const p = Number(key);
                const num = document.createElement("span");
                num.textContent = `P${p}`;
                button.appendChild(num);

                if (this.playerNames[p]) {
                    const nm = document.createElement("span");
                    nm.className = "tn";
                    nm.textContent = ` ${this.playerNames[p]}`;
                    button.appendChild(nm);
                }
            }

            const unread = this.chatUnread[key] || 0;

            if (unread > 0) {
                const badge = document.createElement("span");
                badge.className = "badge";
                badge.textContent = unread > 9 ? "9+" : String(unread);
                button.appendChild(badge);
            }

            this.chatTabsEl.appendChild(button);
        }

        this.chatAllyBtn.hidden = this.chatTab === "all";
    }

    _selectChatTab(key) {
        if (key === this.chatTab) return;

        this.chatDrafts[this.chatTab] = {
            text: this.chatInput.value,
            kind: this.chatInput.dataset.kind || "",
        };

        this.chatTab = key;

        const draft = this.chatDrafts[key] || { text: "", kind: "" };
        this.chatInput.value = draft.text;

        if (draft.kind) this.chatInput.dataset.kind = draft.kind;
        else delete this.chatInput.dataset.kind;

        if (this._chatThreadVisible(key)) this.chatUnread[key] = 0;

        this._renderChatTabs();
        this._renderChatMessages();
        this._renderChatPreview();
    }

    _setChatExpanded(expanded) {
        this.chatExpanded = expanded;
        this.chatPanel.classList.toggle("expanded", expanded);

        if (expanded) {
            this.chatUnread[this.chatTab] = 0;
            this._renderChatTabs();
            this._renderChatMessages();
        }
    }

    _renderChatMessages() {
        if (!this.chatEnabled) return;

        const thread = this.chatThreads[this.chatTab] || [];
        let pinnedMsg = null;

        if (this.chatTab !== "all") {
            for (let i = thread.length - 1; i >= 0; i--) {
                if (thread[i].kind === "alliance") {
                    pinnedMsg = thread[i];
                    break;
                }
            }
        }

        this.chatPinnedEl.textContent = "";
        this.chatPinnedEl.hidden = pinnedMsg === null;

        if (pinnedMsg) {
            const head = document.createElement("div");
            head.className = "pin-head";
            head.textContent = pinnedMsg.mine
                ? `\u{1F91D} Alliance request sent to ${this._chatName(Number(this.chatTab))}`
                : `\u{1F91D} Alliance request from ${this._chatName(pinnedMsg.from)}`;

            const body = document.createElement("div");
            body.textContent = pinnedMsg.text;

            this.chatPinnedEl.append(head, body);
        }

        this.chatListEl.textContent = "";

        for (const msg of thread) {
            if (msg !== pinnedMsg) this.chatListEl.appendChild(this._chatMessageEl(msg));
        }

        this.chatListEl.scrollTop = this.chatListEl.scrollHeight;
    }

    _chatMessageEl(msg) {
        const el = document.createElement("div");
        el.className = "chat-msg" + (msg.mine ? " mine" : "");

        if (this.chatTab === "all" && !msg.mine) {
            const who = document.createElement("span");
            who.className = "who";
            who.textContent = this._chatName(msg.from);
            el.appendChild(who);
        }

        const text = document.createElement("span");
        text.textContent = msg.text;
        el.appendChild(text);

        if (msg.failed) {
            const note = document.createElement("span");
            note.className = "note";
            note.textContent = "not delivered";
            el.appendChild(note);
        }

        return el;
    }

    _renderChatPreview() {
        if (!this.chatEnabled) return;

        const thread = this.chatThreads[this.chatTab] || [];
        const last = thread[thread.length - 1];

        this.chatPreviewEl.classList.toggle("empty", !last);
        this.chatPreviewEl.textContent = last
            ? `${last.mine ? "You" : `P${last.from}`}: ${last.text}`
            : "No messages yet";
    }

    _addChatMessage(key, msg) {
        const thread = (this.chatThreads[key] ||= []);

        thread.push(msg);

        if (thread.length > CHAT_HISTORY_LIMIT) thread.shift();

        if (!msg.mine && !this._chatThreadVisible(key)) {
            this.chatUnread[key] = (this.chatUnread[key] || 0) + 1;
            this._renderChatTabs();
        }

        if (key === this.chatTab) {
            this._renderChatMessages();
            this._renderChatPreview();
        }
    }

    _draftAlliance() {
        if (this.chatTab === "all") return;

        const target = Number(this.chatTab);
        const foes = [];

        for (let p = 1; p <= this.players; p++) {
            if (p !== this.myPlayerIndex && p !== target) foes.push(this._chatName(p));
        }

        const text = foes.length
            ? `Alliance? Let's team up against ${foes.join(" and ")}.`
            : "Alliance? Let's team up.";

        this.chatInput.value = text.slice(0, CHAT_MAX_LENGTH);
        this.chatInput.dataset.kind = "alliance";
        this.chatInput.focus();
    }

    _sendChat() {
        const text = this.chatInput.value.trim().slice(0, CHAT_MAX_LENGTH);

        if (!text || this.network === null) return;

        const key = this.chatTab;
        const kind = key !== "all" && this.chatInput.dataset.kind === "alliance" ? "alliance" : "text";
        const to = key === "all" ? "all" : Number(key);

        let sent = 0;

        try {
            sent = this.network.sendChat(to, text, kind);
        } catch (error) {
            console.log(`[Board] Chat send error: ${error}`);
        }

        this.chatInput.value = "";
        delete this.chatInput.dataset.kind;

        this._addChatMessage(key, {
            from: this.myPlayerIndex,
            text,
            kind,
            ts: Date.now(),
            mine: true,
            failed: sent === 0,
        });
    }

    handleNetworkChat(fromIndex, data) {
        if (!this.chatEnabled) return;

        if (!Number.isInteger(fromIndex) || fromIndex < 1 || fromIndex > this.players) return;
        if (fromIndex === this.myPlayerIndex) return;

        const text = typeof data.text === "string" ? data.text.trim().slice(0, CHAT_MAX_LENGTH) : "";

        if (!text) return;

        const isAll = data.to === "all";

        if (!isAll && Number(data.to) !== this.myPlayerIndex) return;

        this._addChatMessage(isAll ? "all" : String(fromIndex), {
            from: fromIndex,
            text,
            kind: !isAll && data.kind === "alliance" ? "alliance" : "text",
            ts: Date.now(),
            mine: false,
        });
    }
}