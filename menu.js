// ============================================================
// menu.js  (ported from menu.py)
// ============================================================
// Dropped entirely (browsers are single-threaded, so none of this
// is needed): the asyncio event loop + background thread
// (_run_network/self.thread/self.loop), every root.after(0, ...)
// callback-marshaling call, and resize_background (CSS
// background-size: cover replaces it with zero code).
//
// NOTE on mesh_client.py mismatch: menu.py originally built
// MeshClient(player_name, signaling_server=..., room_code=...) and
// called client.connect() / client.close_signaling_only() - but the
// real MeshClient only takes signalingServer in its constructor,
// connect(playerName) takes the name, and there is no
// close_signaling_only (only leaveRoom()). GameNetwork below calls
// the real API. Room codes aren't supported by this signaling
// protocol, so that parameter is dropped for now.

import { Board, DISCONNECT_GRACE_SECONDS } from "./board.js";
import { MeshClient } from "./meshClient.js";
import { makeMove, makeTurn, makePlacement } from "./gameProtocol.js";

// ============================================================
// SIGNALING SERVER
// ============================================================
// Used ONLY for the connection lobby: matchmaking (room roster)
// and relaying WebRTC offer/answer/ICE messages between players.
// Once both players' data channels are open, this server is never
// contacted again for the rest of the match - all moves/turns
// travel peer-to-peer.
const SIGNALING_SERVER_URL = "wss://chess-signaling.chess-signaling-lobby.workers.dev";

// worker.js routes each room code to its own Durable Object, so
// two matches never see each other's players. Every player who
// hits Start -> Online currently lands in this same shared room -
// fine for testing between your own devices, but strangers could
// in principle land in it too. A room-code input field (so players
// can privately agree on a code) would be the natural next step.
const ROOM_CODE = "lobby";

// A normal match shards by game mode - lobby-classic, lobby-4-player,
// etc - and auto-advances to lobby-classic-2, -3, ... whenever the
// current shard already has enough people for a full match, so
// unrelated simultaneous matches of the same mode don't all pile
// into one room and full-mesh-signal each other for no reason (same
// motivation as the per-client datachannel cap in _connect(), just
// applied at the room level instead). Best-effort, not a hard
// guarantee - two devices probing at nearly the same instant can
// still both commit to the same shard; the datachannel cap already
// in place is what keeps that harmless rather than a correctness
// bug. Survivor/searcher reconnect never shards - both sides rely on
// the SAME shared ROOM_CODE room to find each other via tag, and a
// searcher has no way to know which mode the survivor's original
// match even was.
const MAX_ROOM_SHARDS = 20;

function _roomSlug(gameMode) {
    return String(gameMode).toLowerCase().replace(/\s+/g, "-");
}

// Encoded straight into the registered "name" sent to the signaling
// server (which just stores/echoes back whatever string it's given,
// no protocol change needed) so a surviving player reconnecting and
// a player picking "Unfinished Match" mode can only ever pair with
// each other, never with an unrelated fresh player also in the
// shared lobby at the same time. See _checkMatchReady()'s filtering.
// Two DISTINCT, complementary tags rather than one shared tag - a
// survivor must only ever pair with a searcher, never with another
// survivor. Two unrelated 2-player matches can easily lose a player
// at close to the same moment; with a single shared tag both
// survivors would satisfy each other's filter and wrongly pair up
// with each other instead of each waiting for their own opponent.
const UNFINISHED_SURVIVOR_TAG = "unfinished-survivor::";
const UNFINISHED_SEARCHER_TAG = "unfinished-searcher::";

function _tagOf(name) {
    if (typeof name !== "string") return null;
    if (name.startsWith(UNFINISHED_SURVIVOR_TAG)) return "survivor";
    if (name.startsWith(UNFINISHED_SEARCHER_TAG)) return "searcher";
    return null;
}

function _untag(name) {
    if (typeof name !== "string") return name;
    if (name.startsWith(UNFINISHED_SURVIVOR_TAG)) return name.slice(UNFINISHED_SURVIVOR_TAG.length);
    if (name.startsWith(UNFINISHED_SEARCHER_TAG)) return name.slice(UNFINISHED_SEARCHER_TAG.length);
    return name;
}

// Mid-match reconnection: a disconnect just reruns the exact same
// _connect() a fresh match uses, rejoining the plain ROOM_CODE
// lobby - no separate room, tag or registry. Whoever this device
// pairs with next (first-come-first-served, same as any new match)
// is treated as the returning opponent. Whichever side still has an
// active Board when that pairing completes is, by definition, the
// one with live state to share (see the this.board !== null check
// in _checkMatchReady). Scoped to 2-player matches - see
// getStateSnapshot()'s forPlayerIndex in board.js.

