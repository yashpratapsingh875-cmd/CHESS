// ============================================================
// gameProtocol.js
// ============================================================
// menu.py imports make_move/make_turn from Networking.game_protocol,
// a file that wasn't part of the upload. Reconstructed here from
// how board.py/menu.py actually use the returned messages
// (broadcast as JSON over the WebRTC data channel and read back
// via data.get("from")/data.get("to")/data.get("player_index")).

export function makeMove(pieceId, fromPos, toPos) {
    return {
        type: "move",
        piece_id: pieceId,
        from: fromPos,
        to: toPos,
    };
}

export function makeTurn(playerIndex) {
    return {
        type: "turn",
        player_index: playerIndex,
    };
}

export function makePlacement(player, placements) {
    // Broadcast once during the 6-player placement phase - when
    // this player confirms (or their timer runs out), `placements`
    // is their finished [{type, row, col}, ...] army arrangement
    // (see pieces.js's placeCustomPieces and board.js's placement
    // phase). Sent as `pieces` to match what board.js's
    // handleNetworkPlacement() reads back (data.pieces).
    return {
        type: "placement",
        player,
        pieces: placements,
    };
}