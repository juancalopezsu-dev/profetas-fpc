// Función serverless de un solo uso: migra los datos existentes a la nueva
// estructura de seguridad, sin perder información y conservando los IDs.
//
//  1. Partidos y predicciones: pasa el documento único 'profetas/matches'
//     (con matches[] y predictions{} adentro) a documentos individuales en
//     'profetas/matches/matches/{matchId}' y 'profetas/matches/matches/{matchId}/predictions/{profileId}',
//     con ownerUid en cada predicción.
//  2. Perfiles: a cada perfil que todavía no tenga 'ownerUid' le agrega
//     ownerUid = su propio id, mueve su PIN (si tiene) a un hash bcrypt en
//     'profetas/profilePins/{profileId}' (colección a la que el navegador
//     nunca tiene acceso) y quita el campo 'pin' en texto plano del perfil.
//  3. Borra 'profetas/admin', el documento donde vivía la contraseña de
//     administrador en TEXTO PLANO con el sistema viejo — ya no se usa (la
//     contraseña ahora se verifica en el servidor contra ADMIN_PASSWORD_HASH)
//     y dejarla ahí sería un riesgo de seguridad innecesario.
//
// Es seguro correrla más de una vez (no repite trabajo ya hecho). Usa el
// Admin SDK, así que no le aplican las reglas de Firestore del navegador.
//
// Protegida con MIGRATION_SECRET: hay que llamarla con
//   Authorization: Bearer <MIGRATION_SECRET>
// para que no cualquiera la pueda disparar.
//
// Uso (una sola vez, después de desplegar):
//   curl -X POST https://tu-app.vercel.app/api/migrate-security \
//     -H "Authorization: Bearer TU_MIGRATION_SECRET"
//
// Variables de entorno necesarias en Vercel:
//   - FIREBASE_SERVICE_ACCOUNT: JSON del service account de Firebase (como texto)
//   - MIGRATION_SECRET: cualquier texto largo y aleatorio que tú elijas

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';

function getApp() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getApps()[0];
}

async function migrateMatches(db) {
  const oldRef = db.collection('profetas').doc('matches');
  const oldSnap = await oldRef.get();
  if (!oldSnap.exists) {
    return { matchesMigrated: 0, predictionsMigrated: 0, ranMatchesMigration: false };
  }
  const data = oldSnap.data();
  const matches = data.matches || [];
  const predictions = data.predictions || {};

  let matchesMigrated = 0;
  let predictionsMigrated = 0;
  let batch = db.batch();
  let opsInBatch = 0;

  async function commitIfFull() {
    opsInBatch++;
    if (opsInBatch >= 450) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }

  for (const m of matches) {
    const matchRef = db.collection('profetas').doc('matches').collection('matches').doc(m.id);
    batch.set(matchRef, {
      id: m.id,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      kickoff: m.kickoff || null,
      phase: m.phase || 'regular',
      homeScore: m.homeScore === undefined ? null : m.homeScore,
      awayScore: m.awayScore === undefined ? null : m.awayScore
    });
    matchesMigrated++;
    await commitIfFull();

    const predsForMatch = predictions[m.id] || {};
    for (const profileId of Object.keys(predsForMatch)) {
      const pred = predsForMatch[profileId];
      const predRef = matchRef.collection('predictions').doc(profileId);
      batch.set(predRef, {
        home: pred.home,
        away: pred.away,
        ownerUid: profileId
      });
      predictionsMigrated++;
      await commitIfFull();
    }
  }

  batch.delete(oldRef);
  await batch.commit();

  return { matchesMigrated, predictionsMigrated, ranMatchesMigration: true };
}

async function migrateProfiles(db) {
  const profilesSnap = await db.collection('profetas').doc('profiles').collection('profiles').get();
  let profilesMigrated = 0;

  for (const profileDoc of profilesSnap.docs) {
    const profile = profileDoc.data();
    if (profile.ownerUid) continue; // ya migrado

    const updates = { ownerUid: profileDoc.id };

    if (profile.pin) {
      const pinHash = await bcrypt.hash(String(profile.pin), 10);
      await db.collection('profetas').collection('profilePins').doc(profileDoc.id).set({
        pinHash, failedAttempts: 0, lockedUntil: null
      });
    }

    await profileDoc.ref.set(updates, { merge: true });
    if ('pin' in profile) {
      await profileDoc.ref.update({ pin: FieldValue.delete() });
    }
    profilesMigrated++;
  }

  return { profilesMigrated, totalProfiles: profilesSnap.size };
}

async function deleteLegacyAdminDoc(db) {
  const ref = db.collection('profetas').doc('admin');
  const snap = await ref.get();
  if (!snap.exists) return { deleted: false };
  await ref.delete();
  return { deleted: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido (usa POST).' });
    return;
  }
  if (!process.env.MIGRATION_SECRET) {
    res.status(500).json({ error: 'Falta configurar MIGRATION_SECRET en Vercel.' });
    return;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.MIGRATION_SECRET}`) {
    res.status(401).json({ error: 'No autorizado.' });
    return;
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    res.status(500).json({ error: 'Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel.' });
    return;
  }

  try {
    getApp();
    const db = getFirestore();

    const matchesResult = await migrateMatches(db);
    const profilesResult = await migrateProfiles(db);
    const legacyAdminResult = await deleteLegacyAdminDoc(db);

    res.status(200).json({ ok: true, matches: matchesResult, profiles: profilesResult, legacyAdminDoc: legacyAdminResult });
  } catch (err) {
    res.status(500).json({ error: 'Error migrando datos', details: String(err) });
  }
}