export class Menu {
    constructor(root, startCallback = null) {
        this.root = root;
        this.startCallback = startCallback;

        this.frame = document.createElement("div");
        this.frame.className = "menu-frame";

        // ====================================================
        // GAME NETWORK
        // ====================================================
        this.gameNetwork = new GameNetwork(
            (remoteId, data) => this.onNetworkMessage(remoteId, data),
            (gameMode) => this.onMatchReady(gameMode),
            (error) => this.onNetworkError(error),
        );

        this.board = null;

        // Move/turn messages can arrive from the other player
        // before this device's own match-ready fires (their
        // WebRTC connection can settle before ours does). Buffer
        // them here instead of dropping them, and replay once
        // onMatchReady() creates this.board.
        this.pendingNetworkMessages = [];

        // "Searching for player..." overlay shown over the menu
        // while online matchmaking is in progress.
        this.searchingFrame = null;
        this._searchingDotsIntervalId = null;

        // Set once the player clicks Start -> Online (or opens an
        // invite link), so _shareInviteLink() can restart this exact
        // search into a private room without re-prompting for name.
        this._onlinePlayerName = null;
        this._onlineGameMode = null;
        this._activeInviteCode = null;

        this._buildUI();

        this.root.appendChild(this.frame);

        // If this page was opened via a shared invite link, skip the
        // menu entirely and connect straight to that friend's match.
        this._checkInviteLink();
    }

    // ========================================================
    // UI
    // ========================================================

    _buildUI() {
        // ====================================================
        // CENTER PANEL
        // ====================================================
        const panel = document.createElement("div");
        panel.className = "menu-panel";
        this.frame.appendChild(panel);
        this._panel = panel;

        const title = document.createElement("div");
        title.className = "menu-title";
        title.textContent = "Empire Chess";
        panel.appendChild(title);

        // ====================================================
        // MODE
        // ====================================================
        this.modeSelect = document.createElement("select");
        this.modeSelect.className = "menu-select";

        for (const mode of ["Classic", "4 Player", "6 Player", "Custom"]) {
            const option = document.createElement("option");
            option.value = mode;
            option.textContent = mode;
            this.modeSelect.appendChild(option);
        }

        const unfinishedOption = document.createElement("option");
        unfinishedOption.value = "Unfinished Match";
        unfinishedOption.textContent = "Unfinished Match";
        this.modeSelect.appendChild(unfinishedOption);

        panel.appendChild(this.modeSelect);

        // ====================================================
        // NETWORK MODE
        // ====================================================
        const networkLabel = document.createElement("div");
        networkLabel.className = "menu-label";
        networkLabel.textContent = "Network Mode";
        panel.appendChild(networkLabel);

        this.networkModeSelect = document.createElement("select");
        this.networkModeSelect.className = "menu-select";

        for (const mode of ["Offline", "Online"]) {
            const option = document.createElement("option");
            option.value = mode;
            option.textContent = mode;
            this.networkModeSelect.appendChild(option);
        }

        panel.appendChild(this.networkModeSelect);

        // ====================================================
        // START
        // ====================================================
        const startButton = document.createElement("button");
        startButton.className = "menu-button";
        startButton.textContent = "Start";
        startButton.addEventListener("click", () => this.startGame());
        panel.appendChild(startButton);

        // ====================================================
        // RULES
        // ====================================================
        const rulesButton = document.createElement("button");
        rulesButton.className = "menu-button";
        rulesButton.textContent = "Rules";
        rulesButton.addEventListener("click", () => this.showRules());
        panel.appendChild(rulesButton);

        // ====================================================
        // EXIT
        // ====================================================
        // A browser tab can't be closed programmatically from a
        // click handler in most browsers, so this is the closest
        // in-page equivalent to root.destroy().
        const exitButton = document.createElement("button");
        exitButton.className = "menu-button";
        exitButton.textContent = "Exit";
        exitButton.addEventListener("click", () => {
            this.frame.innerHTML = "";
            const message = document.createElement("div");
            message.className = "menu-exit-message";
            message.textContent = "You can close this tab now.";
            this.frame.appendChild(message);
        });
        panel.appendChild(exitButton);
    }

    // ========================================================
    // START MATCH
    // ========================================================

    async startGame() {
        try {
            const gameMode = this.modeSelect.value;
            const networkMode = this.networkModeSelect.value;

            // "Unfinished Match" is inherently online - it's not a
            // separate flow, just another entry in the same online
            // Start below, so it can pair with whoever it finds.
            if (gameMode === "Unfinished Match" && networkMode === "Offline") {
                alert("Unfinished Match requires Network Mode: Online.");
                return;
            }

            // ------------------------------------------------
            // OFFLINE
            // ------------------------------------------------
            // No MeshClient, no signaling server and no
            // networking callbacks are involved.
            // This is the clean Board/Pieces test path.
            if (networkMode === "Offline") {
                console.log(`[Menu] Starting OFFLINE game (${gameMode})`);

                this.hide();

                this.board = new Board(this.root, gameMode, () => this._returnToMenu());

                // 6-player mode starts with an empty board and a
                // placement phase (see startPlacementPhase()); every
                // other mode already has its fixed starting layout
                // from loadGame(), so this is a no-op for them.
                this.board.startPlacementPhase();

                return;
            }

            // ------------------------------------------------
            // ONLINE
            // ------------------------------------------------
            await this._startOnline(gameMode);
        } catch (e) {
            alert(`Error\n\nFailed to start match.\n\n${e}`);
        }
    }

    // ========================================================
    // START ONLINE (normal Start button, or an invite link)
    // ========================================================

    async _startOnline(gameMode, inviteCode = null) {
        let playerName = window.prompt("Enter your player name:", "");

        if (playerName === null) return;

        playerName = playerName.trim();

        if (!playerName) playerName = "Player";

        // Remembered so _shareInviteLink() can restart this exact
        // search into a private room without prompting for the name
        // a second time.
        this._onlinePlayerName = playerName;
        this._onlineGameMode = gameMode;
        this._activeInviteCode = inviteCode;

        console.log(
            `[Menu] Starting ONLINE match: ${playerName} (${gameMode})${inviteCode ? " via invite link" : ""}`,
        );

        // Hide menu immediately.
        this.hide();

        // Show the searching overlay until match-ready or an error
        // brings the menu back.
        this._showSearchingOverlay(inviteCode ? "Connecting to your friend" : "Searching for player");

        // Start matchmaking/networking.
        await this.gameNetwork.start(playerName, gameMode, inviteCode);
    }

