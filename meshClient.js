// ============================================================
// meshClient.js  (ported from mesh_client.py)
// ============================================================
// aiortc -> native RTCPeerConnection, websockets -> native
// WebSocket, asyncio -> plain async/await. The wire protocol
// (register / join_room / room_state / peer_joined / signal
// offer|answer / peer_left / registered / error) is unchanged,
// so the existing signaling server (worker.js) needs no changes.

export class MeshClient {
    // Reusable full-mesh WebRTC client.
    //
    // Responsibilities:
    // - Connect to the signaling server.
    // - Register the local player.
    // - Maintain one RTCPeerConnection per remote player.
    // - Maintain one DataChannel per remote player.
    // - Exchange WebRTC offers/answers through signaling.
    // - Send/receive JSON game messages.
    // - Notify the game through callbacks.
    //
    // It intentionally has no UI of its own.

    constructor(signalingServer = "ws://127.0.0.1:8765") {
        this.signalingServer = signalingServer;

        this.websocket = null;

        // playerId -> RTCPeerConnection
        this.peers = {};

        // playerId -> RTCDataChannel
        this.channels = {};

        // playerId -> player information
        this.players = {};

        // Local player information
        this.myId = null;
        this.myIndex = null;
        this.role = null;
        this.name = null;
        this.roomCode = null;

        // Fetched once per connection from the Worker's
        // /turn-credentials endpoint (see worker.js) and reused for
        // every RTCPeerConnection this client creates.
        this._iceServersPromise = null;

        // Prevent duplicate offers.
        this.offerStarted = new Set();

        // Caps how many peers this client will actually negotiate
        // WebRTC with. Without this, every player in the shared
        // signaling room full-meshes with every other player
        // regardless of how many any single match needs - matches
        // still resolve correctly (isolated by matchedRemoteIds
        // upstream), but every extra connection is pure waste.
        // Infinity = uncapped (the default, and always used for
        // unfinished-match reconnect/search - see menu.js).
        this.maxPeers = Infinity;

        // Prevent simultaneous peer creation racing each other.
        // asyncio.Lock() ported as a promise chain "mutex" since JS
        // has no native async lock primitive.
        this._lockChain = Promise.resolve();

        // Optional callbacks used by board/network integration.
        this.onGameMessage = null;
        this.onPlayerJoined = null;
        this.onPlayerLeft = null;
        this.onConnectionChanged = null;
        this.onRoomState = null;
        this.onChannelOpen = null;
    }

    // =========================================================
    // CALLBACK SETTERS
    // =========================================================

    setGameMessageCallback(callback) {
        this.onGameMessage = callback;
    }

    setPlayerJoinedCallback(callback) {
        this.onPlayerJoined = callback;
    }

    setPlayerLeftCallback(callback) {
        this.onPlayerLeft = callback;
    }

    setConnectionCallback(callback) {
        this.onConnectionChanged = callback;
    }

    setRoomStateCallback(callback) {
        this.onRoomState = callback;
    }

    setChannelOpenCallback(callback) {
        // Fired when a DataChannel to a specific remote player
        // actually finishes opening - distinct from the peer
        // connection's ICE state reaching "connected", which can
        // fire slightly BEFORE the channel itself is open. A
        // ready-check driven only by the ICE state can undercount
        // for a moment right as a match becomes playable.
        this.onChannelOpen = callback;
    }

    // =========================================================
    // LOCK (port of asyncio.Lock's mutual-exclusion around peer
    // creation - the exact ordering guarantee, not the exact API)
    // =========================================================

    async _withLock(fn) {
        const previous = this._lockChain;
        let release;
        this._lockChain = new Promise((resolve) => {
            release = resolve;
        });

        await previous;

        try {
            return await fn();
        } finally {
            release();
        }
    }

    // =========================================================
    // SIGNALING SERVER COMMUNICATION
    // =========================================================

    sendJson(data) {
        if (this.websocket === null) {
            throw new Error("MeshClient is not connected.");
        }

        this.websocket.send(JSON.stringify(data));
    }

    sendSignal(targetId, signalType, extra = {}) {
        const message = {
            type: "signal",
            target_id: targetId,
            signal_type: signalType,
            ...extra,
        };

        this.sendJson(message);
    }

