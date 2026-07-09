# Los Profetas del FPC

App familiar de predicciones de la Liga BetPlay FPC.

## Estructura del proyecto

- `index.html` — estructura de la página
- `styles.css` — todos los estilos visuales
- `app.js` — toda la lógica de la app (Firestore, predicciones, admin, etc.)
- `firebase-config.js` — credenciales del proyecto de Firebase (públicas, no son secretas)
- `api/resultados.js` — función serverless de Vercel que consulta API-Football de forma segura
- `api/actualizar-resultados.js` — función serverless (Vercel Cron) que actualiza resultados automáticamente usando el Admin SDK de Firebase
- `vercel.json` — configura el Cron Job que corre `api/actualizar-resultados` 2 veces al día
- `manifest.json` — manifiesto PWA para poder "agregar a inicio" en el celular
- `icons/` — íconos de la app (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`) usados por el manifiesto y por iOS

## Pasos para publicar (una sola vez)

### 1. Subir a GitHub
1. Crea un repositorio nuevo en GitHub (puede ser privado), ej. `profetas-del-fpc`.
2. Sube todos estos archivos ahí (arrastrando en la web de GitHub, o con `git push` si usas terminal).

### 2. Conectar con Vercel
1. Entra a [vercel.com](https://vercel.com) → **Add New... > Project**.
2. Importa el repo de GitHub que acabas de crear.
3. Framework: déjalo en **"Other"** (no es Next.js ni nada especial, es HTML plano).
4. Antes de darle Deploy, ve a **Environment Variables** y agrega:
   - **Name:** `API_FOOTBALL_KEY` — **Value:** tu key de api-football.com (la que ya tienes)
   - **Name:** `FIREBASE_SERVICE_ACCOUNT` — **Value:** el JSON completo del service account de Firebase (Firebase Console → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada), pegado como texto en una sola línea
   - **Name:** `CRON_SECRET` (opcional pero recomendado) — **Value:** cualquier texto aleatorio largo; Vercel lo usa automáticamente para que solo el Cron Job pueda ejecutar `api/actualizar-resultados`
5. Dale **Deploy**. En un minuto te da un link tipo `profetas-del-fpc.vercel.app` — ese es el link que compartes con tu familia.

### 3. Reglas de seguridad de Firestore (importante, antes de 30 días)
Firestore quedó en "modo de prueba", que se cierra automáticamente a los 30 días de creado.
Antes de que eso pase, entra a Firebase Console → Firestore Database → pestaña **Reglas**, y reemplaza el contenido por:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profetas/{document=**} {
      allow read, write: if true;
    }
  }
}
```

Esto mantiene el acceso abierto (como está ahora) permanentemente, sin depender del modo de prueba. Como es una app familiar sin datos sensibles reales (solo predicciones de fútbol), esto es aceptable — no hace falta un sistema de autenticación complejo.

**Importante:** el `{document=**}` (en vez de `{doc}`) es necesario porque los equipos ahora viven en la subcolección `profetas/teams/teams/{teamId}` — con `{doc}` a secas, Firestore solo permite acceso a documentos directos bajo `profetas` y bloquea (permission-denied) cualquier lectura/escritura dentro de esa subcolección. Si ya tenías la regla vieja con `{doc}`, actualízala en Firebase Console antes de volver a abrir Gestionar.

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

- **Equipos en Firestore**: cada equipo es su propio documento en la subcolección `profetas/teams/teams/{teamId}` (no un array dentro de un documento único), para no toparse con el límite de 1MB por documento cuando varios equipos tienen escudo en base64. Al abrir la app por primera vez con la nueva estructura, si esa subcolección está vacía, se migran automáticamente los equipos del documento viejo `profetas/teams` (o se crean los equipos por defecto si tampoco existía), y luego se borra el documento viejo.
- **Perfiles en Firestore**: mismo patrón que los equipos — cada perfil es su propio documento en `profetas/profiles/profiles/{profileId}`, en vez de un array compartido. La migración automática desde el documento viejo `profetas/profiles` conserva el `id` original de cada perfil (no genera IDs nuevos), porque las predicciones en `matches` están ligadas a esos IDs.
- **PIN de perfiles**: cada quien crea un PIN de 4 dígitos al crear su perfil. Tú (admin) puedes verlos todos en Gestionar por si alguien lo olvida.
- **Mi perfil**: pestaña donde cada persona puede cambiar su nombre, su foto (con el mismo redimensionado a 150x150px) y su PIN — siempre pidiendo el PIN actual antes de guardar cualquier cambio.
- **Detalle de predicciones por persona**: en Tabla → "Nuestra apuesta", cada fila es clickeable y abre un panel con todos los partidos que esa persona predijo (marcador que puso, resultado real y puntos ganados en cada uno) y su pronóstico de pre-temporada con si acertó o no.
- **Bloqueo de predicciones**: se cierra automáticamente en cuanto llega la hora de inicio (`kickoff`) que le pongas al partido.
- **Resultados automáticos (manual)**: el botón "Buscar resultados automáticos" consulta la API-Football por la fecha de los partidos pendientes y llena los marcadores que encuentre — pero siempre tienes que darle "Guardar" tú, así puedes corregir si algo no coincide.
- **Resultados automáticos (sin abrir la app)**: el Cron Job de Vercel corre `api/actualizar-resultados` dos veces al día (8am y 11pm hora Colombia) y escribe directo en Firestore los resultados de los partidos que ya terminaron (status "FT" en API-Football), sin necesidad de que nadie entre a la app.
- **Editar resultado ya cargado**: recalcula los puntos de todos automáticamente, útil si la Dimayor cambia un resultado por reglamento.
- **Eliminar partido**: tanto en "Cargar resultados" como en "Editar resultados ya cargados" hay un botón "Eliminar" (con confirmación) que borra el partido y sus predicciones asociadas de Firestore.
- **Escudos reales**: en la sección Equipos hay un botón "Subir escudo" por equipo (igual que la foto de perfil) que convierte la imagen elegida a base64 con `FileReader` y la guarda de una vez en Firestore; si un equipo no tiene escudo subido, se sigue mostrando el círculo de iniciales como respaldo.
- **Eliminar perfil**: en "Perfiles y PIN" hay un botón "Eliminar" por perfil (con confirmación) que borra el perfil y sus predicciones/pronóstico de pre-temporada de Firestore.
- **Fotos y escudos livianos**: tanto la foto de perfil como los escudos subidos se redimensionan en el navegador (máximo 150x150px, JPEG) antes de convertirse a base64 y guardarse, para no cargar varios MB en cada arranque de la app.
- **Carga en paralelo**: `loadAll()` pide perfiles, equipos, partidos, pre-temporada, tabla real y admin con `Promise.all` en vez de uno por uno, para que la carga inicial no espere secuencialmente por cada documento.
- **Pantalla de carga**: apenas se abre la app se ve un spinner con "Cargando..." (definido en `index.html`) hasta que `boot()` termina de leer Firestore, en vez de una pantalla en blanco/verde.
- **Botones protegidos contra doble clic**: todos los botones que guardan/eliminan algo en Firestore (crear perfil, guardar predicción, agregar partido, guardar resultado, subir escudo, etc.) se deshabilitan y cambian de texto (ej. "Guardando...") mientras la operación está en curso, para no crear registros duplicados por clics repetidos.
- **Perfil bot "Carlos Antonio Vélez"**: perfil especial (`isBot: true`) que se crea solo la primera vez que alguien abre la app tras este cambio. Aparece en la tabla de posiciones como cualquier jugador, pero no en la grilla de login (nadie "entra" como él) ni en "Perfiles y PIN". Desde Gestionar → "Carlos Antonio Vélez (predicción automática)" le subes foto y le pones su pronóstico de pre-temporada a mano.
  - Al crear un partido nuevo se le genera un marcador aleatorio (`randomBotScore()`): ~80% de las veces un resultado bajo y común (0-0, 1-1, 2-1, etc.), ~20% uno más goleador y menos común (hasta 5 goles por equipo), guardado como su predicción real de ese partido — no como un campo aparte.
  - Cuando un partido cierra (llega el `kickoff`), a cualquier persona que no haya predicho se le "presta" la predicción del bot para efectos de puntaje y de visualización — pero esto **no se escribe en Firestore**: `effectivePrediction()` lo calcula al vuelo en cada carga, así siempre refleja el estado real sin depender de un disparador exacto a la hora de cierre. En la tarjeta y en el detalle de la persona se etiqueta como "🤖 Predicción automática (Carlos Antonio Vélez): X-Y" para distinguirla de una predicción propia.
- **Columnas de goleador y campeón en la tabla**: en Tabla → "Nuestra apuesta", cada fila muestra además el nombre del goleador y el escudo del campeón que esa persona puso en su pronóstico de pre-temporada (o "-" si todavía no lo ha hecho). El resto de la fila sigue siendo clickeable para abrir el detalle de predicciones.
- **Ver predicciones de todos por partido**: en Predicciones, los partidos ya cerrados (esperando resultado o finalizados) tienen un botón "Ver predicciones" que abre un modal con el marcador de cada persona en una pastilla de color — verde si acertó el marcador exacto, amarillo si acertó el resultado pero no el marcador, rojo si no acertó nada, gris si el partido aún no tiene resultado. Las predicciones automáticas del bot se marcan igual que en las tarjetas ("🤖 Predicción automática..."). Este botón solo aparece en partidos ya cerrados — antes de esa hora las predicciones ajenas siguen sin ser visibles, para no arruinar la sorpresa.
- **Puntos por fase**: `phaseInfo()` centraliza los puntos de cada fase — Regular (1 pt resultado / 3 pts marcador exacto), Cuadrangulares (2/5) y Final (4/8). La fase "Final" se elige igual que las otras al crear un partido en Gestionar.
- **Pestaña Reglas**: explica cómo se juega, los puntos por fase, pre-temporada, la predicción automática de respaldo y los cambios de resultado — pensada para compartir con la familia sin tener que explicar todo por WhatsApp.
- **PWA ("agregar a inicio")**: `manifest.json` + los íconos en `icons/` permiten instalar la app desde el navegador (Android: menú → "Agregar a pantalla de inicio"; iPhone: compartir → "Agregar a pantalla de inicio", usa el `apple-touch-icon.png`). El `theme-color` (#0E2A2E) colorea la barra del navegador para que se vea integrada con la app.
- **Cierre de pre-temporada en dos pasos**: en Gestionar → Pre-temporada, primero "Cerrar predicciones de pre-temporada" (`preseason.picksLocked = true`) bloquea que se sigan editando campeón/goleador, sin pedir todavía el resultado real. Después, con las predicciones ya bloqueadas, aparece "Cerrar y calificar" para cargar el campeón real y calificar — que además re-confirma `picksLocked = true` por si se saltó el primer paso. "Reabrir pronósticos" deshace ambos (`picksLocked = false` y `result = null`).
- **Calificación manual del goleador**: en vez de comparar el texto que escribió cada quien contra el nombre real (poco confiable por errores de tipeo/variantes), "Cerrar y calificar" muestra la lista de lo que escribió cada persona con un checkbox para que el admin marque a mano quién acertó — puede haber más de una marcada si varios se refirieron al mismo jugador de forma distinta. Esa decisión se guarda como `preseason.result.scorerCorrectIds` (array de IDs de perfil) y es la que se usa tanto para sumar los 12 puntos como para mostrar ✔/✘ en el detalle de cada persona. El campeón se sigue calificando automático comparando IDs, ya que es una selección de lista, no texto libre.
- **Cerrar sesión**: en "Mi perfil" hay un botón "Cerrar sesión" que solo borra la clave `profetas-my-id` de `localStorage` (el perfil "activo" en ese navegador) y vuelve a la pantalla de selección de perfil — no toca nada en Firestore, todos los perfiles y predicciones siguen intactos.
- **Predicciones ajenas ocultas hasta el kickoff (detalle por persona)**: el modal que se abre al hacer clic en alguien en Tabla → "Nuestra apuesta" ya no revelaba el marcador de partidos todavía abiertos — se corrigió para que, igual que en el detalle por partido, cada predicción ajena de un partido sin cerrar se muestre como "🔒 Oculto hasta que inicie el partido". Tus propias predicciones se siguen mostrando siempre (ya las conoces).
- **Actualización en tiempo real**: `loadAll()` dejó de usar `getDoc`/`getDocs` (lectura única) y ahora se suscribe con `onSnapshot` a perfiles, equipos, partidos/predicciones, pre-temporada y tabla real. La primera vez que llega cada dato resuelve la carga inicial igual que antes; cada cambio posterior en Firestore (alguien crea un perfil, predice, o el admin carga un resultado) actualiza el estado y refresca sola la pantalla de quien tenga la app abierta — sin recargar la página. Si la persona está escribiendo algo en ese momento (un input o select visible), `refreshCurrentView()` no interrumpe: el siguiente render ya usa el dato más nuevo.
- **Rellenar predicciones faltantes del bot**: `fillMissingBotPredictions()` revisa todos los partidos existentes y le genera un marcador aleatorio (misma lógica de `randomBotScore()`) al perfil de Carlos Antonio Vélez en cualquiera que se le haya quedado sin predicción — útil para partidos creados antes de que existiera el bot. Se corre sola al final de `loadAll()` (no hace nada si ya está todo al día) y también hay un botón manual "Generar predicciones faltantes de Carlos Antonio Vélez" en Gestionar para forzarla cuando quieras.