    // ========================================================
    // INVITE LINK (opening a link a friend shared)
    // ========================================================

    _checkInviteLink() {
        const params = new URLSearchParams(window.location.search);
        const inviteCode = params.get("invite");

        if (!inviteCode) return;

        const allowedModes = ["Classic", "4 Player", "6 Player", "Custom"];
        const modeParam = params.get("mode");
        const gameMode = allowedModes.includes(modeParam) ? modeParam : "Classic";

        // Consume the link now, so refreshing later doesn't try to
        // rejoin a possibly-stale invite room (the friend who shared
        // it may have already matched with someone else or cancelled
        // by then - see the file-level note on this in
        // _shareInviteLink()).
        window.history.replaceState(null, "", window.location.pathname);

        this._startOnline(gameMode, inviteCode);
    }

    // ========================================================
    // MATCH READY
    // ========================================================

    onMatchReady(gameMode) {
        try {
            console.log("[Menu] Match ready.");

            this._hideSearchingOverlay();

            if (this.board !== null) {
                // A Board already exists for this session - do
                // not create a second one on top of it (this is a
                // backstop; GameNetwork.matchReady is the primary
                // guard against onMatchReady firing twice).
                console.log("[Menu] Match ready fired again - ignoring, board already exists.");
                return;
            }

            this.board = new Board(this.root, gameMode, () => this._returnToMenu());

            // Attach networking to board.
            this.board.setNetwork(this.gameNetwork);

            // Give GameNetwork a direct reference to this Board
            // for incoming MOVE/TURN messages.
            this.gameNetwork.setBoard(this.board);

            // ------------------------------------------------
            // LOCAL PLAYER IDENTITY
            // ------------------------------------------------
            // Tell the Board which player number THIS device is.
            // Without this, currentPlayer is shared game state
            // with no per-device ownership check, and any
            // connected machine could move whichever player's
            // pieces happen to be on turn.
            this.board.setLocalPlayer(this.gameNetwork.getMyIndex());

            // ------------------------------------------------
            // PLAYER NAMES FOR SIDE PANEL
            // ------------------------------------------------
            this.board.setPlayerNames(this.gameNetwork.getPlayerNames());

            // ------------------------------------------------
            // PLACEMENT PHASE
            // ------------------------------------------------
            // Must come after setLocalPlayer()/setPlayerNames() -
            // placement needs to know which player this device is
            // and whose name to show. No-op for any mode other than
            // 6-player (see startPlacementPhase()).
            this.board.startPlacementPhase();

            // ------------------------------------------------
            // REPLAY BUFFERED MESSAGES
            // ------------------------------------------------
            // Anything that arrived from the other player while
            // this.board was still null above got queued instead
            // of dropped - apply it now, in the order it arrived.
            if (this.pendingNetworkMessages.length) {
                const pending = this.pendingNetworkMessages;
                this.pendingNetworkMessages = [];

                for (const [remoteId, data] of pending) {
                    this.onNetworkMessage(remoteId, data);
                }
            }
        } catch (e) {
            alert(`Game Error\n\nFailed to start game.\n\n${e}`);
        }
    }

    // ========================================================
    // NETWORK ERROR
    // ========================================================

    onNetworkError(error) {
        // Called when GameNetwork fails to connect/start a match
        // (e.g. the signaling server is unreachable). The menu was
        // already hidden in anticipation of the match starting -
        // bring it back so the player isn't left looking at an
        // empty window with no way to retry.
        if (this.board === null) {
            // Only restore the menu if a Board never got created -
            // if somehow this fires mid-match, don't rip the board
            // away.
            this._hideSearchingOverlay();
            this.show();
        }
    }

    // ========================================================
    // NETWORK MESSAGE
    // ========================================================

    onNetworkMessage(remoteId, data) {
        const messageType = data.type;

        if (this.board === null) {
            // This device's own Board hasn't been created yet -
            // don't drop the message, it may be the other
            // player's opening move/turn arriving early. Replay
            // happens in onMatchReady() once this.board exists.
            this.pendingNetworkMessages.push([remoteId, data]);
            return;
        }

        if (messageType === "move") {
            this.board.handleNetworkMove(remoteId, data);
        } else if (messageType === "turn") {
            this.board.handleNetworkTurn(data.player_index);
        } else if (messageType === "placement") {
            this.board.handleNetworkPlacement(remoteId, data);
        } else if (messageType === "chat") {
            this.board.handleNetworkChat(this.gameNetwork.getPlayerIndexOf(remoteId), data);
        } else if (messageType === "sync_state") {
            this.board.applyStateSync(data);

            if (typeof data.forPlayerIndex === "number") {
                this.gameNetwork.overridePlayerIndex = data.forPlayerIndex;
                this.board.setLocalPlayer(this.gameNetwork.overridePlayerIndex);
            }
        }
    }

    // ========================================================
    // SEARCHING OVERLAY
    // ========================================================
    // Shown over the menu while online matchmaking is in
    // progress, so the screen isn't just blank between clicking
    // "Start" and either the match becoming ready or an error.