    // =========================================================
    // WEBRTC PEER CREATION
    // =========================================================

    async getOrCreatePeer(remotePlayer) {
        const remoteId = remotePlayer.id;

        if (this.peers[remoteId]) return this.peers[remoteId];

        const iceServers = await this._iceServersPromise;

        return this._withLock(() => {
            if (this.peers[remoteId]) return this.peers[remoteId];

            const peer = new RTCPeerConnection({ iceServers });

            this.peers[remoteId] = peer;
            this.players[remoteId] = remotePlayer;

            peer.onconnectionstatechange = () => {
                const state = peer.connectionState;

                if (this.onConnectionChanged) {
                    this.onConnectionChanged(remoteId, state);
                }
            };

            // Kept as an event hook for future diagnostics. ICE is
            // gathered into SDP (non-trickle) in this prototype.
            peer.oniceconnectionstatechange = () => {};

            peer.ondatachannel = (event) => {
                this.setupChannel(remoteId, event.channel);
            };

            return peer;
        });
    }

    // =========================================================
    // DATA CHANNEL
    // =========================================================

    setupChannel(remoteId, channel) {
        this.channels[remoteId] = channel;

        channel.onopen = () => {
            console.log(`[MeshClient] DataChannel open: ${this.getPlayerName(remoteId)}`);

            if (this.onChannelOpen) {
                this.onChannelOpen(remoteId);
            }
        };

        channel.onmessage = (event) => {
            this.handleGameMessage(remoteId, event.data);
        };

        channel.onclose = () => {
            console.log(`[MeshClient] DataChannel closed: ${this.getPlayerName(remoteId)}`);
        };
    }

    handleGameMessage(remoteId, message) {
        let data;

        try {
            data = JSON.parse(message);
        } catch (error) {
            console.log(`[MeshClient] Invalid game message from ${this.getPlayerName(remoteId)}`);
            return;
        }

        if (this.onGameMessage) {
            this.onGameMessage(remoteId, data);
        }
    }

    // =========================================================
    // ICE GATHERING
    // =========================================================

