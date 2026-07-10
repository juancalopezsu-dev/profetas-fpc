// Función serverless que verifica el PIN de un perfil en el servidor (nunca
// en el navegador) y entrega un "custom token" de Firebase Auth que identifica
// a esa persona con un UID estable (uid = profileId), sin importar desde qué
// dispositivo entre. Esto es lo que hace que 'ownerUid' en Firestore signifique
// algo real: las reglas comparan request.auth.uid contra ownerUid, y el único
// modo de conseguir un token con ese uid es probando el PIN correcto aquí.
//
// El PIN se guarda con bcrypt en 'profetas/profilePins/profilePins/{profileId}',
// una colección a la que las reglas de Firestore le niegan cualquier acceso desde
// el navegador (allow read, write: if false) — solo el Admin SDK, usado aquí,
// puede leerla o escribirla. Así, aunque cualquiera pueda leer la lista de
// perfiles, nadie puede leer ni fuerza-bruta-ear un hash de PIN desde el cliente.
//
// Modos (todos por POST, body JSON):
//   { mode: 'create', name, pin }
//     -> crea un profileId nuevo, guarda el hash del PIN, devuelve {token, profileId}.
//   { mode: 'login', profileId, pin }
//     -> verifica el PIN, devuelve {token} con uid = profileId.
//   { mode: 'changePin', profileId, currentPin, newPin }
//     -> requiere Authorization: Bearer <idToken> del propio profileId (o de un
//        admin). Verifica currentPin, si newPin viene la actualiza.
//   { mode: 'adminReset', profileId, newPin }
//     -> requiere Authorization: Bearer <idToken> de un admin (token.admin===true).
//        Fija un PIN nuevo sin necesidad de conocer el anterior.
//
// Protección contra fuerza bruta: como un PIN de 4 dígitos solo tiene 10.000
// combinaciones, 'login' y el chequeo de 'currentPin' en 'changePin' bloquean
// el perfil 5 minutos después de 5 intentos fallidos seguidos.
//
// Variable de entorno necesaria en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (como texto)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

function getApp() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getApps()[0];
}

async function verifyPinWithLockout(db, profileId, pin) {
  const pinRef = db.collection('profetas').doc('profilePins').collection('profilePins').doc(profileId);
  const pinSnap = await pinRef.get();
  if (!pinSnap.exists) {
    return { ok: false, error: 'Perfil no encontrado.' };
  }
  const data = pinSnap.data();
  const now = Date.now();
  if (data.lockedUntil && data.lockedUntil > now) {
    const minutes = Math.ceil((data.lockedUntil - now) / 60000);
    return { ok: false, error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutes} minuto(s).` };
  }
  const matches = await bcrypt.compare(pin, data.pinHash || '');
  if (!matches) {
    const attempts = (data.failedAttempts || 0) + 1;
    const update = { failedAttempts: attempts };
    if (attempts >= MAX_ATTEMPTS) {
      update.lockedUntil = now + LOCKOUT_MS;
      update.failedAttempts = 0;
    }
    await pinRef.set(update, { merge: true });
    return { ok: false, error: 'PIN incorrecto.' };
  }
  await pinRef.set({ failedAttempts: 0, lockedUntil: null }, { merge: true });
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' });
    return;
  }

  try {
    getApp();
    const db = getFirestore();
    const auth = getAuth();
    const { mode } = req.body || {};

    if (mode === 'create') {
      const { name, pin } = req.body;
      if (!name || !/^\d{4}$/.test(pin || '')) {
        res.status(400).json({ error: 'Falta el nombre o el PIN no tiene 4 dígitos.' });
        return;
      }
      const profileId = randomUUID();
      const pinHash = await bcrypt.hash(pin, 10);
      await db.collection('profetas').doc('profilePins').collection('profilePins').doc(profileId).set({
        pinHash, failedAttempts: 0, lockedUntil: null
      });
      const token = await auth.createCustomToken(profileId, {});
      res.status(200).json({ token, profileId });
      return;
    }

    if (mode === 'login') {
      const { profileId, pin } = req.body;
      if (!profileId || !/^\d{4}$/.test(pin || '')) {
        res.status(400).json({ error: 'Falta el perfil o el PIN no tiene 4 dígitos.' });
        return;
      }
      const result = await verifyPinWithLockout(db, profileId, pin);
      if (!result.ok) {
        res.status(401).json({ error: result.error });
        return;
      }
      const token = await auth.createCustomToken(profileId, {});
      res.status(200).json({ token });
      return;
    }

    if (mode === 'changePin') {
      const { profileId, currentPin, newPin } = req.body;
      const authHeader = req.headers['authorization'] || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!idToken) {
        res.status(401).json({ error: 'Falta iniciar sesión.' });
        return;
      }
      const decoded = await auth.verifyIdToken(idToken).catch(() => null);
      if (!decoded || (decoded.uid !== profileId && decoded.admin !== true)) {
        res.status(403).json({ error: 'No autorizado para cambiar este PIN.' });
        return;
      }
      if (!profileId || !/^\d{4}$/.test(currentPin || '')) {
        res.status(400).json({ error: 'Falta el perfil o el PIN actual no tiene 4 dígitos.' });
        return;
      }
      const result = await verifyPinWithLockout(db, profileId, currentPin);
      if (!result.ok) {
        res.status(401).json({ error: result.error });
        return;
      }
      if (newPin) {
        if (!/^\d{4}$/.test(newPin)) {
          res.status(400).json({ error: 'El nuevo PIN debe tener 4 dígitos.' });
          return;
        }
        const pinHash = await bcrypt.hash(newPin, 10);
        await db.collection('profetas').doc('profilePins').collection('profilePins').doc(profileId).set({ pinHash }, { merge: true });
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (mode === 'adminReset') {
      const { profileId, newPin } = req.body;
      const authHeader = req.headers['authorization'] || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!idToken) {
        res.status(401).json({ error: 'Falta iniciar sesión.' });
        return;
      }
      const decoded = await auth.verifyIdToken(idToken).catch(() => null);
      if (!decoded || decoded.admin !== true) {
        res.status(403).json({ error: 'Solo el administrador puede resetear un PIN.' });
        return;
      }
      if (!profileId || !/^\d{4}$/.test(newPin || '')) {
        res.status(400).json({ error: 'Falta el perfil o el nuevo PIN no tiene 4 dígitos.' });
        return;
      }
      const pinHash = await bcrypt.hash(newPin, 10);
      await db.collection('profetas').doc('profilePins').collection('profilePins').doc(profileId).set({
        pinHash, failedAttempts: 0, lockedUntil: null
      }, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Modo no reconocido.' });
  } catch (err) {
    res.status(500).json({ error: 'Error en el login de perfil', details: String(err) });
  }
}