    _showSearchingOverlay(baseLabel = "Searching for player") {
        if (this.searchingFrame !== null) return;

        this._searchingBaseLabel = baseLabel;

        this.searchingFrame = document.createElement("div");
        this.searchingFrame.className = "searching-frame";

        this._searchingLabel = document.createElement("div");
        this._searchingLabel.className = "searching-label";
        this._searchingLabel.textContent = baseLabel;
        this.searchingFrame.appendChild(this._searchingLabel);

        const cancelButton = document.createElement("button");
        cancelButton.className = "menu-button";
        cancelButton.textContent = "Cancel";
        cancelButton.addEventListener("click", () => this._cancelSearching());
        this.searchingFrame.appendChild(cancelButton);

        const shareButton = document.createElement("button");
        shareButton.className = "menu-button";
        shareButton.textContent = "Share invite link";
        shareButton.addEventListener("click", () => this._shareInviteLink(shareButton));
        this.searchingFrame.appendChild(shareButton);

        this.root.appendChild(this.searchingFrame);

        this._tickSearchingDots(0);
    }

    // ========================================================
    // SHARE INVITE LINK
    // ========================================================
    // Guarantees the link only ever pairs the two people who hold
    // it - the first click switches THIS search from the public
    // matchmaking pool into a fresh, dedicated private room (see the
    // inviteRoomCode branch in GameNetwork._connect()), rather than
    // sharing whichever public room this device happened to land in,
    // which unrelated strangers could also be waiting in.
    //
    // The link only works while this device is still on this exact
    // "searching" screen - if the search is cancelled or a match is
    // found (either way, this overlay - and the button - disappear),
    // the private room is left with nobody in it, so opening the
    // link afterward just waits harmlessly rather than pairing the
    // friend with anyone unintended.

    async _shareInviteLink(button) {
        if (!this._activeInviteCode) {
            this._activeInviteCode = (
                window.crypto && window.crypto.randomUUID
                    ? window.crypto.randomUUID()
                    : `${Date.now()}-${Math.random()}`
            )
                .replace(/-/g, "")
                .slice(0, 10);

            this._searchingBaseLabel = "Waiting for your friend";

            this.gameNetwork.start(this._onlinePlayerName, this._onlineGameMode, this._activeInviteCode);
        }

        const link =
            `${window.location.origin}${window.location.pathname}` +
            `?invite=${encodeURIComponent(this._activeInviteCode)}` +
            `&mode=${encodeURIComponent(this._onlineGameMode)}`;

        if (navigator.share) {
            try {
                await navigator.share({ title: "Join my Empire Chess match", url: link });
                return;
            } catch (error) {
                // Cancelled by the user, or unsupported mid-call -
                // fall through to the clipboard copy below.
            }
        }

        try {
            await navigator.clipboard.writeText(link);

            const original = button.textContent;
            button.textContent = "Link copied!";

            setTimeout(() => {
                button.textContent = original;
            }, 1800);
        } catch (error) {
            window.prompt("Copy this invite link:", link);
        }
    }

    _tickSearchingDots(step) {
        if (this.searchingFrame === null) return;

        const dots = ".".repeat(step % 4);

        this._searchingLabel.textContent = `${this._searchingBaseLabel}${dots}`;

        this._searchingDotsIntervalId = setTimeout(() => this._tickSearchingDots(step + 1), 500);
    }

    _hideSearchingOverlay() {
        if (this._searchingDotsIntervalId !== null) {
            clearTimeout(this._searchingDotsIntervalId);
            this._searchingDotsIntervalId = null;
        }

        if (this.searchingFrame !== null) {
            this.searchingFrame.remove();
            this.searchingFrame = null;
        }
    }

    _cancelSearching() {
        this._hideSearchingOverlay();
        this.gameNetwork.close();
        this.show();
    }

    // ========================================================
    // RULES
    // ========================================================

    showRules() {
        alert(
            "Rules\n\n" +
                "\u2022 Select a piece with the left mouse button.\n\n" +
                "\u2022 Click a highlighted square to move.\n\n" +
                "\u2022 Red dots indicate captures.\n\n" +
                "\u2022 Blue dots indicate legal moves.\n\n" +
                "\u2022 Defeat the enemy King to win.\n\n" +
                "\u2022 Classic pawns: move forward one square (two on their first move), capture only diagonally.\n\n" +
                "\u2022 Classic pawns reaching the last row promote to Queen.\n\n" +
                "\u2022 Collector (\u{1F608}, 4-player mode): moves like a Queen. Capturing a piece from an " +
                "already-defeated player recruits it instead of removing it. Lose the Collector and every " +
                "piece it recruited is lost too. Every player's Collector uses the same emoji - check the " +
                "colored disc behind it (matches that player's piece color) to tell whose it is.\n\n" +
                "\u2022 6-player mode: before the match starts, every player gets 2 minutes to arrange " +
                "their own 16-piece army within their own corner region. Pick a piece type on the " +
                "right, then click a cell in your region to place it (click a placed piece to pick " +
                "it back up). Confirm early or wait out the timer - anything left unplaced when your " +
                "time is up is placed randomly in your own remaining empty cells.\n\n" +
                "\u2022 Unfinished Match: when an online match's connection breaks, the still-connected " +
                "side keeps waiting for 2 minutes. Pick this mode to join whoever you're paired with " +
                "next mid-game instead of a fresh board - a tougher, more realistic practice starting " +
                "point.\n\n" +
                "\u2022 Online matches have a chat panel. In 4/6 Player it has an All tab plus a private " +
                "tab per opponent, and \"Send alliance request\" in a private tab types a suggested " +
                "message you can edit before sending - it's only a message, alliances aren't tracked or " +
                "enforced. The newest request is pinned at the top of that private chat for both of you. " +
                "2-player matches skip the tabs and alliance button entirely, since there's only one " +
                "person to talk to.",
        );
    }

