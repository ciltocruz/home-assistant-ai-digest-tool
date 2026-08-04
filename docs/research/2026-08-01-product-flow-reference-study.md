# Estudio de referencias de producto y frontend

Fecha: 2026-08-01
Alcance: lectura de archivos y APIs públicas de GitHub, más inspección local del frontend. No se ha copiado código ni se ha modificado código de producto.

## Resumen ejecutivo

- **HomeAssistantDigest** tiene la mejor referencia de dominio: perfil del hogar, digest diario/semanal, categorías de severidad, notas del operador y lista de avisos ignorados.
- **drydock** tiene la mejor referencia operativa: shell con navegación persistente, vistas profundas, filtros reflejados en URL, panel de detalle, confirmaciones, toasts, estados de carga/error/reintento y responsive real.
- El producto actual ya tiene buenas bases: onboarding persistido, configuración editable con secretos enmascarados, trabajos durables, UI oscura, responsive, español por defecto y controles de accesibilidad básicos.
- El problema principal actual es de **arquitectura de experiencia**, no de falta de funcionalidades: `App.tsx` apila onboarding, configuración, acción manual, lifecycle, historial y controles en la misma pantalla. El primer arranque debe ser un estado de aplicación distinto del dashboard, no otra tarjeta más.

## Fuentes primarias

### HomeAssistantDigest

