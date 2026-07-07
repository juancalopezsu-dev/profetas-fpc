# Los Profetas del FPC

App familiar de predicciones de la Liga BetPlay FPC.

## Estructura del proyecto

- `index.html` — estructura de la página
- `styles.css` — todos los estilos visuales
- `app.js` — toda la lógica de la app (Firestore, predicciones, admin, etc.)
- `firebase-config.js` — credenciales del proyecto de Firebase (públicas, no son secretas)
- `api/resultados.js` — función serverless de Vercel que consulta API-Football de forma segura

## Pasos para publicar (una sola vez)

### 1. Subir a GitHub
1. Crea un repositorio nuevo en GitHub (puede ser privado), ej. `profetas-del-fpc`.
2. Sube todos estos archivos ahí (arrastrando en la web de GitHub, o con `git push` si usas terminal).

### 2. Conectar con Vercel
1. Entra a [vercel.com](https://vercel.com) → **Add New... > Project**.
2. Importa el repo de GitHub que acabas de crear.
3. Framework: déjalo en **"Other"** (no es Next.js ni nada especial, es HTML plano).
4. Antes de darle Deploy, ve a **Environment Variables** y agrega:
   - **Name:** `API_FOOTBALL_KEY`
   - **Value:** tu key de api-football.com (la que ya tienes)
5. Dale **Deploy**. En un minuto te da un link tipo `profetas-del-fpc.vercel.app` — ese es el link que compartes con tu familia.

### 3. Reglas de seguridad de Firestore (importante, antes de 30 días)
Firestore quedó en "modo de prueba", que se cierra automáticamente a los 30 días de creado.
Antes de que eso pase, entra a Firebase Console → Firestore Database → pestaña **Reglas**, y reemplaza el contenido por:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profetas/{doc} {
      allow read, write: if true;
    }
  }
}
```

Esto mantiene el acceso abierto (como está ahora) permanentemente, sin depender del modo de prueba. Como es una app familiar sin datos sensibles reales (solo predicciones de fútbol), esto es aceptable — no hace falta un sistema de autenticación complejo.

## Cómo seguir editando esta app

Desde tu Mac, abre la terminal en la carpeta del proyecto y escribe:
```
claude
```
Y pídele lo que necesites, ej: "agrégame tal función". Cuando termine:
```
git add .
git commit -m "descripción del cambio"
git push
```
Vercel va a detectar el push y redesplegar la app sola — no necesitas volver a subir nada a mano.

## Notas técnicas

- **PIN de perfiles**: cada quien crea un PIN de 4 dígitos al crear su perfil. Tú (admin) puedes verlos todos en Gestionar por si alguien lo olvida.
- **Bloqueo de predicciones**: se cierra automáticamente en cuanto llega la hora de inicio (`kickoff`) que le pongas al partido.
- **Resultados automáticos**: el botón "Buscar resultados automáticos" consulta la API-Football por la fecha de los partidos pendientes y llena los marcadores que encuentre — pero siempre tienes que darle "Guardar" tú, así puedes corregir si algo no coincide.
- **Editar resultado ya cargado**: recalcula los puntos de todos automáticamente, útil si la Dimayor cambia un resultado por reglamento.