    // ========================================================
    // SHOW / HIDE
    // ========================================================

    show() {
        this.frame.style.display = "";
    }

    hide() {
        this.frame.style.display = "none";
    }

    _returnToMenu() {
        // Board.back() only tears down its own DOM/network - without
        // this, this.board keeps pointing at the old (now-removed)
        // Board object, so a later match in the same tab wrongly
        // thinks it already has a live board (skipping creation of a
        // real one) and wrongly broadcasts that stale board's state
        // as if it were a survivor's.
        this.board = null;
        this.show();
    }
}

// ============================================================
// GAME NETWORK
// ============================================================

class GameNetwork {
    // Runs MeshClient directly - no background asyncio loop is
    // needed since the browser event loop already handles
    // WebSocket/WebRTC events without blocking the UI.

    constructor(onMessage = null, onMatchReady = null, onError = null) {
        this.onMessage = onMessage;
        this.onMatchReady = onMatchReady;
        this.onError = onError;

        this.client = null;

        this.playerName = null;
        this.gameMode = null;

        // Current game board. Set after an online match is ready.
        this.board = null;

        // {playerIndex: playerName} from the last room_state - used
        // to show real names in Board's side panel instead of just
        // "Player N".
        this.roomPlayers = {};

        // Set once onMatchReady has actually fired for this
        // session. Guards against _checkMatchReady() re-passing
        // later (e.g. a stale/closing channel still briefly
        // reporting "open" right as a peer leaves) and firing
        // onMatchReady a second time mid-match.
        this.matchReady = false;

        // The remote player id(s) this match is actually locked to,
        // captured once at match-ready (see _checkMatchReady).
        // Empty until then.
        this.matchedRemoteIds = new Set();

        // Set at the start of an intentional close() so the
        // connectionstatechange events it triggers aren't mistaken
        // for an unexpected mid-match drop by _connectionChanged().
        this.isClosing = false;

        // Set only once this device takes over a returning/joining
        // seat via a sync_state message (see Menu.onNetworkMessage) -
        // the server's own freshly-assigned index doesn't match this
        // device's true identity in an ongoing game.
        this.overridePlayerIndex = null;

        // Set to the vanished opponent's remoteId while a mid-match
        // disconnect reconnect attempt is in flight - see
        // _startBackgroundReconnect(). null otherwise.
        this._pendingDisconnectRemoteId = null;

        // Bumped every time _connect() runs. _connectToAvailableRoom()
        // is a multi-step async loop (probes shard after shard) - if
        // a NEWER _connect() call starts while an older one is still
        // probing (e.g. Share is clicked mid-probe, switching to a
        // private invite room), the older probe checks this after
        // every await and quietly closes itself instead of finishing
        // late and clobbering this.client out from under the newer,
        // already-active connection.
        this._connectEpoch = 0;

        // Set only for a fresh match started via an invite link (see
        // Menu._shareInviteLink/_checkInviteLink) - routes _connect()
        // straight to a dedicated private room instead of the public
        // sharded pool. Ignored during survivor/searcher reconnect
        // (see _connect()) - a disconnect always falls back to the
        // public "Unfinished Match" pool regardless of how the
        // original match started.
        this._inviteRoomCode = null;
    }

    // ========================================================
    // START
    // ========================================================

    async start(playerName, gameMode, inviteCode = null) {
        this.playerName = playerName;
        this.gameMode = gameMode;
        this._inviteRoomCode = inviteCode;

        // Fresh attempt on this same instance (e.g. Cancel was hit
        // during a previous search, then Start was clicked again) -
        // clear flags from that previous attempt.
        this.isClosing = false;
        this.matchReady = false;
        this.matchedRemoteIds = new Set();
        this.overridePlayerIndex = null;
        this._pendingDisconnectRemoteId = null;

        try {
            await this._connect();
        } catch (error) {
            console.log("[GameNetwork] Network error:", error);
            this._showNetworkError(error);
        }
    }

    // ========================================================
    // BOARD CONNECTION
    // ========================================================

    setBoard(board) {
        this.board = board;
    }

    // ========================================================
    // LOCAL PLAYER IDENTITY
    // ========================================================

    getMyIndex() {
        // Return this device's assigned player number (1..N), or
        // null if the client hasn't been registered by the
        // signaling server yet. overridePlayerIndex is set only
        // when rejoining an unfinished match, where the server
        // assigns a fresh index in the new room that doesn't
        // match this device's actual identity in the ongoing game.
        if (this.overridePlayerIndex !== null) return this.overridePlayerIndex;

        if (this.client === null) return null;

        return this.client.myIndex;
    }

    // ========================================================
    // CONNECT
    // ========================================================