- [README.md](https://github.com/saihgupr/HomeAssistantDigest/blob/main/README.md): propuesta de producto, categorías del digest, perfil inicial, historial de siete días y canales de notificación.
- [homeassistant-digest/config.yaml](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/config.yaml): configuración real del add-on, Gemini, horario, día semanal, notificación, historial e intervalo de snapshots.
- [ui/index.html](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/index.html), [ui/app.js](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/app.js): dashboard, cambio diario/semanal, estado, digest actual, historial y generación manual.
- [ui/setup.html](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/setup.html), [ui/setup.js](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/setup.js), [server/api/profile.js](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/server/api/profile.js): cuestionario de cuatro preguntas y persistencia del perfil.
- [ui/entities.html](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/entities.html), [ui/entities.js](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/entities.js), [server/api/entities.js](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/server/api/entities.js): conexión, descubrimiento, categorías, prioridades, rescaneo y guardado.
- [ui/notes.html](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/notes.html), [ui/notes.js](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/notes.js): notas, edición, borrado y estado vacío.
- [server/api/digest.js](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/server/api/digest.js): endpoints de generación, listado, cleanup, notas y avisos ignorados.
- [ui/styles.css](https://github.com/saihgupr/HomeAssistantDigest/blob/main/homeassistant-digest/ui/styles.css): sistema visual de temas planetarios, layout, cards, severidad y modales.

### drydock

- [README.md](https://github.com/CodesWhat/drydock/blob/main/README.md): dashboard, autenticación, notificaciones, auditoría, métricas, responsive y demo.
- [ui/src/router/routes.ts](https://github.com/CodesWhat/drydock/blob/main/ui/src/router/routes.ts): arquitectura de rutas y convención de query params para filtros, tabs, paginación y estado compartible.
- [ui/src/layouts/AppLayout.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/layouts/AppLayout.vue): shell, sidebar agrupado, badges dinámicos, búsqueda y navegación móvil.
- [ui/src/views/DashboardView.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/views/DashboardView.vue), [ui/src/views/dashboard/components/DashboardGrid.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/views/dashboard/components/DashboardGrid.vue): dashboard de widgets, estados, responsive, personalización, progreso y actualizaciones optimistas.
- [ui/src/views/ConfigView.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/views/ConfigView.vue): settings separados por `general`, `appearance` y `profile`, con tabs en URL y preferencias persistidas.
- [ui/src/components/DataViewLayout.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/components/DataViewLayout.vue), [DetailPanel.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/components/DetailPanel.vue), [EmptyState.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/components/EmptyState.vue): patrón de lista/filtro/detalle y empty states reutilizables.
- [ui/src/components/ConfirmDialog.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/components/ConfirmDialog.vue), [AppToast.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/components/AppToast.vue), [ui/src/views/LoginView.vue](https://github.com/CodesWhat/drydock/blob/main/ui/src/views/LoginView.vue): confirmación, feedback asíncrono, login y reconexión.

## Comparación por área

| Área | HomeAssistantDigest | drydock | Implicación para este producto |
|---|---|---|---|
| Información | Dashboard lineal: setup, estado, digest reciente, históricos; Daily/Weekly/Notes arriba. | Shell persistente con Dashboard, Containers, Security, Audit, Logs, Manage y Settings. | Mantener una pantalla principal orientada a "qué necesita atención" y sacar la configuración del flujo operativo. |
| Onboarding | API key fuera de la UI y luego cuatro preguntas de contexto. El perfil se guarda al finalizar; no hay checkpoint por pregunta. | Login/configuración de operador; no es un wizard de producto. | El onboarding persistido de seis pantallas actual es correcto, pero debe gobernar la entrada al dashboard. |
| Settings | Principalmente YAML del add-on; notas, ignores y prioridades sí tienen UI. | Settings explícitos por dominio, tabs y preferencias. | Agrupar conexiones, notificaciones, horario y privacidad en Settings; no duplicar controles en dashboard. |
| Informe | Generación síncrona; el botón queda deshabilitado y muestra estado textual. | Operaciones largas con progreso, SSE, toasts y recuperación. | Conservar el job durable actual y hacer visible un único informe activo, con fases y siguiente acción. |
| Historial | Lista de digest anteriores, selección del digest y cleanup automático al cargar. | Vistas listables con filtros, URL y panel de detalle. | Cada informe del historial debe ser navegable y conservar contexto; no solo texto dentro de un `li`. |
| Jerarquía visual | El contenido del digest ordena overview, atención, observaciones, housekeeping, all good, resumen y tip. | Widgets de resumen y drill-down a vistas operativas. | Usar severidad y acción como jerarquía; evitar que notas, ajustes e informes compitan al mismo nivel. |
| Estados | Empty states claros para digest/notas; loading overlay; errores con `alert` o texto de acción. | Empty state reutilizable, error + retry, toasts por tono y overlay de reconexión. | Normalizar loading, empty, error, retry y success como estados de producto, no mensajes aislados. |

## Hallazgos de HomeAssistantDigest

### Lo que funciona

- La promesa es entendible: un técnico revisa el hogar cada mañana. El README concreta qué detecta y cómo se organiza el resultado.
- La secuencia de digest es fuerte: primero lo positivo, después atención y observaciones, y al final housekeeping/tip. Reduce la lectura de miles de entidades a decisiones.
- Las notas y los avisos ignorados convierten el feedback en contexto para futuras ejecuciones, no en una preferencia escondida en Settings.
- El descubrimiento de entidades muestra conexión, total, categorías, estado, estrategia de almacenamiento y prioridad editable antes de guardar.

### Lo que hay que rechazar

- El `config.yaml` exige `homeassistant_api`, `auth_api`, `hassio_api`, `hassio_role: manager` e ingress: es un add-on acoplado a Supervisor, no una referencia válida para el runtime Docker-first.
- El perfil mantiene respuestas en memoria hasta el último paso; un refresh durante el cuestionario pierde el avance no guardado.
- `app.js` espera a que termine `POST /api/digest/generate`; no hay job durable, progreso por fase, reanudación ni retry explícito.
- `ui/app.js`, `ui/entities.js` y `ui/notes.js` usan `innerHTML`, handlers inline, `alert` y acciones que aparecen principalmente con hover. Es una referencia visual, no una base de interacción accesible.
- Nueve temas planetarios y múltiples layouts son memorables, pero desvían atención del diagnóstico y aumentan el coste de diseño, contraste y mantenimiento.

## Hallazgos de drydock

### Lo que funciona

- El shell hace visible la arquitectura: navegación agrupada, página actual, badges, búsqueda global y comportamiento móvil. El usuario no depende de descubrir tarjetas ocultas.
- `routes.ts` documenta que filtros, tabs y paginación viven en URL. Esto permite volver atrás, compartir una vista y no perder contexto al recargar.
- `DataViewLayout` + `DetailPanel` separa lista y detalle sin abandonar el contexto. En móvil el panel es modal con focus trap; en escritorio es lateral persistente.
- `EmptyState`, `ConfirmDialog` y `AppToast` convierten estados recurrentes en patrones consistentes. `DashboardView` muestra loading, error, retry, progreso optimista y recuperación de conexión.
- `ConfigView` separa general, apariencia y perfil, y preserva la pestaña en `?tab=`. La configuración se siente como un lugar estable, no como un conjunto de acciones desperdigadas.

### Lo que no conviene trasladar literalmente

- Sidebar extensa, command palette, widgets reordenables, múltiples temas, agentes, registries y auditoría son proporcionales a una plataforma de operaciones, no al MVP de digest.
- La densidad informativa y el lenguaje de infraestructura pueden hacer que un usuario de Home Assistant no entienda qué debe resolver primero.
- Debe adaptarse el patrón, no la superficie: dos o tres áreas principales son suficientes para este producto: Dashboard, Informes y Configuración.

## Comparación con el frontend actual

### Bases buenas

- `frontend/src/styles.css` tiene dark mode deliberado, color semántico, tipografía Atkinson Hyperlegible, responsive, focus visible, skip link y `prefers-reduced-motion`.
- `frontend/src/onboarding.tsx` persiste checkpoints, limpia secretos del draft y explica privacidad antes de lanzar el primer informe.
- `frontend/src/job-lifecycle.tsx` ya modela `queued → running → completed/failed`, fases, polling pausado en pestaña oculta, retry y enlace al informe.
- `frontend/src/dashboard.tsx` cubre loading, empty, unavailable y error; `frontend/src/settings.tsx` separa conservar/reemplazar secretos.

### Problemas de flujo y jerarquía

- `frontend/src/App.tsx` renderiza onboarding, SettingsPanel y dashboard juntos en `/`; la configuración aparece también en `/settings`. La aplicación no tiene un corte claro entre primer arranque y uso diario.
- `frontend/src/dashboard.tsx` pinta el historial como `li` sin enlace ni acción de apertura. El detalle solo se alcanza desde el job recién completado.
- `frontend/src/report-detail.tsx` muestra el cuerpo como `<pre>`, por lo que el informe no tiene jerarquía visual de severidad, explicación, recomendación y evidencia.
- `frontend/src/controls-panel.tsx` mezcla notas, ignores, privacidad, retención y test de Telegram en un bloque de controles; además, quitar un ignore es destructivo y no pide confirmación.
- El dashboard tiene estados técnicos correctos, pero no una prioridad de producto suficientemente fuerte: el usuario debería ver primero estado general, atención reciente, informe activo y luego historial.
- Según las reglas de interfaz revisadas, faltan especialmente navegación accionable para el historial, confirmación de eliminación y asociaciones más explícitas entre algunos errores de campo y sus inputs. El baseline de labels, foco, zoom, idioma y reduced motion es bueno.

## Qué adaptar y qué rechazar

### Adaptar

1. De HomeAssistantDigest: el modelo mental **Atención → Observaciones → Todo correcto → Recomendación**, notas de contexto e ignores.
2. De drydock: shell corto con Dashboard/Informes/Configuración, tabs con URL cuando aporten navegación, panel de detalle, confirmaciones, toasts y retry.
3. Del frontend actual: onboarding durable de seis pasos, secretos enmascarados, jobs persistidos y español-first.
4. Para la siguiente evolución: un dashboard con cuatro zonas claras, historial clicable, informe estructurado y estados vacíos que siempre indiquen la siguiente acción.

### Rechazar

1. Dependencia de Supervisor/add-on de HomeAssistantDigest.
2. Generación síncrona y cleanup como efecto implícito de cargar el dashboard.
3. `innerHTML`, `onclick` globales, `alert` y acciones solo visibles al pasar el ratón.
4. Configuración duplicada en dashboard y Settings.
5. Tematización extensa o personalización de widgets antes de resolver la comprensión del flujo principal.

## Conclusión

La dirección correcta no es añadir más paneles. Es convertir el frontend actual en una aplicación con dos estados de entrada inequívocos: **configuración pendiente** o **dashboard operativo**. El producto debe hablar como HomeAssistantDigest cuando explica incidencias y comportarse como drydock cuando navega, carga, falla, confirma y recupera operaciones.