    waitForIce(peer) {
        if (peer.iceGatheringState === "complete") {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const check = () => {
                if (peer.iceGatheringState === "complete") {
                    peer.removeEventListener("icegatheringstatechange", check);
                    resolve();
                }
            };

            peer.addEventListener("icegatheringstatechange", check);
        });
    }

    // =========================================================
    // OFFER CREATION
    // =========================================================

    setMaxPeers(maxPeers) {
        this.maxPeers = Number.isInteger(maxPeers) && maxPeers > 0 ? maxPeers : Infinity;
    }

    _atPeerCapacity(remoteId) {
        return !this.peers[remoteId] && Object.keys(this.peers).length >= this.maxPeers;
    }

    async createOffer(remotePlayer) {
        const remoteId = remotePlayer.id;
        const remoteIndex = remotePlayer.index;

        // Lower player number starts negotiation.
        if (this.myIndex === null || this.myIndex >= remoteIndex) return;

        if (this.offerStarted.has(remoteId)) return;

        if (this._atPeerCapacity(remoteId)) return;

        this.offerStarted.add(remoteId);

        try {
            const peer = await this.getOrCreatePeer(remotePlayer);

            const channel = peer.createDataChannel("game");

            this.setupChannel(remoteId, channel);

            const offer = await peer.createOffer();

            await peer.setLocalDescription(offer);

            // This prototype waits for ICE candidates to be
            // included in the SDP before sending the offer.
            await this.waitForIce(peer);

            this.sendSignal(remoteId, "offer", {
                sdp: peer.localDescription.sdp,
                description_type: peer.localDescription.type,
            });
        } catch (error) {
            this.offerStarted.delete(remoteId);
            throw error;
        }
    }

    // =========================================================
    // HANDLE OFFER
    // =========================================================

    async handleOffer(data) {
        const remoteId = data.from_id;
        const remotePlayer = this.players[remoteId];

        if (remotePlayer === undefined) {
            console.log(`[MeshClient] Offer from unknown player: ${remoteId}`);
            return;
        }

        if (this._atPeerCapacity(remoteId)) {
            console.log(`[MeshClient] Ignoring offer from ${remoteId} - already at max peers (${this.maxPeers}).`);
            return;
        }

        const peer = await this.getOrCreatePeer(remotePlayer);

        await peer.setRemoteDescription({
            sdp: data.sdp,
            type: data.description_type,
        });

        const answer = await peer.createAnswer();

        await peer.setLocalDescription(answer);

        await this.waitForIce(peer);

        this.sendSignal(remoteId, "answer", {
            sdp: peer.localDescription.sdp,
            description_type: peer.localDescription.type,
        });
    }

    // =========================================================
    // HANDLE ANSWER
    // =========================================================

    async handleAnswer(data) {
        const remoteId = data.from_id;

        const peer = this.peers[remoteId];

        if (peer === undefined) {
            console.log(`[MeshClient] Answer for unknown player: ${remoteId}`);
            return;
        }

        await peer.setRemoteDescription({
            sdp: data.sdp,
            type: data.description_type,
        });
    }

    // =========================================================
    // ROOM EVENTS
    // =========================================================

    async handleRoomState(data) {
        const roomPlayers = data.players || [];

        for (const player of roomPlayers) {
            if (player.id !== this.myId) {
                this.players[player.id] = player;
            }
        }

        if (this.onRoomState) {
            this.onRoomState(roomPlayers);
        }

        // Every lower-index player creates offers to players with
        // higher indexes. This produces full mesh without
        // duplicate negotiations.
        for (const player of roomPlayers) {
            if (player.id === this.myId) continue;

            await this.createOffer(player);
        }
    }

    async handlePlayerJoined(data) {
        const player = data.player;

        if (!player) return;

        this.players[player.id] = player;

        if (this.onPlayerJoined) {
            this.onPlayerJoined(player);
        }

        await this.createOffer(player);
    }

    async handlePlayerLeft(data) {
        const playerId = data.player_id;
        const playerName = data.player_name || "Unknown";

        const peer = this.peers[playerId];
        delete this.peers[playerId];
        delete this.channels[playerId];
        delete this.players[playerId];
        this.offerStarted.delete(playerId);

        if (peer) {
            try {
                peer.close();
            } catch (error) {
                // ignore
            }
        }

        if (this.onPlayerLeft) {
            this.onPlayerLeft(playerId, playerName);
        }
    }

    // =========================================================
    // WEBSOCKET RECEIVER
    // =========================================================

    async _onSocketMessage(raw) {
        let data;

        try {
            data = JSON.parse(raw);
        } catch (error) {
            return;
        }

        const messageType = data.type;

        if (messageType === "registered") {
            this.myId = data.id;
            this.myIndex = data.index;
            this.role = data.role;
        } else if (messageType === "room_state") {
            await this.handleRoomState(data);
        } else if (messageType === "peer_joined") {
            await this.handlePlayerJoined(data);
        } else if (messageType === "signal") {
            const signalType = data.signal_type;

            if (signalType === "offer") {
                await this.handleOffer(data);
            } else if (signalType === "answer") {
                await this.handleAnswer(data);
            }
        } else if (messageType === "room_ready") {
            // no-op, mirrors the Python client
        } else if (messageType === "peer_left") {
            await this.handlePlayerLeft(data);
        } else if (messageType === "error") {
            console.log("[MeshClient] Server error:", data.message);
        }
    }

    // =========================================================
    // ROOM / TURN URL HELPERS
    // =========================================================
    // worker.js routes WebSocket upgrades at /room/<code> and mints
    // TURN credentials over plain HTTPS at /turn-credentials - both
    // derived from the same base signalingServer URL.

    _buildRoomUrl(roomCode) {
        const base = this.signalingServer.replace(/\/+$/, "");
        return `${base}/room/${encodeURIComponent(roomCode)}`;
    }

    _buildTurnCredentialsUrl() {
        const httpBase = this.signalingServer
            .replace(/^wss:/, "https:")
            .replace(/^ws:/, "http:")
            .replace(/\/+$/, "");
        return `${httpBase}/turn-credentials`;
    }

    async _fetchIceServers() {
        try {
            const response = await fetch(this._buildTurnCredentialsUrl());

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();

            if (Array.isArray(data.iceServers) && data.iceServers.length) {
                return data.iceServers;
            }
        } catch (error) {
            console.log(
                "[MeshClient] Could not fetch TURN credentials, falling back to STUN-only:",
                error,
            );
        }

        // Public STUN fallback - enough on most home networks, but
        // not behind a strict/symmetric NAT, which is exactly what
        // the Worker's TURN endpoint is there for.
        return [{ urls: "stun:stun.l.google.com:19302" }];
    }

    // =========================================================
    // CONNECT
    // =========================================================

    connect(playerName, roomCode = "lobby") {
        this.name = (playerName || "").trim() || "Player";
        this.roomCode = roomCode;

        // Runs in parallel with the signaling connection below -
        // getOrCreatePeer() awaits this before creating any
        // RTCPeerConnection, so it doesn't need to finish first.
        this._iceServersPromise = this._fetchIceServers();

        return new Promise((resolve, reject) => {
            let settled = false;

            this.websocket = new WebSocket(this._buildRoomUrl(roomCode));

            this.websocket.onopen = () => {
                this.sendJson({ type: "register", name: this.name });

                // Keep the original prototype's short delay so the
                // server receives registration before room join.
                setTimeout(() => {
                    try {
                        this.sendJson({ type: "join_room" });
                        settled = true;
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                }, 200);
            };

            this.websocket.onmessage = (event) => {
                this._onSocketMessage(event.data);
            };

            this.websocket.onclose = () => {
                console.log("[MeshClient] Signaling connection closed.");
            };

            this.websocket.onerror = (error) => {
                console.log("[MeshClient] Receiver error:", error);
                if (!settled) reject(error);
            };
        });
    }

    // =========================================================
    // GAME DATA API
    // =========================================================

    isConnected(playerId) {
        const channel = this.channels[playerId];
        return Boolean(channel && channel.readyState === "open");
    }

    sendToPlayer(playerId, data) {
        const channel = this.channels[playerId];

        if (!channel) return false;
        if (channel.readyState !== "open") return false;

        channel.send(JSON.stringify(data));

        return true;
    }

    broadcast(data) {
        const message = JSON.stringify(data);
        let sent = 0;

        for (const channel of Object.values(this.channels)) {
            if (channel.readyState === "open") {
                channel.send(message);
                sent += 1;
            }
        }

        return sent;
    }

    // =========================================================
    // PLAYER HELPERS
    // =========================================================

    getPlayerName(playerId) {
        const player = this.players[playerId];

        if (player) {
            return player.name || playerId;
        }

        return playerId;
    }

    getConnectedPlayers() {
        const result = [];

        for (const [playerId, player] of Object.entries(this.players)) {
            if (this.isConnected(playerId)) {
                result.push(player);
            }
        }

        return result;
    }

    // =========================================================
    // STATUS
    // =========================================================

    status() {
        const connections = {};

        for (const [playerId, peer] of Object.entries(this.peers)) {
            connections[playerId] = {
                name: this.getPlayerName(playerId),
                webrtc: peer.connectionState,
                ice: peer.iceConnectionState,
                channel: this.channels[playerId] ? this.channels[playerId].readyState : "none",
            };
        }

        return {
            name: this.name,
            id: this.myId,
            index: this.myIndex,
            role: this.role,
            peer_connections: Object.keys(this.peers).length,
            connections,
        };
    }

    // =========================================================
    // LEAVE / CLOSE
    // =========================================================

    leaveRoom() {
        if (this.websocket) {
            try {
                this.sendJson({ type: "leave_room" });
            } catch (error) {
                // ignore
            }
        }
    }

    close() {
        this.leaveRoom();

        for (const peer of Object.values(this.peers)) {
            try {
                peer.close();
            } catch (error) {
                // ignore
            }
        }

        this.peers = {};
        this.channels = {};
        this.players = {};

        if (this.websocket) {
            try {
                this.websocket.close();
            } catch (error) {
                // ignore
            }

            this.websocket = null;
        }
    }
}