    _wireClient(client) {
        client.setGameMessageCallback((remoteId, data) => this._gameMessageReceived(remoteId, data));
        client.setConnectionCallback((remoteId, state) => this._connectionChanged(remoteId, state));
        client.setRoomStateCallback((players) => this._roomStateReceived(players));
        client.setChannelOpenCallback(() => this._checkMatchReady());
        client.setPlayerLeftCallback((playerId, playerName) => this._playerLeft(playerId, playerName));
    }

    _requiredPlayers() {
        if (this._pendingDisconnectRemoteId !== null) return 2;

        return (
            { Classic: 2, "4 Player": 4, "6 Player": 6, Custom: 2, "Unfinished Match": 2 }[this.gameMode] ?? 2
        );
    }

    async _connect() {
        // Tagged when this device is either the surviving side of a
        // mid-match disconnect (_pendingDisconnectRemoteId set by
        // _startBackgroundReconnect before calling this) or a player
        // who picked "Unfinished Match" mode fresh - both sides of
        // the intended pairing, and nobody else.
        const isSurvivor = this._pendingDisconnectRemoteId !== null;
        const isSearcher = this.gameMode === "Unfinished Match";
        const tagPrefix = isSurvivor ? UNFINISHED_SURVIVOR_TAG : isSearcher ? UNFINISHED_SEARCHER_TAG : "";
        const registeredName = tagPrefix + this.playerName;

        // A previous this.client (e.g. the now-dead connection from
        // before a mid-match disconnect) must be fully closed before
        // replacing it - otherwise its signaling registration lingers
        // in the room, auto-negotiates WebRTC with whoever shows up
        // next (including this device's own new registration), and
        // its still-wired callbacks cross-talk with the real one.
        if (this.client) {
            try {
                this.client.close();
            } catch (error) {
                // ignore
            }
        }

        if (isSurvivor || isSearcher) {
            this.client = new MeshClient(SIGNALING_SERVER_URL);
            this._wireClient(this.client);
            await this.client.connect(registeredName, ROOM_CODE);
        } else if (this._inviteRoomCode) {
            // A dedicated private room, entirely outside the public
            // shard pool - only someone with this exact link/code
            // can ever land here, so no sharding or tagging (both
            // there to keep UNRELATED strangers apart) is needed.
            this.client = new MeshClient(SIGNALING_SERVER_URL);
            this._wireClient(this.client);
            this.client.setMaxPeers(this._requiredPlayers() - 1);
            await this.client.connect(registeredName, `invite-${this._inviteRoomCode}`);
        } else {
            // Only capped/sharded for a normal match - reconnect/
            // search already has its own tag + lowest-index pairing
            // safety net (see _checkMatchReady), and either of these
            // could let an unrelated peer get in the way before the
            // real tagged partner is even found.
            await this._connectToAvailableRoom(registeredName, this._requiredPlayers());
        }

        console.log(`[GameNetwork] ${this.playerName} connected${tagPrefix ? ` (tag=${isSurvivor ? "survivor" : "searcher"})` : ""}.`);
    }

    async _connectToAvailableRoom(registeredName, requiredPlayers) {
        const slug = _roomSlug(this.gameMode);

        for (let shard = 1; shard <= MAX_ROOM_SHARDS; shard++) {
            const roomCode = shard === 1 ? `${ROOM_CODE}-${slug}` : `${ROOM_CODE}-${slug}-${shard}`;
            const client = new MeshClient(SIGNALING_SERVER_URL);

            const firstRoomState = new Promise((resolve) => {
                client.setRoomStateCallback((players) => resolve(players));
                setTimeout(() => resolve(null), 1500);
            });

            await client.connect(registeredName, roomCode);

            const players = await firstRoomState;
            const occupants = players ? players.filter((p) => p.id !== client.myId).length : 0;

            if (occupants < requiredPlayers) {
                this._wireClient(client); // replaces the probe callback above with the real ones
                client.setMaxPeers(requiredPlayers - 1);
                this.client = client;

                console.log(`[GameNetwork] Joined room ${roomCode} (${occupants + 1}/${requiredPlayers}).`);

                return;
            }

            console.log(`[GameNetwork] Room ${roomCode} full (${occupants}+), trying next shard.`);

            try {
                client.close();
            } catch (error) {
                // ignore
            }
        }

        throw new Error("All room shards are currently full - try again shortly.");
    }

    // ========================================================
    // ROOM STATE
    // ========================================================

    _roomStateReceived(players) {
        console.log(`[GameNetwork] Room players: ${players.length}`);

        for (const player of players) {
            console.log(`  P${player.index} ${player.name}`);
        }

        this.roomPlayers = {};
        for (const player of players) {
            this.roomPlayers[player.index] = _untag(player.name);
        }

        this._checkMatchReady();
    }

    getPlayerNames() {
        // Return the last known {playerIndex: playerName} map.
        return { ...this.roomPlayers };
    }

    // ========================================================
    // WEBRTC CONNECTION
    // ========================================================

