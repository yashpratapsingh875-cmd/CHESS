// ============================================================
// pieces.js  (ported from pieces.py)
// ============================================================
// Pure game logic - no DOM/canvas assumptions beyond Piece.draw(),
// which takes a CanvasRenderingContext2D instead of a Tk canvas.

export let selectedPiece = null;
export let selectedMove = [];

// ============================================================
// PLAYER CONFIGURATION
// ============================================================

export const PLAYER_COLORS = {
    1: "#FFFFFF",   // White
    2: "#222222",   // Black
    3: "#E53935",   // Red
    4: "#1E88E5",   // Blue
    5: "#43A047",   // Green
    6: "#FDD835",   // Gold
};

export const PLAYER_NAMES = {
    1: "White",
    2: "Black",
    3: "Red",
    4: "Blue",
    5: "Green",
    6: "Gold",
};

// ============================================================
// STARTING LAYOUTS
// ============================================================
//
// Player 4 (Blue, bottom_left) is the reference formation: the
// soldier wall covers the two sides that face the board's open
// center, with the king tucked into the true (closed-on-both-
// sides) corner behind it.
//
// The other three corners are DERIVED from this same formation by
// mirroring it to match which of their own sides are open, rather
// than being separately hand-authored.

const _BOTTOM_LEFT_FORMATION = [
    ["soldier", "soldier", "soldier", "soldier"],
    ["bishop", "rook", "collector", "soldier"],
    ["knight", "queen", "rook", "soldier"],
    ["king", "knight", "bishop", "soldier"],
];

function _mirrorRows(formation) {
    // Flip top-to-bottom (needed for the two TOP corners).
    return formation.slice().reverse().map((row) => row.slice());
}

function _mirrorCols(formation) {
    // Flip left-to-right (needed for the two RIGHT corners).
    return formation.map((row) => row.slice().reverse());
}

export const STARTING_LAYOUTS = {
    "4_player_standard": {
        // bottom_left - reference, no mirroring needed.
        4: _BOTTOM_LEFT_FORMATION,
        // top_left - same (left) column side, opposite (top) row
        // side, so only rows are mirrored.
        1: _mirrorRows(_BOTTOM_LEFT_FORMATION),
        // bottom_right - same (bottom) row side, opposite (right)
        // column side, so only columns are mirrored.
        2: _mirrorCols(_BOTTOM_LEFT_FORMATION),
        // top_right - opposite on both sides, so both are mirrored.
        3: _mirrorCols(_mirrorRows(_BOTTOM_LEFT_FORMATION)),
    },
};

// ============================================================
// PIECE
// ============================================================

export class Piece {
    static SYMBOLS = {
        king: ["\u2654", "\u265A"],
        queen: ["\u2655", "\u265B"],
        rook: ["\u2656", "\u265C"],
        bishop: ["\u2657", "\u265D"],
        knight: ["\u2658", "\u265E"],
        pawn: ["\u2659", "\u265F"],
        soldier: ["\u2659", "\u265F"],

        // TESTING PLACEHOLDER - devil emoji stands in for the
        // Collector piece until real artwork exists. Same glyph
        // for both symbol_index slots since there's no light/dark
        // emoji variant; the fill color (this.color) still marks
        // which player owns it.
        collector: ["\u{1F608}", "\u{1F608}"],
    };

