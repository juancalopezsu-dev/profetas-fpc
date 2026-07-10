# Los Profetas del FPC

App familiar de predicciones de la Liga BetPlay FPC.

## Estructura del proyecto

- `index.html` — estructura de la página
- `styles.css` — todos los estilos visuales
- `app.js` — toda la lógica de la app (Firestore, predicciones, admin, etc.)
- `firebase-config.js` — credenciales del proyecto de Firebase (públicas, no son secretas)
- `api/resultados.js` — función serverless de Vercel que consulta API-Football de forma segura
- `api/actualizar-resultados.js` — función serverless (Vercel Cron) que actualiza resultados automáticamente usando el Admin SDK de Firebase
- `api/profile-login.js` — función serverless que verifica el PIN de cada perfil (crear/entrar/cambiar PIN/resetear) y entrega un custom token de Firebase Auth
- `api/admin-login.js` — función serverless que verifica la contraseña de administrador (hash bcrypt) y entrega un custom token con el claim `admin: true`
- `api/migrate-security.js` — función serverless de un solo uso para migrar los datos existentes a la nueva estructura de seguridad (ver sección de migración más abajo)
- `vercel.json` — configura el Cron Job que corre `api/actualizar-resultados` 2 veces al día
- `manifest.json` — manifiesto PWA para poder "agregar a inicio" en el celular
- `icons/` — íconos de la app (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`) usados por el manifiesto y por iOS
- `firestore.rules` — reglas de seguridad de Firestore (se pegan a mano en Firebase Console → Firestore Database → Reglas; este archivo es solo para tenerlas versionadas en el repo)

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
   - **Name:** `ADMIN_PASSWORD_HASH` — **Value:** el hash bcrypt de tu contraseña de administrador (ver sección "Seguridad" más abajo para cómo generarlo)
   - **Name:** `MIGRATION_SECRET` — **Value:** cualquier texto aleatorio largo que tú elijas; protege `api/migrate-security` para que solo tú puedas dispararla
5. Dale **Deploy**. En un minuto te da un link tipo `profetas-del-fpc.vercel.app` — ese es el link que compartes con tu familia.

### 3. Seguridad: autenticación, reglas de Firestore, contraseña de admin y migración

La app pasó de "cualquiera puede leer y escribir todo" a un modelo real de autenticación. Esto son 4 pasos que hay que hacer **en orden**, una sola vez.

#### 3.1. Autenticación anónima (Firebase Console)
Firebase Console → **Authentication** → pestaña **Sign-in method** → habilita **Anonymous**. (Si ya lo activaste, sigue al siguiente paso.) Esto es necesario para que la app pueda leer/escribir en Firestore incluso antes de que alguien elija su perfil — todas las reglas de abajo exigen `request.auth != null`.

#### 3.2. Reglas de Firestore
Firebase Console → **Firestore Database** → pestaña **Reglas**, y reemplaza el contenido por el de [`firestore.rules`](firestore.rules) (está en la raíz del repo). En resumen, lo que dicen:

- **Equipos, partidos y tabla real**: cualquiera autenticado (aunque sea anónimo) los puede leer; solo un admin (`request.auth.token.admin == true`) los puede crear, editar o borrar.
- **Perfiles**: cualquiera autenticado los puede leer. Solo se puede crear/editar el perfil propio — el `uid` de la sesión (que solo se consigue probando el PIN correcto vía `/api/profile-login`) tiene que ser igual al `id` del documento y al campo `ownerUid` guardado adentro. Solo admin puede borrar perfiles.
- **`profilePins` y `adminAuth`**: `allow read, write: if false` — nadie, ni siquiera un admin, puede tocarlas desde el navegador. Solo las funciones serverless (que usan el Admin SDK, el cual no pasa por estas reglas) pueden leerlas/escribirlas.
- **Predicciones** (`profetas/matches/matches/{matchId}/predictions/{profileId}`): cualquiera autenticado las puede leer (la app decide en el cliente si mostrarlas u ocultarlas hasta el kickoff — eso es una regla de interfaz, no de acceso a datos). Solo se puede crear/editar la predicción propia (`ownerUid` == el propio `uid`), o un admin (necesario para las predicciones automáticas del bot).
- **Pre-temporada**: cualquiera autenticado puede editar *solo su propia entrada* dentro de `picks{}` — el resto del documento tiene que quedar igual. Cerrar/calificar sigue siendo solo de admin.

#### 3.3. Contraseña de administrador (hash bcrypt)
La contraseña de admin ya no vive en Firestore (donde cualquiera con la app abierta podría leerla) — se verifica en el servidor contra un hash bcrypt guardado como variable de entorno.

La forma más simple: dime en el chat qué contraseña quieres usar (la misma de siempre, o una nueva) y te genero el hash yo mismo con Claude Code. Copia el resultado (algo como `$2a$10$....` o `$2b$10$....`) y pégalo como `ADMIN_PASSWORD_HASH` en Vercel (ver paso 2 de arriba).

Si prefieres generarlo tú mismo y tienes Node.js instalado, dentro de la carpeta del proyecto (con `npm install` ya corrido, para tener `bcryptjs`):
```
node -e "require('bcryptjs').hash(process.argv[1], 10).then(h => console.log(h))" "TU-CONTRASEÑA-AQUÍ"
```

#### 3.4. Migrar los datos existentes
Una sola vez, **después** de desplegar (para que `/api/migrate-security` ya exista) y con `FIREBASE_SERVICE_ACCOUNT` y `MIGRATION_SECRET` ya configurados en Vercel, corre:

```
curl -X POST https://tu-app.vercel.app/api/migrate-security \
  -H "Authorization: Bearer TU_MIGRATION_SECRET"
```

Esto (ver detalle en los comentarios de [`api/migrate-security.js`](api/migrate-security.js)):
- Pasa los partidos y predicciones del documento único viejo `profetas/matches` a documentos individuales en `profetas/matches/matches/{matchId}` y `.../predictions/{profileId}`, conservando los IDs.
- A cada perfil le agrega `ownerUid`, mueve su PIN (si tenía uno en texto plano) a un hash bcrypt en `profetas/profilePins/{profileId}`, y quita el PIN en texto plano del perfil.
- Borra `profetas/admin`, donde vivía la contraseña de administrador vieja en **texto plano** — ya no se usa y no tiene sentido dejarla ahí.

Es seguro correrla más de una vez (no repite trabajo ya hecho). La respuesta te dice cuántos partidos, predicciones y perfiles migró.

**Importante:** hasta que corras la migración, los partidos/predicciones/perfiles viejos no van a aparecer en la app (porque ya lee de la estructura nueva). No hay pérdida de datos — simplemente no se ven hasta que migres.

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
- **PIN de perfiles (verificado en servidor)**: cada quien crea un PIN de 4 dígitos al crear su perfil. Ya no se guarda en texto plano ni se compara en el navegador — `/api/profile-login` lo verifica contra un hash bcrypt guardado en `profetas/profilePins/{id}` (una colección a la que el navegador nunca tiene acceso, ni siquiera un admin) y, si es correcto, entrega un token de Firebase Auth con `uid = profileId`. Como ya no se guarda en texto plano, tú (admin) ya no puedes "ver" el PIN de alguien que lo olvidó — pero sí puedes resetearlo a uno nuevo con el botón "Resetear PIN" en Gestionar → Perfiles. Después de 5 intentos fallidos seguidos, ese perfil queda bloqueado 5 minutos (protección contra fuerza bruta, importante porque un PIN de 4 dígitos solo tiene 10.000 combinaciones).
- **Mi perfil**: pestaña donde cada persona puede cambiar su nombre, su foto (con el mismo redimensionado a 150x150px) y su PIN — siempre pidiendo el PIN actual antes de guardar cualquier cambio.
- **Detalle de predicciones por persona**: en Tabla → "Nuestra apuesta", cada fila es clickeable y abre un panel con todos los partidos que esa persona predijo (marcador que puso, resultado real y puntos ganados en cada uno) y su pronóstico de pre-temporada con si acertó o no.
- **Bloqueo de predicciones**: se cierra automáticamente en cuanto llega la hora de inicio (`kickoff`) que le pongas al partido.
- **Resultados automáticos (manual)**: el botón "Buscar resultados automáticos" consulta la API-Football por la fecha de los partidos pendientes y llena los marcadores que encuentre — pero siempre tienes que darle "Guardar" tú, así puedes corregir si algo no coincide.
- **Resultados automáticos (sin abrir la app)**: el Cron Job de Vercel corre `api/actualizar-resultados` dos veces al día (8am y 11pm hora Colombia) y escribe directo en Firestore los resultados de los partidos que ya terminaron (status "FT" en API-Football), sin necesidad de que nadie entre a la app.
- **Editar resultado ya cargado**: recalcula los puntos de todos automáticamente, útil si la Dimayor cambia un resultado por reglamento.
- **Eliminar partido**: tanto en "Cargar resultados" como en "Editar resultados ya cargados" hay un botón "Eliminar" (con confirmación) que borra el partido y sus predicciones asociadas de Firestore.
- **Escudos reales**: en la sección Equipos hay un botón "Subir escudo" por equipo (igual que la foto de perfil) que convierte la imagen elegida a base64 con `FileReader` y la guarda de una vez en Firestore; si un equipo no tiene escudo subido, se sigue mostrando el círculo de iniciales como respaldo.
- **Eliminar perfil**: en "Perfiles" hay un botón "Eliminar" por perfil (con confirmación) que borra el perfil y sus predicciones/pronóstico de pre-temporada de Firestore.
- **Fotos y escudos livianos**: tanto la foto de perfil como los escudos subidos se redimensionan en el navegador (máximo 150x150px, JPEG) antes de convertirse a base64 y guardarse, para no cargar varios MB en cada arranque de la app.
- **Carga en paralelo**: `loadAll()` pide perfiles, equipos, partidos, pre-temporada, tabla real y admin con `Promise.all` en vez de uno por uno, para que la carga inicial no espere secuencialmente por cada documento.
- **Pantalla de carga**: apenas se abre la app se ve un spinner con "Cargando..." (definido en `index.html`) hasta que `boot()` termina de leer Firestore, en vez de una pantalla en blanco/verde.
- **Botones protegidos contra doble clic**: todos los botones que guardan/eliminan algo en Firestore (crear perfil, guardar predicción, agregar partido, guardar resultado, subir escudo, etc.) se deshabilitan y cambian de texto (ej. "Guardando...") mientras la operación está en curso, para no crear registros duplicados por clics repetidos.
- **Perfil bot "Carlos Antonio Vélez"**: perfil especial (`isBot: true`) que se crea solo desde una sesión de administrador (`ensureBotProfile()`, disparada cada vez que abres Gestionar, o por la migración). Aparece en la tabla de posiciones como cualquier jugador, pero no en la grilla de login (nadie "entra" como él) ni en "Perfiles". Desde Gestionar → "Carlos Antonio Vélez (predicción automática)" le subes foto y le pones su pronóstico de pre-temporada a mano.
  - Al crear un partido nuevo se le genera un marcador aleatorio (`randomBotScore()`): ~80% de las veces un resultado bajo y común (0-0, 1-1, 2-1, etc.), ~20% uno más goleador y menos común (hasta 5 goles por equipo), guardado como su predicción real de ese partido — no como un campo aparte.
  - Cuando un partido cierra (llega el `kickoff`), a cualquier persona que no haya predicho se le "presta" la predicción del bot para efectos de puntaje y de visualización — pero esto **no se escribe en Firestore**: `effectivePrediction()` lo calcula al vuelo en cada carga, así siempre refleja el estado real sin depender de un disparador exacto a la hora de cierre. En la tarjeta y en el detalle de la persona se etiqueta como "🤖 Predicción automática (Carlos Antonio Vélez): X-Y" para distinguirla de una predicción propia.
- **Columnas de goleador y campeón en la tabla**: en Tabla → "Nuestra apuesta", cada fila muestra además el nombre del goleador y el escudo del campeón que esa persona puso en su pronóstico de pre-temporada (o "-" si todavía no lo ha hecho). El resto de la fila sigue siendo clickeable para abrir el detalle de predicciones.
- **Ver predicciones de todos por partido**: en Predicciones, los partidos ya cerrados (esperando resultado o finalizados) tienen un botón "Ver predicciones" que abre un modal con el marcador de cada persona en una pastilla de color — verde si acertó el marcador exacto, amarillo si acertó el resultado pero no el marcador, rojo si no acertó nada, gris si el partido aún no tiene resultado. Las predicciones automáticas del bot se marcan igual que en las tarjetas ("🤖 Predicción automática..."). Este botón solo aparece en partidos ya cerrados — antes de esa hora las predicciones ajenas siguen sin ser visibles, para no arruinar la sorpresa.
- **Puntos por fase**: `phaseInfo()` centraliza los puntos de cada fase — Regular (1 pt resultado / 3 pts marcador exacto), Cuadrangulares (2/5) y Final (4/8). La fase "Final" se elige igual que las otras al crear un partido en Gestionar.
- **Pestaña Reglas**: explica cómo se juega, los puntos por fase, pre-temporada, la predicción automática de respaldo y los cambios de resultado — pensada para compartir con la familia sin tener que explicar todo por WhatsApp.
- **PWA ("agregar a inicio")**: `manifest.json` + los íconos en `icons/` permiten instalar la app desde el navegador (Android: menú → "Agregar a pantalla de inicio"; iPhone: compartir → "Agregar a pantalla de inicio", usa el `apple-touch-icon.png`). El `theme-color` (#0E2A2E) colorea la barra del navegador para que se vea integrada con la app.
- **Cierre de pre-temporada en dos pasos**: en Gestionar → Pre-temporada, primero "Cerrar predicciones de pre-temporada" (`preseason.picksLocked = true`) bloquea que se sigan editando campeón/goleador, sin pedir todavía el resultado real. Después, con las predicciones ya bloqueadas, aparece "Cerrar y calificar" para cargar el campeón real y calificar — que además re-confirma `picksLocked = true` por si se saltó el primer paso. "Reabrir pronósticos" deshace ambos (`picksLocked = false` y `result = null`).
- **Calificación manual del goleador**: en vez de comparar el texto que escribió cada quien contra el nombre real (poco confiable por errores de tipeo/variantes), "Cerrar y calificar" muestra la lista de lo que escribió cada persona con un checkbox para que el admin marque a mano quién acertó — puede haber más de una marcada si varios se refirieron al mismo jugador de forma distinta. Esa decisión se guarda como `preseason.result.scorerCorrectIds` (array de IDs de perfil) y es la que se usa tanto para sumar los 12 puntos como para mostrar ✔/✘ en el detalle de cada persona. El campeón se sigue calificando automático comparando IDs, ya que es una selección de lista, no texto libre.
- **Cerrar sesión**: en "Mi perfil" hay un botón "Cerrar sesión" que cierra la sesión real de Firebase Auth (`signOut`) y vuelve a entrar anónimo, para que la pantalla de login pueda seguir leyendo Firestore. No toca nada en Firestore — todos los perfiles y predicciones siguen intactos, esto solo cambia qué perfil está "activo" en este navegador.
- **Predicciones ajenas ocultas hasta el kickoff (detalle por persona)**: el modal que se abre al hacer clic en alguien en Tabla → "Nuestra apuesta" ya no revelaba el marcador de partidos todavía abiertos — se corrigió para que, igual que en el detalle por partido, cada predicción ajena de un partido sin cerrar se muestre como "🔒 Oculto hasta que inicie el partido". Tus propias predicciones se siguen mostrando siempre (ya las conoces).
- **Actualización en tiempo real**: `loadAll()` se suscribe con `onSnapshot`/`onSnapshot` sobre `collectionGroup` a perfiles, equipos, partidos, predicciones (todas las de todos los partidos, agrupadas por `matchId` — ver siguiente punto), pre-temporada y tabla real. La primera vez que llega cada dato resuelve la carga inicial; cada cambio posterior en Firestore actualiza el estado y refresca sola la pantalla de quien tenga la app abierta, sin recargar la página. Si la persona está escribiendo algo en ese momento (un input o select visible), `refreshCurrentView()` no interrumpe: el siguiente render ya usa el dato más nuevo.
- **Rellenar predicciones faltantes del bot**: `fillMissingBotPredictions()` revisa todos los partidos existentes y le genera un marcador aleatorio (misma lógica de `randomBotScore()`) al perfil de Carlos Antonio Vélez en cualquiera que se le haya quedado sin predicción. Solo se puede llamar desde una sesión de administrador (su `ownerUid` nunca coincide con un `auth.uid` real, así que las reglas de Firestore solo lo permiten vía `isAdmin()`) — por eso corre sola cada vez que abres Gestionar, y también hay un botón manual "Generar predicciones faltantes de Carlos Antonio Vélez" para forzarla o confirmar que ya está todo al día.
- **Autenticación anónima obligatoria**: `ensureAuth()` (en `app.js`) usa `signInAnonymously` de Firebase Auth antes de leer o escribir cualquier cosa — todas las reglas de Firestore exigen `request.auth != null`. Si ya había una sesión guardada (de un perfil o de admin, vía custom token), Firebase la restaura sola sin volver a pedir nada.
- **`ownerUid` en perfiles y predicciones**: cada perfil y cada predicción tiene un campo `ownerUid` que las reglas de Firestore comparan contra `request.auth.uid` para decidir quién puede editar qué. La única forma de conseguir un token cuyo `uid` sea igual al `id` de un perfil es probar el PIN correcto en `/api/profile-login` — por eso "ligar el perfil a su dueño" es real y no se puede falsificar editando Firestore directamente.
- **Predicciones en subcolección por partido**: en vez de vivir todas mezcladas en un solo documento, cada predicción es su propio documento en `profetas/matches/matches/{matchId}/predictions/{profileId}`. Esto es lo que permite que las reglas de Firestore verifiquen, por documento, que cada quien solo pueda crear/editar su propia predicción — algo imposible si todas vivieran juntas en un array o mapa gigante. La lectura sigue siendo abierta para cualquier autenticado (para la tabla de posiciones); ocultar las predicciones ajenas hasta el kickoff sigue siendo una decisión de la interfaz, no de las reglas de acceso.
- **Admin real, verificado en servidor**: la contraseña de administrador ya no se compara en el navegador contra un valor guardado en Firestore — `/api/admin-login` la verifica contra un hash bcrypt guardado como variable de entorno de Vercel (`ADMIN_PASSWORD_HASH`) y, si es correcta, entrega un custom token con el claim `admin: true`. Las reglas de Firestore exigen ese claim para cualquier escritura de administrador (crear/borrar partidos y equipos, cargar resultados, cerrar pre-temporada, etc.). Igual que con los PIN, 5 intentos fallidos seguidos bloquean el login de admin 5 minutos.