    _connectionChanged(remoteId, state) {
        console.log(`[GameNetwork] ${remoteId}: ${state}`);

        // ------------------------------------------------
        // MATCH ISOLATION
        // ------------------------------------------------
        // Once matched, this session must never react to some
        // OTHER connection in the same signaling room - e.g. the
        // original opponent's connection dropped, they restarted
        // the app, and rejoined the same default room as a brand
        // new session. That's a different session and has nothing
        // to do with this match.
        if (this.matchReady && !this.matchedRemoteIds.has(remoteId)) {
            console.log(`[GameNetwork] Ignoring ${remoteId} - not part of this match.`);
            return;
        }

        if (state === "connected") {
            this._checkMatchReady();

            // Peer (re)connected - if a disconnect grace-period
            // timer was running for them, cancel it.
            if (this.board !== null) {
                this.board.cancelDisconnectTimer(remoteId);
            }

            return;
        }

        // ------------------------------------------------
        // DISCONNECT GRACE PERIOD (mid-match only)
        // ------------------------------------------------
        // Pre-match connection hiccups are already handled by the
        // matchmaking/ready-check flow above - this only matters
        // once a match is actually underway. isClosing guards
        // against an INTENTIONAL close() (match ended normally, or
        // the player hit Back/Cancel) being mistaken for the
        // opponent unexpectedly dropping.
        if (
            this.matchReady &&
            !this.isClosing &&
            this.board !== null &&
            ["disconnected", "failed", "closed"].includes(state)
        ) {
            const remotePlayer = this.client !== null ? this.client.players[remoteId] || {} : {};

            this.board.startDisconnectTimer(remoteId, _untag(remotePlayer.name), remotePlayer.index);
            this._startBackgroundReconnect(remoteId);
        }
    }

    getPlayerName(remoteId) {
        // Look up a connected/known player's display name.
        if (this.client === null) return null;

        try {
            return _untag(this.client.getPlayerName(remoteId));
        } catch (error) {
            return null;
        }
    }

    _playerLeft(playerId, playerName) {
        // Fired when the signaling server confirms a player has
        // actually left the room (a stronger signal than a WebRTC
        // connectionstatechange blip). Starts the same disconnect
        // timer if a match is already running.
        const displayName = _untag(playerName);
        console.log(`[GameNetwork] ${displayName} left the room.`);

        if (this.matchReady && this.matchedRemoteIds.has(playerId) && this.board !== null) {
            this.board.startDisconnectTimer(playerId, displayName);

            // This signaling-layer event is what actually fires
            // reliably when a tab just vanishes (closed, crashed,
            // network gone) - the WebRTC peer connection's own
            // connectionstatechange can lag far behind or never fire
            // cleanly at all in that case. _startBackgroundReconnect
            // already guards against running twice, so it's safe to
            // call from here even if _connectionChanged also manages
            // to fire for the same drop.
            this._startBackgroundReconnect(playerId);
        }
    }

    // ========================================================
    // CHECK MATCH
    // ========================================================

    _checkMatchReady() {
        if (!this.client) return;

        if (this.matchReady) {
            // Already started this session - a later room_state
            // or connectionstatechange event (e.g. a peer leaving
            // mid-match) must not re-run this and fire
            // onMatchReady a second time.
            return;
        }

        const requiredPlayers = this._requiredPlayers();

        // A survivor only ever counts a searcher as a candidate (never
        // another survivor), a searcher only ever counts a survivor,
        // and a normal fresh player only counts other untagged
        // players - see the file-level note on the two tag constants.
        const isSurvivor = this._pendingDisconnectRemoteId !== null;
        const isSearcher = this.gameMode === "Unfinished Match";
        const wantTag = isSurvivor ? "searcher" : isSearcher ? "survivor" : null;
        let connectedPlayers = this.client
            .getConnectedPlayers()
            .filter((player) => _tagOf(player.name) === wantTag);

        if (wantTag !== null && connectedPlayers.length > 1) {
            // Multiple unfinished matches can be waiting in the
            // shared lobby at once - WebRTC's full mesh may connect
            // this device to more than one tag-matching candidate
            // simultaneously. Commit to exactly ONE partner rather
            // than grabbing all of them into matchedRemoteIds (which
            // would merge two unrelated matches into one 3-way mess).
            // Sorting by the server-assigned index gives every
            // device the same answer independently, so a survivor
            // and its intended searcher converge on each other even
            // when other unrelated survivors/searchers are also
            // present - though a genuinely uneven number on each
            // side (e.g. two searchers both preferring the same
            // survivor) can still leave the odd one waiting rather
            // than corrupting anything.
            connectedPlayers = [connectedPlayers.sort((a, b) => a.index - b.index)[0]];
        }

        const connected = connectedPlayers.length + 1;

        console.log(
            `[GameNetwork] Ready check: ${connected}/${requiredPlayers} ` +
                `(wantTag=${wantTag}, candidates=[${connectedPlayers.map((p) => p.name).join(", ")}])`,
        );

        // For now, the game starts once the required player count
        // has established P2P connections.
        if (connected < requiredPlayers) return;

        // Check all remote channels.
        for (const player of connectedPlayers) {
            if (!this.client.isConnected(player.id)) return;
        }

        console.log("[GameNetwork] MATCH READY");

        this.matchReady = true;

        // Lock this match to exactly these opponent(s). Anything
        // that connects to this room AFTER this point must never be
        // treated as part of THIS match - see _connectionChanged()
        // and _gameMessageReceived(), which check this set before
        // acting on anything.
        this.matchedRemoteIds = new Set(connectedPlayers.map((player) => player.id));

        // Do NOT leave the signaling lobby here. It's tempting to
        // "clean up" by sending leave_room now that WebRTC is
        // established, but this server treats ANY departure -
        // intentional or not - identically: it broadcasts peer_left
        // to the opponent, whose client then closes the very peer
        // connection/data channel this match just finished setting
        // up. That's the exact bug where one side's match never
        // completes and the other immediately sees a disconnect
        // timer, the moment a match starts. The signaling socket
        // stays open and idle for the rest of the match instead -
        // harmless, and it's only really torn down by close() at
        // actual game-end (see the file-level note in leaveLobby()
        // below).

        if (this.board !== null) {
            // A Board already exists on this device, which by
            // definition means it's the side with live state to
            // share - a fresh match/join never reaches this branch,
            // since neither side has a Board yet at that point.
            if (this._pendingDisconnectRemoteId !== null) {
                this.board.cancelDisconnectTimer(this._pendingDisconnectRemoteId);
                this._pendingDisconnectRemoteId = null;
            }

            this.client.broadcast({ type: "sync_state", ...this.board.getStateSnapshot() });
        }

        if (this.onMatchReady) {
            this.onMatchReady(this.gameMode);
        }
    }