    static MOVE_PATTERN = {
        king: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
        queen: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
        rook: [[-1, 0], [1, 0], [0, -1], [0, 1]],
        bishop: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
        knight: [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]],
        soldier: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
        pawn: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],

        // Same movement shape as queen (sliding, all 8 directions).
        // Its special ability (annexing a defeated player's
        // remaining pieces on capture) is handled separately in
        // the capture-resolution helpers below, not here - this
        // table only controls where it's allowed to move.
        collector: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
    };

    static SLIDING = new Set(["rook", "bishop", "queen", "collector"]);

    constructor(pieceType, player, row, col) {
        this.type = pieceType;

        // Player number instead of hard-coded color
        this.player = player;

        this.row = row;
        this.col = col;

        // ----------------------------------------------------
        // COLLECTOR TRACKING
        // ----------------------------------------------------
        // collectedPieces: pieces THIS piece has annexed (only
        // ever populated on a Collector). If this piece is
        // captured/removed, everything in here vanishes with it.
        //
        // collectedBy: the Collector (if any) that annexed THIS
        // piece, so it can be unlinked from that Collector's list
        // if it's later captured/removed by someone else.
        //
        // Present on every piece (not just collectors) so the
        // shared capture-resolution helpers can check them without
        // needing to know the piece's type first.
        this.collectedPieces = [];
        this.collectedBy = null;

        // Tracks whether this piece has ever moved. Currently only
        // used for the pawn's first-move-may-go-two-squares rule
        // below, but kept as a general flag (set for every piece
        // type on every move) since "has this piece moved yet" is
        // useful chess state in general, not pawn-specific.
        this.hasMoved = false;
    }

    // --------------------------------------------------------
    // Color
    // --------------------------------------------------------
    get color() {
        return PLAYER_COLORS[this.player] ?? "#FFFFFF";
    }

    // --------------------------------------------------------
    // Player name
    // --------------------------------------------------------
    get playerName() {
        return PLAYER_NAMES[this.player] ?? `Player ${this.player}`;
    }

    // --------------------------------------------------------
    // Draw
    // --------------------------------------------------------
    // `canvas` here is a CanvasRenderingContext2D (Tk canvas has no
    // browser equivalent, so drawing is rewritten - the position
    // math below is otherwise identical to pieces.py).
    draw(ctx, boardSize, rows, cols, offsetX, offsetY, flip = false) {
        const squareWidth = boardSize / cols;
        const squareHeight = boardSize / rows;

        // When flipped, both rank and file are mirrored (a full
        // 180-degree rotation) - the same convention a physical
        // chess board follows when turned to face the other player.
        const drawRow = flip ? rows - 1 - this.row : this.row;
        const drawCol = flip ? cols - 1 - this.col : this.col;

        const x = offsetX + drawCol * squareWidth + squareWidth / 2;
        const y = offsetY + drawRow * squareHeight + squareHeight / 2;

        const square = Math.min(squareWidth, squareHeight);

        // First symbol = light-style piece
        // Second symbol = dark-style piece
        const symbolIndex = this.player % 2 ? 0 : 1;
        const symbol = Piece.SYMBOLS[this.type][symbolIndex];

        ctx.save();

        // The Collector glyph is a full-color emoji, which browsers
        // render in its own fixed color regardless of ctx.fillStyle
        // - unlike every other piece type, whose glyphs are
        // monochrome outlines that DO pick up fillStyle. Left alone,
        // every player's Collector would look visually identical.
        // A colored disc behind it (in this piece's own player
        // color) restores that same at-a-glance ownership cue.
        if (this.type === "collector") {
            ctx.beginPath();
            ctx.arc(x, y, square * 0.4, 0, Math.PI * 2);
            ctx.fillStyle = this.color;
            ctx.fill();
            ctx.lineWidth = Math.max(1, square * 0.03);
            ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
            ctx.stroke();
        }

        ctx.font = `${Math.trunc(square * 0.65)}px "Segoe UI Symbol", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
        ctx.fillStyle = this.color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(symbol, x, y);
        ctx.restore();
    }

    // --------------------------------------------------------
    // Movement
    // --------------------------------------------------------
    getMoves() {
        return Piece.MOVE_PATTERN[this.type] ?? [];
    }
}

// ============================================================
// PIECE STORAGE
// ============================================================

export let pieces = [];

// ============================================================
// CREATE TWO-PLAYER ARMY
// ============================================================

export function createTwoPlayerPieces(rows, cols) {
    // --------------------------------------------------------
    // Player 1
    // --------------------------------------------------------
    pieces.push(
        new Piece("rook", 1, 0, 0),
        new Piece("knight", 1, 0, 1),
        new Piece("bishop", 1, 0, 2),
        new Piece("queen", 1, 0, 3),
        new Piece("king", 1, 0, 4),
        new Piece("bishop", 1, 0, 5),
        new Piece("knight", 1, 0, 6),
        new Piece("rook", 1, 0, 7),
    );

    for (let col = 0; col < 8; col++) {
        pieces.push(new Piece("pawn", 1, 1, col));
    }

    // --------------------------------------------------------
    // Player 2
    // --------------------------------------------------------
    const backRow = rows - 1;
    const pawnRow = rows - 2;

    for (let col = 0; col < 8; col++) {
        pieces.push(new Piece("pawn", 2, pawnRow, col));
    }

    pieces.push(
        new Piece("rook", 2, backRow, 0),
        new Piece("knight", 2, backRow, 1),
        new Piece("bishop", 2, backRow, 2),
        new Piece("queen", 2, backRow, 3),
        new Piece("king", 2, backRow, 4),
        new Piece("bishop", 2, backRow, 5),
        new Piece("knight", 2, backRow, 6),
        new Piece("rook", 2, backRow, 7),
    );
}

// ============================================================
// EXTRA PLAYER STARTING FORMATION
// ============================================================

export const EXTRA_FORMATION = [
    ["soldier", "soldier", "soldier", "soldier"],
    ["bishop", "rook", "collector", "soldier"],
    ["knight", "queen", "rook", "soldier"],
    ["king", "knight", "bishop", "soldier"],
];

// ============================================================
// PLAYER CORNER POSITIONS
// ============================================================

export const PLAYER_START_CORNERS = {
    1: "top_left",
    2: "bottom_right",
    3: "top_right",
    4: "bottom_left",
    5: "middle_left",
    6: "middle_right",
};

// ============================================================
// FORMATION POSITION (for the extra-player placement path)
// ============================================================

export function getFormationPosition(corner, startRow, startCol, r, c) {
    const size = EXTRA_FORMATION.length;

    if (corner === "top_left") {
        return [startRow + r, startCol + c];
    }

    if (corner === "top_right") {
        return [startRow + r, startCol + (size - 1 - c)];
    }

    if (corner === "bottom_left") {
        return [startRow + (size - 1 - r), startCol + c];
    }

    if (corner === "bottom_right") {
        return [startRow + (size - 1 - r), startCol + (size - 1 - c)];
    }

    return [startRow + r, startCol + c];
}

// ============================================================
// EXTRA-PLAYER REGION ORIGIN (shared by placeExtraPlayer and the
// placement-phase region calculator below, so they can never
// disagree about which cells belong to a given corner)
// ============================================================

function _extraPlayerOrigin(corner, rows, cols) {
    const height = EXTRA_FORMATION.length;
    const width = EXTRA_FORMATION[0].length;

    if (corner === "top_left") return { startRow: 0, startCol: 0 };
    if (corner === "top_right") return { startRow: 0, startCol: cols - width };
    if (corner === "bottom_left") return { startRow: rows - height, startCol: 0 };
    if (corner === "bottom_right") return { startRow: rows - height, startCol: cols - width };
    if (corner === "middle_left") return { startRow: Math.floor((rows - height) / 2), startCol: 0 };
    if (corner === "middle_right") return { startRow: Math.floor((rows - height) / 2), startCol: cols - width };

    return null;
}

// ============================================================
// PLACE EXTRA PLAYER
// ============================================================

export function placeExtraPlayer(player, rows, cols) {
    const corner = PLAYER_START_CORNERS[player];

    if (corner === undefined) return;

    const height = EXTRA_FORMATION.length;
    const width = EXTRA_FORMATION[0].length;

    const origin = _extraPlayerOrigin(corner, rows, cols);

    if (origin === null) return;

    const { startRow, startCol } = origin;

    // --------------------------------------------------------
    // Create pieces
    // --------------------------------------------------------
    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const pieceType = EXTRA_FORMATION[r][c];
            const [boardRow, boardCol] = getFormationPosition(corner, startRow, startCol, r, c);

            if (!(boardRow >= 0 && boardRow < rows && boardCol >= 0 && boardCol < cols)) {
                continue;
            }

            pieces.push(new Piece(pieceType, player, boardRow, boardCol));
        }
    }
}

// ============================================================
// PLACEMENT PHASE SUPPORT
// ============================================================
// Everything below supports the interactive "place your own
// pieces" phase (6-player mode) - it does not touch or replace
// any of the fixed-layout code above.

// The fixed 16-piece army every player arranges within their own
// region during the placement phase - same composition as
// EXTRA_FORMATION, just flattened into a list rather than fixed
// board positions.
export function getStandardArmy() {
    const army = [];

    for (const row of EXTRA_FORMATION) {
        for (const pieceType of row) {
            army.push(pieceType);
        }
    }

    return army;
}

// The list of [row, col] cells that make up `player`'s own corner
// region - exactly the cells placeExtraPlayer() would have used for
// that player, so "your region" always matches the same corner
// math used everywhere else in this file.
export function getPlayerRegionCells(player, rows, cols) {    const corner = PLAYER_START_CORNERS[player];

    if (corner === undefined) return [];

    const origin = _extraPlayerOrigin(corner, rows, cols);

    if (origin === null) return [];

    const height = EXTRA_FORMATION.length;
    const width = EXTRA_FORMATION[0].length;

    const cells = [];

    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const [boardRow, boardCol] = getFormationPosition(corner, origin.startRow, origin.startCol, r, c);

            if (boardRow >= 0 && boardRow < rows && boardCol >= 0 && boardCol < cols) {
                cells.push([boardRow, boardCol]);
            }
        }
    }

    return cells;
}

// Clears the board for a fresh placement-phase match. Needed
// because, unlike every other mode, a placement-mode board never
// calls createPieces() (which resets `pieces` itself) - without
// this, a second 6-player match in the same session would start
// with the previous match's pieces still sitting on the board
// underneath the new placements.
export function resetBoard() {
    pieces = [];
}

// Finalize a player's chosen arrangement onto the real board.
// `placements` is an array of { type, row, col } - from either this
// device's own confirmed local placement, or a "placement" network
// message from another player. Validates the full set before
// applying any of it (exact roster match, every square within this
// player's own region, no square used twice) and applies nothing at
// all if invalid. There's no authoritative server in this P2P
// design, so a remote player's placement message is untrusted input
// - this is what stops a malformed or tampered one from corrupting
// the shared board state. rows/cols default to the 6-player board
// size since that's the only mode this is ever used for.
export function placeCustomPieces(player, placements, rows = 16, cols = 16) {
    if (!Array.isArray(placements)) return false;

    const roster = getStandardArmy();

    if (placements.length !== roster.length) return false;

    const rosterCounts = {};
    for (const pieceType of roster) {
        rosterCounts[pieceType] = (rosterCounts[pieceType] || 0) + 1;
    }

    const validCells = new Set(
        getPlayerRegionCells(player, rows, cols).map(([r, c]) => `${r}_${c}`),
    );

    const seenSquares = new Set();
    const bishopSquareColors = [];

    for (const entry of placements) {
        if (!entry || typeof entry.type !== "string") return false;

        const row = Number(entry.row);
        const col = Number(entry.col);

        if (!Number.isInteger(row) || !Number.isInteger(col)) return false;

        const key = `${row}_${col}`;

        if (!validCells.has(key)) return false;
        if (seenSquares.has(key)) return false;
        seenSquares.add(key);

        if (!rosterCounts[entry.type]) return false;
        rosterCounts[entry.type] -= 1;

        if (entry.type === "bishop") {
            bishopSquareColors.push((row + col) % 2);
        }
    }

    for (const remaining of Object.values(rosterCounts)) {
        if (remaining !== 0) return false;
    }

    // Real-chess bishop rule: with two bishops in the roster, they
    // must go on opposite-colored squares - a player can't place
    // both on the same color block.
    if (bishopSquareColors.length === 2 && bishopSquareColors[0] === bishopSquareColors[1]) {
        return false;
    }

    for (const entry of placements) {
        pieces.push(new Piece(entry.type, player, Number(entry.row), Number(entry.col)));
    }

    return true;
}

// Draws a single piece that isn't (yet) in the real `pieces` array -
// used only to render a local player's in-progress, not-yet-
// confirmed placement during the placement phase.
export function drawGhostPiece(ctx, pieceType, player, row, col, boardSize, rows, cols, offsetX, offsetY, flip = false) {
    const ghost = new Piece(pieceType, player, row, col);
    ghost.draw(ctx, boardSize, rows, cols, offsetX, offsetY, flip);
}

// ============================================================
// CREATE ALL PIECES
// ============================================================

export function createPieces(rows, cols, playerCount = 2, layout = "standard") {
    pieces = [];

    if (playerCount === 2) {
        createTwoPlayerPieces(rows, cols);
        return;
    }

    const layoutKey = `${playerCount}_player_${layout}`;
    const selectedLayout = STARTING_LAYOUTS[layoutKey];

    if (selectedLayout === undefined) return;

    for (let player = 1; player <= playerCount; player++) {
        placeLayout(player, selectedLayout[player], rows, cols);
    }
}

// ============================================================
// DRAW PIECES
// ============================================================

export function drawPieces(ctx, boardSize, rows, cols, offsetX, offsetY, flip = false) {
    for (const piece of pieces) {
        if (!(piece.row >= 0 && piece.row < rows && piece.col >= 0 && piece.col < cols)) {
            continue;
        }

        piece.draw(ctx, boardSize, rows, cols, offsetX, offsetY, flip);
    }
}

// ============================================================
// PLACE LAYOUT
// ============================================================

export function placeLayout(player, formation, rows, cols) {
    const height = formation.length;
    const width = formation[0].length;

    const corner = PLAYER_START_CORNERS[player];

    if (corner === undefined) return;

    let startRow;
    let startCol;

    if (corner === "top_left") {
        startRow = 0;
        startCol = 0;
    } else if (corner === "top_right") {
        startRow = 0;
        startCol = cols - width;
    } else if (corner === "bottom_left") {
        startRow = rows - height;
        startCol = 0;
    } else if (corner === "bottom_right") {
        startRow = rows - height;
        startCol = cols - width;
    } else {
        return;
    }

    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const pieceType = formation[r][c];
            const row = startRow + r;
            const col = startCol + c;

            pieces.push(new Piece(pieceType, player, row, col));
        }
    }
}

// ============================================================
// GET PIECE
// ============================================================

export function getPiece(row, col) {
    for (const piece of pieces) {
        if (piece.row === row && piece.col === col) {
            return piece;
        }
    }

    return null;
}

// ============================================================
// PAWN MOVES (Classic 2-player mode)
// ============================================================

function _getPawnMoves(piece, row, col, rows, cols) {
    const moves = [];

    // Player 1 starts near row 0 and advances toward higher row
    // numbers; Player 2 starts near the last row and advances
    // toward lower row numbers. Classic mode only has these two
    // players, so this covers it without needing per-mode config.
    const direction = piece.player === 1 ? 1 : -1;

    // ------------------------------------------------
    // Forward move(s) - only onto EMPTY square(s).
    // ------------------------------------------------
    const forwardRow = row + direction;
    const forwardOpen = forwardRow >= 0 && forwardRow < rows && getPiece(forwardRow, col) === null;

    if (forwardOpen) {
        moves.push([forwardRow, col, "move"]);

        // First move only: may advance a second square, same as
        // real chess - but only if that second square is also
        // empty (a pawn can never jump over an occupied square).
        if (!piece.hasMoved) {
            const doubleRow = row + direction * 2;
            const doubleOpen =
                doubleRow >= 0 && doubleRow < rows && getPiece(doubleRow, col) === null;

            if (doubleOpen) {
                moves.push([doubleRow, col, "move"]);
            }
        }
    }

    // ------------------------------------------------
    // Diagonal moves - ONLY when capturing an enemy.
    // ------------------------------------------------
    for (const dc of [-1, 1]) {
        const diagRow = row + direction;
        const diagCol = col + dc;

        if (!(diagRow >= 0 && diagRow < rows && diagCol >= 0 && diagCol < cols)) {
            continue;
        }

        const target = getPiece(diagRow, diagCol);

        if (target !== null && target.player !== piece.player) {
            moves.push([diagRow, diagCol, "capture"]);
        }
    }

    return moves;
}

// ============================================================
// AVAILABLE MOVES
// ============================================================

export function getAvailableMoves(row, col, rows, cols) {
    const piece = getPiece(row, col);

    if (piece === null) return [];

    // ----------------------------------------------------
    // PAWN (Classic 2-player mode)
    // ----------------------------------------------------
    // Real chess pawn rules: one square straight ahead only
    // when that square is empty (no capturing straight ahead),
    // and diagonal-forward only when capturing an enemy piece
    // there. This does NOT touch "soldier" - the 4/6-player
    // variant piece - which keeps its existing king-like
    // one-step-any-direction movement.
    if (piece.type === "pawn") {
        return _getPawnMoves(piece, row, col, rows, cols);
    }

    const moves = [];

    for (const [dr, dc] of piece.getMoves()) {
        const maxDistance = Piece.SLIDING.has(piece.type) ? Math.max(rows, cols) : 1;

        for (let step = 1; step <= maxDistance; step++) {
            const r = row + dr * step;
            const c = col + dc * step;

            if (!(r >= 0 && r < rows && c >= 0 && c < cols)) {
                break;
            }

            const target = getPiece(r, c);

            // ------------------------------------------------
            // Empty
            // ------------------------------------------------
            if (target === null) {
                moves.push([r, c, "move"]);
                continue;
            }

            // ------------------------------------------------
            // Enemy
            // ------------------------------------------------
            if (target.player !== piece.player) {
                moves.push([r, c, "capture"]);
            }

            // Any piece blocks path
            break;
        }
    }

    return moves;
}

// ============================================================
// SELECT PIECE
// ============================================================

export function selectPiece(row, col, rows, cols, currentPlayer = null) {
    const piece = getPiece(row, col);

    if (piece === null) return false;

    // --------------------------------------------------------
    // Turn restriction
    // --------------------------------------------------------
    if (currentPlayer !== null && piece.player !== currentPlayer) {
        return false;
    }

    selectedPiece = piece;
    selectedMove = getAvailableMoves(row, col, rows, cols);

    return true;
}

// ============================================================
// GET SELECTED MOVE
// ============================================================

export function getSelectedMove() {
    return selectedMove;
}

// ============================================================
// COLLECTOR + PROMOTION HELPERS
// ============================================================
// Shared by updatePiecePosition() (local moves) and
// applyNetworkMove() (moves received from another player) so
// both paths behave identically - a Collector's annexing and a
// pawn's promotion must happen the same way no matter whose
// device actually made the move.

function _convertPiece(newOwnerCollector, target) {
    // Annex `target` onto newOwnerCollector's team instead of
    // removing it from the board. If `target` is itself a Collector
    // that had already annexed pieces of its own, those fold into
    // the new owner's collection too (they change hands along with
    // it, they don't vanish - only losing a Collector outright does
    // that, see _removePieceAndDependents below).
    //
    // `target` is physically relocated onto the square the Collector
    // is moving FROM (its position right now, before this move
    // completes - this function runs before the mover's own row/col
    // get updated). The Collector still ends up on the square it
    // captured onto, same as a normal capture, so the two pieces
    // never end up stacked on the same square.

    if (target.type === "collector" && target.collectedPieces.length) {
        for (const subPiece of target.collectedPieces) {
            subPiece.player = newOwnerCollector.player;
            subPiece.collectedBy = newOwnerCollector;
            newOwnerCollector.collectedPieces.push(subPiece);
        }

        target.collectedPieces = [];
    }

    target.row = newOwnerCollector.row;
    target.col = newOwnerCollector.col;

    target.player = newOwnerCollector.player;
    target.collectedBy = newOwnerCollector;
    newOwnerCollector.collectedPieces.push(target);
}

function _removePieceAndDependents(piece) {
    // Remove `piece` from the board for good. If it's a Collector
    // holding annexed pieces, they vanish with it - losing the
    // Collector loses everything it collected.

    if (piece.type === "collector" && piece.collectedPieces.length) {
        for (const dependent of piece.collectedPieces.slice()) {
            const idx = pieces.indexOf(dependent);
            if (idx !== -1) pieces.splice(idx, 1);
        }

        piece.collectedPieces = [];
    }

    const idx = pieces.indexOf(piece);
    if (idx !== -1) pieces.splice(idx, 1);

    // If `piece` was itself someone else's annexed piece, unlink
    // it from their collection now that it's gone.
    if (piece.collectedBy !== null) {
        const collectorIdx = piece.collectedBy.collectedPieces.indexOf(piece);
        if (collectorIdx !== -1) piece.collectedBy.collectedPieces.splice(collectorIdx, 1);
    }
}

function _resolveCapture(mover, target) {
    // Decide what happens to `target` when `mover` captures it.
    //
    // Collector's special ability: capturing a non-king piece that
    // belongs to an ALREADY-defeated player (their king is no longer
    // on the board) annexes it instead of removing it. Every other
    // capture - including a Collector capturing a king, or capturing
    // a piece whose player is still alive - is a normal removal.

    if (
        mover.type === "collector" &&
        target.type !== "king" &&
        !getAlivePlayers().includes(target.player)
    ) {
        _convertPiece(mover, target);
        return;
    }

    _removePieceAndDependents(target);
}

function _maybePromotePawn(piece, rows) {
    // Classic-mode pawn promotion: a pawn that reaches the far rank
    // is promoted to a Queen. Does nothing for "soldier" (the 4/6
    // -player variant piece) or any other type.

    if (piece.type !== "pawn") return;

    if (piece.player === 1 && piece.row === rows - 1) {
        piece.type = "queen";
    } else if (piece.player === 2 && piece.row === 0) {
        piece.type = "queen";
    }
}

// ============================================================
// LOCAL MOVE
// ============================================================

export function updatePiecePosition(row, col, rows = 8) {
    // Nothing selected
    if (selectedPiece === null) {
        return [false, false];
    }

    // --------------------------------------------------------
    // Check whether destination is valid
    // --------------------------------------------------------
    let selectedTarget = null;

    for (const [moveRow, moveCol, moveType] of selectedMove) {
        if (moveRow === row && moveCol === col) {
            selectedTarget = moveType;
            break;
        }
    }

    // Invalid destination
    if (selectedTarget === null) {
        return [false, false];
    }

    // --------------------------------------------------------
    // Check destination
    // --------------------------------------------------------
    const targetPiece = getPiece(row, col);
    let captured = false;

    if (targetPiece !== null) {
        // Own piece cannot be captured
        if (targetPiece.player === selectedPiece.player) {
            return [false, false];
        }

        // Capture opponent
        _resolveCapture(selectedPiece, targetPiece);
        captured = true;
    }

    // --------------------------------------------------------
    // Move selected piece
    // --------------------------------------------------------
    selectedPiece.row = row;
    selectedPiece.col = col;
    selectedPiece.hasMoved = true;

    _maybePromotePawn(selectedPiece, rows);

    // --------------------------------------------------------
    // Clear selection
    // --------------------------------------------------------
    selectedPiece = null;
    selectedMove = [];

    return [true, captured];
}

// ============================================================
// APPLY NETWORK MOVE
// ============================================================

export function applyNetworkMove(fromPos, toPos, rows, cols) {
    // Apply a move received through the WebRTC network.
    //
    // This function is intentionally separate from
    // updatePiecePosition() because a network move does not
    // come through the local mouse-selection system.
    //
    // Parameters
    // ----------
    // fromPos: source position as [row, col].
    // toPos: destination position as [row, col].
    //
    // Returns
    // -------
    // [moved, captured]

    // --------------------------------------------------------
    // Validate positions
    // --------------------------------------------------------
    if (
        !(Array.isArray(fromPos) && fromPos.length === 2 && Array.isArray(toPos) && toPos.length === 2)
    ) {
        return [false, false];
    }

    const fromRow = Number(fromPos[0]);
    const fromCol = Number(fromPos[1]);
    const toRow = Number(toPos[0]);
    const toCol = Number(toPos[1]);

    if ([fromRow, fromCol, toRow, toCol].some((n) => !Number.isFinite(n))) {
        return [false, false];
    }

    // --------------------------------------------------------
    // Find source piece
    // --------------------------------------------------------
    const movingPiece = getPiece(fromRow, fromCol);

    if (movingPiece === null) {
        console.log("[Pieces] Network move rejected: source piece not found.");
        return [false, false];
    }

    // --------------------------------------------------------
    // Verify destination is legal for this piece
    // --------------------------------------------------------
    const availableMoves = getAvailableMoves(
        fromRow,
        fromCol,
        Math.max(fromRow, toRow, 0) + 1,
        Math.max(fromCol, toCol, 0) + 1,
    );

    let validMove = false;

    for (const [moveRow, moveCol] of availableMoves) {
        if (moveRow === toRow && moveCol === toCol) {
            validMove = true;
            break;
        }
    }

    if (!validMove) {
        console.log("[Pieces] Network move rejected: illegal destination.");
        return [false, false];
    }

    // --------------------------------------------------------
    // Check destination piece
    // --------------------------------------------------------
    const targetPiece = getPiece(toRow, toCol);
    let captured = false;

    if (targetPiece !== null) {
        // Same-player piece cannot be captured
        if (targetPiece.player === movingPiece.player) {
            console.log("[Pieces] Network move rejected: destination occupied by own piece.");
            return [false, false];
        }

        _resolveCapture(movingPiece, targetPiece);
        captured = true;
    }

    // --------------------------------------------------------
    // Move piece
    // --------------------------------------------------------
    movingPiece.row = toRow;
    movingPiece.col = toCol;
    movingPiece.hasMoved = true;

    _maybePromotePawn(movingPiece, rows);

    // --------------------------------------------------------
    // Clear any local selection
    // --------------------------------------------------------
    selectedPiece = null;
    selectedMove = [];

    return [true, captured];
}

// ============================================================
// CHECK WINNER
// ============================================================

export function checkWinner() {
    const kings = pieces.filter((piece) => piece.type === "king");

    if (kings.length === 1) {
        return kings[0].player;
    }

    return null;
}

// ============================================================
// GET ALIVE PLAYERS
// ============================================================

export function getAlivePlayers() {
    const alivePlayers = new Set();

    for (const piece of pieces) {
        if (piece.type === "king") {
            alivePlayers.add(piece.player);
        }
    }

    return Array.from(alivePlayers).sort((a, b) => a - b);
}

// ============================================================
// ELIMINATE PLAYER (used when a player disconnects in a
// multiplayer mode instead of running a reconnect grace timer -
// see board.js/menu.js)
// ============================================================

export function eliminatePlayer(player) {
    // Removes `player`'s king, exactly as if it had been captured.
    // Their other pieces are deliberately left on the board - same
    // as a normal king capture - so they remain ordinary capture/
    // Collector-annex targets for the remaining players, rather
    // than just vanishing.
    const king = pieces.find((piece) => piece.type === "king" && piece.player === player);

    if (king) {
        _removePieceAndDependents(king);
    }

    clearSelection();
}

// ============================================================
// GET ALL PIECES
// ============================================================

export function getAllPieces() {
    // Return the current list of all pieces on the board. A plain
    // `import { pieces }` elsewhere sees this module's live binding,
    // so it stays correct even though createPieces() rebinds `pieces`
    // to a brand new array on every new game - callers still see the
    // current array through this getter (or through the live import
    // binding itself).
    return pieces;
}

// ============================================================
// CLEAR SELECTION
// ============================================================

export function clearSelection() {
    selectedPiece = null;
    selectedMove = [];
}

// ============================================================
// STATE SNAPSHOT (for mid-match reconnection)
// ============================================================

export function serializeState() {
    const indexOf = new Map();
    pieces.forEach((piece, i) => indexOf.set(piece, i));

    return {
        pieces: pieces.map((piece) => ({
            type: piece.type,
            player: piece.player,
            row: piece.row,
            col: piece.col,
            hasMoved: piece.hasMoved,
            collectedBy: piece.collectedBy !== null ? indexOf.get(piece.collectedBy) : null,
        })),
    };
}

export function loadState(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.pieces)) return false;

    const rebuilt = snapshot.pieces.map((entry) => {
        const piece = new Piece(entry.type, entry.player, entry.row, entry.col);
        piece.hasMoved = Boolean(entry.hasMoved);
        return piece;
    });

    snapshot.pieces.forEach((entry, i) => {
        if (entry.collectedBy !== null && entry.collectedBy !== undefined) {
            const owner = rebuilt[entry.collectedBy];
            rebuilt[i].collectedBy = owner;
            owner.collectedPieces.push(rebuilt[i]);
        }
    });

    pieces = rebuilt;
    clearSelection();

    return true;
}