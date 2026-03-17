/* ═══════════════════════════════════════════════════════════════
   LOCALBEAM CRYPTO MODULE v1
   End-to-End Encryption using WebCrypto API
   
   Key Exchange: ECDH P-256 (widely supported)
   Encryption: AES-256-GCM (authenticated encryption)
   ═══════════════════════════════════════════════════════════════ */

const LocalBeamCrypto = (function() {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────
  const ALGORITHM = {
    name: 'ECDH',
    namedCurve: 'P-256'
  };
  
  const AES_ALGORITHM = {
    name: 'AES-GCM',
    length: 256
  };

  const IV_LENGTH = 12; // 96 bits for GCM
  const TAG_LENGTH = 128; // 128-bit auth tag

  // ─── Key Storage ───────────────────────────────────────────────
  let privateKey = null;
  let publicKey = null;
  let publicKeyBase64 = null;
  let peerPublicKeys = {}; // device_id -> CryptoKey
  let derivedKeys = {};    // device_id -> AES key

  // ─── Initialize Key Pair ───────────────────────────────────────
  async function generateKeyPair() {
    try {
      // Check if we have stored keys
      const storedPrivate = localStorage.getItem('localbeam_private_key');
      const storedPublic = localStorage.getItem('localbeam_public_key');

      if (storedPrivate && storedPublic) {
        // Import existing keys
        const privateJwk = JSON.parse(storedPrivate);
        const publicJwk = JSON.parse(storedPublic);

        privateKey = await crypto.subtle.importKey(
          'jwk', privateJwk, ALGORITHM, false, ['deriveBits', 'deriveKey']
        );
        publicKey = await crypto.subtle.importKey(
          'jwk', publicJwk, ALGORITHM, true, []
        );
        publicKeyBase64 = await exportPublicKeyBase64(publicKey);
        
        console.log('[Crypto] Loaded existing key pair');
        return { publicKey: publicKeyBase64 };
      }

      // Generate new key pair
      const keyPair = await crypto.subtle.generateKey(
        ALGORITHM, true, ['deriveBits', 'deriveKey']
      );

      privateKey = keyPair.privateKey;
      publicKey = keyPair.publicKey;

      // Export and store keys
      const privateJwk = await crypto.subtle.exportKey('jwk', privateKey);
      const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);

      localStorage.setItem('localbeam_private_key', JSON.stringify(privateJwk));
      localStorage.setItem('localbeam_public_key', JSON.stringify(publicJwk));

      publicKeyBase64 = await exportPublicKeyBase64(publicKey);
      
      console.log('[Crypto] Generated new key pair');
      return { publicKey: publicKeyBase64 };
    } catch (err) {
      console.error('[Crypto] Key generation failed:', err);
      throw err;
    }
  }

  // ─── Export Public Key to Base64 ───────────────────────────────
  async function exportPublicKeyBase64(key) {
    const rawKey = await crypto.subtle.exportKey('raw', key);
    return arrayBufferToBase64(rawKey);
  }

  // ─── Import Peer Public Key ────────────────────────────────────
  async function importPeerPublicKey(deviceId, publicKeyB64) {
    try {
      const rawKey = base64ToArrayBuffer(publicKeyB64);
      const peerKey = await crypto.subtle.importKey(
        'raw', rawKey, ALGORITHM, true, []
      );
      
      peerPublicKeys[deviceId] = peerKey;
      
      // Derive shared AES key
      await deriveSharedKey(deviceId, peerKey);
      
      console.log(`[Crypto] Imported public key for device: ${deviceId}`);
      return true;
    } catch (err) {
      console.error(`[Crypto] Failed to import key for ${deviceId}:`, err);
      return false;
    }
  }

  // ─── Derive Shared AES Key ─────────────────────────────────────
  async function deriveSharedKey(deviceId, peerPublicKey) {
    try {
      const sharedKey = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: peerPublicKey },
        privateKey,
        AES_ALGORITHM,
        false,
        ['encrypt', 'decrypt']
      );
      
      derivedKeys[deviceId] = sharedKey;
      console.log(`[Crypto] Derived shared key for device: ${deviceId}`);
      return sharedKey;
    } catch (err) {
      console.error(`[Crypto] Key derivation failed for ${deviceId}:`, err);
      throw err;
    }
  }

  // ─── Encrypt File ──────────────────────────────────────────────
  async function encryptFile(file, recipientDeviceId) {
    try {
      const sharedKey = derivedKeys[recipientDeviceId];
      if (!sharedKey) {
        throw new Error(`No shared key for device: ${recipientDeviceId}`);
      }

      // Read file as ArrayBuffer
      const fileData = await file.arrayBuffer();
      
      // Generate random IV
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      
      // Encrypt with AES-GCM
      const encryptedData = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv, tagLength: TAG_LENGTH },
        sharedKey,
        fileData
      );

      // Create metadata header
      const metadata = {
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        encrypted: true,
        sender: getOwnPublicKey(),
        timestamp: Date.now()
      };
      
      const metadataJson = JSON.stringify(metadata);
      const metadataBytes = new TextEncoder().encode(metadataJson);
      const metadataLength = new Uint32Array([metadataBytes.length]);

      // Combine: [4 bytes metadata length][metadata][12 bytes IV][encrypted data]
      const totalLength = 4 + metadataBytes.length + IV_LENGTH + encryptedData.byteLength;
      const combined = new Uint8Array(totalLength);
      
      let offset = 0;
      combined.set(new Uint8Array(metadataLength.buffer), offset);
      offset += 4;
      combined.set(metadataBytes, offset);
      offset += metadataBytes.length;
      combined.set(iv, offset);
      offset += IV_LENGTH;
      combined.set(new Uint8Array(encryptedData), offset);

      // Create encrypted blob
      const encryptedBlob = new Blob([combined], { type: 'application/x-localbeam-encrypted' });
      
      console.log(`[Crypto] Encrypted file: ${file.name} (${fileData.byteLength} -> ${combined.length} bytes)`);
      
      return {
        blob: encryptedBlob,
        originalName: file.name,
        encryptedName: `${file.name}.enc`,
        originalSize: file.size,
        encryptedSize: combined.length
      };
    } catch (err) {
      console.error('[Crypto] Encryption failed:', err);
      throw err;
    }
  }

  // ─── Decrypt File ──────────────────────────────────────────────
  async function decryptFile(encryptedData, senderDeviceId) {
    try {
      const sharedKey = derivedKeys[senderDeviceId];
      if (!sharedKey) {
        throw new Error(`No shared key for device: ${senderDeviceId}`);
      }

      const dataView = new Uint8Array(encryptedData);
      
      // Read metadata length
      const metadataLength = new DataView(dataView.buffer).getUint32(0, true);
      
      // Read metadata
      const metadataBytes = dataView.slice(4, 4 + metadataLength);
      const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
      
      // Read IV
      const ivStart = 4 + metadataLength;
      const iv = dataView.slice(ivStart, ivStart + IV_LENGTH);
      
      // Read encrypted content
      const encryptedContent = dataView.slice(ivStart + IV_LENGTH);
      
      // Decrypt
      const decryptedData = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv, tagLength: TAG_LENGTH },
        sharedKey,
        encryptedContent
      );

      console.log(`[Crypto] Decrypted file: ${metadata.name} (${encryptedData.byteLength} -> ${decryptedData.byteLength} bytes)`);
      
      return {
        data: decryptedData,
        metadata: metadata,
        blob: new Blob([decryptedData], { type: metadata.type })
      };
    } catch (err) {
      console.error('[Crypto] Decryption failed:', err);
      throw err;
    }
  }

  // ─── Encrypt Data (for messages) ───────────────────────────────
  async function encryptMessage(text, recipientDeviceId) {
    try {
      const sharedKey = derivedKeys[recipientDeviceId];
      if (!sharedKey) {
        throw new Error(`No shared key for device: ${recipientDeviceId}`);
      }

      const data = new TextEncoder().encode(text);
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv, tagLength: TAG_LENGTH },
        sharedKey,
        data
      );

      // Combine IV + encrypted data
      const combined = new Uint8Array(IV_LENGTH + encrypted.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encrypted), IV_LENGTH);

      return arrayBufferToBase64(combined);
    } catch (err) {
      console.error('[Crypto] Message encryption failed:', err);
      throw err;
    }
  }

  // ─── Decrypt Message ───────────────────────────────────────────
  async function decryptMessage(encryptedB64, senderDeviceId) {
    try {
      const sharedKey = derivedKeys[senderDeviceId];
      if (!sharedKey) {
        throw new Error(`No shared key for device: ${senderDeviceId}`);
      }

      const combined = base64ToArrayBuffer(encryptedB64);
      const iv = combined.slice(0, IV_LENGTH);
      const encrypted = combined.slice(IV_LENGTH);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv, tagLength: TAG_LENGTH },
        sharedKey,
        encrypted
      );

      return new TextDecoder().decode(decrypted);
    } catch (err) {
      console.error('[Crypto] Message decryption failed:', err);
      throw err;
    }
  }

  // ─── Utility Functions ─────────────────────────────────────────
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function getOwnPublicKey() {
    return publicKeyBase64;
  }

  function hasKeyForDevice(deviceId) {
    return !!derivedKeys[deviceId];
  }

  function getPeerDevices() {
    return Object.keys(derivedKeys);
  }

  // ─── Clear Keys (logout) ───────────────────────────────────────
  function clearKeys() {
    privateKey = null;
    publicKey = null;
    publicKeyBase64 = null;
    peerPublicKeys = {};
    derivedKeys = {};
    localStorage.removeItem('localbeam_private_key');
    localStorage.removeItem('localbeam_public_key');
    console.log('[Crypto] All keys cleared');
  }

  // ─── Check if E2EE is available ────────────────────────────────
  function isSupported() {
    return !!(window.crypto && window.crypto.subtle);
  }

  // ─── Public API ────────────────────────────────────────────────
  return {
    init: generateKeyPair,
    getPublicKey: getOwnPublicKey,
    importPeerKey: importPeerPublicKey,
    encryptFile: encryptFile,
    decryptFile: decryptFile,
    encryptMessage: encryptMessage,
    decryptMessage: decryptMessage,
    hasKeyFor: hasKeyForDevice,
    getPeers: getPeerDevices,
    clearKeys: clearKeys,
    isSupported: isSupported
  };
})();

// Export for use in other modules
window.LocalBeamCrypto = LocalBeamCrypto;