    // ========================================================
    // INCOMING MESSAGE
    // ========================================================

    _gameMessageReceived(remoteId, data) {
        // MATCH ISOLATION - see _connectionChanged() for why. A
        // move/turn message from some OTHER session in the same
        // room (not this match's locked-in opponent) must never
        // reach this match's Board.
        if (this.matchReady && !this.matchedRemoteIds.has(remoteId)) {
            console.log(`[GameNetwork] Ignoring game message from ${remoteId} - not part of this match.`);
            return;
        }

        // sync_state falls through to onMessage/Menu, same as move,
        // turn and placement - Menu already buffers any message that
        // arrives before this.board exists and replays it once
        // onMatchReady() creates it, which sync_state needs just as
        // much as they do (the two sides' data channels open at
        // nearly the same instant, so this message can easily arrive
        // before this device has finished creating its own Board).

        if (this.onMessage) {
            this.onMessage(remoteId, data);
        }
    }

    // ========================================================
    // SEND MOVE
    // ========================================================

    sendMove(pieceId, fromPos, toPos) {
        if (!this.client) return 0;

        const message = makeMove(pieceId, fromPos, toPos);

        return this.client.broadcast(message);
    }

    // ========================================================
    // SEND TURN
    // ========================================================

    sendTurn(playerIndex) {
        if (!this.client) return 0;

        const message = makeTurn(playerIndex);

        return this.client.broadcast(message);
    }

    // ========================================================
    // CHAT
    // ========================================================

    getPlayerIndexOf(remoteId) {
        const player = this.client ? this.client.players[remoteId] : null;

        return player ? player.index : null;
    }

    sendChat(to, text, kind) {
        if (!this.client) return 0;

        const message = { type: "chat", to, text, kind };

        if (to === "all") return this.client.broadcast(message);

        for (const player of Object.values(this.client.players)) {
            if (player.index === to && this.client.sendToPlayer(player.id, message)) return 1;
        }

        return 0;
    }

    // ========================================================
    // SEND PLACEMENT
    // ========================================================

    sendPlacement(player, placements) {
        if (!this.client) return 0;

        const message = makePlacement(player, placements);

        return this.client.broadcast(message);
    }

    // ========================================================
    // MID-MATCH RECONNECTION
    // ========================================================

    async _startBackgroundReconnect(remoteId) {
        if (this._pendingDisconnectRemoteId !== null) return;

        // Unfinished-match reconnect only makes sense for 2-player
        // games: the tag pool has no way to say WHICH seat is
        // missing, so in a 3+ survivor game every survivor trying
        // this at once would just collide with each other instead
        // of waiting for the one specific player who left.
        if (this.board === null || this.board.players !== 2) return;

        this._pendingDisconnectRemoteId = remoteId;
        this.matchReady = false;
        this.matchedRemoteIds = new Set();

        try {
            // Same method, same ROOM_CODE lobby a fresh match uses -
            // this.playerName/this.gameMode are still whatever this
            // match started with, so whoever this device pairs with
            // next is treated as the returning opponent.
            await this._connect();
        } catch (error) {
            console.log("[GameNetwork] Background reconnect failed, will retry on next state change:", error);
            this._pendingDisconnectRemoteId = null;
        }
    }

    // ========================================================
    // NETWORK ERROR
    // ========================================================

    _showNetworkError(error) {
        alert(`Network Error\n\nUnable to start match.\n\n${error}`);

        // Let the app layer react - e.g. Menu bringing its own
        // screen back, since this device's match never started.
        if (this.onError) this.onError(error);
    }

    // ========================================================
    // CLOSE
    // ========================================================

    close() {
        // Marked BEFORE anything actually closes, so the
        // connectionstatechange events this triggers (moving
        // through "closing"/"closed") are recognized as an
        // intentional shutdown rather than an unexpected drop -
        // see _connectionChanged(), which checks this before
        // starting a disconnect grace-period timer.
        this.isClosing = true;
        this._pendingDisconnectRemoteId = null;

        if (this.client) {
            this.client.close();
        }
    }

    leaveLobby() {
        // Close only the signaling (matchmaking lobby) connection.
        // The real MeshClient exposes this as leaveRoom() (there is
        // no close_signaling_only() - see the file-level note above)
        // - it tells the server this player is no longer registered
        // in the room, without touching the already-open WebRTC
        // data channel used for gameplay.
        if (!this.client) return;

        try {
            this.client.leaveRoom();
        } catch (error) {
            console.log(`[GameNetwork] Error leaving lobby: ${error}`);
        }
    }
}