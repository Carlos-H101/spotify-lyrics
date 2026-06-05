// PKCE helpers for Spotify's Authorization Code + PKCE flow.
// Uses only Node's built-in crypto. No third-party packages.
const crypto = require('crypto');

function base64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// 64 random bytes -> ~86 char verifier (Spotify allows 43-128 chars).
function createVerifier() {
  return base64url(crypto.randomBytes(64));
}

function challengeFromVerifier(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function randomState() {
  return base64url(crypto.randomBytes(16));
}

module.exports = { createVerifier, challengeFromVerifier, randomState };
