// Función serverless que verifica la contraseña de administrador contra un
// hash bcrypt guardado en una variable de entorno de Vercel (nunca en
// Firestore, donde cualquiera con la app abierta podría leerlo y falsificarlo).
// Si la contraseña es correcta, entrega un "custom token" de Firebase Auth con
// el claim admin:true, que las reglas de Firestore exigen para cualquier
// escritura de administrador (crear/borrar partidos y equipos, cargar
// resultados, cerrar pre-temporada, etc.).
//
// El token se emite con el mismo uid que ya tenía la persona en su sesión
// (profileId, si venía de un login de perfil) para que, además de admin,
// siga pudiendo editar su propio perfil y sus propias predicciones con el
// mismo uid de siempre — solo se le agrega el claim admin:true encima.
//
// Protección contra fuerza bruta: bloquea 5 minutos después de 5 intentos
// fallidos seguidos (se guarda en 'profetas/adminAuth/state', inaccesible
// desde el navegador).
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (como texto)
//   - ADMIN_PASSWORD_HASH: hash bcrypt de la contraseña de administrador

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import bcrypt from 'bcryptjs';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

function getApp() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getApps()[0];
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
  if (!process.env.ADMIN_PASSWORD_HASH) {
    res.status(500).json({ error: 'Falta configurar ADMIN_PASSWORD_HASH en Vercel.' });
    return;
  }

  try {
    getApp();
    const db = getFirestore();
    const auth = getAuth();
    const { password, profileId } = req.body || {};
    if (!password) {
      res.status(400).json({ error: 'Falta la contraseña.' });
      return;
    }

    const stateRef = db.collection('profetas').collection('adminAuth').doc('state');
    const stateSnap = await stateRef.get();
    const stateData = stateSnap.exists ? stateSnap.data() : {};
    const now = Date.now();
    if (stateData.lockedUntil && stateData.lockedUntil > now) {
      const minutes = Math.ceil((stateData.lockedUntil - now) / 60000);
      res.status(401).json({ error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutes} minuto(s).` });
      return;
    }

    const matches = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
    if (!matches) {
      const attempts = (stateData.failedAttempts || 0) + 1;
      const update = { failedAttempts: attempts };
      if (attempts >= MAX_ATTEMPTS) {
        update.lockedUntil = now + LOCKOUT_MS;
        update.failedAttempts = 0;
      }
      await stateRef.set(update, { merge: true });
      res.status(401).json({ error: 'Contraseña incorrecta.' });
      return;
    }

    await stateRef.set({ failedAttempts: 0, lockedUntil: null }, { merge: true });
    const uid = profileId || 'admin';
    const token = await auth.createCustomToken(uid, { admin: true });
    res.status(200).json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Error en el login de administrador', details: String(err) });
  }
}
