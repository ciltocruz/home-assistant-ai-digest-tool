# Revisión PR 2: persistencia y seguridad del backend

Este PR introduce la base de persistencia del backend: interfaces de dominio, migraciones SQLite, almacenamiento seguro de secretos y cola idempotente de jobs de digest.

## Ruta rápida de revisión

1. Abrir primero `backend/src/domain/` para ver los contratos que usarán los adaptadores futuros.
2. Revisar `backend/src/adapters/persistence/migrations.ts` para confirmar las tablas creadas.
3. Revisar `sqlite-secret-store.ts` y su test para comprobar que los secretos solo salen en `resolve()`.
4. Revisar `sqlite-digest-job-store.ts` y su test para comprobar la deduplicación por `triggerWindowId`, el lease atómico, la recuperación de leases caducados y la política de reintentos.
5. Ejecutar `pnpm run ci` y `pnpm audit --audit-level moderate`.

## Qué cambió

| Área | Cambio |
|------|--------|
| Dominio | Interfaces para collectors, incident detectors, AI providers, notifiers, renderers, stores y jobs. |
| SQLite | Migración inicial con tablas de settings, secrets, digest jobs, reports, notes, ignore rules y deliveries. |
| Secretos | `SQLiteSecretStore` crea `app.key`, cifra valores con AES-GCM y devuelve solo refs/máscaras salvo resolución explícita interna. |
| Jobs | `SQLiteDigestJobStore` implementa `enqueue`, `leaseNext`, `complete` y `retry` con `triggerWindowId` único, recuperación de leases caducados y reintentos con backoff determinista hasta estado terminal `failed`. |
| Tests | Cobertura de migraciones, no filtrado de secretos, deduplicación concurrente de encolado, lease atómico entre workers, recuperación de leases caducados y agotamiento de reintentos. |
| Tooling | Vitest/Vite se actualizaron para eliminar vulnerabilidades moderadas/altas del tooling de desarrollo. |

## Fuera de alcance intencional

- Rutas Fastify, autenticación, sesiones y CSRF.
- Collectors reales de Home Assistant.
- Providers OpenAI/Gemini y notifiers reales.
- UI React, Docker runtime y documentación pública de instalación.
- Orquestación completa del digest.

## Comandos de verificación

```bash
pnpm test -- backend/src/adapters/persistence
pnpm typecheck
pnpm run ci
pnpm audit --audit-level moderate
```

`pnpm run ci` es el comando principal: ejecuta typecheck, tests, guardia contra `.only` y build.
`pnpm audit --audit-level moderate` debe devolver `No known vulnerabilities found`.

## Verificación manual recomendada

- Confirmar que ningún test, DTO o guía contiene valores reales de secretos.
- Confirmar que `/data/app.key` se trata como material sensible y no como configuración pública.
- Confirmar que `triggerWindowId` representa una ventana única de ejecución y evita duplicados de scheduler/API.
- Confirmar que un job `running` con `lease_until` caducado puede volver a reservarse y que un lease activo no se entrega a dos workers.
- Confirmar que `retry()` no reintenta en bucle: retrasa con backoff y marca `failed` al agotar intentos.

## Conceptos introducidos

| Concepto | Explicación breve |
|----------|-------------------|
| SQLite | Base de datos local en fichero para estado Docker-first; en tests se usa memoria. |
| Migraciones | SQL versionado que crea o actualiza tablas antes de usar la app. |
| Store | Adaptador que encapsula cómo se guarda o recupera un tipo de dato. El dominio depende de la interfaz, no de SQLite. |
| Secret ref | Identificador seguro (`secret_...`) que puede circular por API/UI sin exponer el valor real. |
| Lease de job | Reserva temporal de un job para que un worker lo procese sin duplicar trabajo. |
| `triggerWindowId` | Clave idempotente: la misma ventana manual/diaria/semanal no debe crear dos jobs. |
| Backoff de retry | Retraso creciente entre reintentos para evitar bucles rápidos ante errores repetidos de provider/notifier/orquestación. |
