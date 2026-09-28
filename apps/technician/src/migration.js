/**
 * Relayn WebRTC Data Channel Migration Handler
 * Handles the secure P2P pipeline between Customer (Device A) and Technician (Device B)
 */

class RelaynMigrationManager {
    constructor(role) {
        this.role = role; // Expects either 'customer' or 'technician'
        this.peerConnection = null;
        this.dataChannel = null;
        
        // Target role for signaling messages
        this.targetRole = role === 'customer' ? 'technician' : 'customer';

        // FIXED: Correct syntax format for standard public Google STUN servers
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:://google.com' },
                { urls: 'stun:://google.com' }
            ]
        };

        this.initSignalingListener();
    }

    /**
     * Connects the WebRTC signaling engine to your existing Electron preload listener
     */
    initSignalingListener() {
        window.relayn.onSessionEvent(async (message) => {
            // Filter out events meant strictly for our WebRTC layer
            if (message.type !== 'signal') return;

            const { sdp, candidate } = message.payload;

            try {
                if (sdp) {
                    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
                    console.log(`[WebRTC] Successfully set Remote Description from ${this.targetRole}`);
                    
                    if (sdp.type === 'offer' && this.role === 'technician') {
                        // Technician responds to the Customer's connection offer
                        const answer = await this.peerConnection.createAnswer();
                        await this.peerConnection.setLocalDescription(answer);
                        
                        await window.relayn.sendSignal(this.targetRole, { sdp: answer });
                    }
                } else if (candidate) {
                    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
            } catch (error) {
                console.error('[WebRTC] Error processing incoming signal packet:', error);
            }
        });
    }

    /**
     * Initializes the standard RTCPeerConnection topology
     */
    initializePeerConnection() {
        this.peerConnection = new RTCPeerConnection(this.rtcConfig);

        // Bubble ICE network candidates back up to the signaling relay server
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                window.relayn.sendSignal(this.targetRole, { candidate: event.candidate });
            }
        };

        if (this.role === 'customer') {
            // DEVICE A: Initiates the channel pipeline creation
            this.setupCustomerPipeline();
        } else {
            // DEVICE B: Prepares to receive the channel pipeline from the customer
            this.setupTechnicianPipeline();
        }
    }

    /**
     * 📤 DEVICE A (CUSTOMER): Orchestrates cookie extraction and transmission
     */
    setupCustomerPipeline() {
        console.log('[WebRTC] Initializing Customer (Device A) Pipeline...');
        
        // Create the raw unnegotiated data channel layer
        this.dataChannel = this.peerConnection.createDataChannel('relayn-migration-sync', {
            ordered: true // Ensures packets arrive sequentially 
        });

        this.bindDataChannelEvents();

        // Generate the SDP handshake packet to bridge to the Technician
        this.peerConnection.createOffer()
            .then(offer => this.peerConnection.setLocalDescription(offer))
            .then(() => {
                window.relayn.sendSignal(this.targetRole, { sdp: this.peerConnection.localDescription });
            })
            .catch(err => console.error('[WebRTC] Failed to launch offer creation sequence:', err));
    }

    /**
     * 📥 DEVICE B (TECHNICIAN): Prepares to capture data channel and inject cookie
     */
    setupTechnicianPipeline() {
        console.log('[WebRTC] Initializing Technician (Device B) Pipeline...');
        
        this.peerConnection.ondatachannel = (event) => {
            this.dataChannel = event.channel;
            this.bindDataChannelEvents();
        };
    }

    /**
     * Symmetrical data channel lifecycle handler
     */
    bindDataChannelEvents() {
        if (!this.dataChannel) return;

        this.dataChannel.onopen = async () => {
            console.log(`[WebRTC] Secure Data Channel actively OPEN on role: ${this.role}`);

            // TRIGGER POINT: Automate handoff instantly when P2P lane opens
            if (this.role === 'customer') {
                await this.executeCustomerCookieExport();
            }
        };

        this.dataChannel.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);
                
                if (message.type === 'RELAYN_SESSION_MIGRATION' && this.role === 'technician') {
                    await this.executeTechnicianCookieImport(message.cookie);
                }
            } catch (err) {
                console.error('[WebRTC] Failed to parse raw channel payload:', err);
            }
        };

        this.dataChannel.onclose = () => {
            console.log('[WebRTC] Data channel link dropped.');
        };
    }

    /**
     * Device A Worker: Extracts cookie out of OS vault and drops it on the wire
     */
    async executeCustomerCookieExport() {
        console.log('[Migration] Extracting authentication state from secure vault...');
        
        // Invokes your updated Customer Preload handler
        const result = await window.relayn.extractAuthCookie('session_id');

        if (result.success) {
            this.dataChannel.send(JSON.stringify({
                type: 'RELAYN_SESSION_MIGRATION',
                cookie: result.payload
            }));
            console.log('[Migration] Auth context securely written directly to peer data channel.');
        } else {
            console.error('[Migration] Critical: Aborted extraction sequence:', result.error);
        }
    }

    /**
     * Device B Worker: Captures incoming packet and force-injects to session storage
     */
    async executeTechnicianCookieImport(cookiePayload) {
        console.log('[Migration] Inbound session state caught. Commencing system injection...');
        
        // Invokes your updated Technician Preload handler
        const result = await window.relayn.injectAuthCookie(cookiePayload);

        if (result.success) {
            console.log('[Migration] Success! Application verified. Graceful reboot initiated.');
            
            // Instantly clear the channel connection and bounce the app view to log standard view in
            this.dataChannel.close();
            this.peerConnection.close();
            
            window.location.reload(); 
        } else {
            console.error('[Migration] Critical: System rejected incoming cookie structural format:', result.error);
        }
    }
}
