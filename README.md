# Vial Quito

Pico y placa, vencimientos y reportes de tránsito de la comunidad en Quito.
Web: https://evcarga.github.io/vial/ · App Android: [última versión](https://github.com/evcarga/vial/releases/latest/download/vial.apk)

Parte de [EvCarga Ecuador](https://evcarga.github.io/). Usa la misma base de Supabase: tablas `vial_*`,
columna `proyecto = 'vial'`, bucket `vial` y `user_metadata.proyecto = 'vial'` en usuarios creados aquí.

- `web/` PWA (HTML + JS, Leaflet/OpenStreetMap, Supabase). Se publica con GitHub Pages.
- `android/` Trusted Web Activity que abre la PWA. La APK se compila en GitHub Actions.
- `supabase/` esquema SQL (RLS), tareas programadas y Edge Functions (`vial-auth`, `vial-cron`, `vial-telegram`, `vial-admin`).
