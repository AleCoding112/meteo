/* Genera la coppia di chiavi per le notifiche push (VAPID).
   La pubblica finisce dentro l'app, la privata resta un segreto
   da incollare fra i Secrets del repo: non va mai committata.

   Uso:  node tools/make-vapid.js                                */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();

const publicKey  = b64url(ecdh.getPublicKey());        // 65 byte, punto non compresso
const privateKey = b64url(ecdh.getPrivateKey());       // 32 byte

const out = path.join(__dirname, '..', 'vapid-private.txt');
fs.writeFileSync(out, `VAPID_PUBLIC=${publicKey}\nVAPID_PRIVATE=${privateKey}\n`);

console.log('chiave pubblica (va in app.js):');
console.log('  ' + publicKey);
console.log('\nchiave privata: salvata in vapid-private.txt (esclusa da git)');
console.log('  lunghezze:', Buffer.from(publicKey, 'base64url').length, 'e',
            Buffer.from(privateKey, 'base64url').length, 'byte');
