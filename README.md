# TVBox

Распределённая система управления домашним медиацентром: десктопный ТВ-клиент (Electron) на ПК у телевизора + веб/PWA/Android пульт управления + лёгкий сигнальный сервер.

## Архитектура

```
packages/shared      — общие типы, события WebSocket, парсер имён торрентов
apps/backend         — сигнальный сервер (Node + Socket.io + Google OAuth), раздаёт статику пульта
apps/tv-client       — десктопный клиент для ТВ (Electron: плеер, торренты, TMDb, SQLite, idle-screen)
apps/remote-client   — пульт (React + Vite + PWA + Capacitor → APK)
```

Сервер не хранит медиафайлы и торренты — только маршрутизирует команды (WebSocket), сигналит WebRTC и раздаёт фронтенд пульта.

## Сервер (уже развёрнут)

- Веб-пульт: `https://tv.nemnogovova.com`
- Docker Compose: `docker compose up -d --build`
- Настройки в `.env` (см. `apps/backend/.env.example`)

## TV Client (ПК у телевизора)

Создай `.env` в `apps/tv-client` (или задай переменные окружения):

```
BACKEND_URL=https://tv.nemnogovova.com
DEVICE_TOKEN=<device token из .env сервера>
TMDB_API_KEY=<твой TMDb API key>
MEDIA_DIRS=/path/to/movies,/path/to/series
```

```bash
npm install
npm run dev -w @tvbox/tv-client          # дев-режим
# или собрать и запустить:
npm run build -w @tvbox/tv-client
npm start -w @tvbox/tv-client
```

`better-sqlite3` для Electron пересобирается: `npm run rebuild -w @tvbox/tv-client`.

### Windows EXE

```bash
npm run dist:win -w @tvbox/tv-client
```
Готовый установщик/EXE — в `apps/tv-client/release/`.

## Remote Client (пульт)

```bash
npm run build -w @tvbox/remote-client    # веб-билд
```

### Android APK

```bash
npm run build -w @tvbox/remote-client
npx cap sync android
cd apps/remote-client/android && ./gradlew assembleDebug
```
APK — в `android/app/build/outputs/apk/debug/`.

## Тесты

```bash
npm test     # роли, WebSocket-события, парсер имён, SQLite (31 тест)
npm run build
```
